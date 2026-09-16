use crate::models::{
    CatalogFilter, CatalogPage, EpisodeItem, PlaybackSession, SeriesDetail, SeriesItem,
    VideoQualityOption,
};
use regex::Regex;
use reqwest::Client;
use scraper::{Html, Selector};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::time::Duration;

const HONGGUO_BASE: &str = "https://hongguoduanju.com";
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

pub struct DramaProvider {
    client: Client,
}

impl DramaProvider {
    pub fn new() -> Result<Self, String> {
        let client = Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36")
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(20))
            // 连接池保活：目录/详情每次翻页与换剧都是同一主机的新请求，
            // 默认池空闲 90s 就关连接，再次请求要重新 TLS 握手（1-2 RTT）。
            // 拉长空闲窗口让翻页/换剧复用已建立的连接，首字节快一截。
            .pool_idle_timeout(Duration::from_secs(600))
            .pool_max_idle_per_host(4)
            .tcp_nodelay(true)
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self { client })
    }

    pub async fn catalog(&self, filter: &CatalogFilter) -> Result<CatalogPage, String> {
        let requested_page = parse_page(filter.cursor.as_deref()).unwrap_or(filter.page.max(1));
        // 关键词搜索必须走站点自己的搜索路由。
        //
        // 旧实现是在"当前这一页"的 24 条里做本地过滤，而全站有 800+ 部：
        // 搜"好雨"能命中（它恰好在第一页）、搜"战神"返回 0 条。用户看到的
        // 就是"搜索框没用"。
        if let Some(keyword) = filter
            .keyword
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return self.search_catalog(filter, keyword, requested_page).await;
        }
        if filter.channel == "comic" {
            return self.catalog_comic(filter, requested_page).await;
        }
        let path = if requested_page <= 1 {
            "/category".to_string()
        } else {
            format!("/category?page={requested_page}")
        };
        let html = self.fetch_page(&path).await?;
        let router_data = parse_router_data(&html);
        let raw_items = parse_catalog_cards(&html, filter.channel.as_str());
        let categories = categories_for(&raw_items);
        let mut items = raw_items
            .into_iter()
            .filter(|item| matches_filter(item, filter))
            .collect::<Vec<_>>();
        items.truncate(filter.page_size.clamp(1, 60) as usize);
        // 分页总数优先取站点自带的 loaderData 元数据（实测 /category → 34 页），
        // 取不到再退回"扫描分页链接里的最大页码"。
        let total_pages = router_data
            .as_ref()
            .and_then(|value| find_pagination_value(value, &["totalPages", "total_pages"]))
            .unwrap_or_else(|| detect_total_pages(&html, filter.channel.as_str()))
            .max(requested_page);
        let total = router_data
            .as_ref()
            .and_then(|value| find_pagination_value(value, &["total"]))
            .map(|value| value as usize)
            .unwrap_or(items.len());
        // 空页即到底：即使页码估算偏大，也不会让无限滚动空转。
        let has_more = !items.is_empty() && requested_page < total_pages;
        Ok(CatalogPage {
            total,
            items,
            has_more,
            page: requested_page,
            categories,
            next_cursor: has_more.then(|| (requested_page + 1).to_string()),
            source: if filter.channel == "comic" {
                format!("红果漫剧公开榜单 · {}", sort_label(&filter.sort))
            } else {
                format!("红果短剧公开目录 · {}", sort_label(&filter.sort))
            },
        })
    }

    /// 全站搜索：走站点自己的 `/search/{keyword}` 路由。
    ///
    /// 站点把搜索结果放在 SSR 的 router data 里（loaderData 下键名形如
    /// "search_(keyword)/page"，内含 searchList），因此无需逆向内部 XHR 接口，
    /// 也不需要翻 34 页目录自己做索引。
    async fn search_catalog(
        &self,
        filter: &CatalogFilter,
        keyword: &str,
        requested_page: u32,
    ) -> Result<CatalogPage, String> {
        // 依次尝试原词与中文数字变体，合并去重（原词结果排在前面）。
        //
        // 站点剧名普遍使用中文数字，而它的搜索接口不做数字归一：实测搜
        // "…真BOSS第11季"会被模糊匹配到"第十季"，精确的那一部反而找不到，
        // 用户看到的就是"显示了其他几季、还不连续"。
        let mut items: Vec<SeriesItem> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let mut last_error: Option<String> = None;
        for variant in keyword_variants(keyword) {
            let encoded = encode_uri_component(&variant);
            let html = match self.fetch_page(&format!("/search/{encoded}")).await {
                Ok(html) => html,
                Err(error) => {
                    last_error = Some(error);
                    continue;
                }
            };
            let Some(data) = parse_router_data(&html) else {
                continue;
            };
            for item in parse_search_items(&data, &filter.channel) {
                if seen.insert(item.id.clone()) {
                    items.push(item);
                }
            }
        }
        if items.is_empty() {
            if let Some(error) = last_error {
                return Err(error);
            }
        }
        // 刻意不再叠加列表页的题材/受众筛选：站点返回的本就是按相关度排序的
        // 搜索结果，再用"当前选中的题材"剪一刀就会出现"明明搜得到却显示不全"。
        // 筛选器服务于浏览目录，不该作用于搜索。
        let categories = categories_for(&items);
        let page_size = filter.page_size.clamp(1, 60) as usize;
        let total = items.len();
        let start = ((requested_page.saturating_sub(1)) as usize * page_size).min(total);
        let page_items = items.drain(start..).take(page_size).collect::<Vec<_>>();
        let has_more = start + page_items.len() < total;
        Ok(CatalogPage {
            total,
            items: page_items,
            has_more,
            page: requested_page,
            categories,
            next_cursor: has_more.then(|| (requested_page + 1).to_string()),
            source: format!("红果官网搜索 · {keyword}"),
        })
    }

    async fn catalog_comic(
        &self,
        filter: &CatalogFilter,
        requested_page: u32,
    ) -> Result<CatalogPage, String> {
        // 首屏只取当前公开分页，后续由前端滚动加载继续请求，避免打开漫剧页时等待整榜。
        let path = if requested_page <= 1 {
            "/rank/hot-comic-drama".to_string()
        } else {
            format!("/rank/hot-comic-drama?page={requested_page}")
        };
        let html = self.fetch_page(&path).await?;
        let page_items = parse_catalog_cards(&html, "comic");
        let categories = categories_for(&page_items);
        // 漫剧榜单页没有 pagination 元数据，只靠分页链接推算（实测分页链接到 5）。
        let total_pages = router_data_total_pages(&html, "comic").max(requested_page);
        let filtered = page_items
            .into_iter()
            .filter(|item| matches_filter(item, filter))
            .collect::<Vec<_>>();
        let page_size = filter.page_size.clamp(1, 60) as usize;
        let items = filtered.into_iter().take(page_size).collect::<Vec<_>>();
        let has_more = !items.is_empty() && requested_page < total_pages;

        Ok(CatalogPage {
            total: items.len(),
            items,
            has_more,
            page: requested_page,
            categories,
            next_cursor: has_more.then(|| (requested_page + 1).to_string()),
            source: format!("红果漫剧公开榜单 · {}", sort_label(&filter.sort)),
        })
    }

    pub async fn detail(
        &self,
        series_id: &str,
        channel: Option<&str>,
    ) -> Result<SeriesDetail, String> {
        validate_numeric_id(series_id, "剧集")?;
        let html = self
            .fetch_page(&format!("/detail?series_id={series_id}"))
            .await?;
        let data =
            parse_router_data(&html).ok_or_else(|| "详情页未包含可读取的公开数据。".to_string())?;
        let series =
            find_series(&data, series_id).ok_or_else(|| "详情页未找到剧集信息。".to_string())?;
        let vids = string_array(series.get("vid_list"));
        let total = number_field(
            series,
            &["episode_cnt", "episode_total_cnt", "accessible_episode_cnt"],
        )
        .unwrap_or(vids.len() as u32);
        let cover = string_field(series, &["series_cover", "cover"]);
        let title = string_field(series, &["series_name", "title"]);
        let tags = string_array(series.get("tags"));
        let episodes = vids
            .iter()
            .enumerate()
            .map(|(index, vid)| EpisodeItem {
                id: vid.clone(),
                series_id: series_id.to_string(),
                episode_number: (index + 1) as u32,
                title: format!("第 {} 集", index + 1),
                duration_seconds: 0.0,
                preview_url: None,
            })
            .collect();
        Ok(SeriesDetail {
            id: series_id.to_string(),
            title: if title.is_empty() {
                "未命名短剧".into()
            } else {
                title
            },
            cover,
            item_type: if channel == Some("comic") {
                "comic".into()
            } else {
                "drama".into()
            },
            tags,
            origin: if channel == Some("comic") {
                "红果漫剧".into()
            } else {
                "红果短剧官网".into()
            },
            episodes_count: total,
            description: string_field(series, &["series_intro", "intro", "description"]),
            episodes,
            // 公开网页不提供可信的多清晰度列表：只有 auto 一条真实路径。
            // 之前硬编码 4K/1080P/720P 会让"切清晰度"变成重复下载同一路流，
            // 且档位与真实分辨率不符（4K 实为 1080p、1080P 实为 540p）。
            // 真实档位由 App-API 的 short_drama_app_stream 返回 variants 后再补充。
            available_qualities: vec![VideoQualityOption {
                label: "自动".into(),
                value: "auto".into(),
                resolution: "由播放源自动选择".into(),
            }],
            sources: Vec::new(),
        })
    }

    pub async fn open_episode(
        &self,
        session_id: u64,
        series_id: &str,
        episode_id: &str,
        quality: &str,
        position: f64,
    ) -> Result<PlaybackSession, String> {
        validate_numeric_id(series_id, "剧集")?;
        validate_numeric_id(episode_id, "剧集分集")?;
        // 站点路由是 /player/{series_id}（实测 200），整部剧的播放数据都在这张
        // 页上。旧实现拼成 /player/{series}/{episode}，实测恒定返回 404 —— 这条
        // 兜底链路从来没有成功过，只会把本地解析的真实失败原因盖成"HTTP 404"。
        let html = self.fetch_page(&format!("/player/{series_id}")).await?;
        let data =
            parse_router_data(&html).ok_or_else(|| "播放页未包含可读取的公开数据。".to_string())?;
        // 公开页只带"默认集"的播放数据，所以必须确认它确实属于请求的这一集。
        // 拿别的集的地址去播比播不出来更糟：用户会看到完全不相干的内容。
        let mut page_vids = Vec::new();
        collect_vids(&data, &mut page_vids);
        if !page_vids.iter().any(|candidate| candidate == episode_id) {
            return Err("该集没有公开网页直链（公开页仅提供默认集）。".into());
        }
        let player = find_player_info(&data)
            .ok_or_else(|| "该集没有公开网页播放信息，可能仅限官方 App。".to_string())?;
        let mut urls = Vec::new();
        for key in ["main_url", "play_url", "video_url", "url", "backup_url"] {
            if let Some(url) = player
                .get(key)
                .and_then(Value::as_str)
                .filter(|value| is_playback_url(value))
            {
                push_unique(&mut urls, url.to_string());
            }
        }
        for value in player.values() {
            collect_playback_urls(value, &mut urls);
        }
        // Final boundary protection: every URL sent to the WebView must be a
        // real query string, never an HTML-escaped variant such as `&amp;`.
        for value in &mut urls {
            *value = normalize_playback_url(value);
        }
        let url = select_quality_url(&urls, quality)
            .ok_or_else(|| "未找到公开可播放 URL，该集可能需要官方 App。".to_string())?;
        let backup_url = urls.iter().find(|candidate| *candidate != &url).cloned();
        Ok(PlaybackSession {
            session_id,
            series_id: series_id.to_string(),
            episode_id: episode_id.to_string(),
            position: position.max(0.0),
            quality: if quality.trim().is_empty() {
                "auto".into()
            } else {
                quality.into()
            },
            url,
            backup_url,
        })
    }

    async fn fetch_page(&self, path: &str) -> Result<String, String> {
        fetch_page_with_client(self.client.clone(), path.to_string()).await
    }
}

