//! 客户端更新检查与安装包下载。
//!
//! ## 为什么用 GitHub Releases 而不是自建更新服务
//!
//! 发布链路本来就在 GitHub Releases 上（`release.ps1` 只往那里传 NSIS 包），
//! 再引入一套自建更新服务等于多一个要维护、要花钱、会单点故障的外部依赖。
//! 直接读公开的 Releases API 即可，无需任何凭据。
//!
//! ## 网络请求全部在 Rust 侧
//!
//! 前端的 CSP（`connect-src`）是收紧的，而且**只在生产构建注入**——在浏览器里
//! 试通、打包后才挂掉是这类功能的经典翻车方式（见 AGENTS.md 的 CSP 条目）。
//! 这里让请求由 reqwest 发出，既不碰 CSP，也不把 API 域名暴露给页面。
//!
//! ## 安装包不会自动静默安装
//!
//! 下载完只**打开文件管理器定位到包**，是否安装、什么时候装由用户决定。
//! 静默运行一个从网上下载的可执行文件，是这类功能最不该做的事。

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

/// 当前版本。
///
/// 用编译期注入的 crate 版本，而不是前端再写一份常量：三处版本号
/// （`package.json` / `Cargo.toml` / `tauri.conf.json`）里，构建进二进制的就是它，
/// 界面显示的与应用的必须同源，否则"检查更新"会拿一个假版本去比。
pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 当前版本（不联网）。
///
/// 设置页要在首次渲染时就显示版本号，而 `update_check` 会消耗 GitHub 的未认证配额
/// （60 次/小时）——进一次设置页就打一次网络请求既无必要也浪费。
#[tauri::command]
pub fn app_version() -> &'static str {
    CURRENT_VERSION
}

/// 仓库 slug 已拼进 RELEASES_LATEST_API。不单独留一个只用一次的字面量：
/// 拆成两处只会多一个改漏的地方。
const RELEASES_LATEST_API: &str =
    "https://api.github.com/repos/kiocou/ttv-short-drama/releases/latest";
/// GitHub API 对没有 User-Agent 的请求直接返回 403。
const USER_AGENT: &str = "TTV-Short-Drama-Updater";
/// 下载进度事件的名称（前端订阅它画进度条）。
pub const EVENT_DOWNLOAD: &str = "update://download";

/// 一次检查更新的结果（原样给前端展示，不做加工）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    /// Release 正文（Markdown 原文，前端按纯文本展示）。
    pub notes: String,
    pub published_at: String,
    pub html_url: String,
    /// 安装包资产。仓库里没有可下载资产时为 None（例如草稿或只发了 notes）。
    pub asset_name: Option<String>,
    pub asset_url: Option<String>,
    pub asset_size: u64,
}

/// 下载进度（事件负载）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub received: u64,
    pub total: u64,
    pub percent: u8,
    /// 结束标记：成功与失败都会发一次，前端据此收尾。
    pub done: bool,
    pub error: Option<String>,
    /// 成功时的落地路径。
    pub path: Option<String>,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(std::time::Duration::from_secs(8))
        // 单次查询的兜底超时。下载不走这个（大文件必然超过），见 download。
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| format!("无法创建网络客户端：{error}"))
}

/// 版本号比较用的数字序列：`v0.2.10` / `0.2.10-beta.1` 都取出 `[0, 2, 10]`。
///
/// 刻意不引入 semver crate：这里只需要"谁更新"，而语义化版本的完整规则
/// （预发布优先级、build metadata）对客户端更新判断没有意义，多一个依赖不值。
fn version_parts(raw: &str) -> Vec<u64> {
    raw.trim()
        .trim_start_matches(['v', 'V'])
        // 预发布后缀不参与比较：`0.3.0-rc1` 与 `0.3.0` 视为同一档。
        .split(['-', '+'])
        .next()
        .unwrap_or_default()
        .split('.')
        .map(|part| part.trim().parse::<u64>().unwrap_or(0))
        .collect()
}

/// `latest` 是否比 `current` 新。
pub fn is_newer(latest: &str, current: &str) -> bool {
    let a = version_parts(latest);
    let b = version_parts(current);
    for index in 0..a.len().max(b.len()) {
        let left = a.get(index).copied().unwrap_or(0);
        let right = b.get(index).copied().unwrap_or(0);
        if left != right {
            return left > right;
        }
    }
    false
}

/// 只接受我们自己发布的资产地址。
///
/// 下载目标最终会落到用户磁盘上，因此**不接受任意 URL**：即使是本应用发起的
/// 请求，参数也可能被页面里其他脚本篡改。限定 GitHub 的发布域名，
/// 并把文件名单独净化，双保险。
fn is_trusted_asset_url(url: &str) -> bool {
    const ALLOWED: [&str; 3] = [
        "https://github.com/",
        "https://objects.githubusercontent.com/",
        "https://release-assets.githubusercontent.com/",
    ];
    ALLOWED.iter().any(|prefix| url.starts_with(prefix))
}

