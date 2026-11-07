//! 红果原生客户端的 IPC 出口。
//!
//! 这里只做三件事：把参数翻译成 `hongguo::catalog` 的调用、把返回的结构翻译成
//! 前端习惯的 camelCase JSON、把错误翻译成 `String`。业务逻辑一律留在
//! `hongguo/` 里，别在这里长第二份解析。
//!
//! 为什么单独开文件而不塞进 `main.rs`：那个文件已经两千八百多行，
//! 再加十五个命令会让"找一个命令在哪"变成翻页游戏。

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::hongguo::catalog::{
    DiscoverChannel, FilterRow, NewRelease, Person, RankItem, RankingPage, Recommend,
    SearchOptions, SearchTab, SeriesDetail, SeriesHit, ShortFilterResult, ShortRankResult,
    WorkPage,
};
use crate::models::SeriesItem;

/// 取原生客户端（进程内单例，设备档案跨请求复用）。
async fn client() -> Result<std::sync::Arc<crate::hongguo::client::HongguoClient>, String> {
    crate::hongguo_bridge::client().await
}

/// 卡片映射统一走 `main.rs` 那一份，保证与搜索路径的 `origin` 文案一致。
fn item(hit: &SeriesHit, channel: &str) -> SeriesItem {
    crate::app_search_hit_to_item(hit.clone(), channel)
}

fn items(hits: &[SeriesHit], channel: &str) -> Vec<SeriesItem> {
    hits.iter().map(|h| item(h, channel)).collect()
}

// The recommendation cell can mix types; `item()` labels every hit as the requested channel.
fn recommend_items(hits: &[SeriesHit], channel: &str) -> Vec<SeriesItem> {
    hits.iter()
        .filter(|hit| match channel {
            "drama" => hit.content_type == Some(crate::hongguo::catalog::content_type::LIVE),
            "comic" => hit.content_type == Some(crate::hongguo::catalog::content_type::COMIC),
            _ => true,
        })
        .map(|hit| item(hit, channel))
        .collect()
}

/// 一页列表的统一形状：`items` + `hasMore` + `cursor`。
fn page_json(hits: &[SeriesHit], channel: &str, has_more: bool, cursor: Option<String>) -> Value {
    json!({
        "items": items(hits, channel),
        "hasMore": has_more,
        "cursor": cursor,
    })
}

/// 前端传的 tab 名字 → [`SearchTab`]。只认短剧相关的四个，其他一律报错，
/// 不静默退回综合（静默退回会让用户以为筛选生效了）。
fn parse_tab(raw: Option<&str>) -> Result<SearchTab, String> {
    match raw.map(str::trim).unwrap_or("") {
        "" | "overall" | "综合" | "短剧" => Ok(SearchTab::Overall),
        "series" | "剧集" => Ok(SearchTab::Series),
        "video" | "视频" => Ok(SearchTab::Video),
        "discussion" | "讨论" => Ok(SearchTab::Discussion),
        other => Err(format!(
            "不支持的搜索 tab：{other}（可用：综合 / 剧集 / 视频 / 讨论）"
        )),
    }
}

/// 前端传的频道名 → [`DiscoverChannel`]。只开放短剧相关的频道。
fn parse_channel(raw: Option<&str>) -> Result<DiscoverChannel, String> {
    match raw.map(str::trim).unwrap_or("") {
        "" | "recommend" | "推荐" => Ok(DiscoverChannel::Recommend),
        "live" | "真人剧" => Ok(DiscoverChannel::LiveDrama),
        "comic" | "漫剧" => Ok(DiscoverChannel::Comic),
        "home_live" | "首页真人剧" => Ok(DiscoverChannel::HomeLiveDrama),
        "home_comic" | "首页漫剧" => Ok(DiscoverChannel::HomeComic),
        "find" | "找剧" => Ok(DiscoverChannel::FindDrama),
        other => Err(format!("不支持的发现频道：{other}")),
    }
}