async fn fetch_page_with_client(client: Client, path: String) -> Result<String, String> {
    let response = client
        .get(format!("{HONGGUO_BASE}{path}"))
        .send()
        .await
        .map_err(|error| format!("目录请求失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("目录服务返回 HTTP {}。", response.status()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取目录响应失败：{error}"))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("目录响应超过安全大小限制。".into());
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| "目录响应不是 UTF-8。".into())
}

/// 生成搜索关键词的候选形式：原词 + 阿拉伯数字转中文数字的变体。
fn keyword_variants(keyword: &str) -> Vec<String> {
    let mut variants = vec![keyword.to_owned()];
    let converted = replace_arabic_with_chinese(keyword);
    if converted != keyword {
        variants.push(converted);
    }
    variants
}

/// 把独立出现的阿拉伯数字段整体转成中文数字（"第11季" -> "第十一季"）。
///
/// 只处理被非数字字符分隔的连续数字段，上限 99（分季数不会更大）；超出范围的
/// 数字原样保留，避免把非季数内容改得不伦不类。
fn replace_arabic_with_chinese(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut digits = String::new();
    for ch in input.chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
            continue;
        }
        if !digits.is_empty() {
            flush_number(&mut out, &digits);
            digits.clear();
        }
        out.push(ch);
    }
    if !digits.is_empty() {
        flush_number(&mut out, &digits);
    }
    out
}

