import { ipcService } from './ipc';
import { normalizeTitle, parseSeasonLabel, seasonOrder, type SeasonLabel } from './seasonLabel';
import type { CatalogFilter, SeriesItem } from '../types/catalog';
import type { SeriesDetail } from '../types/series';

/**
 * 详情页「猜你喜欢」的数据源。
 *
 * ## 为什么不新增一条后端命令
 *
 * 分季推荐需要的能力后端**已经全有了**，只是藏在搜索链路里：
 * - `catalog_fast_search` 走红果网页搜索，会把同名系列的各季一起捞回来；
 * - `catalog_suggest` 走红果 App 联想（全局索引），补的正是网页搜索只返回前
 *   10 条时漏掉的分季条目；
 * - 两者在 `provider.rs` 里已经带着「同系列按季号排序」「中文数字变体回查」
 *   这套逻辑（`search_season` / `season_fill_plan`）。
 *
 * 再开一条 `series_related` 命令，等于把上面那条调好的链路重写一遍，还要新增
 * 一个只有详情页用的 Rust 命令与 IPC 契约。所以这里反过来做：**前端拿剧名当
 * 关键词复用搜索链路，再在本地按「同系列」精确筛选**。筛选规则与 `provider.rs`
 * 逐条对齐（见 `seasonLabel.ts`），两边判出来的"同一系列"必须一致。
 *
 * ## 不臆造
 *
 * 推荐是纯增量信息，任何一路失败都只是少几张卡：搜索两路用 `allSettled`，
 * 兜底目录失败就只留同系列。两路都空时组件整块不渲染 —— 不编默认剧，也不拿
 * 当前剧集自己凑数。
 */

/**
 * 一屏展示的卡数。
 *
 * 定成 6 是为了**一行装完**：网格只用 2/3/4/6 列（跳过 5 列，理由同 `HomeShelf`
 * ——6 条在 5 列下会排成 5+1，第二行孤零零挂一张，看起来像布局塌了）。用户给的
 * 示例正好也是「第2..7季」六张。
 *
 * ⚠️ **这是"一屏几张"，不是"池子多大"**。早期版本把它同时当成两者（`pickSeasons`
 * 直接 slice 到 6、兜底也补满 6），结果是候选池恒等于一屏——「换一批」清缓存重拉
 * 拿到的还是同一批，点了完全没反应。池子必须比一屏大，轮换才有东西可换。
 */
export const SLOT_COUNT = 6;

/**
 * 候选池上限。
 *
 * 4 屏的量：再多也没有意义（用户连点四次「换一批」的概率极低），而每条都要占
 * 一个封面解析通道与一次潜在的网络请求。同系列季数超过这个数时按接续顺序截断，
 * 保留下来的正是最该推荐的那几季。
 */
const POOL_LIMIT = SLOT_COUNT * 4;

/**
 * 一张同系列季卡。
 *
 * 季号由本模块解析后一并带出，**不在组件里再解析一遍**：解析规则一旦两处各写
 * 一份就会漂移成"排序按第2季、角标显示第3季"的错位。
 */
export interface SeasonPick {
  item: SeriesItem;
  /** 这一季的季号（1..=SEASON_LIMIT）。 */
  season: number;
  /** 与当前季的关系：往后接 / 前面的季。角标配色据此区分。 */
  relation: 'next' | 'previous';
}

export interface RelatedSeries {
  /** 同系列其它季，按接续顺序排好（后续季在前、越近越前），上限 `POOL_LIMIT`。 */
  seasons: SeasonPick[];
  /** 兜底的同频道推荐。与 `seasons` 一起构成可轮换的候选池。 */
  others: SeriesItem[];
}

/** 搜索用的筛选条件。题材/受众/排序与搜索页一致：搜索链路刻意不叠加这些筛选。 */
function searchFilter(channel: SeriesDetail['type'], keyword: string): CatalogFilter {
  return {
    channel,
    category: '全部',
    audience: '全部',
    sort: 'recommend',
    keyword,
    page: 1,
    pageSize: 40,
  };
}

/**
 * 从候选里筛出真正属于同一系列、且不是当前季的条目，并按接续顺序排好。
 *
 * 三重比对缺一不可：
 * - **base 归一后相等** —— 站点同一部剧的剧名在不同来源里带不同标点/全角空格；
 * - **量词一致** —— 「第一季」与「第一部」是两种分卷习惯，混在一组里会让"第2部"
 *   排到"第2季"旁边，用户看到的是两套编号撞在一起；
 * - **季号不等于当前季** —— 同一季可能有另一个 id 的条目（不同来源），推荐它
 *   等于把用户正在看的这部剧再推一遍。
 *
 * 导出是为了让 `scripts/verify-related-pick.mjs` 直接当黑盒跑：这条筛选是整个
 * 推荐里最容易悄悄错掉的一环（错一条就把别的剧混进"接续推荐"），而它在界面上
 * 表现为"偶尔多出一张不相干的卡"，肉眼很难发现。
 */
