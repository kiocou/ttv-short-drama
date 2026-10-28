//! 目录能力：搜索、详情、分集、首页推荐。
//!
//! 移植自 `internal/protocol/parse.go` 与 `internal/protocol/request.go` 的目录部分。
//! 上游把卡片塞在多层动态结构里（`search_tabs[].data[].video_data[]`、
//! `video_detail.video_detail_list[]`），层级在不同接口间还不一致，所以这里
//! 统一用「递归找 video_detail / series_card 形状」的容错策略，而不是写死路径。

use serde_json::Value;

use crate::hongguo::client::{HongguoClient, HongguoError, Result};
use crate::hongguo::consts::{
    PATH_DISCOVER, PATH_SEARCH, PATH_SERIES, PATH_SUGGEST, SEARCH_SOURCE_HOME, SEARCH_TAB_NAME,
    SEARCH_TAB_SHORT_PLAY,
};
use crate::hongguo::sign::{device_query_pairs, Pairs};

/// 目录卡片。
#[derive(Debug, Clone, Default)]
pub struct SeriesHit {
    pub id: String,
    pub title: String,
    pub cover: String,
    pub intro: String,
    pub episode_count: u32,
}

/// 一集。
#[derive(Debug, Clone, Default)]
pub struct EpisodeHit {
    pub id: String,
    pub series_id: String,
    pub number: u32,
    pub title: String,
    pub duration_seconds: f64,
    pub cover: String,
}

