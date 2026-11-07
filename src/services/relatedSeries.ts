import { ipcService } from './ipc';
import {
  normalizeTitle,
  parseSeasonLabel,
  seasonOrder,
  seasonUnitGroup,
  type SeasonLabel,
} from './seasonLabel';
import type { CatalogFilter, ChannelType, SeasonApiEntry, SeriesItem } from '../types/catalog';
import type { SeriesDetail } from '../types/series';

/**
 * 详情页的两条推荐链路：**「猜你喜欢」** 与 **「系列剧」弹窗**。
 *
 * ## 为什么这两件事被拆开了（2026-10-21）
 *
 * 此前只有一条链路：详情页底部那一栏先铺同系列其它季、凑不满一屏才用同频道其它剧
 * 补位。用户看过之后提了两条互斥的要求 ——
 *
 * 1. 「猜你喜欢」里**不要**出现同系列的任何一季（那栏的语义是"换一部剧看看"，
 *    同一部剧的其它季已经在上面「选集播放」里有了入口，重复出现只是噪音）；
 * 2. 同系列其它季**要能完整看到**，但不能挤在猜你喜欢里，改成点「系列剧」按钮
 *    弹一个窗口按当前界面风格铺成卡片网格。
 *
 * 于是数据层一分为二，两个函数各自只回答一个问题：
 * - `fetchRelatedSeries` —— 同频道、**已剔除同系列**、可轮换的候选池（猜你喜欢）；
 * - `fetchSeriesSeasons` —— 同系列其它季，按接续顺序排好（系列剧弹窗）。
 *
 * 拆分还有一个副作用是好事：猜你喜欢不再发那两次搜索请求（网页搜索 + App 联想），
 * 打开详情页少两次往返；搜索只在用户真的点开「系列剧」时才发生。
 *
 * ## 为什么不新增一条后端命令（2026-10-21 的判断，2026-10-29 已反转）
 *
 * 当时的结论是：分季能力后端**已经全有了**，只是藏在搜索链路里 ——
 * `catalog_fast_search` 走红果网页搜索、`catalog_suggest` 走红果 App 联想，两者在
 * `provider.rs` 里已带「同系列按季号排序」「中文数字变体回查」，再开一条命令等于重写一遍。
 *
 * 实测把这条判断推翻了：搜索是**按相关度截断**的（只给前 10 条），《烬九州》35 季
 * 怎么加锚点都补不全；而季号只能从标题里猜，遇到「第三十五期」这种量词变体直接失效；
 * 用户搜错一个字（镜/烬）连 base 都比不上。于是后端新增权威命令
 * **`catalog_series_seasons`**（`{ seriesId }` → 全部季，季号结构化），
 * `fetchSeriesSeasons` 现在优先走它，搜索链路降级为回退（细节见该函数注释）。
 * 上面的搜索链路与筛选规则一条没删 —— 老后端、Web 演示模式、命令失败时仍然要靠它。
 *
 * ## 不臆造
 *
 * 推荐是纯增量信息，任何一路失败都只是少几张卡：搜索两路用 `allSettled`，
 * 兜底目录失败就返回空池。两路都空时组件整块不渲染 —— 不编默认剧，也不拿
 * 当前剧集自己凑数。
 */

/**
 * 一屏展示的卡数。
 *
 * 定成 6 是为了**一行装完**：网格只用 2/3/4/6 列（跳过 5 列，理由同 `HomeShelf`
 * ——6 条在 5 列下会排成 5+1，第二行孤零零挂一张，看起来像布局塌了）。
 *
 * ⚠️ **这是"一屏几张"，不是"池子多大"**。早期版本把它同时当成两者（`pickSeasons`
 * 直接 slice 到 6、兜底也补满 6），结果是候选池恒等于一屏——「换一批」清缓存重拉
 * 拿到的还是同一批，点了完全没反应。池子必须比一屏大，轮换才有东西可换。
 */
export const SLOT_COUNT = 6;

/**
 * 「猜你喜欢」候选池上限。
 *
 * 4 屏的量：再多也没有意义（用户连点四次「换一批」的概率极低），而每条都要占
 * 一个封面解析通道与一次潜在的网络请求。
 */
const POOL_LIMIT = SLOT_COUNT * 4;

/**
 * 「系列剧」弹窗的季卡上限。
 *
 * 这里刻意比 `POOL_LIMIT` 宽一倍：猜你喜欢是"挑几条给你看"，超过一屏就没意义；
 * 而弹窗是"完整展示这个系列"，用户点进来就是为了把每一季都看一遍。实测站上最长
 * 的系列是 14 季，48 已经是留足余量的上限 —— 真出现超过 48 季的条目，多半是把
 * 「第1080集」这类数字误读成了季号（`SEASON_LIMIT` 的同一类顾虑）。
 */
