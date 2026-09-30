#![windows_subsystem = "windows"]

mod anime_provider;
mod dmghg_bridge;
mod guo_provider;
mod hls_proxy;
mod models;
mod pip;
mod provider;
mod short_drama_app;
mod storage;
mod update;

use crate::models::{
    CacheClearResult, CatalogFilter, CatalogPage, FavoriteItem, PlaybackOpenInput, PlaybackSession,
    PlaybackSnapshot, PlaybackUiState, SeriesDetail, SeriesItem, UserSettings, WatchHistoryItem,
};
use crate::pip::{pip_close, pip_dismiss, pip_handoff, pip_is_open, pip_open, pip_report};
use crate::provider::DramaProvider;
use crate::short_drama_app::{
    short_drama_app_album, short_drama_app_cache_clear, short_drama_app_cache_usage,
    short_drama_app_episode_counts, short_drama_app_prefetch_stream, short_drama_app_qualities,
    short_drama_app_resolve, short_drama_app_set_device, short_drama_app_status,
    short_drama_app_stream,
};
use crate::storage::Database;
use crate::update::{app_version, update_check, update_download, update_reveal};
use std::collections::HashMap;
use std::fs;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Manager, State};

struct AppState {
    provider: DramaProvider,
    anime_provider: crate::anime_provider::AnimeProvider,
    guo_provider: crate::guo_provider::GuoProvider,
    database: Database,
    sessions: Mutex<HashMap<u64, PlaybackSession>>,
    cache_dir: PathBuf,
}

/// 目录首屏返回后，后台预热两个频道的官方题材路由。
///
/// 点题材此前要先抓一次 `/category/{segment}` 才能把题材名换成子路由 slug，
/// 那一次往返就压在用户的点击路径上（实测首次点题材要等一秒上下）。这里在
/// 用户还在浏览目录时就抓好，点击时只剩题材页本身一次往返。
///
/// 只在第 1 页触发：翻页会反复调用 `catalog_list`，而预热只需要一次。
/// 命中缓存时这里就是一次内存查表，无网络开销。
fn warm_theme_routes(app: &tauri::AppHandle, page: u32) {
    if page > 1 {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = handle.state::<AppState>();
        for channel in ["drama", "comic"] {
            let _ = state.provider.theme_routes(channel).await;
        }
    });
}

/// 从筛选器里取出非空关键词。
fn keyword_of(filter: &CatalogFilter) -> Option<String> {
    filter
        .keyword
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// 18+ 站源被总开关挡住时统一的对外文案。
///
/// 不带站源名、不带内部 id（不变量 12）：这段话会直接渲染到界面上，里面出现
/// `dsd` / `guo:dsd:…` 等于告诉调用方"这条被关的路存在、还怎么走"——门闩连
/// 自己的钥匙形状都不该往外露。
const ADULT_SOURCE_BLOCKED: &str = "该内容源已关闭，可在设置中重新开启。";

/// 18+ 站源的总开关当前是否放行。
///
/// **这里必须同步取完、只把 bool 带出去**：`storage::settings_get` 内部自己拿
/// `Mutex<Connection>` 并返回自有类型，而下面每条命令体里都散布着 `.await`。
/// 任何把 guard 或 &UserSettings 活过 await 的写法都会把一把全局数据库锁
/// 拖过整个网络往返——而这些命令全部在 tokio 工作线程上跑，那等于把整个应用的
/// 设置读写串行化。现在这个函数返回 bool，锁在它返回时已经释放，物理上跨不过
/// await。
///
/// 读失败按"关闭"处理。门闩的默认姿态是关的（成人源必须显式开启），反过来
/// 在故障时放行等于门闩自己把自己打开了。
fn adult_sources_allowed(state: &AppState) -> bool {
    state
        .database
        .settings_get()
        .map(|settings| settings.show_adult_sources)
        .unwrap_or(false)
}

/// 目录/搜索类入口的门闩：算出**实际该用的**站源。
///
/// 返回 `None` 表示"这一路不该走 guo"，调用方据此回落到红果官网链路。
///
/// **为什么是静默回落而不是 Err**：这类入口的语义是"给我列个目录"，用户刚才
/// 做的事只是选了一个源。前端在总开关关闭时本来就做了同款处理（选中的源被
/// 隐藏就切回红果，见 `ExploreView`），后端做同样的事不改变任何 UI 观感；
/// 反过来在这里 Err，界面会凭空多出一张"目录加载失败"的红卡片，而用户什么
/// 都没做错——那是把一条内部策略暴露成了故障。
///
/// 命中时也要顺手改掉 `filter.source` 本身而不只是忽略它：下游
/// `merge_search_sources` / `search_cache_key` 都读这个字段，留着它会让
/// 缓存 key 变成"红果结果挂在帝果的 key 下"，切开关后立刻读到旧缓存。
fn gated_source(source: Option<&str>, show_adult: bool) -> Option<String> {
    let source = source?;
    if !show_adult && guo_provider::source_is_adult(source) {
        return None;
    }
    Some(source.to_owned())
}

/// 按 id 直达类入口（详情 / 封面 / 起播 / 画质）的门闩纯判定。
///
/// 与 [`gated_source`] 分成"静默回落"和"报错"两种，差别只在**用户此刻是不是
/// 正在看被禁内容**：
/// - 目录/搜索：用户只选了个源，列表里本就不该出现异常 → 静默回红果；
/// - 直达：用户已经点开了某部被禁的剧，**报错才是正确结果**。静默回退在这里
///   等于"我照播了但你看不见"，用户会以为是自己设备坏了；而播放这条一旦漏了
///   守卫就是整个门闩唯一的实质失守点（绕过目录直接按 id 取流）。
fn series_source_allowed(series_id: &str, show_adult: bool) -> bool {
    show_adult || !guo_provider::source_is_adult(guo_provider::guo_source_of(series_id))
}

/// [`series_source_allowed`] 的命令侧封装：读设置 + 命中即 Err。
fn ensure_series_source_allowed(series_id: &str, state: &AppState) -> Result<(), String> {
    if series_source_allowed(series_id, adult_sources_allowed(state)) {
        Ok(())
    } else {
        Err(ADULT_SOURCE_BLOCKED.to_owned())
    }
}

/// 搜索结果缓存的存活期。
///
/// 5 分钟覆盖"切走再切回、退格重输同一个词、联想在首屏之后被单独补一次"这一段
/// 操作（同一个词因此会被完整重跑 2~3 遍，其中 `catalog_suggest` 每次都要冷启动
/// 一个 Python 进程，实测 0.6-1.9s）。再长就不划算了：目录与榜单是活的，5 分钟
/// 前的搜索结果对用户已经没有新鲜度价值。
const SEARCH_CACHE_TTL: Duration = Duration::from_secs(5 * 60);

/// 缓存条目数上限。超限直接整表清空，不做 LRU：搜索词的基数极低（一个会话里
/// 用户真搜过的词撑死几十个），128 条足够覆盖；为省一次整表清空去维护访问顺序
/// 与链表，复杂度不划算。
const SEARCH_CACHE_CAPACITY: usize = 128;

/// 搜索结果缓存。只服务 `catalog_fast_search`（keyword 非空时）与 `catalog_suggest`。
///
/// **目录浏览（keyword 为空）绝不入缓存**：浏览要的是最新上架与实时排序，把旧页
/// 缓存住等于让用户在一个已经陈旧的目录里翻页。
///
/// 锁是 `std::sync::Mutex` 且只在同步块内短暂持有（查/写完立刻释放），绝不跨
/// `.await`：这些命令体里有多处 await 跨越点，跨 await 持锁会把 tokio 工作线程
/// 串行化，缓存反而成了新的瓶颈。锁中毒时按"没有缓存"处理——缓存坏掉不该让
/// 搜索失败。
struct SearchCache<T> {
    ttl: Duration,
    entries: Mutex<HashMap<String, (Instant, T)>>,
}

impl<T: Clone> SearchCache<T> {
    fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            entries: Mutex::new(HashMap::new()),
        }
    }

    fn get(&self, key: &str) -> Option<T> {
        let mut guard = self.entries.lock().ok()?;
        let expired = matches!(
            guard.get(key),
            Some((stored_at, _)) if stored_at.elapsed() >= self.ttl
        );
        if expired {
            // 顺手删掉过期条目：容量上限是硬清空，不主动回收的话过期值会一直占位。
            guard.remove(key);
            return None;
        }
        guard.get(key).map(|(_, value)| value.clone())
    }

    fn put(&self, key: String, value: T) {
        let Ok(mut guard) = self.entries.lock() else {
            return;
        };
        if guard.len() >= SEARCH_CACHE_CAPACITY {
            guard.clear();
        }
        guard.insert(key, (Instant::now(), value));
    }
}

