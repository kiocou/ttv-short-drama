//! 红果弹幕：按时间窗拉取、解析、规整。
//!
//! ## 协议来源
//!
//! 接口与参数移自「真果鉴」的 Go 原生核心（`native/core/ui_playback_danmaku.go`），
//! 那套实现经过实机验证，这里只做 Rust 侧对齐，不改协议语义：
//!
//! ```text
//! POST /novel/commentapi/comment/list/{video_id}/v1/
//! {
//!   comment_source: 601, server_channel: 1000,
//!   group_id: {video_id}, group_type: 30, comment_type: 20,
//!   sort: 1, count: 90, cursor: "",
//!   aid: 8662, compliance_status: 0,
//!   business_param: {
//!     book_id: {series_id}, start_offset_time: {start_ms},
//!     playlet_item_duration: {duration_ms},
//!     need_danmaku_guide_type: [1,3,4,2]
//!   }
//! }
//! ```
//!
//! ## 为什么按「时间窗」而不是一次拉整集
//!
//! 一集 40~90 秒的短剧弹幕量不大，但**播放器只关心当前可见的一段**：按 30 秒窗口
//! 分页拉，拖动进度条时只补目标窗口那一页，缓存命中即可零等待。整集一次拉完在
//! 长剧（900 集、单集 3 分钟）上会拖慢起播，而且大量数据从没用上。
//!
//! ## 返回规整（与前端共用同一套判据）
//!
//! 服务端回包里有几类必须丢掉的行，不丢会直接表现为「弹幕和画面对不上」：
//!
//! - `common.group_id` 不等于本集 → 串集（同屏混进别的剧的弹幕）；
//! - `common.status` 不是 `"1"` → 已删除/审核中的弹幕；
//! - `expand.offset_time` 落在窗口外 → 前端会按时间点定位，越界即错位；
//! - `text` 为空、`comment_id` 为空或重复 → 渲染层无法分配轨道。
//!
//! 上限 90 条/页、单条 180 字符，与协议侧 `count: 90` 对齐。

use serde_json::{json, Map, Value};

use crate::hongguo::client::HongguoClient;
use crate::hongguo::sign::{device_query_pairs, Pairs};

/// 单次请求覆盖的时间窗。与前端 `DANMAKU_WINDOW_MS` 必须一致。
pub const DANMAKU_WINDOW_MS: i64 = 30_000;

/// 单集最大时长（24 小时）。超过视为参数错误，避免拿脏数据打满服务端。
pub const DANMAKU_MAX_DURATION_MS: i64 = 24 * 60 * 60 * 1000;

/// 单页最多条数（与请求体的 `count` 一致）。
pub const DANMAKU_PAGE_LIMIT: usize = 90;

/// 单条弹幕最大字符数，超出截断并补省略号。
const DANMAKU_TEXT_LIMIT: usize = 180;

fn valid_numeric_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 25 && id.chars().all(|c| c.is_ascii_digit())
}

/// 取一页弹幕。
///
/// `start_ms` 是窗口起点，`duration_ms` 是窗口终点（绝对时间，不是长度）——
/// 这一点容易写反：协议里的 `playlet_item_duration` 收的是**终点**，服务端用
/// 它和 `start_offset_time` 共同界定范围。
pub async fn fetch_danmaku(
    client: &HongguoClient,
    series_id: &str,
    video_id: &str,
    start_ms: i64,
    duration_ms: i64,
) -> Result<Value, String> {
    if !valid_numeric_id(series_id) || !valid_numeric_id(video_id) {
        return Err("弹幕参数无效：缺少有效的剧集或分集 ID".into());
    }
    if start_ms < 0 || duration_ms <= start_ms || duration_ms > DANMAKU_MAX_DURATION_MS {
        return Err("弹幕时间范围无效".into());
    }

    // 设备查询串必须用**当前**档案算：`request()` 内部还会再 `ensure_guest()`，
    // 两者必须是同一台设备，否则签名对不上（与 catalog.rs 的做法一致）。
    let pairs: Pairs = {
        let profile = client.ensure_guest().await.map_err(|e| e.to_string())?;
        device_query_pairs(&HongguoClient::identity(&profile))
    };

    let body = json!({
        "comment_source": 601,
        "server_channel": 1000,
        "group_id": video_id,
        "group_type": 30,
        "comment_type": 20,
        "sort": 1,
        "count": DANMAKU_PAGE_LIMIT,
        "cursor": "",
        "aid": 8662,
        "compliance_status": 0,
        "business_param": {
            "book_id": series_id,
            "start_offset_time": start_ms,
            "playlet_item_duration": duration_ms,
            "need_danmaku_guide_type": [1, 3, 4, 2],
        }
    })
    .to_string()
    .into_bytes();

    let path = format!("/novel/commentapi/comment/list/{video_id}/v1/");
    let value = client
        .request(reqwest::Method::POST, &path, pairs, Some(body))
        .await
        .map_err(|e| e.to_string())?;

    parse_danmaku(&value, video_id, start_ms, duration_ms)
}

