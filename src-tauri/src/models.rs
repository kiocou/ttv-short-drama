use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogFilter {
    pub channel: String,
    /// 外部 guoapp 站源 id；为空表示沿用红果短剧/漫剧链路。
    #[serde(default)]
    pub source: Option<String>,
    pub category: String,
    pub audience: String,
    pub sort: String,
    pub keyword: Option<String>,
    pub page: u32,
    pub page_size: u32,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesItem {
    pub id: String,
    pub title: String,
    pub cover: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub episodes_count: u32,
    pub latest_episode_title: Option<String>,
    pub tags: Vec<String>,
    pub origin: String,
    pub brief: Option<String>,
    /// 站点给出的用户评分，**0-10 量纲**，原样透传不换算。
    ///
    /// 站点不给就是 `None`，**绝不能填 0**：前端 `SeriesCard` 是
    /// `{series.rating && …}`，填 0 既渲染成"0.0 分"角标，又是凭空造分
    /// （不变量 8：不要把不存在的东西显示成可用）。
    ///
    /// `#[serde(default)]` 对当前只 `Serialize` 的结构体其实不生效（它只管反序列化），
    /// 留着是为了哪天给这个结构体补 `Deserialize`（旧缓存 / 旧快照）时不必再改这里。
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rating: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPage {
    pub items: Vec<SeriesItem>,
    pub total: usize,
    pub has_more: bool,
    pub page: u32,
    pub categories: Vec<String>,
    pub next_cursor: Option<String>,
    pub source: String,
    /// **这份结果是降级的**：有来源失败或结果不完整，但仍然返回了内容。
    ///
    /// 为什么不能只靠 `source` 里那句文案（"；动漫来源暂不可用"）：前端判定要靠
    /// 字符串词表（`不可用`/`可重试`/…），而**用户搜的词本身可能含这些字**，
    /// 于是正常来源行会被染成琥珀色。`degraded` 只回答"这次结果可不可信"。
    ///
    /// 真正的多来源合并发生在 `main.rs::merge_search_sources`，它在那儿置位；
    /// 各 provider 内部的部分成功（见 `provider.rs` 的四处）也各自置位。
    /// 失败即整体 `Err` 的链路填 `false`。
    ///
    /// **不要** `skip_serializing_if`：这是常量语义、没有"缺失"这一说，
    /// 恒定出现在载荷里前端才能直接读，不用判 undefined。
    /// 同上，`#[serde(default)]` 现在不生效，是留给将来 `Deserialize` 的。
    #[serde(default)]
    pub degraded: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeItem {
    pub id: String,
    pub series_id: String,
    pub episode_number: u32,
    pub title: String,
    pub duration_seconds: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoQualityOption {
    pub label: String,
    pub value: String,
    pub resolution: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesDetail {
    pub id: String,
    pub title: String,
    pub cover: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub tags: Vec<String>,
    pub origin: String,
    pub episodes_count: u32,
    pub description: String,
    pub episodes: Vec<EpisodeItem>,
    pub available_qualities: Vec<VideoQualityOption>,
    pub sources: Vec<PlaybackSource>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSource {
    pub id: String,
    pub name: String,
    pub is_primary: bool,
    pub health: String,
    pub ping_ms: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackOpenInput {
    pub session_id: u64,
    pub series_id: String,
    pub episode_id: String,
    pub quality: String,
    pub position: f64,
    /// 动漫专区标记：动漫播放走暴风源直链（m3u8 经本地 HLS 代理），不经红果 worker。
    #[serde(default)]
    pub is_anime: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSession {
    pub session_id: u64,
    pub series_id: String,
    pub episode_id: String,
    pub position: f64,
    pub quality: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_url: Option<String>,
    /// 源流形态（**只有动漫链路填**）：
    /// - `hls`：m3u8 播放列表，必须由 hls.js 挂到 MSE 上播放；
    /// - `file`：整段可直连的媒体文件，直接交给 `<video src>`。
    ///
    /// 为什么必须由后端显式标出：动漫的每条地址都会被本地代理重写成
    /// `http://127.0.0.1:port/stream?u=…`，前端 `isHlsUrl()` 里的
    /// `url.includes('/stream?u=')` 因此**恒为 true**——整集 MP4 也会被塞给
    /// hls.js（解析播放列表失败）。而 WebView2 的
    /// `canPlayType('application/vnd.apple.mpegurl')` 返回 `"maybe"`，又让前端
    /// 误以为"原生支持 HLS"，把 m3u8 直接喂给 `<video>`（实测 15 秒后
    /// `videoWidth=0`、只有声音，20 秒后才可能出帧——即"有声无画黑屏"）。
    /// 真值只在解析出地址的 Rust 侧可得，所以在改写地址之前判定并下发。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_kind: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSnapshot {
    pub session_id: u64,
    pub state: PlaybackUiState,
    pub position: f64,
    pub duration: f64,
    pub buffered: f64,
    pub volume: f64,
    pub muted: bool,
    pub playback_rate: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackUiState {
    pub kind: String,
    pub session_id: u64,
}

/// 宽容解析：`null`（以及缺失）一律当 0。
///
/// 为什么需要：前端把 `video.duration` 直接送进来，而分片 MP4 / 未知时长的源
/// 在 WebView 里报 `Infinity`——`JSON.stringify` 会把它变成 `null`。这些字段
/// 原本是必填 f64/u32/u8，一个 `null` 就让**整个参数反序列化失败**，
/// `history_save` 被拒，用户看到的是"这集明明看了，历史里却没有"。
/// 宁可记下 0 秒，也不能丢掉"看到哪一集"这个信息。
fn de_f64_lenient<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<f64>::deserialize(deserializer)?.unwrap_or(0.0))
}

fn de_u32_lenient<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<u32>::deserialize(deserializer)?.unwrap_or(0))
}

fn de_u8_lenient<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<u8>::deserialize(deserializer)?
        .unwrap_or(0)
        .min(100))
}

fn de_i64_lenient<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<i64>::deserialize(deserializer)?.unwrap_or(0))
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchHistoryItem {
    pub series_id: String,
    pub episode_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub series_cover: String,
    #[serde(default, deserialize_with = "de_u32_lenient")]
    pub episode_number: u32,
    #[serde(default, deserialize_with = "de_u32_lenient")]
    pub total_episodes: u32,
    #[serde(default, deserialize_with = "de_f64_lenient")]
    pub position_seconds: f64,
    #[serde(default, deserialize_with = "de_f64_lenient")]
    pub duration_seconds: f64,
    #[serde(default, deserialize_with = "de_u8_lenient")]
    pub progress_percent: u8,
    #[serde(default, deserialize_with = "de_i64_lenient")]
    pub updated_at: i64,
    pub is_finished: bool,
    pub channel: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSettings {
    pub default_quality: String,
    pub auto_next: bool,
    pub countdown_seconds: u32,
    /// 已废弃：补帧/增强链路已移除，保留字段兼容旧设置库记录，恒为 "off"。
    pub preferred_engine: String,
    pub target_fps: u32,
    pub hardware_acceleration: bool,
    pub catalog_cache_mb: f64,
    pub playback_cache_mb: f64,
    /// 是否展示 18+ 外部内容源（黄豆/剧果/野果/帝果/黄果 AI/黄果视频）。
    ///
    /// 旧设置记录里没有这个字段，serde default 保证升级后读取不会失败；
    /// 默认关闭——成人内容源需要用户显式开启。
    #[serde(default)]
    pub show_adult_sources: bool,
    /// 用户勾选启用的视频源 id（前端 `enabledSources`）。
    ///
    /// 存 id 列表而不是"逐源开关"：源表在前端（`services/guoSources.ts`），
    /// 后端不需要知道有哪些源，也不需要在源增删时迁移设置。
    ///
    /// 空列表回落到 `["hongguo"]`——旧设置记录没有这个字段，若按空列表处理，
    /// 升级后用户会看到"一个源都没有"的空目录。
    #[serde(default)]
    pub enabled_sources: Vec<String>,
}

impl Default for UserSettings {
    fn default() -> Self {
        Self {
            default_quality: "auto".into(),
            auto_next: true,
            countdown_seconds: 5,
            preferred_engine: "off".into(),
            target_fps: 60,
            hardware_acceleration: true,
            catalog_cache_mb: 0.0,
            playback_cache_mb: 0.0,
            show_adult_sources: false,
            enabled_sources: vec!["hongguo".to_string()],
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheClearResult {
    pub freed_mb: f64,
}

/// 追剧收藏条目（想看 / 在看 / 已看）。
///
/// 状态语义与历史记录独立：收藏是用户主动标记，`mark` 只有三种取值，
/// 由存储层校验，未知值入库时报错而不是静默改写。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteItem {
    pub series_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub cover: String,
    /// want / watching / done
    pub mark: String,
    /// 漫剧 comic / 短剧 drama，用于收藏页分组筛选。
    #[serde(default)]
    pub channel: Option<String>,
    #[serde(default, deserialize_with = "de_i64_lenient")]
    pub updated_at: i64,
}

#[cfg(test)]
mod history_payload_tests {
    use super::WatchHistoryItem;

    /// `null` 数值不能再让整条历史记录被拒收。
    ///
    /// 这是"漫剧播完历史页里根本没有这条记录"的根因回归测试：前端把
    /// `video.duration` 原样上报，而分片 MP4 在 WebView 里报 `Infinity`，
    /// `JSON.stringify` 把它变成 `null`。字段原本是必填 f64/u32/u8，
    /// 一个 `null` 就让整个 `history_save` 参数反序列化失败——记录一条都写不进去。
    #[test]
    fn accepts_null_numeric_fields() {
        let json = r#"{
            "seriesId": "s1",
            "episodeId": "e1",
            "title": "漫剧",
            "seriesCover": "",
            "episodeNumber": null,
            "totalEpisodes": null,
            "positionSeconds": null,
            "durationSeconds": null,
            "progressPercent": null,
            "updatedAt": null,
            "isFinished": false,
            "channel": "comic"
        }"#;
        let item: WatchHistoryItem =
            serde_json::from_str(json).expect("null 数值必须被宽容接受，否则整条记录丢失");
        assert_eq!(item.position_seconds, 0.0);
        assert_eq!(item.duration_seconds, 0.0);
        assert_eq!(item.progress_percent, 0);
        assert_eq!(item.episode_number, 0);
        assert_eq!(item.updated_at, 0);
        assert_eq!(item.channel.as_deref(), Some("comic"));
    }

    /// 正常的完整载荷必须照常解析，且百分比被夹在 0-100。
    #[test]
    fn accepts_well_formed_payload_and_clamps_percent() {
        let json = r#"{
            "seriesId": "s2",
            "episodeId": "e2",
            "title": "短剧",
            "seriesCover": "https://example.com/c.jpg",
            "episodeNumber": 7,
            "totalEpisodes": 80,
            "positionSeconds": 42.5,
            "durationSeconds": 90.0,
            "progressPercent": 250,
            "updatedAt": 1700000000000,
            "isFinished": false
        }"#;
        let item: WatchHistoryItem = serde_json::from_str(json).expect("正常载荷必须可解析");
        assert_eq!(item.episode_number, 7);
        assert_eq!(item.total_episodes, 80);
        assert!((item.position_seconds - 42.5).abs() < f64::EPSILON);
        assert_eq!(
            item.progress_percent, 100,
            "百分比必须夹在 0-100，否则 u8 会溢出"
        );
        assert!(item.channel.is_none());
    }
}
