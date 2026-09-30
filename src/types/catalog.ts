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
