#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod models;
mod provider;
mod short_drama_app;
mod storage;

use crate::models::{
    CacheClearResult, CatalogFilter, CatalogPage, FavoriteItem, PlaybackOpenInput, PlaybackSession,
    PlaybackSnapshot, PlaybackUiState,
    SeriesDetail, SeriesItem, UserSettings, WatchHistoryItem,
};
use crate::provider::DramaProvider;
use crate::short_drama_app::{
    short_drama_app_album, short_drama_app_cache_clear, short_drama_app_cache_usage,
    short_drama_app_prefetch_stream, short_drama_app_qualities, short_drama_app_resolve,
    short_drama_app_set_device, short_drama_app_status, short_drama_app_stream,
};
use crate::storage::Database;
use std::collections::HashMap;
use std::fs;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::{Manager, State};

struct AppState {
    provider: DramaProvider,
    database: Database,
    sessions: Mutex<HashMap<u64, PlaybackSession>>,
    cache_dir: PathBuf,
}

#[tauri::command]
async fn catalog_list(
    app: tauri::AppHandle,
    filter: CatalogFilter,
    state: State<'_, AppState>,
) -> Result<CatalogPage, String> {
    let keyword = filter
        .keyword
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let Some(keyword) = keyword else {
        return state.provider.catalog(&filter).await;
    };
    // 两个来源并发：网页搜索（结构化、带集数与题材）与 App 联想（分季齐全）。
    // 串行会让搜索凭空多等一次往返，而两者互不依赖。
    let comic = filter.channel == "comic";
    let (web, suggestions) = tokio::join!(
        state.provider.catalog(&filter),
        crate::short_drama_app::search_suggest(&app, &keyword, comic),
    );
    let mut page = web?;
    if suggestions.is_empty() {
        return Ok(page);
    }
    // 联想结果排在后面：网页结果的排序更贴关键词，联想只用于补齐缺项。
    let existing: std::collections::HashSet<String> =
        page.items.iter().map(|item| item.id.clone()).collect();
    let mut added = 0usize;
    for suggestion in suggestions {
        if existing.contains(&suggestion.id) {
            continue;
        }
        page.items.push(SeriesItem {
            id: suggestion.id,
            title: suggestion.title,
            cover: suggestion.cover,
            item_type: filter.channel.clone(),
            episodes_count: suggestion.episode_count,
            latest_episode_title: None,
            tags: suggestion.tags,
            origin: "红果 App 联想".into(),
            brief: None,
        });
        added += 1;
    }
    page.total += added;
    Ok(page)
}

#[tauri::command]
async fn series_detail(
    series_id: String,
    channel: Option<String>,
    state: State<'_, AppState>,
) -> Result<SeriesDetail, String> {
    state.provider.detail(&series_id, channel.as_deref()).await
}

#[tauri::command]
async fn playback_open(
    input: PlaybackOpenInput,
    state: State<'_, AppState>,
) -> Result<PlaybackSession, String> {
    let session = state
        .provider
        .open_episode(
            input.session_id,
            &input.series_id,
            &input.episode_id,
            &input.quality,
            input.position,
        )
        .await?;
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "播放会话锁不可用。".to_string())?;
    sessions.retain(|id, _| *id >= session.session_id.saturating_sub(8));
    sessions.insert(session.session_id, session.clone());
    Ok(session)
}

#[tauri::command]
fn playback_command(
    session_id: u64,
    _action: String,
    _payload: Option<serde_json::Value>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "播放会话锁不可用。".to_string())?;
    if sessions.contains_key(&session_id) {
        Ok(())
    } else {
        Err("播放会话已过期，请重新打开剧集。".into())
    }
}

#[tauri::command]
fn playback_snapshot(
    session_id: u64,
    state: State<'_, AppState>,
) -> Result<PlaybackSnapshot, String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "播放会话锁不可用。".to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "播放会话已过期，请重新打开剧集。".to_string())?;
    Ok(PlaybackSnapshot {
        session_id,
        state: PlaybackUiState {
            kind: "opening".into(),
            session_id,
        },
        position: session.position,
        duration: 0.0,
        buffered: 0.0,
        volume: 1.0,
        muted: false,
        playback_rate: 1.0,
    })
}

