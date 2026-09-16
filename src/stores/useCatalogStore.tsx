import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { ChannelType, SeriesItem, CatalogFilter } from '../types/catalog';
import { ipcService } from '../services/ipc';
import { WatchHistoryItem } from '../types/history';

interface CatalogContextType {
  channel: ChannelType;
  category: string;
  audience: string;
  sort: 'recommend' | 'latest' | 'heat';
  categories: string[];
  items: SeriesItem[];
  continueWatching: WatchHistoryItem | null;
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  setChannel: (channel: ChannelType) => void;
  setCategory: (cat: string) => void;
  setAudience: (aud: string) => void;
  setSort: (s: 'recommend' | 'latest' | 'heat') => void;
  refreshCatalog: (keyword?: string) => Promise<void>;
  loadMore: (keyword?: string) => Promise<void>;
  /**
   * 重新读取"继续观看"。
   *
   * 目录数据不会因为看了几集而变化，所以 `loadData` 不会重跑；但继续观看横幅
   * 依赖历史记录——不单独刷新，用户看完一集回到发现页，横幅还停在启动那一刻的
   * 结果，观感就是"历史没有同步"。
   */
  refreshContinueWatching: () => Promise<void>;
}

const CatalogContext = createContext<CatalogContextType | null>(null);

