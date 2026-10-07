//! 播放链路的运行期诊断日志。
//!
//! 为什么需要它（实测 2026-10-07）：应用以 `#![windows_subsystem = "windows"]`
//! 构建，双击启动没有控制台；Rust 侧 18 处 `eprintln!`、前端 8 处 `console.*`
//! 全部落进黑洞。于是"开关 VSR 没用""首次打开要等十几秒"这类问题只能靠猜。
//! 这里提供三样东西：
//!   1. 进程内环形缓冲（设置页「播放器诊断日志」卡片读它）；
//!   2. 同一份内容追写到 `ttv-playback.log`（应用崩了/退出了也还能拿到）；
//!   3. `capture_stderr()` 把原生 stderr（ffmpeg、Tauri、panic）并入同一条时间线。
//!
//! 设计约束：日志永远不能影响播放。落盘失败、锁中毒一律静默降级。

use serde::Serialize;
use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

/// 内存里保留的最大行数。
///
/// 设置页最多显示 300 行，这里留 2000 是为了"往上翻几秒前发生了什么"仍然可行，
/// 同时常驻内存只有百 KB 量级（每行几十字节），不会成为负担。
const MAX_LINES: usize = 2000;

/// 全局单调序号。
///
/// `clear()` 之后继续增长而不是归零：前端持的是上次拿到的 cursor，若这里重置
/// 序号，清空后前端会拿着一个比最大值还大的 cursor，之后永远收不到新行。
static SEQ: AtomicU64 = AtomicU64::new(1);

struct Line {
    seq: u64,
    text: String,
}

fn buffer() -> &'static Mutex<VecDeque<Line>> {
    static BUF: OnceLock<Mutex<VecDeque<Line>>> = OnceLock::new();
    BUF.get_or_init(|| Mutex::new(VecDeque::with_capacity(256)))
}

/// 进程启动时刻，用于给每条日志打相对时间戳。
///
/// 用相对时间而不是墙上时间：排障时真正要读的是"attach 之后 380ms 才 canplay"，
/// 绝对时间还得做减法。
fn origin() -> Instant {
    static ORIGIN: OnceLock<Instant> = OnceLock::new();
    *ORIGIN.get_or_init(Instant::now)
}

fn log_path() -> PathBuf {
    crate::short_drama_app::cache_dir()
        .parent()
        .map(|dir| dir.join("ttv-playback.log"))
        .unwrap_or_else(|| PathBuf::from("ttv-playback.log"))
}

/// 追加一行到日志。任何失败都静默忽略——日志不是播放链路的一部分。
pub fn log(message: impl AsRef<str>) {
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let line = format!(
        "[+{:>8.3}s #{seq}] {}",
        origin().elapsed().as_secs_f64(),
        message.as_ref()
    );
    if let Ok(mut guard) = buffer().lock() {
        if guard.len() >= MAX_LINES {
            guard.pop_front();
        }
        guard.push_back(Line {
            seq,
            text: line.clone(),
        });
    }
    append_to_file(&line);
}

/// 把 URL 收敛成可安全写进日志的形态：只留 scheme://host[:port]/path。
///
/// 源流地址的 query 里带签名与 token（App-API 的预签名直链尤其如此），整条打进
/// 日志等于把凭据抄进磁盘文件与设置页界面里，排障时随手截图就把凭据漏出去了。
/// 但路径本身（文件名、分片序号）恰恰是排障要看的，所以只砍 query 与用户信息。
pub fn redact_url(url: &str) -> String {
    let (before_query, has_query) = match url.split_once('?') {
        Some((head, _)) => (head, true),
        None => (url, false),
    };
    let without_userinfo = match before_query.split_once("://") {
        Some((scheme, rest)) => match rest.split_once('@') {
            Some((_, host)) => format!("{scheme}://{host}"),
            None => before_query.to_owned(),
        },
        None => before_query.to_owned(),
    };
    if has_query {
        format!("{without_userinfo}?<已省略>")
    } else {
        without_userinfo
    }
}

fn append_to_file(line: &str) {
    static FILE: OnceLock<Mutex<Option<std::fs::File>>> = OnceLock::new();
    let cell = FILE.get_or_init(|| Mutex::new(open_log()));
    let Ok(mut guard) = cell.lock() else {
        return;
    };
    // 首次打开失败（目录只读等）时每次重试一次，避免整轮会话彻底没日志。
    if guard.is_none() {
        *guard = open_log();
    }
    if let Some(file) = guard.as_mut() {
        let _ = writeln!(file, "{line}");
        // 每行都 flush：进程被强杀时，最后几行恰恰是最有价值的那几行。
        let _ = file.flush();
    }
}

