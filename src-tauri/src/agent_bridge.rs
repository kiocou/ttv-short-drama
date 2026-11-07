//! 智能体联动桥：把本地 AI 智能体工具（Claude Code / Codex / Gemini / Cursor 等）
//! 的生命周期事件转发到主窗口，驱动「自动暂停短剧 → 呼叫用户 → 收起播放器 →
//! 一键回到原位置续播」的联动流程。
//!
//! ## 架构（参考 GitHub 上三类已验证的方案）
//!
//! - **PetDeck / pet-tty**（Tauri 2 + Rust，与本货项目同栈）：Claude Code hooks
//!   POST 到 `127.0.0.1:7788` 本机桥，桌宠据此更新状态。本模块照搬这个形态。
//! - **agent-notifications**（817★）：事件分三类——任务完成 / 需要用户操作（权限、
//!   审批）/ 需要用户抉择（提问）。本桥的事件模型与其对齐。
//! - **Clawd on Desk**（6.5k★）：多智能体接入矩阵——每个智能体用「官方 hooks 优先，
//!   日志轮询/进程探测兜底」。本桥只做**统一接收端**：所有智能体工具的 hook 都
//!   POST 到同一个端口，事件体里自带 `agent` 标识（hook 命令里写死），桥不关心
//!   也不需要区分"是谁装的 hook"。
//!
//! ## 为什么是"桥统一收口"而不是"每智能体各写一个集成"
//!
//! 各家智能体的 hook 机制千差万别（Claude Code 的 settings.json hooks、Codex 的
//! hooks.json、Gemini 的 settings.json、Cursor 的 hooks.json……），但它们有一点完全
//! 一致：**都能在事件发生时执行任意 shell 命令**。所以桥只约定一个极简的 HTTP 协议，
//! hook 命令负责把事件翻译成一行 POST——每新增一个智能体工具，只是多复制一段
//! hook 配置，桥与前端零改动。这是 agent-notifications / Clawd 共同验证过的路子。
//!
//! ## 安全边界（与 PetDeck 同款，全部刻意收紧）
//!
//! - 只绑 `127.0.0.1` 回环，不对局域网/外网暴露；
//! - 只接受 POST；请求体上限 64KB；`message` 字段超长截断（hook 输出是不可信数据，
//!   只做展示用，前端不执行其中任何内容）；
//! - 未知 `type` / 缺字段的请求静默丢弃并回 400——桥要稳：智能体工具的 hook 对
//!   响应不敏感（`async: true`），坏了也不该拖累智能体本身；
//! - 不执行、不转发任何 hook 传来的命令或 URL，事件体只作为展示数据下发前端。
//!
//! ## 与 pip.rs 的关系
//!
//! 事件广播完全照 pip.rs 的模式：`emit_to(MAIN_WINDOW_LABEL, event, payload)`。
//! 桥本身不持有窗口、不碰媒体链路——"暂停播放器 / 收起 / 回原位续播"全部由
//! 前端 `AgentWatchBridge`（组件）驱动，与 PipReturnBridge 的职责划分一致。

use serde::Serialize;
use std::sync::atomic::{AtomicU16, Ordering};
use tauri::{AppHandle, Emitter};

/// 与 `pip.rs` 的 `MAIN_WINDOW_LABEL` 同值（那边是 pub，直接复用）。
const MAIN_WINDOW_LABEL: &str = "main";

/// 下发到主窗口的事件名。前端 `services/agentWatch.ts` 里的常量必须与之一致。
pub const EVENT_AGENT_EVENT: &str = "agent://event";

/// 桥实际监听的端口（启动时固化，测试命令与设置页读它拼 hook 配置）。
static BRIDGE_PORT: AtomicU16 = AtomicU16::new(0);

/// 请求体上限：hook 的 stdin 里可能带整段对话上下文，必须挡住。
const MAX_BODY_BYTES: usize = 64 * 1024;

/// `message` 字段截断长度：卡片只展示摘要，足够且防止巨长字符串拖慢渲染。
const MAX_MESSAGE_CHARS: usize = 300;

