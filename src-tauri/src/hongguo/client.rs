//! 匿名红果客户端：注册、签名请求、播放解析。
//!
//! 移植自 `sdk/client.go` + `sdk/media.go`。整个链路不再需要 Python：
//! 首次调用自动注册一台匿名设备（`tt_encrypt` 信封），之后每次请求都带
//! 六代签名头（gorgon / helios / medusa / ladon / argus）。
//!
//! ## 错误分类
//!
//! 上游用「HTTP 200 + 空 body」表达静默拒绝，用业务码表达具体原因。
//! 这两类必须分开：前者换设备可能恢复，后者换设备没用。

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::Mutex;

use crate::hongguo::consts::{API_HOST, APP_ID, PATH_PLAYBACK, PATH_REGISTER, REGISTER_HOST};
use crate::hongguo::device::DeviceProfile;
use crate::hongguo::drm::{derive as derive_key, ContentKey};
use crate::hongguo::media::{parse_playback, Playback};
use crate::hongguo::register::{build_register_body, content_md5, parse_register};
use crate::hongguo::sign::{
    device_query_pairs, draw_entropy, reading_request_id, sign_request, Pairs, SearchIdentity,
};

/// 客户端错误。分类决定调用方该重试、换设备还是直接报错。
#[derive(Debug, Clone)]
pub enum HongguoError {
    /// 网络层失败（可重试）。
    Transport(String),
    /// 需要登录，匿名不可用。
    AuthenticationRequired,
    /// 被限流（可重试）。
    RateLimited,
    /// 服务端对匿名设备返回空结果 —— 通常是设备本身不受信任。
    AnonymousLimited,
    /// 设备被拒绝，需要 `reset_device` 后重试。
    DeviceRejected,
    /// 内容下架 / 不存在 / 无权访问。
    ContentUnavailable(String),
    /// 业务码错误。
    Code { code: i64, message: String },
    /// 其他（含解析失败）。
    Other(String),
}