#[tauri::command]
fn external_player_open(url: String) -> Result<(), String> {
    let url = url.trim();
    if !url.starts_with("https://") {
        return Err("播放地址无效。".into());
    }
    let candidates = [
        std::env::var_os("TTV_BOX_MPV").map(PathBuf::from),
        Some(PathBuf::from("src-tauri/resources/mpv/mpv.exe")),
    ];
    let player = candidates
        .into_iter()
        .flatten()
        .find(|path| path.is_file())
        .or_else(|| Some(PathBuf::from("mpv.exe")))
        .ok_or_else(|| "未找到兼容播放器 mpv。".to_string())?;
    let mut command = Command::new(player);
    command.args([
        "--no-config",
        "--force-window=yes",
        "--keep-open=no",
        "--http-header-fields=Referer: https://novel.snssdk.com/,User-Agent: com.phoenix.read/71332",
        url,
    ]);
    // CREATE_NO_WINDOW：外部播放器由用户手势触发，但 GUI 子系统下 mpv.com
    // 兼容层与宿主仍可能闪终端窗口，后台创建标志一并抑制。
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    command
        .spawn()
        .map_err(|error| format!("启动兼容播放器失败：{error}"))?;
    Ok(())
}

#[tauri::command]
fn history_list(state: State<'_, AppState>) -> Result<Vec<WatchHistoryItem>, String> {
    state.database.list_history()
}

/**
 * 进全屏前，**静默**解除窗口的最大化状态。
 *
 * ## 为什么需要这个命令（而不是直接调 unmaximize）
 *
 * 窗口处于最大化时进全屏会出错：tao（wry 0.35 的 `window.rs`，WM_NCCALCSIZE 分支）
 * 为了保证"无边框窗口最大化时不盖住任务栏"，会把**仍是最大化状态**的窗口客户区
 * 裁到工作区（屏幕减任务栏）。而 `set_fullscreen` 只改全屏标记、从不清除最大化，
 * 于是用户看到"进了全屏，任务栏还在、画面没铺满"。
 *
 * 解除最大化确实能解决它，但 tao 的 `set_maximized(false)` 走的是
 * `ShowWindow(SW_RESTORE)`——**带系统还原动画**，窗口会先缩回原始尺寸再撑成全屏，
 * 用户看到的就是"进全屏时回弹一下"，观感很怪。
 *
 * 这里改用 `SetWindowPlacement`：把显示状态改回 `SW_SHOWNORMAL`，同时把
 * "常规位置"设成**当前（最大化时的）矩形**。窗口因此原地不动、无动画，只是不再
 * 处于最大化状态——tao 的裁切随之失效，紧接着的 `set_fullscreen(true)` 就能
 * 一步铺满整屏。
 */
#[cfg(windows)]
#[tauri::command]
fn window_prepare_fullscreen(window: tauri::Window) -> Result<bool, String> {
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, GetWindowPlacement, GetWindowRect, SetWindowLongPtrW,
        SetWindowPlacement, SetWindowPos, GWL_STYLE, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOSIZE, SWP_NOZORDER, SW_MAXIMIZE, SW_SHOWNORMAL, WINDOWPLACEMENT, WS_MAXIMIZE,
    };

    let hwnd: HWND = window.hwnd().map_err(|error| error.to_string())?.0;

    unsafe {
        let mut placement = WINDOWPLACEMENT {
            length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
            ..Default::default()
        };
        if GetWindowPlacement(hwnd, &mut placement) == 0 {
            return Err("读取窗口位置失败。".into());
        }
        // 没最大化就不用管（例如窗口本来就只是普通尺寸）。
        if placement.showCmd != SW_MAXIMIZE as u32 {
            return Ok(false);
        }

        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return Err("读取窗口矩形失败。".into());
        }

        // 1) 摘掉 WS_MAXIMIZE：窗口不再是"最大化窗口"，tao 的任务栏裁切随之失效。
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        SetWindowLongPtrW(hwnd, GWL_STYLE, style & !(WS_MAXIMIZE as isize));

        // 2) 显示状态改回普通，但"常规位置"保持当前矩形——窗口原地不动，无动画。
        placement.showCmd = SW_SHOWNORMAL as u32;
        placement.rcNormalPosition = rect;
        if SetWindowPlacement(hwnd, &placement) == 0 {
            return Err("应用窗口位置失败。".into());
        }

        // 3) 让非客户区重新计算：客户区立刻按"非最大化"的规则铺满，不必等下一次窗口变化。
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
    Ok(true)
}

#[cfg(not(windows))]
#[tauri::command]
fn window_prepare_fullscreen(_window: tauri::Window) -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
fn history_save(item: WatchHistoryItem, state: State<'_, AppState>) -> Result<(), String> {
    state.database.save_history(&item)
}

#[tauri::command]
fn history_remove(series_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.database.remove_history(&series_id)
}

#[tauri::command]
fn history_clear(state: State<'_, AppState>) -> Result<(), String> {
    state.database.clear_history()
}

#[tauri::command]
fn favorites_list(mark: Option<String>, state: State<'_, AppState>) -> Result<Vec<FavoriteItem>, String> {
    state.database.list_favorites(mark.as_deref())
}

#[tauri::command]
fn favorites_save(item: FavoriteItem, state: State<'_, AppState>) -> Result<(), String> {
    state.database.save_favorite(&item)
}

