//! 视频源注册表：**内置两源固定 + 自定义源（用户直接添加）**。
//!
//! ## 边界（2026-11-02 定稿）
//!
//! - 内置源（红果、动漫）由核心实现，**前后端都固定**，不可移除；
//! - 其余来源由用户自己添加：填一份「苹果 CMS V10」接口定义即可，**不加载任何
//!   第三方代码**（插件系统那条路已经放弃——它要沙箱、要 IPC 契约、要执行用户
//!   代码，代价远大于收益；而这个项目真正需要的只是"再接一个苹果 CMS 站点"）。
//!
//! 格式规范写在项目根的 `视频源格式.txt`，这份代码只负责落地那套约定：
//! 校验 → 落盘 → 列表 → 真实探测一次。

use std::collections::BTreeMap;
use std::path::PathBuf;

/// 内置源的种类。决定它走哪条后端链路。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuiltinKind {
    /// 红果短剧 / 漫剧：`hongguo_bridge` + `guo_provider`（source = hongguo）。
    Hongguo,
    /// 动漫专区：`anime_provider`（dmghg 正式源 → 暴风兜底源）。
    Anime,
}

impl BuiltinKind {
    /// 给前端与日志用的稳定标识（不要用 `{:?}`：改枚举名就会改线上契约）。
    pub fn as_str(self) -> &'static str {
        match self {
            BuiltinKind::Hongguo => "hongguo",
            BuiltinKind::Anime => "anime",
        }
    }
}

/// 一个内置源。**编译期常量**——这两条不允许从配置里增删。
#[derive(Debug, Clone, Copy)]
pub struct BuiltinSource {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: BuiltinKind,
    pub description: &'static str,
}

/// 内置源清单：只有这两条，且没有"启停"字段。
///
/// 为什么不留 `enabled`：用户要求"红果与动漫固定住"。一个可以被关掉的内置源，
/// 关掉之后发现页就没有任何内容——那不是配置项，是把自己锁在门外。
pub const BUILTIN_SOURCES: &[BuiltinSource] = &[
    BuiltinSource {
        id: "hongguo",
        name: "红果短剧 / 漫剧",
        kind: BuiltinKind::Hongguo,
        description: "内置。短剧专区与漫剧次元的默认来源，走 App 接口，免登录。",
    },
    BuiltinSource {
        id: "anime",
        name: "动漫专区",
        kind: BuiltinKind::Anime,
        description: "内置。动漫共和国正式源优先，不可用时自动回落暴风资源。",
    },
];

/// 后端强制固定红果：`settings.enabled_sources` 里必须有它。
pub const PINNED_SOURCE_ID: &str = "hongguo";

fn default_true() -> bool {
    true
}

fn default_kind() -> String {
    "both".into()
}

/// 一个用户自定义源。字段与 `视频源格式.txt` 一一对应。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomSource {
    /// 源标识：小写字母/数字/`-`/`_`，2~40 字符，全局唯一（内置 id 已占用）。
    pub id: String,
    pub name: String,
    /// 苹果 CMS 接口根地址，必须是 http(s)。
    pub api: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub adult: bool,
    /// `live` / `comic` / `both`，其它值按 `both` 处理。
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub category: Option<String>,
    /// 苹果 CMS 的 `t` 参数（分类 id）。
    #[serde(default)]
    pub type_id: Option<String>,
    /// 额外请求头（有些站点校验 Referer）。
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub note: Option<String>,
}

/// 探测结果（「测试」按钮）：只回答"这个源现在能不能拉到东西"。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub ok: bool,
    pub url: String,
    /// 站点自报的总条数（缺失时回落到本页条数）。
    pub total: i64,
    /// 本页实际解析出的条目数。
    pub count: usize,
    /// 前几条标题，给用户肉眼确认"这是我的源"。
    pub samples: Vec<String>,
    pub elapsed_ms: u64,
    pub error: Option<String>,
}

/// 自定义源文件：`<data_dir>/custom-sources.json`。
pub fn custom_sources_path() -> PathBuf {
    crate::short_drama_app::cache_dir()
        .parent()
        .map(|dir| dir.join("custom-sources.json"))
        .unwrap_or_else(|| PathBuf::from("custom-sources.json"))
}

