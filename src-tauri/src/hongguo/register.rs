//! 匿名设备注册报文。
//!
//! 移植自 `internal/protocol/register.go`。报文结构是 `ss_app_log` 信封：
//!
//! ```text
//! {"magic_tag":"ss_app_log","header":{...},"_gen_time":<ms>}
//!   → gzip → tt_encrypt（自定义信封 + AES-256-CBC）
//! ```
//!
//! **字段顺序参与字节结果**（服务端会校验），所以这里不能用 `serde_json::Map`
//! 的默认顺序，必须按 `HEADER_ORDER` 逐项拼接。

use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::hongguo::consts::{DEVICE_PLATFORM, PACKAGE, VERSION_NAME};
use crate::hongguo::device::DeviceProfile;
use crate::hongguo::prim::md5;
use crate::hongguo::sm3::hex_upper;
use crate::hongguo::tt_encrypt::tt_encrypt;

/// 注册与后续请求要用的身份。
#[derive(Debug, Clone)]
pub struct RegisterResult {
    pub device_id: String,
    pub install_id: String,
    pub new_user: i64,
}

/// header 的字段顺序（Go 侧 `bootstrapHeaderOrder`）。
const HEADER_ORDER: &[&str] = &[
    "display_name",
    "update_version_code",
    "manifest_version_code",
    "app_version_minor",
    "aid",
    "channel",
    "package",
    "app_version",
    "version_code",
    "os",
    "os_version",
    "os_api",
    "device_model",
    "device_brand",
    "device_manufacturer",
    "cpu_abi",
    "language",
    "timezone",
    "access",
    "region",
    "tz_name",
    "tz_offset",
    "cdid",
    "openudid",
    "clientudid",
    "ipv6_list",
    "sim_serial_number",
    "oaid",
    "oaid_may_support",
    "req_id",
    "device_platform",
    "guest_mode",
    "is_system_app",
    "sdk_flavor",
    "device_id",
    "install_id",
];

fn s(v: &str) -> Value {
    Value::String(v.to_string())
}

fn n(v: i64) -> Value {
    Value::Number(v.into())
}

fn bootstrap_oaid(id: &str, issued_at: DateTime<Utc>) -> Value {
    // ⚠️ 必须是**列名字典序**：Go 侧这个字段是 map[string]any，
    // encoding/json 会对 map 键排序后再输出。用 serde_json::Map 的插入顺序
    // 会得到不同的字节序列，服务端回 device_id=0（静默拒绝注册）。
    let mut m = serde_json::Map::new();
    m.insert("hw_id_version_code".into(), s("0"));
    m.insert("id".into(), s(id));
    m.insert("is_track_limited".into(), s("false"));
    m.insert("query_times".into(), s("1"));
    m.insert("req_id".into(), s(id));
    m.insert("take_ms".into(), s("6"));
    m.insert("time".into(), s(&issued_at.timestamp_millis().to_string()));
    Value::Object(m)
}

fn build_header(profile: &DeviceProfile, now: DateTime<Utc>) -> Vec<(String, Value)> {
    let d = profile.device_or_default();
    let oaid_at = now - chrono::Duration::milliseconds(200);

    let pairs: Vec<(String, Value)> = vec![
        ("display_name".into(), s("红果免费短剧")),
        ("update_version_code".into(), n(73932)),
        ("manifest_version_code".into(), n(73932)),
        ("app_version_minor".into(), s(VERSION_NAME)),
        ("aid".into(), n(8662)),
        ("channel".into(), s(&d.channel)),
        ("package".into(), s(PACKAGE)),
        ("app_version".into(), s(VERSION_NAME)),
        ("version_code".into(), n(73932)),
        ("os".into(), s("Android")),
        ("os_version".into(), s(&d.os_version)),
        ("os_api".into(), n(d.os_api as i64)),
        ("device_model".into(), s(&d.model)),
        ("device_brand".into(), s(&d.brand)),
        ("device_manufacturer".into(), s(&d.brand)),
        ("cpu_abi".into(), s("arm64-v8a")),
        ("language".into(), s("zh")),
        ("timezone".into(), n(8)),
        ("access".into(), s("wifi")),
        ("region".into(), s("CN")),
        ("tz_name".into(), s("Asia/Shanghai")),
        ("tz_offset".into(), n(28800)),
        ("cdid".into(), s(&profile.cdid)),
        ("openudid".into(), s(&profile.openudid)),
        ("clientudid".into(), s(&profile.clientudid)),
        ("ipv6_list".into(), Value::Array(vec![])),
        ("sim_serial_number".into(), Value::Array(vec![])),
        ("oaid".into(), bootstrap_oaid(&profile.oaid_id, oaid_at)),
        ("oaid_may_support".into(), Value::Bool(true)),
        ("req_id".into(), s(&profile.req_id)),
        ("device_platform".into(), s(DEVICE_PLATFORM)),
        ("guest_mode".into(), n(0)),
        ("is_system_app".into(), n(0)),
        ("sdk_flavor".into(), s("china")),
        ("device_id".into(), s("0")),
        ("install_id".into(), s("0")),
    ];
    pairs
}

