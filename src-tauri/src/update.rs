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
//! ## 安装包会自动静默安装
//!
//! 下载完成后**直接启动安装器（`/S` 静默）并退出本应用**，用户全程零操作。
//!
//! 这是 2026-10 改的设计决策（原先是「只定位到下载目录，由用户自己点」）：
//! 「下载完还要自己找文件、自己双击」对更新流程来说是纯粹的手工活，而本项目所有用户都是
//! 从站内取内容的普通用户，不会有人主动去翻下载目录。
//!
//! 静默运行从网上下载的可执行文件确实不是好习惯，所以这里把风险收紧到可接受：
//!   - 资产域名白名单 + 文件名单独净化（见 `is_trusted_asset_url` / `safe_file_name`），
//!     且本次执行的文件路径必须**仍落在下载目录内**（与 `update_reveal` 同一道校验）；
//!   - 只接受 `.exe`，且校验 MZ 文件头与最小体积，避免把空文件/占位文件当安装器跑；
//!   - 启动失败不静默：返回错误，前端回落成「打开文件夹」并如实提示。
//!
//! 安装器本身是 NSIS 的 `/S`，它会自己处理「等待旧进程退出」；本应用退出只是让文件
//! 句柄尽早释放，避免安装器写不进去。
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
/// 读取 Windows「Internet 设置」里的系统代理，转成 reqwest 的 Proxy。
///
/// ## 为什么必须自己读
///
/// reqwest **只认 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量，不读注册表**；而 PowerShell、浏览器、
/// 以及绝大多数下载工具走的都是系统代理。两者不一致就会得到很迷惑的现象：本机实测开着
/// 本地代理 `127.0.0.1:10808` 时，`api.github.com` 的请求直连能通（所以"检查更新"看起来
/// 正常），但 release 资产的下载域名 `objects.githubusercontent.com` 直连失败，报
/// `error sending request`——**同一个地址用 PowerShell 下载却有 4.88 MB/s**。
///
/// 起初只给下载器补这一手，理由是「其他链路都是国内源」。**该结论 2026-09 被实测推翻**：
/// 动漫兜底源（暴风）的封面域名 `img.bfzypic.com` 与播放域名 `p.bvvvvvvvvv1f.com` 都
/// 解析到 `193.148.95.x`（境外 IP），只有 API 域名 `bfzyapi.com` 走 Cloudflare。现象极具
/// 迷惑性：同一台机器上红果短剧正常、动漫列表也能出来（API 通），唯独封面一张不剩、
/// 播放也起不来（境外 IP 直连超时）——差异全在「有没有走系统代理」。所以业务侧的
/// reqwest 统一改走 `with_system_proxy`。
///
/// 返回 http / https 两个方向（配置里可能只写了一个）。
#[cfg(not(windows))]
fn system_proxy() -> Option<Vec<reqwest::Proxy>> {
    None
}
#[cfg(windows)]
fn system_proxy() -> Option<Vec<reqwest::Proxy>> {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY_CURRENT_USER, KEY_READ, REG_DWORD,
        REG_SZ,
    };

    /// 读一个值；不存在或类型不符都返回 None（代理是可选配置，读不到就当没设）。
    fn read_value(
        key: windows_sys::Win32::System::Registry::HKEY,
        name: &str,
    ) -> Option<(u32, Vec<u8>)> {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let mut kind: u32 = 0;
        let mut size: u32 = 0;
        // 先探长度（传空指针），拿到后再分配。
        let status = unsafe {
            RegQueryValueExW(
                key,
                wide.as_ptr(),
                std::ptr::null_mut(),
                &mut kind,
                std::ptr::null_mut(),
                &mut size,
            )
        };
        if status != 0 || size == 0 {
            return None;
        }
        let mut buffer = vec![0u8; size as usize];
        let status = unsafe {
            RegQueryValueExW(
                key,
                wide.as_ptr(),
                std::ptr::null_mut(),
                &mut kind,
                buffer.as_mut_ptr(),
                &mut size,
            )
        };
        if status != 0 {
            return None;
        }
        Some((kind, buffer))
    }

    let sub_key: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    let mut key: windows_sys::Win32::System::Registry::HKEY = std::ptr::null_mut();
    let status =
        unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, sub_key.as_ptr(), 0, KEY_READ, &mut key) };
    if status != 0 {
        return None;
    }

    let enabled = read_value(key, "ProxyEnable")
        .filter(|(kind, bytes)| *kind == REG_DWORD && bytes.len() >= 4)
        .map(|(_, bytes)| u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
        .unwrap_or(0)
        != 0;

    let server = read_value(key, "ProxyServer")
        .filter(|(kind, _)| *kind == REG_SZ)
        .map(|(_, bytes)| {
            // REG_SZ 是 UTF-16LE，去掉结尾的 NUL。
            let units: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .take_while(|unit| *unit != 0)
                .collect();
            String::from_utf16_lossy(&units)
        })
        .unwrap_or_default();

    unsafe { RegCloseKey(key) };

    if !enabled {
        return None;
    }

    // 两种写法都要认：`host:port` 与 `http=host:port;https=host:port`。
    let pick = |scheme: &str| -> Option<String> {
        server
            .split(';')
            .map(str::trim)
            .find_map(|entry| match entry.split_once('=') {
                Some((key, value)) if key.trim().eq_ignore_ascii_case(scheme) => {
                    Some(value.trim().to_string())
                }
                None if !entry.is_empty() => Some(entry.to_string()),
                _ => None,
            })
            .filter(|value| !value.is_empty())
    };
    let http = pick("http")?;
    let https = pick("https").unwrap_or_else(|| http.clone());

    // 代理地址非法时静默放弃，退回直连（检查更新仍能跑，只是可能失败时会如实报错）。
    let mut proxies = Vec::new();
    if let Ok(proxy) = reqwest::Proxy::http(format!("http://{http}")) {
        proxies.push(proxy);
    }
    if let Ok(proxy) = reqwest::Proxy::https(format!("http://{https}")) {
        proxies.push(proxy);
    }
    // 一个都没配上就不返回：避免调用方以为“已经挂了代理”而实际是空列表。
    (!proxies.is_empty()).then_some(proxies)
}

