import { ipcService } from './ipc';
import { normalizeTitle, parseSeasonLabel } from './seasonLabel';
import type { MembershipMap } from './seriesGrouping';
import type { ChannelType, SeasonApiEntry, SeriesItem } from '../types/catalog';

/**
 * 搜索页的**系列聚合**：搜到某个系列时，把这个系列的各季补进结果列表。
 *
 * ## 为什么要有这一层（2026-10-29）
 *
 * 用户搜《烬九州》只看到 3 张卡，而它其实有 35 季。原因是搜索接口只回答"哪些条目
 * 和这个词相关"，它没有义务把一个系列的每一季都塞进前 N 条——网页搜索更是按相关度
 * 截断（`hongguoduanju.com/search` 改版后甚至恒返回 0 条，首屏只剩 App 联想那几条）。
 *
 * 详情页那边已经证明了正解：后端 `catalog_series_seasons` 按 series id 一次给出
 * 权威季表。这里把同一件事搬到列表侧：**从结果里认出"这是哪个系列"，再拿季表把
 * 整季补进来**。
 *
 * ## 为什么不复用 `relatedSeries.ts`
 *
 * 那边回答的是"当前这部剧的其它季"（要排接续顺序、要排除当前季、要给季卡角标），
 * 输入是详情对象。这里回答的是"这批搜索结果里出现了哪几个系列"，输入是候选列表、
 * 输出是待并入的条目，语义与给用户看的形状都不同。硬塞进去会让那个文件同时承担
 * 两种排序模型。
 *
 * ## 不臆造
 *
 * 认不出系列（没有任何一条标题带季号）时，退化成"拿第一条当锚点试一次"——它不是
 * 猜测某个系列是哪一季，只是把站方返回的第一条当作可能的系列入口去问一次季表。
 * 季表为空、命令不存在或抛错，都只是"没有可补的季"，绝不改动已有结果。
 */

/**
 * 从搜索结果里挑出「值得去问季表」的锚点。
 *
 * ## 规则
 *
 * 1. 用 `parseSeasonLabel` 取出 `base`（剧名去掉季号），按 `normalizeTitle` 归一后
 *    分组：同一部剧的「第34季」「第35期」会落进同一组；
 * 2. 每组只取**一个**代表，优先取**季号最小**的那条 —— 它最可能是系列入口：站方
 *    的条目 id 越小越早建立，而"第34季"比"第35期"更靠近系列头部；更重要的是，
 *    拿季号最大的那条去问也能拿到同一张季表，但拿最小的更稳（后端若只按 id 反查
 *    系列，早期季通常挂在系列主记录上）；
 * 3. 最多返回 `limit` 个（默认 2）。每个锚点都要打一次后端，实测 0.3–0.9s，两路
 *    并行是"覆盖一个系列 + 一个误判"的成本上限；
 * 4. 一个 base 都没解析出来时，退回「取第 1 条」作为唯一锚点（见文件头"不臆造"）。
 *
 * ## 为什么组内要比较季号而不是"先到先得"
 *
 * 实测《烬九州》的首屏是：裸名《烬九州》(98 集) → 「烬九州：三十四季」→
 * 「烬九州第三十五期」。裸名那条解析不出季号（`parseSeasonLabel` 返回 null），
 * 所以它连组都进不去；后两条同组，取季号小的那条 = 「三十四季」。
 *
 * 纯函数、无网络：锚点挑选是整个聚合里最容易悄悄错掉的一环（错了就是"搜到的剧
 * 一张都没补进来"或"补进来一堆别的剧"），必须能脱离 Tauri 断言。
 */
export function pickSeasonAnchors(items: readonly SeriesItem[], limit = 2): SeriesItem[] {
  const capped = Math.max(0, Math.trunc(limit));
  if (capped === 0) return [];

  /** key = 归一的 base；value = 该组里季号最小的那条与它的季号。 */
  const bestByBase = new Map<string, { item: SeriesItem; season: number }>();

  for (const item of items) {
    if (!item?.id || !item.title) continue;
    const label = parseSeasonLabel(item.title);
    if (!label) continue;
    const key = normalizeTitle(label.base);
    if (!key) continue;

    const current = bestByBase.get(key);
    // 同组取季号最小的那条；季号相同则保留先到的（结果顺序即相关度，先到更可信）。
    if (!current || label.season < current.season) {
      bestByBase.set(key, { item, season: label.season });
    }
  }

  if (bestByBase.size === 0) {
    /**
     * 一条季号都解析不出来：退化成"第 1 条"。
     *
     * 典型情形是结果里只有裸名《烬九州》——而它极可能就是一个系列的本体（站方对
     * 第一季常常只写裸剧名，与 `currentSeasonLabel` 里那条判定同源）。不试这一次，
     * 这类搜索结果永远补不出任何季；试错的代价只是后端多打一次季表查询、返回空表。
     */
    const first = items.find(candidate => candidate?.id && candidate.title);
    return first ? [first] : [];
  }

  // Map 保持插入顺序：锚点按它们在结果里首次出现的先后排列，便于日志与测试预期。
  return [...bestByBase.values()].slice(0, capped).map(entry => entry.item);
}

