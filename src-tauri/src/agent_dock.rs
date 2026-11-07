//! 智能体联动的桌面悬浮窗：一个**独立于主窗口**的置顶小窗。
//!
//! ## 为什么必须是独立窗口（不是应用内浮层）
//!
//! 用户的实际使用姿势是：把播放器收起 → 切到智能体工具（终端 / IDE / 浏览器）
//! → 干活 → 等它叫他。这个过程中主窗口根本不在前台，应用内浮层跟着主窗口一起
//! 被遮住 —— 那正是「收起后只能在程序上面显示」的根源（2026-10-29 用户反馈）。
//!
//! 只有真正的顶层窗口才成立：`always_on_top` + `skip_taskbar` + 无边框 + 透明。
//! 这是画中画小窗（`pip.rs`）已经验证过的同一套形态，本模块照它的窗口参数与
//! 「首帧就绪后才 show」的时序，避免看到白底空窗。
//!
//! ## 与主窗口的职责划分（与 PipReturnBridge 完全同构）
//!
//! - 主窗口决定「要不要显示 / 显示什么」：把播放快照（剧名、封面、集号、位置）
//!   经 `agent://dock-state` 事件广播过来；
//! - 悬浮窗只负责渲染，并把用户点击（「回到播放器」/「关闭」）
//!   用 `agent_dock_action` 命令回传；
//! - 主窗口收到动作后自己完成续播与清理（它才持有播放器的 store）。
//!
//! 悬浮窗**不持有任何播放状态**，也不碰媒体链路。

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// 悬浮窗的窗口标签。前端 `main.tsx` 按它分流入口，capabilities 里也要登记。
pub const WINDOW_LABEL: &str = "agentdock";
/// 主窗口标签，与 `pip.rs` 同值。
const MAIN_WINDOW_LABEL: &str = "main";

/// 主窗口 → 悬浮窗：下发/更新卡片内容（None 表示内容已失效，窗口该关了）。
pub const EVENT_DOCK_STATE: &str = "agent://dock-state";

/// 悬浮窗的默认尺寸。卡片本身是流式布局，窗口留一点透明留白给阴影。
const DEFAULT_WIDTH: f64 = 396.0;
const DEFAULT_HEIGHT: f64 = 216.0;

/// 悬浮卡上要展示的内容（主窗口算好下发，悬浮窗只渲染）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockState {
    pub title: String,
    pub cover: String,
    pub episode_number: u32,
    /// 停留位置（秒）。
    pub position: f64,
    /// 总时长（秒）；0 表示未知。
    pub duration: f64,
    /// 智能体显示名（如 "Claude Code"）。
    pub agent_name: String,
    /// 事件类型：done / action / question / error。
    pub event_type: String,
    /// 事件摘要。
    pub message: String,
    /// 项目目录名（可能为空）。
    pub project: String,
    /// 是不是动漫（卡片上给个角标）。
    pub is_anime: bool,
}

/// 悬浮窗的位置记忆：进程内保存最后一次的位置，重新打开时沿用。
#[derive(Default)]
pub struct DockStateStore {
    position: std::sync::Mutex<Option<(f64, f64)>>,
    /// 当前要展示的内容。
    ///
    /// ## 为什么服务端也要存一份（2026-10-29 修的空白窗）
    ///
    /// 第一版只靠 `emit` 推送：窗口 build 完立刻 emit，而那一刻页面的 JS 还没
    /// 执行、监听器还没绑定 —— 事件被静默丢弃。兜底逻辑 1.5 秒后把窗口显示出来，
    /// 用户看到的是一块**完全透明的空窗**（比不显示更糟，因为他会以为程序坏了）。
    ///
    /// 现在内容存这里：窗口建成后前端挂载时调 `agent_dock_state` **主动拉一次**，
    /// 推送只作为"内容更新"的补充。两条路互为兜底。
    current: std::sync::Mutex<Option<DockState>>,
}

/// 算悬浮窗的落点：屏幕工作区右下角，避开任务栏。
///
/// 用 `current_monitor` 而不是主窗口的 `outer_position`：用户可能把主窗口放在
/// 副屏，但"留意一下那边的提示"这件事应该发生在**鼠标所在的屏幕**上。
fn corner_position(app: &AppHandle) -> (f64, f64) {
    let scale = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(1.0);
    let (screen_w, screen_h) = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .and_then(|w| w.current_monitor().ok().flatten())
        .map(|m| {
            let size = m.size();
            let pos = m.position();
            (
                pos.x as f64 / scale + size.width as f64 / scale,
                pos.y as f64 / scale + size.height as f64 / scale,
            )
        })
        .unwrap_or((1920.0, 1080.0));
    // 右下角留 20px 边距；高度多留 56px 给任务栏（不做系统 API 探测，避免多显示器
    // 场景下 DPI 换算差异带来更糟的位置漂移——留白多一点永远不会错）。
    let x = screen_w - DEFAULT_WIDTH - 20.0;
    let y = screen_h - DEFAULT_HEIGHT - 56.0;
    (x.max(0.0), y.max(0.0))
}

