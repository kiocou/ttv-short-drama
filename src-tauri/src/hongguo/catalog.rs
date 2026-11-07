//! 目录能力：搜索、详情、分集、首页推荐。
//!
//! 移植自 `internal/protocol/parse.go` 与 `internal/protocol/request.go` 的目录部分。
//! 上游把卡片塞在多层动态结构里（`search_tabs[].data[].video_data[]`、
//! `video_detail.video_detail_list[]`），层级在不同接口间还不一致，所以这里
//! 统一用「递归找 video_detail / series_card 形状」的容错策略，而不是写死路径。

use std::collections::{BTreeMap, HashSet};

use serde_json::Value;

use crate::hongguo::client::{HongguoClient, HongguoError, Result};
use crate::hongguo::consts::API_HOST;
use crate::hongguo::consts::{
    DEFAULT_RANK_ACTIVITY, DEFAULT_RANK_LIST, PATH_ALBUM, PATH_CELL_CHANGE, PATH_CUE,
    PATH_DISCOVER, PATH_PLAN, PATH_PROFILE, PATH_RANK_ACTIVITY, PATH_SEARCH, PATH_SERIES,
    PATH_SERIES_BATCH, PATH_SHORT_FILTER, PATH_SUBSCRIBE_LIST, PATH_SUGGEST,
    PATH_USER_WORKS_TEMPLATE, PLAN_FROM_SERIES_SEASONS, SEARCH_SOURCE_HOME, SEARCH_TAB_NAME,
    SEARCH_TAB_SHORT_PLAY, SHORT_RANK_CELL,
};
use crate::hongguo::short_cursor::{next_short_cursor, ShortCursor};

/// 批量详情每次请求的短剧数上限。Go 的 `seriesBatchSize` 为 10，服务端接受 20，这里取保守值。
pub const SERIES_BATCH_SIZE: usize = 10;

/// 短剧筛选面板的行 key，固定顺序（与 Go 的 `ShortFilterKeys` 一致）。
pub const SHORT_FILTER_KEYS: [&str; 8] = [
    "category_dim_epoch",
    "online_time",
    "gender",
    "category_dim_role",
    "genre",
    "creation_status",
    "sort",
    "category_dim_theme",
];

/// 短剧 / 合集 id：4–25 位纯数字（与 Go 的 `validID` 一致）。
fn valid_series_id(id: &str) -> bool {
    (4..=25).contains(&id.len()) && id.chars().all(|c| c.is_ascii_digit())
}
use crate::hongguo::sign::{device_query_pairs, Pairs};

/// 搜索综合 tab 的筛选项，与 Go 的 `SearchFilter*` 常量一致（2026-10-24 实测）。
/// 两个漫剧类筛选都返回 content_type 1004，由服务端区分二者。
pub const SEARCH_FILTER_SHORT_PLAY: &str = "content_type_short_play"; // 真人剧
pub const SEARCH_FILTER_COMIC: &str = "content_type_dynamic_comic"; // 漫剧
pub const SEARCH_FILTER_AI_COMIC: &str = "content_type_ai_dynamic_comic"; // AI剧
pub const SEARCH_FILTER_FILM: &str = "content_type_long_video"; // 影视剧
pub const SEARCH_FILTER_UNWATCHED: &str = "search_range_unread"; // 未看过

/// 搜索的 tab。只开放短剧相关的四个；小说与听书属于书城，这里不接。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SearchTab {
    /// 综合（默认，可叠加筛选）。
    #[default]
    Overall,
    /// 剧集。
    Series,
    /// 视频。
    Video,
    /// 讨论。
    Discussion,
}

impl SearchTab {
    /// 对应 `tab_type` 的查询值（与 Go 的 `SearchTab*` 常量一致）。
    pub fn tab_type(self) -> &'static str {
        match self {
            SearchTab::Overall => SEARCH_TAB_SHORT_PLAY,
            SearchTab::Series => "29",
            SearchTab::Video => "30",
            SearchTab::Discussion => "31",
        }
    }
}

/// 搜索选项。`cursor` 是上一页返回的 `next_offset`，空即第一页。
#[derive(Debug, Clone, Default)]
pub struct SearchOptions {
    pub tab: SearchTab,
    /// 筛选项，只能在综合 tab 上使用；取值见 `SEARCH_FILTER_*`。
    pub filters: Vec<String>,
    pub cursor: Option<String>,
    pub page_size: usize,
}

/// 校验筛选项：必须在综合 tab，且每个值都在白名单内；去重并保持输入顺序。
pub fn validate_search_filters(tab: SearchTab, filters: &[String]) -> Result<Vec<String>> {
    if filters.is_empty() {
        return Ok(Vec::new());
    }
    if tab != SearchTab::Overall {
        return Err(HongguoError::Other("筛选项只能用于综合 tab".into()));
    }
    const ALLOWED: [&str; 5] = [
        SEARCH_FILTER_SHORT_PLAY,
        SEARCH_FILTER_COMIC,
        SEARCH_FILTER_AI_COMIC,
        SEARCH_FILTER_FILM,
        SEARCH_FILTER_UNWATCHED,
    ];
    let mut out: Vec<String> = Vec::new();
    for f in filters {
        if !ALLOWED.contains(&f.as_str()) {
            return Err(HongguoError::Other(format!("未知的搜索筛选项：{f}")));
        }
        if !out.iter().any(|existing| existing == f) {
            out.push(f.clone());
        }
    }
    Ok(out)
}

/// 条目级内容类型（服务端 `content_type` 字段，2026-11-07 实测定值）：
/// `1` = 真人短剧；`1004` = 漫剧（AI 剧同值，同属漫剧频道）；`1002` = 未上线
/// （预约/预告，**无法区分真人还是漫剧**——上新日历的预告条目全是它）。
pub mod content_type {
    pub const LIVE: u32 = 1;
    pub const COMIC: u32 = 1004;
}

/// 频道是否接受该内容类型的条目。
///
/// 这是「短剧专区混进漫剧、漫剧次元混进真人剧」（2026-11-07 用户报告）的逐条
/// 兜底闸门：榜单、日历、发现流都是天然混合流，接口参数（genre/board/tab）
/// 挡不住服务端偶发的串味行，必须在每条上验一遍。
///
/// `None`（源没给标记，如老结构的搜索卡片）一律放行——过滤的目的是拦"确证
/// 串味"，不是惩罚没标记的源；把它当不匹配会把整栏清空。
pub fn channel_accepts(channel: &str, content_type: Option<u32>) -> bool {
    match content_type {
        None => true,
        Some(ct) => match channel {
            "comic" => ct == content_type::COMIC,
            "drama" => ct == content_type::LIVE,
            // adult（本机聚合）、anime（独立源）不按红果口径过滤。
            _ => true,
        },
    }
}

/// 从卡片里取 `content_type`：可能直接挂在卡片顶层，也可能在 `video_detail` 内
/// （subscribe_list 的行、发现页的嵌套卡都是两种写法并存）。
fn card_content_type(card: &Value) -> Option<u32> {
    let direct = flex_i64(card.get("content_type"));
    if direct > 0 {
        return Some(direct as u32);
    }
    let nested = flex_i64(
        card.get("video_detail")
            .filter(|v| v.is_object())
            .and_then(|v| v.get("content_type")),
    );
    (nested > 0).then_some(nested as u32)
}

/// 目录卡片。
#[derive(Debug, Clone, Default)]
pub struct SeriesHit {
    pub id: String,
    pub title: String,
    pub cover: String,
    pub intro: String,
    pub episode_count: u32,
    /// 条目级内容类型标记，见 [`content_type`]。`None` = 源没给。
    pub content_type: Option<u32>,
}

/// 短剧详情：在搜索卡片 [`SeriesHit`] 之外，补齐 `video_data` 里的状态、付费、
/// 分级、多季与计数字段。字段名与 Go 的 `wireSeriesData` 一一对应
/// （`internal/protocol/parse.go`）。
#[derive(Debug, Clone, Default)]
pub struct SeriesDetail {
    pub hit: SeriesHit,
    /// 发布状态：0 更新中，1 已完结（`series_status`）。
    pub status: i64,
    /// 付费类型：0 免费，1 会员，2 单买（`pay_info.pay_type`）。
    pub pay_type: i64,
    /// 年龄分级，0 为不受限（`age_gate.age_gate`）。
    pub age_gate: i64,
    /// 是否属于多季合集（`is_multi_season`）。
    pub is_multi_season: bool,
    /// 集数角标，如「更新至12集」（`episode_right_text`）。
    pub right_text: String,
    /// 总播放量（`series_play_cnt`）。
    pub play_count: i64,
    /// 关注数（`followed_cnt`）。
    pub follow_count: i64,
    /// 点赞数（`digg_cnt`）。
    pub digg_count: i64,
    /// 发布时间，unix 秒（`create_time`）。
    pub created_at: i64,
}

/// 一集。
#[derive(Debug, Clone, Default)]
pub struct EpisodeHit {
    pub id: String,
    pub series_id: String,
    pub number: u32,
    pub title: String,
    pub duration_seconds: f64,
    pub cover: String,
}

/// 系列剧里的一季（`PATH_PLAN` 的 `video_data[]` 一项）。
///
/// 与 [`SeriesHit`] 分开，是因为两者**语义不同**：`SeriesHit` 是"一部剧
/// （某个 series_id）"，而这里每一条本身也是一个独立的 `series_id`，
/// 只是同属于一个系列。前端选季时真正要点的是这里的 id。
#[derive(Debug, Clone, Default)]
pub struct SeasonHit {
    pub series_id: String,
    pub title: String,
    pub cover: String,
    /// 季号。**只认这个字段**，绝不从标题里解析。
    ///
    /// 实测《烬九州》第 35 季的标题是「烬九州第三十五期」——尾部用的是「期」
    /// 不是「季」，同一个系列里标题写法并不统一。按标题猜季号必然漏季、
    /// 错序，而 `season_index` 是 1..N 连续整数，直接可用。
    pub season_index: i64,
    pub episode_count: u32,
    /// 接口的原始 `disable_play`：剧方主动锁了播放。
    ///
    /// 与「未上架」（`episode_count == 0`）是两件事，这里不合并——上层要按
    /// 集数出不同的置灰文案，合并了就再也分不出来。
    pub disable_play: bool,
}

