//! 短剧 App-API 云端解析桥（锁定集直链的下载解密管线）。
//!
//! 红果官网 H5 每部剧只放开前几集网页直链（`accessible_episode_cnt`，普遍 3），
//! 之后官网播放页直接 404。桌面端的"全集可播"通过番茄小说 App 的
//! `multi_video_model` 接口实现：`resources/shortdrama-worker/` 里打包了
//! 嵌入式 Python + liushen 六代签名 + ffmpeg 解密管线，Rust 侧按需拉起
//! 单次进程 `worker.py resolve <vid>`，产出本地 mp4 后交给播放器播放。
//!
//! 设备凭据存放在数据目录 `short-drama-device.json`。
//! 首次启动若文件不存在，会自动生成 19 位 deviceId/installId 与 cdid/openudid 并落盘。
//! 已有凭据不会被覆盖。deviceToken（x-tt-dt）只在文件里已有时使用，不会本地编造。
//!
//! ## 这里为什么要跟随 VSR 开关（曾经的 bug 根因）
//!
//! 设置页的「RTX VSR 视频增强」开关原先只作用于 `media_enhance`（guo 与公开
//! 直链那条转码链路），而红果短剧走的是本模块：worker 直接把源流转存成本地 mp4，
//! **根本不经过 media_enhance**。于是用户点红果时开关怎么拨都没用——这正是
//! 「开关 VSR 都没用」那条反馈的真实根因。
//!
//! 正确语义应当按「两种模式下这条链路还要不要为 VSR 服务」来定：
//!   * 开关**开**：输出必须是 H.264（RTX VSR 的硬条件，AGENTS.md 不变量 25），
//!     并且这层就该承担重编码成本——为了把这段成本压下来，输出编码走
//!     `h264_nvenc`（不可用时回落 libx264），实测整集重编从 4.0s 降到 1.6s。
//!   * 开关**关**：回到引入 VSR 之前的播放链路。那时播放器只要求「WebView2
//!     能解出画面」，源档是 H.264 就直接 `-c:v copy` 重封装（实测 0.87s、体积
//!     与源基本一致），不再为了一样用不上的 VSR 把整集重编成十几倍大的文件。

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime};

use crate::models::SeriesItem;

/// 进度事件名（stage: sign/model/fallback/download/transcode/done）。
pub const RESOLVE_EVENT: &str = "shortdrama://app-resolve";
const WORKER_TIMEOUT: Duration = Duration::from_secs(300);
/// stream/album 只签名取模型，不必等整集下载；卡死时尽快回退网页直链。
const STREAM_WORKER_TIMEOUT: Duration = Duration::from_secs(25);
/// 前缀解析（`resolve-prefix`）的上限。
///
/// 比整集短得多是有意的：前缀只是"先给一个能马上出画的短片段"，实测 4.2 秒就
/// 有产物。超过两分钟还没回来，说明这条加速路径本身出了问题——此时前端早就退回
/// 整集链路了，继续挂着这个 worker 只会白占带宽和 CPU。
const PREFIX_WORKER_TIMEOUT: Duration = Duration::from_secs(120);

// ===== resolve 在途去重（leader / follower）=====
// key = "{cache_namespace}:{quality}:{vid}"。
// 预取与前台换集几乎同时对同一集发起 resolve 时，只有 leader 跑 worker；
// follower 轮询等缓存文件出现，避免双 worker 写同一文件互删半成品
// （.source.tmp / .part.mp4 同名互殴，ffmpeg 报处理失败）。
// follower 最多等 leader 一个周期 + 15s，等不到产物就自己接管当新 leader。
fn resolve_inflight() -> &'static Mutex<std::collections::HashSet<String>> {
    static MAP: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

/// 预签名直链缓存：vid -> (url, 解密密钥, 宽高, 时长)。
///
/// 为什么要有它：`stream` 子命令要跑两次 App API 往返（multi_video_model +
/// fallback_api），实测固定 2.16s，是未命中解析里最大的一块固定开销。
/// 用户打开详情页到真正点某一集之间通常有数秒到数十秒，足够提前做完。
/// 直链带时间戳签名，因此这里绝不长期持有：超过 TTL 直接当作没有。
#[derive(Debug, Clone)]
struct CachedStream {
    url: String,
    content_key: String,
    width: u32,
    height: u32,
    duration_ms: i64,
    /// 选中档的编码标识（h264 / hevc / bytevc2 / ""）。
    ///
    /// worker 用它决定直连那一步是「重封装」还是「整集重编码」：源档已是 H.264
    /// 时只 copy，省掉实测约 10 秒的整集重编。不带这一项，预签名命中的那条
    /// 最常见路径会永远走最慢的分支。
    codec: String,
    cached_at: std::time::Instant,
}

/// 直链有效期保守取 10 分钟。宁可少命中，也不能把可能过期的地址交给 worker
/// —— 过期直链会让 ffmpeg 拉流失败，虽然调用方有重新签名的兜底，但那是
/// 一次额外的整轮重跑。
const STREAM_CACHE_TTL: Duration = Duration::from_secs(600);

fn stream_cache() -> &'static Mutex<std::collections::HashMap<String, CachedStream>> {
    static CACHE: OnceLock<Mutex<std::collections::HashMap<String, CachedStream>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// `stream` 子命令的**在途去重**表：同一 vid 的并发签名只跑一次。
///
/// 为什么需要：`resolve`（整集链路，现在只作为失败回退）与 `open_stream`（整集 HLS，
/// 播放主路径）都会去取「加密直链 + CENC 密钥」，而那是**两次 App API 往返、固定
/// 2.2 秒**的纯等待。实测日志里这两条命令在同一毫秒级窗口内一起发车（用户点播放时
/// 前端同时发它们），却各自跑了一遍签名 —— 第 ③ 段 3695ms 就是这么来的。
///
/// 有了这张表：先到的那条把结果写进 stream 缓存，后到的直接读缓存（`peek_stream`），
/// 或者在途时等前一条落地。省下的是一次完整的签名往返。
fn stream_inflight() -> &'static Mutex<std::collections::HashMap<String, std::time::Instant>> {
    static INFLIGHT: OnceLock<Mutex<std::collections::HashMap<String, std::time::Instant>>> =
        OnceLock::new();
    INFLIGHT.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// 在途表项的存活上限（秒）。
///
/// 为什么需要：leader 若在摘除表项**之前**异常退场（panic 而非返回 Err），表项会
/// 永久留着，此后每次打开该 vid 都进 follower 分支白等 20 秒（审查 S1）。
/// 给它一个略大于 worker 自身超时的上限，超龄项在校验时顺手清掉。
const STREAM_INFLIGHT_MAX_AGE_SECS: u64 = 120;

/// 领取/查询在途权。返回 `true` 表示本次调用是 leader。
///
/// 顺带清掉超龄表项（僵尸 leader 留下的）。
fn claim_stream_inflight(vid: &str) -> Result<bool, String> {
    let mut guard = stream_inflight()
        .lock()
        .map_err(|_| "流签名在途表锁不可用。".to_string())?;
    guard.retain(|_, started| started.elapsed().as_secs() < STREAM_INFLIGHT_MAX_AGE_SECS);
    if guard.contains_key(vid) {
        return Ok(false);
    }
    guard.insert(vid.to_owned(), std::time::Instant::now());
    Ok(true)
}

fn release_stream_inflight(vid: &str) {
    if let Ok(mut guard) = stream_inflight().lock() {
        guard.remove(vid);
    }
}

/// 取（或补齐）某 vid 的播放直链，**全进程去重**。
///
/// 命中 `stream` 缓存直接返回；否则领取在途权、跑一次 worker，落缓存后交还。
/// 没领到在途权的调用方轮询等前一条落缓存（上限与 worker 自身超时同量级）。
async fn ensure_stream_cached<R: Runtime>(
    app: &AppHandle<R>,
    vid: &str,
    profile: HongguoAppProfile,
) -> Result<CachedStream, String> {
    if let Some(cached) = peek_stream(vid) {
        return Ok(cached);
    }
    let acquired = claim_stream_inflight(vid)?;
    if !acquired {
        // 已有同 vid 的签名在跑：等它落缓存。两次 API 往返实测 2.2 秒，
        // 给 20 秒余量（含网络抖动），超时后自己再跑一次兜底。
        for _ in 0..80u32 {
            tokio::time::sleep(Duration::from_millis(250)).await;
            if let Some(cached) = peek_stream(vid) {
                return Ok(cached);
            }
        }
        // 超时兜底：不再无限等 leader。它可能已经异常退场（表项靠 TTL 清理），
        // 也可能只是网络极慢。这里自跑一次并**顺手接管在途权**，避免后续调用
        // 又以为有 leader 在跑而继续等。
        crate::trace::log(format!("[红果] 等待在途签名超时，自跑一次 vid={vid}"));
        let _ = claim_stream_inflight(vid);
        let payload = match run_worker_subcommand(app, "stream", vid, "stream", profile).await {
            Ok(payload) => {
                store_stream(vid, &payload);
                peek_stream(vid).ok_or_else(|| "签名结果未能落缓存。".to_owned())
            }
            Err(error) => Err(error),
        };
        release_stream_inflight(vid);
        return payload;
    }
    let result = match run_worker_subcommand(app, "stream", vid, "stream", profile).await {
        Ok(payload) => {
            store_stream(vid, &payload);
            peek_stream(vid).ok_or_else(|| "签名结果未能落缓存。".to_owned())
        }
        Err(error) => Err(error),
    };
    release_stream_inflight(vid);
    result
}

/// 把一次 `stream` 的产物存进缓存。url 为空时直接丢弃，避免缓存一条废条目。
fn store_stream(vid: &str, payload: &serde_json::Value) {
    let url = payload
        .get("url")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    if url.is_empty() {
        return;
    }
    let entry = CachedStream {
        url,
        content_key: payload
            .get("content_key")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        width: payload
            .get("width")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0) as u32,
        height: payload
            .get("height")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0) as u32,
        duration_ms: payload
            .get("duration_ms")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0),
        codec: payload
            .get("codec")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        cached_at: std::time::Instant::now(),
    };
    if let Ok(mut guard) = stream_cache().lock() {
        guard.insert(vid.to_owned(), entry);
    }
}

/// 读一条未过期的缓存（顺带清掉过期项，防止长期运行后缓存只增不减）。
fn peek_stream(vid: &str) -> Option<CachedStream> {
    let mut guard = stream_cache().lock().ok()?;
    guard.retain(|_, item| item.cached_at.elapsed() < STREAM_CACHE_TTL);
    guard.get(vid).cloned()
}

fn clear_stream(vid: &str) {
    if let Ok(mut guard) = stream_cache().lock() {
        guard.remove(vid);
    }
}

/// 前端传入的解析请求。解析链路只依赖 vid；其余字段保留用于诊断与
/// 向前兼容，不参与缓存寻址。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortDramaAppResolveInput {
    #[serde(default)]
    #[allow(dead_code)]
    pub series_id: String,
    pub vid: String,
    /// 真实画质请求。worker 按 preferred_quality_height 缺档回退选流，
    /// 指定档位的产物缓存在 {vid}-{quality}.mp4，与 auto 副本分开。
    #[serde(default)]
    pub quality: Option<String>,
    #[serde(default)]
    pub content_type: Option<u16>,
    #[serde(default)]
    pub app_id: Option<u32>,
}

/// 红果两个客户端共用播放器接口，但请求模型和 aid 不同。
/// 仅接受**私有渠道**已确认的短剧/漫剧内容类型，避免前端传入任意模型值。
#[derive(Debug, Clone, Copy)]
struct HongguoAppProfile {
    content_type: u16,
    app_id: u32,
    cache_namespace: &'static str,
}

impl HongguoAppProfile {
    fn from_input(content_type: Option<u16>, app_id: Option<u32>) -> Result<Self, String> {
        let content_type = content_type.unwrap_or(1);
        // 2026-09-18 实测：漫剧 vid 用 aid=8662 即可取到播放模型（v1/v2 端点
        // 都通）；旧的 1004/1007 → 8704 已被网关静默拒绝（200 空 body）。
        let profile = match content_type {
            1 => Self {
                content_type,
                app_id: 8662,
                cache_namespace: "short-series",
            },
            1004 | 1007 => Self {
                content_type,
                app_id: 8662,
                cache_namespace: "motion-comic",
            },
            _ => {
                return Err(format!(
                    "不支持的红果 contentType={content_type}（仅支持短剧 1、漫剧 1004/1007）。"
                ));
            }
        };
        if let Some(app_id) = app_id {
            if app_id != profile.app_id {
                return Err(format!(
                    "contentType={} 必须使用 aid={}，收到 aid={app_id}。",
                    profile.content_type, profile.app_id
                ));
            }
        }
        Ok(profile)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortDramaAppPlayback {
    pub play_url: String,
    pub width: u32,
    pub height: u32,
    pub size_bytes: u64,
    pub cached: bool,
    ///
    /// 播放形态。`None` 或缺省 = 本地文件路径（前端走 convertFileSrc + <video>.src）；
    /// `Some("hls")` = 本地 HLS 地址（前端必须走 hls.js 挂载，不能 convertFileSrc）。
    ///
    /// 这个字段是「边转边播」链路的一部分：流式首屏交出去的是 `http://127.0.0.1`
    /// 上的 m3u8，把它当文件路径处理会得到一个必然 404 的 asset:// 地址。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_kind: Option<String>,
    /// 本地 HLS 挂载失败时的回退地址（原始加密直链由调用方兜底）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_url: Option<String>,
    ///
    /// **源片真实总时长**（毫秒）。`None` 表示未知。
    ///
    /// 为什么必须由后端给：方案 B 的播放源是「边解密边转」的 HLS，转码没结束时
    /// 清单里只有已经切好的分片、`#EXT-X-ENDLIST` 还没写 —— 浏览器侧的
    /// `video.duration` 要么是 `Infinity`、要么等于「已转到的位置」。
    /// 前端旧实现遇到 `Infinity` 会退回 `seekable` / `buffered` 末尾，而那两个值
    /// **随转码进度增长**，于是用户看到的时长会一路往上跳。
    ///
    /// 而这个数字后端一直有：worker 的 `stream` 子命令早就返回 `duration_ms`
    /// （`CachedStream` 里存着），只是没往前提。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortDramaAppStatus {
    pub configured: bool,
    pub has_device_token: bool,
    pub device_hint: String,
    pub python_found: bool,
    pub worker_found: bool,
    pub ffmpeg_found: bool,
    pub cache_dir: String,
}

/// 锁定集直链流播（worker `stream` 子命令的产物）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortDramaAppStream {
    pub url: String,
    /// CENC 内容密钥（hex）；源流未加密时为空串。
    pub decryption_key: String,
    pub width: u32,
    pub height: u32,
    pub download_ua: String,
    pub download_referer: String,
    /// App 播放模型中返回的全部可用清晰度，已在 worker 中按最高档排序。
    pub variants: Vec<ShortDramaAppVariant>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortDramaAppVariant {
    pub id: String,
    pub label: String,
    pub url: String,
    pub decryption_key: String,
    pub width: u32,
    pub height: u32,
    pub bitrate: u64,
}

/// 专辑详情里的单集（worker `album` 子命令，按 vid_index 排序）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortDramaAppEpisode {
    pub vid: String,
    pub index: u32,
    pub title: String,
    pub locked: bool,
    pub disabled: bool,
    pub duration_seconds: f64,
    pub cover: String,
}

/// 专辑详情（全集 vid 顺序 + 真实锁定态，来自 App-API album_detail）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortDramaAppAlbum {
    pub series_id: String,
    pub title: String,
    pub cover: String,
    pub intro: String,
    pub total: u32,
    pub episodes: Vec<ShortDramaAppEpisode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceCredentials {
    device_id: String,
    install_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    device_token: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    cdid: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    openudid: String,
}

fn mask_device_id(id: &str) -> String {
    let chars: Vec<char> = id.chars().collect();
    if chars.len() <= 4 {
        return "****".into();
    }
    format!("…{}", chars[chars.len() - 4..].iter().collect::<String>())
}

fn json_string_field(value: &serde_json::Value, keys: &[&str]) -> String {
    for key in keys {
        match value.get(*key) {
            Some(serde_json::Value::String(text)) => {
                let text = text.trim();
                if !text.is_empty() {
                    return text.to_owned();
                }
            }
            Some(serde_json::Value::Number(number)) => {
                let text = number.to_string();
                if text != "0" {
                    return text;
                }
            }
            _ => {}
        }
    }
    String::new()
}

fn random_decimal_id() -> String {
    let bytes = *uuid::Uuid::new_v4().as_bytes();
    let raw = u64::from_le_bytes(bytes[0..8].try_into().unwrap_or([0; 8]));
    const MIN: u64 = 1_000_000_000_000_000_000;
    const SPAN: u64 = 8_000_000_000_000_000_000;
    format!("{}", MIN + (raw % SPAN))
}

fn random_openudid() -> String {
    format!("{:032x}", uuid::Uuid::new_v4().as_u128())
        .chars()
        .take(16)
        .collect()
}

fn generate_credentials() -> DeviceCredentials {
    let device_id = random_decimal_id();
    let mut install_id = random_decimal_id();
    while install_id == device_id {
        install_id = random_decimal_id();
    }
    DeviceCredentials {
        device_id,
        install_id,
        device_token: String::new(),
        cdid: uuid::Uuid::new_v4().to_string(),
        openudid: random_openudid(),
    }
}

fn persist_credentials(payload: &DeviceCredentials) -> Result<(), String> {
    let path = device_config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(
        &path,
        serde_json::to_string_pretty(payload).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("写入设备凭据失败：{error}"))
}

fn ensure_credentials() -> Result<DeviceCredentials, String> {
    match load_credentials() {
        Ok(mut credentials) => {
            let mut changed = false;
            if credentials.cdid.is_empty() {
                credentials.cdid = uuid::Uuid::new_v4().to_string();
                changed = true;
            }
            if credentials.openudid.is_empty() {
                credentials.openudid = random_openudid();
                changed = true;
            }
            if changed {
                persist_credentials(&credentials)?;
            }
            Ok(credentials)
        }
        Err(_) => {
            let generated = generate_credentials();
            persist_credentials(&generated)?;
            Ok(generated)
        }
    }
}

fn explain_hongguo_api_error(detail: &str) -> String {
    if detail.contains("111104") || detail.contains("设备身份无效") {
        return "红果设备身份无效（111104）。当前会话未被服务端接受，请稍后重试或改用网页直链。"
            .into();
    }
    if detail.contains("110001") {
        return "红果播放模型异常（110001）。漫剧请使用 App V2 播放模型，或更换设备凭据后重试。"
            .into();
    }
    detail.to_owned()
}

fn data_dir() -> PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(resolve_data_dir).clone()
}