static FAST_SEARCH_CACHE: OnceLock<SearchCache<CatalogPage>> = OnceLock::new();
static SUGGEST_CACHE: OnceLock<SearchCache<Vec<SeriesItem>>> = OnceLock::new();

fn fast_search_cache() -> &'static SearchCache<CatalogPage> {
    FAST_SEARCH_CACHE.get_or_init(|| SearchCache::new(SEARCH_CACHE_TTL))
}

fn suggest_cache() -> &'static SearchCache<Vec<SeriesItem>> {
    SUGGEST_CACHE.get_or_init(|| SearchCache::new(SEARCH_CACHE_TTL))
}

/// 搜索缓存的 key。所有会改变结果的参数都要编进来，漏一个就会串味：同一个词在
/// drama / comic 两个频道下是两批完全不同的条目，page 更是不同切片。
///
/// 题材/受众/排序不进 key：网页搜索刻意不叠加这些筛选（见 provider 的搜索分支
/// 注释），编进去只会把"带着题材去搜"的正常操作判成不同 key，白白丢掉缓存命中。
/// 频道是硬条件：合并动漫源时它会被改写成 `anime`，两者的结果集并不相同。
///
/// 缓存是函数级的私有 statics，跨命令共用会把"含联想的 catalog_list 结果"和
/// "不含联想的快速首屏"混成同一份，所以不按命令名分桶。
fn search_cache_key(filter: &CatalogFilter, keyword: &str) -> String {
    format!(
        "fast|src={}|ch={}|kw={}|p={}|n={}",
        filter.source.as_deref().unwrap_or_default(),
        filter.channel,
        keyword,
        filter.page,
        filter.page_size,
    )
}

fn suggest_cache_key(keyword: &str, channel: &str) -> String {
    format!("suggest|kw={keyword}|ch={channel}")
}

fn suggestion_to_item(
    suggestion: crate::short_drama_app::SearchSuggestion,
    channel: &str,
) -> SeriesItem {
    SeriesItem {
        id: suggestion.id,
        title: suggestion.title,
        cover: suggestion.cover,
        item_type: channel.to_owned(),
        episodes_count: suggestion.episode_count,
        latest_episode_title: None,
        tags: suggestion.tags,
        origin: "红果 App 联想".into(),
        brief: None,
        rating: None,
    }
}

/// 多源搜索的合并链：红果网页（结构化、带集数与题材）+ 动漫源，外加可选的
/// App 联想（补齐分季条目）。
///
/// 三个来源并发：串行会让搜索凭空多等一次往返，而三者互不依赖。
///
/// 为什么在后端合并：搜索页此前只搜红果（channel 硬编码 drama），动漫共和国
/// 的视频永远搜不到。动漫源失败只跳过——它是补充来源，不该让红果结果陪葬；
/// 但会在 `source` 里留一句说明，避免用户把残缺结果当成全集。
///
/// `with_suggestions` 为什么是个开关：联想要冷启动一个 Python 进程（实测端到端
/// 0.6-1.9s），而它只是补充。开着它，网页结果 0.3s 就绪也要在 join! 里陪等到
/// 1s 以后——这正是"搜索慢"的主因。快速首屏传 false，联想由前端随后单独补齐。
async fn merge_search_sources(
    app: &tauri::AppHandle,
    state: &AppState,
    filter: &CatalogFilter,
    keyword: &str,
    with_suggestions: bool,
) -> Result<CatalogPage, String> {
    let comic = filter.channel == "comic";
    let dmghg_filter = CatalogFilter {
        keyword: Some(keyword.to_owned()),
        channel: "anime".into(),
        category: "全部".into(),
        ..filter.clone()
    };
    let suggestions_fut = async {
        if with_suggestions {
            crate::short_drama_app::search_suggest(app, keyword, comic).await
        } else {
            Vec::new()
        }
    };
    let (web, suggestions, anime) =
        tokio::join!(state.provider.catalog(filter), suggestions_fut, async {
            state.anime_provider.catalog(&dmghg_filter).await
        },);
    let mut page = web?;
    // 追加顺序 = 网页结果 → 动漫源 → App 联想：主关键词命中优先，动漫是补充
    // 来源，而联想只用来补齐网页漏掉的分季条目，排在最后。
    let mut existing: std::collections::HashSet<String> =
        page.items.iter().map(|item| item.id.clone()).collect();
    let mut added = 0usize;
    // 降级说明只写"确实失败"的来源，且只写给用户看的话（不泄露内部信息，不变量 12）。
    let mut anime_failed = false;
    if let Ok(anime_page) = anime {
        for item in anime_page.items {
            if existing.contains(&item.id) {
                continue;
            }
            existing.insert(item.id.clone());
            page.items.push(item);
            added += 1;
        }
    } else {
        anime_failed = true;
        page.source = format!("{}；动漫来源暂不可用", page.source);
    }
    // App 联想的空列表**不作为降级信号**：联想失败与"这个词本来就没有联想"共用
    // 同一个 Vec（search_suggest 内部吞掉错误），而动漫关键词天生没有 App 联想
    // （联想恒走短剧档），照报就是纯噪音。只在已经有来源真的挂了、且手上确实留住了
    // 结果时补一句"可重试"，让用户知道结果可能不全。
    let suggest_missing = with_suggestions && suggestions.is_empty();
    for suggestion in suggestions {
        let sid = suggestion.id.clone();
        if existing.contains(&sid) {
            continue;
        }
        page.items
            .push(suggestion_to_item(suggestion, filter.channel.as_str()));
        existing.insert(sid);
        added += 1;
    }
    if anime_failed && suggest_missing && !page.items.is_empty() {
        page.source = format!("{}；部分来源暂不可用，可重试", page.source);
    }
    // 降级判定收敛成一个具名布尔，供机器读。`source` 里的文案仍然照旧输出
    // ——用户得知道"哪个来源不可用"，而 `degraded` 只回答"这次结果可不可信"，
    // 两者互补，不该合成一个字段让前端去猜。
    //
    // 只认"来源真的挂了"，不认联想空列表：联想失败与"这个词本来就没有联想"
    // 共用同一个 Vec（search_suggest 内部吞掉错误），把它算进来会把绝大多数
    // 正常搜索标成降级。动漫关键词天生没有 App 联想，那更是恒假。
    let degraded = anime_failed;
    page.degraded = degraded;
    page.total += added;
    Ok(page)
}