fn flex_str(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn flex_i64(v: Option<&Value>) -> i64 {
    match v {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

fn flex_f64(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// 取布尔值。接口里 `disable_play` 实测是 JSON bool，但同一族的字段偶尔会
/// 变成 `0/1` 数字或 `"true"/"false"` 字符串，这里一并认掉，避免因为一个
/// 类型抖动把「已锁播」误判成「可播」。
fn flex_bool(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0) != 0,
        Some(Value::String(s)) => matches!(s.trim(), "true" | "1"),
        _ => false,
    }
}

/// plan 接口要的 `session_uuid`：UUIDv4 形状即可。
///
/// 服务端只把它当"这一次系列剧弹窗请求的关联 id"，不做服务端状态校验，
/// 所以不需要跨请求复用。用 `uuid`（本就是依赖，v4 feature 已开）生成，
/// 形状与上游 SDK 的 `uuid.NewString()` 一致。
fn session_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// `PATH_PLAN` 里「同系列各季」那种 cell 的 `show_type`。
///
/// 同一个 plan 接口还会塞推荐位、广告位等别的 cell，它们的 `video_data`
/// 形状完全不同（没有 `season_index`），混进来会排出乱七八糟的季号。
const PLAN_SHOW_TYPE_SERIES_SEASONS: i64 = 547;

/// 「这个作品没有其它季」的业务码。
///
/// 上游 SDK 注释原文：没有其他季的作品会返回 101116。`classify` 只把 101000
/// 归入 `ContentUnavailable`，101116 会落到通用的 `Code { .. }`，所以两条
/// 分支都得认。
const PLAN_CODE_NO_OTHER_SEASONS: i64 = 101116;

/// 该错误是不是「这个系列确实没有更多季」。
///
/// 这类情况不是失败：前端要用 `Ok(空列表)` 表示"只有这一季/没有相关季"，
/// 用 `Err` 表示"网络或设备出问题了，可以重试"。
fn seasons_absent(error: &HongguoError) -> bool {
    match error {
        HongguoError::ContentUnavailable(_) => true,
        HongguoError::Code { code, .. } => *code == PLAN_CODE_NO_OTHER_SEASONS,
        _ => false,
    }
}

/// 解析 plan feed 的「同系列各季」列表。
///
/// 规则照抄上游 SDK：只取 `data[]` 里 `show_type == 547` 的 cell，
/// 遍历其 `video_data[]`，丢弃 `series_id` 为空的项，最后按
/// `season_index` 升序（相同再按 `series_id`）排序。
///
/// **不做任何条数截断**：35 季的系列就该一次吐 35 条。旧链路的毛病正是
/// 每季一次回查、硬上限 2 次，才只出得了 1~3 条。
fn parse_seasons(value: &Value) -> Vec<SeasonHit> {
    let mut out: Vec<SeasonHit> = Vec::new();
    let Some(cells) = value.get("data").and_then(Value::as_array) else {
        return out;
    };
    for cell in cells {
        if flex_i64(cell.get("show_type")) != PLAN_SHOW_TYPE_SERIES_SEASONS {
            continue;
        }
        let Some(videos) = cell.get("video_data").and_then(Value::as_array) else {
            continue;
        };
        for item in videos {
            // `series_id` 实测是字符串形式的大整数；`series_id_str` 是同一族
            // 接口的另一种写法，取不到前者时兜底，避免把整季当空 id 丢掉。
            let series_id = {
                let a = flex_str(item.get("series_id"));
                if a.is_empty() {
                    flex_str(item.get("series_id_str"))
                } else {
                    a
                }
            };
            if series_id.is_empty() {
                continue;
            }
            // 标题字段在这个接口里叫 `title`（不是详情接口的 `series_title`），
            // 缺标题仍然收下：季号才是选季的唯一依据，标题只用于展示。
            let title = {
                let a = flex_str(item.get("title"));
                if a.is_empty() {
                    flex_str(item.get("series_title"))
                } else {
                    a
                }
            };
            let cover = {
                let a = flex_str(item.get("cover"));
                if a.is_empty() {
                    flex_str(item.get("series_cover"))
                } else {
                    a
                }
            };
            // 同一个 series_id 出现两次只可能是接口分页拼接的重复，留先到的那条。
            if out.iter().any(|h| h.series_id == series_id) {
                continue;
            }
            out.push(SeasonHit {
                series_id,
                title,
                cover,
                season_index: flex_i64(item.get("season_index")),
                episode_count: flex_i64(item.get("episode_cnt")).max(0) as u32,
                disable_play: flex_bool(item.get("disable_play")),
            });
        }
    }
    out.sort_by(|a, b| {
        a.season_index
            .cmp(&b.season_index)
            .then_with(|| a.series_id.cmp(&b.series_id))
    });
    out
}

/// 尽力从各种卡片形状里抽出一条剧集信息。
fn hit_from_card(card: &Value) -> Option<SeriesHit> {
    let id = {
        let a = flex_str(card.get("series_id_str"));
        if !a.is_empty() {
            a
        } else {
            flex_str(card.get("series_id"))
        }
    };
    let title = flex_str(card.get("series_title"));
    if id.is_empty() || title.is_empty() {
        return None;
    }
    Some(SeriesHit {
        id,
        title,
        cover: card_cover(card),
        intro: flex_str(card.get("series_intro")),
        episode_count: flex_i64(card.get("episode_cnt")).max(0) as u32,
        content_type: card_content_type(card),
    })
}

/// 封面字段的多键兜底：`series_cover` → `cover` → `horiz_cover`。
///
/// 为什么必须兜底而不是只认一个键：同一份搜索响应里，短剧档与漫剧档、
/// 竖版与横版卡片的封面字段名并不统一（`series_cover` 是详情/网页链路的写法，
/// App 搜索的卡片用的是 `cover` / `horiz_cover`）。只认 `series_cover` 的结果
/// 是搜索页整页灰块——字段存在但读不到，比字段缺失更难查。
fn card_cover(card: &Value) -> String {
    for key in ["series_cover", "cover", "horiz_cover"] {
        let value = flex_str(card.get(key));
        if !value.is_empty() {
            return value;
        }
    }
    String::new()
}

/// 递归收集所有「长得像剧集卡片」的对象。
///
/// `video_detail` 里既可以放扁平卡片，也可以放 `video_detail_list`，
/// 搜索的「视频」tab 还会再嵌一层，写死路径必然会漏。
fn collect_hits(node: &Value, out: &mut Vec<SeriesHit>, depth: usize) {
    if depth > 6 {
        return;
    }
    match node {
        Value::Object(map) => {
            // 优先认 video_detail 形状
            if map.contains_key("series_title") {
                if let Some(hit) = hit_from_card(node) {
                    if !out.iter().any(|h| h.id == hit.id) {
                        out.push(hit);
                    }
                }
            }
            // 从 video_data 里取：外层 series_id + video_detail 内的标题
            if let (Some(sid), Some(vd)) = (map.get("series_id"), map.get("video_detail")) {
                let id = flex_str(Some(sid));
                let title = flex_str(vd.get("series_title"));
                if !id.is_empty() && !title.is_empty() {
                    let hit = SeriesHit {
                        id,
                        title,
                        // 封面先看 video_detail（App 搜索的真实位置），再看外层卡片：
                        // 两种层级的写法都真实存在过，只认一边就会丢封面。
                        cover: {
                            let a = card_cover(vd);
                            if a.is_empty() {
                                card_cover(node)
                            } else {
                                a
                            }
                        },
                        intro: {
                            let a = flex_str(vd.get("series_intro"));
                            if a.is_empty() {
                                flex_str(node.get("series_intro"))
                            } else {
                                a
                            }
                        },
                        episode_count: flex_i64(vd.get("episode_cnt")).max(0) as u32,
                        // video_detail 与外层卡片都可能带标记（发现页两种写法并存）。
                        content_type: card_content_type(node),
                    };
                    if !out.iter().any(|h| h.id == hit.id) {
                        out.push(hit);
                    }
                }
            }
            for (_, v) in map {
                collect_hits(v, out, depth + 1);
            }
        }
        Value::Array(arr) => {
            for v in arr {
                collect_hits(v, out, depth + 1);
            }
        }
        _ => {}
    }
}

/// 从 `PATH_SEARCH` 的完整响应里抽出剧集卡片。
///
/// 只认 `tab_type == 11`（真人短剧）那一栏：同一份响应里还有漫剧、听书等
/// 其它 tab，混进来会让"搜短剧"串出别的档位。
fn parse_search_hits(value: &Value, tab_type: &str) -> Vec<SeriesHit> {
    let mut hits = Vec::new();
    if let Some(tabs) = value.get("search_tabs").and_then(|t| t.as_array()) {
        for tab in tabs {
            let got = flex_i64(tab.get("tab_type"));
            // tab_type 缺失（0）时照收：老结构没有这个键，宁可多收也不能漏。
            if got != 0 && got.to_string() != tab_type {
                continue;
            }
            collect_hits(tab, &mut hits, 0);
        }
    }
    if hits.is_empty() {
        // tab 结构不存在时（接口改版 / 单栏响应）退回全量递归，
        // 靠 `collect_hits` 自身的形状识别兜住。
        collect_hits(value, &mut hits, 0);
    }
    hits
}

/// 一页搜索结果。`next_cursor` 为 `None` 表示已经没有下一页。
#[derive(Debug, Clone, Default)]
pub struct SearchPage {
    pub hits: Vec<SeriesHit>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
}

/// 从搜索响应的 `search_tabs[]` 里取出目标 tab 的分页信息。
/// 与 Go 的 `ParseSearchTab` 一致：只看 `tab_type` 命中的那一栏。
fn search_tab_paging(value: &Value, tab_type: &str) -> (bool, i64) {
    let Some(tabs) = value.get("search_tabs").and_then(|t| t.as_array()) else {
        return (false, 0);
    };
    for tab in tabs {
        if flex_i64(tab.get("tab_type")).to_string() == tab_type {
            let has_more = tab
                .get("has_more")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            return (has_more, flex_i64(tab.get("next_offset")));
        }
    }
    (false, 0)
}

impl HongguoClient {
    /// 搜索短剧（综合 tab，无筛选）。保留旧签名，调用方不用改。
    pub async fn search(
        &self,
        keyword: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<SeriesHit>> {
        let page = self
            .search_page(
                keyword,
                &SearchOptions {
                    page_size: limit,
                    cursor: Some(offset.to_string()),
                    ..Default::default()
                },
            )
            .await?;
        Ok(page.hits)
    }

    /// 按 tab 与筛选搜索一页。`opts.cursor` 是上一页的 `next_offset`。
    pub async fn search_page(&self, keyword: &str, opts: &SearchOptions) -> Result<SearchPage> {
        let filters = validate_search_filters(opts.tab, &opts.filters)?;
        let offset = match opts.cursor.as_deref().map(str::trim) {
            None | Some("") => 0,
            Some(raw) => raw
                .parse::<usize>()
                .map_err(|_| HongguoError::Other("搜索游标不合法".into()))?,
        };
        let limit = if opts.page_size == 0 {
            20
        } else {
            opts.page_size
        };

        // 只在设备被**明确拒绝**时换设备，语义统一收在 `with_fresh_device`：
        // 空结果（`AnonymousLimited`）不换，误换等于白烧一次播放机会。
        self.with_fresh_device("搜索", || {
            self.search_once(keyword, limit, offset, opts.tab, &filters)
        })
        .await
    }

    async fn search_once(
        &self,
        keyword: &str,
        limit: usize,
        offset: usize,
        tab: SearchTab,
        filters: &[String],
    ) -> Result<SearchPage> {
        let keyword = keyword.trim();
        if keyword.is_empty() {
            return Ok(SearchPage::default());
        }
        let selected: Vec<&str> = filters.iter().map(String::as_str).collect();
        let pairs = self
            .search_pairs_for(keyword, limit, offset, tab.tab_type(), &selected)
            .await?;

        let value = self
            .request(reqwest::Method::GET, PATH_SEARCH, pairs, None)
            .await?;

        let hits = parse_search_hits(&value, tab.tab_type());
        let (has_more, next) = search_tab_paging(&value, tab.tab_type());
        // 与 Go 一致：只有确实前进了才给游标，防止服务端回传同一个 offset 时死循环。
        let next_cursor = (has_more && next > offset as i64).then(|| next.to_string());
        Ok(SearchPage {
            hits,
            has_more,
            next_cursor,
        })
    }

    /// 搜索接口的完整查询串。
    ///
    /// 抽成独立方法是为了让 `search_once` 与联网测试共用**同一份**参数构造：
    /// 参数顺序参与签名，测试里手抄一份的话，抄错了也测不出来。
    pub(crate) async fn search_pairs(
        &self,
        keyword: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Pairs> {
        self.search_pairs_for(keyword, limit, offset, SEARCH_TAB_SHORT_PLAY, &[])
            .await
    }

    /// 带 tab 与筛选的搜索查询串，参数顺序与 Go 的 `SignedSearchPairsFor` 一致。
    /// `selected_items` 只在综合 tab 上追加，其余 tab 的服务端不认这个参数。
    pub(crate) async fn search_pairs_for(
        &self,
        keyword: &str,
        limit: usize,
        offset: usize,
        tab_type: &str,
        selected: &[&str],
    ) -> Result<Pairs> {
        let profile = self.ensure_guest().await?;
        let mut p = device_query_pairs(&Self::identity(&profile));
        p.push(("query".into(), keyword.trim().to_string()));
        p.push(("tab_type".into(), tab_type.to_string()));
        p.push(("count".into(), limit.max(1).to_string()));
        p.push(("offset".into(), offset.to_string()));
        p.push(("use_correct".into(), "true".into()));
        p.push(("bookshelf_search_plan".into(), "4".into()));
        p.push(("search_source".into(), SEARCH_SOURCE_HOME.into()));
        p.push(("tab_name".into(), SEARCH_TAB_NAME.into()));
        p.push(("bookstore_tab".into(), "16".into()));
        p.push(("user_is_login".into(), "0".into()));
        if !selected.is_empty() {
            p.push(("selected_items".into(), selected.join(",")));
        }
        Ok(p)
    }

    /// 搜索联想词。
    pub async fn suggest(&self, prefix: &str) -> Result<Vec<String>> {
        self.with_fresh_device("搜索联想", || self.suggest_once(prefix))
            .await
    }

    async fn suggest_once(&self, prefix: &str) -> Result<Vec<String>> {
        let pairs: Pairs = {
            let profile = self.ensure_guest().await?;
            let mut p = device_query_pairs(&Self::identity(&profile));
            p.push(("query".into(), prefix.trim().to_string()));
            p.push(("count".into(), "10".into()));
            p.push(("search_source".into(), SEARCH_SOURCE_HOME.into()));
            p.push(("user_is_login".into(), "0".into()));
            p
        };
        let value = self
            .request(reqwest::Method::GET, PATH_SUGGEST, pairs, None)
            .await?;
        let mut out = Vec::new();
        let mut walk = |v: &Value| {
            if let Some(arr) = v.as_array() {
                for item in arr {
                    let s = match item {
                        Value::String(s) => s.trim().to_string(),
                        Value::Object(o) => flex_str(o.get("word")),
                        _ => String::new(),
                    };
                    if !s.is_empty() && !out.contains(&s) {
                        out.push(s);
                    }
                }
            }
        };
        walk(&value);
        if let Some(data) = value.get("data") {
            walk(data);
            if let Some(sug) = data.get("suggest_words") {
                walk(sug);
            }
        }
        Ok(out)
    }

    /// 某部剧所属系列的全部季。
    ///
    /// 换设备重试的外壳与其它目录接口一致（见 `with_fresh_device`）：查询串里的
    /// `device_id` / `iid` 是设备相关的，设备被**明确拒绝**后同一台机器怎么重试
    /// 都是空列表，必须先换设备再打一次。空结果（`AnonymousLimited`）不换——
    /// 它代表「结果本来为空」，误换会烧掉新设备的播放机会（对齐上游 0.2.0 的
    /// `needsFreshDevice`；此前这里对空结果也换设备，正是上游 0.2.0 纠正的行为）。
    ///
    /// 错误语义分两档，前端要靠它区分「确实只有一季」和「请求失败」：
    /// 没有其它季的作品（101116）与内容不可用（101000 一类）收敛成
    /// `Ok(空列表)`；传输层 / 设备被拒 / 限流等照常 `Err`。
    pub async fn series_seasons(&self, series_id: &str) -> Result<Vec<SeasonHit>> {
        let attempt = self
            .with_fresh_device("各季列表", || self.series_seasons_once(series_id))
            .await;
        // 收敛放在重试之后：换设备重打一次同样可能回 101116，两层都要落到 Ok。
        match attempt {
            Err(error) if seasons_absent(&error) => Ok(Vec::new()),
            other => other,
        }
    }

    async fn series_seasons_once(&self, series_id: &str) -> Result<Vec<SeasonHit>> {
        let series_id = series_id.trim();
        if series_id.is_empty() {
            // 空 id 由调用方负责校验；这里返回空而不是报错，避免前端把
            // "没传 id" 当成网络失败去重试。
            return Ok(Vec::new());
        }
        let pairs: Pairs = {
            let profile = self.ensure_guest().await?;
            let mut p = device_query_pairs(&Self::identity(&profile));
            // 参数顺序照抄上游 SDK，且**必须**照抄：查询串整体参与签名，
            // 顺序变了签名就对不上（服务端回 101001 / 空 data）。
            p.push(("book_id".into(), series_id.to_string()));
            p.push(("from".into(), PLAN_FROM_SERIES_SEASONS.into()));
            p.push(("scene".into(), "10".into()));
            p.push(("session_uuid".into(), session_uuid()));
            p.push(("user_is_login".into(), "0".into()));
            p.push(("filter_ids".into(), series_id.to_string()));
            p
        };

        let value = self
            .request(reqwest::Method::GET, PATH_PLAN, pairs, None)
            .await?;

        Ok(parse_seasons(&value))
    }

    /// 剧集详情（含分集列表）。
    pub async fn get_series(&self, series_id: &str) -> Result<(SeriesDetail, Vec<EpisodeHit>)> {
        self.with_fresh_device("剧集详情", || self.get_series_once(series_id))
            .await
    }

    /// 批量加载多部短剧的详情与分集，按请求顺序返回，找不到的剧会被略过。
    /// 每次最多查 [`SERIES_BATCH_SIZE`] 部，超出则分批请求（与 Go 的 `GetSeriesBatch` 一致）。
    pub async fn get_series_batch(
        &self,
        series_ids: &[String],
    ) -> Result<Vec<(SeriesDetail, Vec<EpisodeHit>)>> {
        self.with_fresh_device("批量详情", || self.get_series_batch_once(series_ids))
            .await
    }

    async fn get_series_batch_once(
        &self,
        series_ids: &[String],
    ) -> Result<Vec<(SeriesDetail, Vec<EpisodeHit>)>> {
        // 去重并校验：每个 id 都必须是 4–25 位纯数字。
        let mut ids: Vec<String> = Vec::new();
        for raw in series_ids {
            let id = raw.trim();
            if !valid_series_id(id) {
                return Err(HongguoError::Other(format!("剧集 ID 不合法：{raw}")));
            }
            if !ids.iter().any(|existing| existing == id) {
                ids.push(id.to_string());
            }
        }

        let mut found: std::collections::HashMap<String, (SeriesDetail, Vec<EpisodeHit>)> =
            std::collections::HashMap::new();
        for chunk in ids.chunks(SERIES_BATCH_SIZE) {
            let body = serde_json::to_vec(&serde_json::json!({
                "series_id": chunk.join(","),
                "dr_scene": "player",
                "biz_param": {
                    "detail_page_version": 0,
                    "need_all_video_definition": false,
                    "need_mp4_align": false,
                    "source": 7,
                    "use_os_player": false,
                    "use_server_dns": false,
                },
            }))
            .map_err(|e| HongguoError::Other(e.to_string()))?;

            let pairs = self.query_pairs_only().await?;
            let value = self
                .request(reqwest::Method::POST, PATH_SERIES_BATCH, pairs, Some(body))
                .await?;
            // 响应的 data 是以 series_id 为键的对象。
            if let Some(map) = value.get("data").and_then(|d| d.as_object()) {
                for payload in map.values() {
                    let Some(vd) = payload.get("video_data") else {
                        continue;
                    };
                    if let Ok(parsed) = parse_series_video(vd) {
                        found.insert(parsed.0.hit.id.clone(), parsed);
                    }
                }
            }
        }

        Ok(ids.iter().filter_map(|id| found.remove(id)).collect())
    }

    /// 加载一个合集（多季合集）的各季分集列表。合集 id 必须是纯数字。
    pub async fn get_album(&self, album_id: &str) -> Result<Value> {
        self.with_fresh_device("合集分集", || self.get_album_once(album_id))
            .await
    }

    async fn get_album_once(&self, album_id: &str) -> Result<Value> {
        let album_id = album_id.trim();
        if !valid_series_id(album_id) {
            return Err(HongguoError::Other("合集 ID 不合法".into()));
        }
        let body = serde_json::to_vec(&serde_json::json!({
            "album_id": album_id,
            "biz_param": { "video_platform": 3 },
            "need_video_detail_info": true,
            "series_ids": [],
        }))
        .map_err(|e| HongguoError::Other(e.to_string()))?;
        let pairs = self.query_pairs_only().await?;
        self.request(reqwest::Method::POST, PATH_ALBUM, pairs, Some(body))
            .await
    }

    /// 只带设备身份的查询串（POST 接口的基础参数）。
    async fn query_pairs_only(&self) -> Result<Pairs> {
        let profile = self.ensure_guest().await?;
        Ok(device_query_pairs(&Self::identity(&profile)))
    }

    /// 搜索框轮播的提示词（GET cue 接口）。返回去空白、去重后的文本，保持服务端顺序。
    /// 这些是占位文案（如「书名」「主角」），不是剧名，调用方按需展示。
    pub async fn search_cues(&self) -> Result<Vec<String>> {
        self.with_fresh_device("搜索提示词", || self.search_cues_once())
            .await
    }

    async fn search_cues_once(&self) -> Result<Vec<String>> {
        let pairs: Pairs = {
            let profile = self.ensure_guest().await?;
            let mut p = device_query_pairs(&Self::identity(&profile));
            p.push(("cue_type".into(), "1".into()));
            p.push(("limit".into(), "20".into()));
            p.push(("search_source".into(), SEARCH_SOURCE_HOME.into()));
            p.push(("tab_name".into(), SEARCH_TAB_NAME.into()));
            p.push(("user_is_login".into(), "0".into()));
            p
        };
        let value = self
            .request(reqwest::Method::GET, PATH_CUE, pairs, None)
            .await?;
        Ok(parse_cue_texts(&value))
    }

    /// 按筛选条件分页查短剧（POST distribution 接口）。
    ///
    /// `selections` 把筛选行 key（见 [`SHORT_FILTER_KEYS`]）映射到选中的值；缺省的行即「全部」。
    /// 带 `cursor` 续页时，若同时传了不同的筛选，直接报错：游标只能续接它自己的查询。
    pub async fn short_filter(
        &self,
        selections: &BTreeMap<String, Vec<String>>,
        cursor: Option<&str>,
    ) -> Result<ShortFilterResult> {
        self.with_fresh_device("短剧筛选", || {
            self.short_filter_once(selections, cursor)
        })
        .await
    }

    async fn short_filter_once(
        &self,
        selections: &BTreeMap<String, Vec<String>>,
        cursor: Option<&str>,
    ) -> Result<ShortFilterResult> {
        validate_short_filter_selections(selections)?;

        let cur = ShortCursor::decode(cursor.unwrap_or(""))?;
        // 游标只能续接它自己的查询：传了不同的筛选就拒绝，不静默覆盖。
        let effective = if cursor.is_some_and(|c| !c.trim().is_empty()) {
            if selections.is_empty() {
                cur.selections.clone()
            } else if *selections != cur.selections {
                return Err(HongguoError::Other(
                    "游标属于另一组筛选，请去掉筛选条件或游标".into(),
                ));
            } else {
                selections.clone()
            }
        } else {
            selections.clone()
        };

        // 与 Go 一致：genre 只有单值时才用它决定场景，否则按默认短剧场景。
        let scene = match effective.get("genre").map(Vec::as_slice) {
            Some([g]) if g == "comic_series" || g == "ai_series" => g.as_str(),
            _ => "default",
        };

        let body = build_short_filter_body(scene, &effective, &cur)?;

        let pairs = self.query_pairs_only().await?;
        let value = self
            .request(reqwest::Method::POST, PATH_SHORT_FILTER, pairs, Some(body))
            .await?;
        let data = value.get("data").cloned().unwrap_or(Value::Null);
        let items = parse_flat_series_list(data.get("video_data"));
        let has_more = data
            .get("has_more")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let next_offset = flex_i64(data.get("next_offset"));
        let session = flex_str(data.get("session_id"));

        // 续页游标：本页剧 id 记入 seen，服务端据此跳过，续页不会重复。
        let ids: Vec<String> = items.iter().map(|h| h.id.clone()).collect();
        let next_cursor = next_short_cursor(&cur, has_more, next_offset, &session, &ids)?;

        Ok(ShortFilterResult {
            items,
            has_more,
            next_cursor,
            selections: effective,
        })
    }

    /// 短剧筛选面板的各个选择行（`only_panel` 请求，不带剧集）。
    /// `genre` 为空表示真人剧（default 场景）；漫剧和 AI剧各有自己的 scene。
    pub async fn short_filter_panel(&self, genre: &str) -> Result<Vec<FilterRow>> {
        self.with_fresh_device("筛选面板", || self.short_filter_panel_once(genre))
            .await
    }

    async fn short_filter_panel_once(&self, genre: &str) -> Result<Vec<FilterRow>> {
        let scene = match genre {
            "" | "short_play" => "default",
            "comic_series" | "ai_series" => genre,
            other => {
                return Err(HongguoError::Other(format!(
                    "未知短剧类型 {other}，应为 short_play、comic_series 或 ai_series"
                )))
            }
        };
        let body = serde_json::to_vec(&serde_json::json!({
            "req_scene": scene,
            "need_selector_panel": false,
            "req_type": "only_panel",
        }))
        .map_err(|e| HongguoError::Other(e.to_string()))?;

        let pairs = self.query_pairs_only().await?;
        let value = self
            .request(reqwest::Method::POST, PATH_SHORT_FILTER, pairs, Some(body))
            .await?;
        let rows = parse_filter_rows(value.get("data").unwrap_or(&Value::Null));
        if rows.is_empty() {
            return Err(HongguoError::ContentUnavailable("短剧筛选面板为空".into()));
        }
        Ok(rows)
    }

    /// 短剧排行榜的一页。`content`、`board` 为空时使用服务端默认值；带 `cursor` 续页时
    /// 必须沿用游标里记录的榜单，不能与传入的不同。
    pub async fn short_rank(
        &self,
        content: &str,
        board: &str,
        cursor: Option<&str>,
    ) -> Result<ShortRankResult> {
        self.with_fresh_device("短剧榜单", || {
            self.short_rank_once(content, board, cursor)
        })
        .await
    }

    async fn short_rank_once(
        &self,
        content: &str,
        board: &str,
        cursor: Option<&str>,
    ) -> Result<ShortRankResult> {
        let cur = ShortCursor::decode(cursor.unwrap_or(""))?;
        let (content, board) = (content.trim(), board.trim());
        let (content, board) = if cursor.is_some_and(|c| !c.trim().is_empty()) {
            if (!content.is_empty() && content != cur.content)
                || (!board.is_empty() && board != cur.board)
            {
                return Err(HongguoError::Other(
                    "游标属于另一个榜单，请去掉榜单参数或游标".into(),
                ));
            }
            (cur.content.clone(), cur.board.clone())
        } else {
            (content.to_string(), board.to_string())
        };
        let content = if content.is_empty() {
            "all".to_string()
        } else {
            content
        };

        let change = if cur.offset > 0 { "2" } else { "1" };
        let pairs: Pairs = {
            let profile = self.ensure_guest().await?;
            let mut p = device_query_pairs(&Self::identity(&profile));
            p.push(("cell_id".into(), SHORT_RANK_CELL.into()));
            p.push(("tab_type".into(), "26".into()));
            p.push(("selected_items".into(), content.clone()));
            if !board.is_empty() {
                p.push(("sub_selected_items".into(), board.clone()));
            }
            p.push(("offset".into(), cur.offset.to_string()));
            p.push(("limit".into(), "0".into()));
            p.push(("client_req_type".into(), "2".into()));
            p.push(("client_template".into(), "2".into()));
            p.push(("unlimited_selector_change_type".into(), change.into()));
            if !cur.seen.is_empty() {
                p.push(("filter_ids".into(), cur.seen.join(",")));
            }
            if !cur.session.is_empty() {
                p.push(("session_id".into(), cur.session.clone()));
            }
            p.push(("user_is_login".into(), "0".into()));
            p
        };
        let value = self
            .request(reqwest::Method::GET, PATH_CELL_CHANGE, pairs, None)
            .await?;
        let data = value.get("data").cloned().unwrap_or(Value::Null);
        let (contents, mut items) = parse_short_rank(&data);
        let has_more = data
            .get("has_more")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let next_offset = flex_i64(data.get("next_offset"));
        let session = flex_str(data.get("session_id"));
        if items.is_empty() && cur.offset == 0 {
            return Err(HongguoError::ContentUnavailable("短剧榜单为空".into()));
        }

        // 位置跨页连续编号。
        let base = cur.seen.len();
        for it in &mut items {
            it.position += base;
        }

        // 目录标出了服务端实际返回的内容与榜单；没有指定时，这就是默认值。
        let (mut out_content, mut out_board) = (content.clone(), board.clone());
        for c in &contents {
            if !c.selected {
                continue;
            }
            out_content = c.id.clone();
            if let Some(b) = c.boards.iter().find(|b| b.selected) {
                out_board = b.id.clone();
            }
        }

        let ids: Vec<String> = items.iter().map(|it| it.series.id.clone()).collect();
        let mut next = cur.clone();
        next.content = out_content.clone();
        next.board = out_board.clone();
        let next_cursor = next_short_cursor(&next, has_more, next_offset, &session, &ids)?;

        Ok(ShortRankResult {
            contents,
            items,
            has_more,
            next_cursor,
            content: out_content,
            board: out_board,
        })
    }

    /// 活动榜单（星粉榜）的一页。`activity_id`、`rank_list_id` 为空时使用随 app 发布的默认值。
    /// 该接口是普通 JSON POST，带签名参数会返回 HTTP 400，所以这里不走 [`Self::request`]。
    pub async fn ranking(&self, activity_id: &str, rank_list_id: &str) -> Result<RankingPage> {
        self.with_fresh_device("活动榜单", || {
            self.ranking_once(activity_id, rank_list_id)
        })
        .await
    }

    async fn ranking_once(&self, activity_id: &str, rank_list_id: &str) -> Result<RankingPage> {
        let activity_id = if activity_id.trim().is_empty() {
            DEFAULT_RANK_ACTIVITY
        } else {
            activity_id.trim()
        };
        let rank_list_id = if rank_list_id.trim().is_empty() {
            DEFAULT_RANK_LIST
        } else {
            rank_list_id.trim()
        };
        let body = serde_json::to_vec(&serde_json::json!({
            "activity_id": activity_id,
            "rank_list_id": rank_list_id,
            "offset": 0,
            "count": 50,
        }))
        .map_err(|e| HongguoError::Other(e.to_string()))?;
        let value = self.post_plain_json(PATH_RANK_ACTIVITY, body).await?;
        let data = value.get("data").cloned().unwrap_or(Value::Null);
        Ok(parse_ranking_page(&data))
    }

    /// 不签名、不带设备查询参数的 JSON POST，只用于 activity_api。
    async fn post_plain_json(&self, path: &str, body: Vec<u8>) -> Result<Value> {
        let profile = self.ensure_guest().await?;
        let url = format!("https://{API_HOST}{path}");
        let resp = self
            .http
            .post(&url)
            .header("Content-Type", "application/json")
            .header("User-Agent", crate::hongguo::client::user_agent(&profile))
            .body(body)
            .send()
            .await
            .map_err(|e| HongguoError::Transport(e.to_string()))?;
        let status = resp.status();
        let raw = resp
            .bytes()
            .await
            .map_err(|e| HongguoError::Transport(e.to_string()))?;
        if !status.is_success() {
            return Err(HongguoError::Transport(format!(
                "activity_api HTTP {status}"
            )));
        }
        serde_json::from_slice(&raw).map_err(|e| HongguoError::Other(e.to_string()))
    }

    /// 搜索页的「猜你想搜」和各个热搜榜（plan feed，`from=search_input_page`）。
    pub async fn hot_search(&self) -> Result<HotSearch> {
        self.with_fresh_device("热搜", || self.hot_search_once())
            .await
    }

    async fn hot_search_once(&self) -> Result<HotSearch> {
        let pairs: Pairs = {
            let profile = self.ensure_guest().await?;
            let mut p = device_query_pairs(&Self::identity(&profile));
            for (k, v) in [
                ("user_is_login", "0"),
                ("bookstore_tab", "16"),
                ("bookstore_tab_type", "16"),
                ("scene", "10"),
                ("limit", "0"),
                ("tab_name", SEARCH_TAB_NAME),
                ("from", "search_input_page"),
                ("query_history_removed", "false"),
                ("offset", "0"),
                ("search_middle_page_version", "4"),
                ("search_source", SEARCH_SOURCE_HOME),
                ("new_search_middle_page", "true"),
                ("hot_word_exchange", "false"),
            ] {
                p.push((k.into(), v.into()));
            }
            p
        };
        let value = self
            .request(reqwest::Method::GET, PATH_PLAN, pairs, None)
            .await?;
        let hot = parse_hot_search(value.get("data").unwrap_or(&Value::Null));
        if hot.boards.is_empty() && hot.guesses.is_empty() {
            return Err(HongguoError::ContentUnavailable("搜索页热搜为空".into()));
        }
        Ok(hot)
    }

    /// 详情页的相关推荐。每次调用使用新的 `session_uuid`，与 Go 的 `SeriesRecommend` 一致。
    pub async fn series_recommend(&self, series_id: &str) -> Result<Recommend> {
        self.with_fresh_device("相关推荐", || self.series_recommend_once(series_id))
            .await
    }

    async fn series_recommend_once(&self, series_id: &str) -> Result<Recommend> {
        if !valid_series_id(series_id) {
            return Err(HongguoError::Other("无效的短剧 ID".into()));
        }
        let pairs: Pairs = {
            let profile = self.ensure_guest().await?;
            let mut p = device_query_pairs(&Self::identity(&profile));
            p.push(("book_id".into(), series_id.into()));
            p.push(("from".into(), "select_panel_recommend".into()));
            p.push(("scene".into(), "10".into()));
            p.push(("session_uuid".into(), session_uuid()));
            p.push(("user_is_login".into(), "0".into()));
            p
        };
        let value = self
            .request(reqwest::Method::GET, PATH_PLAN, pairs, None)
            .await?;
        let top_session = flex_str(value.get("session_id"));
        let data = value.get("data").cloned().unwrap_or(Value::Null);
        parse_recommend(&data, &top_session)
            .ok_or_else(|| HongguoError::ContentUnavailable("相关推荐为空".into()))
    }

    /// 上新日历的一页。`date` 为空时取今天；带 `cursor` 续页时日期沿用游标里的，
    /// 与传入的日期冲突则报错。
    pub async fn new_releases(&self, date: &str, cursor: Option<&str>) -> Result<NewReleasePage> {
        self.with_fresh_device("上新日历", || self.new_releases_once(date, cursor))
            .await
    }

    async fn new_releases_once(&self, date: &str, cursor: Option<&str>) -> Result<NewReleasePage> {
        let cur = ShortCursor::decode(cursor.unwrap_or(""))?;
        let has_cursor = cursor.is_some_and(|c| !c.trim().is_empty());
        let date = date.trim();
        if !date.is_empty() && !valid_yyyymmdd(date) {
            return Err(HongguoError::Other("日期必须是 YYYYMMDD".into()));
        }
        let date = if has_cursor {
            if !date.is_empty() && date != cur.date {
                return Err(HongguoError::Other(format!(
                    "游标属于 {}，不是 {date}",
                    cur.date
                )));
            }
            cur.date.clone()
        } else {
            date.to_string()
        };

        let pairs: Pairs = {
            let profile = self.ensure_guest().await?;
            let mut p = device_query_pairs(&Self::identity(&profile));
            p.push(("order_experiment".into(), "descend".into()));
            p.push(("offset".into(), cur.offset.to_string()));
            if !date.is_empty() {
                p.push(("target_date".into(), date.clone()));
            }
            p.push(("active_panel".into(), "5".into()));
            p.push(("session_id".into(), cur.session.clone()));
            p.push(("version".into(), "0".into()));
            p.push(("gender_type".into(), "2".into()));
            p.push(("tab_type".into(), "5".into()));
            p.push(("filter_type".into(), "gender".into()));
            p.push(("subscribe_list_opt".into(), "0".into()));
            p.push(("tab_style".into(), "2".into()));
            p.push(("need_calendar_schema".into(), "true".into()));
            p.push(("user_is_login".into(), "0".into()));
            p
        };
        let value = self
            .request(reqwest::Method::GET, PATH_SUBSCRIBE_LIST, pairs, None)
            .await?;
        let data = value.get("data").cloned().unwrap_or(Value::Null);
        let (default_date, dates, items) = parse_new_releases(&data);
        let has_more = data
            .get("has_more")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let next_offset = flex_i64(data.get("next_offset"));
        let session = flex_str(data.get("session_id"));
        let ids: Vec<String> = items.iter().map(|it| it.series.id.clone()).collect();

        let mut next = cur.clone();
        next.date = if date.is_empty() {
            default_date.clone()
        } else {
            date.clone()
        };
        let next_cursor = next_short_cursor(&next, has_more, next_offset, &session, &ids)?;

        Ok(NewReleasePage {
            date: if date.is_empty() { default_date } else { date },
            dates,
            items,
            has_more,
            next_cursor,
        })
    }

    /// 演员或角色的主页。`user_id` 是账号 id（演员榜上的 `UserID`），不是演员 id。
    pub async fn person(&self, user_id: &str) -> Result<Person> {
        self.with_fresh_device("演员主页", || self.person_once(user_id))
            .await
    }

    async fn person_once(&self, user_id: &str) -> Result<Person> {
        if !valid_series_id(user_id) {
            return Err(HongguoError::Other("无效的用户 ID".into()));
        }
        let pairs: Pairs = {
            let profile = self.ensure_guest().await?;
            let mut p = device_query_pairs(&Self::identity(&profile));
            p.push(("user_id".into(), user_id.into()));
            p.push(("user_is_login".into(), "0".into()));
            p
        };
        let value = self
            .request(reqwest::Method::GET, PATH_PROFILE, pairs, None)
            .await?;
        let person = parse_person(value.get("data").unwrap_or(&Value::Null));
        if person.name.is_empty() {
            return Err(HongguoError::ContentUnavailable("主页内容为空".into()));
        }
        Ok(person)
    }

    /// 某人参演的短剧（主页「作品 › 剧作」），一次一页。`cursor` 为上一页的游标。
    pub async fn person_works(&self, user_id: &str, cursor: Option<&str>) -> Result<WorkPage> {
        self.with_fresh_device("演员作品", || self.person_works_once(user_id, cursor))
            .await
    }

    async fn person_works_once(&self, user_id: &str, cursor: Option<&str>) -> Result<WorkPage> {
        if !valid_series_id(user_id) {
            return Err(HongguoError::Other("无效的用户 ID".into()));
        }
        let cur = decode_works_cursor(cursor.unwrap_or(""))?;
        if cursor.is_some_and(|c| !c.trim().is_empty()) && cur.user_id != user_id {
            return Err(HongguoError::Other("游标属于另一位用户".into()));
        }
        let body = serde_json::to_vec(&serde_json::json!({
            "comment_source": 1506,
            "count": 18,
            "cursor": cur.next,
            "extra_param": {"is_video_tab_comment": "1"},
            "locate_post_id": "",
            "profile_user_type": 0,
            "sort": "time_desc",
            "sub_tab_type": 22,
            "tab_type": 23,
            "target_user_id": user_id,
        }))
        .map_err(|e| HongguoError::Other(e.to_string()))?;
        let path = PATH_USER_WORKS_TEMPLATE.replace("{}", user_id);
        let pairs = {
            let profile = self.ensure_guest().await?;
            device_query_pairs(&Self::identity(&profile))
        };
        let value = self
            .request(reqwest::Method::POST, &path, pairs, Some(body))
            .await?;
        let (works, has_more, next) = parse_user_works(&value);
        let cursor = if has_more && !next.is_empty() && !works.is_empty() {
            Some(encode_works_cursor(&WorksCursor {
                user_id: user_id.to_string(),
                next,
            })?)
        } else {
            None
        };
        Ok(WorkPage {
            works,
            has_more,
            next_cursor: cursor,
        })
    }

    /// 逐页遍历书城的一个频道，并去掉跨页重复的短剧。`cursor` 为空表示从首屏开始。
    pub fn discover_pager(&self, channel: DiscoverChannel, cursor: Option<&str>) -> HitPager<'_> {
        HitPager::new(
            self,
            PagerSource::Discover(channel),
            cursor
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .map(str::to_string),
        )
    }

    /// 逐页遍历搜索结果，并去掉跨页重复的短剧。
    pub fn search_pager(&self, keyword: &str, opts: SearchOptions) -> HitPager<'_> {
        let cursor = opts
            .cursor
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .map(str::to_string);
        HitPager::new(
            self,
            PagerSource::Search {
                keyword: keyword.to_string(),
                opts,
            },
            cursor,
        )
    }

    async fn get_series_once(&self, series_id: &str) -> Result<(SeriesDetail, Vec<EpisodeHit>)> {
        let pairs: Pairs = {
            let profile = self.ensure_guest().await?;
            let mut p = device_query_pairs(&Self::identity(&profile));
            p.push(("series_id".into(), series_id.to_string()));
            p.push(("need_video_detail_info".into(), "true".into()));
            p
        };

        let value = self
            .request(reqwest::Method::GET, PATH_SERIES, pairs, None)
            .await?;

        let data = value
            .get("data")
            .ok_or_else(|| HongguoError::Other("详情响应缺 data".into()))?;
        let vd = data
            .get("video_data")
            .ok_or_else(|| HongguoError::Other("详情响应缺 video_data".into()))?;
        parse_series_video(vd)
    }

    /// 首页「推荐」频道。
    /// 首页某个短剧频道的第一页（频道见 [`DiscoverChannel`]）。
    /// 传 `cursor` 时只加载下一页，游标由上一页返回。
    pub async fn discover_page(
        &self,
        channel: DiscoverChannel,
        cursor: Option<&str>,
    ) -> Result<DiscoverPage> {
        self.with_fresh_device("发现流", || self.discover_page_once(channel, cursor))
            .await
    }

    async fn discover_page_once(
        &self,
        channel: DiscoverChannel,
        cursor: Option<&str>,
    ) -> Result<DiscoverPage> {
        if let Some(token) = cursor.map(str::trim).filter(|t| !t.is_empty()) {
            let next = FeedCursor::decode(token)?;
            if next.tab != channel.response_tab() {
                return Err(HongguoError::Other("发现页游标与频道不匹配".into()));
            }
            let more = self.cell_change(&next).await?;
            return Ok(more.into_page(next));
        }

        let pairs: Pairs = {
            let profile = self.ensure_guest().await?;
            let mut p = device_query_pairs(&Self::identity(&profile));
            p.push(("tab_type".into(), channel.request_tab().into()));
            p.push(("offset".into(), "0".into()));
            p.push(("client_req_type".into(), "3".into()));
            p.push(("bottom_tab_type".into(), channel.bottom_tab().into()));
            p.push(("bottom_tab_type_list".into(), "7,0,1,2,3,4".into()));
            p
        };
        let value = self
            .request(reqwest::Method::GET, PATH_DISCOVER, pairs, None)
            .await?;

        let hits = discover_first_page_hits(&value, channel.response_tab());

        // 首页自带的嵌套流才能续页；没有嵌套流时（找剧的双列页）只返回首屏。
        match discover_continuation(&value, channel.response_tab()) {
            Some(next) => {
                let more = self.cell_change(&next).await?;
                let mut page = more.into_page(next);
                let mut merged = hits;
                merged.extend(page.hits);
                page.hits = dedupe_hits(merged);
                Ok(page)
            }
            None => Ok(DiscoverPage {
                hits: dedupe_hits(hits),
                has_more: false,
                next_cursor: None,
            }),
        }
    }

    /// `cell/change` 的一页，参数顺序与 Go 的 `SignedCellChangePairs` 一致。
    async fn cell_change(&self, next: &FeedCursor) -> Result<CellChangePage> {
        let pairs: Pairs = {
            let profile = self.ensure_guest().await?;
            let mut p = device_query_pairs(&Self::identity(&profile));
            let offset = if next.offset <= 0 {
                "0".to_string()
            } else {
                next.offset.to_string()
            };
            p.push(("cell_id".into(), next.cell.clone()));
            p.push(("offset".into(), offset));
            p.push(("limit".into(), "20".into()));
            p.push(("change_type".into(), "0".into()));
            p.push(("tab_type".into(), next.tab.clone()));
            p.push(("show_type".into(), next.show.clone()));
            p.push(("client_req_type".into(), "2".into()));
            p.push(("session_id".into(), next.session.clone()));
            if !next.template.is_empty() {
                p.push(("client_template".into(), next.template.clone()));
            }
            p
        };
        let value = self
            .request(reqwest::Method::GET, PATH_CELL_CHANGE, pairs, None)
            .await?;
        let mut hits = Vec::new();
        collect_hits(&value, &mut hits, 0);
        let next_offset = flex_i64(value.get("next_offset"));
        let has_more = value
            .get("has_more")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        Ok(CellChangePage {
            hits,
            has_more,
            next_offset,
            session_id: flex_str(value.get("session_id")),
        })
    }
}

/// 发现页的一页结果。`next_cursor` 为 `None` 表示没有下一页。
#[derive(Debug, Clone, Default)]
pub struct DiscoverPage {
    pub hits: Vec<SeriesHit>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
}

/// 短剧筛选的一页结果。`next_cursor` 为 `None` 表示已到末尾。
#[derive(Debug, Clone, Default)]
pub struct ShortFilterResult {
    pub items: Vec<SeriesHit>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
    /// 实际生效的筛选（续页时可能沿用游标里记录的那组）。
    pub selections: BTreeMap<String, Vec<String>>,
}

/// 筛选面板的一行（如「题材」「排序」），`key` 即 [`SHORT_FILTER_KEYS`] 中的值。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FilterRow {
    pub key: String,
    pub name: String,
    pub options: Vec<FilterOption>,
}

/// 筛选行里的一个选项，`value` 是提交给 `select_items` 的 id。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FilterOption {
    pub name: String,
    pub value: String,
}

