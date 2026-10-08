use crate::models::{
    CatalogFilter, CatalogPage, EpisodeItem, PlaybackSession, SeriesDetail, SeriesItem,
    VideoQualityOption,
};
use regex::Regex;
use reqwest::Client;
use scraper::{Html, Selector};
use serde_json::{Map, Value};
use std::cmp::Ordering;
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
    /// 建索引时有整页抓取失败（"单页失败不整体失败"那条容忍策略留下的欠账）。
    /// 缓存里必须把这个事实一起存下来：命中缓存的题材筛选同样要能报降级，
    /// 否则只有冷启动那一次会亮、之后 TTL 内全被当成完整结果。
    degraded: bool,
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

fn cached_catalog_index(channel: &str) -> Option<(Vec<SeriesItem>, bool)> {
    let guard = index_cache().lock().ok()?;
    let entry = guard.get(channel)?;
    if entry.built_at.elapsed() > INDEX_TTL {
        return None;
    }
    Some((entry.items.clone(), entry.degraded))
}

fn store_catalog_index(channel: &str, items: &[SeriesItem], degraded: bool) {
    if let Ok(mut guard) = index_cache().lock() {
        guard.insert(
            channel.to_owned(),
            CatalogIndex {
                items: items.to_vec(),
                built_at: Instant::now(),
                degraded,
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
///
/// `index_degraded`：建索引时有整页抓取失败，索引是**残缺**的，因此这一页也是
/// 降级结果（少的是可筛出来的条目数与 total，不是我眼前的 24 张卡）。
fn paginate_filtered(
    items: Vec<SeriesItem>,
    filter: &CatalogFilter,
    requested_page: u32,
    index_degraded: bool,
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
        degraded: index_degraded,
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

/// 官方题材页结果缓存（短 TTL）。
///
/// "点几个题材比较一下"是发现页最高频的操作，而每次点击都要重新抓一页
/// （约 280KB）并重新解析——来回点 A→B→A 就是三次完整往返。这里把解析后的
/// 整页结果缓存住，重复点击变成纯内存操作。
///
/// TTL 刻意只有 60s：题材页是实时排行，久缓存会让新上的剧进不来；而 60s
/// 足够覆盖"来回比较几个题材"这一段典型操作。
const THEME_PAGE_TTL: Duration = Duration::from_secs(60);

static THEME_PAGE_CACHE: OnceLock<Mutex<HashMap<String, ThemePageEntry>>> = OnceLock::new();

struct ThemePageEntry {
    page: CatalogPage,
    stored_at: Instant,
}

fn theme_page_cache() -> &'static Mutex<HashMap<String, ThemePageEntry>> {
    THEME_PAGE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_theme_page(key: &str) -> Option<CatalogPage> {
    let guard = theme_page_cache().lock().ok()?;
    let entry = guard.get(key)?;
    if entry.stored_at.elapsed() > THEME_PAGE_TTL {
        return None;
    }
    Some(entry.page.clone())
}

fn store_theme_page(key: &str, page: &CatalogPage) {
    if let Ok(mut guard) = theme_page_cache().lock() {
        // 只有两个频道的题材 × 页数，条目很少；顺带清掉过期的，避免长期驻留。
        guard.retain(|_, entry| entry.stored_at.elapsed() <= THEME_PAGE_TTL);
        guard.insert(
            key.to_owned(),
            ThemePageEntry {
                page: page.clone(),
                stored_at: Instant::now(),
            },
        );
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

/// 构造目录/详情用的 HTTP 客户端。
///
/// `use_proxy` 决定是否挂 Windows 系统代理。两条分支的其余参数必须完全一致 ——
/// 兜底路径不该是一台"另一台机器"，否则请求超时行为都会不一样。
fn build_client(use_proxy: bool) -> Result<Client, String> {
    let mut builder = Client::builder();
    if use_proxy {
        // reqwest 不读 Windows 的「Internet 设置」，见 `update::system_proxy`。
        builder = crate::update::with_system_proxy(builder);
    } else {
        // **必须显式 `no_proxy()`**：这条分支是"直连兜底"，而 reqwest 默认还会去读
        // `HTTP_PROXY` / `HTTPS_PROXY` 环境变量。不写这一句，所谓直连其实还是走代理，
        // 兜了个寂寞。
        builder = builder.no_proxy();
    }
    builder
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        )
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        // 连接池保活：目录/详情每次翻页与换剧都是同一主机的新请求，
        // 默认池空闲 90s 就关连接，再次请求要重新 TLS 握手（1-2 RTT）。
        // 拉长空闲窗口让翻页/换剧复用已建立的连接，首字节快一截。
        .pool_idle_timeout(Duration::from_secs(600))
        .pool_max_idle_per_host(4)
        .tcp_nodelay(true)
        .build()
        .map_err(|error| error.to_string())
}

/// 直连兜底客户端（进程内单例、惰性创建）。
///
/// 只在**确实挂着系统代理**时才需要它：没挂代理的机器上这条路径永远走不到，
/// 白白多一个连接池。绝大多数请求也用不到它，所以等到真失败那一刻再建。
fn fallback_direct_client() -> Option<&'static Client> {
    static DIRECT_CLIENT: OnceLock<Option<Client>> = OnceLock::new();
    DIRECT_CLIENT
        .get_or_init(|| {
            if !crate::update::has_system_proxy() {
                return None;
            }
            match build_client(false) {
                Ok(client) => Some(client),
                Err(error) => {
                    eprintln!("[ttv] 直连兜底客户端创建失败：{error}");
                    None
                }
            }
        })
        .as_ref()
}

impl DramaProvider {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            client: build_client(true)?,
        })
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
            let (items, index_degraded) = self.catalog_index(filter.channel.as_str()).await?;
            return Ok(paginate_filtered(
                items,
                filter,
                requested_page,
                index_degraded,
            ));
        }
        let path = catalog_page_path(filter.channel.as_str(), requested_page);
        let html = self.fetch_page(&path).await?;
        let router_data = parse_router_data(&html);
        let raw_items = parse_catalog_cards(&html, filter.channel.as_str());
        // 题材词表优先用全站索引：一页只有 24 条，词表会随翻页/筛选变来变去；
        // 索引就绪后给出的是全站题材的稳定全集。
        let categories = match cached_catalog_index(filter.channel.as_str()) {
            Some((indexed, _)) if !indexed.is_empty() => categories_for(&indexed),
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
            // 这条链路失败即整体 Err：`fetch_page` 用 `?` 直接冒泡，索引也是
            // `?`，拿不到就是拿不到，不存在"少了几页还照样返回"的情况。
            // 唯一的部分成功在上面的题材分支里，已经由 `paginate_filtered` 置位。
            // 多来源合并（红果 + 动漫 + App 联想）的降级在
            // `main.rs::merge_search_sources` 里汇总。
            degraded: false,
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
        let cache_key = format!(
            "{}|{}|{}|{}|{}",
            filter.channel, slug, requested_page, filter.page_size, filter.sort
        );
        if let Some(page) = cached_theme_page(&cache_key) {
            return Ok(page);
        }
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
        // 题材词表是**额外**抓一次频道页拿的，拿不到时题材栏会是空的——内容仍
        // 完整可用，所以不整体 Err，但要照实报降级。
        //
        // 不能只看 `categories.is_empty()` 就置位：那是"抓成功了但站点这条频道
        // 恰好没有题材词表"，与"抓挂了"是两回事。
        let (categories, degraded) = match self.catalog_categories(filter.channel.as_str()).await {
            Ok(categories) => (categories, false),
            Err(_) => (Vec::new(), true),
        };
        let page = CatalogPage {
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
            degraded,
        };
        store_theme_page(&cache_key, &page);
        Ok(page)
    }

    /// 取全站卡片索引（带 TTL 缓存）。题材/受众过滤必须走它。
    ///
    /// 返回 `(条目, 是否残缺)`：首页那一页抓失败即整体 `Err`，但**后续页**允许
    /// 跳过（见下面"单页失败不整体失败"）。跳过的页对应"全站少了一页"这种不完整，
    /// 必须原样带出去给 `CatalogPage.degraded`，不能只剩一份看起来很全的结果。
    ///
    /// 首页用来拿总页数，其余页并发抓取后按 id 去重合并。实测 34 页约 3.4s；
    /// 索引缓存在进程内，TTL 内重复调用是纯内存操作。
    pub async fn catalog_index(&self, channel: &str) -> Result<(Vec<SeriesItem>, bool), String> {
        if let Some(cached) = cached_catalog_index(channel) {
            return Ok(cached);
        }
        let first = self.fetch_page(&catalog_page_path(channel, 1)).await?;
        let total_pages = router_data_total_pages(&first, channel).clamp(1, INDEX_MAX_PAGES);
        let mut items = parse_catalog_cards(&first, channel);
        let mut seen: HashSet<String> = items.iter().map(|item| item.id.clone()).collect();

        let mut next_page = 2u32;
        let mut degraded = false;
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
            // 比因为一次抖动就让用户点不了题材要好。但这笔欠账要记在
            // `degraded` 上——少的那一页是真的搜不到。
            while let Some(joined) = join.join_next().await {
                let Ok(Ok(html)) = joined else {
                    degraded = true;
                    continue;
                };
                for item in parse_catalog_cards(&html, channel) {
                    if seen.insert(item.id.clone()) {
                        items.push(item);
                    }
                }
            }
        }
        store_catalog_index(channel, &items, degraded);
        Ok((items, degraded))
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
        let (items, _) = self.catalog_index(channel).await?;
        if items.is_empty() {
            return Err("目录索引为空，未能汇总题材。".to_string());
        }
        Ok(categories_for(&items))
    }

    /// 全站搜索：走站点自己的 `/search/{keyword}` 路由。
    ///
    /// 站点把搜索结果放在 SSR 的 router data 里（loaderData 下键名形如
    /// "search_(keyword)/page"，内含 searchList），因此无需对接内部 XHR 接口，
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
        // 变体之间是**或**的关系：一个变体挂了另一个仍可能出结果，最终照样返回
        // CatalogPage。这时结果是残缺的（少了那个词形能搜到的条目），必须报降级。
        let mut degraded = false;
        for variant in keyword_variants(keyword) {
            let encoded = encode_uri_component(&variant);
            let html = match self.fetch_page(&format!("/search/{encoded}")).await {
                Ok(html) => html,
                Err(error) => {
                    last_error = Some(error);
                    degraded = true;
                    continue;
                }
            };
            let Some(data) = parse_router_data(&html) else {
                // 页面拿到了但读不出结构化数据，同样算这个词形没搜成。
                degraded = true;
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
            // 到这里 items 空但没有 fetch 失败：要么这词真没结果（`degraded`
            // 保持 false，那是事实），要么页面拿到了却读不出结构化数据
            //（此时 `degraded` 已被上面置位，空列表照实报降级而不是假装"无结果"）。
        }
        // 补齐放在排序之前：新补进来的季要跟其它条目一起过一遍相关度与季号排序，
        // 否则它们会挂在结果末尾（用户看着就像"搜索没找到"）。
        //
        // 补查失败**不进** `degraded`：按它自己的约定那是"锦上添花"，回挂了也不
        // 改这次搜索的成功语义、也不加任何错误文案。既然刻意不告诉用户，就不该
        // 转头用 degraded 告诉前端——两个口径必须一致，否则同一件事在两个地方
        // 一个说"没事"一个说"降级"。
        self.complete_search_seasons(&mut items, &mut seen, &filter.channel, keyword)
            .await;
        // 按与关键词的相关度重排，再交给站点顺序兜底。
        //
        // 站点搜索是模糊匹配：实测搜"战神"返回的第一条是"我只想找死，却被奉为
        // 九州战神了"，而"特级战龙""大将军扛楼养活百万大军"这类标题完全不含
        // 关键词的联想条目也混在里面。用户看到的就是"搜出来的第一张卡片不是
        // 我要的那部"，点进详情自然像"下载了错误的剧"。
        // 相关度分五级，另有分季次序的 tie-break，详见 rank_search_items。
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
            degraded,
        })
    }

    /// 分季补齐：搜「聚宝仙盆」只回来第二、三季时，用「剧名第N季」回查缺的
    /// 那一季，把结果并进本次搜索。
    ///
    /// 补查失败一律静默忽略，不改本次搜索的成功/失败语义、不加任何错误文案：
    /// 这只是锦上添花，为了多一季把一次本来能用的搜索变成红字是不划算的。
    /// 上限 `SEARCH_SEASON_MAX_REQUESTS` 次真实请求，理由见那里的注释。
    async fn complete_search_seasons(
        &self,
        items: &mut Vec<SeriesItem>,
        seen: &mut HashSet<String>,
        channel: &str,
        keyword: &str,
    ) {
        for plan in season_fill_plan(items, keyword) {
            let encoded = encode_uri_component(&plan.query);
            let Ok(html) = self.fetch_page(&format!("/search/{encoded}")).await else {
                continue;
            };
            let Some(data) = parse_router_data(&html) else {
                continue;
            };
            for item in parse_search_items(&data, channel) {
                // 只收确实属于这一组的那一季。回查的搜索结果同样会带一串联想条目，
                // 不逐条核对就会把别的剧、甚至别季的条目塞进本次结果里。
                let belongs = match search_season(&item.title) {
                    Some((base, season, unit)) => {
                        season == plan.season
                            && unit == plan.unit
                            && search_text(&base) == plan.base_key
                    }
                    None => false,
                };
                if belongs && seen.insert(item.id.clone()) {
                    items.push(item);
                }
            }
        }
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
            // 短剧/漫剧链路不受动漫的源形态标记影响：保持 None，前端沿用原有分支。
            stream_kind: None,
        })
    }

    async fn fetch_page(&self, path: &str) -> Result<String, String> {
        fetch_page_with_client(self.client.clone(), path.to_string()).await
    }
}