/// 应用数据根目录：设备凭据与剧集缓存都落在这里。
///
/// 历史遗留：早期版本直接复用 TTV Box 的 `com.ttv.player`，于是两个应用
/// 共用同一份设备凭据与剧集缓存——"清空缓存"会伸进另一个应用的目录，
/// 卸载其中一个也会带走另一个的数据。现在改用本应用自己的
/// `com.ttv.shortdrama`（与 tauri.conf.json 的 identifier 一致）。
///
/// 首次启动时会把旧目录里的凭据与缓存搬过来：用户的设备身份与已经下载好的
/// 剧集不该因为一次改名而作废（重新生成凭据意味着重新走一遍注册）。
fn resolve_data_dir() -> PathBuf {
    let Some(base) = dirs::data_local_dir() else {
        return std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(".ttv-data");
    };
    let current = base.join("com.ttv.shortdrama");
    migrate_legacy_data_dir(&base.join("com.ttv.player"), &current);
    current
}

/// 把历史目录里的设备凭据与剧集缓存搬到新目录。
///
/// 两条安全约束：只在"目标尚不存在"时搬（绝不覆盖新目录里的数据），以及
/// 优先用 rename（同一磁盘上只是一次元数据操作，上 GB 缓存也不会卡启动），
/// 只有跨卷等场景才退回逐文件复制。任何一步失败都不阻断启动——凭据缺失时
/// 应用本来就会重新生成，缓存缺失只会重新下载。
fn migrate_legacy_data_dir(legacy: &std::path::Path, current: &std::path::Path) {
    if !legacy.is_dir() || legacy == current {
        return;
    }
    let _ = std::fs::create_dir_all(current);
    for name in ["short-drama-device.json", "short-drama-cache"] {
        let from = legacy.join(name);
        let to = current.join(name);
        if !from.exists() || to.exists() {
            continue;
        }
        if std::fs::rename(&from, &to).is_ok() {
            continue;
        }
        if from.is_dir() {
            let _ = copy_dir_recursive(&from, &to);
        } else {
            let _ = std::fs::copy(&from, &to);
        }
    }
}

fn copy_dir_recursive(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn device_config_path() -> PathBuf {
    data_dir().join("short-drama-device.json")
}

pub(crate) fn cache_dir() -> PathBuf {
    data_dir().join("short-drama-cache")
}

/// 与 runtime::discover_resource_dir 相同的候选顺序，但以 worker/python 的
/// 存在为判据（worker 目录随 bundle.resources 复制到可执行文件旁）。
pub fn resource_base() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(value) = std::env::var_os("TTV_RESOURCE_DIR") {
        candidates.push(PathBuf::from(value));
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            candidates.push(parent.join("resources"));
            candidates.push(parent.to_owned());
        }
    }
    if let Ok(current) = std::env::current_dir() {
        candidates.push(current.join("resources"));
        candidates.push(current.join("src-tauri/resources"));
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"));
    candidates.into_iter().find(|base| {
        base.join("shortdrama-worker/worker.py").is_file()
            || base.join("python/python.exe").is_file()
    })
}

pub(crate) fn ffmpeg_path() -> Result<PathBuf, String> {
    let base = resource_base()
        .ok_or_else(|| "未找到随包 ffmpeg 资源目录。请重新安装或完整打包应用。".to_owned())?;
    let ffmpeg = base.join("mpv/ffmpeg.exe");
    if ffmpeg.is_file() {
        Ok(ffmpeg)
    } else {
        Err(format!("ffmpeg 不存在：{}", ffmpeg.display()))
    }
}
fn worker_paths() -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let base = resource_base().ok_or_else(|| {
        "未找到短剧解析 worker 资源目录（shortdrama-worker）。请重新安装或完整打包应用。".to_owned()
    })?;
    let python = base.join("python/python.exe");
    let worker = base.join("shortdrama-worker/worker.py");
    let ffmpeg = base.join("mpv/ffmpeg.exe");
    if !python.is_file() {
        return Err(format!("嵌入式 Python 不存在：{}", python.display()));
    }
    if !worker.is_file() {
        return Err(format!("解析 worker 不存在：{}", worker.display()));
    }
    if !ffmpeg.is_file() {
        return Err(format!("ffmpeg 不存在：{}", ffmpeg.display()));
    }
    Ok((python, worker, ffmpeg))
}

fn load_credentials() -> Result<DeviceCredentials, String> {
    let path = device_config_path();
    let text = std::fs::read_to_string(&path)
        .map_err(|error| format!("短剧设备凭据读取失败（{}：{error}）。", path.display()))?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|error| {
        format!("设备凭据格式错误（{error}）。应为 deviceId + installId 两个字段。")
    })?;
    let device_id = json_string_field(&value, &["deviceId", "device_id"]);
    let install_id = json_string_field(&value, &["installId", "install_id", "iid"]);
    if device_id.is_empty() || install_id.is_empty() {
        return Err("设备凭据为空（deviceId / installId 均必填）。".to_owned());
    }
    Ok(DeviceCredentials {
        device_id,
        install_id,
        device_token: json_string_field(
            &value,
            &["deviceToken", "device_token", "xTtDt", "x_tt_dt", "x-tt-dt"],
        ),
        cdid: json_string_field(&value, &["cdid"]),
        openudid: json_string_field(&value, &["openudid", "openUdid"]),
    })
}

fn apply_hongguo_worker_env(
    command: &mut tokio::process::Command,
    credentials: &DeviceCredentials,
    profile: HongguoAppProfile,
) {
    command
        .env("TTV_SD_DEVICE_ID", &credentials.device_id)
        .env("TTV_SD_INSTALL_ID", &credentials.install_id)
        .env("TTV_SD_CONTENT_TYPE", profile.content_type.to_string())
        .env("TTV_SD_AID", profile.app_id.to_string());
    if !credentials.device_token.is_empty() {
        command.env("TTV_SD_DEVICE_TOKEN", &credentials.device_token);
    }
    if !credentials.cdid.is_empty() {
        command.env("TTV_SD_CDID", &credentials.cdid);
    }
    if !credentials.openudid.is_empty() {
        command.env("TTV_SD_OPENUDID", &credentials.openudid);
    }
}

#[tauri::command]
pub fn short_drama_app_status() -> ShortDramaAppStatus {
    let (python_found, worker_found, ffmpeg_found) = match worker_paths() {
        Ok((python, worker, ffmpeg)) => (python.is_file(), worker.is_file(), ffmpeg.is_file()),
        Err(_) => (false, false, false),
    };
    let credentials = ensure_credentials().ok();
    ShortDramaAppStatus {
        configured: credentials.is_some(),
        has_device_token: credentials
            .as_ref()
            .map(|item| !item.device_token.is_empty())
            .unwrap_or(false),
        device_hint: credentials
            .as_ref()
            .map(|item| mask_device_id(&item.device_id))
            .unwrap_or_default(),
        python_found,
        worker_found,
        ffmpeg_found,
        cache_dir: cache_dir().to_string_lossy().to_string(),
    }
}

#[tauri::command]
pub fn short_drama_app_set_device(
    device_id: String,
    install_id: String,
    device_token: Option<String>,
    cdid: Option<String>,
    openudid: Option<String>,
) -> Result<String, String> {
    let device_id = device_id.trim().to_owned();
    let install_id = install_id.trim().to_owned();
    if device_id.is_empty() || install_id.is_empty() {
        return Err("deviceId / installId 均不能为空。".into());
    }
    if !device_id.chars().all(|c| c.is_ascii_digit())
        || !install_id.chars().all(|c| c.is_ascii_digit())
    {
        return Err("deviceId / installId 应为纯数字 ID。".into());
    }
    let path = device_config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let existing = load_credentials().ok();
    let keep_or = |incoming: Option<String>, current: String| {
        incoming
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or(current)
    };
    let payload = DeviceCredentials {
        device_id,
        install_id,
        device_token: keep_or(
            device_token,
            existing
                .as_ref()
                .map(|item| item.device_token.clone())
                .unwrap_or_default(),
        ),
        cdid: keep_or(
            cdid,
            existing
                .as_ref()
                .map(|item| item.cdid.clone())
                .unwrap_or_default(),
        ),
        openudid: keep_or(
            openudid,
            existing
                .as_ref()
                .map(|item| item.openudid.clone())
                .unwrap_or_default(),
        ),
    };
    persist_credentials(&payload)?;
    Ok(path.to_string_lossy().to_string())
}

/// 缓存目录卫生清理（在每次解析前顺手做，成本极低）。
///
/// 清理两类文件：
/// 1. worker 中断留下的半成品：`*.part.mp4`、`*.source.tmp`。它们不会被任何
///    读取路径命中，只会占盘（实测出现过 0 字节的 `xxx-1080p.mp4.part.mp4`）。
/// 2. 旧版按清晰度拼文件的幻影副本：`{vid}-{quality}.mp4`。现已统一为
///    `{vid}.mp4`，这些副本是重复下载的产物，保留纯属浪费。
///
/// 只做这两类精确匹配，绝不删除 `{vid}.mp4` 正式缓存。
/// 半成品（`.part.mp4` / `.source.tmp`）的"正在写入"判定门槛（秒）。
///
/// mtime 新于此值的半成品视为**正被某个 worker 写入**，不清理。见
/// `sweep_cache_dir` 里关于预取与前台解析互殴的说明。
const PARTIAL_STALE_SECONDS: u64 = 600;

/// 清理目录里的半成品与幻影清晰度副本。
///
/// `stale_after` 只作用于半成品：mtime 比它更"新"的半成品会被跳过。
///
/// 为什么需要这个门槛：本函数既在启动时调用，也在**每次解析前**调用，而解析
/// 与后台预取是并发的（`MAX_PREWARM_INFLIGHT` 个预取 worker 可能正在写各自
/// 的 `.part.mp4`）。无条件删除所有半成品，就会让"前台换一次集"顺手把"后台
/// 预取正在写的那一集"删掉——两者互殴，表现为换集莫名变慢、偶发失败。
/// 用 mtime 门槛把正在写的文件排除掉即可；启动时与手动清空缓存时传 0，
/// 那时本来就没有 worker 在跑。
fn sweep_cache_dir(dir: &std::path::Path, stale_after: Duration, now: std::time::SystemTime) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let is_partial = name.ends_with(".part.mp4") || name.ends_with(".source.tmp");
        // 半成品必须过了门槛才删；mtime 读不到时按"正在写"处理，保守不删。
        // `{vid}-{quality}.mp4` 是真实画质副本（resolve 按 requested_quality 产
        // 缓存），不再作为"幻影副本"清理——旧版那段逻辑会删掉刚下载的画质副本，
        // 导致画质切换永远无效。
        let partial_is_stale = is_partial
            && entry
                .metadata()
                .ok()
                .and_then(|meta| meta.modified().ok())
                .and_then(|mtime| now.duration_since(mtime).ok())
                .map(|age| age >= stale_after)
                .unwrap_or(false);
        if partial_is_stale {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// 缓存默认预算（字节），短剧 + 漫剧合计。
///
/// 默认 1GB 是容量、保留期与回看体验的平衡点：旧版按频道各留 1.5GB，实际占用
/// 上限 3GB（实测本机已达到 2.25GB、216 个文件）。用户在设置页可以调整。
const DEFAULT_CACHE_BUDGET_BYTES: u64 = 1024 * 1024 * 1024;

/// 运行期缓存预算。保存设置后立即生效，不需要重启。
fn cache_budget_bytes() -> &'static AtomicU64 {
    static BUDGET: OnceLock<AtomicU64> = OnceLock::new();
    BUDGET.get_or_init(|| AtomicU64::new(DEFAULT_CACHE_BUDGET_BYTES))
}

/// 旧设置库里 `playbackCacheMb=0` 是 0.2.x 的"不做字节统计"哨兵，不是用户要禁用
/// 缓存。这里把它解释成默认 1GB，同时限制过小/过大的极端值，避免误配把清理线程
/// 变成永久删除器或让缓存无界增长。
fn normalize_cache_budget_mb(value: f64) -> u64 {
    if !value.is_finite() || value <= 0.0 {
        1024
    } else {
        value.clamp(256.0, 16_384.0).round() as u64
    }
}

/// 从用户设置写入运行期缓存预算。
pub fn set_cache_budget_mb(value: f64) {
    cache_budget_bytes().store(
        normalize_cache_budget_mb(value) * 1024 * 1024,
        Ordering::Relaxed,
    );
}

/// 缓存保留期（秒）。超过此时长且未被访问的整集会被自动清理。
///
/// 7 天是"看完还会回头"与"不再需要"之间的经验分界：短剧多为连续追更，
/// 一周内的剧集大概率还要回看；超过一周未触碰的基本不会再打开。
/// 这一层是时间维度的兜底——即使总占用没超预算，陈旧剧集也会被清掉，
/// 避免"总量刚好卡在预算内所以永远不清理"的僵局。
const CACHE_MAX_AGE_SECONDS: u64 = 7 * 24 * 60 * 60;

/// 把文件的 mtime 更新为"现在"，作为 LRU 的最近使用时间。
///
/// 为什么需要它：旧实现直接用 atime 当 LRU 键，但 Windows 默认
/// `DisableLastAccess=1`（本机实测 fsutil 确认，读取文件后 atime 完全不变），
/// atime 因此恒等于创建时间，LRU 排序退化为"按文件名/目录顺序"，
/// 淘汰会随机删掉**正在播放**的那一集——表现为播放中途报错、
/// 以及刚看过的剧集下次又要重新整集下载。
///
/// 文件可能正被播放器以只读方式打开，写入权限未必拿得到；拿不到就静默放弃，
/// 下一次命中还会再试，不会影响播放。
fn touch_cache_entry(path: &std::path::Path) {
    if path.is_dir() {
        touch_hls_directory(path);
        return;
    }
    if let Ok(file) = std::fs::OpenOptions::new().write(true).open(path) {
        let _ = file.set_modified(std::time::SystemTime::now());
    }
}

/// 把 HLS 会话目录的 mtime 推到"现在"，并返回该目录路径。
///
/// 为什么需要它：整集 HLS 目录（`rtx-vsr/vid-{vid}`）是方案 B 的播放源，
/// 而它的 LRU 键取**目录内最新文件的 mtime**（见 `directory_usage`）。
/// 正在播放中的目录若长时间没有被 touch，一旦用户把缓存上限调低触发
/// `enforce_cache_budget_now`，它就可能被 LRU 选中 —— 那会把**正在播的**产物
/// 抽走，后续分片全 404（审查 B1）。
///
/// 目录本身没有"写入时间"这一说法可靠地反映使用，所以显式把 `index.m3u8`
/// 与 `init.mp4` 的 mtime 推到当前：它们是这个目录的代表文件，且播放器会
/// 持续读它们。
fn touch_hls_directory(directory: &std::path::Path) {
    let now = std::time::SystemTime::now();
    for name in ["index.m3u8", "init.mp4"] {
        let target = directory.join(name);
        if let Ok(file) = std::fs::OpenOptions::new().write(true).open(&target) {
            let _ = file.set_modified(now);
        }
    }
}

/// 刚写入的文件在此时长内绝不被淘汰（秒）。
///
/// 保护两种"正在被使用"的文件：
/// 1. 正在下载/转存、尚未被播放器接管的产物；
/// 2. 播放器刚刚打开、可能仍在读取的那一集。
///
/// 淘汰只看 mtime，而正在播放的文件 mtime 很新，因此不会被选中。
const CACHE_EVICT_GRACE_SECONDS: u64 = 900;

/// 按 LRU 把频道缓存压回预算内。
///
/// `keep` 是本次即将写入/刚命中的那一集，绝不淘汰——否则会出现"刚下载完
/// 立刻被自己删掉"的荒谬情况。
///
/// LRU 键使用 mtime：命中缓存时 `touch_cache_entry` 会把它推到当前时间，
/// 因此 mtime 真实反映"最近使用"。再叠加 `CACHE_EVICT_GRACE_SECONDS` 宽限期，
/// 双重保证不会删除正在播放或刚下载的整集。
/// 上次执行全量缓存淘汰的时间（节流用）。
fn last_eviction() -> &'static Mutex<Option<std::time::Instant>> {
    static LAST: OnceLock<Mutex<Option<std::time::Instant>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(None))
}

/// 两次全量淘汰之间的最小间隔。
const EVICTION_MIN_INTERVAL: Duration = Duration::from_secs(90);

fn enforce_cache_budget(keep: &std::path::Path) {
    // 节流。
    //
    // 淘汰要遍历两个频道目录、对每个文件 stat 取 mtime、排序，缓存贴着预算时
    // 还要真的删掉上百 MB 文件。这段开销被放在**每次解析**的必经路径上，于是
    // "点开一集"凭空多等约两秒——实测同一集：worker 侧只用 632ms，而整条命令
    // 走完要 2761ms，差额全在这里（当时缓存 1020.9MB，正卡在 1GB 上限）。
    // 淘汰本身是收敛性维护，没必要每集都做一遍。
    {
        let mut guard = match last_eviction().lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        if let Some(last) = *guard {
            if last.elapsed() < EVICTION_MIN_INTERVAL {
                return;
            }
        }
        *guard = Some(std::time::Instant::now());
    }
    evict_channels_to_budget_unthrottled(keep);
}

fn evict_channels_to_budget_unthrottled(keep: &std::path::Path) {
    // 跨频道统一收敛：短剧、漫剧与整集 HLS 共享同一份预算。
    //
    // `rtx-vsr/` 是方案 B 的整集 HLS 目录（每集约 58MB），必须计入——否则用户设的
    // 缓存上限管不到它，看一集就多占 58MB。各会话目录由 `directory_usage` 按目录
    // 整体计费，淘汰时整目录删除。
    evict_channels_to_budget(
        &[
            cache_dir().join("short-series"),
            cache_dir().join("motion-comic"),
            cache_dir().join("rtx-vsr"),
        ],
        keep,
        cache_budget_bytes().load(Ordering::Relaxed),
        CACHE_MAX_AGE_SECONDS,
        std::time::SystemTime::now(),
    );
}

