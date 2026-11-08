// native_player.rs —— 原生播放器（mpv + LSFG 补帧）的进程管理与 IPC 客户端。
//
// 为什么要有这一个模块（而不是继续用 WebView2 播）：
//   * 补帧引擎捕获不到 WebView2（DXGI/WGC 全黑、GDI 崩溃，见 main.rs 的补帧注释）；
//   * 原生播放器直吃红果直链（CENC 解密 + d3d11va 硬解），整条 H.264 转码链路被消除。
//
// 协议（对应 src-tauri/native-player/IpcPipe.cs）：
//   主程序 → 播放器：一行一条 JSON 命令 {cmd:"load"|"pause"|"seek"|...}
//   播放器 → 主程序：{event:"progress"|"ended"|"closed"|"next"|"prev"|"error", ...}
//   管道名由主程序生成（\\.\pipe\<name>），播放器是服务端。
//
// 生命周期：同一时刻只保留一个播放器窗口。再次 open 时如果进程还活着，
// 只下发 load 换集；进程没了才重新 spawn。
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// 播放器回传的状态（命令层读取；前端也可以轮询）。
#[derive(Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerState {
    pub alive: bool,
    pub position: f64,
    pub duration: f64,
    pub episode: u32,
    pub title: String,
    pub series_id: String,
    pub episode_id: String,
}

struct Session {
    child: Child,
    /// 管道写端：事件线程连上后填充（命令层通过它下发控制）。
    stdin: Arc<Mutex<Option<File>>>,
    state: Arc<Mutex<PlayerState>>,
    pipe: String,
}

fn slot() -> &'static Mutex<Option<Session>> {
    static S: OnceLock<Mutex<Option<Session>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

/// 找播放器可执行文件：打包态优先随包资源，开发态回落到本地构建产物。
fn find_player_exe<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("native-player").join("NativePlayer.exe");
        if p.exists() {
            return Some(p);
        }
    }
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for cfg in ["Debug", "Release"] {
        let p = here
            .join("native-player")
            .join("bin")
            .join(cfg)
            .join("net10.0-windows")
            .join("NativePlayer.exe");
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// 关掉播放器（幂等）。应用退出、用户关窗口都走这里。
pub fn stop() {
    let mut guard = slot().lock().unwrap();
    if let Some(mut s) = guard.take() {
        if let Ok(mut w) = s.stdin.lock() {
            if let Some(w) = w.as_mut() {
                let _ = writeln!(w, "{}", json!({"cmd":"quit"}));
                let _ = w.flush();
            }
        }
        std::thread::sleep(Duration::from_millis(120));
        let _ = s.child.kill();
        let _ = s.child.wait();
    }
}

/// 当前状态（无播放器时 alive=false）。
pub fn status() -> PlayerState {
    let guard = slot().lock().unwrap();
    match guard.as_ref() {
        Some(s) => {
            let mut st = s.state.lock().map(|g| g.clone()).unwrap_or_default();
            st.alive = true;
            st
        }
        None => PlayerState::default(),
    }
}

/// 给播放器发一条命令（JSON 行）。
///
/// ⚠️ 两个刻意的设计（都是踩过的坑）：
///   1. **不持有全局 slot 锁去写管道**。管道写是阻塞调用，一旦播放器端读端停了，
///      持锁写会让 `status`/`open` 全部跟着卡死（实测：一次 volume 命令把整个
///      控制面锁住，前端只能重启）。
///   2. **写操作带超时**：放到独立线程里写，2 秒没写完就返回错误，让调用方
///      拿到明确失败而不是无限等待。
pub fn send(cmd: Value) -> Result<(), String> {
    let stdin = {
        let guard = slot().lock().unwrap();
        let Some(s) = guard.as_ref() else {
            return Err("播放器没有在运行".into());
        };
        s.stdin.clone()
    }; // 全局锁在这里释放：后面的阻塞写不再影响其他命令

    let line = format!(
        "{cmd}
"
    );
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut w = stdin.lock().unwrap();
        let Some(w) = w.as_mut() else {
            let _ = tx.send(Err("播放器管道未就绪（刚启动，稍后再试）".to_string()));
            return;
        };
        let r = (|| -> Result<(), String> {
            w.write_all(line.as_bytes())
                .map_err(|e| format!("写入播放器失败：{e}"))?;
            w.flush().map_err(|e| format!("刷新播放器管道失败：{e}"))
        })();
        let _ = tx.send(r);
    });
    match rx.recv_timeout(Duration::from_secs(2)) {
        Ok(r) => r,
        Err(_) => Err("播放器无响应（管道写超时）".into()),
    }
}

