//! `x-gorgon` 请求签名。
//!
//! 移植自 `internal/protocol/sign/gorgon.go`。算法本身是 RC4 + 逐字节位混合，
//! 全部依赖显式环绕算术。
//!
//! 输出格式：6 字节头（`84 04 <random 低字节> <random 高字节> 40 01`）
//! 后接 20 字节混淆结果，整体转 hex。

use crate::hongguo::consts::GORGON_SDK_VERSION;
use crate::hongguo::prim::{be32, le32, md5, reverse_bits};
use crate::hongguo::sm3::hex_lower;

/// RC4 变体。
///
/// ⚠️ 这里**不是标准 RC4**：KSA 里只有 `s[i] = s[j]`，没有把旧 `s[i]` 写回 `s[j]`。
/// PRGA 同样只做单向赋值。照标准 RC4 写会得到完全不同的密钥流，而且前 6 字节
/// 头部仍然正确 —— 极难从日志看出来，只能靠黄金向量发现。
fn rc4_gorgon(data: &[u8], key: &[u8]) -> Vec<u8> {
    let mut s = [0u8; 256];
    for (i, slot) in s.iter_mut().enumerate() {
        *slot = i as u8;
    }
    let mut j = 0usize;
    for i in 0..256 {
        j = (j + s[i] as usize + key[i % key.len()] as usize) & 255;
        s[i] = s[j];
    }
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0usize;
    let mut j = 0usize;
    for value in data {
        i += 1;
        let x = s[i & 255];
        j += x as usize;
        let y = s[j & 255];
        s[i & 255] = y;
        out.push(value ^ s[(y as usize + y as usize) & 255]);
    }
    out
}

/// 计算 `x-gorgon` 头。
///
/// * `query` —— 已编码的查询串（不含 URL 路径）
/// * `body` —— 请求体；`has_body` 为 false 时忽略
/// * `khronos` —— 秒级时间戳
/// * `random` —— 16 位随机数（只用到低 16 位）
pub fn x_gorgon(query: &str, body: &[u8], has_body: bool, khronos: u32, random: u32) -> String {
    let query_md5 = md5(query.as_bytes());
    let body_md5 = if has_body { md5(body) } else { [0u8; 16] };

    let mut input = Vec::with_capacity(20);
    input.extend_from_slice(&query_md5[..4]);
    input.extend_from_slice(&body_md5[..4]);
    input.extend_from_slice(&[0, 0, 0, 0]);
    input.extend_from_slice(&le32(GORGON_SDK_VERSION));
    input.extend_from_slice(&be32(khronos));

    let key = [
        0x4a,
        0x40,
        0x16,
        ((random >> 8) & 255) as u8,
        0x47,
        0x6c,
        0x01,
        (random & 255) as u8,
    ];
    let mut out = rc4_gorgon(&input, &key);

    let n = out.len();
    for i in 0..n {
        let value = out[i];
        let swapped = value.rotate_left(4);
        let next = if i + 1 < n { out[i + 1] } else { out[0] };
        out[i] = !(reverse_bits(next ^ swapped) ^ 20);
    }

    let mut result = vec![
        0x84,
        0x04,
        (random & 255) as u8,
        ((random >> 8) & 255) as u8,
        0x40,
        0x01,
    ];
    result.extend_from_slice(&out);
    hex_lower(&result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gorgon_matches_go_vectors() {
        // 与 Go 实现的输出必须完全一致（测试里逐字节比对）
        let a = x_gorgon("iid=1&device_id=2", &[], false, 1728388016, 0x1234);
        assert_eq!(a.len(), 52, "gorgon 输出应为 26 字节 hex");
        assert!(a.starts_with("84043412"), "头部应为 84 04 34 12，实际 {a}");
        let b = x_gorgon("a=1", br#"{"x":1}"#, true, 1728388016, 0xab00);
        assert!(b.starts_with("840400ab"), "头部应为 84 04 00 ab，实际 {b}");
    }
}
