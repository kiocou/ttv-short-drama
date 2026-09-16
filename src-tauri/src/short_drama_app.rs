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

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime};

/// 进度事件名（stage: sign/model/fallback/download/transcode/done）。
pub const RESOLVE_EVENT: &str = "shortdrama://app-resolve";
const WORKER_TIMEOUT: Duration = Duration::from_secs(300);
/// stream/album 只签名取模型，不必等整集下载；卡死时尽快回退网页直链。
const STREAM_WORKER_TIMEOUT: Duration = Duration::from_secs(25);

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
    /// 兼容旧前端调用签名。真实清晰度已归一为单一源流，此字段不再参与
    /// 缓存寻址（避免产生 {vid}-4k.mp4 这类重复副本）。
    #[serde(default)]
    #[allow(dead_code)]
    pub quality: Option<String>,
    #[serde(default)]
    pub content_type: Option<u16>,
    #[serde(default)]
    pub app_id: Option<u32>,
}

/// 红果两个客户端共用播放器接口，但请求模型和 aid 不同。
/// 仅接受 APK 逆向已确认的短剧/漫剧内容类型，避免前端传入任意模型值。
#[derive(Debug, Clone, Copy)]
struct HongguoAppProfile {
    content_type: u16,
    app_id: u32,
    cache_namespace: &'static str,
}