fn flush_number(out: &mut String, digits: &str) {
    match digits.parse::<u32>() {
        Ok(value) if value <= 99 => out.push_str(&to_chinese_number(value)),
        _ => out.push_str(digits),
    }
}

fn to_chinese_number(value: u32) -> String {
    const DIGITS: [&str; 10] = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
    match value {
        0..=9 => DIGITS[value as usize].to_string(),
        10 => "十".to_string(),
        11..=19 => format!("十{}", DIGITS[(value % 10) as usize]),
        20..=99 => {
            let tens = value / 10;
            let ones = value % 10;
            if ones == 0 {
                format!("{}十", DIGITS[tens as usize])
            } else {
                format!("{}十{}", DIGITS[tens as usize], DIGITS[ones as usize])
            }
        }
        _ => value.to_string(),
    }
}

/// 从搜索页的 router data 里提取剧集条目。
///
/// 实测数据形状：`loaderData["search_(keyword)/page"].searchList[]`，每项带
/// `video_data`，其中有 series_id / series_title / series_cover / episode_cnt /
/// category_list / series_intro。比抓 HTML 卡片可靠得多：标题、封面、集数、
/// 题材都是结构化字段，不受样式改版影响。
fn parse_search_items(data: &Value, channel: &str) -> Vec<SeriesItem> {
    let Some(list) = find_search_list(data) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for entry in list {
        let Some(video) = entry
            .get("video_data")
            .and_then(Value::as_object)
            .or_else(|| entry.as_object())
        else {
            continue;
        };
        let Some(id) = video.get("series_id").and_then(value_as_id) else {
            continue;
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        let title = string_field(video, &["series_title", "title", "name"]);
        if title.trim().is_empty() {
            continue;
        }
        let tags = video
            .get("category_list")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|entry| entry.get("name").and_then(Value::as_str))
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let brief = string_field(video, &["series_intro", "intro", "description"]);
        items.push(SeriesItem {
            id,
            title,
            cover: string_field(video, &["series_cover", "cover"]),
            item_type: if channel == "comic" {
                "comic".into()
            } else {
                "drama".into()
            },
            episodes_count: number_field(video, &["episode_cnt", "episode_total_cnt"]).unwrap_or(0),
            latest_episode_title: None,
            tags,
            origin: "红果官网搜索".into(),
            brief: (!brief.trim().is_empty()).then(|| brief.trim().to_string()),
        });
    }
    items
}