/// 用户保存缓存上限后立即收敛一次，不等下一次解析或重启。
///
/// 不能复用 `enforce_cache_budget` 的 90 秒节流：用户刚把上限从 4GB 调到 512MB，
/// 正是希望马上释放空间。宽限期仍然生效，正在播放/下载的新文件不会被误删。
pub fn enforce_cache_budget_now() {
    evict_channels_to_budget_unthrottled(&cache_dir().join("__settings_change__"));
}

/// 自动清理的统计结果。
#[derive(Debug, Default, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheSweepReport {
    /// 删除的整集数量。
    pub removed_files: u64,
    /// 释放的字节数。
    pub freed_bytes: u64,
}

/// 跨频道淘汰主体：把所有频道缓存视为一个池子，按"先过期、再超量"两步收敛。
///
/// 这是**全自动**清理的核心——不需要任何用户确认：
/// 1. **过期清理**：mtime 早于 `max_age_seconds` 的整集直接删除（时间兜底）。
/// 2. **超量清理**：若删除过期项后总量仍超 `budget_bytes`，按 LRU
///    （mtime 升序）继续删最旧的，直到回到预算内。
///
/// 两道保护始终生效：`keep`（本次正在写入/命中的那一集）与宽限期
/// （`CACHE_EVICT_GRACE_SECONDS` 内的新文件）永不被删。
///
/// 预算、保留期与"当前时刻"都显式传入，便于单元测试直接验证行为。
fn evict_channels_to_budget(
    dirs: &[std::path::PathBuf],
    keep: &std::path::Path,
    budget_bytes: u64,
    max_age_seconds: u64,
    now: std::time::SystemTime,
) -> CacheSweepReport {
    let grace = std::time::Duration::from_secs(CACHE_EVICT_GRACE_SECONDS);
    let max_age = std::time::Duration::from_secs(max_age_seconds);

    // 收集所有频道下的整集缓存（跳过半成品与 keep）。
    //
    // 两类条目：
    //   1. **文件** —— 旧链路的整集 mp4（`{vid}.mp4`）；
    //   2. **目录** —— 方案 B 的整集 HLS 会话目录（`rtx-vsr/vid-{vid}/`），
    //      含 `index.m3u8` + `init.mp4` + `seg-*.m4s`，按目录整体计费与淘汰。
    //
    // 为什么必须把目录也算进来：那批产物每集约 58MB（实测 92.7 秒正片），
    // 而它们此前完全在预算之外 —— 唯一的回收是换集时 `remove_dir_all`，
    // 也就是说"看得越多占得越多、用户设的上限管不着"。把目录纳入之后，
    // LRU 淘汰按**整集**生效（不会出现删掉分片却留下清单的半残状态）。
    let mut files: Vec<(std::path::PathBuf, u64, std::time::SystemTime, bool)> = Vec::new();
    let mut total: u64 = 0;
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // HLS 会话目录：整体算一个条目。
            if path.is_dir() {
                let (size, stamp) = directory_usage(&path);
                if size == 0 {
                    continue;
                }
                total = total.saturating_add(size);
                files.push((path, size, stamp, true));
                continue;
            }
            if !path.is_file() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if !name.ends_with(".mp4") || name.ends_with(".part.mp4") {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            let size = meta.len();
            if size == 0 {
                continue;
            }
            let stamp = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            total = total.saturating_add(size);
            files.push((path, size, stamp, false));
        }
    }

    let mut report = CacheSweepReport::default();
    // 宽限期内的文件（正在下载/刚播放）不参与任何清理。
    let is_protected = |path: &std::path::Path, stamp: std::time::SystemTime| -> bool {
        if path == keep {
            return true;
        }
        now.duration_since(stamp)
            .map(|age| age < grace)
            .unwrap_or(true)
    };

    // 第一步：过期清理。
    for (path, size, stamp, is_dir) in &files {
        if is_protected(path, *stamp) {
            continue;
        }
        let expired = now
            .duration_since(*stamp)
            .map(|age| age > max_age)
            .unwrap_or(false);
        if expired && remove_entry(path, *is_dir) {
            total = total.saturating_sub(*size);
            report.removed_files += 1;
            report.freed_bytes = report.freed_bytes.saturating_add(*size);
        }
    }

    // 第二步：超量清理（LRU）。
    if total > budget_bytes {
        let mut survivors: Vec<&(std::path::PathBuf, u64, std::time::SystemTime, bool)> = files
            .iter()
            .filter(|(path, _, _, _)| path.exists())
            .collect();
        survivors.sort_by_key(|(_, _, stamp, _)| *stamp);
        for (path, size, stamp, is_dir) in survivors {
            if total <= budget_bytes {
                break;
            }
            if is_protected(path, *stamp) {
                continue;
            }
            if remove_entry(path, *is_dir) {
                total = total.saturating_sub(*size);
                report.removed_files += 1;
                report.freed_bytes = report.freed_bytes.saturating_add(*size);
            }
        }
    }

    report
}

/// 删掉一个缓存条目：文件用 `remove_file`，HLS 会话目录用 `remove_dir_all`。
///
/// 目录**必须整目录删**：只删分片会留下一份指向不存在分片的清单，播放器拉到它
/// 就会一连串 404 —— 那比"这一集没缓存"更糟，因为它看起来是"缓存命中"。
fn remove_entry(path: &std::path::Path, is_dir: bool) -> bool {
    if is_dir {
        std::fs::remove_dir_all(path).is_ok()
    } else {
        std::fs::remove_file(path).is_ok()
    }
}

/// 一个目录的 (总字节, 最新的 mtime)。
///
/// 用**最新**的 mtime 而不是最旧的：整集 HLS 在转码期间会不断写新分片，
/// 用最旧的会把"正在写"的目录算成很久没碰过（它里面的 init.mp4 是最早写的），
/// 于是刚转出来的产物可能立刻被淘汰。最新 mtime 在转完后还会被 `touch` 推到当下，
/// 语义正好等于"这一集最近被用过"。
fn directory_usage(path: &std::path::Path) -> (u64, std::time::SystemTime) {
    let mut total: u64 = 0;
    let mut newest = std::time::SystemTime::UNIX_EPOCH;
    let Ok(entries) = std::fs::read_dir(path) else {
        return (0, newest);
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        total = total.saturating_add(meta.len());
        if let Ok(stamp) = meta.modified() {
            if stamp > newest {
                newest = stamp;
            }
        }
    }
    (total, newest)
}

/// 统计当前缓存占用（短剧 + 漫剧 + 整集 HLS 合计）。
pub fn cache_usage() -> CacheSweepReport {
    let mut total: u64 = 0;
    let mut count: u64 = 0;
    for dir in [
        cache_dir().join("short-series"),
        cache_dir().join("motion-comic"),
        cache_dir().join("rtx-vsr"),
    ] {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            // HLS 会话目录：整目录算一集。设置页显示的占用必须与实际一致，
            // 否则用户清完缓存仍看到几十 MB 的落差。
            if entry.path().is_dir() {
                let (size, _) = directory_usage(&entry.path());
                if size == 0 {
                    continue;
                }
                total = total.saturating_add(size);
                count += 1;
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if !meta.is_file() || meta.len() == 0 {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".mp4") || name.ends_with(".part.mp4") {
                continue;
            }
            total = total.saturating_add(meta.len());
            count += 1;
        }
    }
    CacheSweepReport {
        removed_files: count,
        freed_bytes: total,
    }
}

/// 启动时的全自动清理：清理半成品 + 过期剧集 + 超量剧集，并在根目录做一次整理。
///
/// 由 setup 钩子调用，**无需用户任何确认**。返回统计供日志输出。
pub fn auto_clean_cache_on_start() -> CacheSweepReport {
    let root = cache_dir();
    for dir in [
        root.clone(),
        root.join("short-series"),
        root.join("motion-comic"),
    ] {
        // 启动时没有任何 worker 在跑，陈旧门槛传 0 = 全部清理。
        sweep_cache_dir(&dir, Duration::from_secs(0), std::time::SystemTime::now());
    }
    // `rtx-vsr/` 是方案 B 的整集 HLS 目录（每集约 58MB），必须与其它频道一起
    // 计入预算与过期清理 —— 否则它在磁盘上只增不减，而用户设的上限管不到它。
    // 此前这里只列了 short-series / motion-comic，与 `evict_channels_to_budget_unthrottled`
    // 的注释（"三个频道共享同一份预算"）自相矛盾（审查 B2）。
    let rtx_root = root.join("rtx-vsr");
    sweep_cache_dir(
        &rtx_root,
        Duration::from_secs(0),
        std::time::SystemTime::now(),
    );
    // keep 指向一个不可能存在的路径：启动时没有任何"正在写入"的剧集。
    let sentinel = root.join("__none__");
    evict_channels_to_budget(
        &[
            root.join("short-series"),
            root.join("motion-comic"),
            rtx_root,
        ],
        &sentinel,
        cache_budget_bytes().load(Ordering::Relaxed),
        CACHE_MAX_AGE_SECONDS,
        std::time::SystemTime::now(),
    )
}

/// 把前端传来的画质串归一成 worker 认得的档位：`auto` / `4k` / `{digits}p`。
///
/// 前端画质菜单报的是**源流真实高度**，实测会出现 540、360 这类固定档位之外的
/// 值，所以这里不能只白名单 4 个字面量——旧写法把未知档位一律降级成 `auto`，
/// 于是用户点了 540P 之后仍然拿默认最高档，表现成"画质菜单点了没反应"。
fn normalize_requested_quality(raw: &str) -> String {
    let trimmed = raw.trim().to_ascii_lowercase();
    if trimmed.is_empty() || trimmed == "auto" {
        return "auto".into();
    }
    if trimmed == "4k" {
        return "4k".into();
    }
    let digits: String = trimmed
        .chars()
        .filter(|value| value.is_ascii_digit())
        .collect();
    match digits.as_str() {
        "" => "auto".into(),
        "2160" => "4k".into(),
        value => format!("{value}p"),
    }
}

/// sidecar 标记里的内容是否代表"这已经是转码后的 H.264"。
///
/// 只有 `h264` 算数：`skip`（用户关着 VSR 时跳过的 HEVC）与空/损坏内容都不算。
/// 旧版标记文件也是 `h264\n`，所以历史记录继续有效。
fn marker_content_is_h264(marker: &std::path::Path) -> bool {
    std::fs::read_to_string(marker)
        .map(|value| value.trim() == "h264")
        .unwrap_or(false)
}

/// 把历史缓存补齐成 H.264。旧版本会把 bytevc1/HEVC 原样留下；没有这个迁移，
/// 升级后重播旧缓存仍然走不到 RTX VSR。新 worker 产物本身已是 H.264，但用同
/// 一个 sidecar 标记避免每次命中都重转一遍。
async fn ensure_h264_cache(
    path: &std::path::Path,
    ffmpeg: &std::path::Path,
    enabled: bool,
) -> Result<(), String> {
    let marker = path.with_extension("h264");
    // 标记**必须连同内容一起判**，不能只看文件存在。
    //
    // 历史坑：VSR 关闭分支曾经也写下 `h264\n`，与"转码成功"的标记一字不差。
    // 于是关掉 VSR 看一集 HEVC 旧缓存之后，那集就被永久打上"已是 H.264"的假标记；
    // 用户重新打开 VSR 时这一集被这里直接短路，HEVC 文件照原样播出去，
    // 视觉增强静默失效（不变量 25：VSR 的硬条件是 H.264）。
    // 现在关闭分支写的是 `skip\n`，只认 `h264` 才算真转码过。
    if marker_content_is_h264(&marker) {
        return Ok(());
    }
    // 用户关掉了 RTX VSR：不再把整集重编一遍。
    //
    // 这不是"省一点 CPU"——旧缓存迁移是在**起播路径上同步跑**的：一集 1920×1080
    // 实测要重编几秒到十几秒，而缓存里可能积累了几十集旧缓存（HEVC/bytevc1）。
    // 开着开关时这笔成本换的是 VSR；关掉之后它换不到任何东西，只剩"点一集转一次"。
    // 产物保持 HEVC，直连播放（VSR 本来也不认 HEVC，见不变量 25）。
    //
    // ⚠️ 这里写的必须是**与转码成功不同的内容**（`skip` 而不是 `h264`）。
    // 写 `h264` 会造成"假标记"：用户之后重新打开 VSR 时，上面那道
    // `marker_content_is_h264` 判定会把这一集的 HEVC 当成已迁移，直接放行 ——
    // 视觉增强永久静默失效，而且现象是"有些集有 VSR、有些集没有"，极难排查。
    if !enabled {
        let _ = std::fs::write(&marker, b"skip\n");
        return Ok(());
    }
    let partial = path.with_file_name(format!(
        "{}.h264.part.mp4",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    let _ = std::fs::remove_file(&partial);
    let mut command = tokio::process::Command::new(ffmpeg);
    command
        .args(["-y", "-hide_banner", "-loglevel", "error"])
        .arg("-i")
        .arg(path);
    command
        .args(["-map", "0:v:0", "-map", "0:a:0?"])
        // 编码参数与 `media_enhance::x264_args()` **同源**：这条链路产出的也是交给同一块
        // `<video>` 播的 H.264，自己另抄一份就会漂移 —— 此前这里少了 `-profile:v high`、
        // 码率上限与关键帧约束，于是"迁移出来的老集"与"新解析的集"seek 粒度、体积、
        // 首帧时间都对不上（审查发现的第四条链路）。
        .args(crate::media_enhance::x264_args())
        .args(["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"])
        .arg(&partial);
    command
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let status = command
        .status()
        .await
        .map_err(|error| format!("旧缓存 H.264 转码失败：{error}"))?;
    if !status.success()
        || !partial.is_file()
        || partial
            .metadata()
            .map(|meta| meta.len() == 0)
            .unwrap_or(true)
    {
        let _ = std::fs::remove_file(&partial);
        return Err("旧缓存 H.264 转码失败。".to_owned());
    }
    std::fs::rename(&partial, path).map_err(|error| format!("写回 H.264 缓存失败：{error}"))?;
    std::fs::write(&marker, b"h264\n").map_err(|error| format!("写入缓存标记失败：{error}"))?;
    Ok(())
}

/// 解析一集：命中缓存直接返回；否则拉起 worker.py（下载+解密+转存）并转发进度。
///
/// 同 (vid, quality) 的并发请求（预取 + 前台换集几乎同时发生）只允许一个
/// worker 进程真正跑：后到的 follower 等待 leader 完成后直接读缓存。
/// 若 leader 失败，follower 自行重跑一次。否则两个 worker 会同时写同一份
/// `.source.tmp` / `.part.mp4`，互相删除对方的半成品，造成 ffmpeg 互殴。
#[tauri::command]
pub async fn short_drama_app_resolve<R: Runtime>(
    app: AppHandle<R>,
    input: ShortDramaAppResolveInput,
) -> Result<ShortDramaAppPlayback, String> {
    let vid = input.vid.trim().to_owned();
    if vid.is_empty() || !vid.chars().all(|c| c.is_ascii_digit()) {
        return Err("缺少有效的集 vid。".into());
    }
    let profile = HongguoAppProfile::from_input(input.content_type, input.app_id)?;
    // 真实画质请求：worker 按 preferred_quality_height 缺档回退选流。
    // 档位串由 normalize_requested_quality 归一（auto / 4k / {digits}p），
    // 它接受任意真实高度，不再把非固定档位静默降级成 auto。
    let raw_quality = input
        .quality
        .as_deref()
        .unwrap_or("auto")
        .trim()
        .to_ascii_lowercase();
    let requested_quality = normalize_requested_quality(&raw_quality);
    let (python, worker, ffmpeg) = worker_paths()?;
    let credentials = ensure_credentials()?;

    // 缓存寻址：auto 用 {vid}.mp4（默认主副本）；指定档位用 {vid}-{quality}.mp4。
    // 旧版把所有请求归一成 auto，画质切换在 Rust 侧被丢弃，前端切了也无效。
    let namespace_path =
        cache_dir()
            .join(profile.cache_namespace)
            .join(if requested_quality == "auto" {
                format!("{vid}.mp4")
            } else {
                format!("{vid}-{requested_quality}.mp4")
            });
    // TTV Box stored short-drama files directly under short-drama-cache before
    // the per-channel namespaces were added. Reuse those files instead of
    // downloading the same episode again after an upgrade.
    let legacy_path = (requested_quality == "auto").then(|| cache_dir().join(format!("{vid}.mp4")));
    let out_path = std::iter::once(namespace_path.clone())
        .chain(legacy_path)
        .into_iter()
        .find(|path| path.is_file() && path.metadata().map(|meta| meta.len() > 0).unwrap_or(false))
        .unwrap_or(namespace_path);
    let cached_payload = |path: &std::path::Path| {
        touch_cache_entry(path);
        Ok(ShortDramaAppPlayback {
            play_url: path.to_string_lossy().to_string(),
            width: 0,
            height: 0,
            size_bytes: path.metadata().map(|meta| meta.len()).unwrap_or(0),
            cached: true,
            stream_kind: None,
            backup_url: None,
            duration_ms: None,
        })
    };
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("创建缓存目录失败：{error}"))?;
    }
    // 缓存卫生：清理上次异常退出留下的半成品。
    // `*.part.mp4` / `*.source.tmp` 是 worker 中断的残留，永远不会被任何路径
    // 读取，只会占盘（实测残留过 0 字节的 xxx-1080p.mp4.part.mp4）。
    // `{vid}-{quality}.mp4` 是**真实画质副本**（resolve 现按 requested_quality
    // 产缓存），绝不能删——旧版把它当幻影副本清掉的逻辑已随画质切换的恢复
    // 一并移除。
    // 保留 mtime 很新的半成品：那很可能是并发预取 worker 正在写的那一集。
    sweep_cache_dir(
        out_path.parent().unwrap_or(&cache_dir()),
        Duration::from_secs(PARTIAL_STALE_SECONDS),
        std::time::SystemTime::now(),
    );
    // 容量上限：缓存无界增长会把用户磁盘吃满（实测已积累 2.25GB 且只增不减）。
    // 这是**全自动**收敛：跨频道按 LRU 淘汰、并清掉超过保留期的陈旧剧集，
    // 全程无需用户确认。keep 传本次要写入的那一集，避免自我删除。
    enforce_cache_budget(&out_path);

    // ===== 在途去重（leader / follower）=====
    // follower 每 500ms 轮询缓存；leader 落盘后直接读缓存返回。leader 失败
    // 会摘除表项，follower 超时后自己接管重跑，避免单次网络抖动判死整集。
    let inflight_key = format!("{}:{requested_quality}:{vid}", profile.cache_namespace);
    let mut follower_waited: u32 = 0;
    loop {
        let acquired = {
            let map = resolve_inflight();
            let mut guard = map.lock().map_err(|_| "解析在途表锁不可用。".to_string())?;
            if guard.contains(&inflight_key) {
                false
            } else {
                guard.insert(inflight_key.clone());
                true
            }
        };
        if acquired {
            // 旧缓存迁移也必须在 leader/follower 闸门内做：否则悬停预热与前台打开
            // 会同时转码同一文件，两边的 .h264.part.mp4 会互相覆盖。
            if out_path.is_file()
                && out_path
                    .metadata()
                    .map(|meta| meta.len() > 0)
                    .unwrap_or(false)
            {
                match ensure_h264_cache(&out_path, &ffmpeg, crate::vsr_is_enabled()).await {
                    Ok(()) => return cached_payload(&out_path),
                    Err(error) => {
                        // 旧缓存损坏不能永久卡死：删掉它，让下面的 worker 重新下载。
                        eprintln!("[ttv] 旧缓存转 H.264 失败，重新解析：{error}");
                        let _ = std::fs::remove_file(&out_path);
                    }
                }
            }
            break; // 本请求为 leader，跑 worker
        }
        // follower：轮询缓存等 leader 落盘，或等 leader 摘除表项后接管。
        follower_waited += 1;
        if follower_waited == 1 {
            // 悬停预热与前台打开撞在同一集时，前台会变成 follower 干等。日志里
            // 必须能区分"真的在下载"与"其实在排队"，否则会把排队误判成网络慢。
            crate::trace::log(format!(
                "[红果] 同一集已有解析在途，本请求排队等待 vid={vid}"
            ));
        }
        let deadline = tokio::time::Instant::now()
            + if follower_waited <= 2 {
                WORKER_TIMEOUT + Duration::from_secs(15)
            } else {
                // 两轮等待（630s+）仍无产物属于极端场景：直接抢 leader 重跑。
                Duration::from_secs(0)
            };
        while tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(500)).await;
            if out_path.with_extension("h264").is_file()
                && out_path
                    .metadata()
                    .map(|meta| meta.len() > 0)
                    .unwrap_or(false)
            {
                ensure_h264_cache(&out_path, &ffmpeg, crate::vsr_is_enabled()).await?;
                return cached_payload(&out_path);
            }
            let leader_alive = {
                let map = resolve_inflight();
                map.lock()
                    .map(|guard| guard.contains(&inflight_key))
                    .unwrap_or(false)
            };
            if !leader_alive {
                break; // leader 已退场（成功后表项已摘，产物在下一轮判断命中；失败则接管）
            }
        }
        // 回外层循环抢 leader 位。
    }

    // 预签名直链让 worker 跳过签名链路，代价是直链可能已过期（带时间戳签名）。
    // 因此失败且用过预签名时清掉缓存重跑一次：这一轮 worker 会重新签名，
    // 用户既不会看到过期直链导致的错误，也不必自己手动重试。
    // 只有请求 auto 且确实复用了预签名直链时，失败才需要清缓存重跑；
    // 指定档位走的是现场解析，缓存与这一轮的成败无关。
    // 解析这一段通常是首开时间里最长的一段：worker 要把整集下载、解密、再转存成
    // 本地 H.264。把它单独计时并记下"是否已有缓存 / 是否复用预签名直链"，因为
    // 这两点直接决定后面要等几秒还是几十秒。
    crate::trace::log(format!(
        "[红果] resolve 开始 vid={vid} 档位={requested_quality} 复用预签名={} 产物路径={}",
        requested_quality == "auto" && peek_stream(&vid).is_some(),
        out_path.display()
    ));
    let resolve_started = std::time::Instant::now();
    let had_prefetched = requested_quality == "auto" && peek_stream(&vid).is_some();
    let mut attempt = 0;
    let result = loop {
        attempt += 1;
        let outcome = run_resolve_worker(
            &app,
            python.clone(),
            worker.clone(),
            ffmpeg.clone(),
            credentials.clone(),
            profile,
            vid.clone(),
            &requested_quality,
            out_path.clone(),
        )
        .await;
        if outcome.is_ok() || !had_prefetched || attempt >= 2 {
            break outcome;
        }
        clear_stream(&vid);
    };
    // 无论成败都摘除 leader 位：follower 读到产物则返回，否则自行接管重跑。
    match &result {
        Ok(playback) => crate::trace::log(format!(
            "[红果] resolve 完成 vid={vid} 耗时={}ms 尺寸={}x{} 字节={}（整集文件，播放器要等它落盘）",
            resolve_started.elapsed().as_millis(),
            playback.width,
            playback.height,
            playback.size_bytes
        )),
        Err(error) => crate::trace::log(format!(
            "[红果] resolve 失败 vid={vid} 耗时={}ms 原因={error}",
            resolve_started.elapsed().as_millis()
        )),
    }
    if result.is_ok() {
        // worker 新产物已是 H.264，只补标记，不再把刚生成的文件重转一遍。
        let _ = std::fs::write(out_path.with_extension("h264"), b"h264\n");
    }
    {
        let map = resolve_inflight();
        if let Ok(mut guard) = map.lock() {
            guard.remove(&inflight_key);
        }
    }
    result
}