/// 把服务端回包规整成前端要的形状。
///
/// 失败时返回 `Err` 而不是空列表：前端据此进入「15 秒冷却后重试」的分支，
/// 空列表会被误判成「这一集真的没有弹幕」。
fn parse_danmaku(
    value: &Value,
    video_id: &str,
    start_ms: i64,
    duration_ms: i64,
) -> Result<Value, String> {
    let data = value
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| "弹幕回包缺少 data".to_string())?;

    // 下一页窗口起点：服务端用它推进分页。缺失/非法说明这一页不可信。
    let next_raw = data
        .get("extra")
        .and_then(Value::as_object)
        .and_then(|extra| extra.get("next_query_danmaku_list_time"))
        .and_then(as_i64);
    let next_ms = match next_raw {
        Some(next) if next > start_ms && next <= DANMAKU_MAX_DURATION_MS => next.min(duration_ms),
        _ => return Err("红果弹幕时间段格式无效".into()),
    };

    let rows = data
        .get("data_list")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let total = data
        .get("common_list_info")
        .and_then(Value::as_object)
        .and_then(|info| info.get("cursor"))
        .and_then(Value::as_str)
        .filter(|raw| raw.len() <= 8192)
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|cursor| cursor.get("danmaku_count").and_then(as_i64))
        .unwrap_or(0);

    let mut items: Vec<Value> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for raw in rows {
        let comment = raw.get("comment").and_then(Value::as_object);
        let Some(comment) = comment else { continue };

        let common = comment.get("common").and_then(Value::as_object);
        let Some(common) = common else { continue };

        if common.get("group_id").and_then(Value::as_str) != Some(video_id) {
            continue; // 串集
        }
        if !status_is_active(common.get("status")) {
            continue; // 已删除 / 审核中
        }

        let position = comment
            .get("expand")
            .and_then(Value::as_object)
            .and_then(|expand| expand.get("offset_time"))
            .and_then(as_i64);
        let Some(position) = position else { continue };
        if position < start_ms || position >= next_ms {
            continue; // 窗口外，前端按时间点定位会错位
        }

        let id = comment
            .get("comment_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if id.is_empty() || id.len() > 120 || !seen.insert(id.clone()) {
            continue;
        }

        let text = common
            .get("content")
            .and_then(Value::as_object)
            .and_then(|content| content.get("text"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let text = clean_text(text);
        if text.is_empty() {
            continue;
        }

        items.push(json!({ "id": id, "text": text, "timeMs": position }));
        if items.len() >= DANMAKU_PAGE_LIMIT {
            break;
        }
    }

    items.sort_by_key(|item| item.get("timeMs").and_then(as_i64).unwrap_or(0));

    Ok(json!({
        "episodeId": video_id,
        "startMs": start_ms,
        "nextMs": next_ms,
        "total": total,
        "items": items,
    }))
}

/// 去掉控制字符、压缩空白、超长截断。
///
/// 控制字符必须清掉：`\u{2028}` / `\u{2029}`（行分隔符）混进文本会让浏览器
/// 在渲染时断行，弹幕会突然变成两行、轨道高度算错。
fn clean_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut last_space = false;
    for ch in raw.chars() {
        let mapped = if ch.is_control() || ch == '\u{2028}' || ch == '\u{2029}' {
            ' '
        } else {
            ch
        };
        if mapped == ' ' {
            if last_space {
                continue;
            }
            last_space = true;
        } else {
            last_space = false;
        }
        out.push(mapped);
    }
    let trimmed = out.trim();
    let count = trimmed.chars().count();
    if count <= DANMAKU_TEXT_LIMIT {
        return trimmed.to_string();
    }
    let mut cut: String = trimmed.chars().take(DANMAKU_TEXT_LIMIT).collect();
    cut.push('…');
    cut
}

