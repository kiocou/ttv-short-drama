import { normalizeTitle, parseSeasonLabel, seasonUnitGroup } from './seasonLabel';

/**
 * 搜索结果的**同系列折叠**：一个系列在列表里只占**一张卡**，点进去再选季。
 *
 * ## 两种形态，一套归属规则
 *
 * - `groupSeriesItems` —— 聚块：同系列的季连续挨着、组内按季号升序（2026-10-29 第一版）。
 * - `collapseSeriesGroups` —— 折叠：整组只剩一张代表卡（2026-10-29 第二版，用户原话：
 *   *还是全部铺出来的，并没有全部合并到一个卡片里面*）。
 *
 * 两者的归属解析**必须完全一致**（membership 优先、组键 = base + 量词组、落位 = 最小
 * 下标），否则会出现"聚块时是一组、折叠时是两组"的分裂。所以它们共用内部
 * `collectGroups`，对外只差最后一步怎么输出。
 *
 * ## 为什么需要"归属表"这一层
 *
 * 光按标题解析会漏掉最关键的那一条：**第 1 季常常是裸名**。后端季表里 index=1 的
 * 标题就是「烬九州」（id `7647789981687106622`），`parseSeasonLabel` 解析不出季号 ——
 * 只按标题分组的话，折叠出的代表卡会变成"第 2 季"，而第 1 季孤零零留在块外。
 *
 * 归属有两个来源，**季表优先**：
 * 1. `membership`：后端 `catalog_series_seasons` 明确告诉我们"这条 id 属于哪个系列的第几季"
 *    （`searchSeasonExpand.ts` 在并季时回填）；
 * 2. 标题解析：没有季表信息时的兜底（首屏本身就带季号的情形）。
 *
 * ## 为什么是 O(n)
 *
 * 这两个函数挂在每次 `setItems` 的出口上：首屏 40 条、「加载更多」每页 40 条、
 * 联想与聚合各来一次。所以每条标题只解析一次（同标题走 Map 缓存），分组与输出都是
 * 线性扫描，唯一的 `sort` 只发生在组内（总长度仍是 n）。
 */

/** 一条条目在系列里的位置：哪个系列（归一后的 base）+ 第几季。 */
export interface SeriesMember {
  /** 归一后的系列名（`normalizeTitle(base)`），分组键的主体。 */
  baseKey: string;
  /** 季号。 */
  season: number;
}

/** series id → 归属。由季表回填，key 是 series id。 */
export type MembershipMap = Map<string, SeriesMember>;

/**
 * 折叠后的一项：整个系列只留一个代表 + 它的规模信息。
 *
 * 无归属的条目（别的剧）也以这个形状返回：`memberCount: 1`、`seasonCount: undefined`。
 */
export interface CollapsedSeries<T> {
  /**
   * 代表条目：**组内原始下标最小的那条**（= 搜索相关度最高的那张）。
   *
   * ## 为什么不是"季号最小"（2026-10-29 修正）
   *
   * 两种搜法要同时成立：
   * - 搜「烬九州」：接口把裸名本体排在第 1 位，代表自然就是第 1 季 —— 符合预期；
   * - 搜「烬九州第三十五季」：返回里排在前面的是第 35 期。若按季号最小取代表，
   *   用户会看到一张「烬九州」（第 1 季）的卡，以为自己搜错了。
   *
   * 按位置取就同时满足：用户点的那张卡就是他搜到的那一季。聚合补进来的季都在列表
   * 尾部（下标最大），永远抢不到代表位，所以这个规则天然稳定。
   */
  representative: T;
  /** 这一组原本有几条（折叠掉多少张卡）。 */
  memberCount: number;
  /**
   * 该系列总季数。**只在能确信时给出**：`maxSeason === 不同季号个数`（季号连续无缺口）
   * 才 = `maxSeason`；否则 `undefined`（卡上不显示季数角标）。
   *
   * 反例：「持械入宋」只有第一季与第九季两条，缺口 2~8 一大片 —— 显示「共 9 季」
   * 是在替源数据编一个它没给过的断言，用户点进去发现只有 2 季会更困惑。
   */
  seasonCount?: number;
}

