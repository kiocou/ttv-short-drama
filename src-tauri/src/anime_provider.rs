//! 动漫专区数据源。两条后端：
//!
//! 1. **正式源：动漫共和国（dmghg）** —— 见 `crate::dmghg_bridge`。
//!    直接驱动厂商的 `electron_bridge` DLL，列表/搜索/详情/播放地址全部现成，
//!    免登录、免 VIP。播放地址是 MP4 直链（实测 `ftypisom`，支持 Range）。
//!    剧集 id 带 `dmghg:` 前缀，与下面的暴风源区分开。
//!
//! 2. **兜底源：暴风资源（苹果CMS V10 协议，bfzyapi.com）** ——
//!    列表/搜索/详情/播放直链全部可直连，无需登录（实测 2026-09）。
//!    播放地址是 m3u8（vod_play_from=bfzym3u8），经 hls_proxy 转成本地流播放。
//!
//! 走哪条由 `use_dmghg()` 决定：默认优先正式源，DLL 不可用时自动回退暴风。
//! 环境变量 `TTV_ANIME_SOURCE=bfzy` 可强制走兜底源。

use crate::models::{
    CatalogFilter, CatalogPage, EpisodeItem, PlaybackSession, SeriesDetail, SeriesItem,
    VideoQualityOption,
};
use serde_json::Value;
use std::time::Duration;

const BFZY_API: &str = "https://bfzyapi.com/api.php/provide/vod/";

pub struct AnimeProvider {
    client: reqwest::Client,
}