#[tauri::command]
async fn catalog_list(
    app: tauri::AppHandle,
    mut filter: CatalogFilter,
    state: State<'_, AppState>,
) -> Result<CatalogPage, String> {
    // 18+ 门闩：受控源被关掉时把 source 置空 → 静默回落红果（理由见 gated_source）。
    filter.source = gated_source(filter.source.as_deref(), adult_sources_allowed(&state));
    if let Some(source) = filter.source.as_deref() {
        if source != "hongguo" {
            return state.guo_provider.catalog(&filter);
        }
    }
    // 动漫专区走独立数据源（暴风资源），不与短剧目录共享链路。
    if filter.channel == "anime" {
        return state.anime_provider.catalog(&filter).await;
    }
    let Some(keyword) = keyword_of(&filter) else {
        warm_theme_routes(&app, filter.page);
        return state.provider.catalog(&filter).await;
    };
    merge_search_sources(&app, &state, &filter, &keyword, true).await
}

/// 搜索的"快速首屏"入口：只跑两个结构化来源，不等 App 联想。
///
/// 联想只是补齐分季条目，首屏不该为它付出一次 Python 冷启动。前端先调这里
/// 把主结果画出来，再调 `catalog_suggest` 把联想追加到尾部。
#[tauri::command]
async fn catalog_fast_search(
    app: tauri::AppHandle,
    mut filter: CatalogFilter,
    state: State<'_, AppState>,
) -> Result<CatalogPage, String> {
    // 同 catalog_list：门闩必须在缓存查表之前跑，否则受控源的搜索结果会以
    // "红果的结果"回到同一个 key 上，切开关后仍能读到缓存里的旧内容。
    filter.source = gated_source(filter.source.as_deref(), adult_sources_allowed(&state));
    if let Some(source) = filter.source.as_deref() {
        if source != "hongguo" {
            return state.guo_provider.catalog(&filter);
        }
    }
    if filter.channel == "anime" {
        return state.anime_provider.catalog(&filter).await;
    }
    let Some(keyword) = keyword_of(&filter) else {
        return state.provider.catalog(&filter).await;
    };
    // 只缓存带关键词的搜索：keyword 为空的那条是纯目录浏览，必须永远拿最新的。
    let cache_key = search_cache_key(&filter, &keyword);
    if let Some(hit) = fast_search_cache().get(&cache_key) {
        return Ok(hit);
    }
    let page = merge_search_sources(&app, &state, &filter, &keyword, false).await?;
    fast_search_cache().put(cache_key, page.clone());
    Ok(page)
}

/// 只跑 App 搜索联想，返回可直接追加到结果尾部的条目。
///
/// 单独成一个命令是为了让它脱离首屏的关键路径（原因见 `merge_search_sources`）。
/// 失败返回空数组：它是锦上添花的补充来源，不该让整次搜索报错。
#[tauri::command]
async fn catalog_suggest(
    app: tauri::AppHandle,
    keyword: String,
    channel: String,
) -> Result<Vec<SeriesItem>, String> {
    let keyword = keyword.trim().to_owned();
    if keyword.is_empty() {
        return Ok(Vec::new());
    }
    let comic = channel == "comic";
    let cache_key = suggest_cache_key(&keyword, &channel);
    if let Some(hit) = suggest_cache().get(&cache_key) {
        return Ok(hit);
    }
    // 联想失败与"没有联想"都得到空列表，这里一并缓存：前端在首屏之后还会对同一个
    // 词再调一次，省下的正是那次 Python 冷启动（实测 0.6-1.9s）。代价是词源临时
    // 不可用时空结果会挂 5 分钟，但用户多半已经看到完整首屏。
    let items: Vec<SeriesItem> = crate::short_drama_app::search_suggest(&app, &keyword, comic)
        .await
        .into_iter()
        .map(|suggestion| suggestion_to_item(suggestion, channel.as_str()))
        .collect();
    suggest_cache().put(cache_key, items.clone());
    Ok(items)
}

/// 全站题材词表：题材栏的完整来源。
///
/// 目录分页只有一页 24 条，按页取词表会让题材栏随翻页/筛选变来变去，也拿不到
/// 全站题材。这里由后端汇总全站索引后给出稳定全集；首次调用要建索引（约数秒），
/// 前端应在首屏渲染完成后后台调用，不要挡住卡片。
#[tauri::command]
async fn catalog_categories(
    channel: String,
    source: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    // 题材词表同样会命中 18+ 源（"AI 短剧""国漫"这些分类名本身就是成人源的），
    // 门闩漏在这里的话，受控源的题材词表会一直躺在前端题材栏里。
    let source = gated_source(source.as_deref(), adult_sources_allowed(&state));
    if let Some(source) = source.as_deref() {
        if source != "hongguo" {
            return state.guo_provider.categories(source);
        }
    }
    // 动漫专区是独立数据源，不参与红果目录索引。
    if channel == "anime" {
        return Ok(Vec::new());
    }
    state.provider.catalog_categories(&channel).await
}