/// 解析 `only_panel` 返回的 `selector_rows`。没有 `type` 的行和没有 id 的选项会被丢弃。
fn parse_filter_rows(data: &Value) -> Vec<FilterRow> {
    let Some(rows) = data.get("selector_rows").and_then(Value::as_array) else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| {
            let key = flex_str(row.get("type"));
            if key.is_empty() {
                return None;
            }
            let options = row
                .get("items")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|it| {
                            let value = flex_str(it.get("selector_item_id"));
                            (!value.is_empty()).then(|| FilterOption {
                                name: flex_str(it.get("show_name")),
                                value,
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(FilterRow {
                key,
                name: flex_str(row.get("row_name")),
                options,
            })
        })
        .collect()
}

/// 短剧榜单的一个内容分类（如「真人剧」「漫剧」），`boards` 是它下面的榜单。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RankContent {
    pub id: String,
    pub name: String,
    pub selected: bool,
    pub boards: Vec<RankBoard>,
}

/// 某个内容分类下的一个榜单。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RankBoard {
    pub id: String,
    pub name: String,
    pub selected: bool,
}

/// 榜单中的一行。`position` 是页面顺序，从 1 开始。
#[derive(Debug, Clone, Default)]
pub struct RankItem {
    pub position: usize,
    pub series: SeriesHit,
    pub score: String,
    pub promoted: bool,
}