export function pickSeasons(
  candidates: readonly SeriesItem[],
  label: SeasonLabel,
  currentId: string,
): SeasonPick[] {
  const baseKey = normalizeTitle(label.base);
  const seenIds = new Set<string>([currentId]);
  const bySeason = new Map<number, SeriesItem>();

  for (const item of candidates) {
    if (!item?.id || !item.title || seenIds.has(item.id)) continue;
    const itemLabel = parseSeasonLabel(item.title);
    if (!itemLabel) continue;
    if (itemLabel.unit !== label.unit) continue;
    if (normalizeTitle(itemLabel.base) !== baseKey) continue;
    if (itemLabel.season === label.season) continue;
    if (bySeason.has(itemLabel.season)) continue;
    bySeason.set(itemLabel.season, item);
    seenIds.add(item.id);
  }

  return [...bySeason.entries()]
    .sort((left, right) => seasonOrder(left[0], label.season) - seasonOrder(right[0], label.season))
    .slice(0, POOL_LIMIT)
    .map(([season, item]) => ({
      item,
      season,
      relation: season > label.season ? 'next' : 'previous',
    }));
}

export interface FetchRelatedOptions {
  /**
   * 兜底目录取第几页。首屏是 1；「换一批」把候选池耗尽后由调用方递增，
   * 这样新一批里能出现真正没见过的剧，而不是原地重排同一批。
   */
  fallbackPage?: number;
}

/**
 * 拉取某部剧的推荐**候选池**。
 *
 * 两段：
 * 1. **同系列其它季** —— 拿 `base` 当关键词跑「网页搜索 + App 联想」，本地按
 *    base/量词/季号三重比对筛出真正属于这一系列、且不是当前季的条目。
 * 2. **兜底同频道内容** —— 同系列凑不满一屏时（或调用方要求换一批时）拉一页目录。
 *    这一步失败不影响第 1 段，所以整块推荐不会因为一次抖动变成空白。
 *
 * 返回的是**整个池子**，不是一屏：一屏切几张由组件按 offset 决定。池子恒等于
 * 一屏的话，「换一批」就没有任何东西可换（这正是用户报的那个 bug）。
 */
export async function fetchRelatedSeries(
  detail: SeriesDetail,
  options: FetchRelatedOptions = {},
): Promise<RelatedSeries> {
  const channel = detail.type;
  const currentId = detail.id;
  const label = parseSeasonLabel(detail.title);
  const seen = new Set<string>([currentId]);
  const fallbackPage = Math.max(1, Math.trunc(options.fallbackPage ?? 1));

  let seasons: SeasonPick[] = [];

  /**
   * guo 源（`guo:` 前缀）与神秘小窝跳过搜索段。
   *
   * guo 源的剧在红果网页 / 动漫源里**根本不存在**，拿它的标题去搜只会捞回一批
   * 同名不同剧的红果条目，再被同系列筛选全拒——白打两次往返。18+ 频道同理：
   * 红果没有对应口径，拿公开榜单去填等于把普通短剧塞进神秘小窝。
   */
  if (label && channel !== 'adult' && !currentId.startsWith('guo:')) {
    const keyword = label.base;

    /**
     * 两路并行，`allSettled` 收口。
     *
     * 网页搜索快（实测 0.3–0.6s）但只返回前 10 条，分季条目常常跳着出现；
     * App 联想慢（冷启动 Python，0.6–1.9s）却是全局索引，补的正是漏掉的季。
     * 串联会让总耗时相加，并行只取最大值——慢的那条完整地藏在用户读卡的时间里。
     * 任何一路失败都只丢它自己的条目，不牵连另一路。
     */
    const [fast, suggest] = await Promise.allSettled([
      ipcService.catalog.searchFast(searchFilter(channel, keyword)),
      ipcService.catalog.searchSuggest(keyword, channel),
    ]);

    const candidates: SeriesItem[] = [];
    if (fast.status === 'fulfilled') candidates.push(...fast.value.items);
    if (suggest.status === 'fulfilled') candidates.push(...suggest.value);

    seasons = pickSeasons(candidates, label, currentId);
    seasons.forEach(pick => seen.add(pick.item.id));
  }

  const others: SeriesItem[] = [];
  /**
   * 兜底目录**总是**拉（18+ 除外）。
   *
   * ## 为什么不再"同系列够了就跳过"
   *
   * 早期版本在这里判断 `seasons.length < SEASON_ENOUGH`，同系列够一屏就不拉兜底。
   * 但同系列季数常常是"一屏多一点"（实测这部剧 7 季）：第 0 批装 6 季很满，第 1 批
   * 只剩 1 季——而兜底池是空的，剩下的 5 个位置无从补起，网格从 6 张塌成 1 张
   * （实测就是这个现象）。
   *
   * 那个判断原本的理由是"补一批不相干的剧会挤掉真正的接续推荐"，但**切片是
   * seasons 优先、others 只补位**（见 `sliceRelatedBatch`），兜底内容根本挤不掉
   * 同系列季卡。所以这个顾虑不成立，代价只是一次 `catalog.list`（后端有缓存）。
   */
  if (channel !== 'adult') {
    try {
      const page = await ipcService.catalog.list({
        channel,
        category: '全部',
        audience: '全部',
        sort: 'recommend',
        page: fallbackPage,
        pageSize: 24,
      });
      for (const item of page.items) {
        if (seasons.length + others.length >= POOL_LIMIT) break;
        if (!item?.id || !item.title || seen.has(item.id)) continue;
        seen.add(item.id);
        others.push(item);
      }
    } catch {
      // 兜底失败就只留同系列：推荐是增量信息，不值得冒泡成错误。
    }
  }

  return { seasons, others };
}