/// 读全部自定义源。文件不存在/损坏时返回空表——不该因为一个坏文件把设置页打死。
pub fn load_custom_sources() -> Vec<CustomSource> {
    let Ok(raw) = std::fs::read_to_string(custom_sources_path()) else {
        return Vec::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_custom_sources(list: &[CustomSource]) -> Result<(), String> {
    let path = custom_sources_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json =
        serde_json::to_string_pretty(list).map_err(|error| format!("序列化源失败：{error}"))?;
    std::fs::write(&path, json).map_err(|error| format!("写源文件失败：{error}"))
}

/// 校验并规范化一条源。规则与 `视频源格式.txt` 的第八节逐条对应。
pub fn normalize_source(source: CustomSource) -> Result<CustomSource, String> {
    let id = source.id.trim().to_ascii_lowercase();
    if id.len() < 2 || id.len() > 40 {
        return Err("源标识长度必须是 2~40 个字符。".into());
    }
    if !id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("源标识只能包含小写字母、数字、- 和 _。".into());
    }
    if BUILTIN_SOURCES.iter().any(|builtin| builtin.id == id) {
        return Err(format!("「{id}」是内置源 id，不能占用。"));
    }
    let name = source.name.trim().to_string();
    if name.is_empty() {
        return Err("源名称不能为空。".into());
    }
    if name.chars().count() > 40 {
        return Err("源名称最多 40 个字符。".into());
    }
    let api = source.api.trim().to_string();
    if !(api.starts_with("http://") || api.starts_with("https://")) {
        return Err("接口地址必须是以 http:// 或 https:// 开头的完整地址。".into());
    }
    let kind = match source.kind.trim() {
        "live" => "live",
        "comic" => "comic",
        _ => "both",
    }
    .to_string();
    Ok(CustomSource {
        id,
        name,
        api,
        enabled: source.enabled,
        adult: source.adult,
        kind,
        category: source
            .category
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        type_id: source
            .type_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        headers: source.headers,
        note: source
            .note
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
    })
}

/// 追加一条源（重复 id 拒绝；要改已有源请先删除）。
pub fn add_custom_source(source: CustomSource) -> Result<CustomSource, String> {
    let source = normalize_source(source)?;
    let mut list = load_custom_sources();
    if list.iter().any(|item| item.id == source.id) {
        return Err(format!(
            "源标识「{}」已存在，请换一个或先删除旧的。",
            source.id
        ));
    }
    list.push(source.clone());
    save_custom_sources(&list)?;
    Ok(source)
}

/// 删除一条源。返回是否真的删掉了（不存在时不算错误）。
pub fn remove_custom_source(id: &str) -> Result<bool, String> {
    let id = id.trim();
    let mut list = load_custom_sources();
    let before = list.len();
    list.retain(|item| item.id != id);
    let removed = list.len() != before;
    if removed {
        save_custom_sources(&list)?;
    }
    Ok(removed)
}

/// 启停一条源。
pub fn toggle_custom_source(id: &str, enabled: bool) -> Result<(), String> {
    let mut list = load_custom_sources();
    let Some(item) = list.iter_mut().find(|item| item.id == id) else {
        return Err(format!("找不到源「{id}」。"));
    };
    item.enabled = enabled;
    save_custom_sources(&list)
}

/// 拼列表请求地址。
///
/// 苹果 CMS 的 API 根通常以 `/` 结尾（`…/provide/vod/`），查询串必须用 `?` 接上；
/// 直接在末尾追加 `ac=…` 会把它并进路径（历史坑：返回字段从 83 个掉到 8 个，
/// 封面与分集全空，见 `anime_provider` 的同名注释）。
pub fn build_list_url(source: &CustomSource, page: u32) -> String {
    let base = source.api.trim();
    let separator = if base.contains('?') { '&' } else { '?' };
    let mut url = format!("{base}{separator}ac=detail&pg={page}");
    if let Some(type_id) = source
        .type_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        url.push_str("&t=");
        url.push_str(&percent_encode(type_id));
    }
    url
}

/// 只转义查询串里真正危险的那几个字符（这个项目不引 urlencoding 依赖）。
pub fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push_str("%20"),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// 真实请求一次列表接口，回答"这个源现在通不通"。
///
/// 走 `with_local_proxy_fallback`：自定义源大多是境外站点，系统代理没开时也要能
/// 用本机探测到的代理（与动漫/更新链路同一套策略）。
pub async fn probe_custom_source(id: &str) -> Result<ProbeResult, String> {
    let source = load_custom_sources()
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| format!("找不到源「{id}」。"))?;
    probe_source(&source).await
}

