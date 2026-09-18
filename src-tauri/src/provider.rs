use crate::models::{
    CatalogFilter, CatalogPage, EpisodeItem, PlaybackSession, SeriesDetail, SeriesItem,
    VideoQualityOption,
};
use regex::Regex;
use reqwest::Client;
use scraper::{Html, Selector};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const HONGGUO_BASE: &str = "https://hongguoduanju.com";
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

/// 全站卡片索引：把公开目录逐页抓全、按 id 去重后缓存。
///
/// 为什么必须要有它：站点**没有题材级路由**（分类 slug 只有频道级的
/// `real-drama` / `comic-drama` / `ai-drama` / `comic`），页面里也不存在任何
/// `?theme=` 之类的筛选参数——题材只是卡片上的文本标签。旧实现是"抓一页，再在
/// 这一页的 24 条里过滤题材"，于是点任一题材都只剩那 24 条里匹配的几张卡
/// （实测冷门题材整页只有 0-2 张），用户看到的就是"一个个别"。
///
/// 实测全站 34 页 × 24 = 816 部，并发抓完约 3.4s（每页约 280KB），之后按题材
/// 过滤与分页都是纯内存操作。索引带 TTL，过期后下次过滤时重建。
struct CatalogIndex {
    items: Vec<SeriesItem>,
    built_at: Instant,
}

const INDEX_TTL: Duration = Duration::from_secs(30 * 60);
/// 并发抓页上限：每页约 280KB，开太多会挤占同一连接池（保活只有 4 条）。
const INDEX_FETCH_CONCURRENCY: usize = 6;
/// 目录翻页上限：站点实测 34 页，给足余量但别无限翻。
const INDEX_MAX_PAGES: u32 = 60;

static CATALOG_INDEX: OnceLock<Mutex<HashMap<String, CatalogIndex>>> = OnceLock::new();

fn index_cache() -> &'static Mutex<HashMap<String, CatalogIndex>> {
    CATALOG_INDEX.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_catalog_index(channel: &str) -> Option<Vec<SeriesItem>> {
    let guard = index_cache().lock().ok()?;
    let entry = guard.get(channel)?;
    if entry.built_at.elapsed() > INDEX_TTL {
        return None;
    }
    Some(entry.items.clone())
}

fn store_catalog_index(channel: &str, items: &[SeriesItem]) {
    if let Ok(mut guard) = index_cache().lock() {
        guard.insert(
            channel.to_owned(),
            CatalogIndex {
                items: items.to_vec(),
                built_at: Instant::now(),
            },
        );
    }
}

/// 目录分页路径（与站点实际路由一致）。
///
/// 漫剧此前用 `/rank/hot-comic-drama`（热播榜），那个源**只有 5 页 / 约 100 部**：
/// 按题材过滤后经常只剩 1-10 条，前端表现为"点了题材只有一张、也不再继续加载"。
/// `/category/comic-drama` 是同一频道的完整目录（实测 34 页 × 24 部，卡片结构、
/// 封面格式、集数文案都与真人剧一致），因此改用它。
fn catalog_page_path(channel: &str, page: u32) -> String {
    let page = page.max(1);
    let Some(segment) = site_channel_segment(channel) else {
        return if page <= 1 {
            "/category".to_string()
        } else {
            format!("/category?page={page}")
        };
    };
    if page <= 1 {
        format!("/category/{segment}")
    } else {
        format!("/category/{segment}?page={page}")
    }
}

fn has_active_filter(filter: &CatalogFilter) -> bool {
    filter.category != "全部" || filter.audience != "全部"
}