/// 按形状查找 searchList，不写死 loaderData 的键名——那是随路由命名的
/// （实测为 "search_(keyword)/page"），站点改版就会变。
fn find_search_list(value: &Value) -> Option<&Vec<Value>> {
    match value {
        Value::Object(map) => {
            if let Some(Value::Array(items)) = map.get("searchList") {
                return Some(items);
            }
            map.values().find_map(find_search_list)
        }
        Value::Array(items) => items.iter().find_map(find_search_list),
        _ => None,
    }
}

/// 按 RFC 3986 的 unreserved 规则做百分号编码（搜索关键词常含中文）。
fn encode_uri_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn parse_catalog_cards(html: &str, channel: &str) -> Vec<SeriesItem> {
    if channel == "comic" {
        return parse_comic_rank_cards(html);
    }

    let document = Html::parse_document(html);
    let anchor_selector = Selector::parse("a[href*='detail?series_id=']").expect("anchor selector");
    let image_selector = Selector::parse("img").expect("image selector");
    let source_selector = Selector::parse("source").expect("source selector");
    let episode_re = Regex::new(r"(?:全|更新至|第)\s*(\d+)\s*集").expect("episode regex");
    let id_re = Regex::new(r"series_id=(\d+)").expect("id regex");
    let mut seen = HashSet::new();
    let mut cards = Vec::new();

    for anchor in document.select(&anchor_selector) {
        let href = anchor.value().attr("href").unwrap_or_default();
        let Some(id) = id_re
            .captures(href)
            .and_then(|captures| captures.get(1))
            .map(|value| value.as_str().to_string())
        else {
            continue;
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        let title = anchor
            .select(&image_selector)
            .filter_map(|image| image.value().attr("alt"))
            .map(str::trim)
            .find(|value| !value.is_empty())
            .unwrap_or("未命名短剧")
            .to_string();
        let cover = anchor
            .select(&image_selector)
            .filter_map(|image| image.value().attr("src"))
            .find(|value| value.starts_with("https://") && !value.contains("empty_play"))
            .map(str::to_string)
            .or_else(|| {
                anchor
                    .select(&source_selector)
                    .filter_map(|source| source.value().attr("srcset"))
                    .next()
                    .map(str::to_string)
            })
            .unwrap_or_default();
        let text = anchor.text().collect::<Vec<_>>().join(" ");
        let episodes_count = episode_re
            .captures(&text)
            .and_then(|captures| captures.get(1))
            .and_then(|value| value.as_str().parse::<u32>().ok())
            .unwrap_or(0);
        let tags = anchor
            .text()
            .map(str::trim)
            .filter(|value| {
                !value.is_empty() && *value != title.as_str() && !episode_re.is_match(value)
            })
            .filter(|value| value.chars().count() <= 16)
            .map(str::to_string)
            .collect::<Vec<_>>();
        cards.push(SeriesItem {
            id,
            title,
            cover,
            item_type: if channel == "comic" {
                "comic".into()
            } else {
                "drama".into()
            },
            episodes_count,
            latest_episode_title: (episodes_count > 0).then(|| format!("全 {episodes_count} 集")),
            tags: unique(tags),
            origin: if channel == "comic" {
                "红果漫剧公开榜单".into()
            } else {
                "红果短剧公开目录".into()
            },
            brief: None,
        });
    }
    cards
}

fn parse_comic_rank_cards(html: &str) -> Vec<SeriesItem> {
    let document = Html::parse_document(html);
    let article_selector =
        Selector::parse("article[aria-labelledby]").expect("comic article selector");
    let detail_selector =
        Selector::parse("a[href*='detail?series_id=']").expect("comic detail selector");
    let title_selector = Selector::parse("h2[id^='rank-title-']").expect("comic title selector");
    let image_selector = Selector::parse("img").expect("comic image selector");
    let category_selector =
        Selector::parse("p[class*='pc-categories'] span").expect("comic category selector");
    let description_selector =
        Selector::parse("p[class*='pc-description']").expect("comic description selector");
    let episode_selector = Selector::parse("a[href*='/player/']").expect("comic episode selector");
    let id_re = Regex::new(r"series_id=(\d+)").expect("comic id regex");
    let mut seen = HashSet::new();
    let mut cards = Vec::new();

    for article in document.select(&article_selector) {
        let Some(detail_anchor) = article.select(&detail_selector).next() else {
            continue;
        };
        let href = detail_anchor.value().attr("href").unwrap_or_default();
        let Some(id) = id_re
            .captures(href)
            .and_then(|captures| captures.get(1))
            .map(|value| value.as_str().to_string())
        else {
            continue;
        };
        if !seen.insert(id.clone()) {
            continue;
        }

        let title = article
            .select(&title_selector)
            .next()
            .map(|node| node.text().collect::<String>())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "未命名漫剧".into());
        let cover = article
            .select(&image_selector)
            .filter_map(|image| image.value().attr("src"))
            .find(|value| value.starts_with("https://"))
            .map(str::to_string)
            .unwrap_or_default();
        let tags = article
            .select(&category_selector)
            .map(|node| node.text().collect::<String>().trim().to_string())
            .filter(|value| {
                !value.is_empty() && !value.chars().all(|character| character.is_ascii_digit())
            })
            .collect::<Vec<_>>();
        let episode_count = article.select(&episode_selector).count() as u32;
        let brief = article
            .select(&description_selector)
            .next()
            .map(|node| node.text().collect::<Vec<_>>().join(" "))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        cards.push(SeriesItem {
            id,
            title,
            cover,
            item_type: "comic".into(),
            episodes_count: episode_count,
            latest_episode_title: (episode_count > 0)
                .then(|| format!("已公开 {} 集", episode_count)),
            tags: unique(tags),
            origin: "红果漫剧公开榜单".into(),
            brief,
        });
    }
    cards
}

