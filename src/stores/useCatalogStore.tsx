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

/**
 * 合并题材词表：`全部` 恒在首位，保序去重（新增词追加在后面）。
 *
 * 题材栏必须"只增不减"——后端一次只给一页的题材，直接覆盖会让栏位随筛选/翻页
 * 忽明忽暗。
 */
function mergeCategories(base: string[], extra: string[]): string[] {
  const merged = ['全部'];
  for (const name of [...base, ...extra]) {
    const value = name.trim();
    if (value && value !== '全部' && !merged.includes(value)) merged.push(value);
  }
  return merged;
}

const CatalogContext = createContext<CatalogContextType | null>(null);

export const CatalogProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [channel, setChannelState] = useState<ChannelType>('comic');
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

  // 每个频道一份"已知题材词表"，跨筛选/翻页保持稳定。
  // 旧实现每次缓存未命中都把 categories 重置成 ['全部']，响应回来才恢复——
  // 用户看到的就是"题材全部消失，过一会又出来"。
  const categoryVocabularyRef = useRef<Record<string, string[]>>({});
  // 每个频道只汇总一次全站词表，避免反复触发后端建索引。
  const refreshCategoriesRef = useRef<Record<string, boolean>>({});

  // 内存缓存字典，彻底消除频道与筛选切换时的闪烁
  const cacheRef = useRef<Record<string, {
    items: SeriesItem[];
    categories: string[];
    hasMore: boolean;
    nextCursor?: string;
  }>>({});
  // 预取的第 2 页缓存（键 = 主缓存键），loadMore 时优先挪用。
  const nextPageCacheRef = useRef<Record<string, {
    items: SeriesItem[];
    hasMore: boolean;
    nextCursor?: string;
  }>>({});
  // 预取去重：同一频道+筛选组合只预取一次。
  const prefetchPage2Ref = useRef<Record<string, boolean>>({});
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

  /**
   * 漫剧集数补齐。
   *
   * 漫剧列表来自公开榜单页 HTML，而该页 HTML 与内嵌 router data 都不含任何集数
   * 文案（实测整页 `episode_cnt` 出现 0 次），所以卡片本来只能显示"集数未知"。
   * 真实集数由 App 侧 album_detail 批量给出，一次可覆盖整页卡片。
   *
   * 刻意不 await：端到端（含 Python 启动）实测 0.6-1.9s，且 worker 是单实例、
   * 会和播放解析互斥，为这个数字挡住首屏不值得。卡片先出现，集数随后补上；
   * 失败就保持"集数未知"，不影响目录可用性。
   */
  const fillEpisodeCounts = useCallback(
    async (cacheKey: string, source: SeriesItem[], requestId: number) => {
      const pending = source.filter(item => item.episodesCount <= 0).map(item => item.id);
      if (pending.length === 0) return;
      const counts = await ipcService.catalog.episodeCounts(pending);
      // 期间用户可能已切频道/筛选，此时结果不再属于当前视图，直接丢弃。
      if (requestId !== requestIdRef.current) return;
      const patch = (list: SeriesItem[]) => list.map(item => {
        const total = counts[item.id];
        return total && total > 0 && total !== item.episodesCount
          ? { ...item, episodesCount: total }
          : item;
      });
      // 缓存也要一起打补丁，否则切走频道再回来会退回"集数未知"。
      const cached = cacheRef.current[cacheKey];
      if (cached) cached.items = patch(cached.items);
      setItems(previous => patch(previous));
    },
    [],
  );

  /**
   * 后台汇总"全站题材词表"。
   *
   * 目录分页一次只有 24 条：按页取词表既拿不到全站题材，词表本身也会随翻页/筛选
   * 漂移。后端汇总全站目录后给出稳定全集（首次约数秒），完成后题材栏补齐。
   *
   * 刻意不 await：它不该挡住首屏卡片。每个频道只发一次；失败保持原有题材栏。
   */
  const refreshCategoryVocabulary = useCallback(async (target: ChannelType, requestId: number) => {
    if (refreshCategoriesRef.current[target]) return;
    refreshCategoriesRef.current[target] = true;
    const full = await ipcService.catalog.categories(target);
    if (full.length === 0) return;
    const merged = mergeCategories(categoryVocabularyRef.current[target] ?? [], full);
    categoryVocabularyRef.current[target] = merged;
    // 期间可能已切频道：只在仍是当前视图时刷新界面，词表本身照常记下来。
    if (requestId === requestIdRef.current) setCategories(merged);
  }, []);

  const loadData = useCallback(async (kw?: string) => {
    const requestId = ++requestIdRef.current;
    const cacheKey = `${channel}_${category}_${audience}_${sort}_${kw || ''}`;
    const cached = cacheRef.current[cacheKey];

    const knownCategories = categoryVocabularyRef.current[channel] ?? [];
    if (cached) {
      seenIdsRef.current = new Set(cached.items.map(item => item.id));
      setItems(cached.items);
      setCategories(mergeCategories(knownCategories, cached.categories));
      setHasMore(cached.hasMore);
      setNextCursor(cached.nextCursor);
      setNextPage(2);
      setIsLoading(false);
    } else {
      setIsLoading(true);
      // 只有切频道才需要换词表；同一频道内切题材/受众/排序必须保留题材栏，
      // 否则每点一次题材，题材栏都会先空掉再长回来（旧实现就是这样）。
      setCategories(mergeCategories(knownCategories, []));
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
      // 每次重试都必须绕过 inflight 去重：上一轮请求失败/超时后，同键的旧
      // Promise 若还在途中（Rust 端 20s 超时），复用它会让三次重试实际只等
      // 同一个请求，用户看到的就是"骨架屏转了很久也不出卡片"。
      if (channel === 'comic' && res.items.length === 0 && requestId === requestIdRef.current) {
        delete inflightRef.current[cacheKey];
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await new Promise(resolve => window.setTimeout(resolve, 400));
          if (requestId !== requestIdRef.current) break;
          delete inflightRef.current[cacheKey];
          res = await requestCatalog(cacheKey, filter);
          if (res.items.length > 0) break;
        }
      }
      if (requestId !== requestIdRef.current) return;
      const mergedCategories = mergeCategories(
        categoryVocabularyRef.current[channel] ?? [],
        res.categories,
      );
      categoryVocabularyRef.current[channel] = mergedCategories;
      cacheRef.current[cacheKey] = {
        items: res.items,
        categories: mergedCategories,
        hasMore: res.hasMore,
        nextCursor: res.nextCursor,
      };
      seenIdsRef.current = new Set(res.items.map(item => item.id));
      setItems(res.items);
      setCategories(mergedCategories);
      setHasMore(res.hasMore);
      setNextCursor(res.nextCursor);
      setNextPage(2);
      // 漫剧卡片先出，集数随后补齐（原因见 fillEpisodeCounts）。
      if (channel === 'comic') {
        void fillEpisodeCounts(cacheKey, res.items, requestId);
      }
      // 首屏已渲染，后台再汇总全站题材词表（不 await，见 refreshCategoryVocabulary）。
      void refreshCategoryVocabulary(channel, requestId);
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

  // 预取当前频道第 2 页：首屏只有 1 页（24 条），滚动到底才发请求会让
  // 用户中速滚动就在加载位空等。开页后请求已在途，滚到两屏内直接命中。
  // 与 sentinel 观察器互不冲突：loadMore 对同一页有 inflight 去重。
  useEffect(() => {
    let cancelled = false;
    const cacheKey = `${channel}_${category}_${audience}_${sort}_`;
    const page2Key = `${cacheKey}|p2`;
    if (page2Key in prefetchPage2Ref.current) return;
    if (!cacheRef.current[cacheKey] || !cacheRef.current[cacheKey].hasMore) return;
    prefetchPage2Ref.current[page2Key] = true;
    const filter: CatalogFilter = {
      channel,
      category,
      audience,
      sort,
      keyword: undefined,
      page: 2,
      pageSize: 30,
      cursor: cacheRef.current[cacheKey].nextCursor,
    };
    void ipcService.catalog.list(filter).then(res => {
      if (cancelled) return;
      const key = `${channel}_${category}_${audience}_${sort}_`;
      // 滚动加载还没消费过这一页（cacheKey 仍是第 1 页）时，先缓存到
      // 专用槽；loadMore 走正常链路时若发现槽里有数据就直接挪用。
      if (cacheRef.current[key] && !nextPageCacheRef.current[key]) {
        nextPageCacheRef.current[key] = {
          items: res.items,
          hasMore: res.hasMore,
          nextCursor: res.nextCursor,
        };
      }
    }).catch(() => {
      // 预取失败静默：滚动加载照常走网络。
      delete prefetchPage2Ref.current[page2Key];
    });
    return () => { cancelled = true; };
  }, [channel, category, audience, sort, requestCatalog]);

  const setChannel = (newChannel: ChannelType) => {
    setChannelState(newChannel);
    setCategoryState('全部');
    // 切频道时换成新频道"已知"的词表；未知就先只留"全部"，等目录响应或后台
    // 汇总补齐。刻意不无条件清空——那正是"题材消失又出现"的来源之一。
    setCategories(mergeCategories(categoryVocabularyRef.current[newChannel] ?? [], []));
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
      // 预取的第 2 页已就位就直接挪用：网络往返已经完成，这里只剩合并，
      // 用户滚到加载位时卡片立即出现。
      const slotKey = `${channel}_${category}_${audience}_${sort}_`;
      const prefetched = kw ? undefined : nextPageCacheRef.current[slotKey];
      if (prefetched) {
        delete nextPageCacheRef.current[slotKey];
        const fresh: SeriesItem[] = [];
        for (const item of prefetched.items) {
          if (seenIdsRef.current.has(item.id)) continue;
          seenIdsRef.current.add(item.id);
          fresh.push(item);
        }
        if (fresh.length === 0) {
          setHasMore(false);
          return;
        }
        setItems(prev => [...prev, ...fresh]);
        if (channel === 'comic') {
          void fillEpisodeCounts(slotKey, fresh, requestId);
        }
        setNextPage(nextPage + 1);
        setNextCursor(prefetched.nextCursor);
        setHasMore(prefetched.hasMore);
        return;
      }
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
        if (channel === 'comic') {
          void fillEpisodeCounts(slotKey, fresh, requestId);
        }
      }
      const mergedCategories = mergeCategories(
        categoryVocabularyRef.current[channel] ?? [],
        res.categories,
      );
      categoryVocabularyRef.current[channel] = mergedCategories;
      setCategories(mergedCategories);
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
