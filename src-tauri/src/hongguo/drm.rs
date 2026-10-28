//! CENC 内容密钥解包。
//!
//! 移植自 `internal/drm/spade.go`。服务端为每一路码流下发一段不透明的
//! `encrypt_info.spade_a`（base64）。播放器原生库把它按固定置换翻搅后拆成
//! 「版本号 + 内容密钥 + 方案标记」。这里做的是行为兼容的复刻 —— 纯本地计算，
//! 不发任何请求。
//!
//! 它决定播放能否解密：解包错了 ffmpeg 只会报一堆乱码帧，而不是「密钥错误」，
//! 所以必须严格照抄每一处 `wrapping_*`。

/// 一段可用的内容密钥。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentKey {
    /// AES 内容密钥（小写 hex）。
    pub hex: String,
    /// 玩家读取的方案标记（如 `1`）。
    pub version: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidMaterial;

impl std::fmt::Display for InvalidMaterial {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "无法识别的密钥材料")
    }
}

fn hex_digit(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// `popcount` 对 index 的 4 个字节分别计数后相加（对齐播放器的 NEON 实现）。
fn popcount_index(i: usize) -> u8 {
    // Go 侧写的是「四个字节分别 popcount 再相加」，等价于整体 count_ones()。
    // 别真的去逐字节累加 —— 那会把同一批比特数四遍。
    (i as u32).count_ones() as u8
}

fn scramble(buf: &mut [u8], v2: bool) {
    if v2 {
        let last = buf.len().saturating_sub(1);
        let mut i = 0;
        while i + 1 < buf.len() {
            buf.swap(i, i + 1);
            if i == last.saturating_sub(2) {
                break;
            }
            i += 2;
        }
    }

    let mut prev: u8 = 0x55;
    let mut cur: u8 = 0xfa;
    for (i, slot) in buf.iter_mut().enumerate() {
        let b = *slot;
        // Go: term := -byte(0x15 + popcount(uint32(i)))
        let term = (0x15u8).wrapping_add(popcount_index(i)).wrapping_neg();
        if i % 2 == 0 {
            *slot = if v2 {
                (cur ^ b).wrapping_sub(prev).wrapping_add(term)
            } else {
                term.wrapping_add(cur ^ b)
            };
            cur = b;
        } else {
            *slot = if v2 {
                (prev ^ b).wrapping_sub(prev).wrapping_add(term)
            } else {
                term.wrapping_add(prev ^ b)
            };
            prev = b;
        }
    }
}

/// 从 `spade_a` 解出内容密钥。
pub fn derive(spade_a: &str) -> Result<ContentKey, InvalidMaterial> {
    use base64::Engine;
    let trimmed = spade_a.trim();
    let raw = base64::engine::general_purpose::STANDARD
        .decode(trimmed.as_bytes())
        .map_err(|_| InvalidMaterial)?;
    if raw.len() < 4 {
        return Err(InvalidMaterial);
    }

    let marker = (raw[0] ^ raw[1] ^ raw[2]) as i32;
    let prefix_len = marker - 0x30;
    if prefix_len < 1 || prefix_len as usize > raw.len() {
        return Err(InvalidMaterial);
    }
    let out_len = raw.len() as i32 - marker + 0x2f;
    if out_len < 2 || (1 + out_len) as usize > raw.len() {
        return Err(InvalidMaterial);
    }
    let out_len = out_len as usize;

    let mut buf = raw[1..1 + out_len].to_vec();

    let tail = raw.len() as i32 - prefix_len;
    if tail - 2 < 0 || tail as usize > raw.len() {
        return Err(InvalidMaterial);
    }
    let tail = tail as usize;
    let (b16, b14) = (raw[tail - 2], raw[tail - 1]);

    let mut tag = vec![0u8; prefix_len as usize];
    for (i, slot) in tag.iter_mut().enumerate() {
        if i + tail >= raw.len() {
            return Err(InvalidMaterial);
        }
        *slot = b14 ^ b16 ^ raw[i + tail];
    }
    let tag_text = String::from_utf8_lossy(&tag).to_string();
    let v2 = tag_text.starts_with("app_v2") || tag_text.starts_with("web_v2");

    scramble(&mut buf, v2);

    let version_len = hex_digit(buf[0]).ok_or(InvalidMaterial)? as usize;
    if version_len < 1 || version_len >= out_len {
        return Err(InvalidMaterial);
    }
    let key_len = out_len - version_len;
    if key_len < 1 || key_len > buf.len() {
        return Err(InvalidMaterial);
    }
    let hex_key = String::from_utf8_lossy(&buf[1..key_len]).to_lowercase();
    if hex_key.is_empty() || !hex_key.len().is_multiple_of(2) {
        return Err(InvalidMaterial);
    }
    if !hex_key.bytes().all(|c| hex_digit(c).is_some()) {
        return Err(InvalidMaterial);
    }

    Ok(ContentKey {
        hex: hex_key,
        version: String::from_utf8_lossy(&buf[key_len..]).to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_base64_and_short_material() {
        assert_eq!(derive("!!!not base64!!!"), Err(InvalidMaterial));
        assert_eq!(derive("AAA="), Err(InvalidMaterial)); // 只有 2 字节
    }

    #[test]
    fn popcount_matches_byte_lane_sum() {
        // 0x00000000 -> 0；0x0000000f -> 4；0x0000ffff -> 16
        assert_eq!(popcount_index(0), 0);
        assert_eq!(popcount_index(0xf), 4);
        assert_eq!(popcount_index(0xffff), 16);
    }
}