impl AnimeProvider {
    pub fn new() -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36")
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(20))
            .pool_idle_timeout(Duration::from_secs(600))
            .pool_max_idle_per_host(4)
            .tcp_nodelay(true)
            .build()
            .map_err(|error| error.to_string())?;
        // 启动时探一次数据源并写进日志：否则"卡片怎么还是暴风的"没法查。
        if use_dmghg() {
            println!("[anime] 数据源: 动漫共和国（正式源）");
        } else {
            println!("[anime] 数据源: 暴风资源（兜底源）");
            if let Some(error) = crate::dmghg_bridge::init_error() {
                println!("[anime] dmghg 不可用原因: {error}");
            }
        }
        Ok(Self { client })
    }

    async fn get_json(&self, query: &str) -> Result<Value, String> {
        let url = format!("{BFZY_API}{query}");
        let response = self
            .client
            .get(&url)
            .header("Referer", "https://bfzyapi.com/")
            .send()
            .await
            .map_err(|error| format!("动漫源请求失败: {error}"))?;
        if !response.status().is_success() {
            return Err(format!("动漫源响应异常: HTTP {}", response.status()));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("动漫源读取失败: {error}"))?;
        serde_json::from_slice(&bytes).map_err(|error| format!("动漫源数据解析失败: {error}"))
    }

    pub async fn catalog(&self, filter: &CatalogFilter) -> Result<CatalogPage, String> {
        // 正式源优先：由 dmghg 桥接直接取数据（含真实分类表）。
        if use_dmghg() {
            return crate::dmghg_bridge::catalog_async(filter.clone()).await;
        }
        let page = filter.page.max(1);
        // 苹果CMS 分类 id：39 动漫片 / 40 国产动漫 / 41 日韩动漫 / 42 欧美动漫 /
        // 43 港台动漫 / 44 海外动漫 / 50 动画片
        let type_id = match filter.category.as_str() {
            "国产动漫" => 40,
            "日韩动漫" => 41,
            "欧美动漫" => 42,
            "港台动漫" => 43,
            "海外动漫" => 44,
            "动画片" => 50,
            _ => 39,
        };
        let json = if let Some(keyword) = filter
            .keyword
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            // 搜索走 wd 参数（ac=detail 返回封面与播放地址元数据）。
            self.get_json(&format!("ac=detail&wd={}&pg={page}", urlencode(keyword)))
                .await?
        } else {
            // 列表必须走 ac=detail 模式：ac=list 不返回 vod_pic（封面全空）
            // 与 vod_play_url，实测 2026-09。ac=detail 支持同样的 t/pg 筛选。
            self.get_json(&format!("ac=detail&t={type_id}&pg={page}"))
                .await?
        };

        let list = json
            .get("list")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let has_more = {
            let pagecount = json
                .get("pagecount")
                .and_then(Value::as_i64)
                .unwrap_or(page as i64) as u32;
            page < pagecount
        };
        let total = json
            .get("total")
            .and_then(Value::as_i64)
            .unwrap_or(list.len() as i64) as usize;

        let mut items = Vec::new();
        for vod in &list {
            if let Some(item) = parse_series_item(vod) {
                items.push(item);
            }
        }

        // 分类标签固定为动漫分类集合（搜索时只回"全部"）。
        let categories = if filter.keyword.is_some() {
            vec!["全部".to_string()]
        } else {
            vec![
                "全部".to_string(),
                "国产动漫".to_string(),
                "日韩动漫".to_string(),
                "欧美动漫".to_string(),
                "港台动漫".to_string(),
                "海外动漫".to_string(),
                "动画片".to_string(),
            ]
        };

        Ok(CatalogPage {
            total,
            items,
            has_more,
            page,
            categories,
            next_cursor: has_more.then(|| (page + 1).to_string()),
            source: "暴风动漫源".into(),
        })
    }

    pub async fn detail(&self, series_id: &str) -> Result<SeriesDetail, String> {
        // 正式源优先：`series_id` 带 `dmghg:` 前缀时走 DLL 桥接。
        if use_dmghg() {
            return crate::dmghg_bridge::detail_async(series_id.to_string()).await;
        }
        let id: i64 = series_id
            .parse()
            .map_err(|_| "动漫剧集 id 非法。".to_string())?;
        let json = self.get_json(&format!("ac=detail&ids={id}")).await?;
        let vod = json
            .get("list")
            .and_then(Value::as_array)
            .and_then(|list| list.first())
            .cloned()
            .ok_or_else(|| "动漫详情未找到该剧集。".to_string())?;

        let title = str_field(&vod, &["vod_name"]).unwrap_or_else(|| "未命名动漫".into());
        let cover = str_field(&vod, &["vod_pic"]).unwrap_or_default();
        let tags = class_tags(&vod);
        let (episodes, episodes_count) = parse_episodes(&vod, series_id);

        Ok(SeriesDetail {
            id: series_id.to_string(),
            title,
            cover,
            item_type: "anime".into(),
            tags,
            origin: "暴风动漫源".into(),
            episodes_count,
            description: strip_html(&str_field(&vod, &["vod_content"]).unwrap_or_default()),
            episodes,
            available_qualities: vec![VideoQualityOption {
                label: "自动".into(),
                value: "auto".into(),
                resolution: "由播放源自动选择".into(),
            }],
            sources: Vec::new(),
        })
    }

    /// 探测某集的清晰度档位。
    ///
    /// 详情接口不返回档位（dmghg 的档位藏在播放解析里），所以只能在真正要播
    /// 这一集时探一次。档位数随作品/线路而变，实测 1~2 档。
    pub async fn qualities(
        &self,
        series_id: &str,
        episode_id: &str,
    ) -> Result<Vec<VideoQualityOption>, String> {
        if use_dmghg() {
            return crate::dmghg_bridge::qualities_async(
                series_id.to_string(),
                episode_id.to_string(),
            )
            .await;
        }
        // 暴风源只有一路，没有档位可选。
        Ok(Vec::new())
    }

    pub async fn open_episode(
        &self,
        session_id: u64,
        series_id: &str,
        episode_id: &str,
        position: f64,
        quality: &str,
    ) -> Result<PlaybackSession, String> {
        // 正式源优先：dmghg 解析出真实地址后，按需过本地代理。
        if use_dmghg() {
            let url = crate::dmghg_bridge::resolve_play_url_async(
                series_id.to_string(),
                episode_id.to_string(),
                quality.to_string(),
            )
            .await?;
            // 不同选集线路回来的格式不一样（实测）：
            //   仙逆 cn 线          -> https MP4 直链，原生 <video src> 可播
            //   恋爱与选举 newup-jp -> http 明文 m3u8
            // http 明文会被 CSP 的 media-src/connect-src 拦掉（只放行 https 与
            // 127.0.0.1），而且这些 CDN 不给 CORS 头，hls.js 直拉同样过不了。
            // 所以 m3u8 与非 https 一律走本地代理：一次解决 CSP、CORS 与分片重写。
            let url = if url.contains(".m3u8") || !url.starts_with("https://") {
                crate::hls_proxy::proxied_url(&url).unwrap_or(url)
            } else {
                url
            };
            return Ok(PlaybackSession {
                session_id,
                series_id: series_id.to_string(),
                episode_id: episode_id.to_string(),
                position,
                quality: "auto".into(),
                url,
                backup_url: None,
            });
        }
        // 播放地址在详情接口的 vod_play_url 里：`第1集$https://...m3u8#第2集$https://...`
        let id: i64 = series_id
            .parse()
            .map_err(|_| "动漫剧集 id 非法。".to_string())?;
        let json = self.get_json(&format!("ac=detail&ids={id}")).await?;
        let vod = json
            .get("list")
            .and_then(Value::as_array)
            .and_then(|list| list.first())
            .cloned()
            .ok_or_else(|| "动漫详情未找到该剧集。".to_string())?;
        let urls = str_field(&vod, &["vod_play_url"]).unwrap_or_default();
        let mut direct = None;
        let mut backup = None;
        for part in urls.split('#') {
            let mut segs = part.splitn(2, '$');
            let ep_title = segs.next().unwrap_or("").trim();
            let url = segs.next().unwrap_or("").trim();
            if url.is_empty() || !url.starts_with("http") {
                continue;
            }
            if ep_title == episode_id
                || normalize_ep_title(ep_title) == normalize_ep_title(episode_id)
            {
                direct = Some(url.to_string());
                break;
            }
            if backup.is_none() {
                backup = Some(url.to_string());
            }
        }
        let url = direct
            .or(backup)
            .ok_or_else(|| "该集没有可用的播放地址。".to_string())?;
        // m3u8 由本地 HLS 代理转发，绕过 WebView2 原生不支持 m3u8 的限制。
        let proxied = crate::hls_proxy::proxied_url(&url).unwrap_or(url);
        Ok(PlaybackSession {
            session_id,
            series_id: series_id.to_string(),
            episode_id: episode_id.to_string(),
            position,
            quality: "auto".into(),
            url: proxied,
            backup_url: None,
        })
    }
}