/// 把一次请求失败连同**整条 source 链**展开成一句能排查的话。
///
/// reqwest 的 `Display` 只给最外层那句 `error sending request for url (...)`——
/// 信息量近乎为零：连不上、代理挂了、TLS 证书不对、超时，四种原因长得一模一样。
/// 真正的原因全在 `std::error::Error::source()` 链里
/// （典型是 `proxy connect error` / `tcp connect error` /
/// `invalid peer certificate` / `operation timed out`）。
///
/// 这条链路值得多花二十行：用户上一次截图上只有"1 个源均无响应"，
/// 拿到真实原因后才把范围收死到唯一那一个源。
fn describe_request_error(prefix: &str, error: &reqwest::Error) -> String {
    let mut text = format!("{prefix}：{error}");
    let mut source = std::error::Error::source(error);
    while let Some(inner) = source {
        text.push_str(" ← ");
        text.push_str(&inner.to_string());
        source = inner.source();
    }
    text
}

/// 用指定客户端抓一页。
async fn fetch_page_once(client: &Client, path: &str) -> Result<String, String> {
    let response = client
        .get(format!("{HONGGUO_BASE}{path}"))
        .send()
        .await
        .map_err(|error| describe_request_error("目录请求失败", &error))?;
    if !response.status().is_success() {
        return Err(format!("目录服务返回 HTTP {}。", response.status()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| describe_request_error("读取目录响应失败", &error))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("目录响应超过安全大小限制。".into());
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| "目录响应不是 UTF-8。".into())
}

/// 抓一页；**系统代理不通时自动直连兜底**。
///
/// ## 为什么必须有这条兜底
///
/// `update::with_system_proxy()` 会把注册表里的系统代理**无条件**挂到客户端上
/// （`system_proxy()` 连 `ProxyOverride` 绕过表都没读）。而
/// "Windows 系统代理开着、但那个端口其实已经不通"是极常见的状态——实测本机
/// （2026-10-07）：
///
/// ```text
/// 注册表 ProxyEnable=1 / ProxyServer=127.0.0.1:10808
/// curl -x http://127.0.0.1:10808 https://hongguoduanju.com/category/comic-drama
///   → exit 7（连接被拒）
/// curl --noproxy '*' 同一个 URL
///   → 200 / 317 KB / 1.1 s
/// ```
///
/// 没有兜底时，用户看到的是"浏览器打得开、应用报目录加载失败（1 个源均无响应）"，
/// 而错误里只有一句 `error sending request`，完全指不到代理头上——那一轮排查
/// 就是这么耗掉的。
///
/// ## 边界
///
/// 兜底**只做一次**，且只在本机确实配了系统代理时才有对端（见
/// `fallback_direct_client`），不会把失败请求翻倍打给站方。
async fn fetch_page_with_client(client: Client, path: String) -> Result<String, String> {
    match fetch_page_once(&client, &path).await {
        Ok(body) => Ok(body),
        Err(proxied_error) => {
            let Some(direct) = fallback_direct_client() else {
                return Err(proxied_error);
            };
            match fetch_page_once(direct, &path).await {
                Ok(body) => {
                    eprintln!("[ttv] 系统代理不可用，已直连取回目录：{path}");
                    Ok(body)
                }
                Err(direct_error) => {
                    Err(format!("{proxied_error}；直连兜底同样失败：{direct_error}"))
                }
            }
        }
    }
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

/// 阿拉伯数字 → 中文数字（仅覆盖分季用得到的 1..=200）。
///
/// 上限 200 与 `search_season` 的季号上限一致：`flush_number` 仍只把 ≤99 的数字
/// 转中文（分季数不会更大），而分季补齐拼查询串时要能写出「第一百零八季」。
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
        100..=200 => {
            let prefix = format!("{}百", DIGITS[(value / 100) as usize]);
            match value % 100 {
                0 => prefix,
                // 「一百零八」而不是「一百八」：1x 的剩余位前面要补零。
                1..=9 => format!("{prefix}零{}", DIGITS[(value % 10) as usize]),
                // 「一百一十八」而不是「一百十八」：11..=19 前面得带个「一」。
                10..=19 => match value % 10 {
                    0 => format!("{prefix}一十"),
                    ones => format!("{prefix}一十{}", DIGITS[ones as usize]),
                },
                _ => format!("{prefix}{}", to_chinese_number(value % 100)),
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
            // 实测搜索结果的 `video_data` 上**没有**评分键（详见 parse_rating 的
            // 现状说明），这里照常取值：站点哪天补上就自动亮，不用再改解析。
            rating: parse_rating(video),
        });
    }
    items
}

