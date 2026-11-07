//! 短剧列表（筛选、排行榜、上新）的续页游标。
//!
//! 移植自 `internal/protocol/cursor.go` 的 `ShortCursor` 与 `sdk/rank.go` 的
//! `nextShortCursor`。游标是 `s1.` 前缀加 base64url（无填充）包住的 JSON，
//! 字段名刻意很短（`o`、`s`、`x`、`q`、`c`、`b`、`d`），与 Go 一一对应。
//!
//! 游标里记着已经展示过的剧（`s`），服务端靠它跳过重复，所以续页不会重复出现同一部剧。

use std::collections::BTreeMap;

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::hongguo::client::{HongguoError, Result};

/// 续页游标。字段与 Go 的 `ShortCursor` 一一对应，JSON 键见各字段注释。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShortCursor {
    /// 偏移量（`o`）。
    #[serde(rename = "o", default)]
    pub offset: i64,
    /// 已经展示过的剧 id（`s`），续页时带给服务端去重。
    #[serde(rename = "s", default, skip_serializing_if = "Vec::is_empty")]
    pub seen: Vec<String>,
    /// 服务端会话（`x`）。
    #[serde(rename = "x", default, skip_serializing_if = "String::is_empty")]
    pub session: String,
    /// 筛选项（`q`）：行 key → 选中的值。
    #[serde(rename = "q", default, skip_serializing_if = "BTreeMap::is_empty")]
    pub selections: BTreeMap<String, Vec<String>>,
    /// 榜单 content（`c`）。
    #[serde(rename = "c", default, skip_serializing_if = "String::is_empty")]
    pub content: String,
    /// 榜单 board（`b`）。
    #[serde(rename = "b", default, skip_serializing_if = "String::is_empty")]
    pub board: String,
    /// 上新日历的日期 YYYYMMDD（`d`）。
    #[serde(rename = "d", default, skip_serializing_if = "String::is_empty")]
    pub date: String,
}

const PREFIX: &str = "s1.";

impl ShortCursor {
    /// 打包成不透明的字符串令牌。
    pub fn encode(&self) -> Result<String> {
        let raw = serde_json::to_vec(self)
            .map_err(|e| HongguoError::Other(format!("游标编码失败：{e}")))?;
        Ok(format!(
            "{PREFIX}{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw)
        ))
    }

    /// 解开令牌。空串表示第一页，返回默认游标。
    pub fn decode(token: &str) -> Result<Self> {
        if token.is_empty() {
            return Ok(Self::default());
        }
        let invalid = || HongguoError::Other("短剧游标不合法".into());
        let payload = token.strip_prefix(PREFIX).ok_or_else(invalid)?;
        let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload)
            .map_err(|_| invalid())?;
        let cur: ShortCursor = serde_json::from_slice(&raw).map_err(|_| invalid())?;
        if cur.offset < 0 || cur.session.contains(['\r', '\n']) {
            return Err(invalid());
        }
        Ok(cur)
    }
}

/// 用一页结果扩展游标，得到下一页的令牌；到末尾时返回 `None`。
///
/// 与 Go 的 `nextShortCursor` 一致：没有更多、没有内容、或偏移没有前进，都视为结束。
/// 这一条很重要：服务端若回传同一个偏移，不判结束就会无限续页。
pub fn next_short_cursor(
    cur: &ShortCursor,
    has_more: bool,
    next_offset: i64,
    session: &str,
    ids: &[String],
) -> Result<Option<String>> {
    if !has_more || ids.is_empty() || next_offset <= cur.offset {
        return Ok(None);
    }
    let mut next = cur.clone();
    next.offset = next_offset;
    next.seen.extend(ids.iter().cloned());
    next.session = session.to_string();
    next.encode().map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_with_s1_prefix() {
        let mut selections = BTreeMap::new();
        selections.insert("genre".to_string(), vec!["short_play".to_string()]);
        let cur = ShortCursor {
            offset: 18,
            seen: vec!["111".into(), "222".into()],
            session: "sess".into(),
            selections,
            content: "all".into(),
            board: "b1".into(),
            date: "20261029".into(),
        };
        let token = cur.encode().unwrap();
        assert!(token.starts_with("s1."), "{token}");
        assert_eq!(ShortCursor::decode(&token).unwrap(), cur);
    }

    #[test]
    fn empty_token_is_first_page() {
        assert_eq!(ShortCursor::decode("").unwrap(), ShortCursor::default());
    }

    #[test]
    fn rejects_bad_tokens() {
        assert!(ShortCursor::decode("xx.abc").is_err());
        assert!(ShortCursor::decode("s1.!!!").is_err());
        let neg = ShortCursor {
            offset: -1,
            ..Default::default()
        };
        assert!(ShortCursor::decode(&neg.encode().unwrap()).is_err());
    }

    #[test]
    fn next_cursor_accumulates_seen_and_advances() {
        let cur = ShortCursor {
            offset: 0,
            seen: vec!["111".into()],
            ..Default::default()
        };
        let token = next_short_cursor(&cur, true, 18, "S", &["222".into(), "333".into()])
            .unwrap()
            .expect("应当有下一页");
        let next = ShortCursor::decode(&token).unwrap();
        assert_eq!(next.offset, 18);
        assert_eq!(next.seen, vec!["111", "222", "333"]);
        assert_eq!(next.session, "S");
    }

    #[test]
    fn next_cursor_ends_when_done_or_stalled() {
        let cur = ShortCursor {
            offset: 18,
            ..Default::default()
        };
        let ids = vec!["1".to_string()];
        // 没有更多
        assert!(next_short_cursor(&cur, false, 36, "s", &ids)
            .unwrap()
            .is_none());
        // 没有内容
        assert!(next_short_cursor(&cur, true, 36, "s", &[])
            .unwrap()
            .is_none());
        // 偏移没有前进：服务端回传同一个 offset，必须判结束，否则会死循环
        assert!(next_short_cursor(&cur, true, 18, "s", &ids)
            .unwrap()
            .is_none());
    }
}
