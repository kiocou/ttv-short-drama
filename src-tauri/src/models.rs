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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchHistoryItem {
    pub series_id: String,
    pub episode_id: String,
    pub title: String,
    pub series_cover: String,
    pub episode_number: u32,
    pub total_episodes: u32,
    pub position_seconds: f64,
    pub duration_seconds: f64,
    pub progress_percent: u8,
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
pub struct EnhancementEngineInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub target_fps: u32,
    pub recommended: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhancementCapabilities {
    pub supported_engines: Vec<EnhancementEngineInfo>,
    pub gpu_name: String,
    pub driver_version: String,
    pub vram_mb: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhancementStatus {
    pub enabled: bool,
    pub mode: String,
    pub fallback_active: bool,
    pub reason: Option<String>,
    pub actual_fps: Option<f64>,
    pub display_fps: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheClearResult {
    pub freed_mb: f64,
}
