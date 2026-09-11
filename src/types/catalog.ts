export type ChannelType = 'drama' | 'comic';

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
  rating?: number;
  heat?: number;
  updateTime?: string;
  brief?: string;
}

export interface CatalogFilter {
  channel: ChannelType;
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
}