fn detect_total_pages(html: &str, channel: &str) -> u32 {
    // 站点把分类分页链接写成带 slug 的形式：/category/real-drama?page=2。
    // 旧正则只匹配 `/category?page=N`，被中间多出来的 slug 段挡住而永远失配，
    // 于是 total_pages 恒为 1、has_more 恒为 false —— 这正是"首页无限流消失"的根因。
    let route_pattern = if channel == "comic" {
        r#"href=[\"'](?:https?://[^\"']*)?/rank/hot-comic-drama\?page=(\d+)"#
    } else {
        r#"href=[\"'](?:https?://[^\"']*)?/category(?:/[A-Za-z0-9_\-]+)?\?page=(\d+)"#
    };
    let Ok(regex) = Regex::new(route_pattern) else {
        return 1;
    };
    regex
        .captures_iter(html)
        .filter_map(|captures| captures.get(1)?.as_str().parse::<u32>().ok())
        .max()
        .unwrap_or(1)
}

/// 在 loaderData 结构里按"形状"递归寻找分页字段。
///
/// 站点把分页元数据挂在随路由命名的键下面：短剧是 `category_$`（动态段以 `$` 结尾），
/// 漫剧是 `rank_hot-comic-drama`，键名随站点改版会变。旧实现写死了
/// `/loaderData/category_page/pagination/totalPages` 这个 JSON Pointer，
/// 站点用了别的键名，指针就返回 None，分页信息随之丢失。
/// 这里改为按形状搜索：任意一层中名为 `pagination` 的对象里的目标字段。
fn find_pagination_value(value: &Value, keys: &[&str]) -> Option<u32> {
    match value {
        Value::Object(object) => {
            if let Some(pagination) = object.get("pagination").and_then(Value::as_object) {
                for key in keys {
                    if let Some(found) = pagination.get(*key).and_then(Value::as_u64) {
                        return Some(found as u32);
                    }
                }
            }
            object
                .values()
                .find_map(|child| find_pagination_value(child, keys))
        }
        Value::Array(items) => items
            .iter()
            .find_map(|item| find_pagination_value(item, keys)),
        _ => None,
    }
}

