//! 智能体自动接入引擎：识别本机已安装的智能体工具，并把「事件上报」的 hook
//! 自动写进它们各自的配置文件。
//!
//! ## 为什么必须是"自动写入"而不是"让用户自己粘贴"
//!
//! 用户的原话是"设置里只保留开关，不显示这种接入"。而现实是：本机装着 7 个以上
//! 智能体工具，每家的 hook 配置文件位置、JSON 结构、事件名都不一样。让用户逐个
//! 复制粘贴既不可行（12 个工具 × 3 类事件），也不可能正确（少一个引号整份配置就
//! 失效，甚至会让智能体启动失败）。
//!
//! 业界做法（Clawd on Desk / agent-notifications）都是**安装器写配置**，差别只在
//! 覆盖广度。这里照同一思路做，但坚持三条纪律：
//!
//! 1. **合并式写入，绝不覆盖**：只 append 我们自己的 hook 条目，用户已有的
//!    （如 `rtk hook claude`、orca 的 antigravity 钩子）原样保留；
//! 2. **写前备份**：首次改动某个文件前存一份 `<name>.ttv-backup`，可一键还原；
//! 3. **幂等**：靠命令里的 `ttv-agent-hook` 标记识别"这条是我加的"，重复接入
//!    不会越写越多。
//!
//! ## 覆盖范围
//!
//! 表里每一项都对应一个**官方支持 hook 的**智能体工具。没有 hook 机制的工具
//! （或 hook 只做权限决策、不支持事件通知的）不硬塞——那只会让智能体行为异常。
//! 这类工具用"进程探测"兜底（见 `detect_installed`）：能识别到它装了、能提示
//! 用户，但不假装能接管它的事件。

use serde::Serialize;
use std::path::{Path, PathBuf};

/// 写进每条 hook 命令里的标记：既用于幂等判定，也用于卸载时精确删除。
const MARKER: &str = "X-TTV-Agent: 1";
/// 早期版本写进 JSON body hook 的尾部标记；升级时要一起清理，避免同一事件重复上报。
const LEGACY_MARKER: &str = "ttv-agent-hook";

/// 一个受支持的智能体工具。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTarget {
    pub id: String,
    pub name: String,
    /// 配置文件绝对路径（不存在则视为"未安装"）。
    pub config_path: String,
    /// 配置文件是否存在。
    pub installed: bool,
    /// 是否已经接入（配置里能找到 MARKER）。
    pub connected: bool,
    /// 该工具的事件能力说明（给前端做"已接入 N 个"的统计）。
    pub events: Vec<String>,
    /// 无法接入时的原因（例如"该工具不支持事件 hook"）。
    pub note: Option<String>,
}

/// 接入结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachReport {
    pub targets: Vec<AgentTarget>,
    /// 本次实际写入成功的工具 id。
    pub attached: Vec<String>,
    /// 失败原因（工具 id → 原因）。
    pub failed: Vec<(String, String)>,
    /// 备份文件路径（写前快照，供还原）。
    pub backups: Vec<String>,
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// 桥端口写进命令里：端口漂移时配置会失效，所以每次接入都用**当前**端口重写。
///
/// ## 为什么是 URL 查询参数，不是 `-d '{json}'`（2026-10-29 实测踩坑）
///
/// hook 命令要能被 **cmd / PowerShell / bash / zsh** 原样执行。JSON body 需要
/// `-d "{\"type\":\"done\"}"` 这种嵌套转义：
/// - cmd **不处理反斜杠转义**，curl 收到的是字面量 `{\"type\"...}` → 非法 JSON；
/// - cmd 里单引号不是字符串定界符，`-d '{"a":1}'` 会被拆成多个参数。
///
/// 同一个字符串在三家 shell 里解析成三种结果，Windows 上必然坏。改成把参数放进
/// URL（整串用双引号包住，三家行为一致）后就没有转义问题了。
///
/// 注释也不能用 `#`：cmd 不认 `#`，它会连同后面内容一起当成 curl 的参数。
/// 幂等标记改用自定义请求头 `X-TTV-Agent: 1`——它是合法 HTTP 头，三家 shell 里
/// 都只是一个独立参数，且不会污染 JSON。
pub fn hook_command(port: u16, agent: &str, event_type: &str) -> String {
    format!(
        "curl -s -m 1 -o NUL -H \"X-TTV-Agent: 1\" \"http://127.0.0.1:{port}/event?type={event_type}&agent={agent}\""
    )
}

