//! 播放模型（`video_model`）的解析与数据模型。
//!
//! 移植自 `internal/protocol/parse.go` 的播放相关部分。上游字段类型不稳定
//! （同一个键有时是字符串、有时是数字、有时是 JSON 字符串里再套 JSON），
//! 所以这里全程用 `serde_json::Value` + 容错取值，而不是强类型反序列化 ——
//! 强类型会在真实响应上因为一个 `"0"` vs `0` 就整条解析失败。

use serde_json::Value;

/// 一路码流。
#[derive(Debug, Clone, Default)]
pub struct Stream {
    pub definition: String,
    pub quality: String,
    pub codec: String,
    pub width: i32,
    pub height: i32,
    pub bitrate: i64,
    pub size: i64,
    pub url: String,
    pub backup_url: String,
    pub hls: bool,
    pub dash: bool,
    pub protected: bool,
    pub encryption: String,
}

/// 一集的播放模型。
#[derive(Debug, Clone, Default)]
pub struct Playback {
    pub episode_id: String,
    pub video_id: String,
    pub media_type: String,
    pub duration_seconds: i32,
    pub expires_at: i64,
    pub streams: Vec<Stream>,
    pub audio_url: String,
    pub protected: bool,
    /// 包装后的密钥材料（`spade_a`），交给 `drm::derive` 解包。
    pub key_material: String,
}

impl Playback {
    /// 最高档位（按高度取最大；同高度取码率高者）。
    pub fn best_stream(&self) -> Option<&Stream> {
        self.streams.iter().max_by_key(|s| (s.height, s.bitrate))
    }
}

/// 取字符串：字符串原样返回，数字转文本，其余空串。
fn flex_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

fn flex_i64(v: &Value) -> i64 {
    match v {
        Value::Number(n) => n.as_i64().unwrap_or(0),
        Value::String(s) => s.trim().parse::<i64>().unwrap_or(0),
        _ => 0,
    }
}

fn flex_f64(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) => s.trim().parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// 上游用 boolean / 数字 / 字符串 / 对象等多种写法表达真值。
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_i64().map(|x| x != 0).unwrap_or(true),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                return false;
            }
            !matches!(t.to_ascii_lowercase().as_str(), "false" | "0")
        }
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

fn non_empty(v: Option<&Value>) -> Option<&Value> {
    match v {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.trim().is_empty() => None,
        Some(Value::Array(a)) if a.is_empty() => None,
        Some(Value::Object(o)) if o.is_empty() => None,
        Some(other) => Some(other),
    }
}

fn first_of(a: String, b: String) -> String {
    if a.is_empty() {
        b
    } else {
        a
    }
}

/// `video_model` 可能是对象，也可能是「装了 JSON 的字符串」。
fn playback_object(raw: &Value) -> Result<Value, String> {
    // 最多解两层字符串，防止恶意/异常响应里无限嵌套（用 owned 链而非引用链，
    // 避免自引用生命周期问题）
    fn go(v: &Value, depth: u8) -> Result<Value, String> {
        if depth == 0 {
            return Err("播放模型嵌套过深".into());
        }
        match v {
            Value::String(s) => {
                let t = s.trim();
                if t.is_empty() {
                    return Err("播放模型缺失".into());
                }
                let owned: Value =
                    serde_json::from_str(t).map_err(|e| format!("播放模型不是 JSON: {e}"))?;
                if owned.is_object() {
                    Ok(owned)
                } else {
                    go(&owned, depth - 1)
                }
            }
            Value::Object(_) => Ok(v.clone()),
            _ => Err("播放模型不是对象".into()),
        }
    }
    go(raw, 3)
}

/// 从 `video_meta` 或条目本身取字段。
fn pick(meta: &Value, item: &Value, key: &str) -> Value {
    if let Some(v) = non_empty(meta.get(key)) {
        return v.clone();
    }
    item.get(key).cloned().unwrap_or(Value::Null)
}

fn pick_str(meta: &Value, item: &Value, key: &str) -> String {
    flex_str(&pick(meta, item, key))
}

fn pick_i64(meta: &Value, item: &Value, key: &str) -> i64 {
    flex_i64(&pick(meta, item, key))
}

fn pick_i32(meta: &Value, item: &Value, key: &str) -> i32 {
    pick_i64(meta, item, key) as i32
}