export const CatalogProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [channel, setChannelState] = useState<ChannelType>('drama');
  const [category, setCategoryState] = useState<string>('全部');
  const [audience, setAudienceState] = useState<string>('全部');
  const [sort, setSortState] = useState<'recommend' | 'latest' | 'heat'>('recommend');
  const [categories, setCategories] = useState<string[]>(['全部']);
  const [items, setItems] = useState<SeriesItem[]>([]);
  const [continueWatching, setContinueWatching] = useState<WatchHistoryItem | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [nextPage, setNextPage] = useState<number>(2);
  const [error, setError] = useState<string | null>(null);

  // 内存缓存字典，彻底消除频道与筛选切换时的闪烁
  const cacheRef = useRef<Record<string, {
    items: SeriesItem[];
    categories: string[];
    hasMore: boolean;
    nextCursor?: string;
  }>>({});
  const inflightRef = useRef<Record<string, ReturnType<typeof ipcService.catalog.list>>>({});
  const requestIdRef = useRef(0);
  // 已出现过的剧集 id。用于判定"本次翻页是否真的带来了新内容"：
  // 站点若对越界页码返回同一页，继续请求只会空转，必须及时收尾。
  const seenIdsRef = useRef<Set<string>>(new Set());

  const requestCatalog = useCallback((cacheKey: string, filter: CatalogFilter) => {
    const existing = inflightRef.current[cacheKey];
    if (existing) return existing;
    const request = ipcService.catalog.list(filter);
    inflightRef.current[cacheKey] = request;
    void request.then(() => {
      if (inflightRef.current[cacheKey] === request) delete inflightRef.current[cacheKey];
    }, () => {
      if (inflightRef.current[cacheKey] === request) delete inflightRef.current[cacheKey];
    });
    return request;
  }, []);

  const loadData = useCallback(async (kw?: string) => {
    const requestId = ++requestIdRef.current;
    const cacheKey = `${channel}_${category}_${audience}_${sort}_${kw || ''}`;
    const cached = cacheRef.current[cacheKey];

    if (cached) {
      seenIdsRef.current = new Set(cached.items.map(item => item.id));
      setItems(cached.items);
      setCategories(cached.categories);
      setHasMore(cached.hasMore);
      setNextCursor(cached.nextCursor);
      setNextPage(2);
      setIsLoading(false);
    } else {
      setIsLoading(true);
      // 切换频道或关键词时，不展示上一频道遗留的分类标签。
      setCategories(['全部']);
    }

    setError(null);
    const filter: CatalogFilter = {
      channel,
      category,
      audience,
      sort,
      keyword: kw,
      page: 1,
      pageSize: 30,
    };
    // 历史记录是辅助信息，不能阻塞目录首屏。
    const historiesPromise = ipcService.history.list().catch(() => [] as WatchHistoryItem[]);

    try {
      let res = await requestCatalog(cacheKey, filter);
      // The public comic page occasionally returns its shell before the rank
      // articles are present. Retry up to twice instead of caching a false
      // empty page——一次重试实测仍可能拿到空壳，两次覆盖 90%+ 的抖动。
      if (channel === 'comic' && res.items.length === 0 && requestId === requestIdRef.current) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await new Promise(resolve => window.setTimeout(resolve, 400));
          if (requestId !== requestIdRef.current) break;
          res = await requestCatalog(cacheKey, filter);
          if (res.items.length > 0) break;
        }
      }
      if (requestId !== requestIdRef.current) return;
      cacheRef.current[cacheKey] = {
        items: res.items,
        categories: res.categories,
        hasMore: res.hasMore,
        nextCursor: res.nextCursor,
      };
      seenIdsRef.current = new Set(res.items.map(item => item.id));
      setItems(res.items);
      setCategories(res.categories);
      setHasMore(res.hasMore);
      setNextCursor(res.nextCursor);
      setNextPage(2);
    } catch (err) {
      setError((err as Error).message || '目录数据加载失败');
    } finally {
      if (requestId === requestIdRef.current) setIsLoading(false);
    }

    const histories = await historiesPromise;
    if (requestId !== requestIdRef.current) return;
    setContinueWatching(histories[0] || null);
  }, [channel, category, audience, sort, requestCatalog]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Warm the alternate channel while the first channel is visible. The
  // request is deliberately fire-and-forget so it never delays the current
  // page; switching to 漫剧 then paints from memory on the first click.
  useEffect(() => {
    let cancelled = false;
    const cacheKey = 'comic_全部_全部_recommend_';
    if (cacheRef.current[cacheKey]) return;

    void requestCatalog(cacheKey, {
      channel: 'comic',
      category: '全部',
      audience: '全部',
      sort: 'recommend',
      page: 1,
      pageSize: 30,
    }).then((res) => {
      if (cancelled || cacheRef.current[cacheKey] || res.items.length === 0) return;
      cacheRef.current[cacheKey] = {
        items: res.items,
        categories: res.categories,
        hasMore: res.hasMore,
        nextCursor: res.nextCursor,
      };
    }).catch(() => {
      // A warm-up miss is harmless; the normal channel request retries on click.
    });

    return () => {
      cancelled = true;
    };
  }, [requestCatalog]);

  const setChannel = (newChannel: ChannelType) => {
    setChannelState(newChannel);
    setCategoryState('全部');
    setCategories(['全部']);
  };

  const refreshContinueWatching = useCallback(async () => {
    try {
      const histories = await ipcService.history.list();
      setContinueWatching(histories[0] || null);
    } catch {
      // 辅助信息：拉取失败保持原值，不打扰用户。
    }
  }, []);

  const loadMore = useCallback(async (kw?: string) => {
    if (!hasMore || isLoadingMore) return;
    setIsLoadingMore(true);
    setError(null);
    const requestId = requestIdRef.current;
    try {
      const res = await ipcService.catalog.list({
        channel,
        category,
        audience,
        sort,
        keyword: kw,
        page: nextPage,
        pageSize: 30,
        cursor: nextCursor,
      });
      if (requestId !== requestIdRef.current) return;
      // 先剔除重复再落库：本次没有任何新卡片时直接终止无限滚动。
      // 后端已把"空页"判为到底，这里是第二道防线（页码估算偏大、
      // 站点对越界页码回退到同一页等情况都会在这里收口）。
      // 逐个登记而不是先 filter 再 forEach：站点同一页内偶尔会出现重复卡片，
      // 那样写法会让页内重复项一起通过过滤。
      const fresh: SeriesItem[] = [];
      for (const item of res.items) {
        if (seenIdsRef.current.has(item.id)) continue;
        seenIdsRef.current.add(item.id);
        fresh.push(item);
      }
      if (fresh.length > 0) {
        setItems(previous => [...previous, ...fresh]);
      }
      setCategories(previous => [...new Set([...previous, ...res.categories])]);
      setHasMore(res.hasMore && fresh.length > 0);
      setNextCursor(res.nextCursor);
      setNextPage(page => page + 1);
    } catch (err) {
      if (requestId === requestIdRef.current) setError((err as Error).message || '加载更多目录数据失败');
    } finally {
      if (requestId === requestIdRef.current) setIsLoadingMore(false);
    }
  }, [audience, category, channel, hasMore, isLoadingMore, nextCursor, nextPage, sort]);

  return (
    <CatalogContext.Provider
      value={{
        channel,
        category,
        audience,
        sort,
        categories,
        items,
        continueWatching,
        isLoading,
        isLoadingMore,
        hasMore,
        error,
        setChannel,
        setCategory: setCategoryState,
        setAudience: setAudienceState,
        setSort: setSortState,
        refreshCatalog: loadData,
        loadMore,
        refreshContinueWatching,
      }}
    >
      {children}
    </CatalogContext.Provider>
  );
};

export function useCatalogStore() {
  const ctx = useContext(CatalogContext);
  if (!ctx) throw new Error('useCatalogStore must be used within CatalogProvider');
  return ctx;
}