/// 对一条**内存里**的源做探测（添加前预检、联调测试都走它，不依赖落盘）。
pub async fn probe_source(source: &CustomSource) -> Result<ProbeResult, String> {
    let url = build_list_url(source, 1);
    let started = std::time::Instant::now();
    let client = crate::update::with_local_proxy_fallback(reqwest::Client::builder())
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        )
        .connect_timeout(std::time::Duration::from_secs(8))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| format!("无法创建网络客户端：{error}"))?;
    let mut request = client.get(&url);
    for (key, value) in &source.headers {
        request = request.header(key, value);
    }
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            format!("请求超时：{url}")
        } else {
            format!("请求失败：{error}")
        }
    })?;
    if !response.status().is_success() {
        return Err(format!("接口返回 HTTP {}", response.status()));
    }
    // 不用 `response.json()`：本项目的 reqwest 没启用 `json` feature（只开了
    // rustls/gzip 那几项），解码统一走 serde_json::from_slice，与动漫源一致。
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取响应失败：{error}"))?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|error| format!("响应不是合法 JSON：{error}"))?;
    let list = value
        .get("list")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let samples: Vec<String> = list
        .iter()
        .take(5)
        .filter_map(|item| item.get("vod_name").and_then(|name| name.as_str()))
        .map(str::to_string)
        .collect();
    let total = value
        .get("total")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(list.len() as i64);
    Ok(ProbeResult {
        ok: !list.is_empty(),
        url,
        total,
        count: list.len(),
        samples,
        elapsed_ms: started.elapsed().as_millis() as u64,
        error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> CustomSource {
        CustomSource {
            id: "demo".into(),
            name: "示例".into(),
            api: "https://example.com/api.php/provide/vod/".into(),
            enabled: true,
            adult: false,
            kind: "both".into(),
            category: None,
            type_id: None,
            headers: BTreeMap::new(),
            note: None,
        }
    }

    /// 内置源必须**恰好两条且固定**：多一条说明有人又把源焊回核心里。
    #[test]
    fn builtin_sources_are_exactly_the_two_pinned_ones() {
        assert_eq!(BUILTIN_SOURCES.len(), 2);
        let ids: Vec<&str> = BUILTIN_SOURCES.iter().map(|source| source.id).collect();
        assert_eq!(ids, vec!["hongguo", "anime"]);
        assert!(BUILTIN_SOURCES
            .iter()
            .any(|source| source.id == PINNED_SOURCE_ID));
        assert!(BUILTIN_SOURCES
            .iter()
            .any(|source| source.kind == BuiltinKind::Anime));
    }

    /// 列表地址必须补 `?`，且 `t` 参数要能拼上。
    #[test]
    fn list_url_always_carries_a_question_mark() {
        let mut source = sample();
        assert!(build_list_url(&source, 1).ends_with("?ac=detail&pg=1"));

        source.type_id = Some("39".into());
        assert!(build_list_url(&source, 2).ends_with("?ac=detail&pg=2&t=39"));

        // 根地址已经带查询串时改用 `&`，不能拼出 `??`。
        source.api = "https://example.com/api.php?provide=vod".into();
        assert!(build_list_url(&source, 1).contains("?provide=vod&ac=detail"));
    }

    /// 拒绝占用内置 id、拒绝非法协议、未知 kind 归一为 both。
    #[test]
    fn normalize_rejects_reserved_ids_and_bad_api() {
        let mut source = sample();
        source.id = "hongguo".into();
        assert!(normalize_source(source.clone()).is_err());

        source.id = "demo".into();
        source.api = "ftp://example.com".into();
        assert!(normalize_source(source.clone()).is_err());

        source.api = "https://example.com/".into();
        source.kind = "动漫".into();
        let normalized = normalize_source(source).expect("应当通过");
        assert_eq!(normalized.kind, "both");
    }

    /// id 只允许小写字母/数字/`-`/`_`，且会被规范成小写。
    #[test]
    fn normalize_lowercases_and_rejects_illegal_id() {
        let mut source = sample();
        source.id = "Demo Source".into();
        assert!(normalize_source(source.clone()).is_err());

        source.id = "Demo-Source".into();
        let normalized = normalize_source(source).expect("大写应被规范成小写");
        assert_eq!(normalized.id, "demo-source");
    }

    /// 联调：对真实苹果 CMS 接口探一次，验证「拼 URL → 发请求 → 解析 list」
    /// 这条链路（含系统代理未开时自动走本机探测代理）。
    ///
    /// 默认 `#[ignore]`：要联网。排障时手动跑：
    ///   cargo test --bin ttv-short-drama probe_works_against_a_real_endpoint -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "需要联网，只在排障时手动跑"]
    async fn probe_works_against_a_real_endpoint() {
        let source = CustomSource {
            id: "bfzy-demo".into(),
            name: "暴风资源".into(),
            api: "https://bfzyapi.com/api.php/provide/vod/".into(),
            enabled: true,
            adult: false,
            kind: "both".into(),
            category: None,
            type_id: Some("39".into()),
            headers: BTreeMap::new(),
            note: None,
        };
        let result = probe_source(&source).await.expect("探测应成功");
        println!(
            "ok={} total={} count={} elapsed={}ms samples={:?}",
            result.ok, result.total, result.count, result.elapsed_ms, result.samples
        );
        assert!(result.ok, "应至少解析出一条条目");
        assert!(result.count > 0);
    }
}