/// 事件分类（与 agent-notifications 的通知类型对齐，覆盖三家智能体的语义）。
///
/// - `done`：任务完成（Claude Code Stop / TaskCompleted；Codex turn 完成；
///   Gemini turn 完成）。
/// - `action`：需要用户操作——权限审批、计划待批（Claude Code permission_prompt /
///   plan_ready；Codex PermissionRequest；Gemini 工具权限）。
/// - `question`：需要用户抉择——智能体在提问等待回答（Claude Code idle_prompt /
///   question；Codex request_user_input）。
/// - `error`：智能体出错中断（Claude Code API error / PostToolUseFailure）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    /// 事件类型：done / action / question / error。
    pub event_type: String,
    /// 智能体工具标识（hook 命令里写死，如 "claude-code" / "codex" / "gemini"）。
    pub agent: String,
    /// 事件摘要（展示用；已截断，不可信数据）。
    pub message: String,
    /// 项目目录名（hook 传 cwd 时填，用于卡片上区分"是哪个任务在叫我"）。
    pub project: Option<String>,
    /// 桥收到事件的本地时间戳（毫秒）。
    pub timestamp: u64,
}

/// 桥是否已启动（端口非 0 即已启动）。
pub fn bridge_port() -> u16 {
    BRIDGE_PORT.load(Ordering::Relaxed)
}

/// 在回环上找一个可用端口启动桥。端口被占时逐个后移，最多尝试 8 个。
///
/// ## 为什么整条链路都用 tokio 的 socket（2026-10-29 修的连接卡死）
///
/// 第一版用 `std::net::TcpListener`，`accept` 出来的是**阻塞模式** socket，
/// 再交给 `tokio::net::TcpStream::from_std`。而 `from_std` 的文档明确要求调用方
/// 自己保证非阻塞 —— 它**不会替你转**。后果：tokio 的 readiness 探测永远认为
/// "可读"，`read().await` 于是在 worker 线程上真阻塞住；一个 curl 打进来，
/// 连接建立、请求也收到了，但响应永远发不出去（实测 `curl` 超时 28、
/// PowerShell `Invoke-WebRequest` 超时）。改成 tokio 原生 listener 后，
/// 整个读写都在异步运行时里，问题消失。
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        for offset in 0..8u16 {
            let port = 7812u16.saturating_add(offset);
            let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
                Ok(listener) => listener,
                Err(_) => continue,
            };
            BRIDGE_PORT.store(port, Ordering::Relaxed);
            crate::trace::log(format!(
                "[agent-bridge] 智能体联动桥已启动：127.0.0.1:{port}"
            ));

            // 每个连接一个 task：一个慢请求不会堵住后续事件。
            loop {
                let (stream, _) = match listener.accept().await {
                    Ok(pair) => pair,
                    Err(_) => return, // 监听套接字出错（进程退出等），安静收尾
                };
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    handle_connection(stream, app).await;
                });
            }
        }
        crate::trace::log("[agent-bridge] 7812-7819 端口全部被占，联动桥未启动（不影响播放）");
    });
}