/// 总页数：优先站点自带的元数据，其次扫描 HTML 里的分页链接。
fn router_data_total_pages(html: &str, channel: &str) -> u32 {
    parse_router_data(html)
        .as_ref()
        .and_then(|value| find_pagination_value(value, &["totalPages", "total_pages"]))
        .unwrap_or_else(|| detect_total_pages(html, channel))
}

fn parse_router_data(html: &str) -> Option<Value> {
    let document = Html::parse_document(html);
    for selector_text in [
        "script#__MODERN_ROUTER_DATA__",
        "script[data-script-src=\"modern-inline\"]",
    ] {
        let Ok(selector) = Selector::parse(selector_text) else {
            continue;
        };
        let Some(script) = document.select(&selector).next() else {
            continue;
        };
        if let Some(value) = parse_router_script(&script.inner_html()) {
            return Some(value);
        }
    }
    None
}

fn parse_router_script(raw: &str) -> Option<Value> {
    // scraper serializes inline script text as HTML. Decode entities before
    // reading signed media URLs; otherwise `&amp;` becomes part of the query.
    let normalized = raw.trim().replace("&amp;", "&");
    if let Ok(value) = serde_json::from_str::<Value>(&normalized) {
        return Some(value);
    }

    let start = normalized.find('{')?;
    let end = normalized
        .find("function runWindowFn")
        .unwrap_or(normalized.len());
    let candidate = normalized[start..end].trim().trim_end_matches(';').trim();
    serde_json::from_str(candidate).ok()
}

fn find_series<'a>(value: &'a Value, expected_id: &str) -> Option<&'a Map<String, Value>> {
    match value {
        Value::Object(object) => {
            let matches = object
                .get("series_id")
                .and_then(value_as_id)
                .is_some_and(|id| id == expected_id);
            if matches && object.get("vid_list").is_some() {
                return Some(object);
            }
            object
                .values()
                .find_map(|child| find_series(child, expected_id))
        }
        Value::Array(values) => values
            .iter()
            .find_map(|child| find_series(child, expected_id)),
        _ => None,
    }
}

fn find_player_info(value: &Value) -> Option<&Map<String, Value>> {
    match value {
        Value::Object(object) => {
            if let Some(Value::Object(player)) = object.get("video_player_info") {
                return Some(player);
            }
            object.values().find_map(find_player_info)
        }
        Value::Array(values) => values.iter().find_map(find_player_info),
        _ => None,
    }
}

/// 从播放页 JSON 里收集出现的所有 vid。
///
/// 用途只有一个：确认页面携带的播放数据属于请求的那一集。公开播放页只返回
/// 默认集的数据，不做这一步校验就可能把别的集的地址当成目标集交出去。
fn collect_vids(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if key == "vid" {
                    if let Some(text) = child.as_str() {
                        let text = text.trim();
                        if !text.is_empty() && text.chars().all(|c| c.is_ascii_digit()) {
                            out.push(text.to_owned());
                        }
                    }
                }
                collect_vids(child, out);
            }
        }
        Value::Array(items) => {
            for child in items {
                collect_vids(child, out);
            }
        }
        _ => {}
    }
}