fn urlencode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn str_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    })
}

fn parse_series_item(vod: &Value) -> Option<SeriesItem> {
    let id = vod.get("vod_id").and_then(Value::as_i64)?.to_string();
    let title = str_field(vod, &["vod_name"])?;
    let cover = str_field(vod, &["vod_pic"]).unwrap_or_default();
    let type_name = str_field(vod, &["type_name"]).unwrap_or_else(|| "动漫".into());
    let remarks = str_field(vod, &["vod_remarks"]).unwrap_or_default();
    // 集数从 remarks（"更新至第6集"/"第10集"）提取；"已完结"等无数字 remarks
    // 保留原文（前端显示完结状态，不显示"集数未知"）。
    let episodes_count = extract_episode_count(&remarks);
    Some(SeriesItem {
        id,
        title,
        cover,
        item_type: "anime".into(),
        episodes_count,
        latest_episode_title: (!remarks.is_empty()).then_some(remarks.clone()),
        tags: vec![type_name],
        origin: "暴风动漫源".into(),
        brief: Some(remarks),
    })
}

fn extract_episode_count(remarks: &str) -> u32 {
    // "更新至第287集" → 287；"已完结"/"HD" 等无数字返回 0（前端显示 remarks 原文）。
    let digits: String = remarks
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().unwrap_or(0)
}

fn class_tags(vod: &Value) -> Vec<String> {
    let mut tags = Vec::new();
    if let Some(name) = str_field(vod, &["type_name"]) {
        tags.push(name);
    }
    if let Some(class) = str_field(vod, &["vod_class"]) {
        for tag in class.split(',').map(str::trim).filter(|t| !t.is_empty()) {
            if !tags.iter().any(|existing| existing == tag) {
                tags.push(tag.to_string());
            }
        }
    }
    tags
}

fn parse_episodes(vod: &Value, series_id: &str) -> (Vec<EpisodeItem>, u32) {
    // vod_play_url 形如 `第1集$https://...m3u8#第2集$https://...m3u8`。
    // 优先取 m3u8 源（bfzym3u8）。
    let urls = str_field(vod, &["vod_play_url"]).unwrap_or_default();
    let mut episodes = Vec::new();
    for (index, part) in urls.split('#').enumerate() {
        let mut segs = part.splitn(2, '$');
        let ep_title = segs.next().unwrap_or("").trim();
        let url = segs.next().unwrap_or("").trim();
        if url.is_empty() || !url.starts_with("http") {
            continue;
        }
        episodes.push(EpisodeItem {
            id: ep_title.to_string(),
            series_id: series_id.to_string(),
            episode_number: (index + 1) as u32,
            title: ep_title.to_string(),
            duration_seconds: 0.0,
            preview_url: None,
        });
    }
    let count = episodes.len() as u32;
    (episodes, count)
}

fn normalize_ep_title(title: &str) -> String {
    // clippy::collapsible_str_replace：一次 replace 传字符数组即可，语义与两次链式相同。
    title.replace([' ', '\u{3000}'], "")
}

fn strip_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.trim().to_string()
}

/// 是否走 dmghg 正式源。
///
/// 可用性只在进程内判一次（DLL 加载失败会永久回退到暴风），避免出现
/// "列表来自 dmghg、详情却落到暴风" 这种 id 串源的情况。
fn use_dmghg() -> bool {
    crate::dmghg_bridge::preferred() && crate::dmghg_bridge::available()
}
