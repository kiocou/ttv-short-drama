//! 画中画小窗：把正在播的视频"接力"到一个独立的置顶窗口继续播。
//!
//! ## 为什么必须是独立窗口
//!
//! 应用内浮层满足不了这个需求：主窗口一最小化浮层跟着消失，想一边看剧一边用别的
//! 软件更是不可能。只有真正的独立窗口（置顶 + 不进任务栏）才成立，代价是它天然
//! 拿不到主窗口那块 `<video>` 的画面——所以小窗里必然有第二块媒体元素。
//!
//! ## 为什么是"接力"而不是"两块 video 同时播"
//!
//! 仓库里只有一块常驻 `<video>`，历史上两块媒体元素同时活跃造成过"两个声音"与
//! MSE 互相抢占。因此这里立一条硬约定：
//!
//! - 小窗打开期间播放权完全在小窗：主窗口暂停并作废当前会话（`stopPlayback`）；
//! - 小窗关闭/回到播放器时回报最终进度，主窗口按原有链路重新起播（短剧命中整集
//!   缓存即秒开，动漫重新解析一次直链）。
//!
//! 任一时刻只有一路媒体在响。`pip_dismiss` 是这条约定的兜底：主窗口一旦要自己
//! 开始播（用户点了别的集），先把小窗收掉。
//!
//! ## 小窗自己解析播放地址
//!
//! 交接包里只带"身份 + 播放参数"，**不带播放地址**：主窗口的 `video.src` 在动漫
//! 链路下是 MSE 的 `blob:` 地址（跨窗口根本用不了），短剧链路的本地文件地址又深
//! 埋在播放 store 的 ref 里。小窗因此用与主窗口相同的 IPC 命令自行解析——短剧走
//! `short_drama_app_resolve`（整集已缓存，命中即秒开），动漫走 `playback_open`。
//! 这样每个窗口都只有一条自己负责的媒体链路，不存在跨窗口共享的中间态。

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// 销毁小窗前先注入的停播脚本。
///
/// ## 为什么必须显式停播，不能指望"窗口没了声音自然就停"
///
/// 实测（真实窗口 + CDP 采集）：窗口被 `hide()` 之后**音频照旧在播**，而且页面自己的
/// `document.visibilityState` 仍然是 `visible`（`SW_HIDE` 后实测值与可见时一致）。
/// 这是 Chromium 的标准行为——后台/隐藏页面不因不可见而暂停音频——但后果是：
/// 前端没有任何可用的判据去发现"我已经被藏起来了"，而**音声只能靠销毁 webview 来停**。
///
/// 销毁本身对不可靠：`destroy()` 是投递给主线程的异步消息，旧实现还把错误 `let _ =` 吞了。
/// 只要它延迟或失败（主线程正忙、"主窗口点某一集"与"小窗正在销毁"撞在一起等），
/// 窗口就停留在"已隐藏但仍在播放"的状态 —— 用户遇到的就是"关闭了小窗，它还在后台
/// 播放视频，有声音"。这里的实测证据：被隐藏的小窗里 `video.paused` 仍为 `false`、
/// `currentTime` 持续前进（51.4s → 72.2s / 21 秒）。
///
/// 因此停播"必须自己动手"：暂停并把源拆干净，让媒体管道确实停下来，与窗口最后有没有被
/// 成功销毁无关。
const STOP_MEDIA_JS: &str = r#"
(() => {
  for (const el of document.querySelectorAll('video, audio')) {
    try { el.pause(); el.removeAttribute('src'); el.load(); } catch (e) {}
  }
})();
"#;

/// 让小窗页面停掉所有媒体。
///
/// `eval` 是"投递给 webview 执行"，不等结果，所以调用方必须留出一小段排空时间
/// （见 `destroy_window`），否则紧接着的销毁可能先于这段脚本跑完。
///
/// 刻意不返回成败：`eval` 失败只意味着 webview 已经不可用（比如已崩），那里面自然也
/// 没有媒体在跑；调用方根据它做分支反而会变成本末倒置的“因为注入失败所以不停播”。
fn stop_media(window: &tauri::WebviewWindow) {
    let _ = window.eval(STOP_MEDIA_JS);
}

/// 小窗的窗口标签（前端启动时靠它决定渲染哪个入口，见前端 `services/pip.ts`）。
pub const WINDOW_LABEL: &str = "mini";
/// 主窗口标签。
pub const MAIN_WINDOW_LABEL: &str = "main";
/// 小窗 → 主窗口：小窗已关闭，附带最终进度。
pub const EVENT_RETURNED: &str = "pip://returned";
/// 主窗口 → 小窗：复用已存在的小窗时下发新的交接包。
pub const EVENT_HANDOFF: &str = "pip://handoff";