#[tauri::command]
async fn anime_qualities(
    series_id: String,
    episode_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<crate::models::VideoQualityOption>, String> {
    if crate::guo_provider::is_guo_id(&series_id) {
        // 画质探测内部会真起一次 resolve（拿完档位就 release），它拿得到的是
        // 这一集的档位元信息，所以按"直达"口径报错而不是回落。
        ensure_series_source_allowed(&series_id, &state)?;
        return state.guo_provider.qualities(&series_id, &episode_id);
    }
    state
        .anime_provider
        .qualities(&series_id, &episode_id)
        .await
}

/// guo 源的封面解析：返回本地缓存文件路径（前端 convertFileSrc 后呈现）。
///
/// 必须是 async —— cover 下载在 guo-core 侧最长 25 秒（首次还要过源站传输层、
/// 解密、校验），同步命令跑在主线程上会把窗口整个卡住。async 命令在异步运行时
/// 线程池里执行，阻塞的是那把 guo bridge 锁，而不是 UI。
#[tauri::command]
async fn guo_cover(
    series_id: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    // 封面也是内容：这条命令会带着源侧 Referer 去站点把图**下载到本地缓存**。
    // 门闩漏在这里的表现最隐蔽——目录和详情都挡住了，列表里却还有一排 18+
    // 缩略图（很可能是用户上次开着开关时留下的缓存图），等于没关。
    ensure_series_source_allowed(&series_id, &state)?;
    state.guo_provider.cover(&series_id)
}

/// 19 个 guo 源的站源任务/健康度状态（go 侧 `nativeSourceStatus`，原样透传）。
///
/// 逐个源查而不是让 go 侧一次返回全部：`sourceStatus` 只吃一个 source。
/// 它是纯内存读、不联网，19 次 FFI 都是微秒级，同步也不会卡窗口。
///
/// 入参用 `AppHandle` 而不是 `State<'_, AppState>`：Tauri 规定"参数里带引用的
/// 异步命令必须返回 `Result`"，而这里的返回类型是前端契约定死的 `Vec<Value>`
/// （不能是 `Result`，否则前端就得 try/catch 一个永远不会失败的值）。`AppHandle`
/// 本身是 `'static` 的值、不带生命周期，正好绕开这条限制。
#[tauri::command]
async fn guo_source_status(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    app.state::<AppState>().guo_provider.source_status_all()
}

/// 源健康检查：起 `sourceJob`（`check` = 五步链路）并轮询到任务落地。
///
/// `sourceJob` 是**异步起任务**：go 侧 `startSourceTask` 登记完就
/// `go runSourceTask(...)`，回给我们的只是 `running: true` 的初始状态；真正的
/// 结果只能靠再查 `sourceStatus` 拿（`checkSource` 每跑完一步 publish 一次，
/// `health.steps` 增量长出来，`running` 转 false 才是终态）。所以这里 1s 一次
/// 轮询，最多 200 次（≈3 分 20 秒，比 go 侧 3 分钟的任务超时多留余量），等待用
/// tokio 的 sleep 而不是 `thread::sleep`，不占住 async 执行器的 worker。
/// 每轮都重新取一次 state，那把 `State` 借用不跨 `.await`。
///
/// 失败不返回 Err，统一包成带 `error` 的 Value：健康检查是"点一下看个结果"的
/// 辅助操作，让它把整次 IPC 变成异常，前端反而更难写 UI。
#[tauri::command]
async fn guo_source_check(source: String, app: tauri::AppHandle) -> serde_json::Value {
    if let Err(error) = app.state::<AppState>().guo_provider.source_check(&source) {
        return serde_json::json!({ "error": error });
    }
    let mut status = serde_json::Value::Null;
    for _ in 0..200 {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        // 起锁在任何 await 之前就放掉了：那把 guo bridge 锁是全局单锁，
        // 持锁等 1s 会把所有其它 guo 调用一起堵住。
        let polled = app.state::<AppState>().guo_provider.source_status(&source);
        match polled {
            Ok(value) => {
                let settled = crate::guo_provider::source_settled(&value);
                status = value;
                if settled {
                    return status;
                }
            }
            Err(error) => return serde_json::json!({ "error": error }),
        }
    }
    // 3 分钟还没落地：把当前这份（`running` 仍为 true、`steps` 可能只走了一半）
    // 交回去，前端按 `running` 判断是"还在跑"还是"已结束"。
    status
}

/// guo 源的网络模式：`direct` 直连 / `auto` 跟随系统代理。
///
/// 这是设置页「站源网络」开关的后端。真实状态存放在 guo-core 自己的
/// resource-settings.json（saveResourceSettings 热应用 + 持久化），TTV 侧不存
/// 第二份——否则两份状态必然漂移。
#[tauri::command]
async fn guo_proxy_get(app: tauri::AppHandle) -> Result<String, String> {
    app.state::<AppState>().guo_provider.proxy_mode()
}

#[tauri::command]
async fn guo_proxy_set(mode: String, app: tauri::AppHandle) -> Result<(), String> {
    app.state::<AppState>().guo_provider.set_proxy_mode(&mode)
}

#[tauri::command]
async fn series_detail(
    series_id: String,
    channel: Option<String>,
    state: State<'_, AppState>,
) -> Result<SeriesDetail, String> {
    if crate::guo_provider::is_guo_id(&series_id) {
        // 按 id 直达：剧集已经在手上了，回落红果只会拿一部同 id 的别的剧，
        // 所以这里必须报错。
        ensure_series_source_allowed(&series_id, &state)?;
        return state.guo_provider.detail(&series_id);
    }
    // 动漫项按 id 前缀判定，而不是只看 channel：前端的 channelBySeriesId 是内存
    // Map，页面重载 / HMR 后为空（从收藏、历史进入时也不会填），此时 channel 缺失，
    // 动漫 id 会掉进普通短剧链路——`dmghg:` 那种会被 provider 的数字 id 校验拒掉，
    // 表现为「剧集 ID 无效。」；而暴风的裸数字 id 会**通过**校验，进而撞号查到红果
    // 同 id 的剧，实测表现为「标题是别人的、共 0 集全、选集全空」（比直接报错更难查）。
    // id 本身已经携带来源（`dmghg:` / `bfzy:`），用它判定最稳。
    if channel.as_deref() == Some("anime") || crate::anime_provider::is_anime_id(&series_id) {
        return state.anime_provider.detail(&series_id).await;
    }
    state.provider.detail(&series_id, channel.as_deref()).await
}

#[tauri::command]
async fn playback_open(
    input: PlaybackOpenInput,
    state: State<'_, AppState>,
) -> Result<PlaybackSession, String> {
    if crate::guo_provider::is_guo_id(&input.series_id) {
        // **整个门闩最重要的一条**：这是"绕过目录、直接按 id 取流"的入口。
        // 前端过滤、源选择器、神秘小窝 tab 全是 UI 层的，命令行里一次
        // `invoke('playback_open', {input:{seriesId:'guo:dsd:…'}})` 就能绕开
        // 它们全部——目录被挡住时用户手里仍然可能攥着一条旧 id（历史、收藏、
        // 复制来的链接），那正是这条命令存在的理由。
        ensure_series_source_allowed(&input.series_id, &state)?;
        let session = state.guo_provider.open_episode(
            input.session_id,
            &input.series_id,
            &input.episode_id,
            &input.quality,
            input.position,
        )?;
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "播放会话锁不可用。".to_string())?;
        sessions.retain(|id, _| *id >= session.session_id.saturating_sub(8));
        sessions.insert(session.session_id, session.clone());
        return Ok(session);
    }
    // 动漫播放走动漫源直链（m3u8 与非 https 经本地 HLS 代理），不经红果 worker。
    // 同样按 id 前缀兜底：前端 isAnime 来自 detail.type，链条上任一环缺失就会漏判。
    if input.is_anime || crate::anime_provider::is_anime_id(&input.series_id) {
        let session = state
            .anime_provider
            .open_episode(
                input.session_id,
                &input.series_id,
                &input.episode_id,
                input.position,
                &input.quality,
            )
            .await?;
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "播放会话锁不可用。".to_string())?;
        sessions.retain(|id, _| *id >= session.session_id.saturating_sub(8));
        sessions.insert(session.session_id, session.clone());
        return Ok(session);
    }
    let session = state
        .provider
        .open_episode(
            input.session_id,
            &input.series_id,
            &input.episode_id,
            &input.quality,
            input.position,
        )
        .await?;
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "播放会话锁不可用。".to_string())?;
    sessions.retain(|id, _| *id >= session.session_id.saturating_sub(8));
    sessions.insert(session.session_id, session.clone());
    Ok(session)
}

#[tauri::command]
fn playback_command(
    session_id: u64,
    action: String,
    _payload: Option<serde_json::Value>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if action == "stop" {
        state.guo_provider.release(session_id);
    }
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "播放会话锁不可用。".to_string())?;
    if sessions.contains_key(&session_id) {
        Ok(())
    } else {
        Err("播放会话已过期，请重新打开剧集。".into())
    }
}

#[tauri::command]
fn playback_snapshot(
    session_id: u64,
    state: State<'_, AppState>,
) -> Result<PlaybackSnapshot, String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "播放会话锁不可用。".to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "播放会话已过期，请重新打开剧集。".to_string())?;
    Ok(PlaybackSnapshot {
        session_id,
        state: PlaybackUiState {
            kind: "opening".into(),
            session_id,
        },
        position: session.position,
        duration: 0.0,
        buffered: 0.0,
        volume: 1.0,
        muted: false,
        playback_rate: 1.0,
    })
}

#[tauri::command]
fn external_player_open(url: String) -> Result<(), String> {
    let url = url.trim();
    if !url.starts_with("https://") {
        return Err("播放地址无效。".into());
    }
    let candidates = [
        std::env::var_os("TTV_BOX_MPV").map(PathBuf::from),
        Some(PathBuf::from("src-tauri/resources/mpv/mpv.exe")),
    ];
    let player = candidates
        .into_iter()
        .flatten()
        .find(|path| path.is_file())
        .or_else(|| Some(PathBuf::from("mpv.exe")))
        .ok_or_else(|| "未找到兼容播放器 mpv。".to_string())?;
    let mut command = Command::new(player);
    command.args([
        "--no-config",
        "--force-window=yes",
        "--keep-open=no",
        "--http-header-fields=Referer: https://novel.snssdk.com/,User-Agent: com.phoenix.read/71332",
        url,
    ]);
    // CREATE_NO_WINDOW：外部播放器由用户手势触发，但 GUI 子系统下 mpv.com
    // 兼容层与宿主仍可能闪终端窗口，后台创建标志一并抑制。
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    command
        .spawn()
        .map_err(|error| format!("启动兼容播放器失败：{error}"))?;
    Ok(())
}

