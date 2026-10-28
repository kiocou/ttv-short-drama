//! `x-medusa` 请求签名。
//!
//! 移植自 `internal/protocol/sign/medusa.go`，是整套签名里最复杂的一支：
//! 把一棵 protobuf 树序列化后做自定义 XOR 混淆、整体反转、按种子异或，
//! 再用自定义 AES 变体加密，最后加 20 字节版本前缀并 base64。
//!
//! 三处最容易写错、且错了不会报错只会被服务端静默拒绝的地方：
//! 1. `xmxor` 里第一次循环写的是 `encoded[n-i-1]`（倒序写入）；
//! 2. 反转之后那次异或用的是 `seed[(^i)&3]` —— 索引是**位取反**后的低两位，
//!    不是 `i & 3`；
//! 3. 版本前缀的每个 32 位字都要与 `khronos` 异或。

use crate::hongguo::aes_v3::AesV3;
use crate::hongguo::consts::{APP_ID, CHANNEL_ID, MEDUSA_AES_IV, MEDUSA_AES_KEY, MEDUSA_SIGN_KEY};
use crate::hongguo::f13::hash_f13;
use crate::hongguo::prim::{le32, md5};
use crate::hongguo::proto::{proto_bytes, proto_float, proto_sint, proto_string};
use crate::hongguo::sm3::sm3;

use base64::Engine;

/// medusa 每次签名要用的一组随机量。固定住就能得到确定性输出，便于用向量校验。
#[derive(Debug, Clone, Copy, Default)]
pub struct Entropy {
    pub env_launch: i64,
    pub env_pid: i64,
    pub now_secs: i64,
    pub message_random: u32,
    pub random: u32,
    pub packed_random: u32,
    pub gorgon_random: u32,
    pub helios_random: u32,
}

/// 自定义 XOR 混淆。
fn xmxor(data: &[u8], key: &[u8]) -> Vec<u8> {
    let n = data.len();
    let mut encoded = vec![0u8; n];
    for i in 0..n {
        let at = (i * 4) & 28;
        let d0 = key[at];
        let d1 = key[at + 1];
        // Go: byte((uint32((data[i]<<4)|(data[i]>>4)) + uint32(d0)))
        let rotated = data[i].wrapping_shl(4) | (data[i] >> 4);
        let mut d2 = (rotated as u32).wrapping_add(d0 as u32) as u8;
        d2 = !d2 ^ d1;
        d2 = d2.wrapping_shl(3) | (d2 >> 5);
        d2 = d2.wrapping_add(d1);
        d2 ^= d0;
        encoded[n - i - 1] = !d2;
    }

    let last = encoded[n - 1] ^ encoded[n - 2];
    let first = encoded[0];
    encoded[0] = (!last).wrapping_add(first);
    encoded[1] = (encoded[0] ^ encoded[n - 1] ^ 254).wrapping_add(encoded[1]);
    let shifted = encoded[1].wrapping_shl(3) | (encoded[1] >> 5);
    let fix2 = (last.wrapping_sub(first)) ^ (shifted ^ 2);
    encoded[2] = encoded[2].wrapping_add(fix2);

    for i in 0..n.saturating_sub(4) {
        let sh = encoded[i + 2].wrapping_shl(3) | (encoded[i + 2] >> 5);
        let temp = sh ^ encoded[i + 1] ^ (i as u8).wrapping_add(3);
        encoded[i + 3] = (!temp).wrapping_add(encoded[i + 3]);
    }

    encoded[n - 1] ^= encoded[n - 2];

    let mut sum: u32 = 0;
    for item in &encoded[1..] {
        sum = sum.wrapping_add(*item as u32);
    }
    encoded[0] = (encoded[0] ^ encoded[1]).wrapping_add(sum as u8);
    encoded
}

/// 由签名密钥与随机数导出 32 字节哈希与 4 字节种子。
fn key_hash(random: u32) -> ([u8; 32], [u8; 4]) {
    let mut buf = MEDUSA_SIGN_KEY.to_vec();
    buf.extend_from_slice(&le32(random));
    buf.extend_from_slice(&MEDUSA_SIGN_KEY);
    let hash = sm3(&buf);

    let d1 = ((random >> 16) & 255) as u8;
    let mut d2 = ((d1 as u32) << 11) | (random >> 24);
    d2 ^= (d1 as u32) >> 5;
    d2 ^= d1 as u32;
    d2 = !d2;

    let mut seed = [0u8; 4];
    seed.copy_from_slice(&le32(d2));
    (hash, seed)
}