/// 小窗默认尺寸（逻辑像素，16:9）。再小就看不清人脸，再大就不叫"小窗"了。
const DEFAULT_WIDTH: f64 = 420.0;
const DEFAULT_HEIGHT: f64 = 236.0;
/// 用户可调的最小尺寸：进度条与按钮仍要放得下。
const MIN_WIDTH: f64 = 264.0;
const MIN_HEIGHT: f64 = 148.0;
/// 贴边留白。
const MARGIN: f64 = 24.0;
/// 底部额外让开的任务栏高度：小窗默认不该压住任务栏与通知区。
const TASKBAR_ALLOWANCE: f64 = 48.0;

/// 小窗选集用的一集：只带展示与解析都需要的字段。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipEpisode {
    pub id: String,
    pub episode_number: u32,
    pub title: String,
}

/// 主窗口交给小窗的"接力包"。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipHandoff {
    /// `drama`（短剧/漫剧）或 `anime`（动漫专区）——决定小窗用哪条解析链路。
    pub kind: String,
    pub series_id: String,
    /// 交接时正在播的那一集。
    pub episode_id: String,
    pub title: String,
    pub cover: String,
    /// `drama` / `comic` / `anime`：小窗关闭时落历史要用。
    pub channel: String,
    pub total_episodes: u32,
    pub episode_number: u32,
    /// 交接时那一集的集号：集列表缺失时小窗至少还能显示"第 N 集"。
    pub quality: String,
    pub position: f64,
    pub volume: f64,
    pub muted: bool,
    pub rate: f64,
    /// 短剧 worker 的内容类型（1 短剧 / 1004 漫剧）。动漫链路为空。
    pub content_type: Option<i64>,
    pub auto_next: bool,
    pub countdown_seconds: u32,
    /// 整部剧的集列表：小窗要能自己切上一集/下一集，不该为了换集把播放权交回去。
    pub episodes: Vec<PipEpisode>,
}

/// 小窗回报的实时进度。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PipProgress {
    pub position: f64,
    pub duration: f64,
    pub volume: f64,
    pub muted: bool,
    pub rate: f64,
    /// 小窗可能已连播到下一集：这里记的是"此刻真正在播的那一集"。
    pub episode_id: Option<String>,
}

/// 关闭小窗时回传给主窗口的事件负载。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipReturned {
    /// `return`（用户点"回到播放器"）/ `close`（用户点关闭）/ `system`（窗口被系统销毁）。
    pub mode: String,
    pub handoff: Option<PipHandoff>,
    pub progress: PipProgress,
}

/// 小窗的进程内状态：交接包 + 最近一次进度 + 是否已回报关闭。
#[derive(Default)]
pub struct PipState {
    handoff: Mutex<Option<PipHandoff>>,
    progress: Mutex<PipProgress>,
    /// `pip_close` 与窗口销毁回调都会尝试回报，这个标记保证只报一次：
    /// 报两次会让主窗口把同一集重复起播一遍。
    reported: Mutex<bool>,
}

impl PipState {
    fn take_reported(&self) -> bool {
        let mut reported = self
            .reported
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if *reported {
            return true;
        }
        *reported = true;
        false
    }
}

/// 贴右下角的初始位置。
///
/// 用物理像素算完再换算成逻辑坐标：`WebviewWindowBuilder::position` 收的是逻辑值，
/// 而 `Monitor` 报的是物理值，直接混用会在 125% / 150% 缩放的屏幕上把窗口顶出屏幕外。
fn corner_position(app: &AppHandle) -> (f64, f64) {
    let monitor = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .and_then(|window| window.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        // 拿不到显示器信息（极少见）：给一个屏幕内的固定位置，别把窗口扔到 (0,0)。
        return (160.0, 160.0);
    };
    let scale = monitor.scale_factor();
    let size = monitor.size();
    let origin = monitor.position();
    let width = size.width as f64 / scale;
    let height = size.height as f64 / scale;
    let left = origin.x as f64 / scale;
    let top = origin.y as f64 / scale;
    (
        left + (width - DEFAULT_WIDTH - MARGIN).max(0.0),
        top + (height - DEFAULT_HEIGHT - MARGIN - TASKBAR_ALLOWANCE).max(0.0),
    )
}

