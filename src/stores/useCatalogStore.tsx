import React, { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo, ReactNode } from 'react';
import { ChannelType, SeriesItem, CatalogFilter } from '../types/catalog';
import { ipcService, errorText } from '../services/ipc';
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
  /**
   * 重新拉取目录。
   *
   * `options.force = true` 表示这是**用户手动刷新**：整轮请求会穿透站源缓存
   * （见 `ipcService.catalog.list` 与 Rust 侧 `catalog_list` 的 `force` 形参）。
   * 不传 force 就是普通重载——guo 源仍走「缓存优先 + SWR」，用于切频道/切题材
   * 这类「不该为了新鲜度付出一次全网请求」的场景。
   */
  refreshCatalog: (keyword?: string, options?: { force?: boolean }) => Promise<boolean>;
  loadMore: (keyword?: string) => Promise<void>;
  /**
   * 预取下一页（不碰界面）。滚动到距底部一定距离时调用，把请求提前到滚动路径之外。
   */
  prefetchMore: (keyword?: string) => void;
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

/** 一页聚合结果（`requestAllSources` 的返回形状）。 */
interface FetchedPage {
  items: SeriesItem[];
  categories: string[];
  hasMore: boolean;
  /** 逐源的"还有没有下一页"。聚合的 hasMore 是各源的"或"，拿它判断单个源到没到底必然出错。 */
  hasMoreBySource: Record<string, boolean>;
  failedSources: string[];
}

const CatalogContext = createContext<CatalogContextType | null>(null);

/**
 * 目录 Provider 的预设项。
 *
 * 全部不传 = 发现页那一份（频道漫剧起手、排序综合推荐、题材全部），行为与加这组
 * props 之前完全一致。
 *
 * 「更多」页为什么要再挂一个实例：它必须固定排序（正在热播 / 新剧各一个），而
 * `sort` 是本 Provider 的内部 state —— 去改全局那一份会把发现页的排序一起改掉
 * （视图是常驻 DOM，发现页就挂在旁边）。所以在「更多」视图内部再挂一个 Provider，
 * 用 props 把频道与排序钉死，两边的分页 / 缓存 / 预取 / 题材词表互不干扰。
 *
 * 只在**首次挂载**生效（`useState` 初值）：换分区时由调用方加 `key` 强制重挂，
 * 而不是指望这里跟着 props 变。
 */
interface CatalogProviderProps {
  children: ReactNode;
  initialChannel?: ChannelType;
  initialSort?: 'recommend' | 'latest' | 'heat';
  initialCategory?: string;
}

