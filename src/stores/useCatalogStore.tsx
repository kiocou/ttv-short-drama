import React, { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo, ReactNode } from 'react';
import { ChannelType, SeriesItem, CatalogFilter } from '../types/catalog';
import { ipcService } from '../services/ipc';
import { WatchHistoryItem } from '../types/history';
import { enabledSourcesForTab, adultTabSources } from '../services/guoSources';
import { useSettingsStore } from './useSettingsStore';

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
  /** 本次目录实际聚合了哪些源（用于页面角标如实展示覆盖范围）。 */
  activeSources: string[];
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

/**
 * 题材词表 / 门闩 / 预取槽的键：按"源 + 频道"隔离。
 *
 * 旧实现只按频道隔离，切到 guo 源时词表仍是红果的（"爱情、古风"那套），
 * 题材栏展示的是别的源的分类；而且 refreshCategoriesRef 按频道设了"只刷一次"，
 * 切源后永远不会重新拉取新源的分类表。预取槽同样必须带 source，否则不同源的
 * 同一筛选组合会互相顶掉缓存。
 */
const vocabularyKey = (sources: string, channel: ChannelType) => `${sources}_${channel}`;

/** 单源的目录请求体。`hongguo` 走红果自有接口，不带 source。 */
function filterForSource(source: string, base: Omit<CatalogFilter, 'source'>): CatalogFilter {
  return { ...base, source: source === 'hongguo' ? undefined : source };
}

const CatalogContext = createContext<CatalogContextType | null>(null);