/// 分季补齐的硬上限：每补一季是一次真实的 HTTP 回查。
///
/// 参考实现那边一次搜索最多回查 32 次（`hongguoSearchSeasonQueries`），因为它是
/// 常驻进程、有单飞去重和 5 分钟结果缓存，回查几乎不花钱；这里的搜索是用户在
/// 搜索框敲完字就干等的主链路，一个来回就是页面转圈。这里先按 2 次封顶，
/// 等 `main.rs` 侧的搜索缓存落地后可以放宽到 4。
const SEARCH_SEASON_MAX_REQUESTS: usize = 2;

/// 季号上限。超过它的后缀当噪声处理：站点不会有这个量级的分季，而超长的数字
/// 多半是"第 1080 集"之类被误认成季号的集数，认下来只会把补齐带偏。
const SEARCH_SEASON_LIMIT: u32 = 200;

/// 搜索比较用的归一化文本：全角转半角 → 去掉所有非字母数字 → 转小写。
///
/// 为什么两侧都要过这道：站点同一句话在不同位置的写法并不一致——实测卡片标题
/// 中间会带 U+3000 全角空格、alt 与标题元素里的空格有无也不一致，用户又会
/// 照着海报敲全角数字。全角/空格不归一，"聚宝仙盆" 与 "聚宝仙盆　第三季" 就
/// 永远比不相等，相关度分级和分季比较会同时失灵。
///
/// 归一后为空（关键词全是标点）时退回"仅 trim + 小写"：否则空串被任何标题
/// `contains` 命中，整页会被判成同级命中、把站点原始顺序全抹平。
fn search_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        // NFKC 里最常用的一小块：全角 ASCII 与全角空格。其余全角形态（全角中文
        // 标点、全角数字）要么被下面的 alphanumeric 滤掉、要么本来就该保留。
        let ch = match ch {
            '\u{3000}' => ' ',
            c if ('\u{FF01}'..='\u{FF5E}').contains(&c) => {
                char::from_u32(c as u32 - 0xFEE0).unwrap_or(c)
            }
            c => c,
        };
        if ch.is_alphanumeric() {
            out.extend(ch.to_lowercase());
        }
    }
    if out.is_empty() {
        return input.trim().to_lowercase();
    }
    out
}

/// 把关键词按非字母数字切成词，供"全分词命中"这一级使用（等价于 Go 侧的
/// `FieldsFunc(IsSpace || IsPunct)`）。
fn query_words(keyword: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    for ch in keyword.chars() {
        if ch.is_alphanumeric() {
            current.push(ch);
        } else if !current.is_empty() {
            words.push(search_text(&current));
            current.clear();
        }
    }
    if !current.is_empty() {
        words.push(search_text(&current));
    }
    words
}

/// 标题对关键词的相关度分级：0 完全相等 / 1 前缀 / 2 包含 / 3 全分词命中 / 4 其余。
///
/// 之前只有两级（"含完整关键词" 0，其余按未命中字数排），实测搜"战神"时
/// "我只想找死，却被奉为九州战神了" 排第一没问题，但"九州战神·风起陇西"这种
/// 真剧目反而落到"其余"里、跟在联想词后面——用户看到的是"搜出来的第一张不是
/// 我要的那部"，点进详情像下错了剧。前缀/包含分家后，正片主标题才稳定压过
/// 蹭热度的联想条目。
fn title_search_rank(title: &str, keyword: &str) -> u8 {
    let words = query_words(keyword);
    let query = search_text(keyword);
    let title = search_text(title);
    if title == query {
        return 0;
    }
    if title.starts_with(&query) {
        return 1;
    }
    if title.contains(&query) {
        return 2;
    }
    // 关键词带空格/标点时（"九州 战神"），整串匹配不上但每个词都在标题里同样算强命中。
    if !words.is_empty() && words.iter().all(|word| title.contains(word)) {
        return 3;
    }
    4
}

