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
    if let Some(base) = dirs::data_local_dir() {
        return base.join("com.ttv.player");
    }
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".ttv-data")
}

fn device_config_path() -> PathBuf {
    data_dir().join("short-drama-device.json")
}

fn cache_dir() -> PathBuf {
    data_dir().join("short-drama-cache")
}

/// 与 runtime::discover_resource_dir 相同的候选顺序，但以 worker/python 的
/// 存在为判据（worker 目录随 bundle.resources 复制到可执行文件旁）。
fn resource_base() -> Option<PathBuf> {
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
fn sweep_cache_dir(dir: &std::path::Path) {
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
        if is_partial || is_phantom_quality {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// 单频道缓存预算（字节）。超出则按 LRU 淘汰最久未访问的整集。
/// 短剧单集约 5-15MB，1.5GB 约可容纳 120-300 集，够用且不至于失控。
const CACHE_BUDGET_BYTES: u64 = 1536 * 1024 * 1024;

/// 按 LRU 把频道缓存压回预算内。
///
/// `keep` 是本次即将写入/刚命中的那一集，绝不淘汰——否则会出现"刚下载完
/// 立刻被自己删掉"的荒谬情况。淘汰按访问时间升序（最旧优先），用文件的
/// atime 优先、退化到 mtime，因为播放走的是文件读取，atime 更贴近"最近播放"。
fn enforce_cache_budget(dir: &std::path::Path, keep: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::path::PathBuf, u64, std::time::SystemTime)> = Vec::new();
    let mut total: u64 = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        // 只统计正式整集缓存，半成品不计入预算（它们会被 sweep 清掉）。
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
        let stamp = meta
            .accessed()
            .or_else(|_| meta.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        total = total.saturating_add(size);
        files.push((path, size, stamp));
    }
    if total <= CACHE_BUDGET_BYTES {
        return;
    }
    files.sort_by_key(|(_, _, stamp)| *stamp);
    for (path, size, _) in files {
        if total <= CACHE_BUDGET_BYTES {
            break;
        }
        if path == keep {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
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
    let legacy_path = (requested_quality == "auto")
        .then(|| cache_dir().join(format!("{vid}.mp4")));
    let out_path = std::iter::once(namespace_path.clone())
        .chain(legacy_path)
        .into_iter()
        .find(|path| path.is_file() && path.metadata().map(|meta| meta.len() > 0).unwrap_or(false))
        .unwrap_or(namespace_path);
    let cached_payload = |path: &std::path::Path| {
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
    sweep_cache_dir(out_path.parent().unwrap_or(&cache_dir()));
    // 容量上限：缓存无界增长会把用户磁盘吃满（实测已积累 73 集 / 0.51GB 且只增
    // 不减）。落盘前按 LRU 淘汰最久未播放的整集，保持在预算内。
    enforce_cache_budget(out_path.parent().unwrap_or(&cache_dir()), &out_path);

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

    let result = run_resolve_worker(
        &app,
        python,
        worker,
        ffmpeg,
        credentials,
        profile,
        vid.clone(),
        requested_quality,
        out_path.clone(),
    )
    .await;
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

#[tauri::command]
pub fn short_drama_app_cache_clear() -> Result<String, String> {
    let dir = cache_dir();
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir).map_err(|error| format!("清理缓存失败：{error}"))?;
    }
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.to_string_lossy().to_string())
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
}