/// Claude Code 的 hook 条目（`hooks: { Event: [{ matcher?, hooks: [{type, command}] }] }`）。
fn agent_entry(
    port: u16,
    agent: &str,
    matcher: Option<&str>,
    event_type: &str,
) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    if let Some(m) = matcher {
        obj.insert("matcher".into(), serde_json::Value::String(m.into()));
    }
    obj.insert(
        "hooks".into(),
        serde_json::json!([{ "type": "command", "command": hook_command(port, agent, event_type), "async": true }]),
    );
    serde_json::Value::Object(obj)
}

fn claude_entry(port: u16, matcher: Option<&str>, event_type: &str) -> serde_json::Value {
    agent_entry(port, "claude-code", matcher, event_type)
}

/// 读取 JSON 文件（不存在返回空对象）。
fn read_json(path: &Path) -> Result<serde_json::Value, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            if text.trim().is_empty() {
                return Ok(serde_json::json!({}));
            }
            serde_json::from_str(&text)
                .map_err(|e| format!("配置文件不是合法 JSON（{e}），已跳过以免损坏它"))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(e) => Err(format!("读取失败：{e}")),
    }
}

/// 写前备份：只在**首次**改动该文件时备份（`.ttv-backup` 已存在就不覆盖，
/// 保住用户最原始的那一份）。
fn backup_once(path: &Path, backups: &mut Vec<String>) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let backup = path.with_extension(format!(
        "{}.ttv-backup",
        path.extension().and_then(|s| s.to_str()).unwrap_or("json")
    ));
    if backup.exists() {
        return Ok(());
    }
    std::fs::copy(path, &backup).map_err(|e| format!("备份失败：{e}"))?;
    backups.push(backup.to_string_lossy().to_string());
    Ok(())
}

/// 写入 JSON 文件：原子替换（先写临时文件再 rename），避免写一半断电留下坏配置。
fn write_json(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("ttv-tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("写入失败：{e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("替换失败：{e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 各智能体工具的接入实现
// ---------------------------------------------------------------------------

/// Claude Code：`~/.claude/settings.json`，事件 Stop / Notification(permission_prompt)
/// / Notification(idle_prompt)。
fn attach_claude(port: u16, backups: &mut Vec<String>) -> Result<(), String> {
    let path = home().join(".claude").join("settings.json");
    let mut root = read_json(&path)?;
    let hooks = root
        .as_object_mut()
        .ok_or("配置根不是对象")?
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));
    let hooks = hooks.as_object_mut().ok_or("hooks 不是对象")?;
    backup_once(&path, backups)?;

    // Stop：任务完成。
    push_hook(hooks, "Stop", claude_entry(port, None, "done"));
    // Notification：permission_prompt = 需要操作；idle_prompt = 需要抉择（已完成在等人）。
    push_hook(
        hooks,
        "Notification",
        claude_entry(port, Some("permission_prompt"), "action"),
    );
    push_hook(
        hooks,
        "Notification",
        claude_entry(port, Some("idle_prompt"), "question"),
    );
    // 出错中断也值得叫一声（限流 / 认证过期会让任务静默停下）。
    push_hook(hooks, "StopFailure", claude_entry(port, None, "error"));

    write_json(&path, &root)
}

/// 往某个事件的数组里追加一条 hook（同 matcher 已存在则跳过）。
fn push_hook(
    hooks: &mut serde_json::Map<String, serde_json::Value>,
    event: &str,
    entry: serde_json::Value,
) {
    let list = hooks
        .entry(event.to_string())
        .or_insert_with(|| serde_json::json!([]));
    let Some(arr) = list.as_array_mut() else {
        return;
    };
    // 幂等：同 matcher + 同命令就跳过（不靠"整个文件有 marker"判定，
    // 那样新增事件类型时会被误判成"已接入"而永远写不进去）。
    let key = serde_json::to_string(&entry).unwrap_or_default();
    let matcher = entry
        .get("matcher")
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let mut exact = false;
    arr.retain(|item| {
        let text = serde_json::to_string(item).unwrap_or_default();
        let is_ours = text.contains(MARKER) || text.contains(LEGACY_MARKER);
        let same_matcher = item
            .get("matcher")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            == matcher;
        if is_ours && same_matcher {
            if text == key && !exact {
                exact = true;
                true
            } else {
                false
            }
        } else {
            true
        }
    });
    if !exact {
        arr.push(entry);
    }
}

/// Codex CLI：`~/.codex/hooks.json`，与 Claude 同构（hooks.Event[].hooks[]）。
fn attach_codex(port: u16, backups: &mut Vec<String>) -> Result<(), String> {
    let path = home().join(".codex").join("hooks.json");
    let mut root = read_json(&path)?;
    let hooks = root
        .as_object_mut()
        .ok_or("配置根不是对象")?
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));
    let hooks = hooks.as_object_mut().ok_or("hooks 不是对象")?;
    backup_once(&path, backups)?;
    push_hook(hooks, "Stop", agent_entry(port, "codex", None, "done"));
    push_hook(
        hooks,
        "PermissionRequest",
        agent_entry(port, "codex", None, "action"),
    );
    write_json(&path, &root)
}