/// 把全站索引按筛选条件过滤后切页（题材筛选走这条路）。
fn paginate_filtered(
    items: Vec<SeriesItem>,
    filter: &CatalogFilter,
    requested_page: u32,
) -> CatalogPage {
    // 词表取过滤前的全集：点题材不该让题材栏跟着缩水。
    let categories = categories_for(&items);
    let page_size = filter.page_size.clamp(1, 60) as usize;
    let filtered = items
        .into_iter()
        .filter(|item| matches_filter(item, filter))
        .collect::<Vec<_>>();
    let total = filtered.len();
    let start = ((requested_page.saturating_sub(1)) as usize * page_size).min(total);
    let page_items = filtered[start..]
        .iter()
        .take(page_size)
        .cloned()
        .collect::<Vec<_>>();
    let has_more = start + page_items.len() < total;
    CatalogPage {
        total,
        items: page_items,
        has_more,
        page: requested_page,
        categories,
        next_cursor: has_more.then(|| (requested_page + 1).to_string()),
        source: format!(
            "红果公开目录 · 题材「{}」全站筛选 · 共 {total} 部",
            filter.category
        ),
    }
}

/// 站点频道段：官方题材子路由挂在 `<频道段>/<题材 slug>` 下。
///
/// 实测真人剧（real-drama，24 个题材）与漫剧（comic-drama，8 个题材）都提供，
/// 且题材页服务端分页、结果完整——这是"点题材只剩几张卡"的正解。
fn site_channel_segment(channel: &str) -> Option<&'static str> {
    match channel {
        "drama" => Some("real-drama"),
        "comic" => Some("comic-drama"),
        _ => None,
    }
}

/// 官方题材路由表：频道 → [(题材名, slug)]。
type ThemeRoutes = Vec<(String, String)>;

static THEME_ROUTES: OnceLock<Mutex<HashMap<String, ThemeRoutes>>> = OnceLock::new();

fn theme_route_cache() -> &'static Mutex<HashMap<String, ThemeRoutes>> {
    THEME_ROUTES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_theme_routes(channel: &str) -> Option<ThemeRoutes> {
    let guard = theme_route_cache().lock().ok()?;
    guard.get(channel).cloned()
}

fn store_theme_routes(channel: &str, routes: &[(String, String)]) {
    if let Ok(mut guard) = theme_route_cache().lock() {
        guard.insert(channel.to_owned(), routes.to_vec());
    }
}

