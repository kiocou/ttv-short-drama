//! 签名算法用到的基础原语。
//!
//! ⚠️ **所有算术都必须显式环绕**。Go 的 `byte`/`uint32` 溢出是静默取模，
//! 而 Rust debug 模式下 `+`/`-` 溢出会 panic。签名算法里大量依赖这种环绕
//! （尤其是 medusa 的混淆环节），少写一个 `wrapping_*` 就会在测试里炸掉，
//! 或者在 release 下悄悄算出错误签名 —— 后者更难查。因此本文件统一用
//! `wrapping_add` / `wrapping_sub` / `wrapping_mul`，不做任何裸算术。

/// 32 位循环左移。`count` 按 Go 的语义先取低 5 位。
pub fn rol32(value: u32, count: u32) -> u32 {
    let n = count & 31;
    if n == 0 {
        return value;
    }
    value.rotate_left(n)
}

/// 32 位循环右移。`count` 按 Go 的语义先取低 5 位。
pub fn ror32(value: u32, count: u32) -> u32 {
    let n = count & 31;
    if n == 0 {
        return value;
    }
    value.rotate_right(n)
}

/// 64 位循环右移。`count` 按 Go 的语义先取低 6 位。
pub fn ror64(value: u64, count: u64) -> u64 {
    let n = count & 63;
    if n == 0 {
        return value;
    }
    value.rotate_right(n as u32)
}

/// 字节内位序反转。
pub fn reverse_bits(value: u8) -> u8 {
    let mut result = 0u8;
    for i in 0..8 {
        result = (result << 1) | ((value >> i) & 1);
    }
    result
}

/// zigzag 变长整数编码：负数映射到奇数，正数到偶数。
pub fn zigzag(value: i64) -> u64 {
    ((value << 1) ^ (value >> 63)) as u64
}

pub fn le32(value: u32) -> [u8; 4] {
    value.to_le_bytes()
}

pub fn be32(value: u32) -> [u8; 4] {
    value.to_be_bytes()
}

pub fn le64(value: u64) -> [u8; 8] {
    value.to_le_bytes()
}

/// 混淆哈希的状态混合函数。
///
/// 注意 `^inner`：Go 里对 `uint32` 取反是逐位取反，Rust 的 `!` 同义。
pub fn get_iv(iv: u32, data: &[u8]) -> u32 {
    let mut value = iv;
    for (i, b) in data.iter().enumerate() {
        let b = *b as u32;
        if i & 1 == 0 {
            value = (value >> 4) ^ value ^ (value << 6) ^ b;
        } else {
            let inner = (value >> 7) ^ value ^ (b | (value << 12));
            value = !inner;
        }
    }
    value
}

/// 12 字节定长摘要混合，返回带固定哨兵位的结果。
pub fn sum_md5(data: &[u8]) -> u32 {
    let mut check: u32 = 0x20220420;
    for (i, b) in data.iter().take(12).enumerate() {
        let temp: u32;
        if i & 1 == 0 {
            temp = (check >> 3) ^ check;
            check = (*b as u32) ^ (check << 7);
        } else {
            temp = (check >> 5) ^ check;
            check = (*b as u32) | (check << 11);
            check = !check;
        }
        check ^= temp;
    }
    (check | 4) ^ 0x01000000
}

/// byte 的 popcount（用于 DRM 密钥解包的滚动常量）。
pub fn popcount_u32(v: u32) -> u32 {
    v.count_ones()
}

// ───────────────────────────────────────────────────────────────────────────
// MD5
//
// 项目原本没有 MD5 依赖（只有 sha2）。签名链路要算 query/body 的 MD5，
// 而引入 `md-5` crate 只为这一个算法并不划算，所以这里直接实现一份。
// 标准 RFC 1321，已验证与测试向量一致。
// ───────────────────────────────────────────────────────────────────────────

const MD5_S: [u32; 64] = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15,
    21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K: [u32; 64] = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

/// 标准 MD5，返回 16 字节摘要。
pub fn md5(input: &[u8]) -> [u8; 16] {
    let (mut a0, mut b0, mut c0, mut d0) =
        (0x67452301u32, 0xefcdab89u32, 0x98badcfeu32, 0x10325476u32);

    let bit_len = (input.len() as u64).wrapping_mul(8);
    let mut msg = input.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_le_bytes());

    for chunk in msg.chunks_exact(64) {
        let mut m = [0u32; 16];
        for (i, slot) in m.iter_mut().enumerate() {
            *slot = u32::from_le_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        let (mut a, mut b, mut c, mut d) = (a0, b0, c0, d0);
        for i in 0..64 {
            let (f, g) = match i / 16 {
                0 => ((b & c) | (!b & d), i),
                1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let tmp = d;
            d = c;
            c = b;
            b = b.wrapping_add(rol32(
                a.wrapping_add(f).wrapping_add(MD5_K[i]).wrapping_add(m[g]),
                MD5_S[i],
            ));
            a = tmp;
        }
        a0 = a0.wrapping_add(a);
        b0 = b0.wrapping_add(b);
        c0 = c0.wrapping_add(c);
        d0 = d0.wrapping_add(d);
    }

    let mut out = [0u8; 16];
    out[0..4].copy_from_slice(&a0.to_le_bytes());
    out[4..8].copy_from_slice(&b0.to_le_bytes());
    out[8..12].copy_from_slice(&c0.to_le_bytes());
    out[12..16].copy_from_slice(&d0.to_le_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn md5_known_vectors() {
        // RFC 1321 附录里的标准测试向量
        let cases: [(&[u8], &str); 3] = [
            (b"", "d41d8cd98f00b204e9800998ecf8427e"),
            (b"abc", "900150983cd24fb0d6963f7d28e17f72"),
            (b"message digest", "f96b697d7cb7938d525a2f31aaf161d0"),
        ];
        for (input, expect) in cases {
            let got = md5(input);
            let hex: String = got.iter().map(|b| format!("{b:02x}")).collect();
            assert_eq!(hex, expect, "MD5({:?})", String::from_utf8_lossy(input));
        }
    }

    #[test]
    fn rotate_matches_go_semantics() {
        assert_eq!(rol32(0x1234_5678, 4), 0x2345_6781);
        assert_eq!(rol32(0x1234_5678, 0), 0x1234_5678);
        assert_eq!(rol32(0x1234_5678, 32), 0x1234_5678); // 取低 5 位
        assert_eq!(ror32(0x1234_5678, 4), 0x8123_4567);
        assert_eq!(ror64(1, 1), 1 << 63);
    }

    #[test]
    fn zigzag_matches_go() {
        assert_eq!(zigzag(0), 0);
        assert_eq!(zigzag(-1), 1);
        assert_eq!(zigzag(1), 2);
        assert_eq!(zigzag(-2), 3);
    }
}
