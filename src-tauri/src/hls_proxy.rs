//! 本地 HLS 代理：把远端 m3u8/ts 转成本地流，绕过 WebView2 原生不支持 m3u8 的限制。
//!
//! 原理：
//! - `/stream?u=<base64>&t=<token>` 转发远端内容（m3u8 文本会重写分片地址指向本代理）；
//! - `/seg?u=<base64>&t=<token>` 转发 ts 分片原始字节（带 Range 透传）；
//! - 播放器拿到的永远是 `http://127.0.0.1:{port}/...`。
//!
//! 与参考实现（果果剧库 internal/app/ui_forward.go）对齐的三点：
//! 1. **响应头必须在正文之前落定**。此前 m3u8 分支先把头部以 `\r\n\r\n` 收尾，之后
//!    才 `write_all("Content-Length: ...")`——那两行落进了正文，客户端拿到的 body 是
//!    `Content-Length: N\r\n\r\n#EXTM3U...`。hls.js 对播放列表有 `startsWith('#EXTM3U')`
//!    硬校验，必然判 `no EXTM3U delimiter` 直接把整条链路判死。
//! 2. **必须发 CORS 头并处理 OPTIONS 预检**。hls.js 用 XHR 从 WebView origin 拉
//!    `http://127.0.0.1:{port}`，是跨域请求；参考实现 `setForwardCORS` 会同时给出
//!    `Access-Control-Allow-Origin/Headers/Methods/Max-Age` 与 `X-Content-Type-Options`。
//! 3. **不能做开放转发器**。参考实现用「令牌 + 签名 URL + 端点白名单」收口；这里同样
//!    在启动时生成一次性令牌、随 `proxied_url` 下发并在每次请求校验，同时把目标地址
//!    限制为 http(s)——否则本机任意进程、以及 WebView 内被注入的脚本都能拿它当通用
//!    GET 代理（含指向内网与其它 localhost 服务的 SSRF）。base64 只是编码，不是鉴权。

use base64::Engine;
use std::sync::OnceLock;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

static PROXY_PORT: OnceLock<u16> = OnceLock::new();
static PROXY_TOKEN: OnceLock<String> = OnceLock::new();
static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36")
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(30))
            .tcp_nodelay(true)
            .build()
            .expect("hls proxy client")
    })
}

/// 把远端 m3u8 地址包装成本地代理地址（已带访问令牌）。代理未启动时返回 None。
pub fn proxied_url(remote: &str) -> Option<String> {
    let port = *PROXY_PORT.get()?;
    let token = PROXY_TOKEN.get()?;
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(remote.as_bytes());
    Some(format!(
        "http://127.0.0.1:{port}/stream?u={encoded}&t={token}"
    ))
}

/// 启动本地代理（幂等：已启动则直接返回端口）。
pub async fn start() -> Result<u16, String> {
    if let Some(port) = PROXY_PORT.get() {
        return Ok(*port);
    }
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("HLS 代理绑定失败: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    // 一次性令牌：只在进程内存在，随 proxied_url 下发给播放器。
    PROXY_TOKEN
        .set(uuid::Uuid::new_v4().simple().to_string())
        .ok();
    PROXY_PORT.set(port).ok();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            tokio::spawn(handle(socket));
        }
    });
    Ok(port)
}

fn decode_url(encoded: &str) -> Option<String> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .ok()?;
    let remote = String::from_utf8(bytes).ok()?;
    // 只允许 http(s)：挡掉 file:// 之类指向本机文件系统的目标。
    if remote.starts_with("http://") || remote.starts_with("https://") {
        Some(remote)
    } else {
        None
    }
}

/// 常量时间比较：逐字节异或累加，避免提前返回泄露匹配前缀长度。
fn token_eq(expected: &str, supplied: &str) -> bool {
    let (expected, supplied) = (expected.as_bytes(), supplied.as_bytes());
    if expected.len() != supplied.len() {
        return false;
    }
    let mut diff = 0u8;
    for (left, right) in expected.iter().zip(supplied.iter()) {
        diff |= left ^ right;
    }
    diff == 0
}

fn token_matches(supplied: &str) -> bool {
    match PROXY_TOKEN.get() {
        Some(expected) => token_eq(expected, supplied),
        None => false,
    }
}

/// 跨域头：hls.js 从 WebView origin 拉本代理是跨域请求，缺这些头会被浏览器拦下。
fn cors_headers() -> &'static str {
    "Access-Control-Allow-Origin: *\r\n\
     Access-Control-Allow-Headers: *\r\n\
     Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
     Access-Control-Max-Age: 86400\r\n\
     X-Content-Type-Options: nosniff\r\n"
}

async fn write_plain(socket: &mut tokio::net::TcpStream, status: &str, body: &str) {
    let head = format!(
        "HTTP/1.1 {status}\r\n{}Content-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        cors_headers(),
        body.len()
    );
    let _ = socket.write_all(head.as_bytes()).await;
    let _ = socket.write_all(body.as_bytes()).await;
    let _ = socket.flush().await;
}