/// 创建（或复用）小窗。
///
/// 复用分支很关键：用户可能"回播放器看了看，又切回小窗"。这时不能新建窗口
/// （同一标签第二次 build 会直接报错），只下发改动后的交接包。
fn ensure_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    let (x, y) = corner_position(app);
    let window = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App("index.html".into()))
        .title("TTV 画中画")
        .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .position(x, y)
        // 无边框 + 不进任务栏 + 置顶：画中画的标准形态，拖动与缩放都交给前端
        // （startDragging / startResizeDragging），因此标题栏一概不要。
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(true)
        .resizable(true)
        .focused(true)
        .build()
        .map_err(|error| format!("创建画中画窗口失败：{error}"))?;

    // 两条与窗口生命周期相关的事项：
    //   1. Alt+F4 / 任务栏结束等系统路径不会走 pip_close。不在 Destroyed 里补一手，
    //      主窗口会一直以为小窗还在播（点了"进入小窗"却发现什么都不发生）；
    //   2. 这些路径同样必须**先停播**。CloseRequested 是唯一来得及的时机——
    //      Destroyed 是事后的，webview 已经销毁，再想注入脚本已经没机会了。
    //      虽然这一步结束后 webview 终会销毁、声音终会停，但"开始关闭"到"真正销毁"
    //      之间音频仍在响，用户听到的就是关不干净的尾巴。
    let handle = app.clone();
    let media_window = window.clone();
    window.on_window_event(move |event| {
        match event {
            tauri::WindowEvent::CloseRequested { .. } => {
                // 不干预关闭行为（不调用 prevent_close），只争取在窗口还在时把媒体停掉。
                stop_media(&media_window);
            }
            tauri::WindowEvent::Destroyed => report_closed(&handle, "system"),
            _ => {}
        }
    });
    Ok(())
}

/// 把"小窗已关闭"回报给主窗口（幂等）。
fn report_closed(app: &AppHandle, mode: &str) {
    let Some(state) = app.try_state::<PipState>() else {
        return;
    };
    if state.take_reported() {
        return;
    }
    let payload = PipReturned {
        mode: mode.to_string(),
        handoff: state.handoff.lock().ok().and_then(|guard| guard.clone()),
        progress: state
            .progress
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default(),
    };
    let _ = app.emit_to(MAIN_WINDOW_LABEL, EVENT_RETURNED, payload);
}

/// 停播并销毁小窗。
///
/// 顺序与理由（跨三步都不能省）：
///
/// 1. **先注入停播脚本**。这是这个函数存在的关键：窗口 `hide()` 之后音频照旧在播
///    （见 `STOP_MEDIA_JS` 的实测），所以声音能不能停，取决于这一步而不是后面的销毁。
///    放在 `hide` 之前是为了让脚本在页面仍活跃时投递下去。
/// 2. **立刻 `hide()`**：用户马上看不到它。这一步本身不停音频，因而必须在停播之后。
/// 3. **留一段排空时间再销毁**。`eval` 不等结果，立即销毁会让媒体还没停窗口就没了；
///    此时窗口已不可见，这点延迟用户无感。
///
/// 销毁这一步刻意**不吞错误**：旧实现 `let _ = window.destroy()` 把失败藏了起来，
/// 一旦失败就是"窗口不见了、声音还在"的静默故障，排查时毫无线索。现在失败退一步
/// 用 `close()`，并把原因写到 stderr。
///
/// 为什么必须异步销毁：销毁动作会杀掉调用方自己的 webview（`pip_close` 正是由小窗自己
/// 发起的），同步销毁会让前端拿不到返回值。
///
/// 代价（已知且接受）：隐藏前的停播会把小窗页面的媒体清空，所以“收手”的那次销毁如果
/// 之后又被 `pip_open` 复用，该页面要重新起一次播。这正是 `pip_open` 复用分支会重新
/// 下发 `EVENT_HANDOFF` 的原因，小窗拿到交接包就自己恢复播放。
fn destroy_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    stop_media(&window);
    let _ = window.hide();

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        let Some(window) = handle.get_webview_window(WINDOW_LABEL) else {
            return;
        };
        // 这 150ms 内用户可能又点了“画中画”：`pip_open` 会 `show()` 复用小窗并重新下发
        // 交接包。此时若照常销毁，用户看到的就是“点了画中画，小窗闪一下就没了”，
        // 而主窗口已经离开播放器。窗口可见 = 它刚被重新启用，这一轮销毁就此收手。
        if window.is_visible().unwrap_or(false) {
            return;
        }
        if let Err(error) = window.destroy() {
            // 媒体已经在上面的脚本里停掉了，此时最坏只是“窗口没销毁掉”，不会再出声。
            eprintln!("[pip] 小窗销毁失败，改用 close(): {error}");
            let _ = window.close();
        }
    });
}

