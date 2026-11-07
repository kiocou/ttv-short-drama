export interface GuoSource {
  id: string;
  name: string;
  /**
   * 历史实测判定（2026-09-29 一次性探针手填），**已停用，全 19 个源清空**。
   *
   * 停用原因：站方状态会变，而这份快照永远停在填表那一刻 —— 芽果当时就记着
   * "未返回有效的访问令牌"，却仍被填成 `available`，界面上于是一直显示成可用。
   * 实时状态改由 `ipcService.catalog.guoSourceStatus()` 读 guo-core 的体检
   * 结果，没体检过的源一律显示"未检测"（不变量 8）。
   *
   * 保留这个可选字段只为兼容旧引用点；要新增健康度判定请走 guo-core，不要
   * 在这里手填——手填的结论过期后没人知道它过期了。
   */
  status?: 'available' | 'partial' | 'blocked';
  /**
   * 该源的目录内容是「真人」还是「漫剧」。
   *
   * 依据是 2026-09-29 用 guo-core 直接拉 `catalog` action 逐源实测前 12 条的
   * 标题/分类/标签/集数（不是凭站名猜）：
   * - `live`  真人拍摄。判据是条目有具体剧情简介、多为几十上百集。
   * - `comic` 动画/漫剧。判据是分类名含"国漫/动漫"，或条目是合集。
   * - `both`  两种都有。
   *
   * 实测结论：**19 个源里只有 3 个含漫剧内容**（红果走自有频道、黄豆有"国漫"
   * 分类如《牧神记》《凡人190》、花果有条目《工资真相-动漫合集》），其余全是真人
   * 短剧。所以"漫剧次元"这个 tab 的实际内容由这三个源决定。
   *
   * 已知限制：guo-core 的 `catalog` action **不接收频道参数**（`guo_provider.rs`
   * 的 catalog 请求体只有 source/category/query/page/force），所以除红果外，
   * 同一个源在两个 tab 里返回的是**同一份数据**。`both` 是"这个源两种内容都有"，
   * 不代表能按 tab 过滤——这是源的限制，不是可以在前端修的。
   */
  kind: 'live' | 'comic' | 'both';
  /**
   * 18+ 成人内容源：受设置页"显示 18+ 内容源"总开关控制，关闭时不进启用列表、
   * 不参与目录聚合与搜索。**分类依据是各源实际目录内容**（2026-09-29 逐源实测）：
   * - 黄豆：多数"黄豆原创"（真人成人），同站另有"国漫"分类
   * - 剧果：分类恒为"短剧"，成人真人条目
   * - 野果：分类恒为"短剧"，标签为成人题材
   * - 帝果：真人成人向（无码中字/无码破解）
   * - 黄果 AI：分类名即 "AI 短剧"（AI 生成、真人外形）
   * - 黄果视频：series/video 混合条目，真人
   */
  adult?: boolean;
  /**
   * 已下线的源：从选择器、目录聚合与体检面板里移除。
   *
   * 判据是 2026-10-19 的全链路体检（catalog → detail → resolve，直连）：
   * 观果详情接口返回空、牛果 resolve 57s 超时、发果目录 24s 超时、皮果域名
   * 无法解析。四条都是“点开必挂”的死链，留着只会让用户以为是自己网络坏了。
   *
   * 为什么用标记而不是从清单里删掉：① 历史/收藏里可能还留着这些源的剧 id，
   * 物理删除会让它们连“来源名”都解析不出来；② 后端 `GUO_SOURCES` 同时承担
   * 18+ 门闩的登记职责（`source_is_adult`），删掉 18+ 源等于给旧 id 开后门。
   * 标记停用只影响“能不能被选到、会不会进聚合”，不影响按 id 直连。
   */
  retired?: boolean;
}

/**
 * 内置源清单：**只有红果一个**（2026-11-02 源收敛）。
 *
 * 其余 18 个 guo 站源已全部下架，后续来源改由插件系统加载（后端 `source_registry`，
 * 设置页「添加视频源」）。所以这里不再需要手工同步一份 19 项清单——那正是
 * 「前后端各存一份、迟早漂」的根源。
 *
 * 旧的 18 个源在后端 `LEGACY_GUO_SOURCES` 里留了名字与 adult 标记，用于兼容
 * 历史 id 的显示与 18+ 门闩；前端不需要它们：删掉就是真的从选择器与聚合里消失。
 */