async fn handle(mut socket: tokio::net::TcpStream) {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    // 读到请求头结束（\r\n\r\n）
    while let Ok(count) = socket.read(&mut chunk).await {
        if count == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..count]);
        if buf.windows(4).any(|window| window == b"\r\n\r\n") || buf.len() > 64 * 1024 {
            break;
        }
    }
    let request = String::from_utf8_lossy(&buf).into_owned();
    let mut request_lines = request.lines();
    let first_line = request_lines.next().unwrap_or_default();
    let method = first_line
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let path = first_line.split_whitespace().nth(1).unwrap_or_default();

    // 预检与探测：OPTIONS 直接回 204，HEAD 只回头不回正文（参考实现同样显式处理）。
    if method == "OPTIONS" {
        let head = format!(
            "HTTP/1.1 204 No Content\r\n{}Content-Length: 0\r\nConnection: close\r\n\r\n",
            cors_headers()
        );
        let _ = socket.write_all(head.as_bytes()).await;
        let _ = socket.flush().await;
        return;
    }

    // 解析 Range 头（透传给上游，实现拖动进度条）
    let range = request
        .lines()
        .find(|line| line.to_ascii_lowercase().starts_with("range:"))
        .and_then(|line| line.split_once(':'))
        .map(|(_, value)| value.trim().to_string());

    let query = match path.split_once('?') {
        Some((_, query)) => query,
        None => "",
    };
    let param = |name: &str| -> &str {
        query
            .split('&')
            .find_map(|pair| pair.strip_prefix(&format!("{name}=")))
            .unwrap_or_default()
    };

    // 令牌校验先于一切：没有它，这个端口就是一个本机开放转发器。
    if !token_matches(param("t")) {
        write_plain(&mut socket, "403 Forbidden", "HLS 代理令牌无效").await;
        return;
    }
    let Some(remote) = decode_url(param("u")) else {
        write_plain(&mut socket, "400 Bad Request", "HLS 代理目标地址无效").await;
        return;
    };

    let mut request_builder = client().get(&remote);
    if let Some(range) = &range {
        request_builder = request_builder.header("Range", range);
    }
    let response = match request_builder.send().await {
        Ok(response) => response,
        Err(error) => {
            write_plain(
                &mut socket,
                "502 Bad Gateway",
                &format!("上游请求失败：{error}"),
            )
            .await;
            return;
        }
    };

    let is_m3u8 = remote.contains(".m3u8")
        || response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|content_type| content_type.contains("mpegurl"));

    if is_m3u8 {
        // m3u8 文本：重写相对/绝对分片地址指向本代理，并把长度算准后一次写完头部。
        let body = match response.bytes().await {
            Ok(bytes) => String::from_utf8_lossy(&bytes).to_string(),
            Err(error) => {
                write_plain(
                    &mut socket,
                    "502 Bad Gateway",
                    &format!("上游播放列表读取失败：{error}"),
                )
                .await;
                return;
            }
        };
        let rewritten = rewrite_playlist(&body, &remote);
        let head = format!(
            "HTTP/1.1 200 OK\r\n{}Content-Type: application/vnd.apple.mpegurl\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            cors_headers(),
            rewritten.len()
        );
        let _ = socket.write_all(head.as_bytes()).await;
        if method != "HEAD" {
            let _ = socket.write_all(rewritten.as_bytes()).await;
        }
        let _ = socket.flush().await;
        return;
    }

    // ts 分片等二进制：沿用上游的状态码与长度类头（含 Range/206 语义）。
    let mut head = format!(
        "HTTP/1.1 {}\r\n{}Cache-Control: private, no-store\r\n",
        response.status(),
        cors_headers()
    );
    for key in [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
    ] {
        if let Some(value) = response.headers().get(key).and_then(|v| v.to_str().ok()) {
            head.push_str(&format!("{}: {}\r\n", title_case(key), value));
        }
    }
    head.push_str("Connection: close\r\n\r\n");
    if socket.write_all(head.as_bytes()).await.is_err() {
        return;
    }
    if method != "HEAD" {
        // 分片通常几百 KB～几 MB，全量读取转发足够；读失败时连接已声明长度，
        // 直接断开让播放器按失败重试分片。
        if let Ok(bytes) = response.bytes().await {
            let _ = socket.write_all(&bytes).await;
        }
    }
    let _ = socket.flush().await;
}

/// 把 m3u8 里所有分片地址（含 #EXT-X-KEY 的 URI）改写成本代理地址。
fn rewrite_playlist(body: &str, remote: &str) -> String {
    rewrite_playlist_with(
        body,
        remote,
        PROXY_PORT.get().copied().unwrap_or(0),
        PROXY_TOKEN.get().map(String::as_str).unwrap_or_default(),
    )
}

