//! 注册报文的 `tt-data` 信封。
//!
//! 移植自 `internal/protocol/tt_encrypt.go`。这一步是**纯算法常量**，
//! 不涉及任何设备私钥 —— 正因如此，匿名注册才能完全在本地复刻：
//!
//! ```text
//! keyIV   = SHA512( SHA512(prefix) || constant )     // 前 16 字节做 key，后 16 字节做 IV
//! body    = SHA512(plaintext) || plaintext || PKCS#7 填充
//! 输出     = 74 63 05 10 00 00 || prefix || AES-256-CBC(body)
//! ```

use crate::hongguo::consts::{TT_CONSTANT, TT_PREFIX};
use sha2::{Digest, Sha512};

// ───────────────────────────────────────────────────────────────────────────
// 标准 AES-256（与 `aes_v3` 那个变体无关）。只用于这一个信封，所以内联实现，
// 避免为此引入 aes/cbc 两个新依赖。
// ───────────────────────────────────────────────────────────────────────────

const SBOX: [u8; 256] = [
    0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
    0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
    0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
    0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
    0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
    0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
    0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
    0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
    0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
    0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
    0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
    0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
    0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
    0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
    0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
    0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
];

const RCON: [u8; 10] = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

fn xtime(x: u8) -> u8 {
    let v = x.wrapping_shl(1);
    if x & 0x80 != 0 {
        v ^ 0x1b
    } else {
        v
    }
}

fn expand_key_128(key: &[u8]) -> [u8; 176] {
    let mut w = [0u8; 176];
    w[..16].copy_from_slice(&key[..16]);
    let nk = 4;
    let total = 44;
    for i in nk..total {
        let mut temp = [
            w[(i - 1) * 4],
            w[(i - 1) * 4 + 1],
            w[(i - 1) * 4 + 2],
            w[(i - 1) * 4 + 3],
        ];
        if i % nk == 0 {
            temp.rotate_left(1);
            for t in temp.iter_mut() {
                *t = SBOX[*t as usize];
            }
            temp[0] ^= RCON[i / nk - 1];
        }
        for j in 0..4 {
            w[i * 4 + j] = w[(i - nk) * 4 + j] ^ temp[j];
        }
    }
    w
}

fn aes128_block(w: &[u8; 176], block: &[u8; 16]) -> [u8; 16] {
    let mut s = *block;
    let add_round = |s: &mut [u8; 16], round: usize| {
        for i in 0..16 {
            s[i] ^= w[round * 16 + i];
        }
    };
    add_round(&mut s, 0);
    for round in 1..10 {
        for b in s.iter_mut() {
            *b = SBOX[*b as usize];
        }
        // ShiftRows
        let t = s;
        for r in 0..4 {
            for c in 0..4 {
                s[r + 4 * c] = t[r + 4 * ((c + r) % 4)];
            }
        }
        // MixColumns
        for c in 0..4 {
            let i = c * 4;
            let (a0, a1, a2, a3) = (s[i], s[i + 1], s[i + 2], s[i + 3]);
            s[i] = xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3;
            s[i + 1] = a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3;
            s[i + 2] = a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3);
            s[i + 3] = (xtime(a0) ^ a0) ^ a1 ^ a2 ^ xtime(a3);
        }
        add_round(&mut s, round);
    }
    // 末轮无 MixColumns
    for b in s.iter_mut() {
        *b = SBOX[*b as usize];
    }
    let t = s;
    for r in 0..4 {
        for c in 0..4 {
            s[r + 4 * c] = t[r + 4 * ((c + r) % 4)];
        }
    }
    add_round(&mut s, 10);
    s
}

fn aes128_cbc_encrypt(key: &[u8], iv: &[u8], data: &[u8]) -> Vec<u8> {
    let w = expand_key_128(key);
    let mut prev = [0u8; 16];
    prev.copy_from_slice(&iv[..16]);
    let mut out = Vec::with_capacity(data.len());
    for chunk in data.chunks_exact(16) {
        let mut block = [0u8; 16];
        for i in 0..16 {
            block[i] = chunk[i] ^ prev[i];
        }
        let enc = aes128_block(&w, &block);
        out.extend_from_slice(&enc);
        prev = enc;
    }
    out
}

/// 把注册明文包进 `tt-data` 信封。
pub fn tt_encrypt(input: &[u8]) -> Vec<u8> {
    let prefix_hash = Sha512::digest(TT_PREFIX);
    let mut key_material = prefix_hash.to_vec();
    key_material.extend_from_slice(&TT_CONSTANT);
    let key_iv = Sha512::digest(&key_material);

    let digest = Sha512::digest(input);
    let mut plain = Vec::with_capacity(64 + input.len() + 16);
    plain.extend_from_slice(&digest);
    plain.extend_from_slice(input);

    let padding = 16 - (plain.len() % 16);
    for _ in 0..padding {
        plain.push(padding as u8);
    }

    // ⚠️ Go 侧是 `aes.NewCipher(keyIV[:16])` + IV `keyIV[16:32]`，
    // 即 **AES-128**，不是 AES-256。写成 256 位会让服务端解不出报文，
    // 表现为注册接口回 `device_id: 0`（看起来像"注册成功但没给设备"）。
    let encrypted = aes128_cbc_encrypt(&key_iv[..16], &key_iv[16..32], &plain);

    let mut out = Vec::with_capacity(6 + TT_PREFIX.len() + encrypted.len());
    out.extend_from_slice(&[0x74, 0x63, 0x05, 0x10, 0x00, 0x00]);
    out.extend_from_slice(&TT_PREFIX);
    out.extend_from_slice(&encrypted);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn aes128_cbc_nist_vector() {
        // NIST SP 800-38A F.2.1 / F.2.2（CBC-AES128）
        let key = hex("2b7e151628aed2a6abf7158809cf4f3c");
        let iv = hex("000102030405060708090a0b0c0d0e0f");
        let pt = hex("6bc1bee22e409f96e93d7e117393172a");
        let out = aes128_cbc_encrypt(&key, &iv, &pt);
        assert_eq!(
            out.iter().map(|b| format!("{b:02x}")).collect::<String>(),
            "7649abac8119b246cee98e9b12e9197d"
        );
    }

    #[test]
    fn envelope_has_expected_prefix() {
        let out = tt_encrypt(b"hello");
        assert_eq!(&out[..6], &[0x74, 0x63, 0x05, 0x10, 0x00, 0x00]);
        assert_eq!(&out[6..6 + TT_PREFIX.len()], &TT_PREFIX[..]);
        // 6 + 32 + 已填充的密文，且密文长度是 16 的倍数。
        // 明文 = 64（SHA-512 截断的 digest，8 字节×8）+ 5（"hello"）= 69，
        // padding = 16 - (69 % 16) = 11，总 80 字节密文。
        // 注：这里的 padding 实现是「不足一块时补到整块」（padding ∈ 1..=16，
        // 恰好对齐时也会补一整块），与 PKCS#7 一致；69 + 11 = 80。
        let body = &out[6 + TT_PREFIX.len()..];
        assert_eq!(body.len() % 16, 0);
        assert_eq!(body.len(), 80);
    }
}