fn flex_str(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn flex_i64(v: Option<&Value>) -> i64 {
    match v {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

fn flex_f64(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// 尽力从各种卡片形状里抽出一条剧集信息。
fn hit_from_card(card: &Value) -> Option<SeriesHit> {
    let id = {
        let a = flex_str(card.get("series_id_str"));
        if !a.is_empty() {
            a
        } else {
            flex_str(card.get("series_id"))
        }
    };
    let title = flex_str(card.get("series_title"));
    if id.is_empty() || title.is_empty() {
        return None;
    }
    Some(SeriesHit {
        id,
        title,
        cover: flex_str(card.get("series_cover")),
        intro: flex_str(card.get("series_intro")),
        episode_count: flex_i64(card.get("episode_cnt")).max(0) as u32,
    })
}

/// 递归收集所有「长得像剧集卡片」的对象。
///
/// `video_detail` 里既可以放扁平卡片，也可以放 `video_detail_list`，
/// 搜索的「视频」tab 还会再嵌一层，写死路径必然会漏。
fn collect_hits(node: &Value, out: &mut Vec<SeriesHit>, depth: usize) {
    if depth > 6 {
        return;
    }
    match node {
        Value::Object(map) => {
            // 优先认 video_detail 形状
            if map.contains_key("series_title") {
                if let Some(hit) = hit_from_card(node) {
                    if !out.iter().any(|h| h.id == hit.id) {
                        out.push(hit);
                    }
                }
            }
            // 从 video_data 里取：外层 series_id + video_detail 内的标题
            if let (Some(sid), Some(vd)) = (map.get("series_id"), map.get("video_detail")) {
                let id = flex_str(Some(sid));
                let title = flex_str(vd.get("series_title"));
                if !id.is_empty() && !title.is_empty() {
                    let hit = SeriesHit {
                        id,
                        title,
                        cover: flex_str(vd.get("series_cover")),
                        intro: flex_str(vd.get("series_intro")),
                        episode_count: flex_i64(vd.get("episode_cnt")).max(0) as u32,
                    };
                    if !out.iter().any(|h| h.id == hit.id) {
                        out.push(hit);
                    }
                }
            }
            for (_, v) in map {
                collect_hits(v, out, depth + 1);
            }
        }
        Value::Array(arr) => {
            for v in arr {
                collect_hits(v, out, depth + 1);
            }
        }
        _ => {}
    }
}

impl HongguoClient {
    /// 搜索短剧。
    pub async fn search(
        &self,
        keyword: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<SeriesHit>> {
        // 设备被风控时换一台重试（与 resolve_playback 同一套处理：
        // 查询串里的 iid/device_id 是设备相关的，必须在 API 层重置）。
        match self.search_once(keyword, limit, offset).await {
            Err(error) if error.needs_device_reset() => {
                if self.reset_device().await.is_ok() {
                    return self.search_once(keyword, limit, offset).await;
                }
                Err(error)
            }
            other => other,
        }
    }

    async fn search_once(
        &self,
        keyword: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<SeriesHit>> {
        let keyword = keyword.trim();
        if keyword.is_empty() {
            return Ok(Vec::new());
        }
        let pairs: Pairs = {
            let profile = self.ensure_guest().await?;
            let mut p = device_query_pairs(&Self::identity(&profile));
            p.push(("query".into(), keyword.to_string()));
            p.push(("tab_type".into(), SEARCH_TAB_SHORT_PLAY.into()));
            p.push(("count".into(), limit.max(1).to_string()));
            p.push(("offset".into(), offset.to_string()));
            p.push(("use_correct".into(), "true".into()));
            p.push(("bookshelf_search_plan".into(), "4".into()));
            p.push(("search_source".into(), SEARCH_SOURCE_HOME.into()));
            p.push(("tab_name".into(), SEARCH_TAB_NAME.into()));
            p.push(("bookstore_tab".into(), "16".into()));
            p.push(("user_is_login".into(), "0".into()));
            p
        };

        let value = self
            .request(reqwest::Method::GET, PATH_SEARCH, pairs, None)
            .await?;

        // 只取 tab_type == 11（真人短剧）那一栏
        let mut hits = Vec::new();
        if let Some(tabs) = value.get("search_tabs").and_then(|t| t.as_array()) {
            for tab in tabs {
                let tab_type = flex_i64(tab.get("tab_type"));
                if tab_type != 0 && tab_type.to_string() != SEARCH_TAB_SHORT_PLAY {
                    continue;
                }
                collect_hits(tab, &mut hits, 0);
            }
        }
        if hits.is_empty() {
            collect_hits(&value, &mut hits, 0);
        }
        Ok(hits)
    }

    /// 搜索联想词。
    pub async fn suggest(&self, prefix: &str) -> Result<Vec<String>> {
        let pairs: Pairs = {
            let profile = self.ensure_guest().await?;
            let mut p = device_query_pairs(&Self::identity(&profile));
            p.push(("query".into(), prefix.trim().to_string()));
            p.push(("count".into(), "10".into()));
            p.push(("search_source".into(), SEARCH_SOURCE_HOME.into()));
            p.push(("user_is_login".into(), "0".into()));
            p
        };
        let value = self
            .request(reqwest::Method::GET, PATH_SUGGEST, pairs, None)
            .await?;
        let mut out = Vec::new();
        let mut walk = |v: &Value| {
            if let Some(arr) = v.as_array() {
                for item in arr {
                    let s = match item {
                        Value::String(s) => s.trim().to_string(),
                        Value::Object(o) => flex_str(o.get("word")),
                        _ => String::new(),
                    };
                    if !s.is_empty() && !out.contains(&s) {
                        out.push(s);
                    }
                }
            }
        };
        walk(&value);
        if let Some(data) = value.get("data") {
            walk(data);
            if let Some(sug) = data.get("suggest_words") {
                walk(sug);
            }
        }
        Ok(out)
    }

    /// 剧集详情（含分集列表）。
    pub async fn get_series(&self, series_id: &str) -> Result<(SeriesHit, Vec<EpisodeHit>)> {
        match self.get_series_once(series_id).await {
            Err(error) if error.needs_device_reset() => {
                if self.reset_device().await.is_ok() {
                    return self.get_series_once(series_id).await;
                }
                Err(error)
            }
            other => other,
        }
    }

    async fn get_series_once(&self, series_id: &str) -> Result<(SeriesHit, Vec<EpisodeHit>)> {
        let pairs: Pairs = {
            let profile = self.ensure_guest().await?;
            let mut p = device_query_pairs(&Self::identity(&profile));
            p.push(("series_id".into(), series_id.to_string()));
            p.push(("need_video_detail_info".into(), "true".into()));
            p
        };

        let value = self
            .request(reqwest::Method::GET, PATH_SERIES, pairs, None)
            .await?;

        let data = value
            .get("data")
            .ok_or_else(|| HongguoError::Other("详情响应缺 data".into()))?;
        let vd = data
            .get("video_data")
            .ok_or_else(|| HongguoError::Other("详情响应缺 video_data".into()))?;

        let id = {
            let a = flex_str(vd.get("series_id_str"));
            if a.is_empty() {
                flex_str(vd.get("series_id"))
            } else {
                a
            }
        };
        let title = flex_str(vd.get("series_title"));
        if id.is_empty() || title.is_empty() {
            return Err(HongguoError::ContentUnavailable(
                "详情缺少剧集 id 或标题".into(),
            ));
        }

        let series = SeriesHit {
            id: id.clone(),
            title,
            cover: flex_str(vd.get("series_cover")),
            intro: flex_str(vd.get("series_intro")),
            episode_count: flex_i64(vd.get("episode_cnt")).max(0) as u32,
        };

        let mut episodes = Vec::new();
        if let Some(list) = vd.get("video_list").and_then(|v| v.as_array()) {
            for (idx, ep) in list.iter().enumerate() {
                let eid = flex_str(ep.get("vid"));
                if eid.is_empty() {
                    continue;
                }
                // 集号从 1 开始：上游 vid_index 有时是 0 基
                let number = {
                    let n = flex_i64(ep.get("vid_index"));
                    if n > 0 {
                        n as u32
                    } else {
                        (idx + 1) as u32
                    }
                };
                episodes.push(EpisodeHit {
                    id: eid,
                    series_id: id.clone(),
                    number,
                    title: flex_str(ep.get("title")),
                    duration_seconds: flex_f64(ep.get("duration")),
                    cover: {
                        let a = flex_str(ep.get("episode_cover"));
                        if a.is_empty() {
                            flex_str(ep.get("cover"))
                        } else {
                            a
                        }
                    },
                });
            }
        }

        Ok((series, episodes))
    }

    /// 首页「推荐」频道。
    pub async fn discover(&self) -> Result<Vec<SeriesHit>> {
        let pairs: Pairs = {
            let profile = self.ensure_guest().await?;
            let mut p = device_query_pairs(&Self::identity(&profile));
            p.push(("tab_type".into(), "1".into()));
            p.push(("cell_id".into(), "-1".into()));
            p.push(("user_is_login".into(), "0".into()));
            p
        };
        let value = self
            .request(reqwest::Method::GET, PATH_DISCOVER, pairs, None)
            .await?;
        let mut hits = Vec::new();
        collect_hits(&value, &mut hits, 0);
        Ok(hits)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_video_data_shape() {
        let v: Value = serde_json::from_str(
            r#"{"search_tabs":[{"tab_type":11,"data":[{"video_data":[{"series_id":"111","video_detail":{"series_title":"测试剧","series_intro":"简介","episode_cnt":12}}]}]}]}"#,
        )
        .unwrap();
        let mut hits = Vec::new();
        collect_hits(&v, &mut hits, 0);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "111");
        assert_eq!(hits[0].title, "测试剧");
        assert_eq!(hits[0].episode_count, 12);
    }

    #[test]
    fn dedupes_same_series() {
        let v: Value = serde_json::from_str(
            r#"[{"series_id":"9","video_detail":{"series_title":"A"}},{"series_id":"9","video_detail":{"series_title":"A"}}]"#,
        )
        .unwrap();
        let mut hits = Vec::new();
        collect_hits(&v, &mut hits, 0);
        assert_eq!(hits.len(), 1);
    }
}