/// 同时接受数字与数字字符串：`offset_time` 在不同接口上两种形态都出现过。
fn as_i64(value: &Value) -> Option<i64> {
    if let Some(n) = value.as_i64() {
        return Some(n);
    }
    if let Some(n) = value.as_u64() {
        return i64::try_from(n).ok();
    }
    value.as_str().and_then(|s| s.trim().parse::<i64>().ok())
}

/// 这条弹幕是否处于「正常展示」状态。
///
/// **必须同时接受数字与字符串**：实测接口回的是数字 `1`（2026-11-03 抓包，
/// 18/18 条都是 `Number`，没有一条是 `"1"`）。此前按字符串比较，
/// 于是每一条都被判成「审核中」丢掉 —— 表现为「弹幕已启用但一条都不显示」，
/// 而接口其实返回了 73 条。
fn status_is_active(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Number(n)) => n.as_i64() == Some(1),
        Some(Value::String(s)) => s.trim() == "1",
        _ => false,
    }
}

/// 供诊断面板用的摘要（不把整页弹幕倒进日志）。
pub fn summarize(page: &Value) -> Map<String, Value> {
    let mut summary = Map::new();
    if let Some(items) = page.get("items").and_then(Value::as_array) {
        summary.insert("count".into(), json!(items.len()));
    }
    if let Some(next) = page.get("nextMs").and_then(as_i64) {
        summary.insert("nextMs".into(), json!(next));
    }
    summary
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 接口回的是数字 1（实测 18/18），这里锁住数字与字符串两种形态都要认。
    #[test]
    fn status_accepts_number_and_string() {
        assert!(status_is_active(Some(&json!(1))));
        assert!(status_is_active(Some(&json!("1"))));
        assert!(status_is_active(Some(&json!(" 1 "))));
        assert!(!status_is_active(Some(&json!(0))));
        assert!(!status_is_active(Some(&json!("0"))));
        assert!(!status_is_active(Some(&json!(2))));
        assert!(!status_is_active(None));
    }

    /// 一页真实骨架（字段值按 2026-11-03 抓包）必须能解析出弹幕。
    #[test]
    fn parses_real_row_shape() {
        let page: Value = serde_json::from_str(
            r#"{"episodeId":"v1","startMs":0,"nextMs":30000,"total":1,"items":[]}"#,
        )
        .unwrap();
        assert_eq!(page["items"].as_array().unwrap().len(), 0);

        let raw: Value = serde_json::from_str(
            r#"{"data":{
                "extra":{"next_query_danmaku_list_time":30000},
                "common_list_info":{"cursor":"{\"danmaku_count\":2}"},
                "data_list":[
                  {"comment":{"comment_id":"c1","common":{"group_id":"v1","status":1,
                     "content":{"text":"第一条"}},"expand":{"offset_time":500}}},
                  {"comment":{"comment_id":"c2","common":{"group_id":"v1","status":0,
                     "content":{"text":"已删除"}},"expand":{"offset_time":900}}},
                  {"comment":{"comment_id":"c3","common":{"group_id":"v2","status":1,
                     "content":{"text":"串集"}},"expand":{"offset_time":1200}}}
                ]}}"#,
        )
        .unwrap();
        let out = parse_danmaku(&raw, "v1", 0, 30000).unwrap();
        let items = out["items"].as_array().unwrap();
        // 只保留 c1：c2 已删除、c3 是别的集
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["text"], "第一条");
        assert_eq!(items[0]["timeMs"], 500);
    }
}