/// 短剧榜单的一页。`cursor` 为 `None` 表示已到末尾。
#[derive(Debug, Clone, Default)]
pub struct ShortRankResult {
    pub contents: Vec<RankContent>,
    pub items: Vec<RankItem>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
    pub content: String,
    pub board: String,
}

/// 星粉榜（活动榜单）的一页。
#[derive(Debug, Clone, Default)]
pub struct RankingPage {
    /// 本活动下所有榜单的目录。
    pub lists: Vec<RankListInfo>,
    /// 当前榜单的名字。
    pub list_name: String,
    pub items: Vec<ActorRankItem>,
    pub has_more: bool,
    pub next_offset: i64,
}

/// 榜单目录里的一项。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RankListInfo {
    pub id: String,
    pub name: String,
    pub shortlisted_number: i64,
}

/// 星粉榜中的一位演员（或作品）。
#[derive(Debug, Clone, Default)]
pub struct ActorRankItem {
    pub index: i64,
    pub vote_count: i64,
    pub actor_name: String,
    pub actor_avatar: String,
    /// 账号 id（`person` 的入参）。
    pub user_id: String,
    pub series: SeriesHit,
}

/// 解析活动榜单接口的 `data`。缺少 id 的榜单目录项和行会被跳过。
fn parse_ranking_page(data: &Value) -> RankingPage {
    let lists = data
        .pointer("/activity_basic/all_rank_list_basic")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|r| {
                    let id = flex_str(r.get("id"));
                    (!id.is_empty()).then(|| RankListInfo {
                        id,
                        name: flex_str(r.get("name")),
                        shortlisted_number: flex_i64(r.get("shortlisted_number")),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let items = data
        .pointer("/rank_list/items")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|it| ActorRankItem {
                    index: flex_i64(it.pointer("/rank_item_basic/index")),
                    vote_count: flex_i64(it.pointer("/rank_item_basic/vote_count")),
                    actor_name: flex_str(it.pointer("/actor_info/name")),
                    actor_avatar: flex_str(it.pointer("/actor_info/avatar")),
                    user_id: flex_str(it.pointer("/user_info/base_info/user_id")),
                    series: SeriesHit {
                        id: flex_str(it.pointer("/playlet_info/id")),
                        title: flex_str(it.pointer("/playlet_info/title")),
                        cover: flex_str(it.pointer("/playlet_info/cover")),
                        intro: String::new(),
                        episode_count: 0,
                        content_type: it.pointer("/playlet_info").and_then(card_content_type),
                    },
                })
                .collect()
        })
        .unwrap_or_default();

    RankingPage {
        lists,
        list_name: flex_str(data.pointer("/rank_list/rank_list_short_info/name")),
        items,
        has_more: data
            .pointer("/rank_list/turn_page_info/has_more")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        next_offset: flex_i64(data.pointer("/rank_list/turn_page_info/next_offset")),
    }
}

/// 搜索页的热搜：猜你想搜（`guesses`）与各个热搜榜（`boards`）。
#[derive(Debug, Clone, Default)]
pub struct HotSearch {
    pub guesses: Vec<HotItem>,
    pub boards: Vec<HotBoard>,
}

/// 热搜中的一部短剧。
#[derive(Debug, Clone, Default)]
pub struct HotItem {
    pub position: usize,
    pub series: SeriesHit,
    /// 封面链接的过期时间（Unix 秒）；取不到时为 0。
    pub cover_expires_at: i64,
    pub search_score: String,
    pub heat: String,
    pub tag: String,
}

/// 一个热搜榜，含短剧行与话题行。
#[derive(Debug, Clone, Default)]
pub struct HotBoard {
    pub name: String,
    pub items: Vec<HotItem>,
    pub topics: Vec<HotTopic>,
}

/// 热榜话题，`query` 是点击后打开的搜索词。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HotTopic {
    pub id: String,
    pub title: String,
    pub heat: String,
    pub query: String,
}

/// 从封面链接的 `x-expires` 参数读取过期时间；取不到或非正数时返回 0。
fn cover_expiry(raw: &str) -> i64 {
    query_param(raw, "x-expires")
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|&s| s > 0)
        .unwrap_or(0)
}

/// 取链接查询串里某个键的值（百分号解码，与 Go 的 `url.Query().Get` 一致）。
fn query_param(link: &str, key: &str) -> Option<String> {
    reqwest::Url::parse(link)
        .ok()?
        .query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
}

/// 解析 `lynx_data`：服务端可能给字符串（内含 JSON），也可能直接给数组。
fn parse_lynx_cells(value: &Value) -> Vec<Value> {
    let parsed = match value {
        Value::String(s) => serde_json::from_str::<Value>(s).ok(),
        other => Some(other.clone()),
    };
    match parsed {
        Some(Value::Array(cells)) => cells,
        _ => Vec::new(),
    }
}

/// 把一组热搜行转成 [`HotItem`]，跳过没有 id 的行。
fn hot_items(rows: &[Value]) -> Vec<HotItem> {
    let mut out: Vec<HotItem> = Vec::new();
    for r in rows {
        let id = flex_str(r.get("series_id"));
        if id.is_empty() {
            continue;
        }
        let cover = flex_str(r.get("cover"));
        out.push(HotItem {
            position: out.len() + 1,
            series: SeriesHit {
                id,
                title: flex_str(r.get("title")),
                cover: cover.clone(),
                intro: String::new(),
                episode_count: flex_i64(r.get("episode_cnt")).max(0) as u32,
                content_type: card_content_type(r),
            },
            cover_expires_at: cover_expiry(&cover),
            search_score: flex_str(r.get("card_tips")),
            heat: flex_str(r.get("rec_text")),
            tag: flex_str(r.pointer("/tag_info/text")),
        });
    }
    out
}