/// 显示（或更新）悬浮窗。
///
/// 幂等：窗口已存在就直接复用并 show，不重复创建。
pub fn show(app: &AppHandle, state: &DockState) -> Result<(), String> {
    // 先落存储：前端可能比这次 emit 更早/更晚挂载，两条路都要拿得到。
    if let Some(store) = app.try_state::<DockStateStore>() {
        if let Ok(mut guard) = store.current.lock() {
            *guard = Some(state.clone());
        }
    }
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        // 复用分支：先把新内容广播进去，再确保可见。
        let _ = window.emit(EVENT_DOCK_STATE, Some(state));
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    let remembered = app
        .try_state::<DockStateStore>()
        .and_then(|s| s.position.lock().ok().and_then(|g| *g));
    let (x, y) = remembered.unwrap_or_else(|| corner_position(app));

    let window = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App("index.html".into()))
        .title("TTV 智能体")
        .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
        .position(x, y)
        .decorations(false)
        // 置顶 + 不进任务栏：它的全部意义就是"在别的程序上面待着"。
        .always_on_top(true)
        .skip_taskbar(true)
        // 透明：卡片自己是圆角 + 毛玻璃，窗口矩形必须让背景透出去，否则
        // 屏幕上就是一块突兀的白色方块（用户说的"不好看"有一半来自这里）。
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        // 与画中画小窗同一套后台豁免参数（理由见 pip.rs 里那段长注释）：
        // 小窗按定义始终"被遮挡"，不豁免就会被 WebView2 判定为后台并降频。
        .additional_browser_args(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
             --autoplay-policy=no-user-gesture-required \
             --disable-background-timer-throttling \
             --disable-backgrounding-occluded-windows \
             --disable-renderer-backgrounding",
        )
        // 先不可见，由前端首帧渲染完再 show（同 pip.rs 的时序，避免白底空窗）。
        .visible(false)
        .build()
        .map_err(|error| format!("创建智能体悬浮窗失败：{error}"))?;

    // 内容再广播一次：窗口页面可能还没绑定监听器，前端挂载后会主动来取一次
    // （`agent_dock_state` 命令），两条路互为兜底。
    let _ = window.emit(EVENT_DOCK_STATE, Some(state));

    // 前端异常时的兜底显示：1.5 秒还没 show 就强制显示（宁可闪一下白，也不能
    // 让用户点了「前往智能体」却什么都没有——那是比"不好看"严重得多的事故）。
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        if let Some(window) = handle.get_webview_window(WINDOW_LABEL) {
            if !window.is_visible().unwrap_or(true) {
                let _ = window.show();
            }
        }
    });
    Ok(())
}

/// 关掉悬浮窗。
pub fn hide(app: &AppHandle) -> Result<(), String> {
    if let Some(store) = app.try_state::<DockStateStore>() {
        if let Ok(mut guard) = store.current.lock() {
            *guard = None;
        }
    }
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        // 记住位置，下次在原处出现（用户可能把它拖到了顺眼的地方）。
        if let (Ok(pos), Some(store)) = (window.outer_position(), app.try_state::<DockStateStore>())
        {
            if let Ok(mut guard) = store.position.lock() {
                *guard = Some((pos.x as f64, pos.y as f64));
            }
        }
        let _ = window.hide();
    }
    Ok(())
}

/// 销毁（主窗口退出时用，避免留下没有落点的孤儿窗口）。
pub fn destroy(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.destroy();
    }
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

/// 主窗口调用：显示/更新悬浮卡。
#[tauri::command]
pub fn agent_dock_show(app: AppHandle, state: DockState) -> Result<(), String> {
    show(&app, &state)
}

/// 主窗口调用：收起悬浮卡。
#[tauri::command]
pub fn agent_dock_hide(app: AppHandle) -> Result<(), String> {
    hide(&app)
}

/// 悬浮窗启动时拉一次当前内容（防止页面挂载晚于事件广播）。
#[tauri::command]
pub fn agent_dock_state(app: AppHandle) -> Option<DockState> {
    app.try_state::<DockStateStore>()
        .and_then(|store| store.current.lock().ok().and_then(|guard| guard.clone()))
}

/// 悬浮窗自己请求显示（首帧就绪后调用，同 MiniPlayer 的 revealWindow）。
#[tauri::command]
pub fn agent_dock_ready(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window.show().map_err(|e| e.to_string())?;
        // 不要 set_focus：抢焦点会把用户正在打字的智能体工具打断——
        // 这正是"悬浮卡"和"模态弹窗"的区别。
    }
    Ok(())
}

/// 悬浮窗上的动作回传：`resume`（回到播放器）/ `close`（关掉卡片）。
///
/// 由主窗口的 `AgentDockBridge` 监听后执行真正的续播与清理——悬浮窗是独立
/// WebView，拿不到主窗口的播放器 store。
#[tauri::command]
pub fn agent_dock_action(app: AppHandle, action: String) -> Result<(), String> {
    if !matches!(action.as_str(), "resume" | "close") {
        return Err("未知动作".into());
    }
    let _ = app.emit_to(MAIN_WINDOW_LABEL, "agent://dock-action", action);
    Ok(())
}

/// 悬浮窗拖动（无边框窗口没有系统标题栏，拖拽必须由前端发起）。
#[tauri::command]
pub fn agent_dock_drag(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window.start_dragging().map_err(|e| e.to_string())?;
    }
    Ok(())
}
