import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { ipcService, type HotSearchData, type HongguoSearchTab } from '../../services/ipc';
import { expandSeriesSeasons } from '../../services/searchSeasonExpand';
import { collapseSeriesGroups, mergeMembership, type MembershipMap } from '../../services/seriesGrouping';
import { CatalogFilter, SeriesItem } from '../../types/catalog';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { SeriesCard, SERIES_GRID_CLASS } from '../common/SeriesCard';
import { SeriesCardSkeleton } from '../common/SeriesCardSkeleton';
import { SeriesSeasonPicker } from '../common/SeriesSeasonPicker';
import { BackToTop } from '../common/BackToTop';
import { FluentButton } from '../common/FluentButton';

type Channel = 'drama' | 'comic';

/** 搜索默认频道：站点搜索接口不做频道过滤（实测所有结果都是 doc_type:23 的剧集），
 *  固定 drama 让 card 的 type 标记一致，避免两个频道搜出同一批结果的假象。 */
const SEARCH_CHANNEL: Channel = 'drama';

/**
 * 搜索 tab：只放短剧相关的四个。
 *
 * 小说 / 听书属于书城内容，后端也只会拒绝这两个值（`hongguo_api::parse_tab`），
 * 所以这里连按钮都不给——放上去点一下报错，比不给更糟。
 */
const SEARCH_TABS: { key: HongguoSearchTab; label: string }[] = [
  { key: 'overall', label: '综合' },
  { key: 'series', label: '剧集' },
  { key: 'video', label: '视频' },
  { key: 'discussion', label: '讨论' },
];

/**
 * 综合 tab 的筛选项。值与 App 筛选面板发给服务端的 `selected_items` 一致。
 *
 * 只在综合 tab 上有效：服务端对其它 tab 不认这个参数，后端也会拒绝，
 * 所以其它 tab 下这排按钮是禁用的。
 */
const SEARCH_FILTERS: { value: string; label: string }[] = [
  { value: 'content_type_short_play', label: '真人剧' },
  { value: 'content_type_dynamic_comic', label: '漫剧' },
  { value: 'content_type_ai_dynamic_comic', label: 'AI剧' },
  { value: 'content_type_long_video', label: '影视剧' },
  { value: 'search_range_unread', label: '未看过' },
];

/**
 * 两批结果按 id 合并，`base` 的顺序优先。
 *
 * 搜索是两条并行链（主结果 + App 联想），谁先回来由后端缓存与调度决定，不是
 * 固定的先后。两者都只能**并入**已有列表，绝不能整体覆盖——覆盖会把屏幕上
 * 已经画好的卡片换掉或重排（用户反馈："先出来几张，然后一批卡片突然把它们
 * 顶掉"）。
 */
const mergeById = (base: SeriesItem[], extra: SeriesItem[]): SeriesItem[] => {
  if (extra.length === 0) return base;
  const seen = new Set(base.map(item => item.id));
  const added = extra.filter(item => !seen.has(item.id));
  return added.length > 0 ? [...base, ...added] : base;
};

/**
 * 搜索结果页。
 *
 * 唯一的搜索输入在顶部标题栏：聚焦弹搜索历史浮层、回车直接进这里。本视图只
 * 负责展示结果——此前页面内再放一个输入框与历史卡片的中间态已移除（用户反馈
 * "这个页面是多余的"）。无关键词时给一个指向上方搜索框的占位提示。
 */