/// 补帧管线尺寸：长边固定 960（约 540p~720p 档，GPU 预算与画质折中）。
/// 横屏 1920×1080 → 960×540；竖屏 1080×1920 → 540×960。
/// 读字符串字段：前端（TS）传 camelCase，Rust 习惯 snake_case —— 两种都认，
/// 免得一处拼错就让 startSeconds 静默失效（实测踩过：从 0 播而不是续播点）。
fn pick_str<'a>(req: &'a Value, camel: &str, snake: &str) -> &'a str {
    req.get(camel)
        .or_else(|| req.get(snake))
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn pick_f64(req: &Value, camel: &str, snake: &str, default: f64) -> f64 {
    req.get(camel)
        .or_else(|| req.get(snake))
        .and_then(Value::as_f64)
        .unwrap_or(default)
}

fn pick_u64(req: &Value, camel: &str, snake: &str, default: u64) -> u64 {
    req.get(camel)
        .or_else(|| req.get(snake))
        .and_then(Value::as_u64)
        .unwrap_or(default)
}

fn pipeline_size(w: i64, h: i64) -> (i64, i64) {
    let (w, h) = (w.max(64) as f64, h.max(64) as f64);
    if w >= h {
        let vw = 960.0f64;
        let vh = (vw * h / w / 2.0).round() * 2.0;
        (vw as i64, vh.max(2.0) as i64)
    } else {
        let vh = 960.0f64;
        let vw = (vh * w / h / 2.0).round() * 2.0;
        (vw.max(2.0) as i64, vh as i64)
    }
}