/// 前缀先行开播：只取开头一小段（worker 侧按 `TTV_SD_PREFIX_BYTES` 截断）解密
/// 转存成 `{vid}.prefix.mp4`，让播放器几秒内先出画面；整集仍由
/// `short_drama_app_resolve` 在后台照常下载，落盘后前端再切到完整文件。
///
/// 参数与 `short_drama_app_resolve` 完全一致——前端把两条链路当成"同一件事的
/// 快慢两档"。差别只在产物与生命周期：前缀是**独立产物**（与整集并存、可被覆盖
/// 重建），所以在途去重键带 `:prefix` 后缀，与整集互不阻塞、可以并发。
///
/// 整集已在盘上时直接返回整集（`cached: true`）：前缀的全部意义就是省掉整集的
/// 等待，盘上已有整集就没必要再多下一个 ~2MB 的前缀。
#[tauri::command]
pub async fn short_drama_app_resolve_prefix(
    input: ShortDramaAppResolveInput,
) -> Result<ShortDramaAppPlayback, String> {
    let vid = input.vid.trim().to_owned();
    if vid.is_empty() || !vid.chars().all(|c| c.is_ascii_digit()) {
        return Err("缺少有效的集 vid。".into());
    }
    let profile = HongguoAppProfile::from_input(input.content_type, input.app_id)?;
    let raw_quality = input
        .quality
        .as_deref()
        .unwrap_or("auto")
        .trim()
        .to_ascii_lowercase();
    let requested_quality = normalize_requested_quality(&raw_quality);

    // 整集寻址与 short_drama_app_resolve 同构（含旧版本直接写在根目录下的副本）。
    let namespace_path =
        cache_dir()
            .join(profile.cache_namespace)
            .join(if requested_quality == "auto" {
                format!("{vid}.mp4")
            } else {
                format!("{vid}-{requested_quality}.mp4")
            });
    let legacy_path = (requested_quality == "auto").then(|| cache_dir().join(format!("{vid}.mp4")));
    let existing_full = std::iter::once(namespace_path.clone())
        .chain(legacy_path)
        .into_iter()
        .find(|path| path.is_file() && path.metadata().map(|meta| meta.len() > 0).unwrap_or(false));
    if let Some(path) = existing_full {
        touch_cache_entry(&path);
        return Ok(ShortDramaAppPlayback {
            play_url: path.to_string_lossy().to_string(),
            width: 0,
            height: 0,
            size_bytes: path.metadata().map(|meta| meta.len()).unwrap_or(0),
            cached: true,
            stream_kind: None,
            backup_url: None,
            duration_ms: None,
        });
    }

    let (python, worker, ffmpeg) = worker_paths()?;
    let credentials = ensure_credentials()?;
    // 前缀产物与整集并存：`{vid}.prefix.mp4`。`with_extension` 只替换最后一段
    // 扩展名，所以指定档位的 `{vid}-{quality}.prefix.mp4` 与 auto 的
    // `{vid}.prefix.mp4` 天然分开，不会互相覆盖。
    let out_path = namespace_path.with_extension("prefix.mp4");
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("创建缓存目录失败：{error}"))?;
    }
    // 与整集链路同样的缓存卫生：清掉上次中断留下的半成品（mtime 门槛保护正在写的那份）。
    sweep_cache_dir(
        out_path.parent().unwrap_or(&cache_dir()),
        Duration::from_secs(PARTIAL_STALE_SECONDS),
        std::time::SystemTime::now(),
    );

    // 在途去重：键比整集多一个 `:prefix`，因此"前缀"与"整集"可以同时跑；
    // 同一集的两个前缀请求（预取与前台打开撞车）仍然只跑一个 worker。
    let inflight_key = format!(
        "{}:{}:{vid}:prefix",
        profile.cache_namespace, requested_quality
    );
    let acquired = {
        let map = resolve_inflight();
        let mut guard = map.lock().map_err(|_| "解析在途表锁不可用。".to_string())?;
        if guard.contains(&inflight_key) {
            false
        } else {
            guard.insert(inflight_key.clone());
            true
        }
    };
    if !acquired {
        // 已经在途：轮询等它落盘即可，再拉一个 worker 只会让两份半成品互删。
        for _ in 0..120u32 {
            tokio::time::sleep(Duration::from_millis(250)).await;
            if let Some(payload) = prefix_payload(&out_path) {
                return Ok(payload);
            }
            let alive = {
                let map = resolve_inflight();
                map.lock()
                    .map(|guard| guard.contains(&inflight_key))
                    .unwrap_or(false)
            };
            if !alive {
                break;
            }
        }
        return prefix_payload(&out_path).ok_or_else(|| "前缀解析在途但未产出文件。".to_owned());
    }

    crate::trace::log(format!(
        "[红果] 前缀解析开始 vid={vid} 档位={requested_quality} 产物路径={}",
        out_path.display()
    ));
    let started = std::time::Instant::now();
    let result = run_prefix_worker(
        python,
        worker,
        ffmpeg,
        credentials,
        profile,
        vid.clone(),
        &requested_quality,
        out_path.clone(),
    )
    .await;
    match &result {
        Ok(playback) => crate::trace::log(format!(
            "[红果] 前缀解析完成 vid={vid} 耗时={}ms 字节={}（前缀先行，整集仍在后台下载）",
            started.elapsed().as_millis(),
            playback.size_bytes
        )),
        Err(error) => crate::trace::log(format!(
            "[红果] 前缀解析失败 vid={vid} 耗时={}ms 原因={error}",
            started.elapsed().as_millis()
        )),
    }
    {
        let map = resolve_inflight();
        if let Ok(mut guard) = map.lock() {
            guard.remove(&inflight_key);
        }
    }
    result
}

/// 前缀产物已落盘则组装返回载荷；文件不存在或为空返回 None。
fn prefix_payload(path: &std::path::Path) -> Option<ShortDramaAppPlayback> {
    let size = path.metadata().map(|meta| meta.len()).unwrap_or(0);
    if size == 0 {
        return None;
    }
    Some(ShortDramaAppPlayback {
        play_url: path.to_string_lossy().to_string(),
        width: 0,
        height: 0,
        size_bytes: size,
        // 前缀**不是**整集：cached 必须为 false，否则前端会以为自己拿到了整集，
        // 不再等后台那条整集链路，播完十几秒就没了。
        cached: false,
        stream_kind: None,
        backup_url: None,
        duration_ms: None,
    })
}

/// leader 专属：拉起 worker 进程完成下载+解密+转存，转发进度事件。
///
/// 参数偏多是这条链路的固有特征：它需要目标路径、进度上报句柄，以及一组
/// worker 运行期凭据。这些值分别来自不同的上层调用点，强行打包成一个结构体
/// 只会把同一个签名换个地方写，可读性并不会更好。
#[allow(clippy::too_many_arguments)]
async fn run_resolve_worker<R: Runtime>(
    app: &AppHandle<R>,
    python: PathBuf,
    worker: PathBuf,
    ffmpeg: PathBuf,
    credentials: DeviceCredentials,
    profile: HongguoAppProfile,
    vid: String,
    requested_quality: &str,
    out_path: PathBuf,
) -> Result<ShortDramaAppPlayback, String> {
    let _ = app.emit(
        RESOLVE_EVENT,
        serde_json::json!({"vid": vid, "stage": "start", "message": "正在启动云端解析"}),
    );
    crate::trace::log(format!(
        "[红果] worker 启动 vid={vid} 档位={requested_quality} 复用预签名={}",
        requested_quality == "auto" && peek_stream(&vid).is_some()
    ));

    let mut command = tokio::process::Command::new(&python);
    command.arg(&worker).arg("resolve").arg(&vid);
    apply_hongguo_worker_env(&mut command, &credentials, profile);
    command.env("TTV_SD_QUALITY", requested_quality);
    // 命中预签名缓存时把直链与解密密钥直接交给 worker，跳过两次 App API 往返
    // （实测固定 2.16s）。直链过期会让 ffmpeg 拉流失败，调用方
    // short_drama_app_resolve 会在失败后清掉缓存并重跑一次。
    //
    // 只在请求 auto 时复用：缓存里存的是**默认最高档**那一条，指定档位必须让
    // worker 重新解析、按 preferred_quality_height 现场选流，否则会把顶档流写进
    // `{vid}-{quality}.mp4`，之后该档位永远返回错的文件（参考实现每次都按
    // task.DownloadQuality 现场选流，不存在"跨档复用同一份实体"的设计）。
    if requested_quality == "auto" {
        if let Some(cached) = peek_stream(&vid) {
            command
                .env("TTV_SD_DIRECT_URL", &cached.url)
                .env("TTV_SD_DIRECT_KEY", &cached.content_key)
                .env("TTV_SD_DIRECT_WIDTH", cached.width.to_string())
                .env("TTV_SD_DIRECT_HEIGHT", cached.height.to_string())
                .env("TTV_SD_DIRECT_DURATION", cached.duration_ms.to_string())
                .env("TTV_SD_DIRECT_CODEC", &cached.codec);
        }
    }
    command
        .env("TTV_SD_FFMPEG", &ffmpeg)
        .env("TTV_SD_OUT", &out_path)
        .env("PYTHONNOUSERSITE", "1")
        .env("PYTHONIOENCODING", "utf-8")
        // VSR 开关必须交给 worker：红果链路不经过 media_enhance，这是开关
        // 唯一的落点（详见模块头注释）。开=输出 H.264 走硬件编码；
        // 关=能 copy 就 copy，回到未引入 VSR 时的重封装语义。
        .env(
            "TTV_SD_VSR",
            if crate::vsr_is_enabled() { "1" } else { "0" },
        )
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    // CREATE_NO_WINDOW：后台进程不闪控制台窗口。
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动解析 worker 失败：{error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "解析 worker stdout 不可读".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "解析 worker stderr 不可读".to_owned())?;

    let emit_app = app.clone();
    let emit_vid = vid.clone();
    let reader = tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut lines = BufReader::new(stdout).lines();
        let mut final_payload: Option<serde_json::Value> = None;
        let mut error_text = String::new();
        // worker 的 stage 会一路告诉我们它卡在哪一步（解析 / 下载 / 解密 / 转存），
        // 这正是"一直在加载等待"要定位的东西。但 percent 每次变化都上报会刷屏，
        // 所以只在 stage 变化时落一行，带上该 stage 的首个百分比。
        let mut last_stage: Option<String> = None;
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                error_text.push_str(trimmed);
                error_text.push('\n');
                continue;
            };
            match value.get("event").and_then(serde_json::Value::as_str) {
                Some("progress") => {
                    let stage = value
                        .get("stage")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    if last_stage.as_deref() != Some(stage.as_str()) {
                        last_stage = Some(stage.clone());
                        crate::trace::log(format!(
                            "[红果] worker 阶段 vid={} stage={} message={} percent={}",
                            emit_vid,
                            stage,
                            value
                                .get("message")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or_default(),
                            value
                                .get("percent")
                                .map(|percent| percent.to_string())
                                .unwrap_or_else(|| "-".to_owned())
                        ));
                    }
                    let _ = emit_app.emit(
                        RESOLVE_EVENT,
                        serde_json::json!({
                            "vid": emit_vid,
                            "stage": value.get("stage").cloned().unwrap_or(serde_json::Value::Null),
                            "message": value.get("message").cloned().unwrap_or(serde_json::Value::Null),
                            "percent": value.get("percent").cloned().unwrap_or(serde_json::Value::Null),
                        }),
                    );
                }
                Some("done") => final_payload = Some(value),
                _ => error_text.push_str(trimmed),
            }
        }
        (final_payload, error_text)
    });
    // stderr 必须持续排空（否则管道写满会卡死 worker），失败时取尾部辅助定位。
    let stderr_reader = tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut lines = BufReader::new(stderr).lines();
        let mut collected = String::new();
        let mut count: usize = 0;
        while let Ok(Some(line)) = lines.next_line().await {
            // 首行必须留证：worker 崩在导入阶段（缺依赖、Python 版本不对）时，
            // stderr 只有一行，而这一行会被后面的 8000 字节截断逻辑保留下来，
            // 却从来没被人看到过——过去排查只能靠猜。
            if count == 0 && !line.trim().is_empty() {
                crate::trace::log(format!("[红果] worker stderr 首行：{}", line.trim()));
            }
            count += 1;
            if collected.len() < 8000 {
                collected.push_str(&line);
                collected.push('\n');
            }
        }
        if count > 1 {
            crate::trace::log(format!("[红果] worker stderr 共 {count} 行（末尾已存档）"));
        }
        collected
    });

    let wait_result = tokio::time::timeout(WORKER_TIMEOUT, child.wait()).await;
    let status = match wait_result {
        Ok(Ok(status)) => Some(status),
        Ok(Err(error)) => {
            reader.abort();
            return Err(format!("解析 worker 退出异常：{error}"));
        }
        Err(_) => {
            let _ = child.kill().await;
            reader.abort();
            crate::trace::log(format!(
                "[红果] worker 超时被杀 vid={vid} 上限={}s（这一条意味着用户会看到很久的加载）",
                WORKER_TIMEOUT.as_secs()
            ));
            return Err("云端解析超时（300 秒），请稍后重试。".into());
        }
    };
    let (final_payload, error_text) = reader
        .await
        .map_err(|error| format!("读取解析输出失败：{error}"))?;
    let stderr_text = stderr_reader.await.unwrap_or_else(|_| String::new());

    if !status.map(|status| status.success()).unwrap_or(false) || final_payload.is_none() {
        let detail = final_payload
            .as_ref()
            .and_then(|value| value.get("error"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| {
                let mut combined = error_text.trim().to_owned();
                let stderr_tail = stderr_text.trim().to_owned();
                if !stderr_tail.is_empty() {
                    if !combined.is_empty() {
                        combined.push_str(" | ");
                    }
                    combined.push_str(
                        &stderr_tail
                            .lines()
                            .rev()
                            .take(3)
                            .collect::<Vec<_>>()
                            .into_iter()
                            .rev()
                            .collect::<Vec<_>>()
                            .join(" / "),
                    );
                }
                combined
            });
        let _ = app.emit(
            RESOLVE_EVENT,
            serde_json::json!({"vid": vid, "stage": "error", "message": detail}),
        );
        crate::trace::log(format!("[红果] worker 失败 vid={vid} 原因={detail}"));
        // 半成品文件清理
        let _ = std::fs::remove_file(&out_path);
        return Err(if detail.is_empty() {
            "云端解析失败（worker 未返回结果）。".to_owned()
        } else {
            format!("云端解析失败：{}", explain_hongguo_api_error(&detail))
        });
    }

    let payload = final_payload.unwrap();
    let width = payload
        .get("width")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0) as u32;
    let height = payload
        .get("height")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0) as u32;
    let size = payload
        .get("size")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    crate::trace::log(format!(
        "[红果] worker 完成 vid={vid} 尺寸={width}x{height} 字节={size}"
    ));
    let _ = app.emit(
        RESOLVE_EVENT,
        serde_json::json!({"vid": vid, "stage": "done", "message": "解析完成"}),
    );
    Ok(ShortDramaAppPlayback {
        play_url: out_path.to_string_lossy().to_string(),
        width,
        height,
        size_bytes: size,
        cached: false,
        stream_kind: None,
        backup_url: None,
        // 整集 mp4：时长由浏览器读文件头即得，不需要后端代劳。
        duration_ms: None,
    })
}