export const SearchView: React.FC = () => {
  const {
    currentView,
    searchKeyword,
    setSearchKeyword,
    rememberSearch,
    navigateTo,
  } = useAppStore();

  /**
   * 全部卡片共用这一个点击回调（卡片自己带上 seriesId）。
   *
   * 必须是稳定的 `useCallback`：内联箭头函数会让 `SeriesCard` 的 `React.memo` 失效，
   * 搜索结果页一次 40 张卡就会因为任何无关重渲染全部重画。`rememberSearch` /
   * `navigateTo` 在 useAppStore 里已稳定，依赖数组因此保持不变。
   *
   * 关键词**必须**走 ref：它在依赖数组里就等于每次输入都换一个新回调，
   * 40 张 memo 卡的相等判定逐字失效——正是这条注释要防的那件事。
   */
  const keywordRef = useRef(searchKeyword);
  keywordRef.current = searchKeyword;

  /** 真正跳详情：搜索历史与导航都只在这里做一次。 */
  const openDetail = useCallback((seriesId: string) => {
    rememberSearch(keywordRef.current.trim());
    navigateTo('detail', seriesId);
  }, [navigateTo, rememberSearch]);

  /**
   * 当前这份卡片的快照，供点击回调判断"这张卡是不是一个折叠过的系列"。
   *
   * 回调必须保持稳定（`SeriesCard` 的 memo 前提，见上面那段注释），所以不能在依赖
   * 数组里带 `items`；用 ref 读最新值，点击时再决定是弹窗还是直接进详情。
   */
  const itemsRef = useRef<SeriesItem[]>([]);

  const [channel] = useState<Channel>(SEARCH_CHANNEL);

  /**
   * 搜索 tab 与筛选项（红果 App 直连）。
   *
   * ## 为什么要单独一套状态
   *
   * 主链路（综合 tab、无筛选）走的是**多源合并**：红果官网 + 动漫 + App 联想，
   * 三路各有各的坑与各自的修复（见下面 `useEffect` 里那几段长注释）。而 tab 与
   * 筛选是 App 搜索独有的概念，服务端一次只返回该 tab 的一页，没有"合并"可言。
   *
   * 所以这里不做"把筛选塞进旧链路"的改造 —— 那会同时踩到网页搜索与联想两路，
   * 而它们根本不认这些参数。改成：**选了 tab 或筛选就切到单源直连**，
   * 综合且无筛选时保持原样。两条路径的结果都进同一个 `applyItems` 出口，
   * 折叠、分组、选季窗口因此完全复用，不会出现两套卡片行为。
   */
  const [tab, setTab] = useState<HongguoSearchTab>('overall');
  const [filters, setFilters] = useState<string[]>([]);
  /** App 直连模式的翻页游标；合并链路用 `nextPage`，两者互不干扰。 */
  const nativeCursorRef = useRef<string | null>(null);

  /** 是否切到了 App 直连（选了非综合 tab，或勾了任意筛选）。 */
  const nativeMode = tab !== 'overall' || filters.length > 0;

  /**
   * 搜索框的联想词（App 的 `suggest` 接口，只回文本）。
   *
   * 与 `catalog.searchSuggest` 区分开：那条是"补分季条目"用的（回的是带 id 的
   * 剧集项，走 Python worker 的搜索子命令），这里只是**输入提示**。
   * 点一个联想词就是把它填进搜索框，不是直接跳详情。
   */
  const [suggestions, setSuggestions] = useState<string[]>([]);

  /**
   * 轮播提示词（`search_cues`）。
   *
   * 只在**没有关键词**时显示在顶部那行副标题里：它本来就是搜索框的占位文案
   * （「书名」「主角」这类），有结果时再显示只会和结果说明抢位置。
   */
  const [cues, setCues] = useState<string[]>([]);
  /** 无关键词时的热搜。拿不到就保持 `null`，页面退回原来的占位提示。 */
  const [hot, setHot] = useState<HotSearchData | null>(null);
  const [items, setItems] = useState<SeriesItem[]>([]);
  itemsRef.current = items;
  /**
   * 正在「选季」的那个系列（null = 没有弹窗）。
   *
   * 存整张 `SeriesItem` 而不是只存 id：弹窗要用它的 title / type / seasonCount，
   * 而这三样在点击那一刻就已经在手上，回头再去 `items` 里找一遍只会多一次失效可能
   * （比如弹窗开着的时候用户点了「加载更多」）。
   */
  const [picking, setPicking] = useState<SeriesItem | null>(null);

  /**
   * 卡片点击：折叠过的系列卡先弹「选季」窗口，其余照旧直接进详情。
   *
   * 判据是 `seriesFoldedCount > 1`（= 这张卡代表一个系列），不是 `seasonCount` ——
   * 后者只在季号连续时才有值，拿它当开关会让"持械入宋"那种有缺口的系列点了直接跳走。
   */
  const handleCardClick = useCallback((seriesId: string) => {
    const target = itemsRef.current.find(item => item.id === seriesId);
    if (target && (target.seriesFoldedCount ?? 0) > 1) {
      setPicking(target);
      return;
    }
    openDetail(seriesId);
  }, [openDetail])

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 后端给的来源说明（正常是"红果官网搜索 · 关键词"，失败时追加降级说明）。
   *  染不染琥珀色看 `degraded`，不看这段文字——见下方 `degraded` 的注释。 */
  const [sourceNote, setSourceNote] = useState<string | null>(null);
  /** 后端给的降级标志位（有没有来源真的挂了）。 */
  const [degraded, setDegraded] = useState(false);
  /** 分页：hasMore 决定底部显示"加载更多"还是"已显示全部"，nextPage 是下次要拉的页。 */
  const [hasMore, setHasMore] = useState(false);
  const [nextPage, setNextPage] = useState(2);
  /**
   * 后端报的**条目总数**（不是卡数）。
   *
   * 2026-10-29 起不再直接展示：同系列折叠后，35 季会数成 35 条而屏幕上只有 1 张卡，
   * 拿它显示会出现"已显示全部 44 部"底下摆着 8 张卡。头部与底部一律改报
   * `items.length`（= 用户实际能点的卡数）。这个 state 留着是因为它仍是
   * "后端到底认不认得这个词、一共有多少条"的唯一来源，排查搜索质量时要看。
   */
  const [total, setTotal] = useState(0);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  // 请求编号：关键词变化很快时，旧请求不允许覆盖新结果。
  const requestIdRef = useRef(0);
  /** 首屏那一发的 filter：加载更多直接复用它翻页，在别处重建迟早漏字段。 */
  const filterRef = useRef<CatalogFilter | null>(null);
  /** 本轮主结果（网页 + 动漫，含翻页）。null = 还没到。 */
  const mainItemsRef = useRef<SeriesItem[] | null>(null);
  /** 本轮 App 联想补充。它只补齐网页漏掉的分季条目，永远排在主结果之后。 */
  const suggestItemsRef = useRef<SeriesItem[]>([]);

  /**
   * 季表回填的归属：series id → 它属于哪个系列的第几季（2026-10-29）。
   *
   * 分组（`groupSeriesItems`）的第一优先依据。**不可省**：季表里 index=1 的标题
   * 就是裸名「烬九州」，`parseSeasonLabel` 解析不出季号 —— 只按标题分组的话，
   * 用户会看到一个从第 2 季开始、第 1 季飘在块外的系列。
   *
   * 换关键词时随 `resetPaging` 一起清空：上一个词的归属若留下来，新结果里同名的剧
   * 会被错误地并进旧系列。
   */
  const membershipRef = useRef<MembershipMap>(new Map());

  /**
   * **列表的唯一出口**：所有写结果的地方都走它。
   *
   * 两个理由：
   * 1. 分组必须只在一处发生。四处各自 `setItems` 的话，"哪一次渲染忘了分组"就会
   *    表现为同一批卡在两次更新之间来回跳（用户报过"卡片突然被顶掉"这类问题）；
   * 2. `mainItemsRef` 与 `items` 必须同步。ref 存**未分组**的真实顺序（分组是显示层），
   *    下一次合并仍在稳定基准上做，不会被上一轮的分组结果二次影响。
   */
  const applyItems = (next: SeriesItem[]) => {
    mainItemsRef.current = next;
    /**
     * 折叠：一个系列只留一张代表卡（2026-10-29 第二版）。
     *
     * `mainItemsRef` 里存的仍是**未折叠**的原始列表 —— 这一步只影响显示。折叠后的
     * 列表再拿去合并「加载更多」会丢条目（同一系列只剩一条，其余季在 dedupe 时被当成
     * "已在列表里"而不再追加，翻页也就永远补不回来）。
     *
     * 两个字段都挂在代表条目上（不改数据源）：
     * - `seasonCount`：能确信季数时才有值，卡上渲染右上角的「N 季」胶囊；
     * - `seriesFoldedCount`：折叠了几条（= memberCount）。它才是"要不要弹选季窗口"
     *   的开关 —— 与 `seasonCount` 分开，因为季号有缺口时后者是 undefined，而这张卡
     *   依然代表一个系列。
     *
     * 映射放在 `applyItems` 这一个出口里，所以首屏、联想、聚合、「加载更多」四条路径
     * 都会挂上这两个字段（尤其「加载更多」：它追加的卡同样会被折叠）。
     */
    const cards = collapseSeriesGroups(next, membershipRef.current).map(
      ({ representative, memberCount, seasonCount }) => {
        // 单条（无归属的普通剧）直接用原引用：`SeriesCard` 是 memo 的，
        // 每帧新建对象会让整屏卡白白重渲染。
        if (memberCount <= 1 && !(seasonCount && seasonCount > 1)) return representative;
        const card: SeriesItem = { ...representative, seriesFoldedCount: memberCount };
        if (seasonCount && seasonCount > 1) card.seasonCount = seasonCount;
        return card;
      },
    );
    setItems(cards);
  };

  /**
   * 换关键词（或清空）时把分页状态整体归零。
   *
   * 不归零的话，上一轮的 hasMore / nextPage 会跟着新结果一起显示——新关键词
   * 明明只有一页，底部却挂着个翻到别的关键词那页去的"加载更多"。
   */
  const resetPaging = () => {
    setSourceNote(null);
    setDegraded(false);
    setHasMore(false);
    setNextPage(2);
    setIsLoadingMore(false);
    setLoadMoreError(null);
    // 换词时关掉选季窗口：它挂着的是上一个关键词的系列，留着只会让人以为结果没刷新。
    setPicking(null);
    // 本轮结果的合并基准一并归零：上一个词的主结果 / 联想不能混进新结果。
    mainItemsRef.current = null;
    suggestItemsRef.current = [];
    // 归属表同理：留着上一轮的系列归属，新结果里的同名剧会被错误地并进旧系列。
    membershipRef.current = new Map();
  };

  useEffect(() => {
    // 只在结果页激活时发起搜索：顶部搜索框的输入是全局状态，用户在其它页面
    // 敲字（尚未回车提交）不该在后台空跑一轮请求。
    if (currentView !== 'search') return;
    const keyword = searchKeyword.trim();
    // 每次关键词变化立即作废在途请求：防抖窗口内用户又敲了一个字时，
    // 上一次的响应回来不该再往屏幕上画。加载更多复用同一个编号。
    const requestId = ++requestIdRef.current;
    if (!keyword) {
      setItems([]);
      setError(null);
      setIsLoading(false);
      resetPaging();
      filterRef.current = null;
      return;
    }
    // 防抖 300ms：旧实现每敲一个字就发一次全量搜索，而每一发在后端都要
    // 冷启动一个 Python 进程跑 App 联想，打字快时等于连开好几个进程。
    const timer = window.setTimeout(() => {
      setIsLoading(true);
      setError(null);
      resetPaging();

      // ── App 直连分支 ────────────────────────────────────────────────────
      // 选了非综合 tab 或勾了筛选时走这里：单一 App 接口、游标分页，
      // 不再合并网页与联想（它们不认这两个参数）。
      if (nativeMode) {
        nativeCursorRef.current = null;
        void ipcService.hongguo
          .search({ keyword, tab, filters, pageSize: 40, channel })
          .then(page => {
            if (requestId !== requestIdRef.current) return;
            applyItems(page.items);
            nativeCursorRef.current = page.cursor;
            const tabLabel = SEARCH_TABS.find(t => t.key === tab)?.label ?? '综合';
            const filterLabel = filters.length > 0 ? ` · ${filters.length} 项筛选` : '';
            setSourceNote(`红果 App 直连 · ${tabLabel}${filterLabel}`);
            setDegraded(false);
            setHasMore(page.hasMore);
            setTotal(page.items.length);
            void ipcService.catalog.guoCoverPrefetch(page.items.map(item => item.id));
          })
          .catch((err: unknown) => {
            if (requestId !== requestIdRef.current) return;
            setError((err as Error).message || '搜索失败，请稍后重试。');
            setItems([]);
            mainItemsRef.current = null;
          })
          .finally(() => {
            if (requestId === requestIdRef.current) setIsLoading(false);
          });
        return;
      }

      const filter: CatalogFilter = {
        channel,
        // 不带 source：搜索恒走全源（红果官网 + 动漫 + App 联想）。此前把浏览页
        // 选中的站源拼进来，用户在发现页选了什么就只搜得到什么——换个源连搜索
        // 结果都跟着换，搜索失去了"帮我找"的意义。source 为空后端才走三路合并。
        category: '全部',
        audience: '全部',
        sort: 'recommend',
        keyword,
        page: 1,
        pageSize: 40,
      };
      filterRef.current = filter;
      /**
       * 两路**并行**发出，不再串联。
       *
       * 旧实现把联想挂在 `searchFast` 的 `.then` 里，于是总耗时 = 快路 + 联想
       * （实测 0.3-0.6s + 0.6-1.9s，联想要冷启动一个 Python 进程）。而联想是纯补充
       * （补网页漏掉的分季条目），从头到尾不阻塞首屏——串联唯一的作用就是让尾部凭空
       * 多等一拍。改成并行后总耗时是两者的**最大值**，那条慢链路完整地藏进了用户读
       * 首屏结果的时间里。
       */
      const suggestPromise = ipcService.catalog.searchSuggest(keyword, channel);
      /**
       * 主结果这一发单独留个引用：下面的「系列聚合」要等它与联想**都落定**再发。
       *
       * 不能挂在 `searchFast` 的 `.then` 里：实测联想（0.6–1.9s）通常比首屏
       * （0.3–0.6s）慢，挂在首屏上就会拿"只有网页结果"的列表去认系列，而联想
       * 恰恰是补分季条目的那一路——漏了它，锚点可能一个都认不出来。
       */
      const fastPromise = ipcService.catalog.searchFast(filter);
      fastPromise
        .then(page => {
          if (requestId !== requestIdRef.current) return;
          applyItems(mergeById(page.items, suggestItemsRef.current));
          setSourceNote(page.source ?? null);
          setDegraded(page.degraded === true);
          setHasMore(page.hasMore);
          setTotal(page.total);
          // 红果官网搜索本身有分页，此前固定只要第 1 页，hasMore / total 一直
          // 被白白丢掉：命中多页的长尾剧永远只剩首屏那几十张卡片。
          setNextPage(page.page + 1);
          // 首屏已可用，先收掉 loading，用户不用为补充来源继续等。
          setIsLoading(false);
          // 搜索结果里可能混着 guo 源条目（用户启用了 guo 源时），它们的封面要
          // 走 guo-core：一次 IPC 解析一批，而不是等每张卡各自进视口各发一次。
          void ipcService.catalog.guoCoverPrefetch(page.items.map(item => item.id));
        })
        .catch((err: unknown) => {
          if (requestId !== requestIdRef.current) return;
          setError((err as Error).message || '搜索失败，请稍后重试。');
          setItems([]);
          // 主结果都没了，归属表再留着只会让下一次搜索的裸名剧被并进这次的空组。
          mainItemsRef.current = null;
          membershipRef.current = new Map();
        })
        .finally(() => {
          if (requestId === requestIdRef.current) setIsLoading(false);
        });

      // 联想单独一条链：失败静默（它是补充来源），且必须复查 requestId。
      void suggestPromise
        .then(suggestions => {
          if (!suggestions || requestId !== requestIdRef.current) return;
          // 联想按 id 去重后追加：它只是补齐网页漏掉的分季条目，
          // 不打断用户已经在看的首屏结果。
          suggestItemsRef.current = suggestions;
          // 主结果还没到就先不画：先画联想、等主结果到达再整体重排，
          // 正是这次要修的那种跳动。
          if (mainItemsRef.current) applyItems(mergeById(mainItemsRef.current, suggestions));
        })
        .catch(() => {
          // 联想失败不影响已有结果。
        });

      /**
       * ===== 系列聚合：把这个系列的各季补进列表（2026-10-29）=====
       *
       * ## 为什么等两路都落定
       *
       * 锚点从「首屏 + 联想」的合并结果里认（`pickSeasonAnchors` 按剧名 base 分组），
       * 少一路就可能认不出系列：实测《烬九州》的分季条目全在联想里，网页搜索改版后
       * 恒返回 0 条。等到两路都落定再认，命中率才与"用户看到的结果"一致。
       *
       * ## 为什么失败完全静默
       *
       * 聚合是**增量**：季表拿不到就只是少几张卡，已有结果、loading、错误提示都
       * 不该被它影响（`expandSeriesSeasons` 内部已经按锚点做了 allSettled）。
       *
       * ## 并入之后再分组（2026-10-29）
       *
       * 新卡先进 `mainItemsRef`（真实顺序，追加在尾部），再由 `applyItems` 统一分组：
       * 同系列的各季聚到**该组首次出现的位置**，组内按季号升序。用户原话是
       * 「搜索页将相同的系列剧放一块」「方便于用户挑选短剧和观看」——所以这里会挪动
       * 卡片，且只挪同系列的：无归属的条目（别的剧）相对顺序一律不动（见
       * `groupSeriesItems` 的第 5 条）。
       *
       * 归属（`membership`）必须**先写**再分组：裸名的第 1 季只能靠季表回填才认得出来。
       */
      void Promise.allSettled([fastPromise, suggestPromise]).then(() => {
        if (requestId !== requestIdRef.current) return;
        const merged = mergeById(mainItemsRef.current ?? [], suggestItemsRef.current);
        if (merged.length === 0) return;
        void expandSeriesSeasons(merged, channel)
          .then(extra => {
            if (!extra || extra.items.length === 0) return;
            // `await` 期间用户可能换了关键词、也可能点了「加载更多」，写入前再查一次。
            if (requestId !== requestIdRef.current) return;
            /**
             * 先记归属、再落地条目：`applyItems` 内部会立刻分组，归属晚一步写进来，
             * 这一帧的裸名第 1 季就还在块外（下一次渲染才归位 —— 那正是"卡片跳一下"）。
             */
            membershipRef.current = mergeMembership(membershipRef.current, extra.membership);
            applyItems(mergeById(mainItemsRef.current ?? [], extra.items));
            // 与首屏同一套封面预热：红果的 HEIC 与 guo 源封面都要后端转一次。
            void ipcService.catalog.guoCoverPrefetch(extra.items.map(item => item.id));
          })
          .catch(() => {
            // 增量来源，失败就是少几张卡，不打扰任何已渲染的内容。
          });
      });
    }, 300);
    return () => window.clearTimeout(timer);
    // `tab` / `filters` 变化要重跑：它们决定走直连还是合并链路，也决定直连的查询参数。
  }, [currentView, searchKeyword, channel, tab, filters]);

  /**
   * 热搜只在「搜索页 + 无关键词」时拉一次（失败静默，保留占位提示）。
   * 只拉一次是刻意的：它一天也不会变几次，切来切去不该反复打接口。
   */
  useEffect(() => {
    if (currentView !== 'search' || searchKeyword.trim() || hot) return;
    let alive = true;
    void ipcService.catalog.hotSearch().then(data => {
      if (alive && data) setHot(data);
    });
    return () => {
      alive = false;
    };
  }, [currentView, searchKeyword, hot]);

  /**
   * 轮播提示词只拉一次（App 的 `search_cues`）。
   *
   * 它是搜索框的占位文案，内容基本不变；失败静默——没有提示词就不显示，
   * 不该因此让搜索页报错。
   */
  useEffect(() => {
    if (currentView !== 'search' || cues.length > 0) return;
    let alive = true;
    void ipcService.hongguo.searchCues().then(texts => {
      if (alive && texts.length > 0) setCues(texts);
    });
    return () => {
      alive = false;
    };
  }, [currentView, cues.length]);

  /**
   * 联想词：用户输入的防抖（250ms）预览。
   *
   * 只在搜索页、关键词非空时拉；关键词清空就立即清掉联想，避免上一次的旧词
   * 留在屏幕上（它会看起来像"搜索框里还有字"）。
   */
  useEffect(() => {
    if (currentView !== 'search') return;
    const keyword = searchKeyword.trim();
    if (!keyword) {
      setSuggestions([]);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      void ipcService.hongguo.suggest(keyword).then(texts => {
        if (!alive) return;
        // 与输入完全相同的词不重复提示：点了也不会有任何变化。
        setSuggestions(texts.filter(t => t.trim() && t.trim() !== keyword).slice(0, 8));
      });
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [currentView, searchKeyword]);


  /**
   * 加载更多：复用首屏的 filter，只把 page 往后推一格。
   *
   * 必须复查 requestIdRef —— 用户在加载途中改了关键词，这一页的响应属于上一轮，
   * 直接追加就会把别的关键词的剧混进当前列表。页号在 await 之前快照，避免续体
   * 读到已经翻过一次的 nextPage。
   */
  const loadMore = async () => {
    const requestId = requestIdRef.current;

    // 直连模式：翻页靠游标，不碰 `nextPage` / `filterRef`（那是合并链路的）。
    if (nativeMode) {
      const cursor = nativeCursorRef.current;
      if (!cursor || isLoadingMore) return;
      setIsLoadingMore(true);
      setLoadMoreError(null);
      try {
        const page = await ipcService.hongguo.search({
          keyword: searchKeyword.trim(),
          tab,
          filters,
          cursor,
          pageSize: 40,
          channel,
        });
        if (requestId !== requestIdRef.current) return;
        // 合并而不是覆盖：`applyItems` 负责折叠，这里只把新卡并到尾部。
        applyItems(mergeById(mainItemsRef.current ?? [], page.items));
        nativeCursorRef.current = page.cursor;
        setHasMore(page.hasMore);
        void ipcService.catalog.guoCoverPrefetch(page.items.map(item => item.id));
      } catch (err) {
        if (requestId === requestIdRef.current) {
          setLoadMoreError((err as Error).message || '加载更多失败，请重试。');
        }
      } finally {
        if (requestId === requestIdRef.current) setIsLoadingMore(false);
      }
      return;
    }

    const filter = filterRef.current;
    if (!filter || isLoadingMore) return;
    const page = nextPage;
    setIsLoadingMore(true);
    setLoadMoreError(null);
    try {
      const result = await ipcService.catalog.list({ ...filter, page });
      if (requestId !== requestIdRef.current) return;
      // 去重同样是必需的：后端 catalog_list 带关键词时也会合并 App 联想，
      // 联想是整批重复的，不滤掉每翻一页都会白长出同样几张卡片。
      applyItems(
        mergeById(
          mergeById(mainItemsRef.current ?? [], result.items),
          suggestItemsRef.current,
        ),
      );
      setHasMore(result.hasMore);
      setTotal(result.total);
      setNextPage(page + 1);
      // 翻页新进来的卡片同样要预热封面（已预热的会被跳过）。
      void ipcService.catalog.guoCoverPrefetch(result.items.map(item => item.id));
    } catch (err) {
      // 不动已有结果：翻页失败没理由把用户已经看到的几十张卡片清空。
      if (requestId === requestIdRef.current) {
        setLoadMoreError((err as Error).message || '加载更多失败，请重试。');
      }
    } finally {
      if (requestId === requestIdRef.current) setIsLoadingMore(false);
    }
  };

  const hasKeyword = searchKeyword.trim().length > 0;

  /** 回到顶部要自己拿得到滚动容器。与发现页 / 动漫专区同一套交互。 */
  const scrollRef = useRef<HTMLDivElement | null>(null);

  /**
   * 有几张卡是"折叠过的系列"。
   *
   * 只用于头部那句轻量说明（`> 0` 才显示）：没有折叠卡时（比如搜一个不分季的剧），
   * 「已按系列合并」只会是噪音。O(n) 且只在渲染时算一次。
   */
  const foldedCount = items.filter(item => (item.seriesFoldedCount ?? 0) > 1).length;

  return (
    <div ref={scrollRef} className="w-full h-full overflow-y-auto select-none p-6 sm:p-8">
      <div className="max-w-5xl mx-auto flex flex-col gap-5 pb-24">
        {/* 结果页头部：返回 + 当前关键词 + 计数（搜索输入与历史都在顶部搜索框） */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigateTo('explore')}
            className="w-9 h-9 rounded-xl bg-white hover:bg-slate-50 text-slate-600 border border-slate-200/80 shadow-xs flex items-center justify-center transition-all active:scale-95 cursor-pointer flex-shrink-0"
            title="返回发现"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>

          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-bold text-slate-800 truncate">
              {hasKeyword ? `「${searchKeyword.trim()}」的搜索结果` : '搜索'}
            </h2>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {hasKeyword
                ? (isLoading
                    ? '搜索中…'
                    : `按相关度排序 · 精确匹配在前 · 找到 ${items.length} 部短剧${
                        foldedCount > 0 ? ' · 已按系列合并，带季数的卡可先选季' : ''
                      }`)
                : cues.length > 0
                  // 有轮播提示词就用它当引导：比"输入关键词开始搜索"具体得多，
                  // 也顺带告诉用户这个搜索框认哪些写法（App 给的占位文案）。
                  ? `试试搜：${cues.slice(0, 3).join(' · ')}`
                  : '在顶部的搜索框输入关键词开始搜索'}
            </p>
            {/* 来源说明：正常态是灰字（哪种来源、搜的什么），后端给出 degraded
                标志位（有一路来源真的挂了）就染成琥珀色——降级不等于失败，
                不该借用 rose 那套错误色。
                此前这里是拿 `source` 文案去匹配「不可用/已跳过/失败/超时」等词表的，
                而这段文案里本来就嵌着用户搜的词：搜"失败"会把正常来源行染成警告色。
                标志位是结构化的，同样的文案换个关键词不再误判。 */}
            {sourceNote && (
              <p className={`mt-0.5 text-[11px] ${degraded ? 'text-amber-600' : 'text-slate-400'}`}>
                {sourceNote}
              </p>
            )}
          </div>
        </div>

        {/* 搜索档位与筛选（红果 App 直连）。
            只在有关键词时出现：没搜东西时这两排按钮点了也不会改变任何结果。
            选了非「综合」tab 或勾了任一筛选，就会切到单源直连链路（见上方 state 注释），
            头部那句来源说明会相应写「红果 App 直连」。 */}
        {hasKeyword && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {SEARCH_TABS.map(t => {
                const active = tab === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setTab(t.key)}
                    className={`px-3 py-1.5 rounded-full text-xs transition-colors cursor-pointer border ${
                      active
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white/88 text-slate-600 border-slate-200/80 hover:bg-slate-50'
                    }`}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>

            {/* 筛选项只对综合 tab 有意义：其它 tab 下服务端不认 selected_items，
                后端也会直接拒绝，所以这里禁用而不是静默无效。 */}
            <div className="flex flex-wrap items-center gap-2">
              {SEARCH_FILTERS.map(f => {
                const active = filters.includes(f.value);
                const disabled = tab !== 'overall';
                return (
                  <button
                    key={f.value}
                    type="button"
                    disabled={disabled}
                    onClick={() =>
                      setFilters(prev =>
                        prev.includes(f.value)
                          ? prev.filter(v => v !== f.value)
                          : [...prev, f.value],
                      )
                    }
                    className={`px-3 py-1.5 rounded-full text-[11px] border transition-colors ${
                      disabled
                        ? 'bg-slate-50 text-slate-300 border-slate-200/60 cursor-not-allowed'
                        : active
                          ? 'bg-sky-50 text-sky-700 border-sky-200 cursor-pointer'
                          : 'bg-white/88 text-slate-500 border-slate-200/80 hover:bg-slate-50 cursor-pointer'
                    }`}
                    title={disabled ? '筛选项只对「综合」有效' : undefined}
                  >
                    {f.label}
                  </button>
                );
              })}
              {filters.length > 0 && (
                <button
                  type="button"
                  onClick={() => setFilters([])}
                  className="px-2 py-1.5 rounded-full text-[11px] text-slate-400 hover:text-slate-600 transition-colors cursor-pointer"
                >
                  清空筛选
                </button>
              )}
            </div>

            {/* 联想词：点一个就是把它填进搜索框（不是直接跳详情）。
                来源是 App 的 suggest 接口，只回文本，所以这里没有封面也没有 id。 */}
            {suggestions.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-slate-400">相关搜索</span>
                {suggestions.map(text => (
                  <button
                    key={text}
                    type="button"
                    onClick={() => setSearchKeyword(text)}
                    className="px-3 py-1.5 rounded-full bg-white/88 text-[11px] text-slate-600 border border-slate-200/80 hover:bg-slate-50 transition-colors cursor-pointer"
                  >
                    {text}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 无关键词：热搜（App 接口）；拿不到时退回原来的占位提示 */}
        {!hasKeyword && (
          <>
            {hot && (hot.guesses.length > 0 || hot.boards.some(b => b.items.length > 0 || b.topics.length > 0)) ? (
              <>
                {hot.guesses.length > 0 && (
                  <div className="rounded-2xl bg-white/88 border border-white/80 shadow-fluent p-5">
                    <p className="text-xs font-bold text-slate-700 mb-3">猜你想搜</p>
                    <div className="flex flex-wrap gap-2">
                      {hot.guesses.map(item => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => openDetail(item.id)}
                          className="px-3 py-1.5 rounded-full bg-slate-100 hover:bg-slate-200/80 text-xs text-slate-700 transition-colors cursor-pointer"
                        >
                          {item.title}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {hot.boards
                  .filter(board => board.items.length > 0 || board.topics.length > 0)
                  .map(board => (
                    <div
                      key={board.name}
                      className="rounded-2xl bg-white/88 border border-white/80 shadow-fluent p-5"
                    >
                      <p className="text-xs font-bold text-slate-700 mb-2">{board.name}</p>
                      <ol className="flex flex-col">
                        {board.items.slice(0, 10).map((item, index) => (
                          <li key={item.id}>
                            <button
                              type="button"
                              onClick={() => openDetail(item.id)}
                              className="w-full flex items-center gap-3 px-1 py-1.5 rounded-lg text-left hover:bg-slate-50 transition-colors cursor-pointer"
                            >
                              <span
                                className={`w-5 flex-shrink-0 text-center text-xs font-bold ${
                                  index < 3 ? 'text-rose-500' : 'text-slate-400'
                                }`}
                              >
                                {index + 1}
                              </span>
                              <span className="flex-1 min-w-0 truncate text-xs text-slate-700">
                                {item.title}
                              </span>
                              {item.heat && (
                                <span className="flex-shrink-0 text-[11px] text-slate-400">
                                  {item.heat}
                                </span>
                              )}
                            </button>
                          </li>
                        ))}
                        {board.topics.map((topic, index) => (
                          <li key={`${board.name}-topic-${index}`}>
                            <button
                              type="button"
                              onClick={() => setSearchKeyword(topic.query)}
                              className="w-full flex items-center gap-3 px-1 py-1.5 rounded-lg text-left hover:bg-slate-50 transition-colors cursor-pointer"
                            >
                              <span className="w-5 flex-shrink-0 text-center text-xs font-bold text-rose-500">
                                ·
                              </span>
                              <span className="flex-1 min-w-0 truncate text-xs text-slate-700">
                                {topic.title}
                              </span>
                              {topic.heat && (
                                <span className="flex-shrink-0 text-[11px] text-slate-400">
                                  {topic.heat}
                                </span>
                              )}
                            </button>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ))}
              </>
            ) : (
              <div className="rounded-2xl bg-white/88 border border-white/80 shadow-fluent p-8 text-center">
                <p className="text-sm font-semibold text-slate-700">在上方搜索框输入剧名开始搜索</p>
                <p className="mt-1.5 text-xs text-slate-400">
                  支持剧名关键词与分季名称；点击搜索框可查看历史记录。
                </p>
              </div>
            )}
          </>
        )}

        {/* 有关键词：结果区 */}
        {hasKeyword && (
          <>
            {error && (
              <div className="rounded-2xl bg-rose-50/80 border border-rose-200/70 p-4 text-xs text-rose-700">
                {error}
              </div>
            )}

            {!error && !isLoading && items.length === 0 && (
              <div className="rounded-2xl bg-white/88 border border-white/80 shadow-fluent p-8 text-center">
                <p className="text-sm font-semibold text-slate-700">没有找到匹配的剧集</p>
                <p className="mt-1.5 text-xs text-slate-400">
                  试试更短的关键词，或换到另一个频道。分季剧集可以只搜主标题（如「聚宝仙盆」）。
                </p>
              </div>
            )}

            {/* 搜索中且还没有任何结果：骨架占住版面。首屏那一发要走整条来源链，
                几秒内结果区整块空白的话，用户会以为搜索没触发。 */}
            {!error && isLoading && items.length === 0 && (
              <div className={SERIES_GRID_CLASS} aria-busy="true">
                {Array.from({ length: 12 }).map((_, index) => <SeriesCardSkeleton key={index} />)}
              </div>
            )}

            {items.length > 0 && (
              <div className={`${SERIES_GRID_CLASS} ttv-grid-in`}>
                {items.map((series, index) => (
                  <SeriesCard
                    key={`${series.id}-${index}`}
                    series={series}
                    index={index}
onClick={handleCardClick}
                  />
                ))}
              </div>
            )}

            {/* 分页：按钮与"已显示全部"互斥，翻页出错只在这块提示，不清空上面的结果 */}
            {items.length > 0 && (
              <div className="flex flex-col items-center gap-2">
                {loadMoreError && <p className="text-[11px] text-rose-600">{loadMoreError}</p>}
                {hasMore ? (
                  <FluentButton
                    size="md"
                    disabled={isLoadingMore}
                    onClick={loadMore}
                    icon={isLoadingMore ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : undefined}
                  >
                    {isLoadingMore ? '加载中…' : '加载更多'}
                  </FluentButton>
                ) : (
                  // 折叠后一张卡 = 一个系列（或一部单剧），后端 total 数的是条目
                  // （35 季会数成 35），拿它显示会出现"已显示全部 44 部"底下只有 8 张卡。
                  // 所以这里统一用 `items.length` —— 它就是用户实际能点的卡数。
                  <p className="text-[11px] text-slate-400">
                    已显示全部 {items.length} 部
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <BackToTop targetRef={scrollRef} />

      {/* 选季窗口：搜索页专属的中间层（点系列卡先选季，再进详情）。
          `picking` 里存的是点击那一刻的卡，关闭时置 null。 */}
      {picking && (
        <SeriesSeasonPicker
          detail={{ id: picking.id, title: picking.title, type: picking.type }}
          seasonTotal={picking.seasonCount}
          onOpenSeason={seriesId => {
            setPicking(null);
            openDetail(seriesId);
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
};