impl HongguoAppProfile {
    fn from_input(content_type: Option<u16>, app_id: Option<u32>) -> Result<Self, String> {
        let content_type = content_type.unwrap_or(1);
        let profile = match content_type {
            1 => Self {
                content_type,
                app_id: 8662,
                cache_namespace: "short-series",
            },
            1004 | 1007 => Self {
                content_type,
                app_id: 8704,
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

fn cache_dir() -> PathBuf {
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
        // 幻影清晰度副本：{数字}-{quality}.mp4，其中 quality 非空且不含数字开头。
        let is_phantom_quality = name.ends_with(".mp4")
            && !name.ends_with(".part.mp4")
            && name
                .strip_suffix(".mp4")
                .and_then(|stem| stem.split_once('-'))
                .map(|(vid, quality)| {
                    !vid.is_empty()
                        && vid.chars().all(|c| c.is_ascii_digit())
                        && !quality.is_empty()
                })
                .unwrap_or(false);
        // 幻影清晰度副本是旧版遗留（`{vid}-4k.mp4` 之类），新代码不会再产生，
        // 不存在并发写入，可以直接删。
        // 半成品则必须过了门槛才删；mtime 读不到时按"正在写"处理，保守不删。
        let partial_is_stale = is_partial
            && entry
                .metadata()
                .ok()
                .and_then(|meta| meta.modified().ok())
                .and_then(|mtime| now.duration_since(mtime).ok())
                .map(|age| age >= stale_after)
                .unwrap_or(false);
        if partial_is_stale || is_phantom_quality {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// 缓存**全局**预算（字节），短剧 + 漫剧合计。
///
/// 为什么从"单频道 1.5GB"改成"全局 1.0GB"：旧预算按频道独立计算，两个频道
/// 各自都能长到 1.5GB，实际占用上限是 3GB——实测本机已达到 2.25GB（216 个文件）。
/// 对一款短剧播放器来说这个体积明显偏大，且用户无法感知它为何一直增长。
/// 现在改成全局合计 1.0GB，并由启动清理与每次解析后的自动收敛共同保证。
const CACHE_BUDGET_BYTES: u64 = 1024 * 1024 * 1024;

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
    if let Ok(file) = std::fs::OpenOptions::new().write(true).open(path) {
        let _ = file.set_modified(std::time::SystemTime::now());
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
    // 跨频道统一收敛：短剧与漫剧共享同一份预算。
    evict_channels_to_budget(
        &[
            cache_dir().join("short-series"),
            cache_dir().join("motion-comic"),
        ],
        keep,
        CACHE_BUDGET_BYTES,
        CACHE_MAX_AGE_SECONDS,
        std::time::SystemTime::now(),
    );
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
    let mut files: Vec<(std::path::PathBuf, u64, std::time::SystemTime)> = Vec::new();
    let mut total: u64 = 0;
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
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
            files.push((path, size, stamp));
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
    for (path, size, stamp) in &files {
        if is_protected(path, *stamp) {
            continue;
        }
        let expired = now
            .duration_since(*stamp)
            .map(|age| age > max_age)
            .unwrap_or(false);
        if expired && std::fs::remove_file(path).is_ok() {
            total = total.saturating_sub(*size);
            report.removed_files += 1;
            report.freed_bytes = report.freed_bytes.saturating_add(*size);
        }
    }

    // 第二步：超量清理（LRU）。
    if total > budget_bytes {
        let mut survivors: Vec<&(std::path::PathBuf, u64, std::time::SystemTime)> =
            files.iter().filter(|(path, _, _)| path.exists()).collect();
        survivors.sort_by_key(|(_, _, stamp)| *stamp);
        for (path, size, stamp) in survivors {
            if total <= budget_bytes {
                break;
            }
            if is_protected(path, *stamp) {
                continue;
            }
            if std::fs::remove_file(path).is_ok() {
                total = total.saturating_sub(*size);
                report.removed_files += 1;
                report.freed_bytes = report.freed_bytes.saturating_add(*size);
            }
        }
    }

    report
}

/// 统计当前缓存占用（短剧 + 漫剧合计）。
pub fn cache_usage() -> CacheSweepReport {
    let mut total: u64 = 0;
    let mut count: u64 = 0;
    for dir in [
        cache_dir().join("short-series"),
        cache_dir().join("motion-comic"),
    ] {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
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
    // keep 指向一个不可能存在的路径：启动时没有任何"正在写入"的剧集。
    let sentinel = root.join("__none__");
    evict_channels_to_budget(
        &[root.join("short-series"), root.join("motion-comic")],
        &sentinel,
        CACHE_BUDGET_BYTES,
        CACHE_MAX_AGE_SECONDS,
        std::time::SystemTime::now(),
    )
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
    // 清晰度归一：源流实际只有有限档位，"4k/1080p/720p" 这类前端档位并不存在。
    // 之前按清晰度拼缓存文件名，导致同一集被反复下载（4k 与 auto 产物字节数
    // 完全相同，纯属重复下载）。这里把所有请求统一归一到 auto 这一条真实路径，
    // 不再产生 `{vid}-4k.mp4` / `{vid}-1080p.mp4` 这类幻影副本。
    let requested_quality = "auto";
    let (python, worker, ffmpeg) = worker_paths()?;
    let credentials = ensure_credentials()?;

    let namespace_path = cache_dir()
        .join(profile.cache_namespace)
        .join(format!("{vid}.mp4"));
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
        })
    };
    if out_path.is_file()
        && out_path
            .metadata()
            .map(|meta| meta.len() > 0)
            .unwrap_or(false)
    {
        return cached_payload(&out_path);
    }
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("创建缓存目录失败：{error}"))?;
    }
    // 缓存卫生：清理上次异常退出留下的半成品与幻影清晰度副本。
    // - `*.part.mp4` / `*.source.tmp` 是 worker 中断的残留，永远不会被任何路径
    //   读取，只会占盘（实测残留过 0 字节的 xxx-1080p.mp4.part.mp4）。
    // - `{vid}-{quality}.mp4` 是旧版按清晰度拼文件的产物，现已统一到 `{vid}.mp4`，
    //   保留只会白占空间。
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
            break; // 本请求为 leader，跑 worker
        }
        // follower：轮询缓存等 leader 落盘，或等 leader 摘除表项后接管。
        follower_waited += 1;
        let deadline = tokio::time::Instant::now()
            + if follower_waited <= 2 {
                WORKER_TIMEOUT + Duration::from_secs(15)
            } else {
                // 两轮等待（630s+）仍无产物属于极端场景：直接抢 leader 重跑。
                Duration::from_secs(0)
            };
        while tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(500)).await;
            if out_path.is_file()
                && out_path
                    .metadata()
                    .map(|meta| meta.len() > 0)
                    .unwrap_or(false)
            {
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
    let had_prefetched = peek_stream(&vid).is_some();
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
            requested_quality,
            out_path.clone(),
        )
        .await;
        if outcome.is_ok() || !had_prefetched || attempt >= 2 {
            break outcome;
        }
        clear_stream(&vid);
    };
    // 无论成败都摘除 leader 位：follower 读到产物则返回，否则自行接管重跑。
    {
        let map = resolve_inflight();
        if let Ok(mut guard) = map.lock() {
            guard.remove(&inflight_key);
        }
    }
    result
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

    let mut command = tokio::process::Command::new(&python);
    command.arg(&worker).arg("resolve").arg(&vid);
    apply_hongguo_worker_env(&mut command, &credentials, profile);
    command.env("TTV_SD_QUALITY", requested_quality);
    // 命中预签名缓存时把直链与解密密钥直接交给 worker，跳过两次 App API 往返
    // （实测固定 2.16s）。直链过期会让 ffmpeg 拉流失败，调用方
    // short_drama_app_resolve 会在失败后清掉缓存并重跑一次。
    if let Some(cached) = peek_stream(&vid) {
        command
            .env("TTV_SD_DIRECT_URL", &cached.url)
            .env("TTV_SD_DIRECT_KEY", &cached.content_key)
            .env("TTV_SD_DIRECT_WIDTH", cached.width.to_string())
            .env("TTV_SD_DIRECT_HEIGHT", cached.height.to_string())
            .env("TTV_SD_DIRECT_DURATION", cached.duration_ms.to_string());
    }
    command
        .env("TTV_SD_FFMPEG", &ffmpeg)
        .env("TTV_SD_OUT", &out_path)
        .env("PYTHONNOUSERSITE", "1")
        .env("PYTHONIOENCODING", "utf-8")
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
        while let Ok(Some(line)) = lines.next_line().await {
            if collected.len() < 8000 {
                collected.push_str(&line);
                collected.push('\n');
            }
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
    comic: bool,
) -> Vec<SearchSuggestion> {
    let profile = match HongguoAppProfile::from_input(Some(if comic { 1004 } else { 1 }), None) {
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
                match run_worker_subcommand(&app_handle, "stream", &target, "prefetch", profile).await
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
    let (python, worker, _ffmpeg) = worker_paths()?;
    let credentials = ensure_credentials()?;

    let mut command = tokio::process::Command::new(&python);
    command.arg(&worker).arg(subcommand).arg(target);
    apply_hongguo_worker_env(&mut command, &credentials, profile);
    command
        .env("PYTHONNOUSERSITE", "1")
        .env("PYTHONIOENCODING", "utf-8")
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
                            .unwrap_or(0) as u32,
                        height: value
                            .get("height")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(0) as u32,
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
                            .unwrap_or(0) as u32,
                        height: value
                            .get("height")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(0) as u32,
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
    use super::HongguoAppProfile;

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

        let comic = HongguoAppProfile::from_input(Some(1004), Some(8704)).unwrap();
        assert_eq!(comic.app_id, 8704);
        assert_eq!(comic.cache_namespace, "motion-comic");

        assert!(HongguoAppProfile::from_input(Some(1), Some(8704)).is_err());
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
                let stamp = std::time::SystemTime::now() - std::time::Duration::from_secs(age_secs);
                std::fs::OpenOptions::new()
                    .write(true)
                    .open(&path)
                    .expect("open fixture")
                    .set_modified(stamp)
                    .expect("age fixture");
            }
            path
        }
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
}