/// leader 专属：拉起 worker 的 `resolve-prefix` 子命令，产出 `{vid}.prefix.mp4`。
///
/// 与整集链路（`run_resolve_worker`）的差别是刻意保留的：
/// - **不发进度事件**：前缀只是"抢先出画"的加速手段，它若往 RESOLVE_EVENT 上写
///   进度，会覆盖整集链路的百分比与剩余时间估算（前端只有一个加载提示卡）。
///   用户看到的那条进度仍然是整集进度——这正是"前面已经在播、后面继续下"的语义。
/// - **不写 `.h264` 标记、不做旧缓存迁移**：worker 已按 TTV_SD_VSR 产出正确编码，
///   前缀又是短命产物（会被缓存预算淘汰、也会被整集链路取代），不需要那一层。
#[allow(clippy::too_many_arguments)]
async fn run_prefix_worker(
    python: PathBuf,
    worker: PathBuf,
    ffmpeg: PathBuf,
    credentials: DeviceCredentials,
    profile: HongguoAppProfile,
    vid: String,
    requested_quality: &str,
    out_path: PathBuf,
) -> Result<ShortDramaAppPlayback, String> {
    crate::trace::log(format!(
        "[红果] 前缀 worker 启动 vid={vid} 档位={requested_quality} 复用预签名={}",
        requested_quality == "auto" && peek_stream(&vid).is_some()
    ));

    let mut command = tokio::process::Command::new(&python);
    command.arg(&worker).arg("resolve-prefix").arg(&vid);
    apply_hongguo_worker_env(&mut command, &credentials, profile);
    command.env("TTV_SD_QUALITY", requested_quality);
    // 与整集链路同一套预签名注入：命中悬停预热留下的直链时，worker 直接跳过
    // 两次 App API 往返（实测固定 2.16s）——前缀要抢的正是这几秒。
    if requested_quality == "auto" {
        if let Some(cached) = peek_stream(&vid) {
            command
                .env("TTV_SD_DIRECT_URL", &cached.url)
                .env("TTV_SD_DIRECT_KEY", &cached.content_key)
                .env("TTV_SD_DIRECT_WIDTH", cached.width.to_string())
                .env("TTV_SD_DIRECT_HEIGHT", cached.height.to_string())
                .env("TTV_SD_DIRECT_DURATION", cached.duration_ms.to_string())
                .env("TTV_SD_DIRECT_CODEC", &cached.codec);
        }
    }
    command
        .env("TTV_SD_FFMPEG", &ffmpeg)
        .env("TTV_SD_OUT", &out_path)
        .env("PYTHONNOUSERSITE", "1")
        .env("PYTHONIOENCODING", "utf-8")
        // VSR 开关同样要交给前缀：输出编码必须和整集产物一致，否则切源那一刻
        // 画面从"增强过"变回原始，用户会以为切源把画质弄坏了。
        .env(
            "TTV_SD_VSR",
            if crate::vsr_is_enabled() { "1" } else { "0" },
        )
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动前缀 worker 失败：{error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "前缀 worker stdout 不可读".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "前缀 worker stderr 不可读".to_owned())?;

    let reader = tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut lines = BufReader::new(stdout).lines();
        let mut final_payload: Option<serde_json::Value> = None;
        let mut error_text = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                error_text.push_str(trimmed);
                error_text.push('\n');
                continue;
            };
            match value.get("event").and_then(serde_json::Value::as_str) {
                // progress 一律吞掉，不上报（理由见函数头注释）。
                Some("progress") => {}
                Some("done") => final_payload = Some(value),
                _ => error_text.push_str(trimmed),
            }
        }
        (final_payload, error_text)
    });
    let stderr_reader = tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut lines = BufReader::new(stderr).lines();
        let mut collected = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            if collected.len() < 4000 {
                collected.push_str(&line);
                collected.push('\n');
            }
        }
        collected
    });

    match tokio::time::timeout(PREFIX_WORKER_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => {
            if !status.success() {
                crate::trace::log(format!(
                    "[红果] 前缀 worker 退出码非零 vid={vid} status={status}"
                ));
            }
        }
        Ok(Err(error)) => {
            reader.abort();
            return Err(format!("前缀 worker 退出异常：{error}"));
        }
        Err(_) => {
            let _ = child.kill().await;
            reader.abort();
            crate::trace::log(format!(
                "[红果] 前缀 worker 超时被杀 vid={vid} 上限={}s",
                PREFIX_WORKER_TIMEOUT.as_secs()
            ));
            return Err("前缀解析超时，请稍后重试。".into());
        }
    }
    let (final_payload, error_text) = reader
        .await
        .map_err(|error| format!("读取前缀解析输出失败：{error}"))?;
    let stderr_text = stderr_reader.await.unwrap_or_else(|_| String::new());

    // 成败**以文件为准**，不以退出码或 done 载荷为准：worker 的 emit 不带 vid，
    // 而且历史上有过"done 已发、文件随后被后一轮覆盖"的窗口——产物在盘上就是
    // 可播的，没有产物才算失败。
    if let Some(mut playback) = prefix_payload(&out_path) {
        if let Some(value) = final_payload.as_ref() {
            playback.width = value
                .get("width")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0) as u32;
            playback.height = value
                .get("height")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0) as u32;
        }
        return Ok(playback);
    }

    let detail = final_payload
        .as_ref()
        .and_then(|value| value.get("error"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            let mut combined = error_text.trim().to_owned();
            let stderr_tail = stderr_text.trim().to_owned();
            if !stderr_tail.is_empty() {
                if !combined.is_empty() {
                    combined.push_str(" | ");
                }
                combined.push_str(
                    &stderr_tail
                        .lines()
                        .rev()
                        .take(3)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect::<Vec<_>>()
                        .join(" / "),
                );
            }
            combined
        });
    let _ = std::fs::remove_file(&out_path);
    Err(if detail.is_empty() {
        "前缀解析失败（worker 未返回结果）。".to_owned()
    } else {
        format!("前缀解析失败：{}", explain_hongguo_api_error(&detail))
    })
}