export const SEASON_POOL_LIMIT = SLOT_COUNT * 8;

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
  /**
   * 这一季**能不能点开看**（2026-10-29）。
   *
   * 站上有"先建条目、后上架"的做法：季卡存在，但 `episodeCount === 0`，
   * 点进去只有一个空选集。用户反馈过"列表里出现还没上架、点开没内容"的剧，
   * 弹窗里必须把这类季卡置灰，而不是让用户白点一次。
   *
   * 两个来源的判定口径不同，**但含义一致**：
   * - 权威链路（`catalog_series_seasons`）：`!disablePlay && episodeCount > 0`，
   *   站方明确禁播的也算不可用；
   * - 搜索回退链路：只能看到集数，取 `episodesCount > 0` 这一条保守判法
   *   （宁可让用户点进去发现是空的，也不要把本来能看的季误置灰）。
   */
  available: boolean;
}

/** 「猜你喜欢」的候选池：只有同频道其它剧，**不含同系列**。 */
export interface RelatedSeries {
  /** 兜底的同频道推荐，与当前剧不同系列。构成可轮换的候选池。 */
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
 * 这部剧能不能查同系列。
 *
 * guo 源（`guo:` 前缀）与神秘小窝跳过：guo 源的剧在红果网页 / 动漫源里**根本不存在**，
 * 拿它的标题去搜只会捞回一批同名不同剧的红果条目，再被同系列筛选全拒——白打两次
 * 往返。18+ 频道同理：红果没有对应口径。
 *
 * 导出是为了让详情页的「系列剧」按钮与这里共用同一份判定：两处各写一份，必然漂移成
 * "按钮显示得出来、点开永远是空窗口"。
 */
export function canLookupSeasons(detail: SeriesDetail): boolean {
  if (detail.type === 'adult') return false;
  if (detail.id.startsWith('guo:')) return false;
  // 无季号的剧也要给入口：它极可能就是某系列的第 1 季（站方对第一季常常
  // 只写裸剧名）。点开之后按「第 1 季」的基准去找同名/带季号的其它季：
  //   - 同名裸名条目 → 就是他自己，排除；
  //   - 《聚宝盆 第2季》《聚宝盆 第三季》 → 收下。
  // 真的没有其它季时弹窗给空态文案，代价只是多点一次。
  return Boolean(detail.title.trim());
}

/**
 * 当前剧的「当季基准」。
 *
 * 带季号 → 用解析结果；不带季号 → 按**第 1 季**构造一个基准（base 就是完整剧名）。
 *
 * 为什么需要这一层：用户明确指出第一季有两种常见命名（《聚宝盆》与
 * 《聚宝盆》第1季）。若只认带季号的标题，从第 2 季往前看会漏掉裸名第 1 季，
 * 而从裸名第 1 季往右看则整个入口都不出现 —— 两个方向的症状不同，根因是同一个。
 */
export function currentSeasonLabel(detail: SeriesDetail): SeasonLabel | null {
  const parsed = parseSeasonLabel(detail.title);
  if (parsed) return parsed;
  const base = detail.title.trim().replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
  if (!base) return null;
  return { base, season: 1, unit: '季' };
}

/**
 * 从候选里筛出真正属于同一系列、且不是当前季的条目，并按接续顺序排好。
 *
 * 三重比对缺一不可：
 * - **base 归一后相等** —— 站点同一部剧的剧名在不同来源里带不同标点/全角空格；
 * - **量词组一致** —— 「季」与「期」是同一套编号（站方对同一系列会混用，实测
 *   《烬九州》第 32~35 季写作「第N期」），归一成同组；而「第一季」与「第一部」是
 *   两种分卷习惯，混在一组里会让"第2部"排到"第2季"旁边，用户看到的是两套编号
 *   撞在一起，所以「部」独立成组（见 `seasonUnitGroup`）；
 * - **季号不等于当前季** —— 同一季可能有另一个 id 的条目（不同来源），推荐它
 *   等于把用户正在看的这部剧再推一遍。**这也是「新窗口不显示当前季」的实现点**：
 *   弹窗只渲染本函数的返回值，第 4 季从数据层就不在里面。
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

    /**
     * 无季号的同名条目 = 这个系列的**第 1 季**（2026-10-21 用户反馈）。
     *
     * 用户原话：*我看的是《聚宝盆》第1季，实际名可能是《聚宝盆》，也可能是
     * 《聚宝盆》第1季*。站方对第一季的命名没有统一约定 —— 它常常就是裸剧名，
     * 不带任何「第N季」后缀。旧实现只认带季号的条目，于是从第 2 季往前看时
     * 永远找不到那个裸名的第 1 季，弹窗里凭空少一季。
     *
     * 判定"裸名就是第 1 季"而不是"另一个系列"，靠两点：
     * ① 整条标题归一后**精确等于** base（多一个字都不算，避免把
     *    《聚宝盆外传》这种真正不同的剧并进来）；
     * ② 当前季号必须 > 1 —— 如果用户正在看第 1 季，那这一条就是他自己
     *    （id 不同也可能），不该再出现一次。
     */
    if (!itemLabel) {
      if (label.season === 1) continue;
      if (normalizeTitle(item.title) !== baseKey) continue;
      if (bySeason.has(1)) continue;
      bySeason.set(1, item);
      seenIds.add(item.id);
      continue;
    }

