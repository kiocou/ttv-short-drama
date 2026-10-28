//! SM3 密码杂凑算法（GM/T 0004-2012）。
//!
//! 红果的 query 哈希与 medusa 签名都基于它。移植自 openhongguo 的
//! `internal/protocol/sign/sm3.go`，已用官方向量（`SM3("abc")`）与 Go 实现
//! 逐位对齐。

use crate::hongguo::prim::rol32;

const IV: [u32; 8] = [
    0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e,
];

fn ff(j: usize, x: u32, y: u32, z: u32) -> u32 {
    if j < 16 {
        x ^ y ^ z
    } else {
        (x & y) | (x & z) | (y & z)
    }
}

fn gg(j: usize, x: u32, y: u32, z: u32) -> u32 {
    if j < 16 {
        x ^ y ^ z
    } else {
        (x & y) | (!x & z)
    }
}

fn p0(x: u32) -> u32 {
    x ^ rol32(x, 9) ^ rol32(x, 17)
}

fn p1(x: u32) -> u32 {
    x ^ rol32(x, 15) ^ rol32(x, 23)
}

fn pad(msg: &[u8]) -> Vec<u8> {
    let bit_len = (msg.len() as u64).wrapping_mul(8);
    let mut out = Vec::with_capacity(msg.len() + 72);
    out.extend_from_slice(msg);
    out.push(0x80);
    while (out.len() + 8) % 64 != 0 {
        out.push(0);
    }
    out.extend_from_slice(&bit_len.to_be_bytes());
    out
}

/// 计算 SM3 摘要。
pub fn sm3(msg: &[u8]) -> [u8; 32] {
    let mut h = IV;
    let padded = pad(msg);
    let mut w = [0u32; 68];
    let mut wp = [0u32; 64];

    for block in padded.chunks_exact(64) {
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                block[i * 4],
                block[i * 4 + 1],
                block[i * 4 + 2],
                block[i * 4 + 3],
            ]);
        }
        for j in 16..68 {
            let x = w[j - 16] ^ w[j - 9] ^ rol32(w[j - 3], 15);
            w[j] = p1(x) ^ rol32(w[j - 13], 7) ^ w[j - 6];
        }
        for j in 0..64 {
            wp[j] = w[j] ^ w[j + 4];
        }

        let (mut a, mut b, mut c, mut d) = (h[0], h[1], h[2], h[3]);
        let (mut e, mut f, mut g, mut hh) = (h[4], h[5], h[6], h[7]);

        for j in 0..64 {
            let tj: u32 = if j < 16 { 0x79cc4519 } else { 0x7a879d8a };
            let ss1 = rol32(
                rol32(a, 12)
                    .wrapping_add(e)
                    .wrapping_add(rol32(tj, j as u32)),
                7,
            );
            let ss2 = ss1 ^ rol32(a, 12);
            let tt1 = ff(j, a, b, c)
                .wrapping_add(d)
                .wrapping_add(ss2)
                .wrapping_add(wp[j]);
            let tt2 = gg(j, e, f, g)
                .wrapping_add(hh)
                .wrapping_add(ss1)
                .wrapping_add(w[j]);
            d = c;
            c = rol32(b, 9);
            b = a;
            a = tt1;
            hh = g;
            g = rol32(f, 19);
            f = e;
            e = p0(tt2);
        }

        h[0] ^= a;
        h[1] ^= b;
        h[2] ^= c;
        h[3] ^= d;
        h[4] ^= e;
        h[5] ^= f;
        h[6] ^= g;
        h[7] ^= hh;
    }

    let mut out = [0u8; 32];
    for (i, v) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&v.to_be_bytes());
    }
    out
}

/// 小写 hex 编码（签名链路里到处要用）。
pub fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// 大写 hex 编码（`x-ss-stub` 用大写）。
pub fn hex_upper(bytes: &[u8]) -> String {
    hex_lower(bytes).to_uppercase()
}

/// 解析 hex 字符串。
pub fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    let bytes = s.as_bytes();
    for i in (0..s.len()).step_by(2) {
        let hi = (bytes[i] as char).to_digit(16)?;
        let lo = (bytes[i + 1] as char).to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sm3_published_vectors() {
        // GB/T 32905-2016 / GM/T 0004-2012 公布的标准向量
        assert_eq!(
            hex_lower(&sm3(b"abc")),
            "66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0"
        );
        assert_eq!(
            hex_lower(&sm3(b"abcd".repeat(16).as_slice())),
            "debe9ff92275b8a138604889c18e5a4d6fdb70e5387e5765293dcba39c0c5732"
        );
    }
}
