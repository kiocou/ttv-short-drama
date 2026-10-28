//! 请求签名与查询串编码。
//!
//! 移植自 `internal/protocol/sign/request.go` 与 `internal/protocol/request.go`
//! 的设备查询部分。两个容易被忽略但会直接导致签名失败的细节：
//!
//! 1. **查询串用的是自定义转义表**，比标准 `urlencode` 少转义 `!*'()` 五个字符。
//!    用 `url::form_urlencoded` 会让 SM3 输入与实机不同 → 签名全错。
//! 2. **时间戳前的分支探测**：`_rticket` 必须让 `branch_of(...) != 1`。
//!    Go 会从 `base+0` 一路试到 `base+31`，跳过落在分支 1 的取值。

use crate::hongguo::consts::{APP_ID, DEVICE_PLATFORM, VERSION_CODE, VERSION_NAME};
use crate::hongguo::device::Device;
use crate::hongguo::f13::branch_of;
use crate::hongguo::gorgon::x_gorgon;
use crate::hongguo::helios::assemble_helios;
use crate::hongguo::medusa::{assemble_medusa, Entropy};
use crate::hongguo::prim::{le32, md5};
use crate::hongguo::sm3::{hex_upper, sm3};

use base64::Engine;

/// 签名所用的 URL 宿主。medusa 哈希的是这个而不是实际请求域名。
const SIGN_HOST: &str = "https://reading.snssdk.com";

/// `(键, 值)` 有序查询对。顺序参与签名，不能用 map。
pub type Pairs = Vec<(String, String)>;

/// 设备查询身份。
#[derive(Debug, Clone)]
pub struct SearchIdentity {
    pub device_id: String,
    pub install_id: String,
    pub cdid: String,
    pub openudid: String,
    pub device: Device,
}

/// 自定义 URL 组件转义。
///
/// 与 Go 的 `encodeComponent` 一致：只放行字母数字与 `-_.!~*'()`，
/// 其余（含 UTF-8 的每个字节）一律 `%XX` 大写。
fn encode_component(s: &str) -> String {
    const UNRESERVED: &[u8] = b"-_.!~*'()";
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        let c = *b;
        if c.is_ascii_alphanumeric() || UNRESERVED.contains(&c) {
            out.push(c as char);
        } else {
            out.push_str(&format!("%{c:02X}"));
        }
    }
    out
}

/// 按给定顺序拼接查询串。
pub fn encode_query(pairs: &Pairs) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", encode_component(k), encode_component(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// 匿名设备查询对（顺序是签名的一部分，不能改）。
pub fn device_query_pairs(id: &SearchIdentity) -> Pairs {
    let d = id.device.clone().or_default();
    let (kind, pad) = if d.pad { ("pad", "1") } else { ("phone", "0") };
    vec![
        ("iid".into(), id.install_id.clone()),
        ("device_id".into(), id.device_id.clone()),
        ("ac".into(), "wifi".into()),
        ("channel".into(), d.channel.clone()),
        ("aid".into(), APP_ID.into()),
        ("app_name".into(), "novelread".into()),
        ("cdid".into(), id.cdid.clone()),
        ("version_code".into(), VERSION_CODE.into()),
        ("version_name".into(), VERSION_NAME.into()),
        ("device_platform".into(), DEVICE_PLATFORM.into()),
        ("os".into(), "android".into()),
        ("ssmix".into(), "a".into()),
        ("device_type".into(), d.model.clone()),
        ("device_brand".into(), d.brand.clone()),
        ("language".into(), "zh".into()),
        ("os_api".into(), d.os_api.to_string()),
        ("os_version".into(), d.os_version.clone()),
        ("manifest_version_code".into(), VERSION_CODE.into()),
        ("resolution".into(), d.resolution.clone()),
        ("dpi".into(), d.dpi.to_string()),
        ("update_version_code".into(), VERSION_CODE.into()),
        ("host_abi".into(), "arm64-v8a".into()),
        ("dragon_device_type".into(), kind.into()),
        ("pv_player".into(), VERSION_CODE.into()),
        ("compliance_status".into(), "0".into()),
        ("need_personal_recommend".into(), "1".into()),
        ("player_so_load".into(), "1".into()),
        ("is_android_pad_screen".into(), pad.into()),
        ("openudid".into(), id.openudid.clone()),
    ]
}

/// 一次签名请求的结果。
#[derive(Debug, Clone)]
pub struct SignedRequest {
    /// 已签名、可直接拼到 URL 后面的查询串。
    pub query: String,
    /// 需要附加的请求头（含各签名项）。
    pub headers: Vec<(String, String)>,
    /// 实际使用的 `_rticket`（毫秒），调用方做 `x-reading-request` 时要用。
    pub ticket_millis: i64,
}

/// 抽取一次性随机项。生产路径每次请求都现抽。
pub fn draw_entropy(now_millis: i64) -> Entropy {
    let mut buf = [0u8; 16];
    let _ = fill_random(&mut buf);
    let n = u64::from_le_bytes(buf[0..8].try_into().unwrap());
    let rd16 = |i: usize| u16::from_le_bytes([buf[i], buf[i + 1]]) as u64;
    Entropy {
        env_launch: 100 + (n % 21) as i64,
        env_pid: 10001 + (rd16(8) % 2000) as i64,
        now_secs: now_millis / 1000,
        message_random: u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]),
        random: u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]),
        packed_random: u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]),
        gorgon_random: rd16(12) as u32,
        helios_random: u32::from_le_bytes([buf[12], buf[13], buf[14], buf[15]]),
    }
}