/// 从 `/category` 的导航里解析某频道的**官方题材**（名称 → slug，保序去重）。
///
/// 实测真人剧有 24 个官方题材（爱情/都市/古装/玄幻…），且官方题材就是卡片上的
/// 第一个标签——所以用官方题材做筛选既能走服务端路由，也与卡片展示一致。
fn parse_theme_routes(html: &str, channel: &str) -> Vec<(String, String)> {
    let Some(segment) = site_channel_segment(channel) else {
        return Vec::new();
    };
    let Ok(pattern) = Regex::new(&format!(
        r#"href=["']/category/{segment}/([A-Za-z0-9_\-]+)[^"']*["'][^>]*>([^<]{{1,16}})<"#
    )) else {
        return Vec::new();
    };
    let mut routes: Vec<(String, String)> = Vec::new();
    for captures in pattern.captures_iter(html) {
        let slug = captures
            .get(1)
            .map(|value| value.as_str())
            .unwrap_or_default();
        let name = captures
            .get(2)
            .map(|value| value.as_str())
            .unwrap_or_default()
            .trim();
        if slug.is_empty() || name.is_empty() || name == "全部" {
            continue;
        }
        if !routes.iter().any(|(existing, _)| existing == name) {
            routes.push((name.to_owned(), slug.to_owned()));
        }
    }
    routes
}

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
        // ① 官方题材路由优先：真人剧 24 个、漫剧 8 个题材都有子路由
        //    （/category/real-drama/romance、/category/comic-drama/fantasy 等），
        //    服务端分页、结果完整，不必扫描全站——这是"点题材只剩几张卡"的正解。
        if filter.category != "全部" {
            if let Ok(routes) = self.theme_routes(filter.channel.as_str()).await {
                if let Some((_, slug)) = routes.iter().find(|(name, _)| name == &filter.category) {
                    return self.catalog_theme(filter, slug, requested_page).await;
                }
            }
        }
        // ② 走到这里说明筛选条件里没有命中官方题材（频道题材之外的标签，或只按受众筛）。
        //    这种只能靠全站索引过滤：只抓一页再在这一页里过滤，只会剩那 24 条中匹配的
        //    几张卡（实测冷门题材整页 0-2 张）——用户看到的就是"一个个别"。
        //    刻意不再按频道是否有子路由分流：漫剧官方题材只有 8 个，用户手上的其余
        //    标签同样需要索引兜底，否则又会退回"单页后置过滤"。
        if has_active_filter(filter) {
            let items = self.catalog_index(filter.channel.as_str()).await?;
            return Ok(paginate_filtered(items, filter, requested_page));
        }
        let path = catalog_page_path(filter.channel.as_str(), requested_page);
        let html = self.fetch_page(&path).await?;
        let router_data = parse_router_data(&html);
        let raw_items = parse_catalog_cards(&html, filter.channel.as_str());
        // 题材词表优先用全站索引：一页只有 24 条，词表会随翻页/筛选变来变去；
        // 索引就绪后给出的是全站题材的稳定全集。
        let categories = match cached_catalog_index(filter.channel.as_str()) {
            Some(indexed) if !indexed.is_empty() => categories_for(&indexed),
            _ => categories_for(&raw_items),
        };
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

    /// 取该频道的官方题材路由（缓存；没有题材子路由的频道返回空表）。
    pub async fn theme_routes(&self, channel: &str) -> Result<Vec<(String, String)>, String> {
        if let Some(routes) = cached_theme_routes(channel) {
            return Ok(routes);
        }
        if site_channel_segment(channel).is_none() {
            // 明确记住"该频道没有题材路由"，避免每次筛选都重新抓 /category。
            store_theme_routes(channel, &[]);
            return Ok(Vec::new());
        }
        // 题材导航挂在**频道自己的页面**上：漫剧的 8 个题材只在 /category/comic-drama
        // 上出现，总目录 /category 只有真人剧的。取错页会让漫剧拿不到官方题材，
        // 白白退回到"扫全站索引"那条慢路。
        let html = self.fetch_page(&catalog_page_path(channel, 1)).await?;
        let mut routes = parse_theme_routes(&html, channel);
        if routes.is_empty() {
            // 兼容：若站点某天把导航收回总目录页，仍能解析出来。
            if let Ok(fallback) = self.fetch_page("/category").await {
                routes = parse_theme_routes(&fallback, channel);
            }
        }
        store_theme_routes(channel, &routes);
        Ok(routes)
    }

    /// 官方题材浏览：`/category/{segment}/{slug}?page=N`（服务端分页，结果完整）。
    async fn catalog_theme(
        &self,
        filter: &CatalogFilter,
        slug: &str,
        requested_page: u32,
    ) -> Result<CatalogPage, String> {
        let Some(segment) = site_channel_segment(filter.channel.as_str()) else {
            return Err("该频道没有官方题材路由。".to_string());
        };
        let path = if requested_page <= 1 {
            format!("/category/{segment}/{slug}")
        } else {
            format!("/category/{segment}/{slug}?page={requested_page}")
        };
        let html = self.fetch_page(&path).await?;
        let router_data = parse_router_data(&html);
        let mut items = parse_catalog_cards(&html, filter.channel.as_str());
        items.truncate(filter.page_size.clamp(1, 60) as usize);
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
        let categories = self
            .catalog_categories(filter.channel.as_str())
            .await
            .unwrap_or_default();
        Ok(CatalogPage {
            total,
            items,
            has_more,
            page: requested_page,
            categories,
            next_cursor: has_more.then(|| (requested_page + 1).to_string()),
            source: format!(
                "红果公开目录 · 题材「{}」· {}",
                filter.category,
                sort_label(&filter.sort)
            ),
        })
    }

    /// 取全站卡片索引（带 TTL 缓存）。题材/受众过滤必须走它。
    ///
    /// 首页用来拿总页数，其余页并发抓取后按 id 去重合并。实测 34 页约 3.4s；
    /// 索引缓存在进程内，TTL 内重复调用是纯内存操作。
    pub async fn catalog_index(&self, channel: &str) -> Result<Vec<SeriesItem>, String> {
        if let Some(items) = cached_catalog_index(channel) {
            return Ok(items);
        }
        let first = self.fetch_page(&catalog_page_path(channel, 1)).await?;
        let total_pages = router_data_total_pages(&first, channel).clamp(1, INDEX_MAX_PAGES);
        let mut items = parse_catalog_cards(&first, channel);
        let mut seen: HashSet<String> = items.iter().map(|item| item.id.clone()).collect();

        let mut next_page = 2u32;
        while next_page <= total_pages {
            let mut join = tokio::task::JoinSet::new();
            let mut scheduled = 0usize;
            while scheduled < INDEX_FETCH_CONCURRENCY && next_page <= total_pages {
                let client = self.client.clone();
                let path = catalog_page_path(channel, next_page);
                join.spawn(async move { fetch_page_with_client(client, path).await });
                next_page += 1;
                scheduled += 1;
            }
            if scheduled == 0 {
                break;
            }
            // 单页失败不整体失败：索引少一两页仍能提供完整的题材过滤，
            // 比因为一次抖动就让用户点不了题材要好。
            while let Some(joined) = join.join_next().await {
                let Ok(Ok(html)) = joined else {
                    continue;
                };
                for item in parse_catalog_cards(&html, channel) {
                    if seen.insert(item.id.clone()) {
                        items.push(item);
                    }
                }
            }
        }
        store_catalog_index(channel, &items);
        Ok(items)
    }

    /// 题材词表（供前端题材栏使用）。
    ///
    /// 有官方题材路由的频道直接给出官方 24 个题材：稳定、完整，且点击时走服务端
    /// 路由过滤，不需要扫描全站。没有路由的频道（漫剧）才退回"汇总目录卡片标签"，
    /// 那条路要建索引（约数秒），所以前端只应在首屏之后后台调用。
    pub async fn catalog_categories(&self, channel: &str) -> Result<Vec<String>, String> {
        let routes = self.theme_routes(channel).await.unwrap_or_default();
        if !routes.is_empty() {
            let mut names = Vec::with_capacity(routes.len() + 1);
            names.push("全部".to_string());
            names.extend(routes.into_iter().map(|(name, _)| name));
            return Ok(names);
        }
        let items = self.catalog_index(channel).await?;
        if items.is_empty() {
            return Err("目录索引为空，未能汇总题材。".to_string());
        }
        Ok(categories_for(&items))
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
        // 按与关键词的相关度重排，再交给站点顺序兜底。
        //
        // 站点搜索是模糊匹配：实测搜"战神"返回的第一条是"我只想找死，却被奉为
        // 九州战神了"，而"特级战龙""大将军扛楼养活百万大军"这类标题完全不含
        // 关键词的联想条目也混在里面。用户看到的就是"搜出来的第一张卡片不是
        // 我要的那部"，点进详情自然像"下载了错误的剧"。
        // 精确子串（含完整关键词）排最前，其次按命中词数，站点原始顺序兜底。
        rank_search_items(&mut items, keyword);
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
        // 站点路由是 /player/{series_id}/{episode_id}：带集号才会返回那一集的播放数据。
        // 不带集号恒为第一集——实测两页的 duration 与 main_url 各不相同。此前注释称
        // "带集号恒定 404"，实为过期结论：该形态实测 200，且正确指向请求的那一集。
        let html = self
            .fetch_page(&format!("/player/{series_id}/{episode_id}"))
            .await?;
        let data =
            parse_router_data(&html).ok_or_else(|| "播放页未包含可读取的公开数据。".to_string())?;
        let scope = find_player_scope(&data)
            .ok_or_else(|| "该集没有公开网页播放信息，可能仅限官方 App。".to_string())?;
        // 播放数据对象**自身**声明了哪一集就按哪一集核验。拿别的集的地址去播比播不出来
        // 更糟：用户会看到完全不相干的内容（参考实现果果剧库 provider_hongguo.go 亦然）。
        let declared_vid = scope
            .get("vid")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if declared_vid.is_empty() {
            // 对象未声明 vid 时退回弱校验：该 vid 至少要在页面里出现过。
            let mut page_vids = Vec::new();
            collect_vids(&data, &mut page_vids);
            if !page_vids.iter().any(|candidate| candidate == episode_id) {
                return Err("该集没有公开网页直链（公开页仅提供默认集）。".into());
            }
        } else if declared_vid != episode_id {
            return Err("该集没有公开网页直链（公开页返回了别的分集）。".into());
        }
        let declared_series = scope
            .get("series_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if !declared_series.is_empty() && declared_series != series_id {
            return Err("播放页返回了其他剧集的播放信息。".into());
        }
        let player = scope
            .get("video_player_info")
            .and_then(Value::as_object)
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

/// 按与关键词的相关度给搜索结果重排（稳定排序，同分保持站点原始顺序）。
///
/// 分级：标题含完整关键词（不区分大小写）> 标题含关键词逐字命中 > 其余。
/// 排序只影响展示顺序，不丢弃任何条目——联想补齐仍然可用。
fn rank_search_items(items: &mut [SeriesItem], keyword: &str) {
    let keyword_lower = keyword.to_lowercase();
    let chars: Vec<char> = keyword_lower.chars().collect();
    items.sort_by_key(|item| {
        let title_lower = item.title.to_lowercase();
        // 0 = 精确子串；其余按"未命中字数"升序（命中越多未命中越少，排越前），
        // 站点原始顺序由 sort_by_key 的稳定性兜底。
        if title_lower.contains(&keyword_lower) {
            return 0usize;
        }
        let misses = chars
            .iter()
            .filter(|ch| !title_lower.contains(**ch))
            .count();
        misses + 1
    });
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
                "红果漫剧公开目录".into()
            } else {
                "红果短剧公开目录".into()
            },
            brief: None,
        });
    }
    cards
}