    // 量词组比较：`季` 与 `期` 同组（同义混用），`部` 自成一组。
    if (seasonUnitGroup(itemLabel.unit) !== seasonUnitGroup(label.unit)) continue;
    if (normalizeTitle(itemLabel.base) !== baseKey) continue;
    if (itemLabel.season === label.season) continue;
    if (bySeason.has(itemLabel.season)) continue;
    bySeason.set(itemLabel.season, item);
    seenIds.add(item.id);
  }

  return [...bySeason.entries()]
    .sort((left, right) => seasonOrder(left[0], label.season) - seasonOrder(right[0], label.season))
    .slice(0, SEASON_POOL_LIMIT)
    .map(([season, item]) => ({
      item,
      season,
      relation: season > label.season ? 'next' : 'previous',
      // 搜索条目只有集数这一个可判信号：0 集就是还没上架。保守判法 —— 见
      // `SeasonPick.available` 的注释（宁可点进去发现是空的，也不误置灰）。
      available: item.episodesCount > 0,
    }));
}

/**
 * 后端权威季表的一次探测（2026-10-29）。
 *
 * ## 为什么写成"可选探测"而不是直接调 `ipcService.catalog.seriesSeasons`
 *
 * `scripts/verify-*.mjs` 用 esbuild 把 `./ipc` 整体替换成一个只含
 * `searchFast / searchSuggest / list` 的假实现（见 `scripts/verify-related-pick.mjs`
 * 里的 ipc-stub），那里没有 `seriesSeasons`。直接调用会抛 TypeError，而这几组用例
 * 断言的恰恰是**回退链路**的行为 —— 探测不到就当作"后端不支持"，原样走回退，
 * 两边的契约都不动。
 *
 * 任何异常都吞成空数组：它是增量来源，绝不能把详情页弄红（`ipc.ts` 里那一层已经
 * 收口过一次，这里是第二道保险）。
 */