/// 手动清空全部剧集缓存（设置页按钮）。**只清整集视频**，不动其他应用数据。
///
/// 注意：这是用户显式点击时的行为；日常清理完全自动化，不需要用户介入
/// （见 `auto_clean_cache_on_start` 与 `enforce_cache_budget`）。
#[tauri::command]
pub fn short_drama_app_cache_clear() -> Result<CacheSweepReport, String> {
    let before = cache_usage();
    for dir in [
        cache_dir().join("short-series"),
        cache_dir().join("motion-comic"),
    ] {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    // 顺带清掉根目录下的历史遗留文件（旧版本直接写在 short-drama-cache 根下）。
    // 这里是用户主动"清空缓存"，门槛传 0 = 全部清理。
    sweep_cache_dir(
        &cache_dir(),
        Duration::from_secs(0),
        std::time::SystemTime::now(),
    );
    let Ok(entries) = std::fs::read_dir(cache_dir()) else {
        return Ok(before);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(before)
}

/// 查询当前缓存占用（供设置页显示真实数字）。
#[tauri::command]
pub fn short_drama_app_cache_usage() -> CacheSweepReport {
    cache_usage()
}

/// App 搜索联想返回的单条剧集。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSuggestion {
    pub id: String,
    pub title: String,
    pub cover: String,
    pub episode_count: u32,
    pub tags: Vec<String>,
}

/// 用 App 搜索联想补充网页搜索的缺项。
///
/// 网页搜索每次只返回前 10 条，且分季剧集（"…第 N 季"）在结果里是跳着出现的
/// ——用户搜"…第11季"经常根本看不到那一季。App 联想会按名称前缀把整组季列全
/// （实测搜"聚宝仙盆"能列出第十一/十/九/七/五/四/三/二季与仙界篇、灵界篇）。
///
/// 失败一律返回空列表：这是锦上添花的补充来源，不该让整次搜索失败。
pub async fn search_suggest<R: Runtime>(
    app: &AppHandle<R>,
    keyword: &str,
    _comic: bool,
) -> Vec<SearchSuggestion> {
    // 恒用短剧档（content_type 1 / aid 8662），不随频道切 aid：
    // 搜索联想接口实测只由 aid=8662 服务，传漫剧档的 aid=8704 会回 HTTP 200 +
    // **空 body**（`signed_get` 随即抛 JSONDecodeError，整条联想补齐静默失效，
    // 而它正是为了补齐"网页搜索只返回前 10 条、分季条目跳着出现"才存在的）。
    // 而 aid=8662 的搜索索引本身是全局的——实测搜"反派亲妈"返回的条目
    // content_type 同时包含 1（短剧）与 1004/1007（漫剧）。
    // `_comic` 保留只为调用点稳定。
    let profile = match HongguoAppProfile::from_input(Some(1), None) {
        Ok(profile) => profile,
        Err(_) => return Vec::new(),
    };
    let payload = match run_worker_subcommand(app, "search", keyword, "search", profile).await {
        Ok(payload) => payload,
        Err(error) => {
            eprintln!("[ttv] 搜索联想不可用：{error}");
            return Vec::new();
        }
    };
    payload
        .get("items")
        .and_then(serde_json::Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let id = entry.get("id")?.as_str()?.trim();
                    let title = entry.get("title")?.as_str()?.trim();
                    if id.is_empty() || title.is_empty() {
                        return None;
                    }
                    Some(SearchSuggestion {
                        id: id.to_owned(),
                        title: title.to_owned(),
                        cover: entry
                            .get("cover")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        episode_count: entry
                            .get("episodeCount")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(0) as u32,
                        tags: entry
                            .get("tags")
                            .and_then(serde_json::Value::as_array)
                            .map(|values| {
                                values
                                    .iter()
                                    .filter_map(serde_json::Value::as_str)
                                    .map(str::to_owned)
                                    .collect()
                            })
                            .unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 批量取真实集数（漫剧列表卡片"集数未知"的修复）。
///
/// 漫剧列表来自公开榜单页 HTML，但该页 HTML 与内嵌 router data 都不含任何集数
/// 文案（实测整页 `episode_cnt` 出现 0 次），所以列表卡片只能显示"集数未知"，
/// 真实集数只有 App 侧有。`album_detail` 支持一次传多个 `series_ids`，返回
/// `data.video_detail_data.<series_id>.video_data.episode_cnt`——实测整页 20 部
/// 一次命中 20/20，网络耗时冷启 337ms / 热 117ms，远优于逐部详情页的 N 次往返。
///
/// 端到端（含 Python 启动）实测 0.6-1.9s，且 worker 是单实例、会和播放解析互斥，
/// 因此调用方应把它当成**可选的锦上添花**：先出卡片，集数随后补上。
/// 失败一律返回空表，不影响目录可用性。
pub async fn episode_counts<R: Runtime>(
    app: &AppHandle<R>,
    series_ids: &[String],
) -> HashMap<String, u32> {
    let mut unique: Vec<String> = Vec::new();
    for candidate in series_ids.iter().map(|value| value.trim()) {
        if candidate.is_empty() || !candidate.chars().all(|ch| ch.is_ascii_digit()) {
            continue;
        }
        if !unique.iter().any(|existing| existing.as_str() == candidate) {
            unique.push(candidate.to_owned());
        }
    }
    if unique.is_empty() {
        return HashMap::new();
    }
    // 目录一页最多 60 条（见 catalog_comic 的 page_size 夹取）；一次请求带过多 id
    // 会让 argv 过长且上游可能截断，这里按同一上限收口。
    unique.truncate(60);
    // 漫剧档位：content_type 1004 / aid 8662（2026-09-18 起 8704 被网关静默拒绝）。
    let Ok(profile) = HongguoAppProfile::from_input(Some(1004), None) else {
        return HashMap::new();
    };
    let target = unique.join(",");
    let payload = match run_worker_subcommand(app, "counts", &target, "counts", profile).await {
        Ok(payload) => payload,
        Err(error) => {
            eprintln!("[ttv] 集数批量补齐不可用：{error}");
            return HashMap::new();
        }
    };
    payload
        .get("counts")
        .and_then(serde_json::Value::as_object)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|(key, value)| {
                    let total = value.as_u64()? as u32;
                    (total > 0).then(|| (key.clone(), total))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 前端按页调用：把当前可见卡片的 series_id 一次性补齐真实集数。
#[tauri::command]
pub async fn short_drama_app_episode_counts<R: Runtime>(
    app: AppHandle<R>,
    series_ids: Vec<String>,
) -> Result<HashMap<String, u32>, String> {
    Ok(episode_counts(&app, &series_ids).await)
}

// ---------------------------------------------------------------------------
// 「更多」页的分区数据源
// ---------------------------------------------------------------------------

/// 一页分区列表。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelfFeedPage {
    pub items: Vec<SeriesItem>,
    pub has_more: bool,
    /// **不透明游标**：调用方原样回传即可，不要尝试解析它的内容。
    ///
    /// 红果两条接口的分页模型不同（榜单是 `session_uuid + next_offset`、上架是
    /// `offset`），worker 把两者都编码进这个字符串，前端只负责带回来。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// 分区 × 频道 → 红果 App 查询参数。
///
/// 这张表来自**私有渠道**调研。**核心结论是官方的「热播」与「新剧」
/// 本来就是两条不同的接口**，不是同一份列表切两段：
///
/// | 分区 | 频道 | 接口 | 判别参数 |
/// | --- | --- | --- | --- |
/// | 热播 | 漫剧 | 榜单 `cell/change` | `board=hot` → `comic_series_hot_play` |
/// | 热播 | 短剧 | 上架 `landpage` | `sort=hot_score`（短剧没有 cell 榜） |
/// | 新剧 | 短剧 | 上架 `landpage` | `sort=online_time` |
/// | 新剧 | 漫剧 | 上架 `landpage` | `sort=online_time` |
///
/// `sort` 必须用它自己的词表（`online_time` / `hot_score` / `hot_collect`），
/// 不能把 TTV 前端的 `recommend/latest/heat` 直接透传。
fn shelf_feed_spec(
    kind: &str,
    channel: &str,
    cursor: Option<&str>,
) -> Result<serde_json::Value, String> {
    let (mode, genre, board, sort) = match (kind, channel) {
        ("hot", "comic") => ("rank", "", "hot", ""),
        ("hot", "drama") => ("list", "short_play", "", "hot_score"),
        ("new", "comic") => ("list", "comic_series", "", "online_time"),
        ("new", "drama") => ("list", "short_play", "", "online_time"),
        (_, "adult") => {
            return Err("红果 App 接口没有 18+ 口径，神秘小窝不走这条链路。".to_owned());
        }
        ("hot" | "new", other) => {
            return Err(format!("该分区暂不支持频道 {other}。"));
        }
        (other, _) => return Err(format!("未知分区：{other}")),
    };

    let mut spec = serde_json::json!({ "mode": mode });
    let object = spec.as_object_mut().expect("刚构造的对象字面量");
    for (key, value) in [("genre", genre), ("board", board), ("sort", sort)] {
        if !value.is_empty() {
            object.insert(key.to_owned(), serde_json::Value::String(value.to_owned()));
        }
    }
    if let Some(cursor) = cursor.map(str::trim).filter(|value| !value.is_empty()) {
        object.insert(
            "cursor".to_owned(),
            serde_json::Value::String(cursor.to_owned()),
        );
    }
    Ok(spec)
}

/// worker 条目 → `SeriesItem`。
///
/// 脏数据（HTML 标签、题材噪声）已经在 worker 侧处理掉，这里只做类型与字段名的
/// 搬运 —— 与 `search_suggest` 的分工一致。
fn shelf_feed_item(entry: &serde_json::Value, channel: &str) -> Option<SeriesItem> {
    let id = entry.get("id")?.as_str()?.trim();
    let title = entry.get("title")?.as_str()?.trim();
    if id.is_empty() || title.is_empty() {
        return None;
    }
    // 评分源给的是字符串（"9.4"），解析不了就当"源没给"。**绝不能填 0**：
    // 前端是 `{series.rating && …}`，0 既会渲染成"0.0 分"角标，也是凭空造分
    // （不变量 8：不要把不存在的东西显示成存在）。
    let rating = entry
        .get("score")
        .and_then(serde_json::Value::as_str)
        .and_then(|raw| raw.trim().parse::<f64>().ok())
        .filter(|value| *value > 0.0);
    Some(SeriesItem {
        id: id.to_owned(),
        title: title.to_owned(),
        cover: entry
            .get("cover")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        // 漫剧走 comic，其余走 drama：`SeriesCard` 靠它决定角标配色与悬停色。
        item_type: if channel == "comic" { "comic" } else { "drama" }.to_owned(),
        episodes_count: entry
            .get("episodeCount")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0) as u32,
        latest_episode_title: None,
        tags: entry
            .get("tags")
            .and_then(serde_json::Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        origin: entry
            .get("copyright")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_owned(),
        brief: entry
            .get("brief")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        rating,
    })
}

/// 拉一页分区列表。
pub async fn shelf_feed<R: Runtime>(
    app: &AppHandle<R>,
    kind: &str,
    channel: &str,
    cursor: Option<&str>,
) -> Result<ShelfFeedPage, String> {
    let spec = shelf_feed_spec(kind, channel, cursor)?;
    // 恒用短剧档（content_type 1 / aid 8662）：实测 aid 8662 的列表接口同时服务
    // 短剧与漫剧（漫剧由 `select_items.genre` 表达），而 8704 已被网关静默拒绝
    // （HTTP 200 + 空 body）。与 `search_suggest` 的结论一致。
    let profile = HongguoAppProfile::from_input(Some(1), None)?;
    let payload = run_worker_subcommand(app, "feed", &spec.to_string(), "shelf", profile).await?;
    let items = payload
        .get("items")
        .and_then(serde_json::Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| shelf_feed_item(entry, channel))
                .collect()
        })
        .unwrap_or_default();
    Ok(ShelfFeedPage {
        items,
        has_more: payload
            .get("hasMore")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        next_cursor: payload
            .get("nextCursor")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
    })
}

/// 前端「更多」页调用：按分区拉一页。
#[tauri::command]
pub async fn short_drama_app_shelf_feed<R: Runtime>(
    app: AppHandle<R>,
    kind: String,
    channel: String,
    cursor: Option<String>,
) -> Result<ShelfFeedPage, String> {
    shelf_feed(&app, &kind, &channel, cursor.as_deref()).await
}

// ---------------------------------------------------------------------------
// 红果封面代理（HEIC → JPEG）
// ---------------------------------------------------------------------------

/// 封面转码缓存目录。刻意与 guo-core 的 `covers-v1` 分开：两套命名与淘汰策略
/// 互不相干，混在一起以后想清一边就得小心另一边。
fn cover_cache_dir() -> PathBuf {
    resolve_data_dir().join("hongguo-covers-v1")
}

/// 用 URL 的 64 位散列做缓存文件名。
///
/// 没为这个缓存引入 sha2/md5：目录里几千张图的量级下 64 位碰撞可以忽略，真撞了
/// 也只是缓存回一张错图（下次启动重新生成），不值得为它加依赖。
fn cover_cache_key(url: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// 图片字节的容器类型。决定要不要转码，以及 `data:` URL 的 mime。
fn image_kind(bytes: &[u8]) -> &'static str {
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        match &bytes[8..12] {
            b"heic" | b"heix" | b"heim" | b"heis" | b"mif1" | b"msf1" => return "heic",
            _ => {}
        }
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return "jpeg";
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return "png";
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return "webp";
    }
    if bytes.starts_with(b"GIF8") {
        return "gif";
    }
    if bytes.first() == Some(&b'<') {
        return "html";
    }
    "unknown"
}

fn image_data_url(bytes: &[u8], ext: &str) -> String {
    let mime = match ext {
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/jpeg",
    };
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// HEIC → JPEG（用随包的 ffmpeg，实测单张 0.39s）。
///
/// 走临时文件而不是管道：ffmpeg 的 image2 输出走管道要自己拼封装，为几十 KB 的图
/// 不值得；临时文件就写在缓存目录旁边，转完无论成败都清掉。
async fn convert_heic_to_jpeg(
    cache_dir: &std::path::Path,
    key: &str,
    bytes: &[u8],
) -> Result<Vec<u8>, String> {
    let ffmpeg = ffmpeg_path()?;
    let source = cache_dir.join(format!("{key}.heic.tmp"));
    let target = cache_dir.join(format!("{key}.jpg"));
    std::fs::write(&source, bytes).map_err(|error| format!("写入临时封面失败：{error}"))?;
    let mut command = tokio::process::Command::new(&ffmpeg);
    command
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(&source)
        .arg("-frames:v")
        .arg("1")
        .arg("-q:v")
        .arg("4")
        .arg("-y")
        .arg(&target);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // 别弹控制台黑窗
    let output = command.output().await;
    let _ = std::fs::remove_file(&source);
    let output = output.map_err(|error| format!("封面转码失败：{error}"))?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&target);
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "封面转码失败：{}",
            detail.lines().last().unwrap_or("未知原因")
        ));
    }
    std::fs::read(&target).map_err(|error| format!("读取转码结果失败：{error}"))
}

/// 命令的实体。独立出来是为了能被下面 `#[ignore]` 的联网测试直接调用 ——
/// 那条测试不需要 Tauri 运行时，只验证"下载 → 识别 → 转码 → data URL"这一串。
async fn cover_to_data_url(url: &str, cache_dir: &std::path::Path) -> Result<String, String> {
    let url = url.trim();
    if !url.starts_with("https://") {
        return Err("封面地址无效。".to_owned());
    }
    let host_ok = {
        let rest = url.trim_start_matches("https://");
        let authority = rest.split(['/', '?']).next().unwrap_or("");
        let host_only = authority.rsplit('@').next().unwrap_or(authority);
        let host = host_only
            .split(':')
            .next()
            .unwrap_or(host_only)
            .to_ascii_lowercase();
        host.ends_with(".fqnovelpic.com")
            || host.ends_with(".byteimg.com")
            || host.ends_with(".snssdk.com")
    };
    if !host_ok {
        return Err("该封面来源不支持代理。".to_owned());
    }

    std::fs::create_dir_all(cache_dir).map_err(|error| format!("创建封面缓存目录失败：{error}"))?;
    let key = cover_cache_key(url);

    // 命中缓存直接读盘。缓存里存的是**已转码**的格式，所以不需要原地址。
    for ext in ["jpg", "png", "webp", "gif"] {
        if let Ok(bytes) = std::fs::read(cache_dir.join(format!("{key}.{ext}"))) {
            return Ok(image_data_url(&bytes, ext));
        }
    }

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("封面下载失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("封面下载失败：HTTP {}", response.status()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("封面读取失败：{error}"))?;

    match image_kind(&bytes) {
        "heic" => {
            let jpeg = convert_heic_to_jpeg(cache_dir, &key, &bytes).await?;
            Ok(image_data_url(&jpeg, "jpg"))
        }
        "unknown" | "html" => Err("封面不是可识别的图片。".to_owned()),
        kind => {
            let ext = if kind == "jpeg" { "jpg" } else { kind };
            let _ = std::fs::write(cache_dir.join(format!("{key}.{ext}")), &bytes);
            Ok(image_data_url(&bytes, ext))
        }
    }
}

/// 红果封面 → `data:` URL。
///
/// **为什么必须转**：红果图片服务给的是 HEIC（实测 `content-type: image/heic`、
/// 文件头 `ftypheic`），而 WebView2/Chromium 解不了 HEIC —— 前端直接把地址丢给
/// `<img>`，只会得到一块解码失败的空白（用户报告的"视频海报出不来"）。官方 PC
/// 客户端做的是同一件事，它的 `/img?url=` 注释写着"红果封面常返回 HEIC，浏览器
/// 不支持时转成 JPEG"，只是它用 Pillow，我们用随包的 ffmpeg。
///
/// **为什么返回 data URL 而不是本地文件路径**：`asset:` 协议的作用域在开发态
/// （数据目录是项目内 `.app-data`）与打包后（`app_data_dir()`）并不一致，写文件
/// 要么动 scope、要么挑一个两边都在的目录，都不如直接把 JPEG 塞回前端干净 ——
/// CSP 的 `img-src` 本来就有 `data:`。缓存仍落盘，所以重复进入某一页只是读文件。
///
/// 只代理字节系的图片域名：这是唯一会回 HEIC 的一族；放开成任意 URL 会让它变成
/// 一个人人可用的代理（SSRF）。
#[tauri::command]
pub async fn short_drama_app_cover_proxy(url: String) -> Result<String, String> {
    cover_to_data_url(&url, &cover_cache_dir()).await
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefetchStreamInput {
    pub vids: Vec<String>,
    #[serde(default)]
    pub content_type: Option<u16>,
    #[serde(default)]
    pub app_id: Option<u32>,
}

/// 预签名：提前把接下来几集的播放直链与解密密钥取回并缓存。
///
/// 这是"秒开"的关键一步。`stream` 只有两次 API 往返、不下载任何媒体数据，
/// 几乎不占带宽，实测 2.1-2.3s；而用户从打开详情页到点某一集通常有
/// 数秒到数十秒的空档。把这段做完，点集时的 resolve 就从 3-5s 掉到 1s 上下。
///
/// 逐个串行执行：瓶颈是签名计算与 API 往返而非带宽，串行还能让结果按
/// "用户最可能点的顺序"先进缓存。任一集失败都静默跳过——预签名是纯优化。
#[tauri::command]
pub async fn short_drama_app_prefetch_stream<R: Runtime>(
    app: AppHandle<R>,
    input: PrefetchStreamInput,
) -> Result<u32, String> {
    let profile = HongguoAppProfile::from_input(input.content_type, input.app_id)?;
    let mut targets: Vec<String> = Vec::new();
    // 上限 6 集：再多也只是把缓存塞满，用户点不到那么远。
    for raw in input.vids.iter().take(6) {
        let vid = raw.trim().to_owned();
        if vid.is_empty() || !vid.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        if peek_stream(&vid).is_some() {
            continue;
        }
        targets.push(vid);
    }
    if targets.is_empty() {
        return Ok(0);
    }
    // 并发签名（限流 3）。
    //
    // 每集是两次独立的 App API 往返、实测约 2.4s。串行做 6 集就是十几秒，
    // 用户点第一集时后面几集根本还没签上，等于白排。限流 3 路既能把这批压到
    // 一轮往返的量级，又不会把后端和带宽打满。
    let mut ready = 0u32;
    for chunk in targets.chunks(3) {
        let mut handles = Vec::new();
        for vid in chunk {
            let app_handle = app.clone();
            let target = vid.clone();
            handles.push(tokio::spawn(async move {
                match run_worker_subcommand(&app_handle, "stream", &target, "prefetch", profile)
                    .await
                {
                    Ok(payload) => {
                        store_stream(&target, &payload);
                        true
                    }
                    Err(error) => {
                        eprintln!("[ttv] 预签名跳过 {target}：{error}");
                        false
                    }
                }
            }));
        }
        for handle in handles {
            if handle.await.unwrap_or(false) {
                ready += 1;
            }
        }
    }
    Ok(ready)
}

// ============ stream / album（签名直链与专辑详情，共用 worker 进程） ============

/// 拉起单次 worker 子命令并收集最终 `{"event":"done",...}` 载荷。
/// 与 resolve 的差别：不需要 ffmpeg/OUT 环境变量，进度事件带 `action` 区分。
async fn run_worker_subcommand<R: Runtime>(
    app: &AppHandle<R>,
    subcommand: &str,
    target: &str,
    action: &'static str,
    profile: HongguoAppProfile,
) -> Result<serde_json::Value, String> {
    let (python, worker, ffmpeg) = worker_paths()?;
    let credentials = ensure_credentials()?;

    let mut command = tokio::process::Command::new(&python);
    command.arg(&worker).arg(subcommand).arg(target);
    apply_hongguo_worker_env(&mut command, &credentials, profile);
    command
        .env("PYTHONNOUSERSITE", "1")
        .env("PYTHONIOENCODING", "utf-8")
        // 随包 ffmpeg 也交给 worker：`stream` 子命令要用它读一次源流的真实时长
        // （播放模型里那个 duration 字段实测不可信），resolve 那条链路本来就有。
        .env("TTV_SD_FFMPEG", &ffmpeg)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动解析 worker 失败：{error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "解析 worker stdout 不可读".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "解析 worker stderr 不可读".to_owned())?;

    let emit_app = app.clone();
    // tokio::spawn 要求闭包是 'static：subcommand 是借用参数，必须先把归属搬到
    // 闭包外的 String 里（日志要用它）；action 本身已是 &'static str，不用动。
    let subcommand_log = subcommand.to_owned();
    let reader = tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut lines = BufReader::new(stdout).lines();
        let mut final_payload: Option<serde_json::Value> = None;
        let mut error_text = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                error_text.push_str(trimmed);
                error_text.push('\n');
                continue;
            };
            match value.get("event").and_then(serde_json::Value::as_str) {
                Some("progress") => {
                    // 目录/详情/合集这类子命令也要留证：用户报"切页面卡"时，
                    // 常常是这里在等云端，而不是界面本身慢。
                    crate::trace::log(format!(
                        "[红果] worker {} stage={}",
                        subcommand_log,
                        value
                            .get("stage")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                    ));
                    let _ = emit_app.emit(
                        RESOLVE_EVENT,
                        serde_json::json!({
                            "action": action,
                            "stage": value.get("stage").cloned().unwrap_or(serde_json::Value::Null),
                            "message": value.get("message").cloned().unwrap_or(serde_json::Value::Null),
                        }),
                    );
                }
                Some("done") => final_payload = Some(value),
                _ => error_text.push_str(trimmed),
            }
        }
        (final_payload, error_text)
    });
    let stderr_reader = tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut lines = BufReader::new(stderr).lines();
        let mut collected = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            if collected.len() < 4000 {
                collected.push_str(&line);
                collected.push('\n');
            }
        }
        collected
    });

    let wait_result = tokio::time::timeout(STREAM_WORKER_TIMEOUT, child.wait()).await;
    let status = match wait_result {
        Ok(Ok(status)) => Some(status),
        Ok(Err(error)) => {
            reader.abort();
            return Err(format!("解析 worker 退出异常：{error}"));
        }
        Err(_) => {
            let _ = child.kill().await;
            reader.abort();
            return Err("云端取流超时，已停止等待。".into());
        }
    };
    let (final_payload, error_text) = reader
        .await
        .map_err(|error| format!("读取解析输出失败：{error}"))?;
    let stderr_text = stderr_reader.await.unwrap_or_else(|_| String::new());

    if !status.map(|status| status.success()).unwrap_or(false) || final_payload.is_none() {
        let mut combined = error_text.trim().to_owned();
        let stderr_tail = stderr_text.trim().to_owned();
        if !stderr_tail.is_empty() {
            if !combined.is_empty() {
                combined.push_str(" | ");
            }
            combined.push_str(
                &stderr_tail
                    .lines()
                    .rev()
                    .take(3)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join(" / "),
            );
        }
        return Err(if combined.is_empty() {
            format!("worker {subcommand} 失败（未返回结果）。")
        } else {
            format!(
                "worker {subcommand} 失败：{}",
                explain_hongguo_api_error(&combined)
            )
        });
    }
    let payload = final_payload.unwrap();
    if payload.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        let detail = payload
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("未知错误");
        return Err(format!(
            "worker {subcommand} 失败：{}",
            explain_hongguo_api_error(detail)
        ));
    }
    Ok(payload)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortDramaAppStreamInput {
    pub vid: String,
    #[serde(default)]
    pub content_type: Option<u16>,
    #[serde(default)]
    pub app_id: Option<u32>,
}