/// Gemini CLI：`~/.gemini/settings.json` 的 `hooks` 结构（与 Claude 同构的事件名）。
fn attach_gemini(port: u16, backups: &mut Vec<String>) -> Result<(), String> {
    let path = home().join(".gemini").join("settings.json");
    let mut root = read_json(&path)?;
    let hooks = root
        .as_object_mut()
        .ok_or("配置根不是对象")?
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));
    let hooks = hooks.as_object_mut().ok_or("hooks 不是对象")?;
    backup_once(&path, backups)?;
    push_hook(hooks, "AfterAgent", agent_entry(port, "gemini", None, "done"));
    write_json(&path, &root)
}

/// CodeBuddy / 通义等 Claude Code 兼容工具：settings.json 结构与 Claude 完全相同。
fn attach_claude_compatible(
    rel: &str,
    agent_id: &str,
    port: u16,
    backups: &mut Vec<String>,
) -> Result<(), String> {
    let path = home().join(rel);
    let mut root = read_json(&path)?;
    let hooks = root
        .as_object_mut()
        .ok_or("配置根不是对象")?
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));
    let hooks = hooks.as_object_mut().ok_or("hooks 不是对象")?;
    backup_once(&path, backups)?;
    let entry = agent_entry(port, agent_id, None, "done");
    push_hook(hooks, "Stop", entry);
    write_json(&path, &root)
}

/// GitHub Copilot CLI：官方生命周期事件使用 camelCase，`Stop` 不会触发。
fn attach_copilot(port: u16, backups: &mut Vec<String>) -> Result<(), String> {
    let path = home().join(".copilot").join("settings.json");
    let mut root = read_json(&path)?;
    let hooks = root
        .as_object_mut()
        .ok_or("配置根不是对象")?
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));
    let hooks = hooks.as_object_mut().ok_or("hooks 不是对象")?;
    backup_once(&path, backups)?;
    for (event, event_type) in [
        ("agentStop", "done"),
        ("errorOccurred", "error"),
        ("permissionRequest", "action"),
    ] {
        let command = format!("curl.exe -s -m 1 -o NUL -H \"{MARKER}\" \"http://127.0.0.1:{port}/event?type={event_type}&agent=copilot\"");
        let list = hooks.entry(event.to_string()).or_insert_with(|| serde_json::json!([]));
        let arr = list.as_array_mut().ok_or_else(|| format!("{event} 不是数组"))?;
        let entry = serde_json::json!({ "type": "command", "command": command });
        let key = serde_json::to_string(&entry).unwrap_or_default();
        let mut exact = false;
        arr.retain(|item| {
            let text = serde_json::to_string(item).unwrap_or_default();
            if text.contains(MARKER) || text.contains(LEGACY_MARKER) {
                if text == key && !exact {
                    exact = true;
                    true
                } else {
                    false
                }
            } else {
                true
            }
        });
        if !exact {
            arr.push(entry);
        }
    }
    write_json(&path, &root)
}

/// Cursor CLI：官方 hooks.json 是扁平 `{ command }` 数组，不是 Claude 的嵌套结构。
fn attach_cursor(port: u16, backups: &mut Vec<String>) -> Result<(), String> {
    let path = home().join(".cursor").join("hooks.json");
    let mut root = read_json(&path)?;
    let root_obj = root.as_object_mut().ok_or("配置根不是对象")?;
    backup_once(&path, backups)?;
    root_obj.entry("version").or_insert_with(|| serde_json::json!(1));
    for event in ["stop"] {
        let list = root_obj
            .entry(event.to_string())
            .or_insert_with(|| serde_json::json!([]));
        let arr = list
            .as_array_mut()
            .ok_or_else(|| format!("{event} 不是数组"))?;
        let command = hook_command(port, "cursor", "done");
        let key = serde_json::json!({ "command": command });
        let key_text = serde_json::to_string(&key).unwrap_or_default();
        arr.retain(|item| {
            let text = serde_json::to_string(item).unwrap_or_default();
            !(text.contains(MARKER) || text.contains(LEGACY_MARKER)) || text == key_text
        });
        if !arr
            .iter()
            .any(|item| serde_json::to_string(item).unwrap_or_default() == key_text)
        {
            arr.push(key);
        }
    }
    write_json(&path, &root)
}