// ───────────────────────────────────────────────────────────────────────────
// 搜索
// ───────────────────────────────────────────────────────────────────────────

/// 搜索框联想词。原生实现，无 Python 冷启动。
///
/// 接口本身只回文本（没有 id / 封面），所以这里按原样返回字符串列表，
/// 由前端当作下拉提示词用。**不要**在这里编造成可点的剧集卡：
/// 空 id 的卡片点进去只会得到"剧集不存在"。
#[tauri::command]
pub async fn hongguo_suggest(keyword: String) -> Result<Vec<String>, String> {
    let client = client().await?;
    client.suggest(&keyword).await.map_err(|e| e.to_string())
}

/// 搜索框轮播提示词。
#[tauri::command]
pub async fn hongguo_search_cues() -> Result<Vec<String>, String> {
    let client = client().await?;
    client.search_cues().await.map_err(|e| e.to_string())
}

/// 带 tab 与筛选的搜索，一页。`cursor` 传上一页返回的 `cursor`。
#[tauri::command]
pub async fn hongguo_search(
    keyword: String,
    tab: Option<String>,
    filters: Option<Vec<String>>,
    cursor: Option<String>,
    page_size: Option<usize>,
    channel: Option<String>,
) -> Result<Value, String> {
    let tab = parse_tab(tab.as_deref())?;
    let opts = SearchOptions {
        tab,
        filters: filters.unwrap_or_default(),
        cursor,
        page_size: page_size.unwrap_or(20),
    };
    let client = client().await?;
    let page = client
        .search_page(&keyword, &opts)
        .await
        .map_err(|e| e.to_string())?;
    Ok(page_json(
        &page.hits,
        &channel.unwrap_or_else(|| "drama".into()),
        page.has_more,
        page.next_cursor,
    ))
}

// ───────────────────────────────────────────────────────────────────────────
// 发现
// ───────────────────────────────────────────────────────────────────────────