async function lookupSeasonEntries(seriesId: string): Promise<SeasonApiEntry[]> {
  const lookup: ((id: string) => Promise<SeasonApiEntry[]>) | undefined =
    ipcService.catalog.seriesSeasons;
  if (typeof lookup !== 'function') return [];
  try {
    const entries = await lookup(seriesId);
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

/**
 * 后端全季列表 → 弹窗季卡。
 *
 * ## 季号只取 `seasonIndex`，不再解析标题
 *
 * 回退链路只能从标题里猜季号，而标题写法并不统一：`第7季` / `第七季` / `第七期` /
 * `第七部` 都见过（《烬九州》第 32~35 季就是「第N期」）。猜错一次，排序与角标会一起
 * 错成"排序按第2季、角标显示第3季"。后端给了结构化季号就以它为唯一来源，
 * `seasonIndex === 0`（服务端没给）才退回数组位次 —— 接口按季号升序返回，位次即
 * 1-based 季序。
 *
 * ## 排除规则与 `pickSeasons` 一致
 *
 * 同 id、同季号的条目都不出卡：同一季在站上可能有来自不同来源的两个 id，按 id
 * 排除的话当前季会以另一张卡的身份重新冒出来 —— 那正是用户说"不要"的东西。
 *
 * ## 为什么这里**不**截断到 `SEASON_POOL_LIMIT`
 *
 * `pickSeasons` 有 48 季上限兜底，因为搜索候选池本就不完整、50 条以上多半是
 * 「第1080集」被误读成季号。权威链路是站方真实的季表：实测《烬九州》35 季一次
 * 返回、index 连续 1..35，而用户点开弹窗就是为了看全 —— 没有理由替他切掉后半段。
 */
function seasonsFromApi(
  entries: readonly SeasonApiEntry[],
  currentId: string,
  currentIndex: number,
  channel: SeriesDetail['type'],
): SeasonPick[] {
  const picks: SeasonPick[] = [];
  /** 当前季先占位：同季号的其它 id 也不进池（与 `pickSeasons` 的 `label.season` 对齐）。 */
  const seenSeasons = new Set<number>([currentIndex]);

  entries.forEach((entry, index) => {
    if (!entry?.seriesId) return;
    if (entry.seriesId === currentId) return;
    const season = entry.seasonIndex > 0 ? entry.seasonIndex : index + 1;
    if (seenSeasons.has(season)) return;
    seenSeasons.add(season);

    picks.push({
      item: {
        id: entry.seriesId,
        title: entry.title,
        cover: entry.cover,
        type: channel,
        episodesCount: entry.episodeCount,
        // 后端季表只有"这是哪一季"，没有题材/来源。tags 留空而不是补一个「短剧」：
        // `SeriesCard` 对空 tags 直接不渲染那一行，补默认值等于替源数据编造断言
        // （同 `SeriesCard` 里关于假标签的那段注释）。
        tags: [],
        // 来源标成后端季表，不冒称「官网直链」。
        origin: '系列列表',
      },
      season,
      relation: season > currentIndex ? 'next' : 'previous',
      available: !entry.disablePlay && entry.episodeCount > 0,
    });
  });

  return picks.sort(
    (left, right) => seasonOrder(left.season, currentIndex) - seasonOrder(right.season, currentIndex),
  );
}

/**
 * 拉取「系列剧」弹窗的内容：同系列其它季，按接续顺序排好（后续季在前、越近越前）。
 *
 * ## 两条链路，权威优先（2026-10-29）
 *
 * 1. **后端权威季表**（`catalog_series_seasons`）：按 series id 一次给出该系列全部季
 *    （含未上架季），季号结构化。这是《烬九州》35 季只出一条 / 弹窗空白的正解，
 *    也是常态路径 —— 命中时**不发任何搜索请求**，打开弹窗从"最多 4 次往返"降到 1 次。
 * 2. **搜索回退**（下面的两轮）：后端不支持该命令、或季表里除当前季外没有别的季时
 *    才走。它是增量兜底，行为与判定口径完全保持原样。
 *
 * 两路并行、`allSettled` 收口（回退链路）：
 * - 网页搜索快（实测 0.3–0.6s）但只返回前 10 条，分季条目常常跳着出现；
 * - App 联想慢（冷启动 Python，0.6–1.9s）却是全局索引，补的正是漏掉的季。
 * 串联会让总耗时相加，并行只取最大值。任何一路失败都只丢它自己的条目。
 *
 * 返回空数组表示"这个系列确实没有其它季"，也包含"这部剧本来就不分季"与
 * "两路搜索都失败" —— 弹窗对这三种情形给的是同一句话（见 `SeriesSeasonsDialog`），
 * 因为从用户视角它们是同一件事：这里没有别的季可看。
 */
export async function fetchSeriesSeasons(detail: SeriesDetail): Promise<SeasonPick[]> {
  if (!canLookupSeasons(detail)) return [];
  // 用 `currentSeasonLabel` 而不是 `parseSeasonLabel`：裸名（无季号）的剧按第 1 季
  // 处理，否则《聚宝盆》这种命名连入口都进不来。
  const label = currentSeasonLabel(detail);
  if (!label) return [];

  /**
   * ===== 权威链路：后端结构化全季列表 =====
   *
   * 当前的季号优先取后端那条自己（`seriesId === detail.id`）的 `seasonIndex`：
   * 标题里的季号可能与站方季表不一致（《烬九州》标题写「第三十五期」，而季表说
   * index=35），以季表为准，两者的结论才对得上。后端没给（0）或没有自己那条时，
   * 退回标题解析出来的季号。
   *
   * 命中条件：除当前季外**至少还有一季**。只有当前季（或空表）时不能当成"没有
   * 其它季"直接返回 —— 那可能是后端只认出了当前剧，此时该让搜索回退再尽力补一次。
   */
  const entries = await lookupSeasonEntries(detail.id);
  if (entries.length > 0) {
    const self = entries.find(entry => entry.seriesId === detail.id);
    const currentIndex = self && self.seasonIndex > 0 ? self.seasonIndex : label.season;
    const fromApi = seasonsFromApi(entries, detail.id, currentIndex, detail.type);
    if (fromApi.length > 0) return fromApi;
  }

  const keyword = label.base;
  const candidates: SeriesItem[] = [];
  /** 按 id 去重：多路搜索会返回大量重叠条目。 */
  const seen = new Set<string>();
  const absorb = (items: readonly SeriesItem[] | undefined) => {
    for (const item of items ?? []) {
      if (!item?.id || seen.has(item.id)) continue;
      seen.add(item.id);
      candidates.push(item);
    }
  };

  // ===== 第一轮：基础名搜索 + App 联想（并行）=====
  //
  // 两路都保留（2026-10-22 修正）：一度想去掉 suggest 省掉 0.6–1.9s 的 Python
  // 冷启动，理由是"实测它只返回重复条目"。但那只对《聚宝仙盆》这一部成立 ——
  // suggest 走红果 App 的全局索引，覆盖面与网页搜索不同，**别的剧可能正是靠它
  // 才补齐**。系列剧弹窗的用户诉求是"别缺季"，用一两秒换覆盖率是划算的；
  // 何况它与 fast 并行，只取两者最大值，不叠加。
  const first = await Promise.allSettled([
    ipcService.catalog.searchFast(searchFilter(detail.type, keyword)),
    ipcService.catalog.searchSuggest(keyword, detail.type),
  ]);
  const [fast, suggest] = first;
  if (fast.status === 'fulfilled') absorb(fast.value.items);
  if (suggest.status === 'fulfilled') absorb(suggest.value);

  /**
   * ===== 第二轮：按季号锚点补搜（2026-10-22 修「系列剧卡片不全」）=====
   *
   * ## 问题
   *
   * 用户看的是《聚宝仙盆之杂灵根才是真BOSS》第 14 季，弹窗里「前作 4 季」却只
   * 铺出**第 13、12、2、1 季**，中间第 3–11 季整段消失。
   *
   * ## 根因
   *
   * 两路搜索都是**按相关度截断**的，不是"把同系列所有季都返回"：
   *   实测 `searchFast(base)` → 只有 10 条，其中同系列仅 1/2/12/13/14 五季；
   *   `searchSuggest(base)` → 只有 2 条，还是 1/14。
   * 站方把"最相关"的 10 条给了我们，中间那些季在它自己的排序里就排在 10 名之外，
   * 于是**再多翻页也拿不到**（实测翻到第 3 页仍是同一批 10 条去重后 10 条）。
   *
   * ## 为什么锚点有效
   *
   * 把季号写进关键词会改变搜索的相关度排序，让**另一批**季进入前 10：
   *   实测 `base+"第3季"` → 返回 2/3/4/9/12/13，正好补上 3、4、9；
   *   再叠 `base+"第8季"` → 补上 5/6/7/8/10/11。
   * 三路合并后 1–14 季**全覆盖**（实测 4ms，缓存热时）。
   *
   * ## 为什么是自适应锚点而不是固定几个
   *
   * 固定写"第3季/第8季"只对 14 季左右的剧有效；一部 40 季的剧仍然会漏。
   * 这里先从第一轮结果里读出**已知最大季号**，再按它取 1/3 与 2/3 两个锚点 ——
   * 不论系列有多长，锚点都落在候选区间内部，补搜效率最高。
   *
   * 上限 3 路：再多就是拿打开弹窗的延迟换边际覆盖率，不划算（每路一次 IPC）。
   */
  const knownSeasons = candidates
    .map(item => parseSeasonLabel(item.title)?.season)
    .filter((season): season is number => typeof season === 'number' && season > 0);
  const maxKnown = knownSeasons.length > 0 ? Math.max(...knownSeasons) : 0;

  if (maxKnown > 3) {
    /**
     * 补搜锚点：在「已知最大季号」区间内取 1/4、1/2、3/4 三个位置。
     *
     * ## 为什么要多个锚点（实测反例）
     *
     * 单中点对《聚宝仙盆之杂灵根才是真BOSS》（14 季）能全覆盖，但对
     * 《长生狱主，一念镇九幽》（9 季）只补出 1/3/5，缺 2/4/6/7/8 ——
     * 因为每次搜索的"相关度排序"不同，单个锚点只能撬开其中一段。
     * 三个锚点把区间切成四段，每段各撬一次，覆盖率明显更稳。
     *
     * ## 为什么是 3 个而不是更多
     *
     * 后端搜索不是真并发（实测 9 路并发要 6.5s、4 路约 3s），每多一路都线性
     * 增加弹窗等待。3 个是"覆盖率"与"打开速度"的折中；真凑不齐时用户仍能
     * 通过「更多」页自己翻到，而弹窗至少不会缺一整段。
     */
    const anchors = [
      Math.max(2, Math.round(maxKnown / 4)),
      Math.max(2, Math.round(maxKnown / 2)),
      Math.max(3, Math.round((maxKnown * 3) / 4)),
    ]
      .filter((season, index, list) => list.indexOf(season) === index)
      .filter(season => season !== label.season && season <= maxKnown);

    if (anchors.length > 0) {
      const extra = await Promise.allSettled(
        anchors.map(season =>
          ipcService.catalog.searchFast(searchFilter(detail.type, `${keyword}第${season}季`)),
        ),
      );
      for (const result of extra) {
        if (result.status === 'fulfilled') absorb(result.value.items);
      }
    }
  }

  // 回退结果的 `available` 已在 `pickSeasons` 里按 `episodesCount > 0` 补好：
  // 搜索链路看不到 `disablePlay`，只能给这条保守判法（见 `SeasonPick.available`）。
  return pickSeasons(candidates, label, detail.id);
}

/**
 * 后端全季列表 → 季卡，**一条都不排除**（搜索页「选季」弹窗用）。
 *
 * 与 `seasonsFromApi` 的差别只有两点，但两点都不能混：
 * - 不排除"当前季"（搜索页没有当前季的概念，见 `fetchAllSeriesSeasons`）；
 * - 排序是**季号升序**而不是 `seasonOrder`。后者是"后续季优先、越近越前"的接续
 *   顺序，用在详情页的推荐语境里；选季窗口要的是"从第 1 季顺着往下看"。
 *
 * 同季号仍只留一条：同一季在站上可能有来自不同来源的两个 id，铺两张一模一样的
 * 季卡只会让用户以为列表出错。
 */
function allSeasonsFromApi(
  entries: readonly SeasonApiEntry[],
  channel: SeriesDetail['type'],
): SeasonPick[] {
  const picks: SeasonPick[] = [];
  const seenSeasons = new Set<number>();

  entries.forEach((entry, index) => {
    if (!entry?.seriesId) return;
    // 季号只取后端结构化值，0 才退回位次（接口按季号升序返回，位次即 1-based 季序）。
    const season = entry.seasonIndex > 0 ? entry.seasonIndex : index + 1;
    if (seenSeasons.has(season)) return;
    seenSeasons.add(season);

    picks.push({
      item: {
        id: entry.seriesId,
        title: entry.title,
        cover: entry.cover,
        type: channel,
        episodesCount: entry.episodeCount,
        // 后端季表没有题材/来源；tags 留空，`SeriesCard` 对空 tags 直接不渲染那一行。
        tags: [],
        origin: '系列列表',
      },
      season,
      // 没有当前季做参照，所有季统一按"后续季"的强调色渲染。
      relation: 'next',
      available: !entry.disablePlay && entry.episodeCount > 0,
    });
  });

  return picks.sort((left, right) => left.season - right.season);
}

/**
 * 搜索页「选季」弹窗的数据源：**该系列全部季，含折叠卡代表的那一季**（2026-10-29）。
 *
 * ## 为什么不能复用 `fetchSeriesSeasons`
 *
 * 那个函数的语义是"我在看第 N 季，给我**别的**季"——它排除当前季（详情页的系列剧
 * 弹窗要的正是这个）。搜索页没有"当前季"：用户点的是折叠后的代表卡，他想知道的是
 * "这个系列一共有哪几季"，把第 1 季排掉会让他以为少了第一季。
 *
 * 两者语义相反，所以是两个函数而不是一个 `includeCurrent` 开关：调用点只有两处，
 * 开关只会让"哪边排除了什么"更难读，也更容易在将来被误改。
 *
 * ## 数据来源的优先级与 `fetchSeriesSeasons` 一致
 *
 * 1. 后端权威季表 —— 一次给全，季号结构化；
 * 2. 拿不到（空表 / 异常 / 旧后端）时回退搜索链路：直接复用 `fetchSeriesSeasons`
 *    的结果（同系列筛选、排序、`available` 判定都已做完），再**补回代表那一季**。
 *    这样不必重写第四套筛选规则，也就不会出现"选季窗口和详情页弹窗判得不一样"。
 *
 * 失败一律返回 `[]`，不抛：它是弹窗的增量内容，不该把搜索页弄红。
 */
export async function fetchAllSeriesSeasons(
  seriesId: string,
  title: string,
  channel: ChannelType,
): Promise<SeasonPick[]> {
  if (!seriesId || !title?.trim()) return [];

  const entries = await lookupSeasonEntries(seriesId);
  if (entries.length > 0) return allSeasonsFromApi(entries, channel);

  /**
   * 回退：`fetchSeriesSeasons` 只接受 `SeriesDetail`，而搜索页手上只有一个
   * `SeriesItem`（没有选集/清晰度/播放源）。这里补一个只含**判定真正需要的那三个字段**
   * 的最小对象 —— `canLookupSeasons` 与 `currentSeasonLabel` 只读 id / title / type，
   * 其余字段填空值即可，不伪造任何数据。
   */
  const detailLike: SeriesDetail = {
    id: seriesId,
    title,
    cover: '',
    type: channel,
    tags: [],
    origin: '',
    episodesCount: 0,
    description: '',
    episodes: [],
    availableQualities: [],
    sources: [],
  };

  if (!canLookupSeasons(detailLike)) return [];
  const label = currentSeasonLabel(detailLike);
  if (!label) return [];

  let others: SeasonPick[] = [];
  try {
    others = await fetchSeriesSeasons(detailLike);
  } catch {
    others = [];
  }

  /**
   * 补回代表季本身。
   *
   * `available: true`：这一季就是用户刚刚在列表里看到、并据此点开弹窗的那张卡 ——
   * 它能出现在搜索结果里，说明站上有内容。搜索回退链路拿不到 `disablePlay` / 集数，
   * 与其置灰一张用户刚点过的卡，不如放行；真没内容时详情页自己会给空选集。
   */
  const selfPick: SeasonPick = {
    item: {
      id: seriesId,
      title,
      cover: '',
      type: channel,
      episodesCount: 0,
      tags: [],
      origin: '',
    },
    season: label.season,
    relation: 'next',
    available: true,
  };

  return [selfPick, ...others.filter(pick => pick.item.id !== seriesId)].sort(
    (left, right) => left.season - right.season,
  );
}

export interface FetchRelatedOptions {
  /**
   * 兜底目录取第几页。首屏是 1；「换一批」把候选池耗尽后由调用方递增，
   * 这样新一批里能出现真正没见过的剧，而不是原地重排同一批。
   */
  fallbackPage?: number;
}

/**
 * 拉取「猜你喜欢」的候选池：**同频道、且不属于当前这部剧所在系列**的其它剧。
 *
 * ## 为什么这里一条同系列都不出（2026-10-21 用户要求）
 *
 * 这一栏此前是"同系列接续季优先，凑不满一屏用同频道其它剧补位"。用户看过之后
 * 要求把系列短剧整块移出去：同一部剧的其它季已经在「选集播放」上方有独立入口
 * （「系列剧」按钮），在猜你喜欢里再铺一遍等于同一份内容占两个版面，而那一栏真正
 * 该回答的是"下一部看什么"。
 *
 * 所以这里**只拉一页目录，然后剔除同系列**：
 *
 * - 有季号的条目：base 归一后相等 → 同一部剧（含当前季的另一个 id，以及「第一部」
 *   这种不同分卷量词的版本 —— 理由见 `sameSeries` 里那段量词说明）；
 * - 没有季号的条目：整条标题归一后等于当前剧的 base → 同一部剧的未标季版本，
 *   同样剔除（用户看到的就是同一部剧）。
 *
 * 一页 24 条里同系列通常只有几季，剔除后仍远大于一屏；真凑不满时「换一批」会
 * 去拉下一页，而不是在这里循环补页——那会让 `fallbackPage` 的语义与调用方的
 * 递增逻辑打架（两边各推进一次页号，翻两批就会跳页）。
 */
export async function fetchRelatedSeries(
  detail: SeriesDetail,
  options: FetchRelatedOptions = {},
): Promise<RelatedSeries> {
  const fallbackPage = Math.max(1, Math.trunc(options.fallbackPage ?? 1));

  /**
   * 18+ 频道不拉公开目录：红果没有对应口径，拿公开榜单去填等于把普通短剧
   * 塞进神秘小窝。
   */
  if (detail.type === 'adult') return { others: [] };

  const label = parseSeasonLabel(detail.title);
  const baseKey = label ? normalizeTitle(label.base) : '';
  const seen = new Set<string>([detail.id]);

  /**
   * 这一条是否属于当前这部剧所在的系列（判定规则见函数头注释）。
   *
   * ⚠️ **这里刻意不比量词**，与 `pickSeasons` 不同。两处的目的不一样：
   * - `pickSeasons` 要给季卡编号并排序，「第一季」和「第一部」混在一组会让两套
   *   编号撞车（第2部排到第2季旁边），所以量词必须同组才算同组（`seasonUnitGroup`
   *   里把「期」与「季」并成一族 —— 站方对同一系列会混用，实测《烬九州》第 32~35 季
   *   写作「第N期」；不并的话这几季会被当成"无季号条目"而漏掉）；
   * - 这里只回答"这一条是不是同一部剧"，而「聚宝仙盆第一部」与「聚宝仙盆第14季」
   *   在用户眼里就是同一部剧 —— 漏掉它，猜你喜欢里就会出现一部用户正在看的剧的
   *   另一个分卷版本，正是用户要求移除的东西。
   *
   * 宁可少推荐一条，也不要把同一部剧再推一遍。
   */
  const sameSeries = (item: SeriesItem): boolean => {
    if (!item?.id || !item.title) return false;
    if (item.id === detail.id) return true;
    if (!label) return false;
    const itemLabel = parseSeasonLabel(item.title);
    if (itemLabel) return normalizeTitle(itemLabel.base) === baseKey;
    return normalizeTitle(item.title) === baseKey;
  };

  const others: SeriesItem[] = [];

  /**
   * App 原生推荐优先（`series_recommend`，走红果的 plan feed）。
   *
   * 这一路是**真正的"相关推荐"**：服务端按当前剧给出的相关视频 cell，而下面那段
   * 目录兜底只是"同频道的其它剧"，与当前剧没有关系。所以顺序是：先放原生推荐，
   * 不够 `POOL_LIMIT` 再用目录补齐。
   *
   * 失败静默：这一栏是增量信息，接口挂了就退回原来的目录逻辑，不弹错。
   * 同系列过滤照常走 `sameSeries`——推荐里同样可能混进本剧的其它季。
   */
  try {
    const rec = await ipcService.hongguo.seriesRecommend(detail.id, detail.type);
    for (const item of rec?.items ?? []) {
      if (others.length >= POOL_LIMIT) break;
      if (!item?.id || !item.title || seen.has(item.id)) continue;
      if (sameSeries(item)) continue;
      seen.add(item.id);
      others.push(item);
    }
  } catch {
    // 原生推荐不可用：继续走目录兜底。
  }

  try {
    const page = await ipcService.catalog.list({
      channel: detail.type,
      category: '全部',
      audience: '全部',
      sort: 'recommend',
      page: fallbackPage,
      pageSize: 24,
    });
    for (const item of page.items) {
      if (others.length >= POOL_LIMIT) break;
      if (!item?.id || !item.title || seen.has(item.id)) continue;
      if (sameSeries(item)) continue;
      seen.add(item.id);
      others.push(item);
    }
  } catch {
    // 目录失败就返回空池：这一栏是增量信息，不值得冒泡成错误。
  }

  return { others };
}

/** 一屏的切片结果。 */
export interface RelatedSlice {
  others: SeriesItem[];
}

/**
 * 池子里能翻出多少种不同的屏。
 *
 * = 兜底内容能撑几屏。没有任何内容时至少 1 屏（否则「换一批」会被判定为"没得翻"
 * 而卡住）。
 */
export function relatedBatchCount(pool: RelatedSeries): number {
  return Math.max(1, Math.ceil(pool.others.length / SLOT_COUNT));
}

/**
 * 从候选池里切出第 `batch` 屏。
 *
 * ## 为什么要有这个函数
 *
 * 「换一批」此前只是"清缓存重拉"，而 `fetchRelatedSeries` 对同一页目录是确定性
 * 的 —— 重拉必然得到同一批，点了完全没反应（用户报的 bug）。真正的"换"只能来自
 * **在更大的池子里换一个起点**，这就是 `batch` 的作用。
 *
 * ## 回绕而不是留空
 *
 * 翻到池尾时回绕到开头（而不是给一张短屏）：回绕的代价只是几条重复，而短屏会让
 * 网格从 6 张变成 2 张，看起来像"换一批把推荐换没了"。池子不足一屏时同理 —— 回绕
 * 填满，永远给完整的一屏。
 *
 * 纯函数、无随机：同一 `(pool, batch)` 永远得到同一屏，测试可以确定性断言，
 * 用户来回点也能预期看到什么（随机取样会让这类 bug 更难复现）。
 */
export function sliceRelatedBatch(pool: RelatedSeries, batch: number): RelatedSlice {
  const index = Math.max(0, Math.trunc(batch));
  const total = pool.others.length;
  if (total === 0) return { others: [] };

  const start = (index * SLOT_COUNT) % total;
  const picked: SeriesItem[] = [];
  for (let offset = 0; offset < SLOT_COUNT; offset += 1) {
    picked.push(pool.others[(start + offset) % total]);
  }
  return { others: picked };
}