/// 给任意 reqwest 客户端构造器挂上系统代理。
///
/// reqwest 只认 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量，**不读 Windows 的「Internet 设置」**，
/// 所以「浏览器打得开、应用打不开」是这套网络栈的典型现象。没配代理时原样返回构造器，
/// 行为与直连完全一致。
pub(crate) fn with_system_proxy(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    let Some(proxies) = system_proxy() else {
        return builder;
    };
    proxies
        .into_iter()
        .fold(builder, |builder, proxy| builder.proxy(proxy))
}

/// 本机是否配了可用的系统代理。
///
/// 给调用方判断"要不要准备一条直连兜底"用：没配代理的机器上，代理路径与直连路径
/// 本来就是同一条，兜底只会白建一个连接池。见 `provider::fallback_direct_client`。
pub(crate) fn has_system_proxy() -> bool {
    system_proxy().is_some()
}

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
    //
    // 必须挂系统代理：reqwest 不读 Windows 的「Internet 设置」，而 release 资产的
    // 下载域名在直连时可能根本连不上（见 system_proxy 的实测记录）。
    let mut builder = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        // 大文件下载：连接超时给宽一点，但不要设总超时。
        .connect_timeout(std::time::Duration::from_secs(20));
    if let Some(proxies) = system_proxy() {
        for proxy in proxies {
            builder = builder.proxy(proxy);
        }
    }
    let client = builder
        .build()
        .map_err(|error| format!("无法创建下载客户端：{error}"))?;

    let mut response = client.get(url).send().await.map_err(|error| {
        // reqwest 的 Display 经常只有一句 `error sending request for url (...)`，
        // 把 source 链一并带上，否则用户（和排查者）看不出是连不上、TLS 失败还是被重置。
        let mut detail = error.to_string();
        let mut source = std::error::Error::source(&error);
        while let Some(cause) = source {
            detail.push_str(" ← ");
            detail.push_str(&cause.to_string());
            source = cause.source();
        }
        format!("下载失败：{detail}")
    })?;
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

/// 安装包最小体积：低于此值视为下载中断留下的半截文件。
///
/// 1 MB 是保守下限——真实的 NSIS 安装包有几十 MB，而一个正常的可执行文件几乎不可能
/// 只有几十 KB。这个阈值挡的是「下载到一半被取消、留下一个看着像安装包的文件」。
const MIN_INSTALLER_BYTES: u64 = 1024 * 1024;

/// 校验一个待安装的文件是否可以被执行，返回它的真实路径。
///
/// 这是 `update_install` 的安全边界，四道检查缺一不可：
///   1. `canonicalize` 后必须仍在 `allowed_dir` 内——入参来自前端，不加限制等于给了页面
///      一个「运行任意路径下的 exe」的能力。`canonicalize` 必须在比较之前：否则
///      `下载目录\..\..\Windows\System32\cmd.exe` 能靠前缀比较蒙混过关。
///   2. 扩展名必须是 `.exe`——挡掉把数据文件、脚本、快捷方式当安装器。
///   3. 文件头必须是 `MZ`——Windows 可执行文件的魔数。
///   4. 体积不小于 `MIN_INSTALLER_BYTES`——挡掉半截文件。
///
/// 抽成独立函数是为了能单测：这几条是纯判定，不该只能靠真机点一次安装来验证。
fn resolve_installable(path: &Path, allowed_dir: &Path) -> Result<PathBuf, String> {
    let real = path
        .canonicalize()
        .map_err(|error| format!("安装包不存在：{error}"))?;
    let real_allowed = allowed_dir
        .canonicalize()
        .unwrap_or_else(|_| allowed_dir.to_path_buf());
    if !real.starts_with(&real_allowed) {
        return Err("只允许安装下载目录里的安装包。".to_string());
    }
    if real
        .extension()
        .and_then(|ext| ext.to_str())
        .is_none_or(|ext| !ext.eq_ignore_ascii_case("exe"))
    {
        return Err("那不是安装程序，已取消自动安装。".to_string());
    }
    let meta = std::fs::metadata(&real).map_err(|error| format!("无法读取安装包：{error}"))?;
    if meta.len() < MIN_INSTALLER_BYTES {
        return Err("安装包不完整（体积异常），已取消自动安装。".to_string());
    }
    let mut magic = [0u8; 2];
    let mut file =
        std::fs::File::open(&real).map_err(|error| format!("无法读取安装包：{error}"))?;
    std::io::Read::read_exact(&mut file, &mut magic)
        .map_err(|error| format!("无法读取安装包：{error}"))?;
    if &magic != b"MZ" {
        return Err("安装包格式不正确，已取消自动安装。".to_string());
    }
    Ok(real)
}