/// 打开（或复用）画中画小窗并下发交接包。
///
/// **必须是 `async` 命令**：Tauri 的同步命令跑在主线程上，而 `WebviewWindowBuilder::build()`
/// 在主线程里会内联执行窗口/WebView2 创建，创建过程又需要事件循环继续泵消息——
/// 于是这次 IPC 调用永不返回、小窗的 webview 停在 `about:blank`（真实窗口下实测：
/// 窗口确实出现了，但标题栏还是空的空白页，前端 `await openPip(...)` 也一直 pending，
/// 表现为“点了画中画，主窗口停在原地、小窗里一片空白”）。
/// 改成 `async` 后命令跑在异步运行时的线程上，Tauri 会把创建请求投递回主线程，
/// 两边都不再互相等待。
#[tauri::command]
pub async fn pip_open(app: AppHandle, handoff: PipHandoff) -> Result<(), String> {
    let state = app
        .try_state::<PipState>()
        .ok_or_else(|| "画中画状态未初始化。".to_string())?;
    {
        let mut guard = state
            .handoff
            .lock()
            .map_err(|_| "画中画状态锁不可用。".to_string())?;
        *guard = Some(handoff.clone());
    }
    if let Ok(mut progress) = state.progress.lock() {
        *progress = PipProgress {
            volume: handoff.volume,
            muted: handoff.muted,
            rate: handoff.rate,
            episode_id: Some(handoff.episode_id.clone()),
            ..PipProgress::default()
        };
    }
    if let Ok(mut reported) = state.reported.lock() {
        *reported = false;
    }

    ensure_window(&app)?;
    // 窗口刚创建时这条事件必然早于页面加载完成而丢失，小窗挂载后会自己拉一次
    // `pip_handoff`；复用分支则靠这条事件重新初始化。
    let _ = app.emit_to(WINDOW_LABEL, EVENT_HANDOFF, handoff);
    Ok(())
}

/// 小窗启动时拉取交接包。
#[tauri::command]
pub fn pip_handoff(app: AppHandle) -> Result<Option<PipHandoff>, String> {
    let state = app
        .try_state::<PipState>()
        .ok_or_else(|| "画中画状态未初始化。".to_string())?;
    // 先把值取到局部变量再返回：直接写成 `state.…lock()?.clone()` 尾表达式时，
    // MutexGuard 这个临时值的析构落在 `state` 之后，借用检查会报 does not live long enough。
    let handoff = state
        .handoff
        .lock()
        .map_err(|_| "画中画状态锁不可用。".to_string())?
        .clone();
    Ok(handoff)
}

/// 小窗上报实时进度（节流由前端负责）。
///
/// 它不只是给"回到播放器"用的：系统路径关闭小窗时，能回传的就是最近这一次上报。
#[tauri::command]
pub fn pip_report(app: AppHandle, progress: PipProgress) -> Result<(), String> {
    let state = app
        .try_state::<PipState>()
        .ok_or_else(|| "画中画状态未初始化。".to_string())?;
    let mut guard = state
        .progress
        .lock()
        .map_err(|_| "画中画状态锁不可用。".to_string())?;
    *guard = progress;
    Ok(())
}

/// 小窗请求关闭：回报最终进度后销毁自己。
///
/// `mode = "return"` 表示用户要回到播放器继续看（主窗口会重新起播），
/// 其余取值只落进度、不起播。
#[tauri::command]
pub fn pip_close(app: AppHandle, mode: String, progress: PipProgress) -> Result<(), String> {
    let state = app
        .try_state::<PipState>()
        .ok_or_else(|| "画中画状态未初始化。".to_string())?;
    if let Ok(mut guard) = state.progress.lock() {
        *guard = progress;
    }
    report_closed(&app, &mode);
    destroy_window(&app);
    Ok(())
}

/// 主窗口请求收掉小窗。
///
/// 用途是"播放权必须唯一"：主窗口一旦要自己起播（用户点了某一集），小窗必须
/// 立刻让位，否则两路声音同时响。进度按最近一次上报结算，并照常走 `close` 语义
/// 落历史，不惊动用户的观看进度。
#[tauri::command]
pub fn pip_dismiss(app: AppHandle) -> Result<(), String> {
    if app.get_webview_window(WINDOW_LABEL).is_none() {
        return Ok(());
    }
    report_closed(&app, "close");
    destroy_window(&app);
    Ok(())
}

/// 小窗当前是否开着（主窗口用于按钮态与提示）。
#[tauri::command]
pub fn pip_is_open(app: AppHandle) -> bool {
    app.get_webview_window(WINDOW_LABEL).is_some()
}

/// 主窗口关闭时收掉小窗（幂等）。
///
/// Tauri 以"最后一个窗口关闭"决定是否退出进程：不补这一手，用户关掉主界面后应用
/// 不会退出，屏幕上只剩一个悬浮小窗——它的"回到播放器"已经没有落点，用户只能再
/// 去点那个叉。主窗口一关，小窗就该跟着消失。
pub fn dismiss_on_main_close(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.close();
    }
}