fn collect_playback_urls(value: &Value, urls: &mut Vec<String>) {
    match value {
        Value::String(value) if is_playback_url(value) => push_unique(urls, value.to_string()),
        Value::Object(object) => object
            .values()
            .for_each(|child| collect_playback_urls(child, urls)),
        Value::Array(values) => values
            .iter()
            .for_each(|child| collect_playback_urls(child, urls)),
        _ => {}
    }
}

fn is_playback_url(value: &str) -> bool {
    value.starts_with("https://")
        && (value.contains(".m3u8")
            || value.contains(".mp4")
            || value.contains(".mpd")
            || value.contains("video"))
}

fn push_unique(items: &mut Vec<String>, value: String) {
    let value = normalize_playback_url(&value);
    if !items.contains(&value) {
        items.push(value);
    }
}

fn normalize_playback_url(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&#38;", "&")
        .replace("&#x26;", "&")
        .replace("&#X26;", "&")
}

fn select_quality_url(urls: &[String], quality: &str) -> Option<String> {
    if urls.is_empty() {
        return None;
    }
    let quality = quality.trim().to_ascii_lowercase();
    if quality.is_empty() || quality == "auto" {
        return urls.first().cloned();
    }
    let marker = match quality.as_str() {
        "4k" => ["2160", "4k"].as_slice(),
        "1080p" => ["1080"].as_slice(),
        "720p" => ["720"].as_slice(),
        _ => [].as_slice(),
    };
    urls.iter()
        .find(|url| {
            marker
                .iter()
                .any(|part| url.to_ascii_lowercase().contains(part))
        })
        .cloned()
        .or_else(|| match quality.as_str() {
            "4k" => urls.first().cloned(),
            "1080p" => urls.get(1).cloned().or_else(|| urls.first().cloned()),
            "720p" => urls.get(2).cloned().or_else(|| urls.last().cloned()),
            _ => urls.first().cloned(),
        })
}

fn categories_for(items: &[SeriesItem]) -> Vec<String> {
    let mut categories = vec!["全部".into()];
    for tag in items.iter().flat_map(|item| &item.tags) {
        if !tag.is_empty()
            && !tag.chars().all(|character| character.is_ascii_digit())
            && !categories.contains(tag)
        {
            categories.push(tag.clone());
        }
    }
    categories
}

fn matches_filter(item: &SeriesItem, filter: &CatalogFilter) -> bool {
    if filter.category != "全部" && !item.tags.iter().any(|tag| tag == &filter.category) {
        return false;
    }
    if filter.audience != "全部" && !item.tags.iter().any(|tag| tag.contains(&filter.audience)) {
        return false;
    }
    match filter
        .keyword
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(keyword) => {
            item.title.contains(keyword) || item.tags.iter().any(|tag| tag.contains(keyword))
        }
        None => true,
    }
}

fn parse_page(cursor: Option<&str>) -> Option<u32> {
    cursor?
        .trim()
        .parse::<u32>()
        .ok()
        .filter(|value| *value > 0)
}

fn sort_label(sort: &str) -> &'static str {
    match sort {
        "latest" => "公开页当前排序",
        "heat" => "公开热度排序",
        _ => "公开推荐排序",
    }
}

fn validate_numeric_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || !value.chars().all(|character| character.is_ascii_digit()) {
        return Err(format!("{label} ID 无效。"));
    }
    Ok(())
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(value_as_id).collect())
        .unwrap_or_default()
}

fn value_as_id(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| value.as_u64().map(|value| value.to_string()))
}

fn string_field(object: &Map<String, Value>, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
        .to_string()
}

fn number_field(object: &Map<String, Value>, keys: &[&str]) -> Option<u32> {
    keys.iter().find_map(|key| {
        object
            .get(*key)
            .and_then(Value::as_u64)
            .map(|value| value as u32)
    })
}