#[tauri::command]
fn favorites_remove(series_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.database.remove_favorite(&series_id)
}

#[tauri::command]
fn settings_get(state: State<'_, AppState>) -> Result<UserSettings, String> {
    state.database.settings_get()
}

#[tauri::command]
fn settings_save(mut settings: UserSettings, state: State<'_, AppState>) -> Result<(), String> {
    // 用户可控项：倒计时与目标帧率做区间夹取。
    settings.countdown_seconds = settings.countdown_seconds.clamp(3, 15);
    settings.target_fps = settings.target_fps.clamp(30, 120);
    // 能力受限项：如实归零而非静默接受。
    // - 清晰度：公开网页与 App 源都只有单一路径，多档位是幻影，强制 auto。
    // - 增强引擎：未接入真实补帧 SDK，只支持 off。
    // - 缓存读数：当前不做字节级统计，报 0 而不是编造数字。
    // 这些是"诚实报告边界"，不是丢弃用户输入——相应开关在 UI 上也不提供。
    settings.default_quality = "auto".into();
    settings.preferred_engine = "off".into();
    settings.catalog_cache_mb = 0.0;
    settings.playback_cache_mb = 0.0;
    state.database.settings_save(&settings)
}

/// 清空缓存（设置页按钮）。
///
/// 这里曾经只清 AppState::cache_dir（即 <.app-data>/cache）——那是本应用自己的
/// 目录，而**剧集视频实际由 worker 写在 <data_dir>/short-drama-cache**，
/// 两者不是同一个位置。结果是「一键释放缓存」永远报 0 MB，而真正占地的 2GB+
/// 视频文件从未被触及。现在改为委托给 short_drama_app_cache_clear，
/// 由它清理真实的剧集缓存并返回释放量。
#[tauri::command]
fn cache_clear(state: State<'_, AppState>) -> Result<CacheClearResult, String> {
    // 应用自有缓存目录（SQLite 快照等）一并清理。
    let own = clear_directory(&state.cache_dir).unwrap_or(0);
    let report = short_drama_app_cache_clear()?;
    Ok(CacheClearResult {
        freed_mb: (own + report.freed_bytes) as f64 / 1024.0 / 1024.0,
    })
}

fn clear_directory(path: &Path) -> Result<u64, String> {
    if !path.exists() {
        fs::create_dir_all(path).map_err(|error| error.to_string())?;
        return Ok(0);
    }
    let mut total = 0;
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let entry_path = entry.path();
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        if metadata.is_dir() {
            total += clear_directory(&entry_path)?;
            fs::remove_dir(&entry_path).map_err(|error| error.to_string())?;
        } else {
            total += metadata.len();
            fs::remove_file(&entry_path).map_err(|error| error.to_string())?;
        }
    }
    Ok(total)
}

/// 应用数据根目录（SQLite / 剧集缓存 / WebView2 user-data 共用）。
///
/// 默认 Tauri 的 `app_data_dir()` 在 Windows 上是
/// `C:\Users\<user>\AppData\Roaming\<identifier>`。但当系统盘写满时，
/// 在那里创建 SQLite 库会直接以 `disk I/O error` 让 setup 钩子 panic，
/// 应用连窗口都起不来；WebView2 也会因为写不进 GPU/着色器缓存而整片黑屏。
///
/// 因此这里改用"可执行文件所在盘"作为根目录：exe 位于
/// `<crate>/target/debug/ttv-short-drama.exe`，回退两级即 crate 根目录，
/// 最终数据落在 `<crate>/.app-data/`（开发态通常空间充足）。
/// 只有该位置不可写时才退回系统默认目录。
fn app_storage_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let crate_root = exe.parent()?.parent()?; // target/debug -> target
    let crate_dir = crate_root.parent()?; // target -> <crate>
    let candidate = crate_dir.join(".app-data");
    match std::fs::create_dir_all(&candidate) {
        Ok(()) => Some(candidate),
        Err(err) => {
            eprintln!(
                "[ttv] 无法在 {} 创建应用数据目录：{err}",
                candidate.display()
            );
            None
        }
    }
}