/// 按与关键词的相关度给搜索结果重排（稳定排序，同分保持站点原始顺序）。
///
/// 相关度之外再加一条分季次序 tie-break：同系列（base 归一后相同且量词相同）
/// 的按季号升序，「聚宝仙盆第一季」必须排在「聚宝仙盆第三季」前面——用户
/// 搜主标题时期待看到的是完整的一串季，而不是按站点热度东一季西一季。
///
/// 排序只影响展示顺序，不丢弃任何条目——联想补齐、分季补齐仍然可用。
fn rank_search_items(items: &mut [SeriesItem], keyword: &str) {
    items.sort_by(|left, right| {
        title_search_rank(&left.title, keyword)
            .cmp(&title_search_rank(&right.title, keyword))
            .then_with(|| compare_season_order(&left.title, &right.title))
    });
}

/// 同系列按季号升序；不是同系列（或没有季号）返回 Equal，交由 sort_by 的稳定性
/// 退回站点原始顺序。
fn compare_season_order(left: &str, right: &str) -> Ordering {
    let (Some((left_base, left_season, left_unit)), Some((right_base, right_season, right_unit))) =
        (search_season(left), search_season(right))
    else {
        return Ordering::Equal;
    };
    if left_unit != right_unit || search_text(&left_base) != search_text(&right_base) {
        return Ordering::Equal;
    }
    left_season.cmp(&right_season)
}

/// 解析标题尾部的「第N季 / 第N部」，返回 `(base, 季号, 量词)`。
///
/// 只认**尾部**后缀：「第三季」这种本身就叫这个名字的片子没有 base，不构成系列，
/// 认下来只会造出一个 base 为空的组把补齐带偏。base 两端的空白与标点要摘掉
/// （实测有「《聚宝仙盆》第二季」这类写法），base 才等于用户会输入的剧名。
fn search_season(title: &str) -> Option<(String, u32, String)> {
    let chars: Vec<char> = title
        .trim()
        // 尾部允许挂标点（实测有「…第二季·」），先把它们摘掉再从后往前数。
        .trim_end_matches(|c: char| !c.is_alphanumeric())
        .chars()
        .collect();
    let unit = chars.last().copied()?;
    if unit != '季' && unit != '部' {
        return None;
    }
    let mut label_end = chars.len() - 1;
    // 「第 2 季」在实测数据里出现过，数字与量词之间也要容空白。
    while label_end > 0 && chars[label_end - 1].is_whitespace() {
        label_end -= 1;
    }
    let mut start = label_end;
    while start > 0 && is_season_digit(chars[start - 1]) {
        start -= 1;
    }
    if start == label_end {
        return None;
    }
    let mut marker = start;
    while marker > 0 && chars[marker - 1].is_whitespace() {
        marker -= 1;
    }
    if marker == 0 || chars[marker - 1] != '第' {
        return None;
    }
    let number = parse_season_number(&chars[start..label_end])?;
    if !(1..=SEARCH_SEASON_LIMIT).contains(&number) {
        return None;
    }
    // base 两端的标点都摘掉（实测有「《聚宝仙盆》第二季」这类写法）：《》是版式装饰
    // 不属于剧名，留在 base 里会让分季补齐拼出「《聚宝仙盆第四季」」这种查询词。
    let base: String = chars[..marker - 1]
        .iter()
        .collect::<String>()
        .trim_matches(|c: char| !c.is_alphanumeric())
        .to_string();
    if base.is_empty() {
        return None;
    }
    Some((base, number, unit.to_string()))
}

fn is_season_digit(ch: char) -> bool {
    ch.is_ascii_digit()
        || matches!(
            ch,
            '零' | '〇'
                | '一'
                | '二'
                | '两'
                | '兩'
                | '三'
                | '四'
                | '五'
                | '六'
                | '七'
                | '八'
                | '九'
                | '十'
                | '百'
        )
}

fn chinese_digit(ch: char) -> Option<u32> {
    Some(match ch {
        '零' | '〇' => 0,
        '一' => 1,
        '二' | '两' | '兩' => 2,
        '三' => 3,
        '四' => 4,
        '五' => 5,
        '六' => 6,
        '七' => 7,
        '八' => 8,
        '九' => 9,
        _ => return None,
    })
}

/// 中文数字 → 阿拉伯数字（照参考实现 `hongguoSearchSeason` 的进位规则手写）。
///
/// 关键是拒绝而不是"凑"：权值不降（十十）、个位堆了两位（十二三）这类写法一旦
/// 硬算就会得到一个看着像季号、其实来自错误标题的数字，补齐会拿着它去查一个
/// 不存在的季。
fn parse_season_number(label: &[char]) -> Option<u32> {
    if label.iter().all(|ch| ch.is_ascii_digit()) {
        return label.iter().collect::<String>().parse::<u32>().ok();
    }
    if !label.iter().any(|ch| *ch == '十' || *ch == '百') {
        // 没有十/百的纯位值写法（实测基本只有单个「二」），逐位累加。
        let mut number = 0u32;
        for ch in label {
            number = number.checked_mul(10)?.checked_add(chinese_digit(*ch)?)?;
            if number > SEARCH_SEASON_LIMIT {
                return None;
            }
        }
        return Some(number);
    }
    // 十/百进位：「十二」= 12、「一百零八」= 108。previous 记住上一位的权值，
    // 用来判掉「十十」「百十」这种逆序写法。
    let mut number = 0u32;
    let mut digit = 0u32;
    let mut previous = 1000u32;
    // 是否已经进过位。`digit.max(1)` 那个"空个位按 1 算"的省略写法只对**首位**
    // 合法（十 = 10、百 = 100）；已经进过位之后又遇到空个位，说明中间那一位
    // 从来没被写出来（「百十」），那不是季号，按同一条原则一起拒掉。
    let mut carried = false;
    for ch in label {
        if let Some(value) = chinese_digit(*ch) {
            digit = digit.checked_mul(10)?.checked_add(value)?;
            // 个位只容得下一位：否则「十二三」会硬算出 33、「一二三」算出 123，
            // 看着像个季号，其实来自一个被误读的标题。
            if digit > 9 {
                return None;
            }
            continue;
        }
        let value = match ch {
            '十' => 10,
            '百' => 100,
            _ => return None,
        };
        if value >= previous || digit > 9 || (carried && digit == 0) {
            return None;
        }
        number += digit.max(1) * value;
        digit = 0;
        previous = value;
        carried = true;
    }
    Some(number + digit)
}

/// 补齐计划里的一组同系列条目。
struct SeasonGroup {
    /// 摘掉季号后的剧名原样（拼回查要用，不能用归一后的）。
    base: String,
    /// `search_text(base)`，与量词一起当组键。
    key: String,
    unit: String,
    known: HashSet<u32>,
}

/// 一次分季补齐的纯计划：查什么词、期望拿回哪一季。
struct SeasonFill {
    query: String,
    base_key: String,
    unit: String,
    season: u32,
}

/// 挑下一季该补的季号。
///
/// 至少要知道两季才补：只见过一季说明搜索根本没覆盖到这个系列，回查大概率是
/// 白花一次请求。优先补最大已知季号的下一季（站点把最新一季排前面，缺的多半
/// 就是它），断了头（最小已知季号 > 1）才回退到前一季。
fn next_season_to_fill(known: &HashSet<u32>) -> Option<u32> {
    if known.len() < 2 {
        return None;
    }
    let maximum = known.iter().copied().max()?;
    let minimum = known.iter().copied().min()?;
    if maximum < SEARCH_SEASON_LIMIT && !known.contains(&(maximum + 1)) {
        return Some(maximum + 1);
    }
    if minimum > 1 && !known.contains(&(minimum - 1)) {
        return Some(minimum - 1);
    }
    None
}