/// 把 header 按固定顺序序列化成 JSON 对象文本。
fn marshal_ordered(pairs: &[(String, Value)]) -> String {
    let mut seen: Vec<&str> = Vec::new();
    let mut out = String::from("{");
    let mut first = true;

    let push = |out: &mut String, first: &mut bool, key: &str, value: &Value| {
        if !*first {
            out.push(',');
        }
        *first = false;
        out.push_str(&serde_json::to_string(key).unwrap_or_else(|_| "\"\"".into()));
        out.push(':');
        out.push_str(&serde_json::to_string(value).unwrap_or_else(|_| "null".into()));
    };

    // 先按既定顺序，再补剩余（按字典序）
    for key in HEADER_ORDER {
        if let Some((_, v)) = pairs.iter().find(|(k, _)| k == key) {
            push(&mut out, &mut first, key, v);
            seen.push(key);
        }
    }
    let mut rest: Vec<&(String, Value)> = pairs
        .iter()
        .filter(|(k, _)| !seen.contains(&k.as_str()))
        .collect();
    rest.sort_by(|a, b| a.0.cmp(&b.0));
    for (k, v) in rest {
        push(&mut out, &mut first, k, v);
    }

    out.push('}');
    out
}

/// 诊断：返回 oaid 对象的键顺序（用于测试断言）。
pub(crate) fn debug_oaid_order(profile: &DeviceProfile) -> String {
    let v = bootstrap_oaid(&profile.oaid_id, Utc::now());
    match v {
        Value::Object(m) => m.keys().cloned().collect::<Vec<_>>().join(","),
        _ => String::new(),
    }
}

/// 构造注册报文（gzip + tt_encrypt 之后的可直接发送字节）。
pub fn build_register_body(profile: &DeviceProfile) -> Vec<u8> {
    build_register_body_at(profile, Utc::now())
}

/// 同上，但时间可注入（用于与 Go 实现逐字节比对）。
pub fn build_register_body_at(profile: &DeviceProfile, now: DateTime<Utc>) -> Vec<u8> {
    let header = build_header(profile, now);
    let header_json = marshal_ordered(&header);

    let plain = format!(
        r#"{{"magic_tag":"ss_app_log","header":{header_json},"_gen_time":{}}}"#,
        now.timestamp_millis()
    );

    // gzip：与 Go 的 gzip.DefaultCompression + OS=255 一致
    let compressed = gzip(&plain.into_bytes());
    tt_encrypt(&compressed)
}

/// 构造 gzip 之前的明文（与 Go 的 BuildBootstrapPlaintext 对应）。
pub fn build_register_plaintext(profile: &DeviceProfile, now: DateTime<Utc>) -> String {
    let header = build_header(profile, now);
    let header_json = marshal_ordered(&header);
    format!(
        r#"{{"magic_tag":"ss_app_log","header":{header_json},"_gen_time":{}}}"#,
        now.timestamp_millis()
    )
}

fn gzip(data: &[u8]) -> Vec<u8> {
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    let mut encoder = GzEncoder::new(Vec::new(), Compression::new(6));
    let _ = encoder.write_all(data);
    encoder.finish().unwrap_or_default()
}

/// 解析注册响应，取出 `device_id_str` / `install_id_str`。
pub fn parse_register(raw: &[u8]) -> Result<RegisterResult, String> {
    let env: Value = serde_json::from_slice(raw).map_err(|e| format!("注册响应不是 JSON: {e}"))?;

    let flex = |v: Option<&Value>| -> String {
        match v {
            Some(Value::String(s)) => s.trim().to_string(),
            Some(Value::Number(n)) => n.to_string(),
            _ => String::new(),
        }
    };

    let device_id = flex(env.get("device_id_str"));
    let install_id = flex(env.get("install_id_str"));
    let new_user = env.get("new_user").and_then(|v| v.as_i64()).unwrap_or(0);

    if device_id.is_empty() || device_id == "0" || install_id.is_empty() || install_id == "0" {
        return Err("匿名注册没有返回有效身份".into());
    }
    Ok(RegisterResult {
        device_id,
        install_id,
        new_user,
    })
}

/// `X-SS-STUB`：请求体 MD5 的大写 hex。
pub fn content_md5(body: &[u8]) -> String {
    hex_upper(&md5(body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_has_tt_envelope() {
        let p = DeviceProfile::new_anonymous();
        let body = build_register_body(&p);
        assert_eq!(&body[..6], &[0x74, 0x63, 0x05, 0x10, 0x00, 0x00]);
        assert!(body.len() > 100);
    }

    #[test]
    fn header_order_is_stable() {
        let p = DeviceProfile::new_anonymous();
        let h = build_header(&p, Utc::now());
        let json = marshal_ordered(&h);
        // 前三个字段必须按既定顺序出现
        let i_display = json.find("\"display_name\"").unwrap();
        let i_update = json.find("\"update_version_code\"").unwrap();
        let i_manifest = json.find("\"manifest_version_code\"").unwrap();
        assert!(i_display < i_update && i_update < i_manifest);
    }

    #[test]
    fn register_parse_rejects_zero_ids() {
        assert!(parse_register(br#"{"device_id_str":"0","install_id_str":"0"}"#).is_err());
        let ok = parse_register(br#"{"device_id_str":"123","install_id_str":"456"}"#).unwrap();
        assert_eq!(ok.device_id, "123");
    }
}