#[tauri::command]
fn history_list(state: State<'_, AppState>) -> Result<Vec<WatchHistoryItem>, String> {
    state.database.list_history()
}

/**
 * 进全屏前，**静默**解除窗口的最大化状态。
 *
 * ## 为什么需要这个命令（而不是直接调 unmaximize）
 *
 * 窗口处于最大化时进全屏会出错：tao（wry 0.35 的 `window.rs`，WM_NCCALCSIZE 分支）
 * 为了保证"无边框窗口最大化时不盖住任务栏"，会把**仍是最大化状态**的窗口客户区
 * 裁到工作区（屏幕减任务栏）。而 `set_fullscreen` 只改全屏标记、从不清除最大化，
 * 于是用户看到"进了全屏，任务栏还在、画面没铺满"。
 *
 * 解除最大化确实能解决它，但 tao 的 `set_maximized(false)` 走的是
 * `ShowWindow(SW_RESTORE)`——**带系统还原动画**，窗口会先缩回原始尺寸再撑成全屏，
 * 用户看到的就是"进全屏时回弹一下"，观感很怪。
 *
 * 这里改用 `SetWindowPlacement`：把显示状态改回 `SW_SHOWNORMAL`，同时把
 * "常规位置"设成**当前（最大化时的）矩形**。窗口因此原地不动、无动画，只是不再
 * 处于最大化状态——tao 的裁切随之失效，紧接着的 `set_fullscreen(true)` 就能
 * 一步铺满整屏。
 */
#[cfg(windows)]
#[tauri::command]
fn window_prepare_fullscreen(window: tauri::Window) -> Result<bool, String> {
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, GetWindowPlacement, GetWindowRect, SetWindowLongPtrW,
        SetWindowPlacement, SetWindowPos, GWL_STYLE, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOSIZE, SWP_NOZORDER, SW_MAXIMIZE, SW_SHOWNORMAL, WINDOWPLACEMENT, WS_MAXIMIZE,
    };

    let hwnd: HWND = window.hwnd().map_err(|error| error.to_string())?.0;

    unsafe {
        let mut placement = WINDOWPLACEMENT {
            length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
            ..Default::default()
        };
        if GetWindowPlacement(hwnd, &mut placement) == 0 {
            return Err("读取窗口位置失败。".into());
        }
        // 没最大化就不用管（例如窗口本来就只是普通尺寸）。
        if placement.showCmd != SW_MAXIMIZE as u32 {
            return Ok(false);
        }

        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return Err("读取窗口矩形失败。".into());
        }

        // 1) 摘掉 WS_MAXIMIZE：窗口不再是"最大化窗口"，tao 的任务栏裁切随之失效。
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        SetWindowLongPtrW(hwnd, GWL_STYLE, style & !(WS_MAXIMIZE as isize));

        // 2) 显示状态改回普通，但"常规位置"保持当前矩形——窗口原地不动，无动画。
        placement.showCmd = SW_SHOWNORMAL as u32;
        placement.rcNormalPosition = rect;
        if SetWindowPlacement(hwnd, &placement) == 0 {
            return Err("应用窗口位置失败。".into());
        }

        // 3) 让非客户区重新计算：客户区立刻按"非最大化"的规则铺满，不必等下一次窗口变化。
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
    Ok(true)
}

#[cfg(not(windows))]
#[tauri::command]
fn window_prepare_fullscreen(_window: tauri::Window) -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
fn history_save(item: WatchHistoryItem, state: State<'_, AppState>) -> Result<(), String> {
    state.database.save_history(&item)
}

#[tauri::command]
fn history_remove(series_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.database.remove_history(&series_id)
}

#[tauri::command]
fn history_clear(state: State<'_, AppState>) -> Result<(), String> {
    state.database.clear_history()
}

#[tauri::command]
fn favorites_list(
    mark: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<FavoriteItem>, String> {
    state.database.list_favorites(mark.as_deref())
}

#[tauri::command]
fn favorites_save(item: FavoriteItem, state: State<'_, AppState>) -> Result<(), String> {
    state.database.save_favorite(&item)
}

#[tauri::command]
fn favorites_remove(series_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.database.remove_favorite(&series_id)
}

#[tauri::command]
fn settings_get(state: State<'_, AppState>) -> Result<UserSettings, String> {
    state.database.settings_get()
}

/// 清洗用户勾选的启用源列表：去空白、去重、丢弃未知 id，全空时回落到红果。
///
/// 未知 id 必须丢掉：源表在前端（`services/guoSources.ts`），后端不认这些名字，
/// 但脏 id 会一路存进 SQLite 并被前端当源发出去，最后变成一批永远失败的请求。
/// 全空回落红果而不是存空列表——否则用户会得到一个"没有任何请求"的空目录。
fn normalize_enabled_sources(input: &[String]) -> Vec<String> {
    let mut known: Vec<String> = Vec::new();
    for id in input {
        let id = id.trim();
        let exists = guo_provider::GUO_SOURCES
            .iter()
            .any(|source| source.id == id);
        if exists && !known.iter().any(|seen| seen == id) {
            known.push(id.to_owned());
        }
    }
    if known.is_empty() {
        known.push("hongguo".to_string());
    }
    known
}

/// 总开关关闭时，把 18+ 源从启用列表里剔除。
///
/// 为什么必须在**写入**时剔除，而不只靠运行期守卫：`enabledSources` 是持久化
/// 18+ 启用状态**刻意不在这里剔除**（曾经剔除过，语义不对，已撤回）。
///
/// 剔除看起来更"干净"：开关关着就不该留下"帝果已启用"这个自相矛盾的组合。
/// 但设置页的设计决策是**关闭总开关时把 18+ 那组置灰、而不是静默取消已勾选项**
/// ——用户回来重新开启时不该发现自己的选择被吃掉了。取消勾选是一次用户没要求的
/// 数据丢失，置灰只是"现在不能用"。
///
/// 更关键的是：留一个源 id 在磁盘上**不构成内容泄露**。门闩拦的是内容本身
/// （`gated_source` / `ensure_series_source_allowed` 按请求裁决），磁盘上存着
/// "用户曾经授权过帝果"这个事实，既拿不到目录也开不了流。
///
/// 顺序上仍然要排在 `normalize_enabled_sources` 之前的是另一件事：去重与丢弃
/// 未知 id（全空时回落到红果，否则会存下一个"零可用源"的设置）。
#[tauri::command]
fn settings_save(mut settings: UserSettings, state: State<'_, AppState>) -> Result<(), String> {
    // 用户可控项：倒计时与目标帧率做区间夹取。
    settings.countdown_seconds = settings.countdown_seconds.clamp(3, 15);
    settings.target_fps = settings.target_fps.clamp(30, 120);
    // 能力受限项：如实归零而非静默接受。
    // - 清晰度：公开网页与 App 源都只有单一路径，多档位是幻影，强制 auto。
    // - 增强引擎：未接入真实补帧 SDK，只支持 off。
    // - 缓存读数：当前不做字节级统计，报 0 而不是编造数字。
    // 这些是"诚实报告边界"，不是丢弃用户输入——相应开关在 UI 上也不提供。
    settings.default_quality = "auto".into();
    settings.preferred_engine = "off".into();
    settings.catalog_cache_mb = 0.0;
    settings.playback_cache_mb = 0.0;
    // 启用源列表：去重 + 丢弃未知 id（源表在前端，后端不认也得挡住脏 id 进库），
    // 全空时回落到红果，否则用户会存下一个"零可用源"的设置。
    // ⚠️ 这里**不**剔除 18+ 源：设置页的设计决策是关闭总开关时置灰而非取消勾选，
    // 内容侧的拦截由 `gated_source` / `ensure_series_source_allowed` 按请求负责。
    settings.enabled_sources = normalize_enabled_sources(&settings.enabled_sources);
    state.database.settings_save(&settings)
}

/// 清空缓存（设置页按钮）。
///
/// 这里曾经只清 AppState::cache_dir（即 <.app-data>/cache）——那是本应用自己的
/// 目录，而**剧集视频实际由 worker 写在 <data_dir>/short-drama-cache**，
/// 两者不是同一个位置。结果是「一键释放缓存」永远报 0 MB，而真正占地的 2GB+
/// 视频文件从未被触及。现在改为委托给 short_drama_app_cache_clear，
/// 由它清理真实的剧集缓存并返回释放量。
#[tauri::command]
fn cache_clear(state: State<'_, AppState>) -> Result<CacheClearResult, String> {
    // 应用自有缓存目录（SQLite 快照等）一并清理。
    let own = clear_directory(&state.cache_dir).unwrap_or(0);
    let report = short_drama_app_cache_clear()?;
    Ok(CacheClearResult {
        freed_mb: (own + report.freed_bytes) as f64 / 1024.0 / 1024.0,
    })
}

fn clear_directory(path: &Path) -> Result<u64, String> {
    if !path.exists() {
        fs::create_dir_all(path).map_err(|error| error.to_string())?;
        return Ok(0);
    }
    let mut total = 0;
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let entry_path = entry.path();
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        if metadata.is_dir() {
            total += clear_directory(&entry_path)?;
            fs::remove_dir(&entry_path).map_err(|error| error.to_string())?;
        } else {
            total += metadata.len();
            fs::remove_file(&entry_path).map_err(|error| error.to_string())?;
        }
    }
    Ok(total)
}

