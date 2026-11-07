/**
 * 频道。
 *
 * - `drama` 真人短剧专区、`comic` 漫剧次元、`anime` 动漫专区（dmghg/暴风，
 *   独立数据源，走 `anime_provider`）。
 * - `adult` 神秘小窝：只装 18+ 源，且**必须先在设置页打开 18+ 总开关**才存在。
 *   它不是新链路——18+ 源全是 guo 源，而 guo-core 的 `catalog` 本来就不读
 *   channel（见 `guo_provider.rs`），所以这里只是前端换一个聚合名单。
 */
export type ChannelType = 'drama' | 'comic' | 'anime' | 'adult';

/**
 * 首页货架的两个分区：正在热播 / 新剧。
 *
 * 定义在这里而不是 store 里，是因为 service 层（`ipcService.shelf`）也要用它 ——
 * 让 service 反向依赖 store 会把分层搞乱。`useAppStore` 只做转出。
 */
export type ShelfKind = 'hot' | 'new';

/**
 * 「更多」页的一页分区列表。
 *
 * 与 `CatalogPage` 的关键差别是**分页模型**：这条链路是游标式的
 * （`nextCursor` 原样回传，不解析内容），不是页码式的。红果榜单要
 * `session_uuid + next_offset`、最新上架要 `offset`，两者都由后端编码进同一个
 * 不透明游标。
 */
export interface ShelfFeedPage {
  items: SeriesItem[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface SeriesItem {
  id: string;
  title: string;
  cover: string;
  backdrop?: string;
  type: ChannelType;
  episodesCount: number;
  latestEpisodeTitle?: string;
  tags: string[];
  origin: string; // 来源，如：'官网直链' | '短剧精选' | 'App直连'
  /**
   * 评分。必须来自源流实测，缺失就是缺失——不要用默认值或占位分数凑。
   * 角标渲染会把 0 当成"无评分"隐藏，这正是我们要的语义。
   */
  rating?: number;
  heat?: number;
  updateTime?: string;
  brief?: string;
  /**
   * 该系列的季数（2026-10-29，搜索页折叠用）。
   *
   * ⚠️ **这是"季数"，不是"集数"** —— `episodesCount` 才是集数，两者在卡上是两个
   * 独立角标（「115 集全」与「共 35 季」），别混。
   *
   * 只有"季号连续无缺口"时才由 `collapseSeriesGroups` 给出（见那边的
   * `CollapsedSeries.seasonCount`）；缺失 = 不确定，卡上什么都不显示，绝不拿
   * `memberCount` 或最大值硬凑一个数。
   */
  seasonCount?: number;
  /**
   * 搜索页把几条条目折叠成了这张卡（2026-10-29）。
   *
   * `> 1` 表示这张卡代表**一个系列**（同系列的各季已合并进来，点开先弹选季窗口）。
   * 只有搜索页会填：它直接来自 `collapseSeriesGroups` 的 `memberCount`；发现页 /
   * 动漫专区 / 收藏页不折叠，该字段为 undefined。
   *
   * 与 `seasonCount` 的区别：`memberCount` 数的是**条目**（含"同 base 同 season 的
   * 另一部"），`seasonCount` 数的是**季号**（且只在连续时才给）。两个数可能不等，
   * 别互相顶替 —— 判断"要不要弹选季"看这个字段，显示"共 N 季"看 `seasonCount`。
   */
  seriesFoldedCount?: number;
}

export interface CatalogFilter {
  channel: ChannelType;
  source?: string;
  category: string; // '全部' | '都市' | '战神' | '甜宠' | '逆袭' | '玄幻'
  audience: string; // '全部' | '男频' | '女频'
  sort: 'recommend' | 'latest' | 'heat';
  keyword?: string;
  page: number;
  pageSize: number;
  /** Opaque cursor returned by this project's catalog command. */
  cursor?: string;
}

/**
 * 后端 `catalog_series_seasons` 返回的一条季条目（2026-10-29）。
 *
 * ## 为什么需要它
 *
 * 在此之前，前端只能拿「剧名 + 猜出来的季号」当关键词反复打网页搜索与 App 联想
 * （见 `services/relatedSeries.ts` 的回退链路）。搜索是按相关度截断的，35 季的长
 * 系列怎么补都会缺段；用户把剧名打错一个字（镜/烬）更是连 base 都比不上，直接空窗口。
 * 后端按 series id 直接给出**该系列全部季（含当前季、含未上架季）**，季号是结构化的，
 * 不再需要从标题里猜。
 *
 * ## 字段语义（后端契约，前端不要自行改写）
 *
 * - `seasonIndex`：结构化季号；**0 表示服务端没给**，不是"第 0 季"。
 * - `episodeCount`：0 表示这一季还没上架/无内容（不是"集数未知"）。
 * - `disablePlay`：true 表示站方明确不可播放。
 *
 * 定义放在 types 里、由 `ipc.ts` 与 `relatedSeries.ts` 共用：两处各写一份，
 * 字段名或语义一旦漂移，就会出现"后端置灰的季前端照样可点"这种错位。
 */
export interface SeasonApiEntry {
  /** 该季的 series id。 */
  seriesId: string;
  /** 该季标题（如「烬九州第三十五季」）。 */
  title: string;
  cover: string;
  /** 结构化季号，0 表示服务端没给。 */
  seasonIndex: number;
  /** 该季集数；0 表示尚未上架/无内容。 */
  episodeCount: number;
  /** true 表示不可播放。 */
  disablePlay: boolean;
}

export interface CatalogPage {
  items: SeriesItem[];
  total: number;
  hasMore: boolean;
  page: number;
  categories: string[];
  nextCursor?: string;
  source?: string;
  /**
   * 本次结果是否降级：有一路来源真的挂了（红果官网 / 动漫源 / App 联想）。
   *
   * `source` 继续给用户看"哪个来源不可用"，但它是一段人类可读中文，前端判断
   * 降级只能去匹配词语——用户搜的词本身含"失败""超时"就会把正常来源行染成
   * 警告色。这个布尔就是给机器读的那一半。
   *
   * 可选：Web 演示模式的 mock（`ipc.ts` 的 `mockCatalogList`）不产生降级。
   */
  degraded?: boolean;
}
