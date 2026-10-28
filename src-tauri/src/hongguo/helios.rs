//! `x-helios` 请求签名。
//!
//! 移植自 `internal/protocol/sign/helios.go`。结构是：
//! 用 `md5(random_le || appID)` 的 hex 文本切出 4 个 64 位字做种子，
//! 扩散成 34 项查找表，再对 `"khronos-channelID-appID"` 的填充块做 34 轮
//! 双字混合。输出 = `random` 小端 4 字节 + 混合结果，整体 base64。

use crate::hongguo::consts::{APP_ID, CHANNEL_ID};
use crate::hongguo::prim::{le32, md5, ror64};
use crate::hongguo::sm3::hex_lower;

/// 把 4 个种子字扩散成 35 项查找表（首项为原值）。
fn diffuse(words: &[u64]) -> Vec<u64> {
    let mut table = vec![words[0]];
    let mut b0 = words[0];
    let mut b8 = words[1];
    let mut queue: Vec<u64> = words[2..].to_vec();
    for i in 0..34u64 {
        let mut x8 = ror64(b8, 8).wrapping_add(b0);
        x8 ^= i;
        queue.push(x8);
        x8 ^= ror64(b0, 61);
        table.push(x8);
        b0 = x8;
        b8 = queue[0];
        queue.remove(0);
    }
    table
}

/// PKCS#7 风格填充（整块填充，与 Go 的 `heliosPad` 一致）。
fn helios_pad(khronos: u32) -> Vec<u8> {
    let text = format!("{khronos}-{CHANNEL_ID}-{APP_ID}");
    let text = text.as_bytes();
    let fill = (16 - (text.len() % 16)) as u8;
    let size = (text.len() + 1).div_ceil(16) * 16;
    let mut out = vec![fill; size];
    out[..text.len()].copy_from_slice(text);
    out
}

/// 计算 `x-helios` 头（base64）。
pub fn assemble_helios(khronos: u32, random: u32) -> String {
    let mut seed = le32(random).to_vec();
    seed.extend_from_slice(APP_ID.as_bytes());
    let digest = md5(&seed);
    let ascii = hex_lower(&digest).into_bytes(); // 32 个 ASCII 字符

    let mut words = [0u64; 4];
    for (i, slot) in words.iter_mut().enumerate() {
        let mut buf = [0u8; 8];
        buf.copy_from_slice(&ascii[i * 8..i * 8 + 8]);
        *slot = u64::from_le_bytes(buf);
    }

    let table = diffuse(&words);
    let padded = helios_pad(khronos);

    let mut output = Vec::with_capacity(padded.len());
    for chunk in padded.chunks_exact(16) {
        let mut a = u64::from_le_bytes(chunk[..8].try_into().unwrap());
        let mut b = u64::from_le_bytes(chunk[8..].try_into().unwrap());
        for t in table.iter().take(34) {
            b = t ^ (a.wrapping_add(ror64(b, 8)));
            a = b ^ ror64(a, 61);
        }
        output.extend_from_slice(&a.to_le_bytes());
        output.extend_from_slice(&b.to_le_bytes());
    }

    let mut result = le32(random).to_vec();
    result.extend_from_slice(&output);
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helios_is_stable() {
        // 同输入必须同输出（纯函数），且随 khronos 变化
        let a = assemble_helios(1728388016, 0x12345678);
        let b = assemble_helios(1728388016, 0x12345678);
        let c = assemble_helios(1728388017, 0x12345678);
        assert_eq!(a, b);
        assert_ne!(a, c);
    }
}