/** 一屏的切片结果。`seasons` 与 `others` 合计 `SLOT_COUNT` 条。 */
export interface RelatedSlice {
  seasons: SeasonPick[];
  others: SeriesItem[];
}

/**
 * 第 `page` 屏上有几张季卡。
 *
 * 季卡**优先占满整屏**：正在看第 5 季时，用户要的是「第6、第7、第8、第9、第10季」
 * 一路接下去，而不是「4 季 + 2 部不相干的剧」。所以这里不预留座位给兜底内容——
 * 兜底只在季卡真的不够铺满一屏时（池子里的季都排完了）才补位。
 *
 * 早期版本固定留 2 个座位（`FALLBACK_RESERVE`），理由是想让「换一批」有东西可翻。
 * 但那会让 10 季的池子每屏只显示 4 季，第 10 季被直接挤出屏幕 —— 与本栏的核心
 * 目的（接着看下一季）冲突。「换一批」的可翻性由"季卡分段翻页 + 兜底补位"解决，
 * 不需要牺牲季卡的位置。
 */
function seasonsOnPage(totalSeasons: number, page: number): number {
  return Math.max(0, Math.min(SLOT_COUNT, totalSeasons - page * SLOT_COUNT));
}

/**
 * 季卡一共铺满几屏。
 *
 * ## 没有季卡时是 0 屏，不是 1 屏（2026-10-19 修正）
 *
 * 旧实现返回 `max(1, ...)`，把"没有季卡"也算成 1 屏。那是为了兼容"第 0 批必须
 * 有内容"的写法，但它带来一个副作用：`sliceRelatedBatch` 里的 `pages - 1` 会
 * 变成 0，于是**季卡永远被钳制在第 0 页**，翻批时反复显示同一批季卡。
 *
 * 现在返回真实的屏数：0 表示"这一栏没有季卡，全部走兜底"。
 */
function seasonPageCount(totalSeasons: number): number {
  return Math.ceil(totalSeasons / SLOT_COUNT);
}

/**
 * 第 `batch` 屏开始前，兜底池已经被用掉了多少条。
 *
 * ## 为什么要精确算
 *
 * 兜底段要**接着往下走**而不是每屏从头开始，否则「换一批」翻到后半段会重复前面的
 * 内容。每屏消耗的条数等于"这一屏剩下的座位数"，而座位数又取决于这一屏有几张季卡
 * ——所以必须逐屏累加，不能用 `batch * 固定值` 近似。
 *
 * ## 季卡全部展示完之后（2026-10-19 修正）
 *
 * 旧实现假设"季卡页走完后每屏季卡数固定在最后一页的量"，也就是季卡会一直占座。
 * 现在的规则是**季卡按接续顺序全部展示完，之后整屏交给兜底内容**，所以季卡页
 * 走完之后每屏消耗的兜底条数就是 `SLOT_COUNT`（满屏），不再有季卡占座。
 */
function othersConsumedBefore(totalSeasons: number, batch: number): number {
  const pages = seasonPageCount(totalSeasons);

  let consumed = 0;
  // 季卡还在铺的这几屏：每屏消耗「6 - 这一屏的季卡数」条兜底。
  for (let page = 0; page < Math.min(batch, pages); page += 1) {
    consumed += SLOT_COUNT - seasonsOnPage(totalSeasons, page);
  }
  // 季卡已经全部展示完：之后每屏都是满屏兜底。
  if (batch > pages) consumed += (batch - pages) * SLOT_COUNT;
  return consumed;
}

