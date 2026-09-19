use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogFilter {
    pub channel: String,
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