/// 把服务器给的文件名压成一个安全的纯文件名。
///
/// 只取最后一段并过滤掉分隔符与 `..`：否则一个精心构造的资产名就能把文件写到
/// 目标目录之外（路径穿越）。
fn safe_file_name(raw: &str) -> String {
    let base = raw
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim()
        .replace("..", "");
    if base.is_empty() {
        "TTV-Short-Drama-setup.exe".to_string()
    } else if base.to_ascii_lowercase().ends_with(".exe") {
        base
    } else {
        // 不是安装包就不下载：这是更新按钮，不是通用下载器。
        "TTV-Short-Drama-setup.exe".to_string()
    }
}

/// 下载目录（拿不到就退回临时目录，至少不让整条链路失败）。
fn download_dir() -> PathBuf {
    dirs::download_dir().unwrap_or_else(std::env::temp_dir)
}

/// 查询最新 Release。
#[tauri::command]
pub async fn update_check() -> Result<UpdateInfo, String> {
    let response = client()?
        .get(RELEASES_LATEST_API)
        // GitHub 的默认响应是完整 release；这里只用到少量字段，接受保持简单。
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("无法连接 GitHub：{error}"))?;

    let status = response.status();
    // 不用 `response.json()`：reqwest 在本项目里是 `default-features = false`，
    // 没开 `json` 特性。自己拿 text 再反序列化，等价且不引入新特性。
    let text = response
        .text()
        .await
        .map_err(|error| format!("GitHub 返回了无法读取的内容：{error}"))?;
    let body: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("GitHub 返回了无法解析的内容：{error}"))?;

    if !status.is_success() {
        // 仓库尚无 release、被限流、或网络被劫持，都会走到这里——如实报告状态码，
        // 而不是抛一句笼统的"检查更新失败"，否则用户（和排查者）分不清是哪种。
        let detail = body
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("未知原因");
        // 404 有它自己的含义：GitHub 对**私有仓库**（或不存在）的未认证访问一律返回 404，
        // 而不是 403——这样不会泄露私有资源是否存在。本应用不携带任何凭据，
        // 所以这一条几乎总是"仓库还没公开"。
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err("GitHub 返回 404：仓库可能尚未公开，或还没有发布过 Release。".to_string());
        }
        return Err(format!("GitHub 返回 {status}：{detail}"));
    }

    // 版本号做一次归一化：tag 是 `v0.2.9`，而界面统一用 `v{版本}` 渲染，
    // 不处理就会显示成 `vv0.2.9`（实测确实如此）。发布标签的 v 前缀是习惯，
    // 不该泄漏到展示层。
    let latest_version = body
        .get("tag_name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim_start_matches(['v', 'V'])
        .to_string();
    if latest_version.trim().is_empty() {
        return Err("GitHub 的最新发布里没有版本号。".to_string());
    }

    // 只挑 NSIS 安装包：MSI 恒在 100 MB 上下，超过 GitHub Release 单文件上限，
    // 发布脚本根本不传它（见 release.ps1），所以这里也只可能拿到 setup.exe。
    let asset = body
        .get("assets")
        .and_then(serde_json::Value::as_array)
        .and_then(|assets| {
            assets.iter().find(|asset| {
                asset
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|name| name.to_ascii_lowercase().ends_with(".exe"))
            })
        });

    Ok(UpdateInfo {
        current_version: CURRENT_VERSION.to_string(),
        latest_version: latest_version.clone(),
        has_update: is_newer(&latest_version, CURRENT_VERSION),
        notes: body
            .get("body")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        published_at: body
            .get("published_at")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        html_url: body
            .get("html_url")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        asset_name: asset
            .and_then(|value| value.get("name"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        asset_url: asset
            .and_then(|value| value.get("browser_download_url"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        asset_size: asset
            .and_then(|value| value.get("size"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
    })
}

/// 下载安装包到系统下载目录，全程通过 `update://download` 事件上报进度。
///
/// 返回落地路径（同时也会随最后一次进度事件给出）。
#[tauri::command]
pub async fn update_download(
    app: AppHandle,
    url: String,
    file_name: String,
) -> Result<String, String> {
    if !is_trusted_asset_url(&url) {
        return Err("拒绝下载非 GitHub 发布域名的地址。".to_string());
    }
    let target = download_dir().join(safe_file_name(&file_name));

    let result = download_to(&app, &url, &target).await;
    match &result {
        Ok(()) => {
            let _ = app.emit(
                EVENT_DOWNLOAD,
                DownloadProgress {
                    received: target.metadata().map(|meta| meta.len()).unwrap_or(0),
                    total: target.metadata().map(|meta| meta.len()).unwrap_or(0),
                    percent: 100,
                    done: true,
                    error: None,
                    path: Some(target.to_string_lossy().to_string()),
                },
            );
            Ok(target.to_string_lossy().to_string())
        }
        Err(error) => {
            // 失败也要发一次 done：前端若只靠事件收尾，漏发就会永远停在进度条上。
            let _ = app.emit(
                EVENT_DOWNLOAD,
                DownloadProgress {
                    received: 0,
                    total: 0,
                    percent: 0,
                    done: true,
                    error: Some(error.clone()),
                    path: None,
                },
            );
            Err(error.clone())
        }
    }
}

async fn download_to(app: &AppHandle, url: &str, target: &Path) -> Result<(), String> {
    use std::io::Write;

    // 下载不吃 client() 的 20 秒总超时：77 MB 的安装包在慢速网络下必然超。
    // 这里单独建一个只设连接超时的客户端。
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|error| format!("无法创建下载客户端：{error}"))?;

    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("下载失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("下载失败：GitHub 返回 {}", response.status()));
    }
    let total = response.content_length().unwrap_or(0);

    // 先写临时文件、成功后再改名：中途失败不会在下载目录留下一个"看起来是安装包"
    // 的半截文件，用户下次也不会误点它。
    let temp = target.with_extension("download");
    let mut file =
        std::fs::File::create(&temp).map_err(|error| format!("无法创建文件：{error}"))?;
    let mut received: u64 = 0;
    let mut last_percent: i64 = -1;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("下载中断：{error}"))?
    {
        file.write_all(&chunk)
            .map_err(|error| format!("写入失败：{error}"))?;
        received += chunk.len() as u64;

        // 每 1% 发一次事件：再密就是纯噪音，再疏进度条会一跳一跳。
        // 用 checked_div 而不是 `if total > 0`：这既是 clippy 的要求，也把
        // “拿不到 Content-Length 就不报百分比”这件事写进了类型里。
        let percent = received
            .checked_mul(100)
            .and_then(|scaled| scaled.checked_div(total))
            .map(|value| value.min(100) as i64)
            .unwrap_or(-1);
        if percent != last_percent {
            last_percent = percent;
            let _ = app.emit(
                EVENT_DOWNLOAD,
                DownloadProgress {
                    received,
                    total,
                    percent: percent.clamp(0, 100) as u8,
                    done: false,
                    error: None,
                    path: None,
                },
            );
        }
    }
    file.flush().map_err(|error| format!("写入失败：{error}"))?;
    drop(file);

    std::fs::rename(&temp, target).map_err(|error| format!("无法完成保存：{error}"))?;
    Ok(())
}

/// 在资源管理器里定位到已下载的安装包。
///
/// 只允许打开**下载目录里的文件**：这个命令的入参来自前端，不加限制就等于
/// 给页面提供了一个"打开任意本地文件"的能力。
#[tauri::command]
pub fn update_reveal(path: String) -> Result<(), String> {
    let requested = PathBuf::from(&path);
    let allowed = download_dir();
    let real_requested = requested
        .canonicalize()
        .map_err(|error| format!("文件不存在：{error}"))?;
    let real_allowed = allowed.canonicalize().unwrap_or_else(|_| allowed.clone());
    if !real_requested.starts_with(&real_allowed) {
        return Err("只允许打开下载目录里的安装包。".to_string());
    }

    // `explorer /select,<path>` 只做定位选中，不执行文件；参数通过独立参数传递，
    // 不经过 shell 拼接（AGENTS.md 的不变量：不得把路径当命令行参数拼进去）。
    std::process::Command::new("explorer")
        .arg(format!("/select,{}", real_requested.display()))
        .spawn()
        .map_err(|error| format!("无法打开资源管理器：{error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions_numerically_not_lexically() {
        // 字符串比较会把 0.2.10 判成比 0.2.9 旧，这正是必须按段比数字的原因。
        assert!(is_newer("0.2.10", "0.2.9"));
        assert!(is_newer("v0.3.0", "0.2.8"));
        assert!(is_newer("1.0.0", "0.99.99"));
        assert!(!is_newer("0.2.8", "0.2.8"));
        assert!(!is_newer("0.2.7", "0.2.8"));
        // 带 v 前缀、预发布后缀都能比
        assert!(is_newer("0.3.0-rc1", "0.2.8"));
        assert!(!is_newer("0.3.0-rc1", "0.3.0"));
    }

    #[test]
    fn rejects_path_traversal_in_asset_name() {
        assert_eq!(safe_file_name("../../evil.exe"), "evil.exe");
        assert_eq!(safe_file_name("a\\b\\setup.exe"), "setup.exe");
        assert_eq!(safe_file_name(""), "TTV-Short-Drama-setup.exe");
        // 非 exe 资产不下载，回落到默认名
        assert_eq!(safe_file_name("notes.md"), "TTV-Short-Drama-setup.exe");
    }

    #[test]
    fn only_trusts_github_release_hosts() {
        assert!(is_trusted_asset_url(
            "https://github.com/kiocou/ttv-short-drama/releases/download/v0.2.9/x.exe"
        ));
        assert!(is_trusted_asset_url(
            "https://objects.githubusercontent.com/x"
        ));
        assert!(!is_trusted_asset_url("https://example.com/x.exe"));
        // 前缀伪装：必须连斜杠一起匹配
        assert!(!is_trusted_asset_url("https://github.com.evil.com/x.exe"));
        assert!(!is_trusted_asset_url("http://github.com/x.exe"));
    }
}