impl std::fmt::Display for HongguoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(e) => write!(f, "网络请求失败：{e}"),
            Self::AuthenticationRequired => write!(f, "内容需要登录，匿名设备无法访问"),
            Self::RateLimited => write!(f, "请求过于频繁，被服务端限流"),
            Self::AnonymousLimited => write!(f, "服务端对匿名设备返回空结果"),
            Self::DeviceRejected => write!(f, "匿名设备被拒绝，需要重置后重新注册"),
            Self::ContentUnavailable(m) => write!(f, "内容不可用：{m}"),
            Self::Code { code, message } => write!(f, "接口错误 {code}：{message}"),
            Self::Other(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for HongguoError {}

impl HongguoError {
    /// 是否值得原样重试。
    pub fn retryable(&self) -> bool {
        matches!(self, Self::Transport(_) | Self::RateLimited)
    }

    /// 是否是「这台匿名设备被服务端拒了」——重置设备后重试才有意义。
    ///
    /// 实测（2026-10-27）：同一台设备注册成功后，过一段时间会开始收到
    /// 「HTTP 200 + 空 body」；此时换一台新设备（重新注册）立刻恢复正常，
    /// 而同一台设备无论重试多少次都是空的。所以这不是可重试错误，
    /// **必须换设备**。
    pub fn needs_device_reset(&self) -> bool {
        matches!(self, Self::AnonymousLimited | Self::DeviceRejected)
    }
}

pub type Result<T> = std::result::Result<T, HongguoError>;

/// 播放解析结果（码流 + 已解包的内容密钥）。
#[derive(Debug, Clone)]
pub struct ResolvedPlayback {
    pub playback: Playback,
    pub content_key: Option<ContentKey>,
}

/// 匿名红果客户端。
pub struct HongguoClient {
    http: reqwest::Client,
    profile: Arc<Mutex<DeviceProfile>>,
    profile_path: Option<PathBuf>,
}

impl HongguoClient {
    /// 创建客户端。给出 `profile_path` 时设备档案会落盘复用，
    /// 否则只在内存里活到进程结束。
    pub async fn new(profile_path: Option<PathBuf>) -> Result<Self> {
        let profile = match &profile_path {
            Some(path) if path.exists() => {
                let raw = tokio::fs::read(path)
                    .await
                    .map_err(|e| HongguoError::Other(format!("读取设备档案失败：{e}")))?;
                serde_json::from_slice::<DeviceProfile>(&raw)
                    .map_err(|e| HongguoError::Other(format!("设备档案损坏：{e}")))?
            }
            _ => DeviceProfile::new_anonymous(),
        };

        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| HongguoError::Other(format!("HTTP 客户端初始化失败：{e}")))?;

        Ok(Self {
            http,
            profile: Arc::new(Mutex::new(profile)),
            profile_path,
        })
    }

    async fn save_profile(&self, profile: &DeviceProfile) -> Result<()> {
        if let Some(path) = &self.profile_path {
            if let Some(parent) = path.parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            let raw = serde_json::to_vec_pretty(profile)
                .map_err(|e| HongguoError::Other(format!("序列化设备档案失败：{e}")))?;
            tokio::fs::write(path, raw)
                .await
                .map_err(|e| HongguoError::Other(format!("写入设备档案失败：{e}")))?;
        }
        Ok(())
    }

    async fn digest(&self) -> String {
        let p = self.profile.lock().await;
        if p.device_id_str.is_empty() {
            p.cdid.replace('-', "")
        } else {
            p.device_id_str.clone()
        }
    }

    /// 确保已有可用匿名设备（必要时注册）。
    pub async fn ensure_guest(&self) -> Result<DeviceProfile> {
        {
            let p = self.profile.lock().await;
            if p.is_ready() {
                return Ok(p.clone());
            }
        }

        let mut profile = self.profile.lock().await.clone();
        let body = build_register_body(&profile);
        let stub = content_md5(&body);

        let url = format!(
            "https://{REGISTER_HOST}{PATH_REGISTER}?req_id={}&tt_data=a",
            url_encode(&profile.req_id)
        );

        let ua = user_agent(&profile);

        let resp = self
            .http
            .post(&url)
            .header("User-Agent", ua)
            .header("Content-Type", "application/octet-stream;tt-data=a")
            .header("log-encode-type", "gzip")
            .header("sdk-version", "2")
            .header("passport-sdk-version", "5051452")
            .header("x-vc-bdturing-sdk-version", "4.0.3.cn")
            .header("x-ss-dp", APP_ID)
            .header("X-SS-STUB", stub)
            .body(body)
            .send()
            .await
            .map_err(|e| HongguoError::Transport(e.to_string()))?;

        let status = resp.status();
        let cookies: Vec<String> = resp
            .headers()
            .get_all("set-cookie")
            .iter()
            .filter_map(|v| v.to_str().ok().map(|s| s.to_string()))
            .collect();
        let raw = resp
            .bytes()
            .await
            .map_err(|e| HongguoError::Transport(e.to_string()))?;

        if !status.is_success() {
            return Err(HongguoError::Other(format!("注册接口 HTTP {status}")));
        }
        if raw.is_empty() {
            return Err(HongguoError::AnonymousLimited);
        }
        if std::env::var_os("HONGGUO_DEBUG_REGISTER").is_some() {
            eprintln!(
                "[hongguo] 注册响应 {} 字节: {}",
                raw.len(),
                String::from_utf8_lossy(&raw[..raw.len().min(600)])
            );
        }

        let parsed =
            parse_register(&raw).map_err(|e| HongguoError::Other(format!("注册失败：{e}")))?;

        profile.device_id_str = parsed.device_id;
        profile.install_id_str = parsed.install_id;
        // 从 Set-Cookie 里取 ttreq / store-region 等
        for cookie in cookies {
            let first = cookie.split(';').next().unwrap_or("");
            if let Some((k, v)) = first.split_once('=') {
                match k.trim() {
                    "ttreq" => profile.ttreq = v.trim().to_string(),
                    "store-region" => profile.store_region = v.trim().to_string(),
                    "store-region-src" => profile.store_region_src = v.trim().to_string(),
                    _ => {}
                }
            }
        }

        self.save_profile(&profile).await?;
        *self.profile.lock().await = profile.clone();
        Ok(profile)
    }

    pub(crate) fn identity(profile: &DeviceProfile) -> SearchIdentity {
        SearchIdentity {
            device_id: profile.device_id_str.clone(),
            install_id: profile.install_id_str.clone(),
            cdid: profile.cdid.clone(),
            openudid: profile.openudid.clone(),
            device: profile.device_or_default(),
        }
    }

    /// 发一次已签名的请求；设备被拒时**自动换一台设备重试一次**。
    ///
    /// 为什么必须自动做：匿名设备会被服务端风控（实测同一台设备先能用、
    /// 一段时间后开始收到空 body）。若不在这一层兜住，用户就会看到
    /// 「刚才还能播，现在全失败」，而且重启应用也没用（档案是落盘的）。
    pub(crate) async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        pairs: Pairs,
        body: Option<Vec<u8>>,
    ) -> Result<Value> {
        let profile = self.ensure_guest().await?;
        let now_ms = chrono::Utc::now().timestamp_millis();
        let entropy = draw_entropy(now_ms);

        let signed = sign_request(
            path,
            &pairs,
            now_ms,
            &profile.device_id_str,
            body.as_deref(),
            entropy,
        );

        let url = format!("https://{API_HOST}{path}?{}", signed.query);

        let mut req = self
            .http
            .request(method.clone(), &url)
            .header("User-Agent", user_agent(&profile))
            .header("x-ss-dp", APP_ID)
            .header("lc", "101")
            .header("x-reading-request", reading_request_id(now_ms, rand_i31()));

        for (k, v) in &signed.headers {
            req = req.header(k, v);
        }
        if !profile.ttreq.is_empty() {
            req = req.header("Cookie", profile.guest_cookie());
        }
        if let Some(b) = &body {
            req = req.body(b.clone());
        }

        let resp = req
            .send()
            .await
            .map_err(|e| HongguoError::Transport(e.to_string()))?;

        let status = resp.status();
        let raw = resp
            .bytes()
            .await
            .map_err(|e| HongguoError::Transport(e.to_string()))?;

        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(HongguoError::AuthenticationRequired);
        }
        if status.as_u16() == 429 {
            return Err(HongguoError::RateLimited);
        }
        if !status.is_success() {
            return Err(HongguoError::Other(format!("HTTP {status}")));
        }

        let trimmed = String::from_utf8_lossy(&raw).trim().to_string();
        if trimmed.is_empty() {
            // 静默拒绝：换设备可能恢复
            return Err(HongguoError::AnonymousLimited);
        }

        let value: Value = serde_json::from_str(&trimmed)
            .map_err(|e| HongguoError::Other(format!("响应不是 JSON：{e}")))?;

        // 业务码
        let code = match value.get("code") {
            Some(Value::Number(n)) => n.as_i64().unwrap_or(0),
            Some(Value::String(s)) => s.trim().parse::<i64>().unwrap_or(0),
            _ => 0,
        };
        if code != 0 {
            let message = value
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("")
                .to_string();
            return Err(classify(code, message));
        }

        // BaseResp.StatusCode 也可能带设备拒绝码
        if let Some(base) = value.get("BaseResp").and_then(|b| b.get("StatusCode")) {
            let st = base.as_i64().unwrap_or(0);
            if st == 263175 || st == 263176 {
                return Err(HongguoError::DeviceRejected);
            }
            if st != 0 {
                return Err(HongguoError::Code {
                    code: st,
                    message: "BaseResp".into(),
                });
            }
        }

        Ok(value)
    }

    /// 解析一集的播放模型，并解出内容密钥。
    ///
    /// 这是「点播放」的核心：一次往返拿到全部码流地址（不像旧链路要两次），
    /// 密钥在本地解包，不发额外请求。
    pub async fn resolve_playback(&self, episode_id: &str) -> Result<ResolvedPlayback> {
        // 设备被风控时换一台再试一次。**必须在这一层重置**：查询串里的
        // iid/device_id 是设备相关的，如果在下层（request）重置，上层的 pairs
        // 仍是旧设备算出来的，签名永远对不上 —— 那正是"重置了还是失败"的原因。
        match self.resolve_playback_once(episode_id).await {
            Err(error) if error.needs_device_reset() => {
                crate::trace::log(format!(
                    "[红果] 设备被拒，重置后重试 vid={episode_id} 原因={error}"
                ));
                match self.reset_device().await {
                    Ok(profile) => {
                        crate::trace::log(format!(
                            "[红果] 已换新设备 device_id={}",
                            profile.device_id_str
                        ));
                        self.resolve_playback_once(episode_id).await
                    }
                    Err(reset_error) => {
                        crate::trace::log(format!("[红果] 重置设备失败：{reset_error}"));
                        Err(error)
                    }
                }
            }
            other => other,
        }
    }

    async fn resolve_playback_once(&self, episode_id: &str) -> Result<ResolvedPlayback> {
        if !valid_id(episode_id) {
            return Err(HongguoError::Other(format!("非法的分集 ID：{episode_id}")));
        }

        let pairs: Pairs = {
            let profile = self.ensure_guest().await?;
            device_query_pairs(&Self::identity(&profile))
        };

        // 字段顺序与 Go 的 map 序列化一致（字典序）
        let body = format!(
            r#"{{"biz_param":{{"need_all_video_definition":true,"video_id_type":0,"video_platform":3}},"video_id":"{episode_id}"}}"#
        )
        .into_bytes();

        let value = self
            .request(reqwest::Method::POST, PATH_PLAYBACK, pairs, Some(body))
            .await?;

        // 复用解析器：把它重新包成 {"code":0,"data":{"video_model":...}}
        let wrapped = serde_json::to_vec(&value)
            .map_err(|e| HongguoError::Other(format!("回包序列化失败：{e}")))?;
        let playback = parse_playback(&wrapped, episode_id)
            .map_err(|e| HongguoError::Other(format!("播放模型解析失败：{e}")))?;

        let content_key = if playback.protected && !playback.key_material.is_empty() {
            derive_key(&playback.key_material).ok()
        } else {
            None
        };

        Ok(ResolvedPlayback {
            playback,
            content_key,
        })
    }

    /// 当前设备档案快照（诊断用）。
    pub async fn profile_snapshot(&self) -> DeviceProfile {
        self.profile.lock().await.clone()
    }

    /// 当前 device_id（写入签名头时用）。
    pub async fn device_id(&self) -> String {
        self.digest().await
    }

    /// 丢弃当前设备并重新注册。
    pub async fn reset_device(&self) -> Result<DeviceProfile> {
        {
            let mut p = self.profile.lock().await;
            *p = DeviceProfile::new_anonymous();
        }
        if let Some(path) = &self.profile_path {
            let _ = tokio::fs::remove_file(path).await;
        }
        self.ensure_guest().await
    }
}