/// 解析搜索页 plan feed 的 `data`（各个 cell 的 `lynx_data`）。
fn parse_hot_search(data: &Value) -> HotSearch {
    let mut out = HotSearch::default();
    let cells = data.as_array().cloned().unwrap_or_default();
    for cell in &cells {
        for lynx in parse_lynx_cells(cell.get("lynx_data").unwrap_or(&Value::Null)) {
            let rows = lynx
                .get("video_data")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if !rows.is_empty() {
                out.guesses.extend(hot_items(&rows));
            }
            let boards = lynx
                .get("cell_data")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for board in &boards {
                let rows: Vec<Value> = board
                    .get("video_data")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let topics: Vec<HotTopic> = board
                    .get("video_topic")
                    .and_then(Value::as_array)
                    .map(|ts| {
                        ts.iter()
                            .map(|t| HotTopic {
                                id: flex_str(t.get("topic_id")),
                                title: flex_str(t.get("title")),
                                heat: flex_str(t.pointer("/secondary_info_list/0/content")),
                                query: query_param(&flex_str(t.get("url")), "directQueryWord")
                                    .unwrap_or_default(),
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let items = hot_items(&rows);
                if !items.is_empty() || !topics.is_empty() {
                    out.boards.push(HotBoard {
                        name: flex_str(board.get("cell_name")),
                        items,
                        topics,
                    });
                }
            }
        }
    }
    out
}

/// 相关推荐的一组：`cell_title` 是服务端给的标题，`session_id` 是该 cell 的会话。
#[derive(Debug, Clone, Default)]
pub struct Recommend {
    pub cell_title: String,
    pub session_id: String,
    pub items: Vec<SeriesHit>,
}

/// 详情页「相关视频」cell 的 `show_type`（与 Go 的 `ShowTypeDetailRelatedVideo` 一致）。
const PLAN_SHOW_TYPE_RELATED_VIDEO: i64 = 160;

/// 从 plan 响应里取相关推荐。优先取 `show_type == 160`；匿名时服务端会返回别的 cell 类型，
/// 此时退回第一个有内容的 cell。都没有时返回 `None`。
fn parse_recommend(data: &Value, top_session: &str) -> Option<Recommend> {
    let cells = data.as_array()?;
    let session = top_session.to_string();
    let pick = |cell: &Value| -> Option<Recommend> {
        let items =
            parse_flat_series_list(cell.get("video_data").or_else(|| cell.get("cell_data")));
        if items.is_empty() {
            return None;
        }
        let cell_session = flex_str(cell.get("session_id"));
        Some(Recommend {
            cell_title: flex_str(cell.get("cell_name")),
            session_id: if cell_session.is_empty() {
                session.clone()
            } else {
                cell_session
            },
            items,
        })
    };
    cells
        .iter()
        .filter(|c| flex_i64(c.get("show_type")) == PLAN_SHOW_TYPE_RELATED_VIDEO)
        .find_map(pick)
        .or_else(|| cells.iter().find_map(pick))
}

/// 上新日历的一项。`publish_at` 为 Unix 秒，取不到时为 0。
#[derive(Debug, Clone, Default)]
pub struct NewRelease {
    pub series: SeriesHit,
    pub online: bool,
    pub publish_at: i64,
    pub categories: Vec<String>,
    pub heat: String,
    pub note: String,
}

/// 上新日历的一页。`date` 是当前日期（YYYYMMDD），`dates` 是日历上可选的全部日期。
#[derive(Debug, Clone, Default)]
pub struct NewReleasePage {
    pub date: String,
    pub dates: Vec<String>,
    pub items: Vec<NewRelease>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
}

/// 校验 YYYYMMDD：8 位数字，且是合法日期。
fn valid_yyyymmdd(s: &str) -> bool {
    s.len() == 8 && chrono::NaiveDate::parse_from_str(s, "%Y%m%d").is_ok()
}

/// 解析上新日历的一页（与 Go 的 `ParseNewReleases` 对齐）。
/// 有 `subscribe_data` 的条目取其中的剧信息；否则取条目本身。没有 id 或标题的条目跳过。
fn parse_new_releases(data: &Value) -> (String, Vec<String>, Vec<NewRelease>) {
    let date = flex_str(data.pointer("/calendar_schema/default_date"));
    let dates = data
        .pointer("/calendar_schema/date_list")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|d| flex_str(Some(d)))
                .filter(|d| !d.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let rows = data
        .get("subscribe_items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut items = Vec::new();
    for it in &rows {
        let online = it
            .get("is_online")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let row = it.get("subscribe_data").filter(|v| v.is_object());
        let (id, title, description, cover, episode_count) = match row {
            Some(r) => (
                flex_str(r.get("series_id")),
                flex_str(r.get("title")),
                flex_str(r.get("video_desc")),
                flex_str(r.get("cover")),
                flex_i64(r.get("episode_cnt")).max(0) as u32,
            ),
            None => (
                flex_str(it.get("item_id")),
                flex_str(it.get("name")),
                flex_str(it.get("item_desc")),
                flex_str(it.get("cover")),
                0,
            ),
        };
        if id.is_empty() || id == "0" || title.trim().is_empty() {
            continue;
        }
        let when = {
            let s = flex_i64(it.get("schedule_publish_time"));
            if s == 0 {
                flex_i64(it.get("expected_publish_time"))
            } else {
                s
            }
        };
        let heat = if online {
            flex_str(it.pointer("/rec_tags/0/content"))
        } else {
            flex_str(it.get("expected_rec_text"))
        };
        items.push(NewRelease {
            series: SeriesHit {
                id,
                title,
                cover,
                intro: description,
                episode_count,
                // 已上线条目的标记在 subscribe_data 里（顶层与 video_detail 都有）；
                // 预告条目没有 subscribe_data，None = 无法判型。
                content_type: row.and_then(card_content_type),
            },
            online,
            publish_at: when.max(0),
            categories: it
                .get("categories")
                .and_then(Value::as_array)
                .map(|a| a.iter().map(|c| flex_str(Some(c))).collect())
                .unwrap_or_default(),
            heat,
            note: flex_str(it.get("sub_info")),
        });
    }
    (date, dates, items)
}

/// 演员或角色的主页。`user_id` 是账号 id（不是演员 id）。
#[derive(Debug, Clone, Default)]
pub struct Person {
    pub user_id: String,
    pub name: String,
    pub description: String,
    pub avatar_url: String,
    /// 主页头衔，如「女演员」「虚拟人物」。
    pub tags: Vec<String>,
    /// 名字下方的小徽标，如星座。
    pub labels: Vec<String>,
    pub followers: i64,
    pub likes: i64,
}

/// 解析主页接口的 `data.ugc_user`（与 Go 的 `ParseProfile` 对齐）。
fn parse_person(data: &Value) -> Person {
    let texts = |v: Option<&Value>| -> Vec<String> {
        v.and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .map(|t| flex_str(t.get("text")))
                    .filter(|t| !t.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    };
    let u = data.get("ugc_user").unwrap_or(&Value::Null);
    Person {
        user_id: flex_str(u.get("user_id")),
        name: flex_str(u.pointer("/base_info/user_name")),
        description: flex_str(u.pointer("/base_info/description")),
        avatar_url: flex_str(u.pointer("/base_info/user_avatar")),
        tags: texts(u.pointer("/user_tag/sub_title_list")),
        labels: texts(u.pointer("/user_expand/sub_title_list")),
        followers: flex_i64(u.pointer("/user_relation/fans_num")),
        likes: flex_i64(u.pointer("/user_relation/recv_digged_count")),
    }
}

/// 作品页的续页游标：记录用户 id（`u`）和服务端的下一页游标（`n`）。
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct WorksCursor {
    #[serde(rename = "u")]
    user_id: String,
    #[serde(rename = "n")]
    next: String,
}

const WORKS_CURSOR_PREFIX: &str = "w1.";

/// 编码作品游标为 `w1.` + base64url（无填充）的 JSON。
fn encode_works_cursor(cur: &WorksCursor) -> Result<String> {
    use base64::Engine;
    let raw = serde_json::to_vec(cur).map_err(|e| HongguoError::Other(e.to_string()))?;
    Ok(format!(
        "{WORKS_CURSOR_PREFIX}{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw)
    ))
}

/// 解码作品游标。空串为第一页，返回默认值；格式不对、用户 id 非数字或下一页游标为空都报错。
fn decode_works_cursor(token: &str) -> Result<WorksCursor> {
    use base64::Engine;
    if token.is_empty() {
        return Ok(WorksCursor::default());
    }
    let invalid = || HongguoError::Other("作品游标不合法".into());
    let payload = token
        .strip_prefix(WORKS_CURSOR_PREFIX)
        .ok_or_else(invalid)?;
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| invalid())?;
    let cur: WorksCursor = serde_json::from_slice(&raw).map_err(|_| invalid())?;
    if !cur.user_id.chars().all(|c| c.is_ascii_digit()) || cur.next.is_empty() {
        return Err(invalid());
    }
    Ok(cur)
}

/// 某人作品页的一页。`next_cursor` 为 `None` 表示已到末尾。
#[derive(Debug, Clone, Default)]
pub struct WorkPage {
    pub works: Vec<Work>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
}

/// 作品页里的一部作品。
#[derive(Debug, Clone, Default)]
pub struct Work {
    pub series: SeriesHit,
    pub cover_expires_at: i64,
    pub tags: Vec<String>,
    pub heat: i64,
    pub plays: i64,
}

/// 解析某人作品页（`commentapi/user/profile`）的一页，返回作品、是否还有更多、以及服务端的下一页游标。
fn parse_user_works(value: &Value) -> (Vec<Work>, bool, String) {
    let data = value.get("data").unwrap_or(&Value::Null);
    let rows = data
        .get("data_list")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut works = Vec::new();
    for row in &rows {
        let Some(v) = row.get("video").filter(|v| v.is_object()) else {
            continue;
        };
        let id = flex_str(v.get("video_id"));
        let title = flex_str(v.pointer("/common/title"));
        if id.is_empty() || title.trim().is_empty() {
            continue;
        }
        let cover = flex_str(v.pointer("/common/cover"));
        let tags = v
            .pointer("/expand/sub_title_list")
            .and_then(Value::as_array)
            .map(|ts| {
                ts.iter()
                    .map(|t| flex_str(t.get("text")))
                    .filter(|t| !t.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        works.push(Work {
            series: SeriesHit {
                id,
                title,
                cover: cover.clone(),
                intro: flex_str(v.pointer("/common/intro")),
                episode_count: flex_i64(v.pointer("/expand/episode_cnt")).max(0) as u32,
                content_type: card_content_type(v),
            },
            cover_expires_at: cover_expiry(&cover),
            tags,
            heat: flex_i64(v.pointer("/stat/hot")),
            plays: flex_i64(v.pointer("/stat/play_cnt")),
        });
    }
    let has_more = data
        .pointer("/common_list_info/has_more")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let next = flex_str(data.pointer("/common_list_info/cursor"));
    (works, has_more, next)
}

/// 跨页去重的翻页器（与 Go 的 `Pager` 一致）：`next` 只返回之前没见过的行。
/// 只含已知行的页会被自动跳过。
pub struct HitPager<'a> {
    client: &'a HongguoClient,
    source: PagerSource,
    next: Option<String>,
    seen: HashSet<String>,
    done: bool,
    /// 已拉取的页数。
    pub pages: usize,
}

enum PagerSource {
    Discover(DiscoverChannel),
    Search {
        keyword: String,
        opts: SearchOptions,
    },
}

impl<'a> HitPager<'a> {
    fn new(client: &'a HongguoClient, source: PagerSource, cursor: Option<String>) -> Self {
        Self {
            client,
            source,
            next: cursor,
            seen: HashSet::new(),
            done: false,
            pages: 0,
        }
    }

    /// 已返回的不同剧集数。
    pub fn seen(&self) -> usize {
        self.seen.len()
    }

    /// 加载下一页，返回之前没见过的行。`bool` 表示是否还有下一页。
    pub async fn next(&mut self) -> Result<(Vec<SeriesHit>, bool)> {
        while !self.done {
            let (items, has_more, cursor) = match &self.source {
                PagerSource::Discover(channel) => {
                    let page = self
                        .client
                        .discover_page(*channel, self.next.as_deref())
                        .await?;
                    (page.hits, page.has_more, page.next_cursor)
                }
                PagerSource::Search { keyword, opts } => {
                    let page = self
                        .client
                        .search_page(
                            keyword,
                            &SearchOptions {
                                cursor: self.next.clone(),
                                ..opts.clone()
                            },
                        )
                        .await?;
                    (page.hits, page.has_more, page.next_cursor)
                }
            };
            self.pages += 1;
            self.next = cursor;
            self.done = !has_more || self.next.as_deref().unwrap_or("").is_empty();
            let fresh: Vec<SeriesHit> = items
                .into_iter()
                .filter(|h| self.seen.insert(h.id.clone()))
                .collect();
            if !fresh.is_empty() || self.done {
                return Ok((fresh, !self.done));
            }
        }
        Ok((Vec::new(), false))
    }
}

/// 解析 `cell/change` 的短剧榜单页（与 Go 的 `ParseShortRank` 对齐，演员榜暂未处理）。
fn parse_short_rank(data: &Value) -> (Vec<RankContent>, Vec<RankItem>) {
    let contents = data
        .pointer("/cell_view/cell_selector/outer_row/items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|c| {
                    let id = flex_str(c.get("selector_item_id"));
                    if id.is_empty() {
                        return None;
                    }
                    let boards = c
                        .pointer("/sub_cell_selector/outer_row/items")
                        .and_then(Value::as_array)
                        .map(|bs| {
                            bs.iter()
                                .map(|b| RankBoard {
                                    id: flex_str(b.get("selector_item_id")),
                                    name: flex_str(b.get("show_name")),
                                    selected: b
                                        .get("is_selected")
                                        .and_then(Value::as_bool)
                                        .unwrap_or(false),
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(RankContent {
                        id,
                        name: flex_str(c.get("show_name")),
                        selected: c
                            .get("is_selected")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        boards,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let mut items = Vec::new();
    let cells = data
        .pointer("/cell_view/cell_data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for cell in &cells {
        let videos = cell
            .get("video_data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for v in &videos {
            let id = flex_str(v.get("series_id"));
            let title = flex_str(v.get("title"));
            if id.is_empty() || title.is_empty() {
                continue;
            }
            let score = flex_str(v.pointer("/rec_text_item/RecommendText"));
            items.push(RankItem {
                position: items.len() + 1,
                series: SeriesHit {
                    id,
                    title,
                    cover: flex_str(v.get("cover")),
                    intro: String::new(),
                    episode_count: flex_i64(v.get("episode_cnt")).max(0) as u32,
                    content_type: card_content_type(v),
                },
                promoted: score == PROMOTED_TEXT,
                score,
            });
        }
    }
    (contents, items)
}

/// 服务端把这段文字插在榜单里时，表示该行是平台推荐而非真实排名。
const PROMOTED_TEXT: &str = "平台推荐";

/// 校验筛选项：行 key 必须在 [`SHORT_FILTER_KEYS`] 内，且每个值都不能是空白。
fn validate_short_filter_selections(selections: &BTreeMap<String, Vec<String>>) -> Result<()> {
    for (key, values) in selections {
        if !SHORT_FILTER_KEYS.contains(&key.as_str()) {
            return Err(HongguoError::Other(format!("未知的筛选行：{key}")));
        }
        if values.iter().any(|v| v.trim().is_empty()) {
            return Err(HongguoError::Other(format!("筛选行 {key} 的值为空")));
        }
    }
    Ok(())
}

/// 短剧筛选的请求体（只要内容，不要面板）。`select_items` 按 [`SHORT_FILTER_KEYS`] 的固定顺序给出，
/// 缺省的行为空数组。`filter_ids` 是游标里记录的已展示剧 id，服务端据此去重。
fn build_short_filter_body(
    scene: &str,
    selections: &BTreeMap<String, Vec<String>>,
    cur: &ShortCursor,
) -> Result<Vec<u8>> {
    let select_items: BTreeMap<String, Vec<String>> = SHORT_FILTER_KEYS
        .iter()
        .map(|k| {
            (
                (*k).to_string(),
                selections.get(*k).cloned().unwrap_or_default(),
            )
        })
        .collect();
    serde_json::to_vec(&serde_json::json!({
        "filter_ids": cur.seen.join(","),
        "req_scene": scene,
        "offset": cur.offset,
        "limit": 18,
        "need_selector_panel": false,
        "select_items": select_items,
        "session_id": cur.session,
        "req_type": "only_content",
    }))
    .map_err(|e| HongguoError::Other(e.to_string()))
}

/// 解析扁平的剧集数组（筛选、排行等接口的 `video_data`）。
/// 字段与找剧卡片一致：id 取 `series_id_str` 或 `series_id`，标题取 `series_title` 或 `title`。
/// 缺 id 或标题的条目跳过，结果按 id 去重。
fn parse_flat_series_list(raw: Option<&Value>) -> Vec<SeriesHit> {
    let Some(rows) = raw.and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for row in rows {
        let id = {
            let a = flex_str(row.get("series_id_str"));
            if a.is_empty() {
                flex_str(row.get("series_id"))
            } else {
                a
            }
        };
        let title = {
            let a = flex_str(row.get("series_title"));
            if a.is_empty() {
                flex_str(row.get("title"))
            } else {
                a
            }
        };
        if id.is_empty() || title.is_empty() {
            continue;
        }
        let count = {
            let cnt = flex_i64(row.get("episode_cnt"));
            if cnt > 0 {
                cnt
            } else {
                row.get("video_list")
                    .and_then(|l| l.as_array())
                    .map(|l| l.len() as i64)
                    .unwrap_or(0)
            }
        }
        .max(0) as u32;
        let cover = {
            let a = card_cover(row);
            if a.is_empty() {
                flex_str(row.get("horiz_cover"))
            } else {
                a
            }
        };
        let intro = {
            let a = flex_str(row.get("series_intro"));
            if a.is_empty() {
                flex_str(row.get("video_desc"))
            } else {
                a
            }
        };
        out.push(SeriesHit {
            id,
            title,
            cover,
            intro,
            episode_count: count,
            content_type: card_content_type(row),
        });
    }
    dedupe_hits(out)
}

/// `cell/change` 的一页原始结果，尚未拼成对外的 [`DiscoverPage`]。
struct CellChangePage {
    hits: Vec<SeriesHit>,
    has_more: bool,
    next_offset: i64,
    session_id: String,
}

impl CellChangePage {
    /// 与 Go 的 `finishDiscover` 一致：只有确实前进且有内容时才给下一页游标。
    fn into_page(self, mut next: FeedCursor) -> DiscoverPage {
        let has_next = self.has_more && self.next_offset > 0 && !self.hits.is_empty();
        if !has_next {
            return DiscoverPage {
                hits: dedupe_hits(self.hits),
                has_more: false,
                next_cursor: None,
            };
        }
        if !self.session_id.is_empty() {
            next.session = self.session_id;
        }
        next.offset = self.next_offset;
        DiscoverPage {
            hits: dedupe_hits(self.hits),
            has_more: true,
            next_cursor: Some(next.encode()),
        }
    }
}

/// 发现页频道。只开放短剧相关的频道；书城内容（小说、听书、社区、经典等）不接入。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DiscoverChannel {
    /// 推荐（默认）。
    #[default]
    Recommend,
    /// 真人剧。
    LiveDrama,
    /// 漫剧。
    Comic,
    /// 首页真人剧。
    HomeLiveDrama,
    /// 首页漫剧。
    HomeComic,
    /// 找剧（双列页，没有嵌套流，只有首屏）。
    FindDrama,
}

impl DiscoverChannel {
    /// 请求用的 `tab_type`，与 Go 的 `ResolveDiscoverChannel` 一致。
    fn request_tab(self) -> &'static str {
        match self {
            DiscoverChannel::Recommend => "-1",
            DiscoverChannel::LiveDrama => "39",
            DiscoverChannel::Comic => "36",
            DiscoverChannel::HomeLiveDrama => "38",
            DiscoverChannel::HomeComic => "32",
            DiscoverChannel::FindDrama => "8",
        }
    }

    /// 响应里对应的 tab 编号（用于校验游标）。推荐页的响应 tab 是 16。
    fn response_tab(self) -> &'static str {
        match self {
            DiscoverChannel::Recommend => "16",
            DiscoverChannel::LiveDrama => "39",
            DiscoverChannel::Comic => "36",
            DiscoverChannel::HomeLiveDrama => "38",
            DiscoverChannel::HomeComic => "32",
            DiscoverChannel::FindDrama => "8",
        }
    }

    /// 底部导航 tab，找剧与首页频道为 0，其余为 7。
    fn bottom_tab(self) -> &'static str {
        match self {
            DiscoverChannel::Recommend | DiscoverChannel::LiveDrama | DiscoverChannel::Comic => "7",
            _ => "0",
        }
    }
}

/// 发现页的续页游标，字段与 Go 的 `feedCursor` 一一对应（JSON 键 `cell/session/template/show/tab/offset`）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FeedCursor {
    pub cell: String,
    pub session: String,
    pub template: String,
    pub show: String,
    pub tab: String,
    pub offset: i64,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct FeedCursorWire {
    cell: String,
    session: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    template: String,
    show: String,
    tab: String,
    offset: i64,
}

impl FeedCursor {
    /// 编码为 `d1.` 前缀加 base64url（无填充）的 JSON，与 Go 的 `EncodeFeedCursor` 一致。
    pub fn encode(&self) -> String {
        use base64::Engine;
        let wire = FeedCursorWire {
            cell: self.cell.clone(),
            session: self.session.clone(),
            template: self.template.clone(),
            show: self.show.clone(),
            tab: self.tab.clone(),
            offset: self.offset,
        };
        let json = serde_json::to_vec(&wire).unwrap_or_default();
        format!(
            "d1.{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)
        )
    }

    /// 解码并校验：前缀、base64、JSON、数字字段与会话都必须合法。
    pub fn decode(token: &str) -> Result<Self> {
        use base64::Engine;
        let invalid = || HongguoError::Other("发现页游标不合法".into());
        let payload = token.strip_prefix("d1.").ok_or_else(invalid)?;
        if payload.is_empty() {
            return Err(invalid());
        }
        let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload)
            .map_err(|_| invalid())?;
        let wire: FeedCursorWire = serde_json::from_slice(&raw).map_err(|_| invalid())?;
        let digits = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
        if wire.offset <= 0
            || !digits(&wire.cell)
            || !digits(&wire.tab)
            || !digits(&wire.show)
            || wire.session.is_empty()
            || wire.session.contains(['\r', '\n'])
        {
            return Err(invalid());
        }
        Ok(FeedCursor {
            cell: wire.cell,
            session: wire.session,
            template: wire.template,
            show: wire.show,
            tab: wire.tab,
            offset: wire.offset,
        })
    }
}

/// 首页首屏的剧集卡：只沿命中的响应 tab，取 `cell_data[].video_data[]`。
/// 规则与 Go 的 `appendCatalogCell` 一致：id 与标题都要有，集数优先 `episode_cnt`。
/// 不收 `book_data`（书城内容）；没有 `video_data` 的运营位（如金刚位）直接跳过。
fn discover_first_page_hits(value: &Value, response_tab: &str) -> Vec<SeriesHit> {
    let mut out = Vec::new();
    let Some(tabs) = value
        .get("data")
        .and_then(|d| d.get("tab_item"))
        .and_then(|t| t.as_array())
    else {
        return out;
    };
    for tab in tabs {
        if flex_i64(tab.get("tab_type")).to_string() != response_tab {
            continue;
        }
        let Some(cells) = tab.get("cell_data").and_then(|c| c.as_array()) else {
            continue;
        };
        for cell in cells {
            // 嵌套层：cell.cell_data[] 里才是 video_data 所在的卡片组。
            let Some(groups) = cell.get("cell_data").and_then(|c| c.as_array()) else {
                continue;
            };
            let cards: Vec<&Value> = groups
                .iter()
                .filter_map(|g| g.get("video_data").and_then(|v| v.as_array()))
                .flatten()
                .collect();
            for card in cards {
                let id = {
                    let a = flex_str(card.get("series_id_str"));
                    if a.is_empty() {
                        flex_str(card.get("series_id"))
                    } else {
                        a
                    }
                };
                // 两种形状：带 video_detail 的（搜索/剧集卡）与扁平的（找剧卡：
                // title / episode_cnt / cover 直接挂在卡片顶层）。
                let vd = card.get("video_detail").filter(|v| v.is_object());
                let title = vd
                    .map(|v| flex_str(v.get("series_title")))
                    .filter(|t| !t.is_empty())
                    .unwrap_or_else(|| flex_str(card.get("title")));
                if id.is_empty() || title.is_empty() {
                    continue;
                }
                // 有 video_detail 时字段在里面（与 Go 的 appendCatalogCell 一致），
                // 否则字段在卡片顶层。集数为 0 时退回 video_list 长度。
                let src = vd.unwrap_or(card);
                let count = {
                    let cnt = flex_i64(src.get("episode_cnt"));
                    if cnt > 0 {
                        cnt
                    } else {
                        src.get("video_list")
                            .and_then(|l| l.as_array())
                            .map(|l| l.len() as i64)
                            .unwrap_or(0)
                    }
                }
                .max(0) as u32;
                let cover = {
                    let a = card_cover(src);
                    if a.is_empty() {
                        flex_str(card.get("horiz_cover"))
                    } else {
                        a
                    }
                };
                let intro = {
                    let a = flex_str(src.get("series_intro"));
                    if a.is_empty() {
                        flex_str(src.get("video_desc"))
                    } else {
                        a
                    }
                };
                out.push(SeriesHit {
                    id,
                    title,
                    cover,
                    intro,
                    episode_count: count,
                    // 卡片顶层或 video_detail 内都可能有标记（发现页两种写法并存）。
                    content_type: card_content_type(card),
                });
            }
        }
    }
    dedupe_hits(out)
}

/// 从首页 `tab_item[]` 里找出续页用的 cell：带嵌套卡片的 cell 优先，
/// 否则退回没有嵌套的 cell（找剧）。与 Go 的 `DiscoverContinuationTab` 一致。
fn discover_continuation(value: &Value, response_tab: &str) -> Option<FeedCursor> {
    let tabs = value.get("data")?.get("tab_item")?.as_array()?;
    let mut fallback: Option<FeedCursor> = None;
    for tab in tabs {
        let tab_type = flex_i64(tab.get("tab_type")).to_string();
        let session = flex_str(tab.get("session_id"));
        if tab_type != response_tab || session.is_empty() {
            continue;
        }
        let template = flex_i64(tab.get("client_template"));
        for cell in tab.get("cell_data")?.as_array()? {
            let cell_id = flex_str(cell.get("cell_id_str").or_else(|| cell.get("cell_id")));
            let show = flex_i64(cell.get("show_type"));
            if cell_id.is_empty() || show == 0 {
                continue;
            }
            let next = FeedCursor {
                cell: cell_id,
                session: session.clone(),
                template: if template > 0 {
                    template.to_string()
                } else {
                    String::new()
                },
                show: show.to_string(),
                tab: tab_type.clone(),
                offset: 0,
            };
            let nested = cell
                .get("cell_data")
                .and_then(|c| c.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(false);
            if nested {
                return Some(next);
            }
            if fallback.is_none() {
                fallback = Some(next);
            }
        }
    }
    fallback
}

/// 解析搜索框提示词：取 `data_v1[].text`，去空白、去空、去重，保持服务端顺序。
fn parse_cue_texts(value: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(rows) = value.get("data_v1").and_then(|v| v.as_array()) {
        for row in rows {
            let text = flex_str(row.get("text"));
            if !text.is_empty() && !out.iter().any(|existing| existing == &text) {
                out.push(text);
            }
        }
    }
    out
}

/// 解析一部短剧的 `video_data`（详情与批量详情共用）：详情字段加上全部分集。
/// 缺 id 或标题视为内容不可用。
fn parse_series_video(vd: &Value) -> Result<(SeriesDetail, Vec<EpisodeHit>)> {
    let id = {
        let a = flex_str(vd.get("series_id_str"));
        if a.is_empty() {
            flex_str(vd.get("series_id"))
        } else {
            a
        }
    };
    let title = flex_str(vd.get("series_title"));
    if id.is_empty() || title.is_empty() {
        return Err(HongguoError::ContentUnavailable(
            "详情缺少剧集 id 或标题".into(),
        ));
    }

    let series = SeriesDetail {
        hit: SeriesHit {
            id: id.clone(),
            title,
            cover: flex_str(vd.get("series_cover")),
            intro: flex_str(vd.get("series_intro")),
            episode_count: flex_i64(vd.get("episode_cnt")).max(0) as u32,
            content_type: card_content_type(vd),
        },
        status: flex_i64(vd.get("series_status")),
        pay_type: flex_i64(vd.get("pay_info").and_then(|p| p.get("pay_type"))),
        age_gate: flex_i64(vd.get("age_gate_info").and_then(|a| a.get("age_gate"))),
        is_multi_season: flex_bool(vd.get("is_multi_season")),
        right_text: flex_str(vd.get("episode_right_text")),
        play_count: flex_i64(vd.get("series_play_cnt")),
        follow_count: flex_i64(vd.get("followed_cnt")),
        digg_count: flex_i64(vd.get("digg_cnt")),
        created_at: flex_i64(vd.get("create_time")),
    };

    let mut episodes = Vec::new();
    if let Some(list) = vd.get("video_list").and_then(|v| v.as_array()) {
        for (idx, ep) in list.iter().enumerate() {
            let eid = flex_str(ep.get("vid"));
            if eid.is_empty() {
                continue;
            }
            // 集号从 1 开始：上游 vid_index 有时是 0 基
            let number = {
                let n = flex_i64(ep.get("vid_index"));
                if n > 0 {
                    n as u32
                } else {
                    (idx + 1) as u32
                }
            };
            episodes.push(EpisodeHit {
                id: eid,
                series_id: id.clone(),
                number,
                title: flex_str(ep.get("title")),
                duration_seconds: flex_f64(ep.get("duration")),
                cover: {
                    let a = flex_str(ep.get("episode_cover"));
                    if a.is_empty() {
                        flex_str(ep.get("cover"))
                    } else {
                        a
                    }
                },
            });
        }
    }
    Ok((series, episodes))
}

/// 按 `video_detail`/`series_id` 去重，保留首次出现的顺序。
fn dedupe_hits(hits: Vec<SeriesHit>) -> Vec<SeriesHit> {
    let mut seen = std::collections::HashSet::new();
    hits.into_iter()
        .filter(|h| seen.insert(h.id.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_video_data_shape() {
        let v: Value = serde_json::from_str(
            r#"{"search_tabs":[{"tab_type":11,"data":[{"video_data":[{"series_id":"111","video_detail":{"series_title":"测试剧","series_intro":"简介","episode_cnt":12}}]}]}]}"#,
        )
        .unwrap();
        let mut hits = Vec::new();
        collect_hits(&v, &mut hits, 0);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "111");
        assert_eq!(hits[0].title, "测试剧");
        assert_eq!(hits[0].episode_count, 12);
    }

    #[test]
    fn dedupes_same_series() {
        let v: Value = serde_json::from_str(
            r#"[{"series_id":"9","video_detail":{"series_title":"A"}},{"series_id":"9","video_detail":{"series_title":"A"}}]"#,
        )
        .unwrap();
        let mut hits = Vec::new();
        collect_hits(&v, &mut hits, 0);
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn search_tab_maps_to_go_tab_types() {
        assert_eq!(SearchTab::Overall.tab_type(), "11");
        assert_eq!(SearchTab::Series.tab_type(), "29");
        assert_eq!(SearchTab::Video.tab_type(), "30");
        assert_eq!(SearchTab::Discussion.tab_type(), "31");
    }

    #[test]
    fn search_filters_only_on_overall_tab() {
        let f = vec![SEARCH_FILTER_COMIC.to_string()];
        assert!(validate_search_filters(SearchTab::Series, &f).is_err());
        assert_eq!(
            validate_search_filters(SearchTab::Overall, &f).unwrap(),
            vec![SEARCH_FILTER_COMIC.to_string()]
        );
    }

    #[test]
    fn search_filters_reject_unknown_and_dedupe() {
        let unknown = vec!["content_type_novel".to_string()];
        assert!(validate_search_filters(SearchTab::Overall, &unknown).is_err());

        let dup = vec![
            SEARCH_FILTER_SHORT_PLAY.to_string(),
            SEARCH_FILTER_COMIC.to_string(),
            SEARCH_FILTER_SHORT_PLAY.to_string(),
        ];
        let out = validate_search_filters(SearchTab::Overall, &dup).unwrap();
        assert_eq!(
            out,
            vec![
                SEARCH_FILTER_SHORT_PLAY.to_string(),
                SEARCH_FILTER_COMIC.to_string()
            ]
        );
    }

    #[test]
    fn search_paging_reads_matching_tab_only() {
        let v: Value = serde_json::from_str(
            r#"{"search_tabs":[
                {"tab_type":11,"has_more":true,"next_offset":20},
                {"tab_type":29,"has_more":false,"next_offset":5}
            ]}"#,
        )
        .unwrap();
        assert_eq!(search_tab_paging(&v, "11"), (true, 20));
        assert_eq!(search_tab_paging(&v, "29"), (false, 5));
        assert_eq!(search_tab_paging(&v, "30"), (false, 0));
    }

    #[test]
    fn search_hits_follow_requested_tab() {
        let v: Value = serde_json::from_str(
            r#"{"search_tabs":[
                {"tab_type":11,"data":[{"video_data":[{"series_id":"111","video_detail":{"series_title":"短剧甲"}}]}]},
                {"tab_type":29,"data":[{"video_data":[{"series_id":"222","video_detail":{"series_title":"剧集乙"}}]}]}
            ]}"#,
        )
        .unwrap();
        let overall = parse_search_hits(&v, "11");
        assert_eq!(overall.len(), 1);
        assert_eq!(overall[0].id, "111");

        let series = parse_search_hits(&v, "29");
        assert_eq!(series.len(), 1);
        assert_eq!(series[0].id, "222");
    }

    #[test]
    fn valid_series_id_requires_4_to_25_digits() {
        assert!(valid_series_id("7698294694886788121"));
        assert!(valid_series_id("1234"));
        assert!(!valid_series_id("123"));
        assert!(!valid_series_id(&"1".repeat(26)));
        assert!(!valid_series_id("12a4"));
        assert!(!valid_series_id(""));
    }

    #[test]
    fn series_batch_chunks_by_batch_size() {
        let ids: Vec<String> = (0..25).map(|i| format!("{:08}", 10_000_000 + i)).collect();
        let sizes: Vec<usize> = ids.chunks(SERIES_BATCH_SIZE).map(|c| c.len()).collect();
        assert_eq!(sizes, vec![10, 10, 5]);
    }

    #[test]
    fn series_batch_payload_parses_each_video_data() {
        // 批量响应的 data 以 series_id 为键，每项内有 video_data，与单部详情的结构一致。
        let v: Value = serde_json::from_str(
            r#"{"data":{
                "111":{"video_data":{"series_id_str":"111","series_title":"甲","episode_cnt":3,
                    "video_list":[{"vid":"e1"},{"vid":"e2"},{"vid":"e3"}]}},
                "222":{"video_data":{"series_id_str":"222","series_title":"乙","episode_cnt":0}}
            }}"#,
        )
        .unwrap();
        let map = v["data"].as_object().unwrap();
        let mut parsed: Vec<(String, usize)> = map
            .values()
            .map(|p| {
                let (d, eps) = parse_series_video(&p["video_data"]).unwrap();
                (d.hit.id, eps.len())
            })
            .collect();
        parsed.sort();
        assert_eq!(parsed, vec![("111".into(), 3), ("222".into(), 0)]);
    }

    #[test]
    fn cue_texts_trim_drop_empty_and_dedupe_in_order() {
        let v: Value = serde_json::from_str(
            r#"{"data_v1":[
                {"text":"  书名  "},
                {"text":""},
                {"text":"主角"},
                {"text":"书名"},
                {"text":"作者"}
            ]}"#,
        )
        .unwrap();
        assert_eq!(parse_cue_texts(&v), vec!["书名", "主角", "作者"]);
    }

    #[test]
    fn short_filter_body_lists_all_keys_in_order() {
        let mut sel = BTreeMap::new();
        sel.insert("genre".to_string(), vec!["comic_series".to_string()]);
        let body = build_short_filter_body("comic_series", &sel, &ShortCursor::default()).unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        let items = v["select_items"].as_object().unwrap();
        assert_eq!(items.len(), SHORT_FILTER_KEYS.len());
        assert_eq!(items["genre"], serde_json::json!(["comic_series"]));
        // 未选的行为空数组，而不是缺键
        assert_eq!(items["sort"], serde_json::json!([]));
        assert_eq!(v["req_type"], "only_content");
        assert_eq!(v["req_scene"], "comic_series");
    }

    #[test]
    fn short_filter_body_carries_seen_ids_from_cursor() {
        let cur = ShortCursor {
            offset: 18,
            seen: vec!["111".into(), "222".into()],
            session: "S".into(),
            ..Default::default()
        };
        let body = build_short_filter_body("default", &BTreeMap::new(), &cur).unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["filter_ids"], "111,222");
        assert_eq!(v["offset"], 18);
        assert_eq!(v["session_id"], "S");
    }

    #[test]
    fn ranking_page_reads_lists_and_actors() {
        let data = serde_json::json!({
            "activity_basic": {"all_rank_list_basic": [
                {"id": "l1", "name": "总榜", "shortlisted_number": 50},
                {"id": "", "name": "无 id"}
            ]},
            "rank_list": {
                "rank_list_short_info": {"id": "l1", "name": "总榜"},
                "items": [{
                    "rank_item_basic": {"index": 1, "vote_count": 120},
                    "actor_info": {"name": "演员甲", "avatar": "a"},
                    "playlet_info": {"id": "123456", "title": "剧甲", "cover": "c"}
                }],
                "turn_page_info": {"has_more": true, "next_offset": 20}
            }
        });
        let page = parse_ranking_page(&data);
        assert_eq!(page.lists.len(), 1);
        assert_eq!(page.list_name, "总榜");
        assert_eq!(page.items[0].actor_name, "演员甲");
        assert_eq!(page.items[0].series.id, "123456");
        assert!(page.has_more);
        assert_eq!(page.next_offset, 20);
    }

    #[test]
    fn works_cursor_round_trips_and_rejects_bad_tokens() {
        let cur = WorksCursor {
            user_id: "123456".into(),
            next: "n1".into(),
        };
        let token = encode_works_cursor(&cur).unwrap();
        assert!(token.starts_with("w1."));
        assert_eq!(decode_works_cursor(&token).unwrap(), cur);
        assert!(decode_works_cursor("").unwrap().next.is_empty());
        assert!(decode_works_cursor("w2.abc").is_err());
        assert!(decode_works_cursor("w1.!!!").is_err());
    }

    #[test]
    fn user_works_parse_skips_rows_without_id_or_title() {
        let value = serde_json::json!({
            "data": {
                "data_list": [
                    {"video": {"video_id": "555", "common": {"title": "作品甲", "intro": "i",
                        "cover": "https://x/c.jpg?x-expires=1800000000"},
                     "stat": {"hot": 10, "play_cnt": 99},
                     "expand": {"episode_cnt": 20, "sub_title_list": [{"text": "标签"}]}}},
                    {"video": {"video_id": "", "common": {"title": "无 id"}}},
                    {"video": null}
                ],
                "common_list_info": {"cursor": "n2", "has_more": true}
            }
        });
        let (works, has_more, next) = parse_user_works(&value);
        assert_eq!(works.len(), 1);
        assert_eq!(works[0].series.episode_count, 20);
        assert_eq!(works[0].cover_expires_at, 1_800_000_000);
        assert_eq!(works[0].tags, vec!["标签"]);
        assert_eq!(works[0].plays, 99);
        assert!(has_more);
        assert_eq!(next, "n2");
    }

    #[test]
    fn hot_search_parses_lynx_string_and_topics() {
        let inner = serde_json::json!([{
            "cell_name": "热搜",
            "video_data": [{"series_id": "777", "title": "猜你想看", "cover": "c",
                            "rec_text": "热度 1", "card_tips": "tip", "tag_info": {"text": "新"}}],
            "cell_data": [{
                "cell_name": "短剧热搜榜",
                "video_data": [{"series_id": "888", "title": "榜一"}],
                "video_topic": [{"topic_id": "t1", "title": "话题",
                                 "url": "dragon8662://search?directQueryWord=%E5%89%A7",
                                 "secondary_info_list": [{"content": "热度 9"}]}]
            }]
        }]);
        let data = serde_json::json!([{ "lynx_data": inner.to_string() }]);
        let hot = parse_hot_search(&data);
        assert_eq!(hot.guesses.len(), 1);
        assert_eq!(hot.guesses[0].tag, "新");
        assert_eq!(hot.boards.len(), 1);
        assert_eq!(hot.boards[0].items[0].series.id, "888");
        assert_eq!(hot.boards[0].topics[0].heat, "热度 9");
        // 百分号编码按 URL 规则解码（与 Go 的 url.Query().Get 一致）。
        assert_eq!(hot.boards[0].topics[0].query, "剧");
    }

    #[test]
    fn short_rank_parses_contents_boards_and_promoted_rows() {
        let data = serde_json::json!({
            "cell_view": {
                "cell_selector": {"outer_row": {"items": [
                    {"selector_item_id": "human", "show_name": "真人剧", "is_selected": true,
                     "sub_cell_selector": {"outer_row": {"items": [
                         {"selector_item_id": "human_hot_play", "show_name": "热播", "is_selected": true}
                     ]}}}
                ]}},
                "cell_data": [{"video_data": [
                    {"series_id": "1234567890", "title": "甲", "cover": "c", "episode_cnt": 80,
                     "rec_text_item": {"RecommendText": "热度 9.1"}},
                    {"series_id": "2222222222", "title": "乙", "episode_cnt": 3,
                     "rec_text_item": {"RecommendText": "平台推荐"}},
                    {"series_id": "", "title": "无 id"}
                ]}]
            }
        });
        let (contents, items) = parse_short_rank(&data);
        assert_eq!(contents.len(), 1);
        assert!(contents[0].selected);
        assert_eq!(contents[0].boards[0].id, "human_hot_play");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].series.id, "1234567890");
        assert_eq!(items[0].series.episode_count, 80);
        assert!(!items[0].promoted);
        assert!(items[1].promoted);
    }

    #[test]
    fn channel_accepts_gates_live_and_comic() {
        use super::content_type;
        // 真人频道：放行 1，拦下漫剧；漫剧频道反之。
        assert!(super::channel_accepts("drama", Some(content_type::LIVE)));
        assert!(!super::channel_accepts("drama", Some(content_type::COMIC)));
        assert!(super::channel_accepts("comic", Some(content_type::COMIC)));
        assert!(!super::channel_accepts("comic", Some(content_type::LIVE)));
        // 1002（未上线）两边都拦：无法判型的内容不能进任何纯频道。
        assert!(!super::channel_accepts("drama", Some(1002)));
        assert!(!super::channel_accepts("comic", Some(1002)));
        // 缺标记放行：过滤只拦"确证串味"，不惩罚没标记的源。
        assert!(super::channel_accepts("drama", None));
        assert!(super::channel_accepts("comic", None));
        // adult / anime 是聚合或独立源，不按红果口径过滤。
        assert!(super::channel_accepts("adult", Some(content_type::COMIC)));
        assert!(super::channel_accepts("anime", Some(content_type::LIVE)));
    }

    #[test]
    fn short_rank_items_carry_content_type() {
        let data = serde_json::json!({
            "cell_view": {
                "cell_data": [{"video_data": [
                    {"series_id": "1234567890", "title": "真人剧", "content_type": 1},
                    {"series_id": "2222222222", "title": "漫剧", "content_type": 1004},
                    {"series_id": "3333333333", "title": "老结构无标记"}
                ]}]
            }
        });
        let (_, items) = parse_short_rank(&data);
        assert_eq!(items[0].series.content_type, Some(1));
        assert_eq!(items[1].series.content_type, Some(1004));
        assert_eq!(items[2].series.content_type, None);
    }

    #[test]
    fn new_releases_carry_content_type_from_subscribe_data() {
        let data = serde_json::json!({
            "calendar_schema": {"default_date": "20261107", "date_list": ["20261107"]},
            "subscribe_items": [
                {"is_online": true, "subscribe_data": {
                    "series_id": "1234567890", "title": "真人剧", "content_type": 1
                }},
                {"is_online": true, "subscribe_data": {
                    "series_id": "2222222222", "title": "漫剧", "content_type": 1004
                }},
                // 预告条目：没有 subscribe_data，无法判型（宁可缺不可猜）。
                {"is_online": false, "item_id": "3333333333", "name": "预告剧"}
            ]
        });
        let (_, _, items) = parse_new_releases(&data);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].series.content_type, Some(1));
        assert_eq!(items[1].series.content_type, Some(1004));
        assert_eq!(items[2].series.content_type, None);
    }

    #[test]
    fn discover_hits_carry_content_type_from_nested_video_detail() {
        let value = serde_json::json!({
            "data": {"tab_item": [
                {"tab_type": 39, "cell_data": [
                    {"cell_data": [
                        {"video_data": [{"series_id_str": "1234567890", "title": "真人剧",
                                          "content_type": 1}]},
                        // 标记在 video_detail 内的写法（发现页两种形状并存）。
                        {"video_data": [{"series_id_str": "2222222222", "title": "漫剧",
                                          "video_detail": {"content_type": 1004}}]}
                    ]}
                ]},
                // 不同 tab 的行必须被跳过（response_tab 过滤）。
                {"tab_type": 36, "cell_data": [
                    {"cell_data": [{"video_data": [{"series_id_str": "9999999999",
                                                      "title": "别的tab"}]}]}
                ]}
            ]}
        });
        let hits = discover_first_page_hits(&value, "39");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].content_type, Some(1));
        assert_eq!(hits[1].content_type, Some(1004));
    }

    #[test]
    fn filter_rows_drop_unnamed_rows_and_empty_options() {
        let data = serde_json::json!({
            "selector_rows": [
                {"type": "genre", "row_name": "题材", "items": [
                    {"show_name": "全部", "selector_item_id": "all"},
                    {"show_name": "无id", "selector_item_id": ""}
                ]},
                {"row_name": "没有 type 的行", "items": []}
            ]
        });
        let rows = parse_filter_rows(&data);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].key, "genre");
        assert_eq!(rows[0].name, "题材");
        assert_eq!(
            rows[0].options,
            vec![FilterOption {
                name: "全部".into(),
                value: "all".into()
            }]
        );
        assert!(parse_filter_rows(&Value::Null).is_empty());
    }

    #[test]
    fn short_filter_validates_row_keys_and_values() {
        // 校验是 short_filter 在发请求之前执行的同一个函数，直接测它即可。
        let mut unknown = BTreeMap::new();
        unknown.insert("not_a_row".to_string(), vec!["x".to_string()]);
        assert!(validate_short_filter_selections(&unknown).is_err());

        let mut blank = BTreeMap::new();
        blank.insert("genre".to_string(), vec!["   ".to_string()]);
        assert!(validate_short_filter_selections(&blank).is_err());

        let mut ok = BTreeMap::new();
        ok.insert("genre".to_string(), vec!["short_play".to_string()]);
        assert!(validate_short_filter_selections(&ok).is_ok());
    }

    #[test]
    fn feed_cursor_round_trips_with_d1_prefix() {
        let cur = FeedCursor {
            cell: "7470092475068071998".into(),
            session: "sess-abc".into(),
            template: "3".into(),
            show: "2".into(),
            tab: "39".into(),
            offset: 40,
        };
        let token = cur.encode();
        assert!(token.starts_with("d1."), "{token}");
        assert_eq!(FeedCursor::decode(&token).unwrap(), cur);
    }

    #[test]
    fn feed_cursor_rejects_bad_input() {
        assert!(FeedCursor::decode("").is_err());
        assert!(FeedCursor::decode("xx.abc").is_err());
        assert!(FeedCursor::decode("d1.!!!").is_err());
        // offset 必须为正数，cell 必须是纯数字
        let zero = FeedCursor {
            cell: "1".into(),
            session: "s".into(),
            show: "1".into(),
            tab: "39".into(),
            offset: 0,
            ..Default::default()
        };
        assert!(FeedCursor::decode(&zero.encode()).is_err());
        let bad_cell = FeedCursor {
            cell: "abc".into(),
            session: "s".into(),
            show: "1".into(),
            tab: "39".into(),
            offset: 5,
            ..Default::default()
        };
        assert!(FeedCursor::decode(&bad_cell.encode()).is_err());
    }

    #[test]
    fn discover_continuation_prefers_nested_cell() {
        let v: Value = serde_json::from_str(
            r#"{"data":{"tab_item":[{"tab_type":39,"session_id":"S1","client_template":3,
                "cell_data":[
                    {"cell_id_str":"100","show_type":2,"cell_data":[]},
                    {"cell_id_str":"200","show_type":1,"cell_data":[{"series_id":"9"}]}
                ]}]}}"#,
        )
        .unwrap();
        let next = discover_continuation(&v, "39").unwrap();
        assert_eq!(next.cell, "200");
        assert_eq!(next.session, "S1");
        assert_eq!(next.template, "3");
        assert_eq!(next.show, "1");
        assert_eq!(next.tab, "39");
    }

    #[test]
    fn discover_continuation_falls_back_for_find_drama() {
        // 找剧没有嵌套流，只能退回childless cell
        let v: Value = serde_json::from_str(
            r#"{"data":{"tab_item":[{"tab_type":8,"session_id":"S2",
                "cell_data":[{"cell_id_str":"300","show_type":4,"cell_data":[]}]}]}}"#,
        )
        .unwrap();
        let next = discover_continuation(&v, "8").unwrap();
        assert_eq!(next.cell, "300");
        assert_eq!(next.show, "4");
        assert!(next.template.is_empty());
    }

    #[test]
    fn discover_channel_maps_to_go_tabs() {
        assert_eq!(DiscoverChannel::Recommend.request_tab(), "-1");
        assert_eq!(DiscoverChannel::Recommend.response_tab(), "16");
        assert_eq!(DiscoverChannel::LiveDrama.request_tab(), "39");
        assert_eq!(DiscoverChannel::Comic.request_tab(), "36");
        assert_eq!(DiscoverChannel::FindDrama.request_tab(), "8");
        assert_eq!(DiscoverChannel::FindDrama.bottom_tab(), "0");
        assert_eq!(DiscoverChannel::LiveDrama.bottom_tab(), "7");
    }

    /// `PATH_PLAN` 的等价内联样本（对齐 SDK 的 testdata/protocol/series-seasons.json）：
    /// 一季正常、一季正常、一季 `episode_cnt: 0`（未上架）。
    ///
    /// 顺序刻意打乱（第 3 季写在前），用来验证排序不是靠"数组恰好有序"。
    const SEASONS_FIXTURE: &str = r#"{
      "code": 0,
      "data": [
        {
          "show_type": 547,
          "video_data": [
            {"series_id": "7000000000000000003", "title": "测试剧第三季", "cover": "https://x/3.jpg",
             "episode_cnt": 0, "season_index": 3, "disable_play": false}
          ]
        },
        {
          "show_type": 547,
          "video_data": [
            {"series_id": "7000000000000000001", "title": "测试剧第一季", "cover": "https://x/1.jpg",
             "episode_cnt": 80, "season_index": 1, "disable_play": false},
            {"series_id": "7000000000000000002", "title": "测试剧第二季", "cover": "https://x/2.jpg",
             "episode_cnt": 100, "season_index": 2, "disable_play": true}
          ]
        },
        {
          "show_type": 512,
          "video_data": [
            {"series_id": "7000000000000000009", "title": "推荐位", "episode_cnt": 12, "season_index": 9}
          ]
        }
      ]
    }"#;

    #[test]
    fn parses_series_seasons_sorted_with_unpublished_marked() {
        let v: Value = serde_json::from_str(SEASONS_FIXTURE).unwrap();
        let seasons = parse_seasons(&v);

        // 只认 show_type == 547：那个 512 的推荐位 cell 不能被当成一季。
        assert_eq!(seasons.len(), 3, "应解析出 3 季，实际 {seasons:?}");
        // 季号必须升序，且顺序来自 season_index 而不是数组位置。
        let order: Vec<i64> = seasons.iter().map(|s| s.season_index).collect();
        assert_eq!(order, vec![1, 2, 3]);
        assert_eq!(seasons[0].series_id, "7000000000000000001");
        assert_eq!(seasons[0].title, "测试剧第一季");
        assert_eq!(seasons[0].cover, "https://x/1.jpg");
        assert_eq!(seasons[0].episode_count, 80);
        // 接口的 disable_play 原样带出（第 2 季被剧方锁了播放）。
        assert!(seasons[1].disable_play);
        // 第 3 季 `episode_cnt: 0` = 未上架：集数为 0 这一事实本身要留给上层置灰。
        assert_eq!(seasons[2].episode_count, 0);
    }

    #[test]
    fn drops_cells_without_series_id() {
        let v: Value = serde_json::from_str(
            r#"{"data":[{"show_type":547,"video_data":[
                {"series_id":"","title":"空 id","episode_cnt":5,"season_index":1},
                {"title":"缺 id","episode_cnt":5,"season_index":2},
                {"series_id":"42","title":"正常","episode_cnt":5,"season_index":2}
            ]}]}"#,
        )
        .unwrap();
        let seasons = parse_seasons(&v);
        assert_eq!(seasons.len(), 1);
        assert_eq!(seasons[0].series_id, "42");
    }

    #[test]
    fn empty_payload_is_not_an_error() {
        // 服务端在"没有其它季"时可能直接给空 data / 缺 data 的形状，
        // 解析层必须安静地回空列表，而不是 panic 或报错。
        for raw in [r#"{"code":0,"data":[]}"#, r#"{"code":101116}"#] {
            let v: Value = serde_json::from_str(raw).unwrap();
            assert!(parse_seasons(&v).is_empty(), "{raw} 应解析为空");
        }
    }

    /// 打印响应里所有 `video_data[]` 项的键名集合（真实键名，不猜）。
    ///
    /// 上游 CLI 的 `--json` 输出里没有封面目字段，只有看原始响应才知道封面到底
    /// 叫 `series_cover` / `cover` 还是 `horiz_cover`。测试跑一遍就把这份事实
    /// 固化在输出里，以后接口改版也能第一时间看出来。
    fn print_video_data_keys(value: &Value) {
        use std::collections::BTreeSet;

        fn walk(
            node: &Value,
            video_keys: &mut BTreeSet<String>,
            detail_keys: &mut BTreeSet<String>,
            depth: usize,
        ) {
            if depth > 8 {
                return;
            }
            match node {
                Value::Object(map) => {
                    if let Some(vd) = map.get("video_data") {
                        let items: Vec<&Value> = match vd {
                            Value::Array(arr) => arr.iter().collect(),
                            other => vec![other],
                        };
                        for item in items {
                            if let Value::Object(o) = item {
                                for key in o.keys() {
                                    video_keys.insert(key.clone());
                                }
                                if let Some(Value::Object(detail)) = o.get("video_detail") {
                                    for key in detail.keys() {
                                        detail_keys.insert(key.clone());
                                    }
                                }
                            }
                        }
                    }
                    for v in map.values() {
                        walk(v, video_keys, detail_keys, depth + 1);
                    }
                }
                Value::Array(arr) => {
                    for v in arr {
                        walk(v, video_keys, detail_keys, depth + 1);
                    }
                }
                _ => {}
            }
        }

        let mut video_keys = BTreeSet::new();
        let mut detail_keys = BTreeSet::new();
        walk(value, &mut video_keys, &mut detail_keys, 0);
        println!(
            "video_data 键名: {:?}",
            video_keys.iter().collect::<Vec<_>>()
        );
        println!(
            "video_detail 键名: {:?}",
            detail_keys.iter().collect::<Vec<_>>()
        );
    }

    /// App 搜索的端到端验收（服务端真实数据）。
    ///
    /// 默认 `#[ignore]`，手动跑：
    /// `cargo test --bin ttv-short-drama app_search_live -- --ignored --nocapture`
    ///
    /// 它同时是**封面字段的实测入口**：`--nocapture` 时会把 `video_data[]` 与
    /// `video_detail` 的真实键名集合打出来，据此确认封面字段名。
    #[tokio::test]
    #[ignore = "会真的联网请求红果 App 搜索接口，默认不跑"]
    async fn app_search_live_finds_jinjiuzhou() {
        let client = HongguoClient::new(None).await.expect("客户端初始化失败");

        // 先打一次原始响应，把键名集合打出来（封面字段名的唯一可靠来源）。
        let pairs = client
            .search_pairs("烬九州", 10, 0)
            .await
            .expect("构造查询串失败");
        let raw = client
            .request(reqwest::Method::GET, PATH_SEARCH, pairs, None)
            .await
            .expect("搜索请求失败");
        print_video_data_keys(&raw);

        // 再走正式解析，验证用户能看到的东西。
        let hits = client.search("烬九州", 10, 0).await.expect("App 搜索失败");
        println!("App 搜索命中 {} 条：", hits.len());
        for hit in &hits {
            println!(
                "  id={} episodes={} cover={:?} title={}",
                hit.id, hit.episode_count, hit.cover, hit.title
            );
        }

        assert!(
            hits.len() >= 3,
            "「烬九州」至少应有 3 条，实际 {} 条——先看上面打印的原始键名是不是改版了",
            hits.len()
        );
        assert!(
            hits.iter().any(|hit| hit.id == "7647789981687106622"),
            "本体（第一季 115 集）必须在结果里，实际：{:?}",
            hits.iter().map(|hit| &hit.id).collect::<Vec<_>>()
        );
        // 这条是封面可用性的硬证据：全空就说明 `card_cover` 的键名兜底没覆盖到真实字段。
        assert!(
            hits.iter().any(|hit| !hit.cover.trim().is_empty()),
            "至少一条要有封面，否则搜索页全是灰块：{hits:?}"
        );
    }

    /// 端到端联网冒烟：真打一次 plan 接口，验证「35 季一次吐全」。    ///
    /// 默认 `#[ignore]`：依赖外网和红果的匿名风控，不能进默认测试集。
    /// 手动跑：`cargo test --lib series_seasons_live -- --ignored --nocapture`
    ///
    /// seriesId 取实测样本《烬九州》第一季 7647789981687106622（整系列 35 季）。
    #[tokio::test]
    #[ignore = "会真的联网请求红果 plan 接口，默认不跑"]
    async fn series_seasons_live_returns_all_35() {
        let client = HongguoClient::new(None).await.expect("客户端初始化失败");
        let seasons = client
            .series_seasons("7647789981687106622")
            .await
            .expect("plan 请求失败");

        println!("plan 返回 {} 季", seasons.len());
        for s in &seasons {
            println!(
                "  index={:<3} episodes={:<4} disable_play={:<5} {}",
                s.season_index, s.episode_count, s.disable_play, s.title
            );
        }

        // 35 季是实测值；留一点余量，站点后续增删季不该让冒烟测试天天红。
        assert!(
            seasons.len() >= 30,
            "应至少 30 季，实际 {} 季——若无截断逻辑仍在，问题多半在解析",
            seasons.len()
        );
        // 季号严格升序（不允许相等，也不允许回退）。
        let mut prev = 0;
        for s in &seasons {
            assert!(
                s.season_index > prev,
                "季号未升序：{} 出现在 {} 之后",
                s.season_index,
                prev
            );
            prev = s.season_index;
        }
    }

    /// 「找剧」（tab 8）实测：只打印卡片，不在代码里判定是否短剧，结论由人看输出决定。
    /// 运行：cargo test find_drama_live -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "会真的联网请求红果找剧频道，默认不跑"]
    async fn find_drama_live_lists_cards() {
        let client = HongguoClient::new(None).await.expect("客户端初始化失败");
        let page = client
            .discover_page(DiscoverChannel::FindDrama, None)
            .await
            .expect("找剧首页请求失败");

        println!(
            "找剧首屏 {} 张卡，has_more={}，cursor={:?}",
            page.hits.len(),
            page.has_more,
            page.next_cursor
        );
        for h in &page.hits {
            println!("  id={} 集数={:<4} {}", h.id, h.episode_count, h.title);
        }
        assert!(!page.hits.is_empty(), "找剧首屏为空，可能是设备被风控");
    }

    /// 新移植方法的联网探针：逐个真打一次并打印耗时与结果规模，
    /// 用于和现有网页抓取链路对比（不跑断言，只看数据）。
    ///
    /// 手动跑：`cargo test sdk_probe_live -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "会真的联网请求红果 App 接口，默认不跑"]
    async fn sdk_probe_live() {
        use std::time::{Duration, Instant};

        macro_rules! run {
            ($name:expr, $call:expr) => {{
                let t = Instant::now();
                match tokio::time::timeout(Duration::from_secs(25), $call).await {
                    Ok(Ok(v)) => {
                        println!("OK  {:<20} {:>5}ms", $name, t.elapsed().as_millis());
                        Some(v)
                    }
                    Ok(Err(e)) => {
                        println!("ERR {:<20} {:>5}ms  {e}", $name, t.elapsed().as_millis());
                        None
                    }
                    Err(_) => {
                        println!("超时 {:<20}", $name);
                        None
                    }
                }
            }};
        }

        let client = HongguoClient::new(None).await.expect("客户端初始化失败");
        let (mut ok, mut fail) = (0, 0);

        if let Some(h) = run!("hot_search", client.hot_search()) {
            ok += 1;
            println!(
                "    → 猜你想搜 {} 条，热搜榜 {} 个（{:?}）",
                h.guesses.len(),
                h.boards.len(),
                h.boards.iter().map(|b| b.name.as_str()).collect::<Vec<_>>()
            );
        } else {
            fail += 1;
        }

        if let Some(rows) = run!(
            "short_filter_panel",
            client.short_filter_panel("short_play")
        ) {
            ok += 1;
            println!(
                "    → 筛选行 {} 个：{:?}",
                rows.len(),
                rows.iter().map(|r| r.name.as_str()).collect::<Vec<_>>()
            );
        } else {
            fail += 1;
        }

        if let Some(page) = run!("short_filter", client.short_filter(&BTreeMap::new(), None)) {
            ok += 1;
            println!(
                "    → 结果 {} 条，has_more={}",
                page.items.len(),
                page.has_more
            );
        } else {
            fail += 1;
        }

        if let Some(rank) = run!("short_rank", client.short_rank("", "", None)) {
            ok += 1;
            println!(
                "    → 榜单 {} 行，内容 {} 个（content={} board={}）",
                rank.items.len(),
                rank.contents.len(),
                rank.content,
                rank.board
            );
        } else {
            fail += 1;
        }

        if let Some(r) = run!("ranking", client.ranking("", "")) {
            ok += 1;
            println!(
                "    → 榜单目录 {} 个，演员 {} 位（{}）",
                r.lists.len(),
                r.items.len(),
                r.list_name
            );
        } else {
            fail += 1;
        }

        if let Some(page) = run!("new_releases", client.new_releases("", None)) {
            ok += 1;
            println!(
                "    → 日期 {}，可选日期 {} 个，条目 {} 条",
                page.date,
                page.dates.len(),
                page.items.len()
            );
        } else {
            fail += 1;
        }

        let series_id = client
            .search("烬九州", 5, 0)
            .await
            .ok()
            .and_then(|hits| hits.first().map(|h| h.id.clone()));
        if let Some(id) = &series_id {
            if let Some(rec) = run!("series_recommend", client.series_recommend(id)) {
                ok += 1;
                println!(
                    "    → 推荐 cell「{}」{} 条",
                    rec.cell_title,
                    rec.items.len()
                );
            } else {
                fail += 1;
            }
        } else {
            println!("SKIP series_recommend（搜索没拿到 id）");
        }

        let user_id = client
            .ranking("", "")
            .await
            .ok()
            .and_then(|r| r.items.into_iter().find(|i| !i.user_id.is_empty()))
            .map(|i| i.user_id);
        match user_id {
            Some(uid) => {
                if let Some(p) = run!("person", client.person(&uid)) {
                    ok += 1;
                    println!("    → 主页「{}」头衔 {:?}", p.name, p.tags);
                } else {
                    fail += 1;
                }
                if let Some(w) = run!("person_works", client.person_works(&uid, None)) {
                    ok += 1;
                    println!("    → 作品 {} 部，has_more={}", w.works.len(), w.has_more);
                } else {
                    fail += 1;
                }
            }
            None => println!("SKIP person/person_works（星粉榜没拿到 user_id）"),
        }

        {
            let t = Instant::now();
            let mut pager = client.discover_pager(DiscoverChannel::Recommend, None);
            match tokio::time::timeout(Duration::from_secs(25), pager.next()).await {
                Ok(Ok((hits, more))) => {
                    ok += 1;
                    println!(
                        "OK  {:<20} {:>5}ms  → 首屏 {} 条，more={more}",
                        "discover_pager",
                        t.elapsed().as_millis(),
                        hits.len()
                    );
                }
                Ok(Err(e)) => {
                    fail += 1;
                    println!(
                        "ERR {:<20} {:>5}ms  {e}",
                        "discover_pager",
                        t.elapsed().as_millis()
                    );
                }
                Err(_) => {
                    fail += 1;
                    println!("超时 {:<20}", "discover_pager");
                }
            }
        }

        {
            let t = Instant::now();
            let mut pager = client.search_pager(
                "烬九州",
                SearchOptions {
                    tab: SearchTab::Overall,
                    filters: Vec::new(),
                    cursor: None,
                    page_size: 10,
                },
            );
            match tokio::time::timeout(Duration::from_secs(25), pager.next()).await {
                Ok(Ok((hits, more))) => {
                    ok += 1;
                    println!(
                        "OK  {:<20} {:>5}ms  → 首屏 {} 条，more={more}",
                        "search_pager",
                        t.elapsed().as_millis(),
                        hits.len()
                    );
                }
                Ok(Err(e)) => {
                    fail += 1;
                    println!(
                        "ERR {:<20} {:>5}ms  {e}",
                        "search_pager",
                        t.elapsed().as_millis()
                    );
                }
                Err(_) => {
                    fail += 1;
                    println!("超时 {:<20}", "search_pager");
                }
            }
        }

        println!("\n汇总：成功 {ok} 项，失败 {fail} 项");
        assert!(ok > 0, "全部失败，先看上面的错误信息");
    }
}