/// 下载完成后静默安装，并退出本应用让出文件锁。
///
/// 四道安全校验在 `resolve_installable` 里（AGENTS.md 不变量 13 补充五），这里只负责
/// 启动与退出。`/S` 是 NSIS 的静默安装开关，参数以独立 argv 传递，不经过 shell。
#[tauri::command]
pub fn update_install(app: AppHandle, path: String) -> Result<(), String> {
    let real = resolve_installable(&PathBuf::from(&path), &download_dir())?;

    std::process::Command::new(&real)
        .arg("/S")
        .spawn()
        .map_err(|error| format!("无法启动安装程序：{error}"))?;

    // 安装器要覆盖本应用的 exe 与随包资源，必须等本进程彻底退出。先把界面收掉，避免
    // 用户在安装的几秒里以为程序卡死。
    app.exit(0);
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

    /// 在临时目录里造一个够大、带 MZ 头的假安装包，返回 (下载目录, 安装包路径)。
    fn fake_installer(dir_name: &str, file_name: &str, bytes: usize) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("ttv-update-test-{dir_name}"));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("建临时目录");
        let file = root.join(file_name);
        let mut data = vec![b'M', b'Z'];
        data.resize(bytes, 0u8);
        std::fs::write(&file, data).expect("写假安装包");
        (root, file)
    }

    fn big() -> usize {
        MIN_INSTALLER_BYTES as usize + 1
    }

    #[test]
    fn accepts_a_well_formed_installer_inside_the_download_dir() {
        let (dir, file) = fake_installer("ok", "setup.exe", big());
        assert!(resolve_installable(&file, &dir).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_a_file_outside_the_download_dir() {
        let (dir, file) = fake_installer("outside", "setup.exe", big());
        let elsewhere = std::env::temp_dir().join("ttv-update-test-not-the-dir");
        std::fs::create_dir_all(&elsewhere).expect("建另一个目录");
        let error = resolve_installable(&file, &elsewhere).unwrap_err();
        assert!(error.contains("下载目录"), "实际错误：{error}");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&elsewhere);
    }

    #[test]
    fn rejects_path_traversal_out_of_the_download_dir() {
        // `下载目录\..\evil.exe` 字符串上前缀匹配是通过的，只有 canonicalize 之后才发现
        // 它其实在下载目录之外。这条正是第 1 道检查必须先 canonicalize、再比较的原因。
        let (dir, file) = fake_installer("traversal-src", "evil.exe", big());
        let escaped = std::env::temp_dir().join("ttv-update-test-traversal-evil.exe");
        std::fs::copy(&file, &escaped).expect("把文件放到下载目录之外");
        let sneaky = dir.join("..").join("ttv-update-test-traversal-evil.exe");
        // 前提：`..` 拼出来的路径在字符串上确实以下载目录开头。
        assert!(
            sneaky.starts_with(&dir),
            "测试前提不成立：带 .. 的路径不应以目录开头"
        );
        let error = resolve_installable(&sneaky, &dir).unwrap_err();
        assert!(error.contains("下载目录"), "实际错误：{error}");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&escaped);
    }

    #[test]
    fn rejects_non_exe_extensions() {
        let (dir, file) = fake_installer("bat", "setup.bat", big());
        let error = resolve_installable(&file, &dir).unwrap_err();
        assert!(error.contains("不是安装程序"), "实际错误：{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_a_truncated_download() {
        // 下载到一半被取消：MZ 头有、体积不够。
        let (dir, file) = fake_installer("truncated", "setup.exe", 4096);
        let error = resolve_installable(&file, &dir).unwrap_err();
        assert!(error.contains("不完整"), "实际错误：{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_a_file_without_the_mz_magic() {
        // 体积够、扩展名对，但内容不是可执行文件（例如把视频改名成 .exe）。
        let (dir, file) = fake_installer("notmz", "setup.exe", big());
        // 必须写满 big() 字节：只写 4 个字节会先被体积检查拦下，那样测的就不是
        // MZ 这一道了。
        let mut data = vec![b'N', b'O'];
        data.resize(big(), 0u8);
        std::fs::write(&file, data).expect("改写内容");
        let error = resolve_installable(&file, &dir).unwrap_err();
        assert!(error.contains("格式不正确"), "实际错误：{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