/// 把一条码流条目转成 `Stream`。
fn item_to_stream(item: &Value) -> Stream {
    let meta = item.get("video_meta").cloned().unwrap_or(Value::Null);

    let encrypt_info = non_empty(item.get("encrypt_info"));
    let encryption_method = {
        let direct = flex_str(
            &item
                .get("encryption_method")
                .cloned()
                .unwrap_or(Value::Null),
        );
        if !direct.is_empty() {
            direct
        } else {
            encrypt_info
                .and_then(|e| e.get("encryption_method"))
                .map(flex_str)
                .unwrap_or_default()
        }
    };

    let gear_des_key = flex_str(&item.get("gear_des_key").cloned().unwrap_or(Value::Null));
    let spade_a = flex_str(&item.get("spade_a").cloned().unwrap_or(Value::Null));
    let kid = flex_str(&item.get("kid").cloned().unwrap_or(Value::Null));

    let protected = if let Some(info) = encrypt_info {
        if info.is_object() {
            let encrypt = info.get("encrypt").map(truthy).unwrap_or(false);
            let _method = info
                .get("encryption_method")
                .map(flex_str)
                .unwrap_or_default();
            let info_kid = info.get("kid").map(flex_str).unwrap_or_default();
            let info_spade = info.get("spade_a").map(flex_str).unwrap_or_default();
            encrypt
                || !encryption_method.is_empty()
                || !info_kid.is_empty()
                || !info_spade.is_empty()
        } else {
            true
        }
    } else {
        !gear_des_key.is_empty()
            || !spade_a.is_empty()
            || !kid.is_empty()
            || !encryption_method.is_empty()
            || truthy(&item.get("encrypt").cloned().unwrap_or(Value::Null))
            || non_empty(item.get("check_info")).is_some()
    };

    let mut definition = pick_str(&meta, item, "definition");
    let mut quality = pick_str(&meta, item, "quality");
    let quality_desc = flex_str(&item.get("quality_desc").cloned().unwrap_or(Value::Null));
    if quality.is_empty() && !quality_desc.is_empty() {
        quality = quality_desc;
    }
    let vtype = flex_str(&item.get("vtype").cloned().unwrap_or(Value::Null));
    let mut hls = truthy(&item.get("hls").cloned().unwrap_or(Value::Null))
        || !flex_str(&item.get("m3u8").cloned().unwrap_or(Value::Null)).is_empty();
    if definition.is_empty() && vtype.eq_ignore_ascii_case("m3u8") {
        hls = true;
    }
    if definition.is_empty() {
        definition = String::new();
    }

    let dash = pick_str(&meta, item, "vtype").eq_ignore_ascii_case("dash")
        || vtype.eq_ignore_ascii_case("dash");

    Stream {
        definition,
        quality,
        codec: pick_str(&meta, item, "codec_type"),
        width: pick_i32(&meta, item, "vwidth"),
        height: pick_i32(&meta, item, "vheight"),
        bitrate: pick_i64(&meta, item, "bitrate"),
        size: pick_i64(&meta, item, "size"),
        url: flex_str(&item.get("main_url").cloned().unwrap_or(Value::Null)),
        backup_url: first_of(
            flex_str(&item.get("backup_url").cloned().unwrap_or(Value::Null)),
            flex_str(&item.get("backup_url_1").cloned().unwrap_or(Value::Null)),
        ),
        hls,
        dash,
        protected,
        encryption: encryption_method,
    }
}

/// `video_list` 可能是数组，也可能是按档位名索引的对象。
fn parse_items(raw: &Value) -> Vec<Value> {
    match raw {
        Value::Array(a) => a.clone(),
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort();
            keys.into_iter()
                .map(|k| {
                    let mut item = o[k].clone();
                    if let Value::Object(ref mut map) = item {
                        // 键名即档位：条目自己没有 definition 时用键名
                        let has = map.get("definition").map(|v| !flex_str(v).is_empty())
                            == Some(true)
                            || map
                                .get("video_meta")
                                .and_then(|m| m.get("definition"))
                                .map(|v| !flex_str(v).is_empty())
                                == Some(true);
                        if !has {
                            map.insert("definition".into(), Value::String(k.clone()));
                        }
                    }
                    item
                })
                .collect()
        }
        _ => Vec::new(),
    }
}

fn wrapped_key(item: &Value) -> String {
    if let Some(info) = non_empty(item.get("encrypt_info")) {
        if let Some(k) = info.get("spade_a") {
            let s = flex_str(k);
            if !s.is_empty() {
                return s;
            }
        }
    }
    flex_str(&item.get("spade_a").cloned().unwrap_or(Value::Null))
}