const OPENCODE_PLUGIN: &str = r#"// X-TTV-Agent: 1
export const TTVAgentNotify = async ({ project, directory }) => ({
  event: async ({ event }) => {
    const types = {
      "session.idle": "done",
      "session.error": "error",
      "permission.asked": "action",
    };
    const type = types[event.type];
    if (!type) return;
    const projectName = project?.name || directory?.split(/[\\/]/).filter(Boolean).pop() || "";
    const query = new URLSearchParams({ type, agent: "opencode", project: projectName });
    try { await fetch(`http://127.0.0.1:7812/event?${query}`); } catch {}
  },
});
"#;

fn opencode_plugin_path() -> PathBuf {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".config"));
    config.join("opencode").join("plugins").join("ttv-agent-notify.js")
}

fn attach_opencode(_port: u16, backups: &mut Vec<String>) -> Result<(), String> {
    let path = opencode_plugin_path();
    if path.exists() {
        let text = std::fs::read_to_string(&path).map_err(|e| format!("读取插件失败：{e}"))?;
        if !text.contains(MARKER) {
            return Err("同名 OpenCode 插件已存在，未覆盖".into());
        }
        backup_once(&path, backups)?;
    }
    let parent = path.parent().ok_or("插件目录无效")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("创建插件目录失败：{e}"))?;
    let tmp = path.with_extension("ttv-tmp");
    std::fs::write(&tmp, OPENCODE_PLUGIN).map_err(|e| format!("写入插件失败：{e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("替换插件失败：{e}"))?;
    Ok(())
}

/// 受支持的智能体工具注册表（顺序即设置页的展示顺序，但界面上不展示明细）。
fn targets(port: u16) -> Vec<AgentTarget> {
    let h = home();
    let mut list = Vec::new();

    let mut push =
        |id: &str, name: &str, config: PathBuf, events: Vec<&str>, note: Option<&str>| {
            let installed = config.exists()
                || (id == "opencode"
                    && config
                        .parent()
                        .and_then(Path::parent)
                        .map(Path::exists)
                        .unwrap_or(false));
            let connected = installed
                && std::fs::read_to_string(&config)
                    .map(|t| t.contains(MARKER) || t.contains(LEGACY_MARKER))
                    .unwrap_or(false);
            list.push(AgentTarget {
                id: id.into(),
                name: name.into(),
                config_path: config.to_string_lossy().to_string(),
                installed,
                connected,
                events: events.into_iter().map(str::to_string).collect(),
                note: note.map(str::to_string),
            });
        };
    let _ = port;

    push(
        "claude-code",
        "Claude Code",
        h.join(".claude/settings.json"),
        vec![
            "Stop",
            "Notification(permission_prompt)",
            "Notification(idle_prompt)",
            "StopFailure",
        ],
        None,
    );
    push(
        "codex",
        "Codex CLI",
        h.join(".codex/hooks.json"),
        vec!["Stop", "PermissionRequest"],
        None,
    );
    push(
        "gemini",
        "Gemini CLI",
        h.join(".gemini/settings.json"),
        vec!["AfterAgent"],
        None,
    );
    push(
        "codebuddy",
        "CodeBuddy",
        h.join(".codebuddy/settings.json"),
        vec!["Stop"],
        None,
    );
    push(
        "cursor",
        "Cursor CLI",
        h.join(".cursor/hooks.json"),
        vec!["stop"],
        None,
    );
    push(
        "qwen",
        "Qwen Code",
        h.join(".qwen/settings.json"),
        vec!["Stop"],
        None,
    );
    push(
        "kimi",
        "Kimi Code",
        h.join(".kimi/config.toml"),
        vec!["hooks"],
        Some("TOML 配置，暂只识别不自动写入"),
    );
    push(
        "grok",
        "Grok",
        h.join(".grok/hooks/ttv-agent-hook.json"),
        vec!["Stop"],
        None,
    );
    push(
        "dsh",
        "DSH (DeepSeek Harness)",
        h.join(".dsh/dsh-settings.json"),
        vec!["Stop"],
        Some("DSH 用进程内插件，暂只识别不自动写入"),
    );
    push(
        "zcode",
        "ZCode",
        h.join(".zcode/cli/config.json"),
        vec!["hooks"],
        Some("ZCode 的 hook 在设置界面里配置，暂只识别"),
    );
    push(
        "opencode",
        "OpenCode",
        opencode_plugin_path(),
        vec!["session.idle", "session.error", "permission.asked"],
        None,
    );
    push(
        "copilot",
        "GitHub Copilot",
        h.join(".copilot/settings.json"),
        vec!["agentStop", "errorOccurred", "permissionRequest"],
        None,
    );
    push(
        "kiro",
        "Kiro CLI",
        h.join(".kiro/agents/ttv.json"),
        vec!["Stop"],
        Some("自定义 agent，暂只识别"),
    );

    list
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

/// 列出本机智能体工具的接入状态（设置页只用来显示"已自动接入 N 个"）。
#[tauri::command]
pub fn agent_targets(port: u16) -> Vec<AgentTarget> {
    targets(port)
}

/// 一键自动接入：把所有**已安装且支持自动写入**的工具接上。
///
/// 幂等：已有我们的条目就跳过；端口变了会就地更新命令。
#[tauri::command]
pub fn agent_attach_all(port: u16) -> AttachReport {
    let mut backups = Vec::new();
    let mut attached = Vec::new();
    let mut failed: Vec<(String, String)> = Vec::new();

    let jobs: Vec<(&str, fn(u16, &mut Vec<String>) -> Result<(), String>)> = vec![
        (
            "claude-code",
            attach_claude as fn(u16, &mut Vec<String>) -> Result<(), String>,
        ),
        ("codex", attach_codex),
        ("gemini", attach_gemini),
        ("copilot", attach_copilot),
        ("cursor", attach_cursor),
        ("grok", |p, b| {
            attach_claude_compatible(".grok/hooks/ttv-agent-hook.json", "grok", p, b)
        }),
        ("codebuddy", |p, b| {
            attach_claude_compatible(".codebuddy/settings.json", "codebuddy", p, b)
        }),
        ("qwen", |p, b| {
            attach_claude_compatible(".qwen/settings.json", "qwen", p, b)
        }),
    ];
    // 只对"配置目录已存在"的工具动手：给没装的工具凭空造配置目录，轻则无意义，
    // 重则让它的启动流程走到一个半成品配置上。
    let home_dir = home();
    for (id, job) in jobs {
        let config_exists = match id {
            "claude-code" => home_dir.join(".claude").exists(),
            "codex" => home_dir.join(".codex").exists(),
            "gemini" => home_dir.join(".gemini").exists(),
            "copilot" => home_dir.join(".copilot").exists(),
            "cursor" => home_dir.join(".cursor").exists(),
            "grok" => home_dir.join(".grok").exists(),
            "codebuddy" => home_dir.join(".codebuddy").exists(),
            "qwen" => home_dir.join(".qwen").exists(),
            _ => false,
        };
        if !config_exists {
            continue;
        }
        match job(port, &mut backups) {
            Ok(()) => attached.push(id.to_string()),
            Err(e) => failed.push((id.to_string(), e)),
        }
    }

    AttachReport {
        targets: targets(port),
        attached,
        failed,
        backups,
    }
}

/// 断开：把所有我们写的条目从配置里摘干净（用户关掉开关时调用）。
#[tauri::command]
pub fn agent_detach_all() -> Vec<String> {
    let mut cleaned = Vec::new();
    let files = [
        ".claude/settings.json",
        ".codex/hooks.json",
        ".gemini/settings.json",
        ".cursor/hooks.json",
        ".codebuddy/settings.json",
        ".copilot/hooks/hooks.json",
        ".grok/hooks/ttv-agent-hook.json",
        ".qwen/settings.json",
    ];
    for rel in files {
        let path = home().join(rel);
        if !path.exists() {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        if !text.contains(MARKER) && !text.contains(LEGACY_MARKER) {
            continue;
        }
        let Ok(mut root) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        if strip_marker(&mut root).0 {
            if write_json(&path, &root).is_ok() {
                cleaned.push(rel.to_string());
            }
        }
    }
    cleaned
}

/// 递归摘掉含标记的条目，并清掉**因我们删除而变空**的容器。
///
/// 返回 `(changed, should_drop)`：
/// - `changed`：这棵子树里有没有真的删掉东西；
/// - `should_drop`：这棵子树是否应该从父容器里整体摘掉。
///
/// ## 为什么要后序 + 带 should_drop（2026-10-29 修的 bug）
///
/// 先序剪枝会留下空壳：`{ hooks: [ {type,command} ] }` 里的数组被清空后，
/// 外层对象变成 `{}`，而 `{}` 本身不含标记 —— 于是它被当成"用户的数据"保留，
/// 空数组也就永远判不成空。最终 `Stop` 事件里堆着一个 `{}`，智能体读到会报
/// schema 错。这里改成"子节点先剪、剪空了就连父节点一起摘"，并且只在
/// **本次确实动过**的容器上摘（用户自己原本就存在的空数组保持原样）。
fn strip_marker(value: &mut serde_json::Value) -> (bool, bool) {
    match value {
        serde_json::Value::Object(map) => {
            let keys: Vec<String> = map.keys().cloned().collect();
            let mut changed = false;
            for key in keys {
                let drop_child = match map.get_mut(&key) {
                    Some(child) => {
                        let (child_changed, drop) = strip_marker(child);
                        changed |= child_changed;
                        drop
                    }
                    None => false,
                };
                if drop_child {
                    map.remove(&key);
                    changed = true;
                }
            }
            (changed, changed && map.is_empty())
        }
        serde_json::Value::Array(arr) => {
            let mut changed = false;
            // 逐项剪：既要摘掉"自己含标记"的项，也要摘掉"子节点被剪空"的项
            // （后者可能是个 `{}` 空壳，它本身不含标记，只看标记会漏掉）。
            let mut kept: Vec<serde_json::Value> = Vec::with_capacity(arr.len());
            for mut item in std::mem::take(arr) {
                let (child_changed, drop) = strip_marker(&mut item);
                changed |= child_changed;
                let text = serde_json::to_string(&item).unwrap_or_default();
                let is_ours = text.contains(MARKER) || text.contains(LEGACY_MARKER);
                if drop || is_ours {
                    changed = true;
                    continue;
                }
                kept.push(item);
            }
            *arr = kept;
            (changed, changed && arr.is_empty())
        }
        _ => (false, false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 幂等：同一份配置写两次，条目数不变。
    #[test]
    fn push_hook_is_idempotent() {
        let mut hooks = serde_json::Map::new();
        let entry = claude_entry(7812, None, "done");
        push_hook(&mut hooks, "Stop", entry.clone());
        push_hook(&mut hooks, "Stop", entry);
        let arr = hooks.get("Stop").and_then(|v| v.as_array()).unwrap();
        assert_eq!(arr.len(), 1, "重复接入不能越写越多");
    }

    /// 端口变化时旧条目被替换而不是叠加。
    #[test]
    fn push_hook_replaces_on_port_change() {
        let mut hooks = serde_json::Map::new();
        push_hook(&mut hooks, "Stop", claude_entry(7812, None, "done"));
        push_hook(&mut hooks, "Stop", claude_entry(7813, None, "done"));
        let arr = hooks.get("Stop").and_then(|v| v.as_array()).unwrap();
        assert_eq!(arr.len(), 1, "端口变了应该就地更新，不是叠加");
        assert!(serde_json::to_string(arr).unwrap().contains("7813"));
    }

    /// 剥离：我们写的条目被摘掉，用户自己的条目保留。
    #[test]
    fn strip_keeps_user_entries() {
        let mut root = serde_json::json!({
            "hooks": {
                "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "rtk hook claude" }] }],
                "Stop": [{ "hooks": [{ "type": "command", "command": hook_command(7812, "claude-code", "done") }] }]
            }
        });
        assert!(strip_marker(&mut root).0);
        let text = serde_json::to_string(&root).unwrap();
        assert!(text.contains("rtk hook claude"), "用户自己的 hook 必须保留");
        assert!(!text.contains(MARKER), "我们的标记必须被摘掉");
        assert!(
            root["hooks"].get("Stop").is_none(),
            "空的 Stop 数组应被清理"
        );
    }

    /// 命令里必须带 1 秒超时：hook 不能拖住智能体。
    #[test]
    fn hook_command_has_timeout_and_marker() {
        let cmd = hook_command(7812, "claude-code", "done");
        assert!(cmd.contains("-m 1"));
        assert!(cmd.contains(MARKER));
        assert!(cmd.contains("http://127.0.0.1:7812/"));
    }
}