fn unique(items: Vec<String>) -> Vec<String> {
    let mut result = Vec::new();
    for item in items {
        if !result.contains(&item) {
            result.push(item);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{
        detect_total_pages, find_pagination_value, normalize_playback_url, parse_router_script,
        DramaProvider, Value,
    };
    use crate::models::CatalogFilter;

    #[test]
    fn detects_comic_pagination() {
        let html = r#"
            <a href="/rank/hot-comic-drama?page=2">2</a>
            <a href="/rank/hot-comic-drama?page=5">5</a>
        "#;
        assert_eq!(detect_total_pages(html, "comic"), 5);
    }

    #[test]
    fn decodes_media_url_entities_in_router_data() {
        let data = parse_router_script(
            r#"{"video_player_info":{"main_url":"https://cdn.test/video.mp4?a=1&amp;ch=0"}}"#,
        )
        .expect("router data");
        assert_eq!(
            data["video_player_info"]["main_url"],
            "https://cdn.test/video.mp4?a=1&ch=0"
        );
    }

    #[test]
    fn normalizes_all_common_ampersand_entities() {
        assert_eq!(
            normalize_playback_url(
                "https://cdn.test/video.mp4?a=1&amp;ch=0&#38;x=1&#x26;y=2&#X26;z=3"
            ),
            "https://cdn.test/video.mp4?a=1&ch=0&x=1&y=2&z=3"
        );
    }

    /// 回归：分类分页链接带 slug（/category/real-drama?page=N）。
    ///
    /// 旧正则只认 `/category?page=N`，slug 段让它永远失配，total_pages 退化成 1，
    /// has_more 恒为 false —— 首页无限滚动在首屏之后彻底失效。夹具取自线上真实标记。
    #[test]
    fn detects_category_total_pages_with_slug() {
        let html = r#"
            <a href="/category/real-drama?page=2" class="pc-item-PjMYKE" aria-label="第 2 页">
            <a href="/category/real-drama?page=3" class="pc-item-PjMYKE" aria-label="第 3 页">
            <a href="/category/real-drama?page=34" class="pc-item-PjMYKE" aria-label="第 34 页">
        "#;
        assert_eq!(detect_total_pages(html, "drama"), 34);
    }

    /// 无 slug 形态也必须继续可用（`/category?page=2`）。
    #[test]
    fn detects_category_total_pages_without_slug() {
        let html = r#"<a href="/category?page=2">2</a><a href="https://hongguoduanju.com/category?page=7">7</a>"#;
        assert_eq!(detect_total_pages(html, "drama"), 7);
    }

    /// 回归：分页元数据挂在 `category_$` 这类随路由命名的键下，而不是 `category_page`。
    #[test]
    fn finds_pagination_under_route_named_key() {
        let data: Value = serde_json::from_str(
            r#"{"loaderData":{"category_layout":null,"category_$":{
                "query":{"page":1},
                "pagination":{"total":800,"pageSize":24,"totalPages":34}}}}"#,
        )
        .expect("router data");
        assert_eq!(
            find_pagination_value(&data, &["totalPages", "total_pages"]),
            Some(34)
        );
        assert_eq!(find_pagination_value(&data, &["total"]), Some(800));
    }

    /// 联网端到端验证：目录第一页必须报告 has_more，且第二页必须是新内容。
    ///
    /// 默认忽略（避免离线环境跑测试失败），需要时手动执行：
    ///   cargo test --bins -- --ignored --nocapture catalog_pagination_live
    #[tokio::test]
    #[ignore = "需要联网，手动运行"]
    async fn catalog_pagination_live() {
        let provider = DramaProvider::new().expect("provider");
        for channel in ["drama", "comic"] {
            let filter = |page: u32| CatalogFilter {
                channel: channel.to_string(),
                category: "全部".into(),
                audience: "全部".into(),
                sort: "recommend".into(),
                keyword: None,
                page,
                page_size: 30,
                cursor: None,
            };
            let first = provider.catalog(&filter(1)).await.expect("first page");
            println!(
                "[{channel}] page1 items={} has_more={} total={}",
                first.items.len(),
                first.has_more,
                first.total
            );
            assert!(!first.items.is_empty(), "{channel} 第一页为空");
            assert!(first.has_more, "{channel} 第一页必须报告还有更多内容");

            let second = provider.catalog(&filter(2)).await.expect("second page");
            let first_ids: std::collections::HashSet<&str> =
                first.items.iter().map(|item| item.id.as_str()).collect();
            let overlap = second
                .items
                .iter()
                .filter(|item| first_ids.contains(item.id.as_str()))
                .count();
            println!(
                "[{channel}] page2 items={} has_more={} 与第一页重叠={overlap}",
                second.items.len(),
                second.has_more
            );
            assert!(!second.items.is_empty(), "{channel} 第二页为空");
            assert_eq!(overlap, 0, "{channel} 第二页与第一页重叠，翻页无进展");
        }
    }

    /// 没有任何分页元数据时必须返回 None，由调用方退回扫描分页链接。
    #[test]
    fn pagination_lookup_returns_none_when_absent() {
        let data: Value =
            serde_json::from_str(r#"{"loaderData":{"rank_hot-comic-drama":{"items":[]}}}"#)
                .expect("router data");
        assert_eq!(find_pagination_value(&data, &["totalPages"]), None);
    }
}