/// 真实清晰度档位查询：签名取回该集的 variants，报出**实际存在**的分辨率。
///
/// 存在的意义：公开网页只给一条流，前端之前凭空硬编码 4K/1080P/720P，
/// 导致"切清晰度"既不真实又触发重复下载。这里把源流真实档位（含宽高与
/// 码率）原样交给前端，让清晰度菜单只显示源真正提供的档位。
/// 失败时返回空列表而不是报错：清晰度是锦上添花，不该阻塞播放。
#[tauri::command]
pub async fn short_drama_app_qualities<R: Runtime>(
    app: AppHandle<R>,
    input: ShortDramaAppStreamInput,
) -> Result<Vec<ShortDramaAppVariant>, String> {
    let vid = input.vid.trim().to_owned();
    if vid.is_empty() || !vid.chars().all(|c| c.is_ascii_digit()) {
        return Err("缺少有效的集 vid。".into());
    }
    let profile = HongguoAppProfile::from_input(input.content_type, input.app_id)?;
    let payload = match run_worker_subcommand(&app, "stream", &vid, "stream", profile).await {
        Ok(payload) => payload,
        Err(_) => return Ok(Vec::new()),
    };
    let variants = payload
        .get("variants")
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| {
                    let url = value.get("url").and_then(serde_json::Value::as_str)?.trim();
                    if url.is_empty() {
                        return None;
                    }
                    // 高度夹在 1-4320（与果果 parsePlaybackQuality 的清晰度范围
                    // 一致）：异常档位（worker 解析出 0 或超高分）不进画质菜单。
                    let height = value
                        .get("height")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0)
                        .min(4320);
                    if height == 0 {
                        return None;
                    }
                    Some(ShortDramaAppVariant {
                        id: value
                            .get("id")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        label: value
                            .get("label")
                            .and_then(serde_json::Value::as_str)
                            .filter(|label| !label.trim().is_empty())
                            .unwrap_or("原始画质")
                            .to_owned(),
                        url: url.to_owned(),
                        decryption_key: value
                            .get("content_key")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        width: value
                            .get("width")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(0)
                            .min(8640) as u32,
                        height: height as u32,
                        bitrate: value
                            .get("bitrate")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(0),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(variants)
}

/// 边转边播：把红果加密源**直接**转成本地 H.264 HLS，首片落地就把地址交出去。
///
/// ## 它和另外两条红果链路的关系
///
/// | 链路 | 产物 | 实测首屏 | 说明 |
/// |---|---|---|---|
/// | `resolve`（整集） | 本地 mp4 | 6.6–22.3 秒 | 下载+解密+转存**整集**才返回 |
/// | `resolve_prefix`（前缀） | `{vid}.prefix.mp4` | 6.2–7.2 秒 | 只取开头 2MB 源流，但仍要下载+解密+转码一轮 |
/// | **本命令** | 本地 HLS 分片 | **约 3.3 秒**（首片 1.1 秒+API 2.2 秒） | 不落整集，边解密边转边播 |
///
/// ## 为什么它更快
///
/// 前缀通道要把「下载 2MB 源流 → 解密转码 → 落盘 mp4 → 再交给播放器」整段走完才
/// 能返回（实测下载 2301ms + 转码 983ms）。本命令把这四步**合并成一件事**：ffmpeg
/// 直接从加密直链读、带 `-decryption_key` 边解密边转 H.264、按 2 秒切片写到本地 HLS
/// 目录，第一个分片一写完地址就能播。实测：**首片 1005–1126ms 落地**（含 API 往返
/// 3.1–3.5 秒总首屏），而不是等整段下载完。
///
/// 这就是用户要的「先把视频画面出来，播放的同时再加载」——播放与取流并行了。
///
/// ## 和整集链路并存，不是替代
///
/// 调用方应当**同时**发这条和整集 `resolve`：本命令负责尽早出画，整集负责最终质量
/// （可拖动、秒切清晰度、不需要持续转码）。两条链路各有自己的会话目录与在途去重键，
/// 互不阻塞。
///
/// ## 失败语义
///
/// 与 `media_enhance` 一致：`ensure_server` 起不来、ffmpeg 立刻退出、或者等满
/// `READY_WAIT` 仍无产物，都返回 Err，调用方回退既有链路。**慢不等于失败**——
/// 进程还活着就把地址交出去，让播放器按自己的重试节奏等首段。
#[tauri::command]
pub async fn short_drama_app_open_stream<R: Runtime>(
    app: AppHandle<R>,
    input: ShortDramaAppStreamInput,
    session_id: u64,
) -> Result<ShortDramaAppPlayback, String> {
    let vid = input.vid.trim().to_owned();
    if vid.is_empty() || !vid.chars().all(|c| c.is_ascii_digit()) {
        return Err("缺少有效的集 vid。".into());
    }
    // RTX VSR 开关关闭时**不走这条路**：这条链路产出的是 H.264 分片，正是 VSR 需要
    // 的形态，而「关」的语义是"完全回到引入 media_enhance 之前的旧播放链路"。
    // 判断放在这里而不是前端，是为了让开关只有一处权威判定（与
    // `enhance_short_drama_session` 同一个 AtomicBool），前端漏判也不会破坏契约。
    if !crate::vsr_is_enabled() {
        crate::trace::log(format!(
            "[红果] VSR 开关=关，流式开播让位给旧链路 vid={vid}（调用方回退前缀/整集）"
        ));
        return Err("VSR 开关已关闭，使用旧播放链路。".into());
    }
    let profile = HongguoAppProfile::from_input(input.content_type, input.app_id)?;
    // ⚠️ **不再优先返回整集 mp4**。
    //
    // 方案 B（用户 2026-10-08 拍板）之后，这条链路是**唯一**的播放源：整集 HLS
    // 从头播到尾，不再「先流式出画、等 mp4 落盘再切源」。理由见 CHANGELOG 与
    // `media_enhance::start_video_cache`：整集转码实测 5.6 秒（92.7 秒正片，
    // 16 倍实时），而两段式的代价是用户明确抱怨的「前 8 秒转换后面再进入」。
    //
    // 旧实现在这里返回 mp4 会让前端拿到 `stream_kind = None`（文件形态），
    // 于是又走回「直连 mp4」那条老路 —— 那正是本次要退场的东西。
    //
    // 唯一例外：HLS 转码已经失败过、而盘上恰好有整集 mp4 时，由下面的错误分支
    // 兜底回它（见函数末尾的 `fallback_to_cached_mp4`），不在这里抢道。

    // 取播放直链：**全进程去重**。
    //
    // 这里曾经是「peek 缓存，未命中就自己跑一次 stream」。问题在于用户点播放时
    // 前端会**同时**发 `open_stream` 与 `resolve`，两条都走签名链路，而那是两次
    // App API 往返（固定 2.2 秒）的纯等待 —— 实测这段白跑一趟花了 3695ms。
    // `ensure_stream_cached` 让后到的那条读缓存（或在途等待），同一 vid 只签一次。
    let prefetched = peek_stream(&vid).is_some();
    let cached_stream = ensure_stream_cached(&app, &vid, profile).await?;
    let (source_url, decryption_key) =
        (cached_stream.url.clone(), cached_stream.content_key.clone());
    crate::trace::log(format!(
        "[红果] 流式开播 vid={vid} 预签名已命中={prefetched} 会话={session_id}"
    ));

    // 会话号必须落在 media_enhance 的地址空间里：stop(session_id) 由
    // playback_command 的 "stop" 分支统一调用，两处用同一个 id 才能被停掉。
    //
    // 用 `start_video_cache` 而不是 `start_with_key`：整集 HLS 现在**就是**播放源
    // （方案 B 不再切到 mp4），所以它必须按 vid 留存、换集不删、已转好则直接复用。
    // 多次打开同一集的代价因此从「重转 5.6 秒」降到「读一次清单」。
    let key = Some(decryption_key.as_str()).filter(|value| !value.is_empty());
    match crate::media_enhance::start_video_cache(session_id, &vid, &source_url, key).await {
        Ok(url) => {
            // 把这份产物的 mtime 推到当下：它是"最近被用过"的证据，也是缓存
            // 淘汰时唯一的保护（`keep` 只覆盖本次解析的那一个路径）。
            touch_cache_entry(&crate::media_enhance::video_cache_dir(&vid));
            Ok(ShortDramaAppPlayback {
                play_url: url,
                width: cached_stream.width,
                height: cached_stream.height,
                size_bytes: 0,
                // 流转码产物：调用方按 HLS 挂载，不再等任何"整集文件"。
                cached: false,
                stream_kind: Some("hls".to_owned()),
                backup_url: Some(source_url),
                // **源片真实总时长**：这是「时长固定」的全部依据。
                //
                // 边转边播时浏览器算不出总时长（分片清单还没 ENDLIST），前端只能退回
                // `seekable`/`buffered` 末尾，而那两个值随转码进度增长 —— 用户看到的
                // 时长会一路往上跳。这里把 worker 已经返回的 `duration_ms` 交下去，
                // 前端以它为权威，时长从此不随转码进度变。
                duration_ms: Some(cached_stream.duration_ms).filter(|value| *value > 0),
            })
        }
        Err(error) => {
            crate::trace::log(format!("[红果] 整集 HLS 未启动：{error}"));
            // 回退顺序：盘上已有整集 mp4 → 用它（旧链路产物，仍可播）；否则报错，
            // 由前端退到公开直链兜底。方案 B 删掉了"等 mp4 再切源"，但**不能**
            // 删掉"HLS 起不来时还有一个能播的东西" —— 那是单源架构唯一的保险。
            if let Some(playback) = cached_full_mp4(&vid, &profile) {
                crate::trace::log(format!("[红果] 整集 HLS 失败，回退已缓存的 mp4 vid={vid}"));
                return Ok(playback);
            }
            Err(format!("整集转码未启动：{error}"))
        }
    }
}

/// **预转下一集的整集 HLS**（用户需求：集与集之间无缝切换）。
///
/// 语义：后台把某一集转好放进 `vid-{vid}` 目录，**不占播放会话、不返回地址**。
/// 等用户真的连播/点开那一集时，`short_drama_app_open_stream` 命中
/// `#EXT-X-ENDLIST` 直接复用 —— 切换不需要任何等待。
///
/// 为什么值得单独做一条命令：一集正片 50–140 秒，而整集转码只要 5.6 秒
/// （实测 92.7 秒正片）。上一集播放期间完全来得及备好下一集，用户却仍在为
/// "播完才开始加载"等 6–11 秒 —— 那段等待本来可以完全不存在。
///
/// 失败一律静默（只记日志）：预转是纯优化，失败时用户走的就是"现场转"那条路。
#[tauri::command]
pub async fn short_drama_app_prewarm_stream<R: Runtime>(
    app: AppHandle<R>,
    input: ShortDramaAppResolveInput,
) -> Result<(), String> {
    let vid = input.vid.trim().to_owned();
    if vid.is_empty() || !vid.chars().all(|c| c.is_ascii_digit()) {
        return Err("缺少有效的集 vid。".into());
    }
    // VSR 开关关闭时不预转：那条链路的产物形态是 H.264 HLS，属于增强链路。
    if !crate::vsr_is_enabled() {
        return Ok(());
    }
    let profile = HongguoAppProfile::from_input(input.content_type, input.app_id)?;
    // 直链复用同一份缓存：预转与播放共用 `ensure_stream_cached`，
    // 因此这里不会又多跑一次签名。
    let cached = ensure_stream_cached(&app, &vid, profile).await?;
    let key = Some(cached.content_key.as_str()).filter(|value| !value.is_empty());
    // 槽位号取一个远离播放会话号的大数段：播放会话从 100 起递增，
    // 而这里用它只是为了让预转任务在 jobs 表中有个不冲突的键。
    let slot = PREWARM_SESSION_BASE + (stable_slot_of(&vid) % 4096);
    // fire-and-forget：预转是后台行为，不能让调用方等它转完（那就成了同步等待）。
    let source_url = cached.url.clone();
    let key_owned = key.map(str::to_owned);
    let vid_owned = vid.clone();
    tauri::async_runtime::spawn(async move {
        crate::media_enhance::prewarm_video_cache(
            &vid_owned,
            &source_url,
            key_owned.as_deref(),
            slot,
        )
        .await;
    });
    Ok(())
}

/// 预转任务的槽位起点。取一个远离播放会话号（从 100 递增）的区段，避免撞号。
const PREWARM_SESSION_BASE: u64 = 1_000_000;

/// 由 vid 派生一个稳定的槽位偏移。
///
/// 同一集每次预转都用同一个槽位，于是「重复预转」会被 `start_in_directory` 的
/// 同号替换逻辑天然去重；不同集则落到不同槽位，可以各自排队。
fn stable_slot_of(vid: &str) -> u64 {
    // 简单 FNV-1a：只要稳定且分布均匀，不需要密码学强度。
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in vid.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}
/// 盘上是否有现成的整集 mp4（旧链路的产物）。有就返回文件形态的结果。
///
/// 这是方案 B 的**唯一退路**：整集 HLS 起不来（ffmpeg 缺失、源地址过期、显卡编码
/// 崩掉）时，至少让用户还能播一个已经下好的文件，而不是直接黑屏。
///
/// 寻址与 `resolve` 主线同构，含旧版本直接写在缓存根目录下的副本。
fn cached_full_mp4(vid: &str, profile: &HongguoAppProfile) -> Option<ShortDramaAppPlayback> {
    let namespace_path = cache_dir()
        .join(profile.cache_namespace)
        .join(format!("{vid}.mp4"));
    let legacy_path = cache_dir().join(format!("{vid}.mp4"));
    let path = std::iter::once(namespace_path)
        .chain(std::iter::once(legacy_path))
        .find(|path| {
            path.is_file() && path.metadata().map(|meta| meta.len() > 0).unwrap_or(false)
        })?;
    touch_cache_entry(&path);
    Some(ShortDramaAppPlayback {
        play_url: path.to_string_lossy().to_string(),
        width: 0,
        height: 0,
        size_bytes: path.metadata().map(|meta| meta.len()).unwrap_or(0),
        cached: true,
        stream_kind: None,
        backup_url: None,
        duration_ms: None,
    })
}
/// 锁定集秒开：签名取回加密直链 + CENC 密钥，交给 libmpv 流播（不落盘）。
#[tauri::command]
pub async fn short_drama_app_stream<R: Runtime>(
    app: AppHandle<R>,
    input: ShortDramaAppStreamInput,
) -> Result<ShortDramaAppStream, String> {
    let vid = input.vid.trim().to_owned();
    if vid.is_empty() || !vid.chars().all(|c| c.is_ascii_digit()) {
        return Err("缺少有效的集 vid。".into());
    }
    let profile = HongguoAppProfile::from_input(input.content_type, input.app_id)?;
    let payload = run_worker_subcommand(&app, "stream", &vid, "stream", profile).await?;
    let url = payload
        .get("url")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    if url.is_empty() {
        return Err("云端直链为空，请回退到完整解析。".into());
    }
    let width = payload
        .get("width")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0) as u32;
    let height = payload
        .get("height")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0) as u32;
    let variants = payload
        .get("variants")
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| {
                    let url = value.get("url").and_then(serde_json::Value::as_str)?.trim();
                    if url.is_empty() {
                        return None;
                    }
                    // 高度夹在 1-4320（与果果 parsePlaybackQuality 的清晰度范围
                    // 一致）：异常档位（worker 解析出 0 或超高分）不进画质菜单。
                    let height = value
                        .get("height")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0)
                        .min(4320);
                    if height == 0 {
                        return None;
                    }
                    Some(ShortDramaAppVariant {
                        id: value
                            .get("id")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        label: value
                            .get("label")
                            .and_then(serde_json::Value::as_str)
                            .filter(|label| !label.trim().is_empty())
                            .unwrap_or("原始画质")
                            .to_owned(),
                        url: url.to_owned(),
                        decryption_key: value
                            .get("content_key")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        width: value
                            .get("width")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(0)
                            .min(8640) as u32,
                        height: height as u32,
                        bitrate: value
                            .get("bitrate")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(0),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let variants = if variants.is_empty() {
        vec![ShortDramaAppVariant {
            id: "default".to_owned(),
            label: if height > 0 {
                format!("{height}P")
            } else {
                "最高".to_owned()
            },
            url: url.clone(),
            decryption_key: payload
                .get("content_key")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            width,
            height,
            bitrate: 0,
        }]
    } else {
        variants
    };
    Ok(ShortDramaAppStream {
        url,
        decryption_key: payload
            .get("content_key")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_owned(),
        width,
        height,
        download_ua: payload
            .get("download_ua")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("com.phoenix.read/71332")
            .to_owned(),
        download_referer: payload
            .get("download_referer")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("https://novel.snssdk.com/")
            .to_owned(),
        variants,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortDramaAppAlbumInput {
    pub series_id: String,
    #[serde(default)]
    pub content_type: Option<u16>,
    #[serde(default)]
    pub app_id: Option<u32>,
}

/// 专辑详情：全集 vid 顺序 + 真实锁定态（修正官网“前 N 集”的粗粒度徽标）。
#[tauri::command]
pub async fn short_drama_app_album<R: Runtime>(
    app: AppHandle<R>,
    input: ShortDramaAppAlbumInput,
) -> Result<ShortDramaAppAlbum, String> {
    let series_id = input.series_id.trim().to_owned();
    if series_id.is_empty() || !series_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("缺少有效的剧集 ID。".into());
    }
    let profile = HongguoAppProfile::from_input(input.content_type, input.app_id)?;
    let payload = run_worker_subcommand(&app, "album", &series_id, "album", profile).await?;
    let episodes = payload
        .get("episodes")
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| {
                    let vid = value.get("vid").and_then(serde_json::Value::as_str)?;
                    Some(ShortDramaAppEpisode {
                        vid: vid.to_owned(),
                        index: value
                            .get("index")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(0) as u32,
                        title: value
                            .get("title")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        locked: value
                            .get("locked")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false),
                        disabled: value
                            .get("disabled")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false),
                        duration_seconds: value
                            .get("duration_seconds")
                            .and_then(serde_json::Value::as_f64)
                            .unwrap_or(0.0),
                        cover: value
                            .get("cover")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if episodes.is_empty() {
        return Err("专辑详情没有分集信息。".into());
    }
    Ok(ShortDramaAppAlbum {
        series_id,
        title: payload
            .get("title")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        cover: payload
            .get("cover")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        intro: payload
            .get("intro")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        total: payload
            .get("total")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(episodes.len() as u64) as u32,
        episodes,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        cover_to_data_url, marker_content_is_h264, normalize_cache_budget_mb,
        normalize_requested_quality, HongguoAppProfile,
    };
    use base64::Engine;

    // 只有内容为 h264 的 sidecar 才算「已迁移」。
    //
    // 回归用例：旧实现让「关掉 VSR」这条分支也写 h264，于是在关着开关时看过一集
    // HEVC 旧缓存之后，重新打开 VSR 会被只判「文件存在」的旧逻辑放行 —— HEVC 文件
    // 照原样播出去，视觉增强静默失效（不变量 25：VSR 的硬条件是 H.264）。
    // 现在关闭分支写的是 skip，必须被这里判成「未迁移」，从而触发真正的转码。
    #[test]
    fn h264_marker_content_decides_migration_state() {
        let dir = std::env::temp_dir().join(format!("ttv-marker-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let marker = dir.join("probe.mp4.h264");

        // 真正的转码产物标记。
        std::fs::write(&marker, b"h264\n").unwrap();
        assert!(marker_content_is_h264(&marker));

        // 用户关着 VSR 时跳过的标记：不能被当成已迁移。
        std::fs::write(&marker, b"skip\n").unwrap();
        assert!(!marker_content_is_h264(&marker));

        // 空文件 / 损坏内容同样不算。
        std::fs::write(&marker, b"").unwrap();
        assert!(!marker_content_is_h264(&marker));

        // 标记不存在（从未迁移）也必须为 false，而不是让调用方 panic。
        let _ = std::fs::remove_file(&marker);
        assert!(!marker_content_is_h264(&marker));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cache_budget_defaults_and_clamps_user_values() {
        assert_eq!(normalize_cache_budget_mb(0.0), 1024);
        assert_eq!(normalize_cache_budget_mb(f64::NAN), 1024);
        assert_eq!(normalize_cache_budget_mb(128.0), 256);
        assert_eq!(normalize_cache_budget_mb(2048.0), 2048);
        assert_eq!(normalize_cache_budget_mb(999_999.0), 16_384);
    }

    #[test]
    fn reads_device_token_aliases_from_credentials_json() {
        let value = serde_json::json!({
            "deviceId": "111",
            "install_id": "222",
            "x-tt-dt": "token-from-server",
            "cdid": "cdid-1"
        });
        assert_eq!(
            super::json_string_field(&value, &["deviceId", "device_id"]),
            "111"
        );
        assert_eq!(
            super::json_string_field(&value, &["installId", "install_id"]),
            "222"
        );
        assert_eq!(
            super::json_string_field(&value, &["deviceToken", "x-tt-dt", "x_tt_dt"]),
            "token-from-server"
        );
        assert_eq!(
            super::explain_hongguo_api_error("worker stream 失败：111104 SERVICE_ERROR"),
            "红果设备身份无效（111104）。当前会话未被服务端接受，请稍后重试或改用网页直链。"
        );
    }

    #[test]
    fn generates_local_device_ids_without_token() {
        let first = super::generate_credentials();
        let second = super::generate_credentials();
        assert_eq!(first.device_id.len(), 19);
        assert!(first.device_id.chars().all(|c| c.is_ascii_digit()));
        assert!(first.install_id.chars().all(|c| c.is_ascii_digit()));
        assert_ne!(first.device_id, first.install_id);
        assert_ne!(first.device_id, second.device_id);
        assert!(first.device_token.is_empty());
        assert_eq!(first.cdid.len(), 36);
        assert_eq!(first.openudid.len(), 16);
    }

    #[test]
    fn matches_confirmed_hongguo_content_profiles() {
        let short = HongguoAppProfile::from_input(Some(1), Some(8662)).unwrap();
        assert_eq!(short.app_id, 8662);
        assert_eq!(short.cache_namespace, "short-series");

        let comic = HongguoAppProfile::from_input(Some(1004), Some(8662)).unwrap();
        assert_eq!(comic.app_id, 8662);
        assert_eq!(comic.cache_namespace, "motion-comic");

        assert!(HongguoAppProfile::from_input(Some(1), Some(8704)).is_err());
        assert!(HongguoAppProfile::from_input(Some(1004), Some(8704)).is_err());
        assert!(HongguoAppProfile::from_input(Some(999), None).is_err());
        assert!(HongguoAppProfile::from_input(Some(999), None).is_err());
    }

    #[test]
    fn masks_device_id_without_leaking_full_value() {
        assert_eq!(super::mask_device_id("1234567890"), "…7890");
        assert_eq!(super::mask_device_id("12"), "****");
    }

    /// 临时目录夹具：创建后写若干文件并把部分文件的 mtime 调老。
    struct CacheFixture {
        dir: std::path::PathBuf,
    }

    impl CacheFixture {
        fn new(tag: &str) -> Self {
            let unique = std::time::SystemTime::now()
                .duration_since(std::time::SystemTime::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!("ttv-cache-{tag}-{unique}"));
            std::fs::create_dir_all(&dir).expect("create fixture dir");
            Self { dir }
        }

        fn write(&self, name: &str, bytes: usize, age_secs: u64) -> std::path::PathBuf {
            let path = self.dir.join(name);
            std::fs::write(&path, vec![b'x'; bytes]).expect("write fixture");
            if age_secs > 0 {
                age_file(&path, age_secs);
            }
            path
        }

        /// 建一个 HLS 会话目录：`index.m3u8` + `init.mp4` + 若干 `seg-*.m4s`。
        ///
        /// `age_secs` 施加在**全部**文件上 —— `directory_usage` 取最新的 mtime，
        /// 所以只有全部调老，这个目录才会被当成「很久没用过」。
        fn write_hls_dir(&self, name: &str, seg_bytes: usize, age_secs: u64) -> std::path::PathBuf {
            let dir = self.dir.join(name);
            std::fs::create_dir_all(&dir).expect("create hls dir");
            std::fs::write(dir.join("index.m3u8"), b"#EXTM3U\n#EXT-X-ENDLIST\n").expect("m3u8");
            std::fs::write(dir.join("init.mp4"), vec![b'i'; 16]).expect("init");
            std::fs::write(dir.join("seg-00000.m4s"), vec![b's'; seg_bytes]).expect("seg");
            std::fs::write(dir.join("seg-00001.m4s"), vec![b's'; seg_bytes]).expect("seg2");
            if age_secs > 0 {
                for entry in std::fs::read_dir(&dir).expect("read hls dir").flatten() {
                    age_file(&entry.path(), age_secs);
                }
            }
            dir
        }
    }

    /// 把一个文件的 mtime 调到 `age_secs` 秒之前。
    fn age_file(path: &std::path::Path, age_secs: u64) {
        let stamp = std::time::SystemTime::now() - std::time::Duration::from_secs(age_secs);
        std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .expect("open fixture")
            .set_modified(stamp)
            .expect("age fixture");
    }

    impl Drop for CacheFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// 回归：预算超限时，淘汰的是**最旧**的文件，新文件与 keep 必须存活。
    ///
    /// 旧实现用 atime 当 LRU 键，但 Windows 默认 `DisableLastAccess=1`
    /// （本机 fsutil 实测确认：读取文件后 atime 完全不变），atime 恒等于
    /// 创建时间，排序退化后会删掉**正在播放**的那一集——表现为播放中途报错、
    /// 刚看过的剧集下次又要重新整集下载。
    #[test]
    fn eviction_removes_oldest_and_protects_recent() {
        let fx = CacheFixture::new("evict");
        // 两个陈旧文件（远超宽限期）与一个刚写入的新文件，各 100 字节。
        let oldest = fx.write("111.mp4", 100, 7200);
        let older = fx.write("222.mp4", 100, 3600);
        let fresh = fx.write("333.mp4", 100, 0);

        // 预算 250 字节：总量 300，必须淘汰到只剩 2 个。
        // 保留期设为 7 天，因此 2 小时/1 小时的文件不算过期，走 LRU 分支。
        let report = super::evict_channels_to_budget(
            std::slice::from_ref(&fx.dir),
            &fresh,
            250,
            7 * 24 * 3600,
            std::time::SystemTime::now(),
        );

        assert!(!oldest.exists(), "最旧的文件应当被淘汰");
        assert!(fresh.exists(), "刚写入的文件在宽限期内，不得被淘汰");
        // 淘汰顺序必须是"先最旧"，因此 older 应比 oldest 更可能存活。
        assert!(older.exists(), "次旧文件在淘汰一个后应仍存活");
        assert_eq!(fresh.metadata().expect("stat").len(), 100);
        assert_eq!(report.removed_files, 1);
        assert_eq!(report.freed_bytes, 100);
    }

    /// 回归：整集 HLS 的会话**目录**必须与整集 mp4 一起参与预算，且按整目录淘汰。
    ///
    /// 为什么这条必须有：方案 B 之后整集 HLS 是唯一播放源，每集约 58MB（实测
    /// 92.7 秒正片）。旧实现 `evict_channels_to_budget` 只认 `.mp4` 文件、`rtx-vsr/`
    /// 也不在白名单里，于是那批产物完全在用户预算之外 —— 看一集多占 58MB，
    /// 而设置页显示的上限「形同虚设」。
    #[test]
    fn eviction_counts_hls_directories_as_one_entry() {
        let fx = CacheFixture::new("hlsdir");
        // 一个陈旧 HLS 目录（两个分片各 200 字节 + 清单/init，共约 400+ 字节）
        // 与一个刚写入的小 mp4。
        let old_dir = fx.write_hls_dir("vid-111", 200, 7200);
        let fresh_file = fx.write("222.mp4", 50, 0);

        // 预算 100 字节：目录被计价后必然超限，且它是唯一可淘汰项。
        let report = super::evict_channels_to_budget(
            std::slice::from_ref(&fx.dir),
            &fresh_file,
            100,
            7 * 24 * 3600,
            std::time::SystemTime::now(),
        );

        assert!(
            !old_dir.exists(),
            "HLS 会话目录必须被整体淘汰（只删分片会留下指向空分片的清单）"
        );
        assert!(fresh_file.exists(), "宽限期内的新文件不该被删");
        assert_eq!(report.removed_files, 1, "目录算一个条目，不是四个");
    }

    /// 回归：目录的 LRU 键取**最新** mtime —— 正在转码的目录不会被误淘汰。
    ///
    /// 整集 HLS 在转码期间不断写新分片，而 `init.mp4` 是最早写的。若用最旧 mtime
    /// 当键，「正在写」的目录会被算成很久没碰过，刚转出来的产物可能立刻被自己删掉。
    #[test]
    fn hls_directory_lru_uses_newest_mtime() {
        let fx = CacheFixture::new("hlsnew");
        // 目录里混一个新文件（模拟"正在写"）与几个老文件。
        let active_dir = fx.write_hls_dir("vid-active", 200, 7200);
        age_file(&active_dir.join("seg-00001.m4s"), 0);

        let (_, stamp) = super::directory_usage(&active_dir);
        let age = std::time::SystemTime::now()
            .duration_since(stamp)
            .map(|delta| delta.as_secs())
            .unwrap_or(u64::MAX);
        assert!(
            age < 60,
            "目录 mtime 应取最新（实测 {age}s 前），否则正在转码的目录会被误判为陈旧"
        );
    }

    /// 回归：即便在预算内，keep 指向的文件也绝不能被删。
    #[test]
    fn eviction_never_deletes_keep() {
        let fx = CacheFixture::new("keep");
        let keep = fx.write("999.mp4", 100, 7200); // 故意做得很旧
        fx.write("888.mp4", 100, 7200);

        // 预算极低：必须淘汰，但 keep 必须豁免。
        super::evict_channels_to_budget(
            std::slice::from_ref(&fx.dir),
            &keep,
            0,
            7 * 24 * 3600,
            std::time::SystemTime::now(),
        );

        assert!(
            keep.exists(),
            "keep 指向的文件被删除，会导致刚下载完就自我销毁"
        );
    }

    /// 回归：宽限期内的文件即使超预算也不淘汰（保护正在下载/播放的整集）。
    #[test]
    fn eviction_respects_grace_period() {
        let fx = CacheFixture::new("grace");
        let recent_a = fx.write("aaa.mp4", 100, 0);
        let recent_b = fx.write("bbb.mp4", 100, 10);

        // 预算 0：若没有宽限期，两者都会被删。
        super::evict_channels_to_budget(
            std::slice::from_ref(&fx.dir),
            &recent_a,
            0,
            7 * 24 * 3600,
            std::time::SystemTime::now(),
        );

        assert!(recent_a.exists(), "宽限期内的文件不得被淘汰");
        assert!(recent_b.exists(), "宽限期内的文件不得被淘汰");
    }

    /// 预算足够时不做任何删除。
    #[test]
    fn eviction_is_noop_within_budget() {
        let fx = CacheFixture::new("noop");
        let old = fx.write("555.mp4", 100, 7200);
        let keep = fx.write("666.mp4", 100, 7200);

        let report = super::evict_channels_to_budget(
            std::slice::from_ref(&fx.dir),
            &keep,
            1024 * 1024,
            7 * 24 * 3600,
            std::time::SystemTime::now(),
        );

        assert!(old.exists());
        assert!(keep.exists());
        assert_eq!(report.removed_files, 0);
    }

    /// 新增能力：超过保留期的整集即使没超预算也会被自动清掉。
    ///
    /// 这是"占空间不会无限增长"的时间维度兜底——否则用户看过的零散剧集
    /// 只要总量没到预算就一直留着。
    #[test]
    fn eviction_removes_expired_episodes() {
        let fx = CacheFixture::new("expire");
        // 8 天前（超过 7 天保留期）与 1 小时前。
        let expired = fx.write("old.mp4", 100, 8 * 24 * 3600);
        let recent = fx.write("new.mp4", 100, 3600);

        // 预算给得很大：只有"过期"这一条能触发删除。
        let report = super::evict_channels_to_budget(
            std::slice::from_ref(&fx.dir),
            &fx.dir.join("__none__"),
            1024 * 1024 * 1024,
            7 * 24 * 3600,
            std::time::SystemTime::now(),
        );

        assert!(!expired.exists(), "超过保留期的整集应被自动清理");
        assert!(recent.exists(), "保留期内的整集不得被清理");
        assert_eq!(report.removed_files, 1);
    }

    /// 新增能力：短剧与漫剧共享同一份预算（而非各自独立）。
    ///
    /// 旧实现按频道分别限制，两个频道合计可长到 3GB；实测本机已达 2.25GB。
    #[test]
    fn budget_is_shared_across_channels() {
        let fx = CacheFixture::new("shared");
        let drama_dir = fx.dir.join("short-series");
        let comic_dir = fx.dir.join("motion-comic");
        std::fs::create_dir_all(&drama_dir).expect("mkdir");
        std::fs::create_dir_all(&comic_dir).expect("mkdir");

        // 每个频道各写两个 100 字节的陈旧文件：合计 400 字节。
        let mut paths = Vec::new();
        for (dir, prefix) in [(&drama_dir, "d"), (&comic_dir, "c")] {
            for i in 0..2 {
                let p = dir.join(format!("{prefix}{i}.mp4"));
                std::fs::write(&p, vec![b'x'; 100]).expect("write");
                let stamp = std::time::SystemTime::now() - std::time::Duration::from_secs(7200);
                std::fs::OpenOptions::new()
                    .write(true)
                    .open(&p)
                    .expect("open")
                    .set_modified(stamp)
                    .expect("age");
                paths.push(p);
            }
        }

        // 预算 250 字节（小于合计 400）：必须跨频道淘汰到预算内。
        let report = super::evict_channels_to_budget(
            &[drama_dir.clone(), comic_dir.clone()],
            &fx.dir.join("__none__"),
            250,
            7 * 24 * 3600,
            std::time::SystemTime::now(),
        );

        let remaining: u64 = paths
            .iter()
            .filter(|p| p.exists())
            .map(|p| p.metadata().expect("stat").len())
            .sum();
        assert!(
            remaining <= 250,
            "跨频道合计应被压回预算内，实际剩余 {remaining} 字节"
        );
        assert_eq!(
            report.removed_files, 2,
            "400 - 250 需淘汰 2 个 100 字节文件"
        );
    }
    #[test]
    fn normalizes_requested_quality_into_worker_literals() {
        // 固定档位（历史取值）必须保持原样。
        assert_eq!(normalize_requested_quality("auto"), "auto");
        assert_eq!(normalize_requested_quality(""), "auto");
        assert_eq!(normalize_requested_quality("4k"), "4k");
        assert_eq!(normalize_requested_quality("1080p"), "1080p");
        assert_eq!(normalize_requested_quality("720p"), "720p");
        // 前端画质菜单报的是源流真实高度：带 p 与不带 p 都要落到 {digits}p，
        // 否则真实档位会被静默降级成 auto（表现成画质轴点了没反应）。
        assert_eq!(normalize_requested_quality("1080"), "1080p");
        assert_eq!(normalize_requested_quality("2160"), "4k");
        assert_eq!(normalize_requested_quality("540p"), "540p");
        assert_eq!(normalize_requested_quality("360P"), "360p");
        assert_eq!(normalize_requested_quality(" 1080P "), "1080p");
        // 认不出来的串退回 auto，而不是去打一个并不存在的档位。
        assert_eq!(normalize_requested_quality("高清"), "auto");
    }

    /// 联网冒烟：真去拉一张红果封面，走完"下载 → 识别 HEIC → ffmpeg 转码 → data URL"。
    ///
    /// 默认不跑（`#[ignore]`），因为它依赖网络与随包 ffmpeg，不适合放进 CI 的
    /// 纯逻辑单测。跑法：
    /// `cargo test --bins -- --ignored cover_proxy --nocapture`
    ///
    /// 存在的意义：`cover_to_data_url` 里任何一步坏掉（域名白名单、HEIC 识别、
    /// ffmpeg 参数、base64），前端只会表现为"海报又变成空白占位"，看不出原因；
    /// 这条测试把整条链路的失败点直接打印出来。
    #[test]
    #[ignore = "需要联网与随包 ffmpeg"]
    fn cover_proxy_converts_real_heic_into_jpeg_data_url() {
        // 这张地址来自红果榜单实测返回（HEIC，400px 宽模板）。
        const URL: &str = "https://p3-reading-sign.fqnovelpic.com/novel-pic/98484d0e3cf06d85d2d29712d0465a5f~tplv-81nmtwyey9-superreso-aifit:400:0.heic?lk3s=64477e16&x-expires=1796531569&x-signature=z69dWJ7phEinpeez2diQeyx%2BPXQ%3D";
        let cache_dir = std::env::temp_dir().join("ttv-cover-proxy-test");
        let _ = std::fs::remove_dir_all(&cache_dir);
        let runtime = tokio::runtime::Runtime::new().expect("tokio 运行时");
        let data_url = runtime
            .block_on(cover_to_data_url(URL, &cache_dir))
            .expect("封面代理应当成功");
        println!("data URL 长度 = {}", data_url.len());
        assert!(
            data_url.starts_with("data:image/jpeg;base64,"),
            "前缀不对：{}",
            &data_url[..40.min(data_url.len())]
        );
        let encoded = data_url.trim_start_matches("data:image/jpeg;base64,");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("base64 应当可解");
        // JPEG 的 SOI 标记，说明 ffmpeg 真的产出了图而不是把 HEIC 原样塞回来。
        assert_eq!(&decoded[..3], &[0xFF, 0xD8, 0xFF], "转码结果不是 JPEG");
        println!("转码后 JPEG 字节数 = {}", decoded.len());
        let _ = std::fs::remove_dir_all(&cache_dir);
    }
}