/// 从当前结果里挑出值得补的季号组，返回**至多 `SEARCH_SEASON_MAX_REQUESTS`**
/// 条回查计划（纯逻辑，不发请求，便于单测）。
///
/// 只补 base 里含关键词的组，否则搜「战神」会把「九州战神传」和「战神来了」
/// 两个不相干的系列都各回查一次，预算两次就白烧光了。
/// 组按相关度再按已知季数排，抢预算的自然是用户最可能要看的那部。
fn season_fill_plan(items: &[SeriesItem], keyword: &str) -> Vec<SeasonFill> {
    // 用户直接搜「聚宝仙盆第三季」时不要补：那已经是明确指向某一季的查询，
    // 再补一季只会让结果里混进用户没要的东西。
    if search_season(keyword).is_some() {
        return Vec::new();
    }
    let query_key = search_text(keyword);
    if query_key.is_empty() {
        return Vec::new();
    }
    let mut groups: Vec<SeasonGroup> = Vec::new();
    for item in items {
        let Some((base, season, unit)) = search_season(&item.title) else {
            continue;
        };
        let key = search_text(&base);
        if !key.contains(&query_key) {
            continue;
        }
        let position = match groups.iter().position(|g| g.key == key && g.unit == unit) {
            Some(position) => position,
            None => {
                groups.push(SeasonGroup {
                    base,
                    key: key.clone(),
                    unit,
                    known: HashSet::new(),
                });
                groups.len() - 1
            }
        };
        groups[position].known.insert(season);
    }
    let mut candidates: Vec<SeasonGroup> = groups
        .into_iter()
        .filter(|group| group.known.len() >= 2)
        .collect();
    candidates.sort_by(|left, right| {
        title_search_rank(&left.base, keyword)
            .cmp(&title_search_rank(&right.base, keyword))
            .then_with(|| right.known.len().cmp(&left.known.len()))
    });
    candidates
        .iter()
        .filter_map(|group| {
            let season = next_season_to_fill(&group.known)?;
            let query = format!(
                "{}第{}{}",
                group.base,
                to_chinese_number(season),
                group.unit
            );
            // 用户搜的词本身就是这一季（如 base 为「聚宝仙盆」+ 季号 1 且季号后缀
            // 没被 search_season 认出来），补查就是原地重发一次。
            if query == keyword {
                return None;
            }
            Some(SeasonFill {
                query,
                base_key: group.key.clone(),
                unit: group.unit.clone(),
                season,
            })
        })
        .take(SEARCH_SEASON_MAX_REQUESTS)
        .collect()
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

/// 去掉所有空白字符后比较，用于判定"这段文本是不是标题"。
///
/// 站点同一部剧在不同位置的空格并不一致：实测 alt 为
/// `你让我当牛马我在荒岛　成王第一季`（中间一个 U+3000 全角空格），而卡片标题
/// 元素里没有任何空格。`trim()` 只管首尾，中间的空格会让精确比较失效，标题
/// 因此被当成题材标签收下，再跟着"只增不减"的题材词表永久留在分类栏。
fn strip_spaces(value: &str) -> String {
    value.chars().filter(|c| !c.is_whitespace()).collect()
}

fn parse_catalog_cards(html: &str, channel: &str) -> Vec<SeriesItem> {
    let document = Html::parse_document(html);
    let anchor_selector = Selector::parse("a[href*='detail?series_id=']").expect("anchor selector");
    let image_selector = Selector::parse("img").expect("image selector");
    let source_selector = Selector::parse("source").expect("source selector");
    // 卡片标题元素：站点用 CSS module，类名形如 `pc-title-l_s3n8` / `m-title-F3bkRB`，
    // 前缀稳定、hash 后缀随构建变化，所以按前缀匹配。
    let title_selector =
        Selector::parse("[class*='pc-title-'], [class*='m-title-']").expect("title selector");
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
        // 标题优先取卡片自己的标题元素，img alt 只作兜底。
        //
        // 为什么不能只信 alt：站点数据里 alt 与标题文本并不总相等——实测存在
        // alt="你让我当牛马我在荒岛　成王第一季"（中间多一个全角空格）而卡片
        // 文本没有空格的卡片。旧实现只从 alt 取标题、再用"文本 != 标题"的精确
        // 比较去剔除标题，于是那个标题原样成了题材标签，跟着"只增不减"的题材
        // 词表永久留在分类栏（用户看到的是"分类里出现了视频标题名称"）。
        let title = anchor
            .select(&title_selector)
            .map(|node| node.text().collect::<String>())
            .map(|text| text.trim().to_string())
            .find(|value| !value.is_empty())
            .or_else(|| {
                anchor
                    .select(&image_selector)
                    .filter_map(|image| image.value().attr("alt"))
                    .map(str::trim)
                    .find(|value| !value.is_empty())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "未命名短剧".to_string());
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
        // 题材标签 = 卡片里"除了标题和集数之外的文本"。
        //
        // 两个判据缺一不可：① 与标题比较前先做空白归一化（站点同一部剧在 alt 与
        // 标题元素里的空格并不一致，精确比较必然漏判）；② 只收"纯字词"文本——
        // 题材词是"爱情""无限流"这种词，而剧名常带"，""！"等标点。
        let title_key = strip_spaces(&title);
        let tags = anchor
            .text()
            .map(str::trim)
            .filter(|value| {
                if value.is_empty() || episode_re.is_match(value) {
                    return false;
                }
                if !value
                    .chars()
                    .all(|c| c.is_alphanumeric() || c == '-' || c == '/' || c == '·')
                {
                    return false;
                }
                let norm = strip_spaces(value);
                if norm == title_key {
                    return false;
                }
                // 标题被站点截断/加后缀时长度对不上，退一步用包含关系兜底；
                // 只对长文本启用，避免把"爱情"这种真题材词从"爱情公寓"里误杀。
                if norm.chars().count() >= 6
                    && (title_key.contains(norm.as_str()) || norm.contains(title_key.as_str()))
                {
                    return false;
                }
                true
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
            // 恒为 None：目录卡片是**从 HTML 抓**的，实测卡片文本里只有剧名、
            // 题材词与"全 77 集"这类集数文案，站点不在卡面上标评分。评分只在
            // 详情页（`seriesSocialInfo.rating`），而详情页进的是 SeriesDetail。
            // 这里写死 None 而不是去正则扒文本——扒不出就是 None，扒出来一个像
            // 集数或题材的数字比没有评分更糟。
            rating: None,
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

/// 取一条剧集对象上的**用户评分**，0-10 量纲，站点不给返回 `None`。
///
/// 键名只认 `rating` / `rate`，**刻意不认 `score`**。实测（2026-09-29 抓
/// `/search/战神` 的 SSR router data）搜索结果的 `video_data` 上确实有 `score`，
/// 但它在 `hot_score_data` 子对象里、值是 `44456111`、配套文案"4445万热度"——
/// 那是**热度**不是评分，`hot` 与评分是两回事（热度另走 `heat` 那个字段）。
/// 把它当评分读，角标会直接显示成 "44456111.0 分"。
///
/// 量纲实测：`/detail?series_id=…` 的 `loaderData.detail_page.seriesSocialInfo.rating`
/// 是 0-10（实测 7.8 / 8.3 / 8.7 / 9 / 9.6），并且**整数与浮点混着发**
/// （同一次实测里 `9` 是 JSON 整数）。`Value::as_f64` 两种都吃，故不做 `as_f64` 之外
/// 的额外分支。前端角标是 `rating.toFixed(1)`，量纲一致，**不需要换算**。
///
/// 超出 0-10 一律当 `None`：站点哪天改量纲（换 0-5 或 0-100）时，宁可角标不显示，
/// 也不能把 87.3 分显示成 87.3/10。
///
/// ⚠️ 现状（实测，别照文档猜）：**列表页与搜索页的卡片数据里根本没有评分**。
/// 逐个抓过 `/category/real-drama`、`/category/comic-drama`、
/// `/category/real-drama/romance`、`/rank/hot-comic-drama` 与 `/search/{词}`，
/// score/rating/rate/grade 类键一个都没有；`recommendList[]` 的字段只有
/// accessible_episode_cnt / celebrities / episode_cnt / episode_right_text /
/// pay_type / series_cover / series_episode_info / series_id / series_intro /
/// series_name / tags / vid_list。评分**只在详情页**，而详情页不进
/// `SeriesItem`（进的是 `SeriesDetail`）。所以真实数据下角标仍然是空的——
/// 这是站点的事实，不是解析漏了。这里先把取值与判据落好并锁测试，站点哪天在
/// 列表里补上评分就会自动亮。
fn parse_rating(video: &Map<String, Value>) -> Option<f64> {
    ["rating", "rate"]
        .iter()
        .find_map(|key| video.get(*key))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && (0.0..=10.0).contains(value))
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
        cached_theme_page, catalog_page_path, detect_total_pages, find_pagination_value,
        next_season_to_fill, normalize_playback_url, paginate_filtered, parse_catalog_cards,
        parse_rating, parse_router_script, parse_season_number, parse_theme_routes,
        rank_search_items, search_season, search_text, season_fill_plan, store_theme_page,
        title_search_rank, DramaProvider, SeriesItem, Value,
    };
    use crate::models::CatalogFilter;
    use std::collections::HashSet;

    fn search_item(id: &str, title: &str) -> SeriesItem {
        SeriesItem {
            id: id.into(),
            title: title.into(),
            cover: String::new(),
            item_type: "drama".into(),
            episodes_count: 0,
            latest_episode_title: None,
            tags: vec![],
            origin: String::new(),
            brief: None,
            rating: None,
        }
    }

    fn ranked_titles(keyword: &str, items: &[(&str, &str)]) -> Vec<String> {
        let mut items: Vec<SeriesItem> = items
            .iter()
            .map(|(id, title)| search_item(id, title))
            .collect();
        rank_search_items(&mut items, keyword);
        items.into_iter().map(|item| item.title).collect()
    }

    /// 搜索结果按关键词相关度重排：含完整关键词的排最前，
    /// 标题完全不含关键词的联想条目排最后（"搜出来的第一张不是我要的"）。
    ///
    /// 同级的两条联想项按站点原始顺序留原样——新分级不再区分它们，
    /// 这条断言锁住"没有新的信息就别乱动顺序"。
    #[test]
    fn ranks_search_items_by_keyword_relevance() {
        let titles = ranked_titles(
            "战神",
            &[
                ("1", "大将军扛楼养活百万大军"),
                ("2", "特级战龙"),
                ("3", "我只想找死，却被奉为九州战神了"),
            ],
        );
        assert_eq!(titles[0], "我只想找死，却被奉为九州战神了");
        assert_eq!(titles[1], "大将军扛楼养活百万大军");
        assert_eq!(titles[2], "特级战龙");
    }

    /// 五级相关度：完全相等 > 前缀 > 包含 > 全分词命中 > 其余。
    ///
    /// 关键词故意带一个空格："九州 战神"整串匹配不上"战神降临九州"，
    /// 但两个词都在标题里，这一级才有机会被覆盖到。
    #[test]
    fn ranks_search_items_into_five_levels() {
        assert_eq!(title_search_rank("九州战神", "九州 战神"), 0);
        assert_eq!(title_search_rank("九州战神录", "九州 战神"), 1);
        assert_eq!(
            title_search_rank("我只想找死却被奉为九州战神了", "九州 战神"),
            2
        );
        assert_eq!(title_search_rank("战神降临九州", "九州 战神"), 3);
        assert_eq!(title_search_rank("大将军扛楼养活百万大军", "九州 战神"), 4);

        let titles = ranked_titles(
            "九州 战神",
            &[
                ("1", "大将军扛楼养活百万大军"),
                ("2", "战神降临九州"),
                ("3", "我只想找死，却被奉为九州战神了"),
                ("4", "九州战神"),
                ("5", "九州战神录"),
            ],
        );
        assert_eq!(
            titles,
            vec![
                "九州战神",
                "九州战神录",
                "我只想找死，却被奉为九州战神了",
                "战神降临九州",
                "大将军扛楼养活百万大军",
            ]
        );
    }

    /// 归一化：全角数字字母与全角空格要和半角写法算出同一个值。
    ///
    /// 用户照着海报敲全角是常态，而站点标题里混着 U+3000 全角空格；
    /// 不归一的话「ＡＢＣ」搜不出「abc 之崛起」。
    #[test]
    fn search_text_normalizes_fullwidth_and_case() {
        assert_eq!(search_text("ＡＢＣ　def-１"), "abcdef1");
        assert_eq!(search_text("ABC def-1"), search_text("ＡＢＣ　def-１"));
        // 全标点的关键词不能把所有标题都判成命中，否则整页顺序会被抹平。
        assert_eq!(title_search_rank("ＡＢＣ！", "abc"), 0);
        assert_eq!(title_search_rank("随便什么剧", "！？"), 4);
    }

    /// 同系列按季号升序：搜主标题时看到的应该是一整串连续的季。
    #[test]
    fn ranks_same_series_by_season_number() {
        let titles = ranked_titles(
            "聚宝仙盆",
            &[
                ("1", "聚宝仙盆第三季"),
                ("2", "聚宝仙盆"),
                ("3", "聚宝仙盆第二季"),
            ],
        );
        assert_eq!(titles, vec!["聚宝仙盆", "聚宝仙盆第二季", "聚宝仙盆第三季"]);
    }

    /// 季号解析：中文数字要按十/百进位读，缺 base 的「第三季」不构成系列。
    #[test]
    fn search_season_parses_chinese_numerals() {
        assert_eq!(
            search_season("聚宝仙盆第十二季"),
            Some(("聚宝仙盆".to_string(), 12, "季".to_string()))
        );
        assert_eq!(
            search_season("某剧第一百零八部"),
            Some(("某剧".to_string(), 108, "部".to_string()))
        );
        assert_eq!(
            search_season("《聚宝仙盆》第二季"),
            Some(("聚宝仙盆".to_string(), 2, "季".to_string()))
        );
        assert_eq!(
            search_season("聚宝仙盆第 2 季"),
            Some(("聚宝仙盆".to_string(), 2, "季".to_string()))
        );
        // 超上限的集数不能被认成季号：认下来只会把补齐带偏。
        assert_eq!(search_season("某剧第 1080 季"), None);
        // 尾数写错就整条判负，不硬凑一个看着像季号的数字。
        assert_eq!(search_season("某剧第十十季"), None);
        assert_eq!(search_season("第三季"), None);
        assert_eq!(search_season("聚宝仙盆"), None);
    }

    /// `parse_season_number` 的"拒绝而不是凑"：畸形写法必须返回 `None`，
    /// 否则会拿着一个看着像季号、其实来自错误标题的数字去回查，烧掉
    /// `SEARCH_SEASON_MAX_REQUESTS` 的预算并把分季顺序排错。
    ///
    /// - 「十二三」个位堆了两位 → 硬算会得到 33；
    /// - 「百十」进过位之后又碰到空个位 → 硬算会得到 110；
    /// - 「十十」权值不降 → 早已由 `previous` 拦下，这里钉住不回归。
    #[test]
    fn parse_season_number_rejects_malformed_chinese_numerals() {
        let parse = |text: &str| parse_season_number(&text.chars().collect::<Vec<_>>());
        assert_eq!(parse("十二三"), None, "个位堆两位");
        assert_eq!(parse("百十"), None, "进位后又遇空个位");
        assert_eq!(parse("十十"), None, "权值不降");
        // 正常写法一个都不能被误伤（「某剧第一百零八部」是实测真标题）。
        assert_eq!(parse("一百零八"), Some(108));
        assert_eq!(parse("二十一"), Some(21));
        assert_eq!(parse("两百"), Some(200));
        assert_eq!(parse("十二"), Some(12));
        assert_eq!(parse("一百二十"), Some(120));
        assert_eq!(parse("十"), Some(10));
        // 纯位值写法走的是另一条分支，不受十/百那套进位规则影响。
        assert_eq!(parse("二三"), Some(23));
        assert_eq!(parse("二"), Some(2));
        // 阿拉伯数字原样解析，空标签仍然无解。
        assert_eq!(parse("12"), Some(12));
        assert_eq!(parse(""), None);
        assert_eq!(parse("十X"), None);
    }

    /// 挑补哪一季：优先补最大已知季号的下一季，断了头才回退。
    #[test]
    fn next_season_to_fill_prefers_next_then_gap() {
        let known = |seasons: &[u32]| -> HashSet<u32> { seasons.iter().copied().collect() };
        assert_eq!(next_season_to_fill(&known(&[2, 3])), Some(4));
        assert_eq!(next_season_to_fill(&known(&[1, 2, 3])), Some(4));
        // 只见过一季说明搜索没覆盖到整个系列，回查多半白花一次请求。
        assert_eq!(next_season_to_fill(&known(&[3])), None);
        // 最大季号顶到上限时不再往上补，改补断头的那一季（生产路径上这类组
        // 会被 season_fill_plan 先剔掉，这里留着当上限万一被调高时的护栏）。
        assert_eq!(next_season_to_fill(&known(&[150, 200])), Some(149));
    }

    /// 补齐计划：只补"确实缺一季"的同系列，用户直接搜某一季时不补，
    /// 不相关的系列不占回查预算。
    #[test]
    fn season_fill_plan_targets_gaps_only() {
        let items: Vec<SeriesItem> = ["聚宝仙盆第二季", "聚宝仙盆第三季", "别的剧第五季"]
            .iter()
            .enumerate()
            .map(|(index, title)| search_item(&index.to_string(), title))
            .collect();
        let plan = season_fill_plan(&items, "聚宝仙盆");
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].query, "聚宝仙盆第四季");
        assert_eq!(plan[0].season, 4);
        // 用户已经指定了季号，别再往结果里塞别的季。
        assert!(season_fill_plan(&items, "聚宝仙盆第三季").is_empty());
        // 只有一季的系列不补。
        let lonely = vec![search_item("1", "聚宝仙盆第三季")];
        assert!(season_fill_plan(&lonely, "聚宝仙盆").is_empty());
    }

    /// 题材页缓存要能原样取回，且不同键不得互相命中。
    ///
    /// 这条锁住"来回点题材秒切"的能力：键里少拼了频道或页码，用户点 A 拿到的
    /// 就会是 B 的卡片——那比慢更糟。TTL 内的过期行为不便在单测里等待，只锁键。
    #[test]
    fn theme_page_cache_round_trips_and_separates_keys() {
        let page = |title: &str| crate::models::CatalogPage {
            items: vec![SeriesItem {
                id: "1".into(),
                title: title.into(),
                cover: String::new(),
                item_type: "drama".into(),
                episodes_count: 0,
                latest_episode_title: None,
                tags: vec![],
                origin: String::new(),
                brief: None,
                rating: None,
            }],
            total: 1,
            has_more: false,
            page: 1,
            categories: vec!["全部".into()],
            next_cursor: None,
            source: "test".into(),
            degraded: false,
        };
        let key = "theme-cache-test|huanxiang|1|30|recommend";
        store_theme_page(key, &page("玄幻"));
        let hit = cached_theme_page(key).expect("刚存进去的题材页应命中");
        assert_eq!(hit.items[0].title, "玄幻");
        assert!(cached_theme_page("theme-cache-test|huanxiang|2|30|recommend").is_none());
        assert!(cached_theme_page("comic|huanxiang|1|30|recommend").is_none());
    }

    /// 卡片标题绝不能变成题材标签。
    ///
    /// 锁住"分类里出现了视频标题名称"：站点同一部剧在 img alt 与标题元素里的
    /// 空格并不一致（实测 alt 中间多一个 U+3000 全角空格），而旧实现用精确比较
    /// 剔除标题——漏判一次，剧名就被当成题材收下，并跟着"只增不减"的题材词表
    /// 永久留在分类栏里。
    #[test]
    fn card_title_never_becomes_category_tag() {
        let html = r#"<html><body>
        <a href="/detail?series_id=7673888102712101950" class="pc-card-DQXf3W">
          <div class="pc-img-container-lewSpn">
            <img class="image-PWlIcn" src="https://p3.example.com/a.image" alt="你让我当牛马我在荒岛　成王第一季"/>
          </div>
          <p class="pc-title-l_s3n8 m-title-F3bkRB">你让我当牛马我在荒岛成王第一季</p>
          <div class="pc-tags-fSDXii"><span>脑洞</span><span>异能</span></div>
        </a>
        <a href="/detail?series_id=111" class="pc-card-DQXf3W">
          <div class="pc-img-container-lewSpn">
            <img class="image-PWlIcn" src="https://p3.example.com/b.image" alt="破库房的秘密"/>
          </div>
          <p class="pc-title-l_s3n8 m-title-F3bkRB">破库房的秘密</p>
          <div class="pc-tags-fSDXii"><span>剧情</span><span>逆袭</span><span>年代</span></div>
        </a>
        </body></html>"#;
        let cards = parse_catalog_cards(html, "comic");
        assert_eq!(cards.len(), 2);
        assert_eq!(cards[0].title, "你让我当牛马我在荒岛成王第一季");
        assert_eq!(cards[0].tags, vec!["脑洞", "异能"]);
        assert_eq!(cards[1].tags, vec!["剧情", "逆袭", "年代"]);
    }

    /// 带标点的剧名（站点上真实存在，如"栀栀复栀栀！太子爷非她不可第七季"）
    /// 同样不能当题材——真题材词不带标点。
    #[test]
    fn punctuated_title_is_not_a_category_tag() {
        let html = r#"<html><body>
        <a href="/detail?series_id=222">
          <img src="https://p3.example.com/c.image" alt="栀栀复栀栀！太子爷非她不可第七季"/>
          <p class="pc-title-l_s3n8">栀栀复栀栀！太子爷非她不可第七季</p>
          <span>豪门</span><span>甜宠</span>
        </a>
        </body></html>"#;
        let cards = parse_catalog_cards(html, "drama");
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].tags, vec!["豪门", "甜宠"]);
    }

    /// 联网回归：真实页面里的卡片标题不能变成题材标签。
    ///
    /// 漫剧第 10 页实测就有 alt 与标题空格不一致的卡片（"你让我当牛马我在荒岛
    /// 成王第一季"），它曾把整条剧名塞进题材栏并永久留在那里。默认忽略：
    ///   cargo test --bins -- --ignored --nocapture catalog_tags_live
    #[tokio::test]
    #[ignore = "需要联网，手动运行"]
    async fn catalog_tags_live() {
        let provider = DramaProvider::new().expect("provider");
        let filter = CatalogFilter {
            source: None,
            channel: "comic".to_string(),
            category: "全部".to_string(),
            audience: "全部".to_string(),
            sort: "recommend".to_string(),
            keyword: None,
            page: 10,
            page_size: 30,
            cursor: None,
        };
        let page = provider.catalog(&filter).await.expect("comic page 10");
        assert!(!page.items.is_empty(), "漫剧第 10 页为空");
        for item in &page.items {
            for tag in &item.tags {
                assert!(
                    !tag.contains("成王") && !tag.contains("破库房"),
                    "标题混进了题材标签：{tag:?}（来自《{}》）",
                    item.title
                );
            }
        }
        println!(
            "漫剧第 10 页 {} 条，首条标签：{:?}",
            page.items.len(),
            page.items.first().map(|item| &item.tags)
        );
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
                source: None,
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
            source: None,
            channel: "drama".to_string(),
            category: "都市".into(),
            audience: "全部".into(),
            sort: "recommend".into(),
            keyword: None,
            page,
            page_size: 30,
            cursor: None,
        };
        let cold_start = std::time::Instant::now();
        let first = provider.catalog(&filter(1)).await.expect("theme page 1");
        println!(
            "题材「都市」第 1 页: {} 条 has_more={} source={:?}（首次，耗时 {:?}）",
            first.items.len(),
            first.has_more,
            first.source,
            cold_start.elapsed()
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

        // 题材页缓存实测：同一题材连点两次（"点回上一个题材看看"是最普通的
        // 操作），第二次必须走缓存——它决定了来回比较几个题材是否秒切。
        let warm_start = std::time::Instant::now();
        let again = provider
            .catalog(&filter(1))
            .await
            .expect("theme page 1 (cached)");
        println!(
            "题材「都市」第 1 页（第二次，命中缓存）: {} 条，耗时 {:?}",
            again.items.len(),
            warm_start.elapsed()
        );
        assert_eq!(
            again.items.len(),
            first.items.len(),
            "缓存返回的条目数应与首次一致"
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
                source: None,
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
                    source: None,
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
                source: None,
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

    /// 评分只取站点真给的值，脏数据一律 None。
    ///
    /// 形状照抄 2026-09-29 实测的 `/search/{词}` → `video_data`：
    /// 实测这条链路上**没有** `rating`，只有 `hot_score_data.score`（热度），
    /// 所以正常路径是 `None`——这是站点的现状，不是解析失败。
    ///
    /// 锁住的是取值规则本身：站点哪天把 `rating` 补上就得立刻能用，且**绝不能**
    /// 拿热度冒充评分。
    #[test]
    fn rating_reads_only_real_scores() {
        // `parse_rating` 收的是 `video_data` 那个对象，所以按 `Value::Object`
        // 解析——直接 `from_str::<Value>` 再取引用会把类型对不上。
        let rating_of = |raw: &str| -> Option<f64> {
            let value: Value = serde_json::from_str(raw).expect("json");
            match value {
                Value::Object(map) => parse_rating(&map),
                other => panic!("期望 JSON 对象，实际是 {other}"),
            }
        };
        // 缺失：实测的 video_data 原样就是这种形状 → None
        assert_eq!(
            rating_of(r#"{"series_id":"1","series_title":"战神"}"#),
            None
        );
        // 实测热度键：4445 万热度，绝不能当评分读进来
        assert_eq!(
            rating_of(r#"{"hot_score_data":{"score":44456111,"text":"4445万热度"}}"#),
            None
        );
        // 实测详情页 seriesSocialInfo 的形状：整数 9 与浮点 9.6 混着发
        assert_eq!(rating_of(r#"{"rating":9}"#), Some(9.0));
        assert_eq!(rating_of(r#"{"rating":9.6}"#), Some(9.6));
        assert_eq!(rating_of(r#"{"rating":0}"#), Some(0.0));
        // 非数字 / null / 空串：站点没给分，不能变成 0
        assert_eq!(rating_of(r#"{"rating":"9.6"}"#), None);
        assert_eq!(rating_of(r#"{"rating":null}"#), None);
        assert_eq!(rating_of(r#"{"rating":""}"#), None);
    }

    /// 量纲锁死 0-10，越界当 None。
    ///
    /// 前端角标是 `rating.toFixed(1)` 直出、不做任何换算，所以 Rust 侧**不能**
    /// 换算（换算就得两处都改，一个漏改就是错分）。代价是站点哪天把量纲换成
    /// 0-100，这里会返回 None 而不是显示 "87.3 分"——宁可角标不显示（不变量 8）。
    #[test]
    fn rating_rejects_out_of_scale_values() {
        let rating_of = |raw: &str| -> Option<f64> {
            match serde_json::from_str::<Value>(raw).expect("json") {
                Value::Object(map) => parse_rating(&map),
                other => panic!("期望 JSON 对象，实际是 {other}"),
            }
        };
        assert_eq!(rating_of(r#"{"rating":10.0}"#), Some(10.0));
        // 0-100 量纲的 87.3 会被挡住
        assert_eq!(rating_of(r#"{"rating":87.3}"#), None);
        assert_eq!(rating_of(r#"{"rating":-1}"#), None);
        // `rate` 是同义键（guo-core 的 provider_huangguo.go 就是 score/rating 二选一），
        // 但那个源的 score 是热度字符串，Rust 侧不读它。
        assert_eq!(rating_of(r#"{"rate":7.8}"#), Some(7.8));
    }

    /// 索引残缺必须一路传到 `CatalogPage.degraded`，且**只在**真的残缺时置位。
    ///
    /// 锁的是"题材筛选那条路"：它全靠全站索引，`catalog_index` 里"单页失败不
    /// 整体失败"跳过的那几页对应的条目是真的搜不到，不报就是骗用户说"全站就
    /// 这些"。索引完整时必须是 false，否则正常浏览也会常亮降级角标。
    #[test]
    fn paginate_filtered_carries_index_degradation() {
        let filter = CatalogFilter {
            source: None,
            channel: "drama".to_string(),
            category: "全部".into(),
            audience: "全部".into(),
            sort: "recommend".into(),
            keyword: None,
            page: 1,
            page_size: 30,
            cursor: None,
        };
        let items = vec![search_item("1", "战神"), search_item("2", "和气生财")];
        assert!(
            !paginate_filtered(items.clone(), &filter, 1, false).degraded,
            "索引完整时不得报降级"
        );
        assert!(
            paginate_filtered(items, &filter, 1, true).degraded,
            "索引建的时候跳过过整页，就必须报降级"
        );
    }

    /// `rating` 缺失时序列化仍是合法 JSON（前端 `rating?: number` 兼容 undefined）。
    ///
    /// 顺带锁住 `degraded` 恒定出现——前端靠它区分"这次结果可不可信"，
    /// 少这个键就退回到按 `source` 文案猜的老路。
    #[test]
    fn catalog_page_always_emits_degraded_and_omits_absent_rating() {
        let item = search_item("1", "战神");
        let page = crate::models::CatalogPage {
            items: vec![item],
            total: 1,
            has_more: false,
            page: 1,
            categories: vec!["全部".into()],
            next_cursor: None,
            source: "test".into(),
            degraded: true,
        };
        let json = serde_json::to_string(&page).expect("序列化");
        assert!(
            json.contains(r#""degraded":true"#),
            "degraded 必须恒定出现在载荷里：{json}"
        );
        assert!(
            !json.contains("rating"),
            "rating 为 None 时不该输出占位 0：{json}"
        );
    }
}