fn detect_total_pages(html: &str, channel: &str) -> u32 {
    // 站点把分页链接写成带 slug 的形式，且官方题材页再多一层：
    //   /category/real-drama?page=2        （频道）
    //   /category/real-drama/romance?page=2（官方题材）
    // 旧正则只匹配 `/category?page=N`，被多出来的 slug 段挡住而永远失配，
    // 于是 total_pages 恒为 1、has_more 恒为 false —— 这正是"首页无限流消失"的根因。
    // 这里放宽到最多两层 slug，三种形态都能命中。
    // 漫画频道现在也走 `/category/comic-drama`，与真人剧同一形态；rank 形态仍保留
    // 匹配，避免站点某个入口回退到榜单页时页码失配。
    let route_pattern = if channel == "comic" {
        r#"href=["'](?:https?://[^"']*)?/(?:rank/hot-comic-drama|category(?:/[A-Za-z0-9_\-]+){0,2})\?page=(\d+)"#
    } else {
        r#"href=["'](?:https?://[^"']*)?/category(?:/[A-Za-z0-9_\-]+){0,2}\?page=(\d+)"#
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

/// 找到承载播放数据的对象：既含 `video_player_info`，同层还带 `vid` / `series_id`。
///
/// 实测结构（`/player/{series_id}/{episode_id}` 页）：
/// `{ …, "isSuccess":true, "series_id":"…", "vid":"…", "video_player_info":{ duration, main_url, … } }`
/// ——`vid` 与 `series_id` 是 `video_player_info` 的**同层兄弟**，并不在它内部。
/// 参考实现（果果剧库 provider_hongguo.go）同样是在这个外层对象上比对 vid/series_id。
fn find_player_scope(value: &Value) -> Option<&Map<String, Value>> {
    match value {
        Value::Object(object) => {
            if object.contains_key("video_player_info") {
                return Some(object);
            }
            object.values().find_map(find_player_scope)
        }
        Value::Array(values) => values.iter().find_map(find_player_scope),
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
        catalog_page_path, detect_total_pages, find_pagination_value, normalize_playback_url,
        parse_router_script, parse_theme_routes, rank_search_items, DramaProvider, Value,
    };
    use crate::models::{CatalogFilter, SeriesItem};

    /// 搜索结果按关键词相关度重排：含完整关键词的排最前，
    /// 标题完全不含关键词的联想条目排最后（"搜出来的第一张不是我要的"）。
    #[test]
    fn ranks_search_items_by_keyword_relevance() {
        let make = |id: &str, title: &str| SeriesItem {
            id: id.into(),
            title: title.into(),
            cover: String::new(),
            item_type: "drama".into(),
            episodes_count: 0,
            latest_episode_title: None,
            tags: vec![],
            origin: String::new(),
            brief: None,
        };
        let mut items = vec![
            make("1", "大将军扛楼养活百万大军"),
            make("2", "特级战龙"),
            make("3", "我只想找死，却被奉为九州战神了"),
        ];
        rank_search_items(&mut items, "战神");
        assert_eq!(items[0].title, "我只想找死，却被奉为九州战神了");
        assert_eq!(items[2].title, "大将军扛楼养活百万大军");
    }

    /// 漫剧现在走完整目录 `/category/comic-drama`，不再是只有 5 页的热播榜。
    /// 这条锁住数据源：排行榜那个源按题材过滤后经常只剩 1-10 条（"只有一个、
    /// 也不继续加载"的根因），换回去会立刻复发。
    #[test]
    fn comic_catalog_uses_full_category_route() {
        assert_eq!(catalog_page_path("comic", 1), "/category/comic-drama");
        assert_eq!(
            catalog_page_path("comic", 2),
            "/category/comic-drama?page=2"
        );
        assert_eq!(catalog_page_path("drama", 1), "/category/real-drama");
        assert_eq!(catalog_page_path("drama", 7), "/category/real-drama?page=7");
        // 漫剧完整目录同样带两层 slug 的官方题材页。
        let html = r#"
            <a href="/category/comic-drama?page=2">2</a>
            <a href="/category/comic-drama/fantasy?page=34">34</a>
        "#;
        assert_eq!(detect_total_pages(html, "comic"), 34);
    }

    /// 榜单形态的分页链接仍要能识别：数据源虽已换成完整目录，但站点某个入口
    /// 若回退到榜单页，页码也不该失配。
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

    /// 官方题材页比频道页多一层 slug（`/category/real-drama/romance?page=2`）。
    /// 旧正则只允许一层 slug，题材页的 total_pages 会退化成 1、has_more 恒为 false
    /// ——点题材后就再也翻不出第二页。
    #[test]
    fn detects_official_theme_total_pages() {
        let html = r#"
            <a href="/category/real-drama/romance?page=2">2</a>
            <a href="/category/real-drama/romance?page=34">34</a>
        "#;
        assert_eq!(detect_total_pages(html, "drama"), 34);
    }

    /// 从 `/category` 导航解析官方题材（名称 → slug）：跳过频道级链接与"全部"，
    /// 保序去重；没有题材子路由的频道返回空表。
    #[test]
    fn parses_official_theme_routes() {
        let html = r#"
            <a href="/category/real-drama">全部</a>
            <a href="/category/real-drama/romance">爱情</a>
            <a href="/category/real-drama/urban">都市</a>
            <a href="/category/real-drama/romance">爱情</a>
            <a href="/category/comic-drama">漫剧</a>
        "#;
        assert_eq!(
            parse_theme_routes(html, "drama"),
            vec![
                ("爱情".to_string(), "romance".to_string()),
                ("都市".to_string(), "urban".to_string()),
            ]
        );
        // 漫剧/AI 剧没有官方题材子路由。
        assert!(parse_theme_routes(html, "comic").is_empty());
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

    /// 联网端到端验证：官方题材路由必须给出完整、可分页的结果。
    ///
    /// 这是"点题材只剩几张卡"的回归护栏：旧实现只抓一页再在这一页里后置过滤，
    /// 实测冷门题材整页只有 0-2 张。默认忽略（避免离线环境跑失败），需要时手动执行：
    ///   cargo test --bins -- --ignored --nocapture theme_catalog_live
    #[tokio::test]
    #[ignore = "需要联网，手动运行"]
    async fn theme_catalog_live() {
        let provider = DramaProvider::new().expect("provider");
        let routes = provider.theme_routes("drama").await.expect("theme routes");
        println!(
            "官方题材 {} 个: {:?}",
            routes.len(),
            routes
                .iter()
                .map(|(name, _)| name.as_str())
                .collect::<Vec<_>>()
        );
        assert!(routes.len() >= 20, "官方题材数量异常: {}", routes.len());
        // 漫剧也有自己的官方题材（8 个）：这些题材只在 /category/comic-drama 页面上
        // 出现，所以取题材导航必须抓频道自己的页面，而不是总目录 /category。
        let comic_routes = provider.theme_routes("comic").await.expect("comic routes");
        println!(
            "漫剧官方题材 {} 个: {:?}",
            comic_routes.len(),
            comic_routes
                .iter()
                .map(|(name, _)| name.as_str())
                .collect::<Vec<_>>()
        );
        assert!(
            comic_routes.len() >= 5,
            "漫剧官方题材数量异常: {}",
            comic_routes.len()
        );

        let filter = |page: u32| CatalogFilter {
            channel: "drama".to_string(),
            category: "都市".into(),
            audience: "全部".into(),
            sort: "recommend".into(),
            keyword: None,
            page,
            page_size: 30,
            cursor: None,
        };
        let first = provider.catalog(&filter(1)).await.expect("theme page 1");
        println!(
            "题材「都市」第 1 页: {} 条 has_more={} source={:?}",
            first.items.len(),
            first.has_more,
            first.source
        );
        assert!(
            first.items.len() >= 20,
            "题材过滤只剩 {} 条——后置过滤的老问题回来了",
            first.items.len()
        );
        assert!(first.has_more, "题材页应当还能翻页");
        // 官方题材就是卡片的第一个标签：每条都必须带它，不能混入别的题材。
        assert!(
            first
                .items
                .iter()
                .all(|item| item.tags.iter().any(|tag| tag == "都市")),
            "题材页混入了非该题材的卡片"
        );
        // 题材词表应是稳定的官方全集，而不是随页漂移的卡片标签。
        assert!(first.categories.contains(&"都市".to_string()));
        assert!(
            first.categories.len() >= 20,
            "题材词表不完整: {}",
            first.categories.len()
        );

        let second = provider.catalog(&filter(2)).await.expect("theme page 2");
        let overlap = second
            .items
            .iter()
            .filter(|item| first.items.iter().any(|prev| prev.id == item.id))
            .count();
        println!(
            "题材「都市」第 2 页: {} 条 与第 1 页重叠={overlap}",
            second.items.len()
        );
        assert!(!second.items.is_empty(), "题材第 2 页为空");
        assert_eq!(overlap, 0, "题材翻页无进展");
        // 漫剧：官方题材路由（8 个）+ 完整目录，正是"点题材只有一个、也不再继续
        // 加载"的修复点。漫剧是应用默认落地频道，这条路径必须出满页。
        // 官方题材本身已在上文断言过，这里只验证"题材栏 + 题材页"是否完整。
        let _ = &comic_routes;
        let comic_categories = provider
            .catalog_categories("comic")
            .await
            .expect("comic categories");
        println!(
            "漫剧题材栏 {} 项，前 8 个: {:?}",
            comic_categories.len(),
            comic_categories.iter().take(8).collect::<Vec<_>>()
        );
        // 直接验证第一个官方题材：题材页必须出满一页且还能继续加载。
        // （修复前的症状：只抓一页再后置过滤 → 常常只剩 1-10 条、has_more=false，
        //   用户看到的就是"点题材只有一个、也不再继续加载"。）
        for theme in comic_categories.iter().skip(1).take(1) {
            let comic_filter = CatalogFilter {
                channel: "comic".to_string(),
                category: theme.clone(),
                audience: "全部".into(),
                sort: "recommend".into(),
                keyword: None,
                page: 1,
                page_size: 30,
                cursor: None,
            };
            let comic_page = provider
                .catalog(&comic_filter)
                .await
                .expect("comic theme page");
            println!("漫剧题材「{theme}」: {} 条", comic_page.items.len());
            // 关键回归：题材页必须出满一页且还能继续加载。
            // 全量记录前修复前的症状：只抓一页再后置过滤 → 常常 1-10 条、has_more=false。
            assert!(
                comic_page.items.len() >= 20,
                "漫剧题材「{theme}」只剩 {} 条——题材过滤没有走完整目录",
                comic_page.items.len()
            );
            assert!(comic_page.has_more, "漫剧题材「{theme}」应当还能继续加载");
            assert!(
                comic_page
                    .items
                    .iter()
                    .all(|item| item.tags.iter().any(|tag| tag == theme)),
                "漫剧题材页混入了非该题材的卡片"
            );
            let comic_second = provider
                .catalog(&CatalogFilter {
                    channel: "comic".to_string(),
                    category: theme.clone(),
                    audience: "全部".into(),
                    sort: "recommend".into(),
                    keyword: None,
                    page: 2,
                    page_size: 30,
                    cursor: None,
                })
                .await
                .expect("comic theme page 2");
            let overlap = comic_second
                .items
                .iter()
                .filter(|item| comic_page.items.iter().any(|prev| prev.id == item.id))
                .count();
            println!(
                "漫剧题材「{theme}」第 2 页: {} 条 与第 1 页重叠={overlap}",
                comic_second.items.len()
            );
            assert!(!comic_second.items.is_empty(), "漫剧题材第 2 页为空");
            assert_eq!(overlap, 0, "漫剧题材翻页无进展");
        }
        assert!(
            comic_categories.len() > 1,
            "漫剧题材栏除「全部」外应当还有官方题材"
        );
    }

    #[tokio::test]
    #[ignore = "临时诊断：需要联网"]
    async fn debug_comic_cards_live() {
        let provider = DramaProvider::new().expect("provider");
        let page = provider
            .catalog(&CatalogFilter {
                channel: "comic".into(),
                category: "全部".into(),
                audience: "全部".into(),
                sort: "recommend".into(),
                keyword: None,
                page: 1,
                page_size: 30,
                cursor: None,
            })
            .await
            .expect("comic page");
        for item in page.items.iter().take(4) {
            println!(
                "title={} | eps={} | cover={} | tags={:?}",
                item.title, item.episodes_count, item.cover, item.tags
            );
        }
        let empty = page
            .items
            .iter()
            .filter(|item| item.cover.is_empty())
            .count();
        println!(
            "TOTAL items={} empty_covers={} total_field={}",
            page.items.len(),
            empty,
            page.total
        );
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