fn fill_random(buf: &mut [u8]) -> Result<(), ()> {
    use std::io::Read;
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(buf))
        .map_err(|_| ())
        .or_else(|_| {
            // Windows 没有 /dev/urandom，退回 uuid 的随机源拼接
            let mut filled = 0;
            while filled < buf.len() {
                let id = uuid::Uuid::new_v4();
                let bytes = id.as_bytes();
                let take = (buf.len() - filled).min(bytes.len());
                buf[filled..filled + take].copy_from_slice(&bytes[..take]);
                filled += take;
            }
            Ok(())
        })
}

/// 生成一次签名请求。
///
/// `path` 参与 medusa 哈希（写死 `reading.snssdk.com` 宿主），
/// `body` 为 `Some` 时按带 body 的 POST 处理。
pub fn sign_request(
    path: &str,
    pairs: &Pairs,
    now_millis: i64,
    device_id: &str,
    body: Option<&[u8]>,
    entropy: Entropy,
) -> SignedRequest {
    let has_body = body.is_some();
    let body_md5 = match body {
        Some(b) => md5(b),
        None => [0u8; 16],
    };

    let base = now_millis as u64;
    let mut query = String::new();
    let mut ticket: u64 = base;
    let mut khronos: u32 = 0;

    // 探测 `_rticket`：跳过会让 branch_of 落在分支 1 的取值。
    for offset in 0..32u64 {
        ticket = base.wrapping_add(offset);
        khronos = (ticket / 1000) as u32;

        let mut with_ticket = pairs.clone();
        with_ticket.push(("ts".into(), khronos.to_string()));
        with_ticket.push(("_rticket".into(), ticket.to_string()));
        query = encode_query(&with_ticket);

        let sum = sm3(query.as_bytes());
        if branch_of(&sum, &body_md5, &le32(khronos)) != 1 {
            break;
        }
    }

    let mut ent = entropy;
    if ent.now_secs == 0 {
        ent.now_secs = khronos as i64;
    }

    let raw_url = format!("{SIGN_HOST}{path}?{query}");

    let mut headers: Vec<(String, String)> = vec![
        (
            "Accept".into(),
            "application/json; charset=utf-8,application/x-protobuf".into(),
        ),
        ("x-xs-from-web".into(), "0".into()),
        ("x-ss-req-ticket".into(), ticket.to_string()),
        ("x-tt-request-tag".into(), "t=0;n=0".into()),
        ("sdk-version".into(), "2".into()),
        ("passport-sdk-version".into(), "50561".into()),
        ("x-vc-bdturing-sdk-version".into(), "3.7.2.cn".into()),
        ("x-khronos".into(), khronos.to_string()),
        (
            "x-ladon".into(),
            base64::engine::general_purpose::STANDARD.encode(khronos.to_be_bytes()),
        ),
        (
            "x-argus".into(),
            base64::engine::general_purpose::STANDARD.encode(khronos.to_le_bytes()),
        ),
        (
            "x-gorgon".into(),
            x_gorgon(
                &query,
                body.unwrap_or(&[]),
                has_body,
                khronos,
                ent.gorgon_random,
            ),
        ),
        (
            "x-helios".into(),
            assemble_helios(khronos, ent.helios_random),
        ),
        (
            "x-medusa".into(),
            assemble_medusa(
                &raw_url,
                body.unwrap_or(&[]),
                has_body,
                khronos,
                device_id,
                VERSION_NAME,
                ent,
            ),
        ),
        ("x-tt-dt".into(), String::new()),
    ];

    if let Some(b) = body {
        headers.push((
            "Content-Type".into(),
            "application/json; charset=UTF-8".into(),
        ));
        headers.push(("x-ss-stub".into(), hex_upper(&md5(b))));
    }

    SignedRequest {
        query,
        headers,
        ticket_millis: ticket as i64,
    }
}

/// `x-reading-request` 头：`<毫秒>-<随机正数>`。
pub fn reading_request_id(unix_millis: i64, random_int: i32) -> String {
    let n = (random_int as i64).abs();
    format!("{unix_millis}-{n}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn component_escape_matches_go() {
        // Go 放行 !*'() 这五个，标准 urlencode 会把它们转义
        assert_eq!(encode_component("a!b*c'd(e)f"), "a!b*c'd(e)f");
        assert_eq!(encode_component("a b"), "a%20b");
        assert_eq!(encode_component("中"), "%E4%B8%AD");
        assert_eq!(encode_component("=&?"), "%3D%26%3F");
    }

    #[test]
    fn ticket_never_lands_on_branch_one() {
        for base in [1728388016000i64, 1728388016123, 1700000000000] {
            let pairs: Pairs = vec![("aid".into(), "8662".into())];
            let signed = sign_request("/x", &pairs, base, "123", None, draw_entropy(base));
            // 复算一次，确认分支不为 1
            let query_for_check = signed.query.clone();
            let sum = sm3(query_for_check.as_bytes());
            let khronos = signed
                .headers
                .iter()
                .find(|(k, _)| k == "x-khronos")
                .map(|(_, v)| v.parse::<u32>().unwrap())
                .unwrap();
            assert_ne!(
                branch_of(&sum, &[0u8; 16], &le32(khronos)),
                1,
                "_rticket 探测失效"
            );
        }
    }
}