fn open_log() -> Option<std::fs::File> {
    // 测试不落盘。
    //
    // 踩过：cargo test 会真的跑通 logger，把 2000 行「填充 N」写进用户真实目录
    // 下的 ttv-playback.log，把排障现场冲掉。测试要的是编号与过滤语义，不是文件，
    // 所以 test 构建直接禁用落盘。
    if cfg!(test) {
        return None;
    }
    let path = log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceTail {
    pub lines: Vec<String>,
    pub next_cursor: u64,
    pub dropped: bool,
}

pub fn tail(cursor: u64) -> TraceTail {
    let Ok(guard) = buffer().lock() else {
        return TraceTail {
            lines: Vec::new(),
            next_cursor: cursor,
            dropped: false,
        };
    };
    let lines: Vec<String> = guard
        .iter()
        .filter(|line| line.seq > cursor)
        .map(|line| line.text.clone())
        .collect();
    // 被淘汰的行会让序号出现跳跃。显式告诉前端"你漏了行"，否则界面上会静默少
    // 一段，看起来像日志自己断了。
    let dropped = guard
        .front()
        .is_some_and(|first| first.seq > cursor.saturating_add(1));
    let next_cursor = guard.back().map(|line| line.seq).unwrap_or(cursor);
    TraceTail {
        lines,
        next_cursor,
        dropped,
    }
}

pub fn clear() {
    if let Ok(mut guard) = buffer().lock() {
        guard.clear();
    }
    let _ = std::fs::remove_file(log_path());
    log("诊断日志已清空");
}

/// 窗口尺寸变化的打点（带节流）。
///
/// 为什么需要它：「退出全屏回弹」是一个**时序**问题。全屏进出会在几百毫秒内
/// 连发多次 Resized，日志里只有首尾两个矩形时，分不清中间到底弹了几次、每次
/// 弹多大。这里把每次**尺寸变化**记下来，把视觉现象变成一条可读的时间线。
///
/// 节流规则（实测拖动窗口时 Resized 每秒几十次，全记会刷爆 2000 行环形缓冲）：
///   1. 尺寸与上一条完全相同 —— 丢弃（全屏切换常重复发同尺寸事件）；
///   2. 同一 500ms 窗口内最多 12 条 —— 超出丢弃，保证回弹那几跳一定留得下。
pub fn log_window_size(width: u32, height: u32) {
    use std::time::Duration;

    struct Gate {
        last: Option<(u32, u32)>,
        window_start: Option<Instant>,
        count: u32,
    }

    static GATE: OnceLock<Mutex<Gate>> = OnceLock::new();
    let gate = GATE.get_or_init(|| {
        Mutex::new(Gate {
            last: None,
            window_start: None,
            count: 0,
        })
    });
    let Ok(mut guard) = gate.lock() else {
        return;
    };
    if guard.last == Some((width, height)) {
        return;
    }
    let now = Instant::now();
    let fresh = guard
        .window_start
        .is_none_or(|started| now.duration_since(started) >= Duration::from_millis(500));
    if fresh {
        guard.window_start = Some(now);
        guard.count = 0;
    }
    guard.count += 1;
    if guard.count > 12 {
        return;
    }
    guard.last = Some((width, height));
    drop(guard);
    log(format!("[窗口] 尺寸变化 {width}x{height}"));
}

#[tauri::command]
pub fn trace_ui_log(message: String) {
    log(format!("[ui] {message}"));
}

#[tauri::command]
pub fn trace_tail(cursor: Option<u64>) -> TraceTail {
    tail(cursor.unwrap_or(0))
}

#[tauri::command]
pub fn trace_clear() {
    clear();
}

/// 记录启动横幅：这一段回答的是"你现在跑的到底是哪一版、VSR 到底开没开"。
///
/// 把可执行文件的构建时间写进来是有原因的：本轮"开关 VSR 没用"的第一嫌疑就是
/// 用户 GUI 里跑的是几小时前的旧二进制，而旧二进制里根本没有开关对应的代码——
/// 有这一行就能一眼排除或坐实。
pub fn log_environment() {
    log(format!(
        "==== TTV Short Drama v{} 启动 ====",
        env!("CARGO_PKG_VERSION")
    ));
    match std::env::current_exe() {
        Ok(exe) => {
            let built = std::fs::metadata(&exe)
                .and_then(|meta| meta.modified())
                .ok()
                .map(format_time)
                .unwrap_or_else(|| "未知".to_owned());
            log(format!("可执行文件：{}", exe.display()));
            log(format!("可执行文件构建时间：{built}"));
        }
        Err(error) => log(format!("取可执行文件路径失败：{error}")),
    }
    log(format!(
        "VSR 开关（当前值）：{}",
        if crate::vsr_is_enabled() {
            "开"
        } else {
            "关"
        }
    ));
    log(format!(
        "缓存目录：{}",
        crate::short_drama_app::cache_dir().display()
    ));
    if let Some(root) = std::env::var_os("WEBVIEW2_USER_DATA_FOLDER") {
        log(format!("WebView2 用户数据：{}", root.to_string_lossy()));
    }
    if let Some(args) = std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        log(format!("WebView2 启动参数：{}", args.to_string_lossy()));
    }
}

