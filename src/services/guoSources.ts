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
   * - 黄豆：母上攻略 / 苏老师的裸贷人生 / 深渊调教，同站另有"国漫"分类
   * - 剧果：同学妈妈(无删减版) / 欧美成人片演员名条目
   * - 野果：母子同淫 / 魔法少女淫乱之路（标签直白：乱伦/巨乳/中出）
   * - 帝果：日本 AV（无码中字/无码破解，含番号）
   * - 黄果 AI：分类名即 "AI 短剧"，少妇白洁 / 滴滴代操
   * - 黄果视频：母子同欢第2季 / 苏老师的裸贷人生
   */
  adult?: boolean;
}

/**
 * 19 个 guo 站源的静态清单。
 *
 * 只描述**结构性的、源侧决定的**属性（kind / adult），不描述运行期健康度——
 * 后者一律现查 guo-core（`ipcService.catalog.guoSourceStatus`）。下面每条
 * `实测` 注释记录的是 2026-09-29 拉目录时的内容特征，用来支撑 kind / adult
 * 的分类依据；它们证明的是"这个源里装的是什么内容"，不是"这个源现在通不通"。
 */
export const GUO_SOURCES: GuoSource[] = [
  // 实测：2044 条全为真人短剧（都市/逆袭/爱情/年代，有剧情简介、几十至上百集）；
  // 红果是唯一"频道参数真的生效"的源——短剧与漫剧走两条不同的官方接口。
  { id: 'hongguo', name: '红果短剧 / 漫剧', kind: 'both' },
  // 实测 30 条：多数"黄豆原创"（真人成人），但含"国漫"分类的《牧神记》《凡人190》。
  { id: 'huangdou', name: '黄豆', kind: 'both', adult: true },
  // 实测 20 条：分类恒为"短剧"，标题为成人真人条目。
  { id: 'huangju', name: '剧果', kind: 'live', adult: true },
  // 实测 20 条：分类恒为"短剧"，标签为成人题材；集数全部为 0。
  { id: 'yeguo', name: '野果', kind: 'live', adult: true },
  // 实测 72 条：日本 AV（无码中字 / 无码破解，含番号），真人。
  { id: 'dsd', name: '帝果', kind: 'live', adult: true },
  // 实测 96 条：分类恒为 "AI 短剧"（AI 生成、真人外形），有集数。
  { id: 'huangguoai', name: '黄果 AI', kind: 'live', adult: true },
  // 实测 40 条：分类为 series/video 的混合条目，真人。
  { id: 'huangguo-video', name: '黄果视频', kind: 'live', adult: true },
  // 实测失败："芽果未返回有效的访问令牌"，内容未验证，暂按真人登记。
  { id: 'yaguo', name: '芽果', kind: 'live' },
  // 实测 66 条：都市情感真人短剧，33~70 集。
  { id: 'maoguo', name: '猫果', kind: 'live' },
  // 实测 10 条：分类恒为"都市"，真人，30~90 集。
  { id: 'fanguo', name: '饭果', kind: 'live' },
  // 实测 30 条：玄幻仙侠/都市爱情/逆袭/甜宠，真人。
  { id: 'guanguo', name: '观果', kind: 'live' },
  // 实测 63 条：都市/古风/复仇真人短剧，部分条目集数为 0。
  { id: 'heguo', name: '河果', kind: 'live' },
  // 实测 10 条：真人短剧，20~91 集。
  { id: 'xingguo', name: '星果', kind: 'live' },
  // 实测 36 条：标题带题材后缀的真人短剧，但含《工资真相-动漫合集》这一漫剧条目。
  { id: 'huaguo', name: '花果', kind: 'both' },
  // 实测 12 条：穿越/修仙/剑仙，集数全为 0；无简介，按真人登记。
  { id: 'niuguo', name: '牛果', kind: 'live' },
  // 实测 403（站点要求浏览器验证）。
  { id: 'wangguo', name: '网果', kind: 'live' },
  // 实测 444。
  { id: 'faguo', name: '发果', kind: 'live' },
  // 实测 492，且两次探测结果不一致（一次 10 条、一次报错），链路不稳。
  { id: 'piguo', name: '皮果', kind: 'live' },
  // 实测 30 条：古代宅斗/宫斗真人短剧，集数恒为 1。
  { id: 'wuguo', name: '伍果', kind: 'live' },
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
  return GUO_SOURCES.filter(item => item.adult && chosen.has(item.id));
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
    .filter(item => chosen.has(item.id))
    .filter(item => showAdult || !item.adult)
    .map(item => item.id);
}

/** 按 tab 过滤后的启用源（`both` 计入两个 tab）。 */
export function enabledSourcesForTab(enabled: string[], showAdult: boolean, tab: 'drama' | 'comic'): GuoSource[] {
  const ids = new Set(enabledSourceIds(enabled, showAdult));
  return GUO_SOURCES.filter(item => ids.has(item.id) && sourceMatchesTab(item, tab));
}