/// 处理单个连接：读一段 → 解析 → 回复 → 关闭。
///
/// 用手写的极简 HTTP 读法（读到空行 + Content-Length 或连接关闭）而不是引入
/// HTTP 框架：hook 命令全部是 `Invoke-RestMethod` / `curl` 一发即弃，没有 keep-alive、
/// 没有 chunked，零依赖足够；Cargo.toml 一个字节都不用加。
async fn handle_connection(mut stream: tokio::net::TcpStream, app: AppHandle) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // 读上限：头部 8KB + 体 64KB。超限按坏请求处理（读不完也无所谓——对端
    // 是 `async: true` 的 hook，不关心响应）。
    let mut buf: Vec<u8> = Vec::with_capacity(2048);
    let mut chunk = [0u8; 4096];
    let content_length = loop {
        if buf.len() > MAX_BODY_BYTES + 8192 {
            let _ = stream
                .write_all(b"HTTP/1.1 413 Payload Too Large\r\nContent-Length: 0\r\n\r\n")
                .await;
            return;
        }
        let n = match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => {
                // 连接关了还没给完头：可能是端口探测，直接静默。
                return;
            }
            Ok(n) => n,
        };
        buf.extend_from_slice(&chunk[..n]);
        // 头部齐了（找到 \r\n\r\n）就解析 Content-Length。
        if let Some(pos) = find_header_end(&buf) {
            let head = String::from_utf8_lossy(&buf[..pos]);
            let length = head
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    if name.trim().eq_ignore_ascii_case("content-length") {
                        value.trim().parse::<usize>().ok()
                    } else {
                        None
                    }
                })
                .unwrap_or(0);
            break length;
        }
    };
    let head_end = find_header_end(&buf).unwrap_or(buf.len());
    let head = String::from_utf8_lossy(&buf[..head_end]);
    let request_line = head.lines().next().unwrap_or("");
    let is_post = request_line.to_ascii_uppercase().contains("POST");

    /// 从请求行里取查询参数（`GET /event?type=done&agent=codex`）。
    ///
    /// ## 为什么主路径是"查询参数"而不是 JSON body
    ///
    /// hook 命令必须能在 **cmd、PowerShell、bash、zsh** 里都原样工作。JSON body
    /// 需要 `-d "{\"type\":\"done\"}"` 这种嵌套转义，而 cmd 不处理反斜杠转义、
    /// 单引号也不识别——同一个字符串在三家 shell 里会解析成三种东西，Windows
    /// 上直接变成非法 JSON（实测：curl 收到的是带反斜杠的字面量）。
    ///
    /// 查询参数没有这个问题：整个 URL 用一对双引号包住，三家 shell 行为一致，
    /// 也没有 `#`（cmd 不认注释语法，会被当成参数传给 curl）。
    fn query_param(request_line: &str, key: &str) -> Option<String> {
        let target = request_line.split_whitespace().nth(1)?;
        let query = target.split_once('?')?.1;
        for pair in query.split('&') {
            let (k, v) = pair.split_once('=')?;
            if k == key {
                return Some(percent_decode(v));
            }
        }
        None
    }

    // 极简百分号解码：只处理 %XX 与 +（够覆盖事件名、agent 标识与中文摘要）。
    fn percent_decode(input: &str) -> String {
        let bytes = input.as_bytes();
        let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            match bytes[i] {
                b'%' if i + 2 < bytes.len() => {
                    let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
                    match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                        Some(byte) => {
                            out.push(byte);
                            i += 3;
                        }
                        None => {
                            out.push(bytes[i]);
                            i += 1;
                        }
                    }
                }
                b'+' => {
                    out.push(b' ');
                    i += 1;
                }
                b => {
                    out.push(b);
                    i += 1;
                }
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    // 查询参数优先（推荐的、跨 shell 稳定的调用方式）。
    if let Some(event_type) = query_param(request_line, "type") {
        if matches!(
            event_type.as_str(),
            "done" | "action" | "question" | "error"
        ) {
            let agent = query_param(request_line, "agent").unwrap_or_else(|| "agent".into());
            let message = query_param(request_line, "message").unwrap_or_default();
            let project = query_param(request_line, "project");
            emit_event(&app, &event_type, &agent, &message, project);
            let _ = stream
                .write_all(
                    b"HTTP/1.1 204 No Content
Content-Length: 0
Connection: close

",
                )
                .await;
            return;
        }
    }

    if !is_post {
        let body = "TTV agent bridge is running. POST {\"type\":\"done\",\"agent\":\"test\"} to send an event.";
        let _ = stream.write_all(
            format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes(),
        ).await;
        return;
    }
    // 体读够为止（可能还在路上）。
    let body_start = head_end + 4;
    while buf.len() < body_start + content_length {
        let n = match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        if buf.len() + n > MAX_BODY_BYTES + body_start {
            break; // 超限：拿到的部分够解析了，不再读
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let body = &buf[body_start..(body_start + content_length).min(buf.len())];

    // 解析事件体：{ "type": "done", "agent": "claude-code", "message": "...", "project": "..." }
    let parsed: serde_json::Value = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(_) => {
            let _ = stream
                .write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
                .await;
            return;
        }
    };
    let event_type = parsed
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned();
    if !matches!(
        event_type.as_str(),
        "done" | "action" | "question" | "error"
    ) {
        let _ = stream
            .write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
            .await;
        return;
    }
    let agent = parsed
        .get("agent")
        .and_then(|v| v.as_str())
        .unwrap_or("agent")
        .chars()
        .take(40)
        .collect::<String>();
    let message: String = parsed
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .chars()
        .take(MAX_MESSAGE_CHARS)
        .collect();
    let project: Option<String> = parsed
        .get("project")
        .and_then(|v| v.as_str())
        .map(|s| s.chars().take(60).collect());

    emit_event(&app, &event_type, &agent, &message, project);

    let _ = stream
        .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        .await;
}

/// 构造并广播一条事件（查询参数与 JSON body 两条入参路径共用）。
fn emit_event(
    app: &AppHandle,
    event_type: &str,
    agent: &str,
    message: &str,
    project: Option<String>,
) {
    let event = AgentEvent {
        event_type: event_type.to_owned(),
        agent: agent.chars().take(40).collect(),
        message: message.chars().take(MAX_MESSAGE_CHARS).collect(),
        project: project.map(|p| p.chars().take(60).collect()),
        timestamp: now_millis(),
    };
    // 广播给主窗口。前端不在（窗口未建好/正在关闭）时 emit 会失败——桥的存在
    // 不依赖窗口，静默继续。
    let _ = app.emit_to(MAIN_WINDOW_LABEL, EVENT_AGENT_EVENT, &event);
    crate::trace::log(format!(
        "[agent-bridge] 事件 type={} agent={} project={:?}",
        event.event_type, event.agent, event.project
    ));
}

/// 找 `\r\n\r\n`（头部结束标记）。
fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

/// 桥状态（设置页展示用）。
#[tauri::command]
pub fn agent_bridge_status() -> serde_json::Value {
    serde_json::json!({ "port": bridge_port() })
}

/// 测试呼叫：设置页「发送测试事件」按钮用，直接广播一条 question 事件，
/// 让用户在不开智能体工具的情况下验证全链路（桥 → 事件 → 暂停 → 卡片）。
#[tauri::command]
pub fn agent_test_call(app: AppHandle, event_type: Option<String>) -> Result<(), String> {
    let event_type = event_type.unwrap_or_else(|| "question".into());
    if !matches!(
        event_type.as_str(),
        "done" | "action" | "question" | "error"
    ) {
        return Err("未知事件类型".into());
    }
    let event = AgentEvent {
        event_type,
        agent: "ttv-test".into(),
        message: "这是一条来自设置页的测试事件：联动链路工作正常。".into(),
        project: Some("测试".into()),
        timestamp: now_millis(),
    };
    app.emit_to(MAIN_WINDOW_LABEL, EVENT_AGENT_EVENT, &event)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    /// 头部结束标记查找：空缓冲、不完整头、完整头三种情况。
    #[test]
    fn finds_header_end_marker() {
        use super::find_header_end;
        assert!(find_header_end(b"").is_none());
        assert!(find_header_end(b"POST / HTTP/1.1\r\nContent-Len").is_none());
        let request = b"POST / HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}";
        // 头部 "POST / HTTP/1.1\r\nContent-Length: 2\r\n" 共 34 字节，
        // \r\n\r\n 的首字节即头部结束位置。
        assert_eq!(find_header_end(request), Some(34));
    }

    /// 事件体解析的核心规则（不依赖网络）：合法类型放行、非法类型拒收。
    #[test]
    fn event_type_whitelist() {
        for ok in ["done", "action", "question", "error"] {
            assert!(matches!(ok, "done" | "action" | "question" | "error"));
        }
        assert!(!matches!("plan", "done" | "action" | "question" | "error"));
    }
}