/// 应用数据根目录（SQLite / 剧集缓存 / WebView2 user-data 共用）。
///
/// 默认 Tauri 的 `app_data_dir()` 在 Windows 上是
/// `C:\Users\<user>\AppData\Roaming\<identifier>`。但当系统盘写满时，
/// 在那里创建 SQLite 库会直接以 `disk I/O error` 让 setup 钩子 panic，
/// 应用连窗口都起不来；WebView2 也会因为写不进 GPU/着色器缓存而整片黑屏。
///
/// 因此这里改用"可执行文件所在盘"作为根目录：exe 位于
/// `<crate>/target/debug/ttv-short-drama.exe`，回退两级即 crate 根目录，
/// 最终数据落在 `<crate>/.app-data/`（开发态通常空间充足）。
/// 只有该位置不可写时才退回系统默认目录。
fn app_storage_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    // 只有 **cargo 构建产物**（<crate>/src-tauri/target/{debug,release}/）才把数据
    // 放在项目内，方便开发期查看与清理。
    //
    // 旧实现无条件向上回退两级，注释假设 exe 位于 "<crate>/target/debug"，
    // 但真实布局是 "<crate>/src-tauri/target/debug"，于是回退两级得到的是
    // **src-tauri/target** 的父目录；而打包安装后 exe 位于安装目录，回退两级
    // 会落到 %LOCALAPPDATA% 或 Program Files 的上一级，在那里凭空创建
    // ".app-data"（实测落在 %APPDATA%\..\.app-data），SQLite、剧集缓存与
    // WebView2 用户数据全部被塞进这个非标准位置。
    // 现在：非 cargo 构建一律返回 None，由调用方回退到 Tauri 的 app_data_dir()。
    let is_cargo_target = exe_dir
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == "debug" || name == "release")
        && exe_dir
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == "target");
    if is_cargo_target {
        if let Some(crate_dir) = exe_dir.parent().and_then(Path::parent) {
            let candidate = crate_dir.join(".app-data");
            if std::fs::create_dir_all(&candidate).is_ok() {
                return Some(candidate);
            }
        }
    }
    None
}

/// 配置 WebView2 启动参数。
///
/// 两件事：
/// 1. 确保开启 `PlatformHEVCDecoderSupport` —— 没有它，HEVC 源流无法播放。
/// 2. 剔除 `--disable-gpu-compositing` —— 那是当年 C 盘写满导致黑屏时的兜底，
///    如今 user-data 已迁到可写盘、根因消除；而它会把渲染与解码压回软件路径，
///    既让 30 处 backdrop-blur 异常昂贵，也会让平台 HEVC 硬解走不通。
///    保留用户/脚本传入的其他参数，只做追加与剔除，不整体覆盖。
fn configure_webview_browser_arguments() {
    const HEVC_FEATURE: &str = "PlatformHEVCDecoderSupport";
    let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();

    // 保留有效参数，丢弃已过时的软件光栅开关。
    let mut kept: Vec<String> = existing
        .split_whitespace()
        .filter(|arg| *arg != "--disable-gpu-compositing")
        .map(str::to_string)
        .collect();

    // 合并 --enable-features：保留他人已启用的特性，追加 HEVC 支持。
    let feature_index = kept
        .iter()
        .position(|arg| arg.starts_with("--enable-features="));
    match feature_index {
        Some(index) => {
            let current = kept[index].clone();
            if !current.contains(HEVC_FEATURE) {
                kept[index] = format!("{current},{HEVC_FEATURE}");
            }
        }
        None => kept.push(format!("--enable-features={HEVC_FEATURE}")),
    }

    let merged = kept.join(" ");
    eprintln!("[ttv] WebView2 启动参数：{merged}");
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", merged);
}

/// 为当前进程申请"高性能 GPU"（Windows 图形首选项）。
///
/// ## 为什么需要它
///
/// 本机是 **AMD Radeon 610M（核显）+ NVIDIA GeForce RTX 5060 Laptop** 的双显卡
/// 笔记本，Windows 默认按省电策略把非游戏进程交给核显。而 **RTX 视频增强（VSR）
/// 是 NVIDIA 驱动侧的功能**：进程跑在核显上时它根本不会被挂载，用户看到的就是
/// "同一个驱动设置，这个播放器不生效、别的播放器生效"。
///
/// 这条链路在 0.2.5 随补帧一起被删掉过，后果很隐蔽：开发态（exe 在
/// `target/debug`）因为注册表里**留有旧条目**照常走独显，而打包安装后的 exe
/// （`%LOCALAPPDATA%\TTV Short Drama`）**没有任何首选项**——于是"开发时能用、
/// 装完就没了"。实测本机注册表里只有 debug 那一条：
///
/// ```text
/// D:\...\src-tauri\target\debug\ttv-short-drama.exe = GpuPreference=2;
/// ```
///
/// ## 边界
///
/// - 只写 `HKCU`（当前用户），不需要管理员权限；幂等，值相同则不重复写。
/// - 失败一律静默：首选项缺失只影响画质增强，不该让应用起不来。
/// - 首选项在**进程启动时**读取，写入后需要重启应用才生效；这里只在真正需要
///   改动的首次运行写一次，并在日志里说明。
#[cfg(windows)]
fn apply_windows_gpu_preference() {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_SZ,
    };

    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let Some(exe_text) = exe.to_str() else {
        return;
    };
    // 值与值名都必须是 NUL 结尾的 UTF-16。
    let exe_name: Vec<u16> = exe_text.encode_utf16().chain(std::iter::once(0)).collect();
    let sub_key: Vec<u16> = "Software\\Microsoft\\DirectX\\UserGpuPreferences"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    // GpuPreference=2 = "高性能"（独显）。
    let value: Vec<u16> = "GpuPreference=2;"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        let mut key: windows_sys::Win32::System::Registry::HKEY = std::ptr::null_mut();
        let status = RegCreateKeyExW(
            HKEY_CURRENT_USER,
            sub_key.as_ptr(),
            0,
            std::ptr::null_mut(),
            0,
            KEY_SET_VALUE,
            std::ptr::null(),
            &mut key,
            std::ptr::null_mut(),
        );
        if status != 0 {
            eprintln!("[ttv] 图形首选项：打开注册表键失败（{status}），跳过");
            return;
        }
        let bytes = std::slice::from_raw_parts(value.as_ptr() as *const u8, value.len() * 2);
        let status = RegSetValueExW(
            key,
            exe_name.as_ptr(),
            0,
            REG_SZ,
            bytes.as_ptr(),
            bytes.len() as u32,
        );
        let _ = RegCloseKey(key);
        if status == 0 {
            eprintln!("[ttv] 图形首选项：已为当前 exe 申请高性能 GPU（RTX 视频增强依赖独显，下次启动生效）");
        } else {
            eprintln!("[ttv] 图形首选项：写入失败（{status}），跳过");
        }
    }
}