/// 纯函数版本（不读全局状态），便于单测。
fn rewrite_playlist_with(body: &str, remote: &str, port: u16, token: &str) -> String {
    let base = remote
        .rsplit_once('/')
        .map(|(dir, _)| dir)
        .unwrap_or(remote);
    let encode = |absolute: &str| {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(absolute.as_bytes())
    };
    let mut rewritten = String::with_capacity(body.len() + 512);
    for line in body.lines() {
        let trimmed = line.trim();
        let replaced = if trimmed.is_empty() || trimmed.starts_with('#') {
            // #EXT-X-KEY / #EXT-X-MAP 里的 URI 也要重写，否则密钥请求绕过代理而失败。
            match trimmed.find("URI=\"") {
                Some(index) => {
                    let head = &trimmed[..index + 5];
                    let rest = &trimmed[index + 5..];
                    match rest.find('"') {
                        Some(end) => {
                            let absolute = absolutize(base, &rest[..end]);
                            format!(
                                "{head}http://127.0.0.1:{port}/seg?u={}&t={token}\"{}",
                                encode(&absolute),
                                &rest[end + 1..]
                            )
                        }
                        None => line.to_string(),
                    }
                }
                None => line.to_string(),
            }
        } else {
            let absolute = absolutize(base, trimmed);
            format!(
                "http://127.0.0.1:{port}/seg?u={}&t={token}",
                encode(&absolute)
            )
        };
        rewritten.push_str(&replaced);
        rewritten.push('\n');
    }
    rewritten
}

fn title_case(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    for (index, part) in key.split('-').enumerate() {
        if index > 0 {
            out.push('-');
        }
        let mut chars = part.chars();
        if let Some(first) = chars.next() {
            out.extend(first.to_uppercase());
            out.push_str(chars.as_str());
        }
    }
    out
}

fn absolutize(base: &str, url: &str) -> String {
    if url.starts_with("http://") || url.starts_with("https://") {
        return url.to_string();
    }
    // 协议相对地址（//host/path）：补上 base 的 scheme，否则会被拼成 base 下的路径。
    if let Some(rest) = url.strip_prefix("//") {
        if let Some(scheme_end) = base.find("://") {
            return format!("{}://{rest}", &base[..scheme_end]);
        }
        return format!("https://{rest}");
    }
    if url.starts_with('/') {
        if let Some(scheme_end) = base.find("://") {
            if let Some(host_end) = base[scheme_end + 3..].find('/') {
                return format!("{}{}", &base[..scheme_end + 3 + host_end], url);
            }
            return format!("{base}{url}");
        }
    }
    format!("{base}/{url}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolutize_handles_protocol_relative_and_root_paths() {
        // 契约：base 是"目录"（调用方已用 rsplit_once('/') 去掉文件名）。
        let base = "https://cdn.example/a/b";
        assert_eq!(
            absolutize(base, "//other.example/x.ts"),
            "https://other.example/x.ts"
        );
        assert_eq!(
            absolutize(base, "/root/x.ts"),
            "https://cdn.example/root/x.ts"
        );
        assert_eq!(absolutize(base, "x.ts"), "https://cdn.example/a/b/x.ts");
        assert_eq!(
            absolutize(base, "https://z.example/y.ts"),
            "https://z.example/y.ts"
        );
    }

    #[test]
    fn decode_url_rejects_non_http_schemes() {
        let encode =
            |value: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.as_bytes());
        assert_eq!(
            decode_url(&encode("https://cdn.example/a.ts")),
            Some("https://cdn.example/a.ts".to_string())
        );
        assert_eq!(decode_url(&encode("file:///C:/Windows/win.ini")), None);
        assert_eq!(decode_url(&encode("ftp://example.com/a.ts")), None);
        assert_eq!(decode_url("not-base64!!"), None);
    }

    #[test]
    fn rewrite_playlist_points_segments_and_keys_at_local_proxy() {
        let body = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:1.0,\na.ts\n#EXT-X-ENDLIST\n";
        let rewritten =
            rewrite_playlist_with(body, "https://cdn.example/dir/index.m3u8", 45678, "tok");
        assert!(rewritten.starts_with("#EXTM3U\n"));
        assert!(rewritten.contains("http://127.0.0.1:45678/seg?u="));
        // 分片地址与密钥 URI 都必须带令牌，否则播放器拉到分片会被 403。
        assert!(rewritten.contains("&t=tok\""));
        assert!(rewritten.contains("URI=\"http://127.0.0.1:45678/seg?u="));
        // 关键行本身不能被改成地址
        assert!(rewritten.contains("#EXTINF:1.0,"));
        assert!(rewritten.contains("#EXT-X-ENDLIST"));
        // 首行必须仍是 #EXTM3U，供 hls.js 做 startsWith('#EXTM3U') 校验
        assert_eq!(rewritten.lines().next(), Some("#EXTM3U"));
    }

    #[test]
    fn token_eq_requires_exact_token() {
        assert!(token_eq("secret-token", "secret-token"));
        assert!(!token_eq("secret-token", "secret-toke"));
        assert!(!token_eq("secret-token", "secret-tokenx"));
        assert!(!token_eq("secret-token", ""));
        assert!(!token_eq("secret-token", "other"));
    }
}