/// 发现页某个频道的一页；`cursor` 续页。
#[tauri::command]
pub async fn hongguo_discover(
    channel: Option<String>,
    cursor: Option<String>,
) -> Result<Value, String> {
    let channel = parse_channel(channel.as_deref())?;
    let client = client().await?;
    let page = client
        .discover_page(channel, cursor.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    let item_channel = match channel {
        DiscoverChannel::Comic | DiscoverChannel::HomeComic => "comic",
        DiscoverChannel::LiveDrama | DiscoverChannel::HomeLiveDrama => "drama",
        _ => "",
    };
    /*
     * 逐条内容类型兜底（2026-11-07）：tab 过滤是发现流的第一道隔离，
     * 这里是第二道——串味卡（真人 tab 里偶尔夹漫剧卡）按 content_type 拦下。
     * 只对「纯频道」生效：推荐流（综合推荐页的语义）与找剧页本来就是混排，
     * 过滤它们反而改变产品语义。缺标记的条目放行（见 channel_accepts）。
     */
    let hits = if item_channel.is_empty() {
        page.hits
    } else {
        page.hits
            .into_iter()
            .filter(|h| crate::hongguo::catalog::channel_accepts(item_channel, h.content_type))
            .collect::<Vec<_>>()
    };
    Ok(page_json(
        &hits,
        if item_channel.is_empty() {
            "drama"
        } else {
            item_channel
        },
        page.has_more,
        page.next_cursor,
    ))
}

// ───────────────────────────────────────────────────────────────────────────
// 榜单与筛选
// ───────────────────────────────────────────────────────────────────────────

/// 短剧排行榜的一页。`content` / `board` 为空时用服务端默认榜。
#[tauri::command]
pub async fn hongguo_short_rank(
    content: Option<String>,
    board: Option<String>,
    cursor: Option<String>,
    channel: Option<String>,
) -> Result<Value, String> {
    let client = client().await?;
    let channel = channel.unwrap_or_else(|| "drama".into());

    /*
     * 频道 → 榜单内容形态 + 子榜的默认档。
     *
     * 首页榜单区（`RankingSection`）首屏只传 `channel`，content / board 都是
     * `None`；旧实现把空串原样透传，下游 `short_rank` 对空 content 回落成 `"all"`，
     * 于是**漫剧次元打开的是全站榜**，真人剧与漫剧混排 —— 这正是用户报告的
     * "短剧专区看到漫画、漫剧次元看到真人剧"。
     *
     * 默认 id 必须来自服务端自己的 `contents[].id`（cell 7470092475068071998 的
     * 选择器目录，实测 2026-11-07）：
     * - 漫剧 → `comic_series_rank`（漫剧榜，实测 10/10 全为漫剧）+ 子榜
     *   `comic_series_hot_play`（热播，对齐「热度排行榜」标题）。
     * - 真人 → `ranklist_hot_sc`（推荐榜）。**没有**纯真人榜：推荐榜实测 8:2
     *   真人:漫剧，串味行靠下面的逐条 content_type 过滤拦。
     *   2026-11-06 曾用 `human` / `human_hot_play`——这两个 id **不在服务端
     *   选择器目录里**（目录里只有 ranklist_* 与 comic_series_rank），实测返回
     *   空 cell，短剧频道整栏报"榜单为空"，这次一并修正。
     *
     * 用户手动切分类时**不再套用**这组默认值（新分类的 board id 完全不同，
     * 套上去会请求到不存在的榜）。
     */
    let (content, board) = {
        let raw_content = content.unwrap_or_default();
        let raw_board = board.unwrap_or_default();
        let derived = raw_content.trim().is_empty();
        let (default_content, default_board) = if channel == "comic" {
            ("comic_series_rank", "comic_series_hot_play")
        } else {
            ("ranklist_hot_sc", "")
        };
        let content = if derived {
            default_content.to_string()
        } else {
            raw_content
        };
        // 只有「首屏、连分类都是默认推出来的」时才补默认子榜；用户点了子榜但没
        // 换分类，或已经切到别的内容形态，都保留用户的选择 / 让服务端给该形态默认榜。
        let board = if derived && raw_board.trim().is_empty() {
            default_board.to_string()
        } else {
            raw_board
        };
        (content, board)
    };

    let result: ShortRankResult = client
        .short_rank(&content, &board, cursor.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    /*
     * 逐条内容类型过滤 + 分类托盘裁剪（2026-11-07）。
     *
     * 这颗 cell 的大部分榜（推荐/热播/必看/收藏/新剧）都是**天然混合流**——
     * 接口参数选不出纯真人榜，所以每条按 `content_type`（1=真人 / 1004=漫剧）
     * 验一遍，串味行直接丢弃。托盘同步裁剪：漫剧频道只留漫剧榜（其余榜切过去
     * 也会被逐条过滤成空，不如不给）；真人频道去掉漫剧榜（纯漫剧）与预约榜
     * （全部是 1002 未上线条目，无法判型，过滤后必空）。
     */
    let items = result
        .items
        .iter()
        .filter(|r| crate::hongguo::catalog::channel_accepts(&channel, r.series.content_type))
        .collect::<Vec<_>>();
    let contents = result
        .contents
        .iter()
        .filter(|c| match channel.as_str() {
            "comic" => c.id == "comic_series_rank" || c.name.contains("漫剧"),
            /*
             * 真人频道裁掉漫剧榜与预约榜。**id + 名称双重判据**：id 来自
             * 2026-11-07 实测的目录快照，但不同设备/实验组的目录 id 会漂移
             * （用户截图里出现过探针没有的"追更榜"），中文名 `show_name` 更
             * 稳定——漫剧榜不会不叫"漫剧榜"。预约榜整榜都是未上线内容
             * （content_type=1002，无法判型），逐条过滤后必然为空，留着只会
             * 让用户点进去看到"空榜"。
             */
            "drama" => {
                let name = c.name.as_str();
                c.id != "comic_series_rank"
                    && c.id != "ranklist_subscribe"
                    && !name.contains("漫剧")
                    && !name.contains("预约")
            }
            _ => true,
        })
        .collect::<Vec<_>>();

    Ok(json!({
        "items": items.iter().map(|r: &&RankItem| json!({
            "position": r.position,
            "series": item(&r.series, &channel),
            "score": r.score,
            "promoted": r.promoted,
        })).collect::<Vec<_>>(),
        "contents": contents.iter().map(|c| json!({
            "id": c.id,
            "name": c.name,
            "selected": c.selected,
            "boards": c.boards.iter().map(|b| json!({
                "id": b.id,
                "name": b.name,
                "selected": b.selected,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "content": result.content,
        "board": result.board,
        "hasMore": result.has_more,
        "cursor": result.next_cursor,
    }))
}

/// 短剧筛选面板的各选择行。`genre` 取 `short_play` / `comic_series` / `ai_series`，空即全部。
#[tauri::command]
pub async fn hongguo_short_filter_panel(genre: Option<String>) -> Result<Value, String> {
    let client = client().await?;
    let rows: Vec<FilterRow> = client
        .short_filter_panel(genre.as_deref().unwrap_or(""))
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!(rows
        .iter()
        .map(|row| json!({
            "key": row.key,
            "name": row.name,
            "options": row.options.iter().map(|o| json!({
                "name": o.name,
                "value": o.value,
            })).collect::<Vec<_>>(),
        }))
        .collect::<Vec<_>>()))
}

/// 按筛选条件查短剧，一页。`selections` 是 行 key → 选中值列表。
#[tauri::command]
pub async fn hongguo_short_filter(
    selections: Option<BTreeMap<String, Vec<String>>>,
    cursor: Option<String>,
    channel: Option<String>,
) -> Result<Value, String> {
    let client = client().await?;
    let result: ShortFilterResult = client
        .short_filter(&selections.unwrap_or_default(), cursor.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    let channel = channel.unwrap_or_else(|| "drama".into());
    let mut out = page_json(&result.items, &channel, result.has_more, result.next_cursor);
    // 把实际生效的筛选回传：续页时前端要原样带上，否则游标会被判成「另一组查询」。
    out["selections"] = json!(result.selections);
    Ok(out)
}

/// 活动榜（红果演员粉丝榜）。`activityId` / `rankListId` 为空时用服务端默认值。
#[tauri::command]
pub async fn hongguo_ranking(
    activity_id: Option<String>,
    rank_list_id: Option<String>,
    channel: Option<String>,
) -> Result<Value, String> {
    let client = client().await?;
    let result: RankingPage = client
        .ranking(
            activity_id.as_deref().unwrap_or(""),
            rank_list_id.as_deref().unwrap_or(""),
        )
        .await
        .map_err(|e| e.to_string())?;
    let channel = channel.unwrap_or_else(|| "drama".into());
    Ok(json!({
        "listName": result.list_name,
        "lists": result.lists.iter().map(|l| json!({
            "id": l.id,
            "name": l.name,
            "shortlistedNumber": l.shortlisted_number,
        })).collect::<Vec<_>>(),
        "items": result.items.iter().map(|a| json!({
            "index": a.index,
            "voteCount": a.vote_count,
            "actorName": a.actor_name,
            "actorAvatar": a.actor_avatar,
            "userId": a.user_id,
            "series": item(&a.series, &channel),
        })).collect::<Vec<_>>(),
        "hasMore": result.has_more,
        "nextOffset": result.next_offset,
    }))
}

// ───────────────────────────────────────────────────────────────────────────
// 详情与推荐
// ───────────────────────────────────────────────────────────────────────────

/// 单部短剧的详情（含详情字段与全集列表）。
#[tauri::command]
pub async fn hongguo_series_detail(
    series_id: String,
    channel: Option<String>,
) -> Result<Value, String> {
    let client = client().await?;
    let (detail, episodes) = client
        .get_series(&series_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(detail_json(
        &detail,
        &episodes,
        &channel.unwrap_or_else(|| "drama".into()),
    ))
}

fn detail_json(
    detail: &SeriesDetail,
    episodes: &[crate::hongguo::catalog::EpisodeHit],
    channel: &str,
) -> Value {
    json!({
        "series": item(&detail.hit, channel),
        "status": detail.status,
        "payType": detail.pay_type,
        "ageGate": detail.age_gate,
        "isMultiSeason": detail.is_multi_season,
        "rightText": detail.right_text,
        "playCount": detail.play_count,
        "followCount": detail.follow_count,
        "diggCount": detail.digg_count,
        "createdAt": detail.created_at,
        "episodes": episodes.iter().map(|e| json!({
            "id": e.id,
            "seriesId": e.series_id,
            "number": e.number,
            "title": e.title,
            "durationSeconds": e.duration_seconds,
            "cover": e.cover,
        })).collect::<Vec<_>>(),
    })
}

/// 批量详情：一次最多 10 部，按请求顺序返回。
#[tauri::command]
pub async fn hongguo_series_batch(
    series_ids: Vec<String>,
    channel: Option<String>,
) -> Result<Value, String> {
    let client = client().await?;
    let found = client
        .get_series_batch(&series_ids)
        .await
        .map_err(|e| e.to_string())?;
    let channel = channel.unwrap_or_else(|| "drama".into());
    Ok(json!(found
        .iter()
        .map(|(detail, episodes)| detail_json(detail, episodes, &channel))
        .collect::<Vec<_>>()))
}

/// 合集详情：原样透传上游 JSON（合集结构各接口不一致，这里不做二次建模）。
#[tauri::command]
pub async fn hongguo_album(album_id: String) -> Result<Value, String> {
    let client = client().await?;
    client.get_album(&album_id).await.map_err(|e| e.to_string())
}

/// 相关推荐：详情页底部的「相关视频」。
#[tauri::command]
pub async fn hongguo_series_recommend(
    series_id: String,
    channel: Option<String>,
) -> Result<Value, String> {
    let client = client().await?;
    let rec: Recommend = client
        .series_recommend(&series_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({
        "cellTitle": rec.cell_title,
        "sessionId": rec.session_id,
        "items": recommend_items(&rec.items, &channel.unwrap_or_else(|| "drama".into())),
    }))
}

// ───────────────────────────────────────────────────────────────────────────
// 演员
// ───────────────────────────────────────────────────────────────────────────

/// 演员 / 角色主页。
#[tauri::command]
pub async fn hongguo_person(user_id: String) -> Result<Value, String> {
    let client = client().await?;
    let p: Person = client.person(&user_id).await.map_err(|e| e.to_string())?;
    Ok(json!({
        "userId": p.user_id,
        "name": p.name,
        "description": p.description,
        "avatarUrl": p.avatar_url,
        "tags": p.tags,
        "labels": p.labels,
        "followers": p.followers,
        "likes": p.likes,
    }))
}

/// 演员参演作品，一页。
#[tauri::command]
pub async fn hongguo_person_works(
    user_id: String,
    cursor: Option<String>,
    channel: Option<String>,
) -> Result<Value, String> {
    let client = client().await?;
    let works: WorkPage = client
        .person_works(&user_id, cursor.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    let channel = channel.unwrap_or_else(|| "drama".into());
    Ok(json!({
        "items": works.works.iter().map(|w| json!({
            "series": item(&w.series, &channel),
            "tags": w.tags,
            "heat": w.heat,
            "plays": w.plays,
            "coverExpiresAt": w.cover_expires_at,
        })).collect::<Vec<_>>(),
        "hasMore": works.has_more,
        "cursor": works.next_cursor,
    }))
}

// ───────────────────────────────────────────────────────────────────────────
// 上新日历
// ───────────────────────────────────────────────────────────────────────────

/// 上新日历的一页。`date` 为 YYYYMMDD，空即今天；`cursor` 续页。
#[tauri::command]
pub async fn hongguo_new_releases(
    date: Option<String>,
    cursor: Option<String>,
    channel: Option<String>,
) -> Result<Value, String> {
    let client = client().await?;
    let page = client
        .new_releases(date.as_deref().unwrap_or(""), cursor.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    let channel = channel.unwrap_or_else(|| "drama".into());
    /*
     * 上新日历是**全站混合流**（真人 + 漫剧一起按时间排），且这颗接口没有任何
     * 按频道取数的参数（2026-11-07 实测：content_type / genre / req_scene 等
     * 查询参数全部被服务端忽略）——首页两块日历的串味就是它。
     *
     * 过滤取**强校验**：只留 `subscribe_data.content_type` 与频道确切相符的
     * 条目（1=真人 / 1004=漫剧）。预告条目没有 subscribe_data（批量详情接口
     * 对它们也只回 1002，无法判型）——按「数据不足宁缺毋假」的原则直接不放行，
     * 前端的栏副标题已同步改成「今天上线」。
     */
    let expected = if channel == "comic" {
        crate::hongguo::catalog::content_type::COMIC
    } else {
        crate::hongguo::catalog::content_type::LIVE
    };
    let items = page
        .items
        .iter()
        .filter(|r| r.series.content_type == Some(expected))
        .collect::<Vec<_>>();
    Ok(json!({
        "date": page.date,
        "dates": page.dates,
        "items": items.iter().map(|r: &&NewRelease| json!({
            "series": item(&r.series, &channel),
            "online": r.online,
            "publishAt": r.publish_at,
            "categories": r.categories,
            "heat": r.heat,
            "note": r.note,
        })).collect::<Vec<_>>(),
        "hasMore": page.has_more,
        "cursor": page.next_cursor,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recommendations_require_a_known_matching_content_channel() {
        use crate::hongguo::catalog::content_type;

        let hits = [
            SeriesHit {
                id: "live".into(),
                title: "真人短剧".into(),
                content_type: Some(content_type::LIVE),
                ..Default::default()
            },
            SeriesHit {
                id: "comic".into(),
                title: "漫剧".into(),
                content_type: Some(content_type::COMIC),
                ..Default::default()
            },
            SeriesHit {
                id: "unmarked".into(),
                title: "未标注".into(),
                content_type: None,
                ..Default::default()
            },
            SeriesHit {
                id: "unreleased".into(),
                title: "未上线".into(),
                content_type: Some(1002),
                ..Default::default()
            },
        ];

        assert_eq!(
            recommend_items(&hits, "drama")
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["live"]
        );
        assert_eq!(
            recommend_items(&hits, "comic")
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["comic"]
        );
    }

    #[test]
    fn tab_names_map_to_short_drama_tabs_only() {
        assert_eq!(parse_tab(None).unwrap(), SearchTab::Overall);
        assert_eq!(parse_tab(Some("综合")).unwrap(), SearchTab::Overall);
        assert_eq!(parse_tab(Some("剧集")).unwrap(), SearchTab::Series);
        assert_eq!(parse_tab(Some("视频")).unwrap(), SearchTab::Video);
        assert_eq!(parse_tab(Some("讨论")).unwrap(), SearchTab::Discussion);
        // 小说 / 听书不属于短剧域，必须报错而不是悄悄退回综合
        assert!(parse_tab(Some("小说")).is_err());
        assert!(parse_tab(Some("听书")).is_err());
    }

    #[test]
    fn channel_names_reject_book_channels() {
        assert_eq!(parse_channel(None).unwrap(), DiscoverChannel::Recommend);
        assert_eq!(
            parse_channel(Some("找剧")).unwrap(),
            DiscoverChannel::FindDrama
        );
        assert_eq!(parse_channel(Some("漫剧")).unwrap(), DiscoverChannel::Comic);
        assert!(parse_channel(Some("小说")).is_err());
        assert!(parse_channel(Some("经典")).is_err());
        assert!(parse_channel(Some("听书")).is_err());
    }
}