/// 设备信息子树（字段值与抓包一致，不是随机生成）。
fn device_proto(device_id: &str) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&proto_sint(1, 1));
    out.extend_from_slice(&proto_sint(2, 2));
    out.extend_from_slice(&proto_string(3, APP_ID));
    out.extend_from_slice(&proto_string(4, device_id));
    out.extend_from_slice(&proto_string(5, "Ai6svO3PyrwDOUSmO6ZcResxu"));
    out.extend_from_slice(&proto_string(6, "!noperm!"));
    out.extend_from_slice(&proto_sint(7, -888888));
    out.extend_from_slice(&proto_sint(8, -888888));
    out.extend_from_slice(&proto_sint(9, 3));
    out.extend_from_slice(&proto_sint(10, -888888));
    out.extend_from_slice(&proto_string(11, "!notset!"));
    out.extend_from_slice(&proto_string(12, "Asia/Shanghai,8"));
    out.extend_from_slice(&proto_string(13, "zh_CN"));
    out.extend_from_slice(&proto_sint(14, 4));
    out.extend_from_slice(&proto_float(16, 255.249_94));
    out.extend_from_slice(&proto_float(17, 35.585_99));
    out.extend_from_slice(&proto_float(18, 3.467_449_2));
    out.extend_from_slice(&proto_float(19, 3.467_449_2));
    out.extend_from_slice(&proto_float(20, 255.175_49));
    out.extend_from_slice(&proto_float(21, 42.175_44));
    out.extend_from_slice(&proto_string(22, "16"));
    out.extend_from_slice(&proto_sint(23, 41));
    out.extend_from_slice(&proto_sint(24, 36));
    out.extend_from_slice(&proto_sint(25, 1728388016635));
    out.extend_from_slice(&proto_sint(26, 1728388016635));
    out.extend_from_slice(&proto_sint(27, 1728388016635));
    out.extend_from_slice(&proto_sint(28, 1728388016637));
    out.extend_from_slice(&proto_sint(29, -1));
    out.extend_from_slice(&proto_string(30, "25053RT47C"));
    out.extend_from_slice(&proto_string(31, "Redmi"));
    out.extend_from_slice(&proto_string(32, "25053RT47C"));
    out.extend_from_slice(&proto_string(33, "25053RT47C"));
    out.extend_from_slice(&proto_string(34, "Xiaomi"));
    out.extend_from_slice(&proto_string(35, "Redmi"));
    out.extend_from_slice(&proto_string(36, "Redmi"));
    out.extend_from_slice(&proto_sint(38, 31));
    out
}

fn index_byte(s: &str, c: u8) -> Option<usize> {
    s.as_bytes().iter().position(|b| *b == c)
}