/// 配置 WebView2 启动参数。
///
/// 两件事：
/// 1. 确保开启 `PlatformHEVCDecoderSupport` —— 没有它，HEVC 源流无法播放。
/// 2. 剔除 `--disable-gpu-compositing` —— 那是当年 C 盘写满导致黑屏时的兜底，
///    如今 user-data 已迁到可写盘、根因消除；而它会把渲染与解码压回软件路径，
///    既让 30 处 backdrop-blur 异常昂贵，也会让平台 HEVC 硬解走不通。
///    保留用户/脚本传入的其他参数，只做追加与剔除，不整体覆盖。
fn configure_webview_browser_arguments() {
    const HEVC_FEATURE: &str = "PlatformHEVCDecoderSupport";
    let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();

    // 保留有效参数，丢弃已过时的软件光栅开关。
    let mut kept: Vec<String> = existing
        .split_whitespace()
        .filter(|arg| *arg != "--disable-gpu-compositing")
        .map(str::to_string)
        .collect();

    // 合并 --enable-features：保留他人已启用的特性，追加 HEVC 支持。
    let feature_index = kept
        .iter()
        .position(|arg| arg.starts_with("--enable-features="));
    match feature_index {
        Some(index) => {
            let current = kept[index].clone();
            if !current.contains(HEVC_FEATURE) {
                kept[index] = format!("{current},{HEVC_FEATURE}");
            }
        }
        None => kept.push(format!("--enable-features={HEVC_FEATURE}")),
    }

    let merged = kept.join(" ");
    eprintln!("[ttv] WebView2 启动参数：{merged}");
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", merged);
}

fn main() {
    // 历史背景：系统盘写满时，WebView2 写不了 GPU/着色器缓存 → 合成管线初始化失败
    // → 窗口内容区整片纯黑。当时用 `--disable-gpu-compositing` 兜底，但那会让全部
    // 渲染退回 CPU 软件光栅；而界面大量使用 `backdrop-blur`（30 处），软件高斯模糊
    // 极其昂贵——实测首页静止时 WebView2 仍持续占用约 50% 单核，表现为明显卡顿。
    //
    // 黑屏的真正根因是"缓存写不进去"，而 WebView2 的 user-data（含 GPU/着色器缓存）
    // 现已迁到空间充足的盘（见下方 WEBVIEW2_USER_DATA_FOLDER），根因已消除，
    // 因此不再禁用 GPU 合成，让 blur 走硬件加速。
    if let Some(data_dir) = app_storage_root().map(|root| root.join("webview-data")) {
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &data_dir);
    }
    // 允许 WebView2 使用系统平台解码器解 HEVC。
    //
    // 播放失败的根因：App-API 返回的源流是 HEVC(H.265)/hvc1（实测短剧 1080x1920、
    // 漫剧 1920x1080，缓存里每一集都是），而 Chromium 内核默认关闭 HEVC 解码，
    // HTML5 <video> 直接报错 —— 界面上表现为"该媒体无法由 WebView 解码"。
    // 本机已安装 Microsoft.HEVCVideoExtension，打开这个特性开关即可复用系统解码器，
    // 无需把每集转码成 H.264（转码会耗时 20s+/集、体积膨胀约 2.5 倍）。
    configure_webview_browser_arguments();

    tauri::Builder::default()
        .setup(|app| {
            // AppState 的 SQLite 与剧集缓存也落在同一个可写根目录下。
            let app_dir = app_storage_root().unwrap_or_else(|| {
                app.path()
                    .app_data_dir()
                    .unwrap_or_else(|_| std::env::temp_dir().join("ttv-short-drama"))
            });
            fs::create_dir_all(&app_dir).map_err(|error| error.to_string())?;
            let cache_dir = app_dir.join("cache");
            fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;
            let provider = DramaProvider::new()?;
            let database = Database::open(&app_dir.join("short-drama.sqlite3"))?;
            app.manage(AppState {
                provider,
                database,
                sessions: Mutex::new(HashMap::new()),
                cache_dir,
            });

            // 启动即自动整理缓存，无需用户确认。
            //
            // 处理三件事：清掉 worker 中断留下的半成品、删除超过保留期（7 天）
            // 的陈旧剧集、并把总占用压回全局预算（1GB）内。放在独立线程里执行，
            // 避免在缓存很大时拖慢窗口创建（首次启动可能要删掉上 GB 文件）。
            std::thread::spawn(|| {
                let report = short_drama_app::auto_clean_cache_on_start();
                if report.removed_files > 0 {
                    eprintln!(
                        "[ttv] 缓存自动清理：删除 {} 个剧集，释放 {:.1} MB",
                        report.removed_files,
                        report.freed_bytes as f64 / 1024.0 / 1024.0
                    );
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            catalog_list,
            series_detail,
            playback_open,
            playback_command,
            playback_snapshot,
            external_player_open,
            short_drama_app_status,
            short_drama_app_set_device,
            short_drama_app_resolve,
            short_drama_app_cache_clear,
            short_drama_app_cache_usage,
            short_drama_app_stream,
            short_drama_app_qualities,
            short_drama_app_album,
            short_drama_app_prefetch_stream,
            history_list,
            history_save,
            history_remove,
            history_clear,
            favorites_list,
            favorites_save,
            favorites_remove,
            window_prepare_fullscreen,
            settings_get,
            settings_save,
            cache_clear,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run TTV Short Drama");
}