/**
 * 把新的归属并进已有表里。
 *
 * **原地合并并返回同一个 Map**（不新建）：这张表会随每一次「加载更多」增长，
 * 每页都重建一遍是白白的 O(总条数)。调用方拿到返回值重新赋值即可（引用不变也无妨）。
 *
 * 先到的优先：同一 id 若已有归属就不覆盖 —— 聚合只会给它**自己带回来的** id，
 * 不会覆盖别人的判断；跨锚点重复 id 在并季时已去重。
 */
export function mergeMembership(target: MembershipMap, extra: MembershipMap): MembershipMap {
  for (const [id, member] of extra) {
    if (!target.has(id)) target.set(id, member);
  }
  return target;
}

/**
 * 内部用的组键。
 *
 * = 归一后的 base + 量词组别（`seasonUnitGroup`）。为什么不是裸 base：
 * 「镇世无双第二部」与「镇世无双第二季」是两套独立编号（「部」是分卷习惯），
 * 并成一个组会让"第2部"直接排在"第2季"旁边，用户看到两套编号撞在一起。
 * 而「第二季」与「第三十五期」是同一套编号（站方混用），必须同组。
 *
 * 用 `\u0000` 分隔：剧名里不会出现这个字符，避免「甲#乙」这种拼接碰撞。
 */
function groupKeyOf(baseKey: string, unit: 'season' | 'volume'): string {
  return `${baseKey}\u0000${unit}`;
}

/** 一次解析的结果：既给组键，也给季号。`null` = 这条没有归属。 */
interface Resolved {
  groupKey: string;
  season: number;
}

/** 一个组：落位（最小下标）+ 成员（按原始顺序追加）。 */
interface GroupBucket<T> {
  anchor: number;
  members: { index: number; item: T; season: number }[];
}

/**
 * 归属解析 + 分组，两个对外函数共用。
 *
 * 返回 `resolved`（与 items 同下标，`null` 表示无归属）与 `buckets`（组键 → 组）。
 * `buckets` 的插入顺序就是各组的落位顺序，`members` 按原始下标递增追加。
 */
function collectGroups<T extends { id: string; title: string }>(
  items: readonly T[],
  membership: MembershipMap,
): { resolved: (Resolved | null)[]; buckets: Map<string, GroupBucket<T>> } {
  /** 同标题只解析一次：一页 40 条里分季标题的 base 高度重复。 */
  const byTitle = new Map<string, Resolved | null>();

  const resolve = (item: T): Resolved | null => {
    const known = membership.get(item.id);
    if (known) return { groupKey: groupKeyOf(known.baseKey, 'season'), season: known.season };

    const title = item.title ?? '';
    if (byTitle.has(title)) return byTitle.get(title) ?? null;
    const label = parseSeasonLabel(title);
    let resolved: Resolved | null = null;
    if (label) {
      const baseKey = normalizeTitle(label.base);
      if (baseKey) {
        resolved = { groupKey: groupKeyOf(baseKey, seasonUnitGroup(label.unit)), season: label.season };
      }
    }
    byTitle.set(title, resolved);
    return resolved;
  };

  const resolved: (Resolved | null)[] = [];
  const buckets = new Map<string, GroupBucket<T>>();

  items.forEach((item, index) => {
    const entry = resolve(item);
    resolved.push(entry);
    if (!entry) return;
    const bucket = buckets.get(entry.groupKey);
    if (bucket) {
      bucket.members.push({ index, item, season: entry.season });
    } else {
      buckets.set(entry.groupKey, { anchor: index, members: [{ index, item, season: entry.season }] });
    }
  });

  return { resolved, buckets };
}