/// 计算 `x-medusa` 头（base64）。
pub fn assemble_medusa(
    raw_url: &str,
    body: &[u8],
    has_body: bool,
    khronos: u32,
    device_id: &str,
    version_name: &str,
    entropy: Entropy,
) -> String {
    let body_md5 = if has_body { md5(body) } else { [0u8; 16] };

    let query_raw = match index_byte(raw_url, b'?') {
        Some(i) => &raw_url[i + 1..],
        None => "",
    };
    let query_sm3 = sm3(query_raw.as_bytes());
    let ts = le32(khronos);
    let query_body_ts = hash_f13(&query_sm3, &body_md5, &ts, khronos);

    let check = (((query_sm3[0] & 63) as u32) << 14)
        | 0x1800_0001
        | (((query_body_ts[0] & 63) as u32) << 8);

    // ---- 嵌套子树 ----
    let mut nested = proto_sint(1, 111);
    nested.extend_from_slice(&proto_sint(2, 10));
    nested.extend_from_slice(&proto_sint(3, 694367));
    nested.extend_from_slice(&proto_sint(5, 586952199));

    let mut nested13 = proto_sint(1, entropy.now_secs);
    nested13.extend_from_slice(&proto_sint(2, -2));
    nested13.extend_from_slice(&proto_sint(4, 200));

    let mut env = proto_sint(1, entropy.env_launch);
    env.extend_from_slice(&proto_sint(2, 146331399));
    env.extend_from_slice(&proto_sint(3, 146331396));
    env.extend_from_slice(&proto_sint(5, 7));
    env.extend_from_slice(&proto_string(6, "v04.06.04.03-bugfix"));
    env.extend_from_slice(&proto_sint(7, entropy.env_pid));
    env.extend_from_slice(&proto_bytes(12, &device_proto(device_id)));
    env.extend_from_slice(&proto_bytes(13, &nested13));
    env.extend_from_slice(&proto_string(14, version_name));

    let mut qh = query_raw.as_bytes().to_vec();
    qh.extend_from_slice(&body_md5);
    qh.extend_from_slice(b"none");
    let query_hash = sm3(&qh);

    // ---- 主报文 ----
    let fixed1: [u8; 16] = [
        0xf7, 0xe8, 0x5f, 0xfa, 0xd7, 0xd7, 0xdc, 0x3b, 0xd6, 0x2a, 0xc8, 0x70, 0x57, 0xcf, 0x61,
        0x18,
    ];
    let fixed2: [u8; 8] = [0x40, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];

    let mut message = proto_bytes(1, &fixed1);
    message.extend_from_slice(&proto_sint(2, 3));
    message.extend_from_slice(&proto_sint(3, entropy.message_random as i64));
    message.extend_from_slice(&proto_string(4, APP_ID));
    message.extend_from_slice(&proto_string(5, device_id));
    message.extend_from_slice(&proto_string(6, CHANNEL_ID));
    message.extend_from_slice(&proto_string(7, version_name));
    message.extend_from_slice(&proto_string(8, "v04.06.04-ml-android"));
    message.extend_from_slice(&proto_sint(9, 67503104));
    message.extend_from_slice(&proto_bytes(10, &fixed2));
    message.extend_from_slice(&proto_sint(12, khronos as i64));
    message.extend_from_slice(&proto_bytes(13, &query_body_ts));
    message.extend_from_slice(&proto_bytes(14, &query_sm3[..6]));
    message.extend_from_slice(&proto_bytes(15, &nested));
    message.extend_from_slice(&proto_string(16, "AXYQOS6n2m60x1fVZHIrH3iol"));
    message.extend_from_slice(&proto_sint(17, khronos as i64));
    message.extend_from_slice(&proto_bytes(19, &query_hash));
    message.extend_from_slice(&proto_string(20, "none"));
    message.extend_from_slice(&proto_sint(21, 312));
    message.extend_from_slice(&proto_bytes(23, &env));
    message.extend_from_slice(&proto_string(
        24,
        r#"{"cmr":16777216,"cmr2":16777216,"un_h":1879194040,"vpn":0,"kd":0,"fkd":3672518972,"pd":-1872573247,"dyn":"","do":0,"tk":true}"#,
    ));

    // ---- 混淆 ----
    let (hash, seed) = key_hash(entropy.random);
    let mut transformed = xmxor(&message, &hash);

    let mut prefixed = fixed2.to_vec();
    prefixed.extend_from_slice(&transformed);
    transformed = prefixed;

    transformed.reverse();

    for i in 0..transformed.len() {
        // Go: seed[(^i)&3]
        transformed[i] ^= seed[(!i) & 3];
    }

    let mut packed = vec![0x35u8];
    packed.extend_from_slice(&le32(entropy.packed_random));
    packed.extend_from_slice(&le32(check));
    packed.extend_from_slice(&transformed);
    packed.push((entropy.random >> 16) as u8);
    packed.push((entropy.random >> 24) as u8);

    let encrypted = AesV3::new(&MEDUSA_AES_KEY, khronos).encrypt(&packed, &MEDUSA_AES_IV);

    let version: [u8; 20] = [
        0x03, 0x00, 0x00, 0x00, 0xf7, 0xe8, 0x5f, 0xfa, 0xd7, 0xd7, 0xdc, 0x3b, 0xd6, 0x2a, 0xc8,
        0x70, 0x57, 0xcf, 0x61, 0x18,
    ];
    let mut prefix = [0u8; 20];
    for i in 0..5 {
        let v = u32::from_le_bytes(version[i * 4..i * 4 + 4].try_into().unwrap());
        prefix[i * 4..i * 4 + 4].copy_from_slice(&le32(v ^ khronos));
    }

    let mut out = prefix.to_vec();
    out.push((entropy.random & 255) as u8);
    out.push(((entropy.random >> 8) & 255) as u8);
    out.push(0);
    out.push(1);
    out.extend_from_slice(&encrypted);

    base64::engine::general_purpose::STANDARD.encode(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn medusa_is_deterministic_for_fixed_entropy() {
        let e = Entropy {
            env_launch: 105,
            env_pid: 12345,
            now_secs: 1728388016,
            message_random: 0x11223344,
            random: 0x55667788,
            packed_random: 0x99aabbcc,
            gorgon_random: 0xddee,
            helios_random: 0x01020304,
        };
        let a = assemble_medusa(
            "https://reading.snssdk.com/x?iid=1",
            b"{}",
            true,
            1728388016,
            "123",
            "7.3.9.32",
            e,
        );
        let b = assemble_medusa(
            "https://reading.snssdk.com/x?iid=1",
            b"{}",
            true,
            1728388016,
            "123",
            "7.3.9.32",
            e,
        );
        assert_eq!(a, b);
        assert!(!a.is_empty());
    }
}