/**
 * 池子里能翻出多少种不同的屏。
 *
 * = 季卡铺满的屏数 + 兜底内容还能再撑几屏。兜底池被季卡页"顺带消耗"掉的那部分
 * 要先扣掉，否则批数会虚高，翻到后面全是重复。
 *
 * 季卡全部展示完之后，每屏是满屏兜底（`SLOT_COUNT` 条），所以剩余屏数按它算。
 */
export function relatedBatchCount(pool: RelatedSeries): number {
  const pages = seasonPageCount(pool.seasons.length);
  const consumedBySeasons = othersConsumedBefore(pool.seasons.length, pages);
  const restOthers = Math.max(0, pool.others.length - consumedBySeasons);
  // 季卡走完后不再占座，每屏满额消耗兜底。
  const extra = Math.ceil(restOthers / SLOT_COUNT);
  // 没有任何内容时至少 1 屏（否则「换一批」会被判定为"没得翻"而卡住）。
  return Math.max(1, pages + extra);
}

/**
 * 从候选池里切出第 `batch` 屏。
 *
 * ## 为什么要有这个函数
 *
 * 「换一批」此前只是"清缓存重拉"，而 `fetchRelatedSeries` 是确定性函数 —— 同一部剧
 * 搜同样的词、过同样的筛选排序，重拉必然得到同一批，点了完全没反应（用户报的 bug）。
 * 真正的"换"只能来自**在更大的池子里换一个起点**，这就是 `batch` 的作用。
 *
 * ## 排布规则：季卡优先，但按顺序全部展示完
 *
 * 每屏先放季卡，放不满才用兜底内容补位。正在看第 5 季、池子里有第 6~10 季时，
 * 第一屏就是「第6、第7、第8、第9、第10季」——**后续季优先**（`seasonOrder` 已按
 * "往后接、越近越前"排好），剩下的座位才轮到前作和同频道其它剧。
 *
 * ## 季卡展示完就轮到兜底（2026-10-19 修正）
 *
 * 旧实现把季卡**钳制在最后一页**：翻批时季卡永远重复同一批，只有右侧兜底在变。
 * 那让"季卡优先"退化成了"季卡固定"——用户看到的是一栏永远不动的主卡。
 *
 * 现在的规则是：
 *   - 第 0 屏起按 `seasonOrder` 顺序把季卡**逐屏铺开**（后续季在前、越近越前）；
 *   - 季卡全部展示完之后（`batch >= seasonPageCount`），**不再重复出季卡**，
 *     整屏交给兜底内容；
 *   - 排序始终由 `seasonOrder` 决定，不因翻批而打乱接续顺序。
 *
 * 也就是说：季卡是"优先展示"，不是"固定占位"。
 *
 * ## 回绕而不是留空
 *
 * 兜底段翻到池尾时回绕到开头（而不是给一张短屏）：回绕的代价只是几条重复，而短屏
 * 会让网格从 6 张变成 2 张，看起来像"换一批把推荐换没了"。
 *
 * 纯函数、无随机：同一 `(pool, batch)` 永远得到同一屏，测试可以确定性断言，
 * 用户来回点也能预期看到什么（随机取样会让这类 bug 更难复现）。
 */
export function sliceRelatedBatch(pool: RelatedSeries, batch: number): RelatedSlice {
  const index = Math.max(0, Math.trunc(batch));

  /**
   * 季卡段：按页往后铺，**铺完就停**（不钳制、不重复）。
   *
   * `pool.seasons` 已由 `pickSeasons` 按 `seasonOrder` 排好序（后续季在前、
   * 越近越前），这里只做切片，不重新排序——排序规则必须只有一处，
   * 否则两处各写一份就会漂移成"角标按 A 排、卡面按 B 排"的错位。
   */
  const pickedSeasons = pool.seasons.slice(index * SLOT_COUNT, index * SLOT_COUNT + SLOT_COUNT);

  const remaining = SLOT_COUNT - pickedSeasons.length;
  if (remaining <= 0 || pool.others.length === 0) {
    return { seasons: pickedSeasons, others: [] };
  }

  // 兜底段接着前面几屏已经用掉的条数往后走。
  const start = othersConsumedBefore(pool.seasons.length, index);
  const pickedOthers: SeriesItem[] = [];
  for (let offset = 0; offset < remaining; offset += 1) {
    // 到池尾就回绕取头部（理由见上面的「回绕而不是留空」）。
    pickedOthers.push(pool.others[(start + offset) % pool.others.length]);
  }

  return { seasons: pickedSeasons, others: pickedOthers };
}