/// 打开（或复用）播放器播放一集。
///
/// `req`：vid、series_id、episode_id、title、episode、start_seconds、volume、fg、fg_mult
pub async fn open<R: Runtime>(app: AppHandle<R>, req: Value) -> Result<PlayerState, String> {
    let vid = req
        .get("vid")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    if vid.is_empty() || !vid.chars().all(|c| c.is_ascii_digit()) {
        return Err("缺少有效的 vid".into());
    }

    // 1) 直链 + 解密 key + 真实宽高（红果原生解析，实测 150~250ms）
    let payload = crate::hongguo_bridge::fetch_stream_payload(&vid)
        .await
        .map_err(|e| format!("解析播放地址失败：{e}"))?;
    let url = payload
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if url.is_empty() {
        return Err("播放地址为空".into());
    }
    let key = payload
        .get("content_key")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let width = payload.get("width").and_then(Value::as_i64).unwrap_or(1080);
    let height = payload
        .get("height")
        .and_then(Value::as_i64)
        .unwrap_or(1920);
    let duration = payload
        .get("duration_ms")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        / 1000.0;
    let (vw, vh) = pipeline_size(width, height);

    let title = pick_str(&req, "title", "title").to_owned();
    let episode = pick_u64(&req, "episode", "episode", 0) as u32;
    let series_id = pick_str(&req, "seriesId", "series_id").to_owned();
    let episode_id = pick_str(&req, "episodeId", "episode_id").to_owned();

    let load = json!({
        "url": url,
        "key": key,
        "start": pick_f64(&req, "startSeconds", "start_seconds", 0.0),
        "title": title,
        "ep": episode,
        "total": duration,
        "vw": vw,
        "vh": vh,
        "volume": pick_f64(&req, "volume", "volume", 80.0),
    });

    // 2) 活着就复用（只换集），否则重建
    let reuse = {
        let mut guard = slot().lock().unwrap();
        let mut alive = false;
        if let Some(s) = guard.as_mut() {
            if matches!(s.child.try_wait(), Ok(None)) {
                alive = true;
                if let Ok(mut st) = s.state.lock() {
                    st.position = 0.0;
                    st.duration = duration;
                    st.episode = episode;
                    st.title = title.clone();
                    st.series_id = series_id.clone();
                    st.episode_id = episode_id.clone();
                }
            } else {
                // 已退出：清掉骨架
                if let Some(mut dead) = guard.take() {
                    let _ = dead.child.kill();
                    let _ = dead.child.wait();
                }
            }
        }
        alive
    };

    if reuse {
        let mut cmd = load.clone();
        if let Some(obj) = cmd.as_object_mut() {
            obj.insert("cmd".into(), json!("load"));
        }
        send(cmd)?;
        crate::trace::log(format!("[原生播放器] 复用窗口换集 vid={vid} ep={episode}"));
        return Ok(status());
    }

    let exe = find_player_exe(&app)
        .ok_or_else(|| "找不到 NativePlayer.exe（先构建 src-tauri/native-player）".to_string())?;
    crate::apply_windows_gpu_preference_for(&exe);
    let pipe = format!(
        "ttv-player-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );

    // 3) load 走文件：URL 带签名很长，命令行传会被外壳吞引号（实测 PowerShell 踩过）
    let load_path = std::env::temp_dir().join(format!("{pipe}.json"));
    std::fs::write(&load_path, serde_json::to_vec(&load).unwrap_or_default())
        .map_err(|e| format!("写 load 文件失败：{e}"))?;

    let fg = if req.get("fg").and_then(Value::as_bool).unwrap_or(true) {
        "1"
    } else {
        "0"
    };
    let fg_mult = pick_u64(&req, "fgMult", "fg_mult", 2)
        .clamp(2, 5)
        .to_string();

    let mut child = Command::new(&exe)
        .arg("--pipe")
        .arg(&pipe)
        .arg("--load-file")
        .arg(&load_path)
        .arg("--fg")
        .arg(fg)
        .arg("--fgmult")
        .arg(fg_mult)
        .current_dir(exe.parent().unwrap_or_else(|| std::path::Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动播放器失败：{e}"))?;

    let _ = child.stdin.take();
    let state = Arc::new(Mutex::new(PlayerState {
        alive: true,
        position: 0.0,
        duration,
        episode,
        title: title.clone(),
        series_id: series_id.clone(),
        episode_id: episode_id.clone(),
    }));

    {
        let mut guard = slot().lock().unwrap();
        *guard = Some(Session {
            child,
            stdin: Arc::new(Mutex::new(None)),
            state: state.clone(),
            pipe: pipe.clone(),
        });
    }

    spawn_event_reader(app.clone(), pipe.clone(), state, load_path);

    crate::trace::log(format!(
        "[原生播放器] 已启动 vid={vid} ep={episode} 管线={vw}x{vh} 管道={pipe}"
    ));
    Ok(status())
}

/// 事件读取线程：连管道（重试 10s）→ 逐行解析 → 更新状态 / 落观看历史。
fn spawn_event_reader<R: Runtime>(
    app: AppHandle<R>,
    pipe: String,
    state: Arc<Mutex<PlayerState>>,
    load_path: PathBuf,
) {
    std::thread::spawn(move || {
        let path = format!(r"\\.\pipe\{pipe}");
        let mut conn = None;
        for _ in 0..100 {
            match std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)
            {
                Ok(f) => {
                    conn = Some(f);
                    break;
                }
                Err(_) => std::thread::sleep(Duration::from_millis(100)),
            }
        }
        let Some(write_end) = conn else {
            crate::trace::log("[原生播放器] 管道连接失败（播放器未起来？）");
            let snapshot = if let Ok(mut st) = state.lock() {
                st.alive = false;
                st.clone()
            } else {
                PlayerState::default()
            };
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.emit(
                    "native-player-error",
                    json!({
                        "seriesId": snapshot.series_id,
                        "episodeId": snapshot.episode_id,
                        "position": snapshot.position,
                        "message": "原生播放器未能连接。",
                    }),
                );
            }
            return;
        };
        // load 文件已经用过了，删掉（里面是签名 URL，不留在临时目录）
        let _ = std::fs::remove_file(&load_path);

        let read_end = match write_end.try_clone() {
            Ok(c) => c,
            Err(e) => {
                crate::trace::log(format!("[原生播放器] 管道复制失败：{e}"));
                return;
            }
        };
        // 把写端交给命令层
        {
            let mut guard = slot().lock().unwrap();
            if let Some(s) = guard.as_mut() {
                if s.pipe == pipe {
                    if let Ok(mut w) = s.stdin.lock() {
                        *w = Some(write_end);
                    }
                }
            }
        }

        let mut received_closed = false;
        let mut lines = BufReader::new(read_end).lines();
        while let Some(Ok(line)) = lines.next() {
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let event = v.get("event").and_then(Value::as_str).unwrap_or("");
            match event {
                "progress" => {
                    let snapshot = {
                        let Ok(mut st) = state.lock() else { continue };
                        if let Some(p) = v.get("pos").and_then(Value::as_f64) {
                            st.position = p;
                        }
                        if let Some(d) = v.get("dur").and_then(Value::as_f64) {
                            if d > 0.5 {
                                st.duration = d;
                            }
                        }
                        st.clone()
                    };
                    if !snapshot.series_id.is_empty() {
                        save_history(&app, &snapshot);
                    }
                }
                "ended" => {
                    let snapshot = if let Ok(mut st) = state.lock() {
                        if let Some(p) = v.get("pos").and_then(Value::as_f64) {
                            st.position = p;
                        }
                        st.clone()
                    } else {
                        PlayerState::default()
                    };
                    crate::trace::log("[原生播放器] 本集播完");
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.emit(
                            "native-player-ended",
                            json!({ "seriesId": snapshot.series_id, "episodeId": snapshot.episode_id }),
                        );
                    }
                }
                "closed" => {
                    received_closed = true;
                    let snapshot = if let Ok(mut st) = state.lock() {
                        st.alive = false;
                        if let Some(p) = v.get("pos").and_then(Value::as_f64) {
                            st.position = p;
                        }
                        st.clone()
                    } else {
                        PlayerState::default()
                    };
                    crate::trace::log("[原生播放器] 窗口关闭");
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.emit(
                            "native-player-closed",
                            json!({
                                "seriesId": snapshot.series_id,
                                "episodeId": snapshot.episode_id,
                                "position": snapshot.position,
                            }),
                        );
                    }
                    break;
                }
                "prev" | "next" => {
                    // 播放器的上下集按钮：把意图转给前端（前端持有剧集列表）
                    crate::trace::log(format!("[原生播放器] 用户点了{event}"));
                    if let Some(win) = app.get_webview_window("main") {
                        let snapshot = state
                            .lock()
                            .map(|current| current.clone())
                            .unwrap_or_default();
                        let _ = win.emit(
                            "native-player-navigate",
                            json!({ "dir": event, "seriesId": snapshot.series_id, "episodeId": snapshot.episode_id, "pos": v.get("pos").cloned().unwrap_or(json!(0.0)) }),
                        );
                    }
                }
                "error" => {
                    let msg = v.get("msg").and_then(Value::as_str).unwrap_or("");
                    crate::trace::log(format!("[原生播放器] 错误：{msg}"));
                    let snapshot = state
                        .lock()
                        .map(|current| current.clone())
                        .unwrap_or_default();
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.emit(
                            "native-player-error",
                            json!({
                                "seriesId": snapshot.series_id,
                                "episodeId": snapshot.episode_id,
                                "position": snapshot.position,
                                "message": msg,
                            }),
                        );
                    }
                }
                "frame-interpolation" => {
                    let enabled = v.get("enabled").and_then(Value::as_bool).unwrap_or(false);
                    let multiplier = v
                        .get("mult")
                        .and_then(Value::as_u64)
                        .unwrap_or(2)
                        .clamp(2, 5) as u32;
                    let state_store = app.state::<crate::AppState>();
                    match state_store.database.settings_get() {
                        Ok(mut settings) => {
                            settings.frame_interpolation_enabled = enabled;
                            settings.frame_interpolation_multiplier = multiplier;
                            if let Err(error) = state_store.database.settings_save(&settings) {
                                crate::trace::log(format!(
                                    "[原生播放器] 补帧设置保存失败：{error}"
                                ));
                            } else if let Some(win) = app.get_webview_window("main") {
                                let _ = win.emit(
                                    "native-player-frame-interpolation",
                                    json!({
                                        "enabled": enabled,
                                        "multiplier": multiplier,
                                    }),
                                );
                            }
                        }
                        Err(error) => crate::trace::log(format!(
                            "[原生播放器] 读取设置失败，补帧偏好未保存：{error}"
                        )),
                    }
                }
                _ => {}
            }
        }
        let snapshot = if let Ok(mut st) = state.lock() {
            st.alive = false;
            st.clone()
        } else {
            PlayerState::default()
        };
        if !received_closed {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.emit(
                    "native-player-error",
                    json!({
                        "seriesId": snapshot.series_id,
                        "episodeId": snapshot.episode_id,
                        "position": snapshot.position,
                        "message": "原生播放器已意外退出。",
                    }),
                );
            }
        }
        crate::trace::log("[原生播放器] 事件流结束");
    });
}

/// 落观看历史：与 WebView2 链路共用同一张表，切回去续播位置一致。
fn save_history<R: Runtime>(app: &AppHandle<R>, st: &PlayerState) {
    let state = app.state::<crate::AppState>();
    let pct = if st.duration > 0.5 {
        ((st.position / st.duration) * 100.0)
            .round()
            .clamp(0.0, 100.0) as u8
    } else {
        0
    };
    let item = crate::models::WatchHistoryItem {
        series_id: st.series_id.clone(),
        episode_id: st.episode_id.clone(),
        title: st.title.clone(),
        series_cover: String::new(),
        episode_number: st.episode,
        total_episodes: 0,
        position_seconds: st.position,
        duration_seconds: st.duration,
        progress_percent: pct,
        updated_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
        is_finished: pct >= 98,
        channel: None,
    };
    if let Err(e) = state.database.save_history(&item) {
        crate::trace::log(format!("[原生播放器] 历史保存失败：{e}"));
    }
}