/**
 * 把锚点所在系列的各季转成可并入列表的条目。
 *
 * ## 三条取舍
 *
 * 1. **过滤掉未上架的季**（`disablePlay === true || episodeCount <= 0`）：用户明确
 *    说过不想看到"点开没内容"的卡。这一层过滤**只作用于新补进来的季** —— 首屏那条
 *    本体已在列表里、有自己的来源与封面，去重时保留先到的，不在这里删它。
 * 2. **跨锚点按 id 去重**：两个锚点可能属于同一系列（分组的 base 归一不完全一致时），
 *    或者后端对同一季返回了多条记录。
 * 3. **任何一路失败静默**：季表是增量来源，失败只意味着"少补几张卡"。用
 *    `allSettled` 而不是 `all` —— 一路挂了不该让另一路的季白拿。
 *
 * ## 为什么每路都包一层 `Promise.resolve().then(...)`
 *
 * 旧后端（以及 `scripts/verify-*.mjs` 里的 ipc-stub）没有 `seriesSeasons` 这个方法，
 * 直接调用会在 `map` 里**同步**抛 TypeError —— 那时 `allSettled` 还没拿到 promise，
 * 异常会冒出去打断整个搜索页的渲染。包一层之后，"方法不存在"与"方法是异步的"都
 * 变成同一个 rejected promise，由 `allSettled` 统一收口。
 */
export interface ExpandedSeasons {
  /** 待并入的季条目（已过滤未上架、跨锚点去重），与聚合前的返回结构一致。 */
  items: SeriesItem[];
  /**
   * 每条并入的季 → 它属于哪个系列的第几季。
   *
   * 必须与 `items` 一起返回：分组（`seriesGrouping.ts`）靠它把**裸名的第 1 季**
   * 认回组里 —— 季表 index=1 的标题就是「烬九州」，`parseSeasonLabel` 解析不出季号，
   * 只按标题分组的话这一条会被当成"别的剧"留在块外。
   */
  membership: MembershipMap;
}

export async function expandSeriesSeasons(
  items: readonly SeriesItem[],
  channel: ChannelType,
): Promise<ExpandedSeasons> {
  const anchors = pickSeasonAnchors(items);
  if (anchors.length === 0) return { items: [], membership: new Map() };

  const lookup: ((id: string) => Promise<SeasonApiEntry[]>) | undefined =
    ipcService.catalog.seriesSeasons;

  // 两路**并行**：每个锚点一次请求（实测 0.3–0.9s），串联会让等待相加。
  const results = await Promise.allSettled(
    anchors.map(anchor =>
      Promise.resolve()
        .then(() => (typeof lookup === 'function' ? lookup(anchor.id) : []))
        .then(entries => (Array.isArray(entries) ? entries : [])),
    ),
  );

  const seen = new Set<string>();
  const expanded: SeriesItem[] = [];
  const membership: MembershipMap = new Map();

  results.forEach((result, anchorIndex) => {
    if (result.status !== 'fulfilled') return;
    const anchor = anchors[anchorIndex];
    /**
     * 这个锚点所在系列的归一 base。
     *
     * 锚点本来就是"解析得出季号"的那条（`pickSeasonAnchors` 的选取规则），所以正常
     * 走第一个分支；解析不出时退回整标题归一 —— 那种情况只可能出现在"结果里一条季号
     * 都没有、退回第 1 条当锚点"的兜底分支里，用整标题当 key 至少能自成一类，
     * 不会把无关的剧混进来。
     */
    const anchorLabel = parseSeasonLabel(anchor.title);
    const baseKey = anchorLabel
      ? normalizeTitle(anchorLabel.base)
      : normalizeTitle(anchor.title);

    result.value.forEach((entry, entryIndex) => {
      if (!entry?.seriesId) return;
      // 用户明确不想看到"点开没内容"的卡：禁播与 0 集都不进列表。
      if (entry.disablePlay === true || entry.episodeCount <= 0) return;
      if (seen.has(entry.seriesId)) return;
      seen.add(entry.seriesId);

      /**
       * 季号：后端给了结构化季号就用它，否则用**该季表里的位次**（接口按季号升序
       * 返回，位次即 1-based 季序）。与 `relatedSeries.ts::seasonsFromApi` 同一口径，
       * 两处对"第几季"的判断不能有分歧。
       */
      const season = entry.seasonIndex > 0 ? entry.seasonIndex : entryIndex + 1;

      expanded.push({
        id: entry.seriesId,
        title: entry.title,
        cover: entry.cover,
        type: channel,
        episodesCount: entry.episodeCount,
        // 后端季表只有"这是哪一季"，没有题材/来源。tags 留空而不是补「短剧」：
        // `SeriesCard` 对空 tags 直接不渲染那一行，补默认值等于替源数据编造断言。
        tags: [],
        // 标成后端季表，不冒称「官网直链」。
        origin: '系列列表',
      });
      membership.set(entry.seriesId, { baseKey, season });
    });
  });

  return { items: expanded, membership };
}