/// 解析 `video_model` 响应体。
pub fn parse_playback(raw: &[u8], episode_id: &str) -> Result<Playback, String> {
    let env: Value = serde_json::from_slice(raw).map_err(|e| format!("播放响应不是 JSON: {e}"))?;

    let code = flex_str(&env.get("code").cloned().unwrap_or(Value::Null));
    if !code.is_empty() && code != "0" {
        let msg = flex_str(&env.get("message").cloned().unwrap_or(Value::Null));
        return Err(format!("播放接口返回错误码 {code}：{msg}"));
    }

    let video_model = env
        .get("data")
        .and_then(|d| d.get("video_model"))
        .cloned()
        .ok_or_else(|| "响应里没有 data.video_model".to_string())?;
    let body = playback_object(&video_model)?;

    let video_list = body.get("video_list").cloned().unwrap_or(Value::Null);
    let mut items = Vec::new();
    if let Some(list) = non_empty(Some(&video_list)) {
        items = parse_items(list);
    }

    let mut audio_url = String::new();
    if items.is_empty() {
        // 长片走 DASH：视频轨与音频轨分开下发，没有 video_list
        if let Some(dynamic) = body.get("dynamic_video").and_then(|d| non_empty(Some(d))) {
            if let Some(vl) = dynamic
                .get("dynamic_video_list")
                .and_then(|v| non_empty(Some(v)))
            {
                items = match vl {
                    Value::Array(a) => a.clone(),
                    _ => Vec::new(),
                };
            }
            // 内层先把类型收窄成切片，避免多层 if let（let-chain 需 Rust 2024）。
            if let Some(al) = dynamic
                .get("dynamic_audio_list")
                .and_then(|v| non_empty(Some(v)))
            {
                // `al` 在两个 if let 里各自使用（第二个只是判别类型），clippy
                // 建议的合并写法是 let-chain（Rust 2024 语法），这里保持分步。
                let first = match al {
                    Value::Array(a) => a.first(),
                    _ => None,
                };
                if let Some(first) = first {
                    audio_url = flex_str(&first.get("main_url").cloned().unwrap_or(Value::Null));
                }
            }
        }
    }

    if items.is_empty() {
        return Err("播放模型不可用（没有任何码流）".into());
    }

    let mut out = Playback {
        episode_id: episode_id.to_string(),
        video_id: flex_str(&body.get("video_id").cloned().unwrap_or(Value::Null)),
        media_type: flex_str(&body.get("media_type").cloned().unwrap_or(Value::Null)),
        duration_seconds: (flex_f64(&body.get("video_duration").cloned().unwrap_or(Value::Null))
            + 0.5) as i32,
        expires_at: flex_i64(&body.get("url_expire").cloned().unwrap_or(Value::Null)),
        streams: Vec::new(),
        audio_url,
        protected: false,
        key_material: String::new(),
    };

    let mut protected_count = 0usize;
    for item in &items {
        let stream = item_to_stream(item);
        if stream.url.is_empty() {
            continue;
        }
        if stream.protected {
            protected_count += 1;
        }
        if out.key_material.is_empty() {
            out.key_material = wrapped_key(item);
        }
        out.streams.push(stream);
    }

    if out.streams.is_empty() {
        return Err("播放模型不可用（码流都没有地址）".into());
    }
    out.protected = protected_count == out.streams.len();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_object_video_model() {
        let raw = br#"{
            "code": 0,
            "data": {"video_model": "{\"video_id\":\"v1\",\"video_duration\":209.4,\"video_list\":{\"1080p\":{\"main_url\":\"https://x/a.mp4\",\"vheight\":1080,\"bitrate\":628000,\"encrypt_info\":{\"encrypt\":true,\"encryption_method\":\"cenc-aes-ctr\",\"spade_a\":\"AAA\"}}}}"}
        }"#;
        let pb = parse_playback(raw, "ep1").unwrap();
        assert_eq!(pb.video_id, "v1");
        assert_eq!(pb.duration_seconds, 209);
        assert_eq!(pb.streams.len(), 1);
        assert_eq!(pb.streams[0].definition, "1080p");
        assert!(pb.streams[0].protected);
        assert_eq!(pb.key_material, "AAA");
        assert_eq!(pb.streams[0].height, 1080);
    }

    #[test]
    fn error_code_surfaces() {
        let raw = r#"{"code": 101000, "message": "服务异常"}"#.as_bytes();
        let err = parse_playback(raw, "ep1").unwrap_err();
        assert!(err.contains("101000"), "{err}");
    }

    #[test]
    fn empty_body_is_reported_as_anonymous_limited_shape() {
        // 空 body 在 client 层会被识别为静默拒绝，这里只保证解析器不 panic
        assert!(parse_playback(b"", "ep1").is_err());
    }
}