/**
 * 聚块：同系列聚到**首次出现的位置**，组内按季号升序；无归属条目原样留在原位。
 *
 * ## 算法
 *
 * 1. 逐条求归属：`membership.get(id)` 优先，否则 `parseSeasonLabel(title)`；
 * 2. 同 `baseKey`（同量词组）的条目归一组，组的**落位 = 该组在原始列表里的最小下标**；
 * 3. 组内按 `season` 升序，同 season 保持原始相对顺序（用原始下标做 tie-break，
 *    不依赖 `Array.sort` 的稳定性实现）；
 * 4. 从列表头开始扫：遇到某组的落位就整组展开（已展开的组跳过），其余原样输出；
 * 5. 无归属条目的相对顺序不变 —— 它们是别的剧，不该被排动。
 *
 * ⚠️ 搜索页现在用的是 `collapseSeriesGroups`（一个系列一张卡）。这个函数保留，
 * 是因为「展开态」将来若要做（点开系列就地铺季），它就是要用的那一层；
 * 而且 `verify:series-grouping` 的既有断言全部钉在它上面。
 */
export function groupSeriesItems<T extends { id: string; title: string }>(
  items: readonly T[],
  membership: MembershipMap,
): T[] {
  if (items.length <= 1) return items as T[];

  const { resolved, buckets } = collectGroups(items, membership);

  // 全无归属：原样返回，不复制。调用方（`setItems`）拿同一个引用，React 也不会白渲染。
  if (buckets.size === 0) return items as T[];

  // 组内排序：季号升序，同季按原始下标（稳定，且不依赖 sort 的实现细节）。
  for (const bucket of buckets.values()) {
    if (bucket.members.length <= 1) continue;
    bucket.members.sort((left, right) => left.season - right.season || left.index - right.index);
  }

  const output: T[] = [];
  const expanded = new Set<string>();

  items.forEach((item, index) => {
    const entry = resolved[index];
    if (!entry) {
      // 无归属：原样输出（相对顺序天然不变）。
      output.push(item);
      return;
    }
    const bucket = buckets.get(entry.groupKey);
    if (!bucket || bucket.anchor !== index) return; // 组员的第一次出现已在落位处展开
    if (expanded.has(entry.groupKey)) return;
    expanded.add(entry.groupKey);
    for (const member of bucket.members) output.push(member.item);
  });

  return output;
}

/**
 * 折叠：一个系列只输出**一张代表卡**，顺序 = 各组的落位顺序；无归属条目各自单独成项。
 *
 * ## 代表怎么选
 *
 * 组内**原始下标最小**的那条（见 `CollapsedSeries.representative` 的注释）：搜索语义
 * 是"相关度最高的那张就是入口"，而不是"系列的第 1 季就是入口"。`buckets` 的 `members`
 * 按原始下标递增追加，所以 `members[0]` 就是落位那条。
 *
 * ## 季数怎么给
 *
 * 只有当季号**连续无缺口**（`maxSeason === 不同季号个数`）且不止一季时才给。宁可
 * 不显示，也不要显示一个"共 9 季"而其实只有 2 季 —— 用户点进去就会发现问题。
 *
 * ## 为什么 memberCount 一定要留着
 *
 * 卡片本身只显示代表，但"这个系列被折叠了几条"是排查"搜到的季去哪了"的唯一线索
 * （也用于角标：只有 > 1 时才值得一提）。
 */
export function collapseSeriesGroups<T extends { id: string; title: string }>(
  items: readonly T[],
  membership: MembershipMap,
): CollapsedSeries<T>[] {
  if (items.length === 0) return [];

  const { resolved, buckets } = collectGroups(items, membership);
  const output: CollapsedSeries<T>[] = [];

  items.forEach((item, index) => {
    const entry = resolved[index];
    if (!entry) {
      // 无归属：自成一卡，不带季数（它不是"某个系列的第 N 季"）。
      output.push({ representative: item, memberCount: 1 });
      return;
    }
    const bucket = buckets.get(entry.groupKey);
    if (!bucket || bucket.anchor !== index) return;

    const seasons = new Set(bucket.members.map(member => member.season));
    const maxSeason = Math.max(...seasons);
    // 季号连续且不止一季才算得出真实季数；否则不编。
    const seasonCount = maxSeason > 1 && maxSeason === seasons.size ? maxSeason : undefined;

    output.push({
      representative: bucket.members[0].item,
      memberCount: bucket.members.length,
      seasonCount,
    });
  });

  return output;
}