export const CatalogProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { settings } = useSettingsStore();
  const [channel, setChannelState] = useState<ChannelType>('comic');

  /**
   * 本次目录要聚合的源：按当前 tab（短剧/漫剧）从用户的启用集合里筛出来。
   *
   * 依赖 settings 而不是自己存一份：用户在设置页改勾选后，发现页必须立刻反映，
   * 不能等重启。18+ 总开关也在这一层生效——它关掉时那些源不进 `sources`，
   * 目录与搜索都看不到它们。
   *
   * 兜底：启用集合为空（设置被外部写坏、或用户把最后一个源也取消勾选）时
   * 回落红果，否则首页会是一个没有任何请求的空目录，用户看不出发生了什么。
   */
  const sources = useMemo(() => {
    // 神秘小窝只聚合 18+ 源，且总开关关闭时名单为空——那时 tab 压根不渲染，
    // 万一状态还停在 adult（比如刚关开关），也不能回落到红果：那会让普通短剧
    // 出现在 18+ 专区里，是最糟的一种错位。
    if (channel === 'adult') {
      return adultTabSources(settings.enabledSources, settings.showAdultSources).map(item => item.id);
    }
    const picked = enabledSourcesForTab(
      settings.enabledSources,
      settings.showAdultSources,
      channel === 'comic' ? 'comic' : 'drama',
    ).map(item => item.id);
    return picked.length > 0 ? picked : ['hongguo'];
  }, [settings.enabledSources, settings.showAdultSources, channel]);
  const [category, setCategoryState] = useState<string>('全部');
  const [audience, setAudienceState] = useState<string>('全部');
  const [sort, setSortState] = useState<'recommend' | 'latest' | 'heat'>('recommend');
  const [categories, setCategories] = useState<string[]>(['全部']);
  const [items, setItems] = useState<SeriesItem[]>([]);
  const [continueWatching, setContinueWatching] = useState<WatchHistoryItem | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSources, setActiveSources] = useState<string[]>([]);
  /**
   * 每个源的当前页码（`page: 0` 表示该源已到底，不再请求）。
   *
   * 聚合模式下"下一页"不再是单一状态：每个源有自己的页数，滚动加载要逐源推进。
   * 原来那对 `nextCursor` / `nextPage` state 在多源下会互相覆盖。
   *
   * 只留页码、不留游标：后端的游标就是页码的字符串形态——`provider.rs` 出口写
   * `next_cursor = (page + 1).to_string()`，入口 `parse_page` 又把它读回数字，
   * 且 `filter.cursor` 会**压过** `filter.page`。两条路表达同一个数，而 guo 源恒
   * 返回 `next_cursor: None`，同时留着就是留一条永远为 undefined 的分支。
   */
  const pagingRef = useRef<Record<string, { page: number }>>({});

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

  /**
   * 并发拉取多个源的目录并合并。
   *
   * 单源失败不能拖垮整页：一个源 403 / 超时是常态（实测网果 403、发果 444、
   * 皮果 492），如果 fail-fast，用户看到的会是"整个 tab 空了"而不是"少一个源"。
   * 因此逐源 `allSettled`，只把成功的结果并进来；全部失败才报错。
   *
   * 合并时按 id 去重：不同源可能推同一���（同一部剧被多个站转载），卡片上会
   * 标出来源，但网格里不该出现两张一模一样的卡。
   */
  const requestAllSources = useCallback(async (
    sources: string[],
    base: Omit<CatalogFilter, 'source' | 'page' | 'cursor'>,
    pageFor: (source: string) => number,
  ) => {
    const settled = await Promise.allSettled(sources.map(source => {
      const page = pageFor(source);
      return requestCatalog(
        `${source}_${base.channel}_${base.category}_${base.audience}_${base.sort}_${base.keyword || ''}_p${page}`,
        { ...base, source: source === 'hongguo' ? undefined : source, page },
      );
    }));

    const seen = new Set<string>();
    const items: SeriesItem[] = [];
    const categories: string[] = [];
    let hasMore = false;
    const failures: string[] = [];
    // 逐源的"还有没有下一页"。聚合的 `hasMore` 是"或"，拿它判断**单个**源到没到
    // 底必然出错：一个只有 30 条的源会被反复请求，而它回来的东西在 id 去重后
    // 永远是 0 条。收尾时必须逐源看这张表，见 loadMore。
    const hasMoreBySource: Record<string, boolean> = {};

    settled.forEach((outcome, index) => {
      const source = sources[index];
      if (outcome.status === 'rejected') {
        failures.push(source);
        // 本轮失败的源**不算**到底：不置 0，下一轮 loadMore 还会再试它一次。
        hasMoreBySource[source] = true;
        return;
      }
      const page = outcome.value;
      for (const item of page.items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
      }
      for (const name of page.categories) categories.push(name);
      hasMore = hasMore || page.hasMore;
      hasMoreBySource[source] = page.hasMore;
    });

    if (failures.length === sources.length) {
      throw new Error(`目录数据加载失败（${failures.length} 个源均无响应）`);
    }
    return { items, categories, hasMore, hasMoreBySource, failedSources: failures };
  }, [requestCatalog]);

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
  const refreshCategoryVocabulary = useCallback(async (
    sources: string[],
    target: ChannelType,
    requestId: number,
  ) => {
    const key = vocabularyKey(sources.join('+'), target);
    if (refreshCategoriesRef.current[key]) return;
    refreshCategoriesRef.current[key] = true;
    // 逐源汇总后并集：题材栏是所有启用源的并集，勾选某个题材等于在每个源上
    // 各筛一次（后端按自己的分类表把显示名映射回自己的 id）。
    const perSource = await Promise.all(sources.map(source => (
      ipcService.catalog.categories(target, source === 'hongguo' ? undefined : source).catch(() => [] as string[])
    )));
    const full = perSource.flat();
    // 汇总失败（全部源都返回空）必须把门闩撤掉，否则这个 source×channel 组合
    // 永远不再汇总：门闩是在 await **之前**置的（防并发重复汇总），失败路径不
    // 回收就等于把一次网络抖动变成永久失效。
    if (full.length === 0) {
      delete refreshCategoriesRef.current[key];
      return;
    }
    const merged = mergeCategories(categoryVocabularyRef.current[key] ?? [], full);
    categoryVocabularyRef.current[key] = merged;
    // 期间可能已切频道：只在仍是当前视图时刷新界面，词表本身照常记下来。
    if (requestId === requestIdRef.current) setCategories(merged);
  }, []);

  const loadData = useCallback(async (kw?: string) => {
    const requestId = ++requestIdRef.current;
    const sourceKey = sources.join('+');
    const cacheKey = `${sourceKey}_${channel}_${category}_${audience}_${sort}_${kw || ''}`;
    const cached = cacheRef.current[cacheKey];

    const knownCategories = categoryVocabularyRef.current[vocabularyKey(sourceKey, channel)] ?? [];
    if (cached) {
      seenIdsRef.current = new Set(cached.items.map(item => item.id));
      setItems(cached.items);
      setCategories(mergeCategories(knownCategories, cached.categories));
      setHasMore(cached.hasMore);
      pagingRef.current = {};
      setIsLoading(false);
    } else {
      setIsLoading(true);
      // 只有切频道才需要换词表；同一频道内切题材/受众/排序必须保留题材栏，
      // 否则每点一次题材，题材栏都会先空掉再长回来（旧实现就是这样）。
      setCategories(mergeCategories(knownCategories, []));
    }

    setError(null);
    const base: Omit<CatalogFilter, 'source' | 'page' | 'cursor'> = {
      channel,
      category,
      audience,
      sort,
      keyword: kw,
      pageSize: 30,
    };
    // 历史记录是辅助信息，不能阻塞目录首屏。
    const historiesPromise = ipcService.history.list().catch(() => [] as WatchHistoryItem[]);

    try {
      // 翻页页码复位：首屏装第 1 页，loadMore 的缺省页码 1 也对应这一点
      //（复位后的第一次 loadMore 请求的是第 2 页）。
      pagingRef.current = {};
      let res = await requestAllSources(sources, base, () => 1);
      // The public comic page occasionally returns its shell before the rank
      // articles are present. Retry up to twice instead of caching a false
      // empty page——一次重试实测仍可能拿到空壳，两次覆盖 90%+ 的抖动。
      // 每次重试都必须绕过 inflight 去重：上一轮请求失败/超时后，同键的旧
      // Promise 若还在途中（Rust 端 20s 超时），复用它会让三次重试实际只等
      // 同一个请求，用户看到的就是"骨架屏转了很久也不出卡片"。
      if (channel === 'comic' && res.items.length === 0 && requestId === requestIdRef.current) {
        for (const source of sources) delete inflightRef.current[`${source}_${channel}_${category}_${audience}_${sort}_${kw || ''}_p1`];
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await new Promise(resolve => window.setTimeout(resolve, 400));
          if (requestId !== requestIdRef.current) break;
          for (const source of sources) delete inflightRef.current[`${source}_${channel}_${category}_${audience}_${sort}_${kw || ''}_p1`];
          res = await requestAllSources(sources, base, () => 1);
          if (res.items.length > 0) break;
        }
      }
      if (requestId !== requestIdRef.current) return;
      const mergedCategories = mergeCategories(
        categoryVocabularyRef.current[vocabularyKey(sourceKey, channel)] ?? [],
        res.categories,
      );
      categoryVocabularyRef.current[vocabularyKey(sourceKey, channel)] = mergedCategories;
      cacheRef.current[cacheKey] = {
        items: res.items,
        categories: mergedCategories,
        hasMore: res.hasMore,
      };
      seenIdsRef.current = new Set(res.items.map(item => item.id));
      setItems(res.items);
      setCategories(mergedCategories);
      setHasMore(res.hasMore);
      setActiveSources(sources);
      // 漫剧卡片先出，集数随后补齐（原因见 fillEpisodeCounts）。
      if (channel === 'comic') {
        void fillEpisodeCounts(cacheKey, res.items, requestId);
      }
      // 首屏已渲染，后台再汇总全站题材词表（不 await，见 refreshCategoryVocabulary）。
      void refreshCategoryVocabulary(sources, channel, requestId);
    } catch (err) {
      setError((err as Error).message || '目录数据加载失败');
    } finally {
      if (requestId === requestIdRef.current) setIsLoading(false);
    }

    const histories = await historiesPromise;
    if (requestId !== requestIdRef.current) return;
    setContinueWatching(histories[0] || null);
  }, [audience, category, channel, refreshCategoryVocabulary, requestAllSources, sort, sources]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const setChannel = (newChannel: ChannelType) => {
    setChannelState(newChannel);
    setCategoryState('全部');
    // 切频道时换成新频道"已知"的词表；未知就先只留"全部"，等目录响应或后台
    // 汇总补齐。刻意不无条件清空——那正是"题材消失又出现"的来源之一。
    setCategories(mergeCategories(
      categoryVocabularyRef.current[vocabularyKey(sources.join('+'), newChannel)] ?? [],
      [],
    ));
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
    const sourceKey = sources.join('+');
    const slotKey = `${sourceKey}_${channel}_${category}_${audience}_${sort}_`;
    try {
      const base: Omit<CatalogFilter, 'source' | 'page' | 'cursor'> = {
        channel,
        category,
        audience,
        sort,
        keyword: kw,
        pageSize: 30,
      };
      // 逐源推进页码：聚合模式下"下一页"是每个源各自的下一页。
      // 某个源已经到底（页码记作 0）就整个跳过它——继续请求只会拿回同一页，
      // 在 seenIds 去重后永远是 0 条新卡片，还白花一次请求。
      // 缺省页码是 1：首屏 loadData 装的就是第 1 页，所以"下一页"是 2。
      const paging = pagingRef.current;
      const pending = sources.filter(source => paging[source]?.page !== 0);
      for (const source of pending) {
        paging[source] = { page: (paging[source]?.page ?? 1) + 1 };
      }

      const res = await requestAllSources(pending, base, source => paging[source].page);
      if (requestId !== requestIdRef.current) return;
      // 逐源收尾：本轮报"到底"的源置 0，后续 loadMore 直接跳过它。必须逐源看
      // hasMoreBySource——聚合的 res.hasMore 是各源的"或"，只按它判断的话，
      // 一个只有 30 条的源会被其余源拖着一直翻。
      for (const source of pending) {
        if (!res.hasMoreBySource[source]) paging[source] = { page: 0 };
      }

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
        categoryVocabularyRef.current[vocabularyKey(sourceKey, channel)] ?? [],
        res.categories,
      );
      categoryVocabularyRef.current[vocabularyKey(sourceKey, channel)] = mergedCategories;
      setCategories(mergedCategories);
      setHasMore(res.hasMore && fresh.length > 0);
    } catch (err) {
      if (requestId === requestIdRef.current) setError((err as Error).message || '加载更多目录数据失败');
    } finally {
      if (requestId === requestIdRef.current) setIsLoadingMore(false);
    }
  }, [audience, category, channel, hasMore, isLoadingMore, requestAllSources, sort, sources]);

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
        activeSources,
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