fn format_time(time: std::time::SystemTime) -> String {
    let stamp: chrono::DateTime<chrono::Local> = time.into();
    stamp.format("%Y-%m-%d %H:%M:%S").to_string()
}

/// 把原生 stderr 接到本模块。
///
/// GUI 子系统进程默认没有 STD_ERROR_HANDLE，任何 `eprintln!` 与 ffmpeg 的错误输出
/// 都会被直接丢弃。这里建一条匿名管道顶替它，再起一个线程把读到的每一行收进日志。
#[cfg(windows)]
pub fn capture_stderr() {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::Console::{SetStdHandle, STD_ERROR_HANDLE};
    use windows_sys::Win32::System::Pipes::CreatePipe;

    let mut read: HANDLE = std::ptr::null_mut();
    let mut write: HANDLE = std::ptr::null_mut();
    // 默认的 0 会让管道缓冲小到几十 KB，ffmpeg 一次吐一屏错误就可能把写端堵住，
    // 进而把转码进程也卡住。1MB 缓冲在这个量级下足够安全。
    let created = unsafe { CreatePipe(&mut read, &mut write, std::ptr::null_mut(), 1 << 20) };
    if created == 0 {
        return;
    }
    unsafe { SetStdHandle(STD_ERROR_HANDLE, write) };

    // HANDLE 与 RawHandle 同为 *mut c_void，不要再 cast（clippy -D warnings 会拦）。
    let owned = unsafe { std::fs::File::from_raw_handle(read) };
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        for line in BufReader::new(owned).lines() {
            match line {
                Ok(line) => log(format!("[stderr] {line}")),
                Err(_) => break,
            }
        }
    });
}

#[cfg(not(windows))]
pub fn capture_stderr() {}

#[cfg(test)]
mod tests {
    use super::*;

    /// 序号必须单调：前端每次只带上次的 cursor 回来，收到重复序号会重复渲染。
    #[test]
    fn tail_returns_only_newer_lines() {
        log("测试行 A");
        let first = tail(0);
        assert!(first.next_cursor >= 1);
        let second = tail(first.next_cursor);
        assert!(second.lines.is_empty(), "同一个 cursor 不该再取到行");
    }

    /// 预签名直链的 token 绝不能进日志文件，但路径要留下。
    #[test]
    fn redact_strips_query_and_userinfo() {
        assert_eq!(
            redact_url("https://cdn.example.com/a/b.mp4?sign=secret&t=1"),
            "https://cdn.example.com/a/b.mp4?<已省略>"
        );
        assert_eq!(
            redact_url("https://user:pass@cdn.example.com/a/b.mp4"),
            "https://cdn.example.com/a/b.mp4"
        );
        assert_eq!(redact_url("file:///d/a.mp4"), "file:///d/a.mp4");
    }

    /// 被淘汰的行要让上层知道，否则界面静默缺段。
    #[test]
    fn dropped_flag_reports_gaps() {
        let head = tail(0).next_cursor;
        for index in 0..(MAX_LINES + 10) {
            log(format!("填充 {index}"));
        }
        let far = tail(head);
        assert!(far.dropped, "跨越了被淘汰区间应当报 dropped");
    }
}