fn classify(code: i64, message: String) -> HongguoError {
    match code {
        111104 => HongguoError::DeviceRejected,
        101000 => HongguoError::ContentUnavailable(format!("服务异常（{code}）")),
        110001 => HongguoError::ContentUnavailable("播放模型未知异常（110001）".into()),
        100103 => HongguoError::Code { code, message },
        263175 | 263176 => HongguoError::DeviceRejected,
        _ => HongguoError::Code { code, message },
    }
}

fn valid_id(id: &str) -> bool {
    let len = id.len();
    (4..=25).contains(&len) && id.chars().all(|c| c.is_ascii_digit())
}

fn user_agent(profile: &DeviceProfile) -> String {
    let d = profile.device_or_default();
    format!(
        "com.phoenix.read/73932 (Linux; U; Android {}; zh_CN; {}; Build/{}; Cronet/TTNetVersion:8d40f833 2026-03-03 QuicVersion:21ac1950 2025-11-18)",
        d.os_version, d.model, d.build
    )
}

fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn rand_i31() -> i32 {
    let id = uuid::Uuid::new_v4();
    let b = id.as_bytes();
    (u32::from_be_bytes([b[0], b[1], b[2], b[3]]) & 0x7fff_ffff) as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_id_requires_digits() {
        assert!(valid_id("7698309376561400856"));
        assert!(!valid_id("abc123"));
        assert!(!valid_id("12"));
        assert!(!valid_id(""));
    }

    #[test]
    fn classify_maps_known_codes() {
        assert!(matches!(
            classify(111104, String::new()),
            HongguoError::DeviceRejected
        ));
        assert!(matches!(
            classify(101000, String::new()),
            HongguoError::ContentUnavailable(_)
        ));
    }

    #[test]
    fn user_agent_matches_client_shape() {
        let p = DeviceProfile::new_anonymous();
        let ua = user_agent(&p);
        assert!(ua.starts_with("com.phoenix.read/73932"));
        assert!(ua.contains("Android 14"));
        assert!(ua.contains("23127PN0CC"));
    }
}