export const GUO_SOURCES: GuoSource[] = [
  // 唯一内置源：红果短剧 / 漫剧。
  //
  // 2026-11-02 源收敛：其余 18 个站源全部下架；后续来源改由插件系统加载
  // （后端 `source_registry`，设置页「添加视频源」）。红果在**两端都固定**：
  // 前端不给取消入口，后端 `normalize_enabled_sources` 也会把它补回。
  //
  // 旧的 18 个源只在后端 `LEGACY_GUO_SOURCES` 里留了一份名字/adult 表用于
  // 兼容历史 id，前端不再需要它们：这里删掉就是真的从选择器与聚合里消失。
  { id: 'hongguo', name: '红果短剧 / 漫剧', kind: 'both' },
];

/**
 * 该源是否属于「短剧专区 / 漫剧次元」这两个 tab。
 *
 * **18+ 源一律返回 false**：它们独占「神秘小窝」专区（见 `adultTabSources`）。
 * 早先这里只按 `kind` 判，于是剧果/野果/帝果/黄果 AI/黄果视频（`kind: live`）
 * 和黄豆（`kind: both`）会同时出现在短剧专区与神秘小窝——同一批内容在两个
 * tab 里各出现一次，而其中一个 tab 的存在意义就是"隔离成人内容"。
 *
 * `kind` 描述的是**内容形态**（真人/漫剧），`adult` 描述的是**分级**，
 * 两个维度正交：分级高的内容不该因为形态是真人就混进普通专区。
 */
export function sourceMatchesTab(source: GuoSource, tab: 'drama' | 'comic'): boolean {
  if (source.adult) return false;
  if (source.kind === 'both') return true;
  // `kind` 描述形态（live/comic），`tab` 是频道名（drama/comic）——两套命名。
  // 早先直接写 `source.kind === tab` 是在比 `'live' === 'drama'`，恒为假：
  // 于是**除红果外所有真人源都被判为不属于短剧专区**。真实覆盖靠的是
  // `kind: both` 那三个源兜着（红果/黄豆/花果），真人专区实际上只剩红果。
  return source.kind === (tab === 'drama' ? 'live' : 'comic');
}

/**
 * 「神秘小窝」要聚合的源。
 *
 * 与 `enabledSourcesForTab` 互补而非重叠：那边靠 `sourceMatchesTab` 把 18+ 源
 * 排除掉，这边只收 18+ 源，两边合起来正好是不重不漏的全集。
 *
 * 总开关关闭时返回空数组：专区此时根本不存在（前端连 tab 都不渲染）。
 */
export function adultTabSources(enabled: string[], showAdult: boolean): GuoSource[] {
  if (!showAdult) return [];
  const chosen = new Set(enabled);
  return GUO_SOURCES.filter(item => item.adult && !item.retired && chosen.has(item.id));
}

/**
 * 当前启用的源 id 列表。
 *
 * 启用集合存在设置里（`enabledSources`），默认只有红果——19 个源全开会并发打
 * 19 个站点的目录接口，首屏会被最慢的那个拖住。18+ 源还要额外过总开关：
 * 总开关关闭时它们一律不启用，即使用户之前勾过。
 */
export function enabledSourceIds(enabled: string[], showAdult: boolean): string[] {
  const chosen = new Set(enabled);
  return GUO_SOURCES
    .filter(item => !item.retired)
    .filter(item => chosen.has(item.id))
    .filter(item => showAdult || !item.adult)
    .map(item => item.id);
}

/** 按 tab 过滤后的启用源（`both` 计入两个 tab）。 */
export function enabledSourcesForTab(enabled: string[], showAdult: boolean, tab: 'drama' | 'comic'): GuoSource[] {
  const ids = new Set(enabledSourceIds(enabled, showAdult));
  return GUO_SOURCES.filter(item => ids.has(item.id) && sourceMatchesTab(item, tab));
}