#[cfg(not(windows))]
fn apply_windows_gpu_preference() {}

fn main() {
    // 历史背景：系统盘写满时，WebView2 写不了 GPU/着色器缓存 → 合成管线初始化失败
    // → 窗口内容区整片纯黑。当时用 `--disable-gpu-compositing` 兜底，但那会让全部
    // 渲染退回 CPU 软件光栅；而界面大量使用 `backdrop-blur`（30 处），软件高斯模糊
    // 极其昂贵——实测首页静止时 WebView2 仍持续占用约 50% 单核，表现为明显卡顿。
    //
    // 黑屏的真正根因是"缓存写不进去"，而 WebView2 的 user-data（含 GPU/着色器缓存）
    // 现已迁到空间充足的盘（见下方 WEBVIEW2_USER_DATA_FOLDER），根因已消除，
    // 因此不再禁用 GPU 合成，让 blur 走硬件加速。
    if let Some(data_dir) = app_storage_root().map(|root| root.join("webview-data")) {
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &data_dir);
    }
    // 允许 WebView2 使用系统平台解码器解 HEVC。
    //
    // 播放失败的根因：App-API 返回的源流是 HEVC(H.265)/hvc1（实测短剧 1080x1920、
    // 漫剧 1920x1080，缓存里每一集都是），而 Chromium 内核默认关闭 HEVC 解码，
    // HTML5 <video> 直接报错 —— 界面上表现为"该媒体无法由 WebView 解码"。
    // 本机已安装 Microsoft.HEVCVideoExtension，打开这个特性开关即可复用系统解码器，
    // 无需把每集转码成 H.264（转码会耗时 20s+/集、体积膨胀约 2.5 倍）。
    configure_webview_browser_arguments();
    // 让本进程走独显：RTX 视频增强（VSR）只在 NVIDIA 显卡渲染的视频上生效。
    apply_windows_gpu_preference();

    tauri::Builder::default()
        .setup(|app| {
            // AppState 的 SQLite 与剧集缓存也落在同一个可写根目录下。
            let app_dir = app_storage_root().unwrap_or_else(|| {
                app.path()
                    .app_data_dir()
                    .unwrap_or_else(|_| std::env::temp_dir().join("ttv-short-drama"))
            });
            fs::create_dir_all(&app_dir).map_err(|error| error.to_string())?;
            let cache_dir = app_dir.join("cache");
            fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;
            let provider = DramaProvider::new()?;
            let anime_provider = crate::anime_provider::AnimeProvider::new()?;
            let resource_dir = app
                .path()
                .resource_dir()
                .unwrap_or_else(|_| app_dir.join("resources"));
            let guo_provider = crate::guo_provider::GuoProvider::new(&resource_dir, &app_dir)?;
            // guo 源的封面由 guo-core 下载到 `<app_dir>/guo-core/covers-v1` 后经
            // asset 协议呈现：dev 态这个目录在项目内（.app-data），不在默认的
            // `$APPLOCALDATA` scope 里，不显式放行生产/dev 两端都会 403。
            let _ = app
                .asset_protocol_scope()
                .allow_directory(app_dir.join("guo-core"), true);
            let database = Database::open(&app_dir.join("short-drama.sqlite3"))?;
            app.manage(AppState {
                provider,
                anime_provider,
                guo_provider,
                database,
                sessions: Mutex::new(HashMap::new()),
                cache_dir,
            });

            // 画中画小窗的交接状态：窗口按需创建，状态随进程存活。
            app.manage(crate::pip::PipState::default());

            // 主窗口关闭 = 退出应用：小窗是同进程里的另一个窗口，不跟着收掉就会
            // 留下一个没有落点的悬浮窗（Tauri 要等最后一个窗口关闭才退出进程）。
            if let Some(main_window) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                main_window.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                        crate::pip::dismiss_on_main_close(&handle);
                    }
                });
            }

            // 动漫专区 HLS 本地代理：随应用启动（幂等），m3u8/ts 全部经它转发。
            tauri::async_runtime::spawn(async {
                match crate::hls_proxy::start().await {
                    Ok(port) => eprintln!("[ttv] HLS 代理已启动: 127.0.0.1:{port}"),
                    Err(error) => eprintln!("[ttv] HLS 代理启动失败: {error}"),
                }
            });

            // 启动即自动整理缓存，无需用户确认。
            //
            // 处理三件事：清掉 worker 中断留下的半成品、删除超过保留期（7 天）
            // 的陈旧剧集、并把总占用压回全局预算（1GB）内。放在独立线程里执行，
            // 避免在缓存很大时拖慢窗口创建（首次启动可能要删掉上 GB 文件）。
            std::thread::spawn(|| {
                let report = short_drama_app::auto_clean_cache_on_start();
                if report.removed_files > 0 {
                    eprintln!(
                        "[ttv] 缓存自动清理：删除 {} 个剧集，释放 {:.1} MB",
                        report.removed_files,
                        report.freed_bytes as f64 / 1024.0 / 1024.0
                    );
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            catalog_list,
            catalog_fast_search,
            catalog_suggest,
            catalog_categories,
            guo_cover,
            guo_source_status,
            guo_source_check,
            guo_proxy_get,
            guo_proxy_set,
            anime_qualities,
            series_detail,
            playback_open,
            playback_command,
            playback_snapshot,
            external_player_open,
            short_drama_app_status,
            short_drama_app_set_device,
            short_drama_app_resolve,
            short_drama_app_cache_clear,
            short_drama_app_cache_usage,
            short_drama_app_stream,
            short_drama_app_qualities,
            short_drama_app_album,
            short_drama_app_prefetch_stream,
            short_drama_app_episode_counts,
            history_list,
            history_save,
            history_remove,
            history_clear,
            favorites_list,
            favorites_save,
            favorites_remove,
            window_prepare_fullscreen,
            settings_get,
            settings_save,
            cache_clear,
            pip_open,
            pip_handoff,
            pip_report,
            pip_close,
            pip_dismiss,
            pip_is_open,
            update_check,
            update_download,
            update_reveal,
            app_version,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run TTV Short Drama");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一个空页：命中/过期判定只看存进去的是什么值，不看内容是否合理。
    fn fake_page(source: &str) -> CatalogPage {
        CatalogPage {
            items: Vec::new(),
            total: 0,
            has_more: false,
            page: 1,
            categories: Vec::new(),
            next_cursor: None,
            source: source.to_owned(),
            degraded: false,
        }
    }

    fn fake_filter() -> CatalogFilter {
        CatalogFilter {
            channel: "drama".into(),
            source: None,
            category: "全部".into(),
            audience: "全部".into(),
            sort: "hot".into(),
            keyword: Some("战神".into()),
            page: 1,
            page_size: 24,
            cursor: None,
        }
    }

    #[test]
    fn search_cache_hit_returns_stored_value() {
        let cache: SearchCache<CatalogPage> = SearchCache::new(Duration::from_secs(300));
        cache.put("k".into(), fake_page("第一次"));
        assert_eq!(
            cache.get("k").map(|page| page.source).as_deref(),
            Some("第一次")
        );
        // 同 key 再写再读，读到的是后写入的那份，说明第二次没有重跑上游。
        cache.put("k".into(), fake_page("第二次"));
        assert_eq!(
            cache.get("k").map(|page| page.source).as_deref(),
            Some("第二次")
        );
    }

    #[test]
    fn search_cache_key_isolates_source_channel_and_page() {
        let mut filter = fake_filter();
        let base = search_cache_key(&filter, "战神");

        let mut other = filter.clone();
        other.source = Some("guo_x".into());
        assert_ne!(
            search_cache_key(&other, "战神"),
            base,
            "source 不同必须换 key"
        );

        let mut other = filter.clone();
        other.channel = "comic".into();
        assert_ne!(
            search_cache_key(&other, "战神"),
            base,
            "channel 不同必须换 key"
        );

        filter.page = 2;
        assert_ne!(
            search_cache_key(&filter, "战神"),
            base,
            "page 不同必须换 key"
        );

        assert_ne!(
            search_cache_key(&filter, "战神的哥哥"),
            base,
            "关键词不同必须换 key"
        );
    }

    #[test]
    fn enabled_sources_drop_unknown_ids_and_duplicates() {
        let input = vec![
            "hongguo".to_string(),
            " heguo ".to_string(),
            "hongguo".to_string(),
            "不存在的源".to_string(),
            "".to_string(),
        ];
        // 顺序保留首个出现的位置；未知 id 与空白项直接丢弃。
        assert_eq!(
            normalize_enabled_sources(&input),
            vec!["hongguo".to_string(), "heguo".to_string()]
        );
    }

    #[test]
    fn enabled_sources_fall_back_to_hongguo_when_all_rejected() {
        // 全是脏 id / 空串时不能存成空列表：那会让前端一个源都不请求，首页全空。
        let input = vec!["不存在".to_string(), "  ".to_string()];
        assert_eq!(
            normalize_enabled_sources(&input),
            vec!["hongguo".to_string()]
        );
        assert_eq!(normalize_enabled_sources(&[]), vec!["hongguo".to_string()]);
    }

    /// 目录/搜索类入口的门闩：受控源被关掉时**静默回落红果**（置空 source），
    /// 而不是报错。
    #[test]
    fn gated_source_falls_back_to_hongguo_instead_of_failing() {
        // 总开关关闭 + 18+ 源 → 置空，调用方据此走红果官网链路。
        for source in [
            "dsd",
            "huangdou",
            "huangju",
            "yeguo",
            "huangguoai",
            "huangguo-video",
        ] {
            assert_eq!(
                gated_source(Some(source), false),
                None,
                "{source} 被关掉时应静默回落，不能带着它继续打 guo-core"
            );
        }
        // 总开关开启 → 原样透传。
        assert_eq!(gated_source(Some("dsd"), true), Some("dsd".to_owned()));
        // 常规源（红果自己、其余 guo 源）两种状态下都不受影响。
        assert_eq!(
            gated_source(Some("hongguo"), false),
            Some("hongguo".to_owned())
        );
        assert_eq!(gated_source(Some("heguo"), false), Some("heguo".to_owned()));
        // 本来就没有 source（红果原生链路）不能被门闩改成别的。
        assert_eq!(gated_source(None, false), None);
        assert_eq!(gated_source(None, true), None);
    }

    /// 按 id 直达类入口的门闩：受控源被关掉时**报错**。
    ///
    /// 这里与 `gated_source` 分道扬镳是刻意的：用户此刻正拿着一部被禁的剧，
    /// 静默放行等于"照播了但你看不见"，报错才是正确结果。
    #[test]
    fn series_source_allowed_blocks_disabled_adult_series_only() {
        // 关闭 + 18+ 源剧集 → 拒。
        for series_id in ["guo:dsd:1", "guo:huangdou:abc", "guo:huangguo-video:x:1"] {
            assert!(
                !series_source_allowed(series_id, false),
                "{series_id} 属于被关掉的 18+ 源，必须挡住"
            );
        }
        // 开启 → 全放行。
        assert!(series_source_allowed("guo:dsd:1", true));
        // 关闭 + 常规源 / 非 guo 剧集 → 放行（红果、动漫的 id 都不能被误伤）。
        assert!(series_source_allowed("guo:heguo:1", false));
        assert!(series_source_allowed("guo:hongguo:1", false));
        assert!(series_source_allowed("dmghg:9999", false));
        assert!(series_source_allowed("12345", false));
    }

    /// `settings_save` 的启用列表归一化，以及"为什么不剔除 18+ 源"的护栏。
    ///
    /// 归一化做三件事：去重、丢弃未知 id、全空回落红果（否则会存下一个零可用源的
    /// 设置，首页一个请求都没有）。
    ///
    /// 断言的重点在最后一条：开关关闭时 **18+ 源仍留在启用列表里**。这是刻意的
    /// （设置页关闭总开关是"置灰"不是"取消勾选"，取消是用户没要求的数据丢失）；
    /// 内容侧由 `series_source_allowed` / `gated_source` 按请求拦，磁盘上留个源 id
    /// 拿不到任何内容。写死这条是为了防止下一个人看到"关着开关还启用着帝果"就
    /// 顺手加回剔除。
    #[test]
    fn settings_save_normalizes_but_keeps_disabled_adult_sources() {
        let mixed = UserSettings {
            show_adult_sources: false,
            enabled_sources: vec![
                "dsd".to_string(),
                "heguo".to_string(),
                "huangguo-video".to_string(),
                "hongguo".to_string(),
                "不存在的源".to_string(),
            ],
            ..UserSettings::default()
        };
        // 18+ 源原样保留；未知 id 被丢弃；顺序保持稳定（用户勾选的顺序即聚合顺序）。
        assert_eq!(
            normalize_enabled_sources(&mixed.enabled_sources),
            vec![
                "dsd".to_string(),
                "heguo".to_string(),
                "huangguo-video".to_string(),
                "hongguo".to_string()
            ]
        );

        // 全空（含全是被丢弃的未知 id）时回落红果：零可用源等于坏设置。
        assert_eq!(
            normalize_enabled_sources(&["不存在-a".to_string(), "不存在-b".to_string()]),
            vec!["hongguo".to_string()]
        );
        assert_eq!(normalize_enabled_sources(&[]), vec!["hongguo".to_string()]);

        // 但守卫仍然拦得住：18+ 源的剧集 id 在开关关闭时一律不可达。
        assert!(!series_source_allowed("guo:dsd:1", false));
        assert!(!series_source_allowed("guo:huangguo-video:1", false));
    }

    #[test]
    fn search_cache_entry_expires_after_ttl() {
        let cache: SearchCache<CatalogPage> = SearchCache::new(Duration::from_millis(0));
        cache.put("k".into(), fake_page("过期"));
        assert!(cache.get("k").is_none());
    }

    #[test]
    fn search_cache_clears_when_capacity_reached() {
        let cache: SearchCache<CatalogPage> = SearchCache::new(Duration::from_secs(300));
        for index in 0..SEARCH_CACHE_CAPACITY {
            cache.put(format!("k{index}"), fake_page("满"));
        }
        cache.put("k0".into(), fake_page("触发清空"));
        // 容量到顶就整表清空：先写的那批全部消失，只剩触发清空后写入的这一条。
        assert!(cache.get("k1").is_none());
        assert_eq!(
            cache.get("k0").map(|page| page.source).as_deref(),
            Some("触发清空")
        );
    }

    #[test]
    fn suggest_cache_key_isolates_channel() {
        assert_ne!(
            suggest_cache_key("战神", "drama"),
            suggest_cache_key("战神", "comic")
        );
    }
}