export const CatalogProvider: React.FC<CatalogProviderProps> = ({
  children,
  initialChannel,
  initialSort,
  initialCategory,
}) => {
  const { settings } = useSettingsStore();
  const [channel, setChannelState] = useState<ChannelType>(initialChannel ?? 'comic');

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
  const [category, setCategoryState] = useState<string>(initialCategory ?? '全部');
  const [audience, setAudienceState] = useState<string>('全部');
  const [sort, setSortState] = useState<'recommend' | 'latest' | 'heat'>(initialSort ?? 'recommend');
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
  /**
   * loadMore 连续失败次数。
   *
   * 用来给自动重试上熔断：observer 在 isLoadingMore 复位后会重建，而哨兵此刻仍在视口
   * 内，会立刻再次触发 loadMore——只要后端还在失败，就会变成“底部一直转、每秒几次请求”
   * 的风暴（实测卡住就是这个形态：界面永远停在“正在加载更多内容…”）。连续两次失败后
   * 置 hasMore=false，把重试交回用户点“重试”按钮。
   */
const loadMoreFailuresRef = useRef(0);

  /**
   * 已发起但尚未落到界面的一页（真实无限流的核心）。
   *
   * 旧实现是"滚到底 → 发请求 → 等回来 → 插入"，请求延迟完全暴露在滚动路径上：
   * 观感就是"卡一会儿才出下一页"。现在把**发请求**与**提交到界面**拆成两件事——发
   * 完就搁在这里，用户滚到底时通常它已经在途甚至已完成，提交是同步的，于是滚动不再
   * 等待网络。
   *
   * 页码推进放在 `commitPage` 而不是发请求时：这样"重复发起同一页"天然被幂等吃掉
   * （pages 算出来一样，`requestCatalog` 的 inflight 去重直接复用同一个 Promise），
   * 而预取与正式提交撞车时也只会是同一个 in-flight，不会跳页。
   *
   * 预取**不登记** seenIds：登记是提交期的职责，否则预取来的卡片会在真正提交时
   * 被自己的去重表过滤掉。
   */
  const pendingFetchRef = useRef<{
    requestId: number;
    pages: Record<string, number>;
    promise: Promise<FetchedPage>;
    /** 已被 loadMore 认领（正在提交）。此刻不允许再另起一页预取。 */
    claimed: boolean;
  } | null>(null);

  const requestCatalog = useCallback((cacheKey: string, filter: CatalogFilter, force = false) => {
    // 强制刷新另起一个 in-flight 键：同键复用本来是「同一页只发一次」的幂等保障，
    // 但一次 force 请求若被同键的普通请求复用（或反之），这次刷新就又被缓存吃掉了。
    const key = force ? `${cacheKey}|force` : cacheKey;
    const existing = inflightRef.current[key];
    if (existing) return existing;
    const request = ipcService.catalog.list(filter, force);
    inflightRef.current[key] = request;
    void request.then(() => {
      if (inflightRef.current[key] === request) delete inflightRef.current[key];
    }, () => {
      if (inflightRef.current[key] === request) delete inflightRef.current[key];
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
    force = false,
  ) => {
    const settled = await Promise.allSettled(sources.map(source => {
      const page = pageFor(source);
      return requestCatalog(
        `${source}_${base.channel}_${base.category}_${base.audience}_${base.sort}_${base.keyword || ''}_p${page}`,
        { ...base, source: source === 'hongguo' ? undefined : source, page },
        force,
      );
    }));

    const seen = new Set<string>();
    const items: SeriesItem[] = [];
    const categories: string[] = [];
    let hasMore = false;
    const failures: string[] = [];
    /**
     * 每个失败源**各自的**错误原文。
     *
     * 只报"（N 个源均无响应）"是没法排查的：到底是连不上、HTTP 403、还是响应解析
     * 不出来，全都长一个样。更糟的是漫剧频道现在只剩红果一个源（其余启用的源都是
     * 18+，被 `showAdultSources: false` 滤掉了），"1 个源均无响应"背后必然是那个
     * 唯一源的某一句话——不把它带出来，界面上就只剩一个无法行动的结论。
     */
    const failureReasons: string[] = [];
    // 逐源的"还有没有下一页"。聚合的 `hasMore` 是"或"，拿它判断**单个**源到没到
    // 底必然出错：一个只有 30 条的源会被反复请求，而它回来的东西在 id 去重后
    // 永远是 0 条。收尾时必须逐源看这张表，见 loadMore。
    const hasMoreBySource: Record<string, boolean> = {};

    settled.forEach((outcome, index) => {
      const source = sources[index];
      if (outcome.status === 'rejected') {
        failures.push(source);
        failureReasons.push(`${source}: ${errorText(outcome.reason, '未知错误')}`);
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

    if (sources.length === 0) {
      // 没有待请求的源（全部记为到底）。不能落到下一行：`0 === 0` 会成立，
      // 把一次正常的到底抛成“0 个源均无响应”。
      return { items: [], categories: [], hasMore: false, hasMoreBySource: {}, failedSources: [] };
    }
    if (failures.length === sources.length) {
      throw new Error(
        `目录数据加载失败（${failures.length} 个源均无响应）—— ${failureReasons.join('；')}`,
      );
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

const loadData = useCallback(async (kw?: string, options?: { force?: boolean }) => {
    const requestId = ++requestIdRef.current;
    // 只有用户手动刷新（首页货架的刷新按钮）才会传 force：它让整轮请求穿透
    // 站源缓存。切频道/题材/排序这些路径不能 force——那会把每次筛选都变成
    // 一次全网请求，guo 源在死源冷却上前根本不划算。
    const force = options?.force === true;
    // 复位"加载更多"的忙态。新的一轮首屏请求会作废任何在途 loadMore（它靠
    // requestId 判定过期），而 loadMore 的 finally 也因为同一判定不会复位
    // isLoadingMore —— 不在这里清掉，它就会永久停在 true：底部一直挂着"正在加载
    // 更多内容…"，且 loadMore 的 `if (isLoadingMore) return` 与 ExploreView 的
    // IntersectionObserver 都从此再不触发。切题材/排序/频道、设置页改启用源、刷新
    // 都会走到这条路径。
    setIsLoadingMore(false);
    loadMoreFailuresRef.current = 0;
    // 丢弃上一轮的预取：它的页码是按上一轮的筛选/频道算的，本轮必须重算。
    // （不清的话，用户切题材后滚到底会拿到上一轮预取来的卡片。）
    pendingFetchRef.current = null;
    catalogKeywordRef.current = kw;
    loadMoreFailuresRef.current = 0;
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
      // 缓存只负责让旧内容立即可见，网络请求仍在后台校验。保留 loading 状态，
      // 让页面用细进度条和轻微压暗明确告知用户"这是旧内容，正在换新结果"，
      // 避免点击题材后看起来像没有反应。
      setIsLoading(true);
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

    // 本轮是否成功。返回值给手动刷新的调用方一个明确的成败信号——目录数据
    // 在源侧排序不变时「刷新成功」与「刷新失败」在界面上长得一模一样，
    // 调用方需要它来决定给不给用户一条反馈。
    let ok = true;
    try {
      // 翻页页码复位：首屏装第 1 页，loadMore 的缺省页码 1 也对应这一点
      //（复位后的第一次 loadMore 请求的是第 2 页）。
      pagingRef.current = {};
      // 重试前必须连 force 变体一起清：`requestCatalog` 给 force 请求另起了一个
      // in-flight 键（见那里），只清普通键的话重试会复用同一个在途 Promise，
      // 三次重试实际只等同一个请求。
      const dropPage1Inflight = () => {
        for (const source of sources) {
          const key = `${source}_${channel}_${category}_${audience}_${sort}_${kw || ''}_p1`;
          delete inflightRef.current[key];
          delete inflightRef.current[`${key}|force`];
        }
      };
      let res = await requestAllSources(sources, base, () => 1, force);
      // The public comic page occasionally returns its shell before the rank
      // articles are present. Retry up to twice instead of caching a false
      // empty page——一次重试实测仍可能拿到空壳，两次覆盖 90%+ 的抖动。
      // 每次重试都必须绕过 inflight 去重：上一轮请求失败/超时后，同键的旧
      // Promise 若还在途中（Rust 端 20s 超时），复用它会让三次重试实际只等
      // 同一个请求，用户看到的就是"骨架屏转了很久也不出卡片"。
      if (channel === 'comic' && res.items.length === 0 && requestId === requestIdRef.current) {
        dropPage1Inflight();
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await new Promise(resolve => window.setTimeout(resolve, 400));
          if (requestId !== requestIdRef.current) break;
          dropPage1Inflight();
          res = await requestAllSources(sources, base, () => 1, force);
          if (res.items.length > 0) break;
        }
      }
      if (requestId !== requestIdRef.current) return ok;
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
      ok = false;
      setError(errorText(err, '目录数据加载失败'));
    } finally {
      if (requestId === requestIdRef.current) setIsLoading(false);
    }

    const histories = await historiesPromise;
    if (requestId !== requestIdRef.current) return ok;
    setContinueWatching(histories[0] || null);
    return ok;
  }, [audience, category, channel, refreshCategoryVocabulary, requestAllSources, sort, sources]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  /**
   * `useCallback` 是必需的：它要进下方 context value 的依赖数组，不稳定就会让那份
   * `useMemo` 每次都失效，memo 也就白做了。
   */
  const setChannel = useCallback((newChannel: ChannelType) => {
    setChannelState(newChannel);
    setCategoryState('全部');
    // 切频道时换成新频道"已知"的词表；未知就先只留"全部"，等目录响应或后台
    // 汇总补齐。刻意不无条件清空——那正是"题材消失又出现"的来源之一。
    setCategories(mergeCategories(
      categoryVocabularyRef.current[vocabularyKey(sources.join('+'), newChannel)] ?? [],
      [],
    ));
  }, [sources]);

  const refreshContinueWatching = useCallback(async () => {
    try {
      const histories = await ipcService.history.list();
      setContinueWatching(histories[0] || null);
    } catch {
      // 辅助信息：拉取失败保持原值，不打扰用户。
    }
  }, []);

  /**
   * 发起下一页请求（不碰界面）。
   *
   * 页码**不**在这里推进，而是把算出来的 `pages` 连同 Promise 一起存进
   * `pendingFetchRef`：这样"同一页被发起两次"（预取撞上正式提交、或者失败后重试）
   * 算出的 `pages` 完全相同，`requestCatalog` 的 inflight 去重会直接复用同一个
   * Promise —— 幂等，且不会跳页。真正的页码推进在 `commitPage`。
   *
   * 返回 null 表示所有源都已到底，没有可发的请求。
   */
  const beginFetch = useCallback((kw?: string) => {
    // 已有在途的一页：直接复用，不重复发。
    const existing = pendingFetchRef.current;
    if (existing && existing.requestId === requestIdRef.current) {
      // 已被认领去提交的那一页：此刻正在等它落地，不允许再起一页预取。因为页码要到
      // `commitPage` 才推进，此时算出来的会是**完全相同**的页码 —— 白白重复请求一次
      // 同页，还会给 pendingFetchRef 留下一条已过期的记录，下一次 beginFetch 拿它去
      // 提交会因 id 去重拿到 0 条新卡片，从而误判到底、把无限流提前掐断。
      return existing.claimed ? null : existing;
    }

    const paging = pagingRef.current;
    // 逐源推进页码：聚合模式下"下一页"是每个源各自的下一页。
    // 某个源已经到底（页码记作 0）就整个跳过它——继续请求只会拿回同一页，
    // 在 seenIds 去重后永远是 0 条新卡片，还白花一次请求。
    // 缺省页码是 1：首屏 loadData 装的就是第 1 页，所以"下一页"是 2。
    const pending = sources.filter(source => paging[source]?.page !== 0);
    if (pending.length === 0) return null;

    const pages: Record<string, number> = {};
    for (const source of pending) pages[source] = (paging[source]?.page ?? 1) + 1;

    const base: Omit<CatalogFilter, 'source' | 'page' | 'cursor'> = {
      channel,
      category,
      audience,
      sort,
      keyword: kw,
      pageSize: 30,
    };
    const record = {
      requestId: requestIdRef.current,
      pages,
      promise: requestAllSources(pending, base, source => pages[source]),
      claimed: false,
    };
    pendingFetchRef.current = record;
    return record;
  }, [audience, category, channel, requestAllSources, sort, sources]);

  /**
   * 把一页落到界面：登记 id、推进页码、更新题材栏与 hasMore。
   *
   * 与 `beginFetch` 严格分开，就是为了让预取可以在任何空闲时刻发起，而提交只在
   * 用户真的滚到底时才发生。
   */
  const commitPage = useCallback((
    res: FetchedPage,
    pages: Record<string, number>,
    kw: string | undefined,
    requestId: number,
  ) => {
    const paging = pagingRef.current;
    const sourceKey = sources.join('+');
    const slotKey = `${sourceKey}_${channel}_${category}_${audience}_${sort}_`;

    // 逐源收尾：本轮报"到底"的源置 0，后续直接跳过它；其余源把页码记成本轮页数。
    // 必须逐源看 hasMoreBySource——聚合的 res.hasMore 是各源的"或"，只按它判断的
    // 话，一个只有 30 条的源会被其余源拖着一直翻。
    for (const source of Object.keys(pages)) {
      paging[source] = { page: res.hasMoreBySource[source] ? pages[source] : 0 };
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
    // 翻页成功：清零失败计数，否则一次抖动就会把熔断阈值推满。
    loadMoreFailuresRef.current = 0;
  }, [category, audience, channel, sort, sources]);

  /**
   * 后台预取：空闲时就发下一页，不设任何界面状态。
   *
   * 这是"真正的无限流"与"滚到底才加载"的唯一差别——请求不再位于滚动路径上。
   * 失败静默：预取失败只是下次滚动时退化成同步加载，不该打扰用户。
   */
  const prefetchMore = useCallback((kw?: string) => {
    const record = beginFetch(kw);
    if (!record) return;
    void record.promise.catch(() => {
      // 预取失败要把槽位释放掉，否则一次抖动会让 `beginFetch` 永远返回这个
      // 已失败的 in-flight，用户滚到底时拿到的是同一个被 reject 的 Promise。
      if (pendingFetchRef.current === record) pendingFetchRef.current = null;
    });
  }, [beginFetch]);

  const loadMore = useCallback(async (kw?: string) => {
    if (!hasMore || isLoadingMore) return;
    setIsLoadingMore(true);
    setError(null);
    const requestId = requestIdRef.current;
    // 提到 try 外：catch 里也要靠它释放槽位。
    let claimed: NonNullable<typeof pendingFetchRef.current> | null = null;
    try {
      const record = beginFetch(kw);
      claimed = record;
      if (!record) {
        // beginFetch 返回 null 有两种含义，不能一律宣告到底：
        // ① 所有源都记为到底 —— 槽位是空的，该停；
        // ② 有一页已被认领去提交（isLoadingMore 是 state，React 重渲染前可能有第二个
        //    loadMore 挤进来）—— 槽位非空，停在这里等下一次哨兵触发即可。
        // 把 ② 误判成 ① 就是"看几屏之后无限流突然没了"。
        if (!pendingFetchRef.current) setHasMore(false);
        return;
      }
      record.claimed = true;
      const res = await record.promise;
      if (requestId !== requestIdRef.current) return;
      commitPage(res, record.pages, kw, requestId);
      // 释放槽位，让空闲预取可以接着排下一页（页码已由 commitPage 推进）。
      if (pendingFetchRef.current === record) pendingFetchRef.current = null;
    } catch (err) {
      if (requestId === requestIdRef.current) {
        setError(errorText(err, '加载更多目录数据失败'));
        // 连续失败就停掉自动重试。observer 在 isLoadingMore 复位后会重建，而哨兵
        // 仍在视口内 → 立刻又触发一次 loadMore，失败请求会变成一秒几次的无限风暴
        // （实测表现为底部一直转、且各路请求都在超时）。两次失败是网络/站方问题的
        // 强信号，此时交给用户点"重试"而不是继续自动烧请求。
        loadMoreFailuresRef.current += 1;
        if (loadMoreFailuresRef.current >= 2) setHasMore(false);
      }
      // 失败同样要释放槽位，否则下一次 beginFetch 会拿回这条已 reject 的 in-flight，
      // 无限流从此再也推进不了。
      if (pendingFetchRef.current === claimed) pendingFetchRef.current = null;
    } finally {
      // 无条件复位：不带 requestId 判定。带上的话，过期的这一轮不会复位；而新一轮
      // (loadData) 虽然会复位，若它自己又过期就没人复位了——isLoadingMore 卡在 true
      // 等于无限滚动永久停摆（loadMore 首行 `if (isLoadingMore) return` 与 observer
      // 的 `|| isLoadingMore` 都会直接短路）。loadMore 本身有 isLoadingMore 单飞，
      // 不会出现两个在途请求互相踩。
      setIsLoadingMore(false);
    }
  }, [beginFetch, channel, commitPage, hasMore, isLoadingMore]);

  /**
   * 当前这一轮的关键词（首屏可能被顶部搜索带进来），预取要沿用它。
   */
  const catalogKeywordRef = useRef<string | undefined>(undefined);

  /**
   * 空闲即预取：每一页落地后就排下一页，让请求不落在滚动路径上。
   *
   * 触发点用 `requestIdleCallback`（Chromium/WebView2 有）而不是 setTimeout：预取是
   * 纯网络等待，不占主线程，但**发起**它会同步走一遍渲染源筛选与 IPC 组装；排在空闲
   * 回调里不会和用户点击、切题材这些真正要紧的交互抢帧。
   *
   * 只预取一页（不滚到底就白拉两页），这是"用户还没表达需求"与"别浪费站方带宽"之间
   * 的平衡点；实测一页 30 条足够覆盖中速滚动到哨兵的时间。
   *
   * 文档隐藏时不预取：用户切走了还在给站源打请求没有意义，也会拖慢切回来时的首屏。
   */
  useEffect(() => {
    if (!hasMore || isLoading || isLoadingMore) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    // 用一个句柄类型区分两种调度器：setTimeout 在部分环境返回 number，但两条分支
    // 需要各自取消，不能混着 clearTimeout/cancelIdleCallback（互相传对方的 id 是
    // 无效调用，静默不生效 —— 旧代码就这么错了，只是当时没暴露）。
    let cancel: (() => void) | null = null;
    const win = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (win.requestIdleCallback && win.cancelIdleCallback) {
      const handle = win.requestIdleCallback(() => prefetchMore(catalogKeywordRef.current), { timeout: 1500 });
      cancel = () => win.cancelIdleCallback!(handle);
    } else {
      const handle = window.setTimeout(() => prefetchMore(catalogKeywordRef.current), 200);
      cancel = () => window.clearTimeout(handle);
    }
    return () => cancel?.();
  }, [hasMore, isLoading, isLoadingMore, items.length, prefetchMore]);

  /**
   * context value 必须 memo。
   *
   * 目录数据是本项目变动最频繁的状态（翻页、补集数、切筛选都会改），而消费方
   * `ExploreView` 挂着上百张卡片。不 memo 的话，光是后台补集数这种"用户看不见的更新"
   * 就会把整页卡片重新渲染一遍。
   */
  const value = useMemo<CatalogContextType>(() => ({
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
    prefetchMore,
    refreshContinueWatching,
  }), [
    activeSources, audience, categories, category, channel, continueWatching, error, hasMore,
    isLoading, isLoadingMore, items, loadData, loadMore, prefetchMore, refreshContinueWatching,
    setChannel, sort,
  ]);

  return (
    <CatalogContext.Provider value={value}>
      {children}
    </CatalogContext.Provider>
  );
};

export function useCatalogStore() {
  const ctx = useContext(CatalogContext);
  if (!ctx) throw new Error('useCatalogStore must be used within CatalogProvider');
  return ctx;
}
