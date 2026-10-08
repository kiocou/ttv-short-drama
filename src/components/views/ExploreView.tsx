import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useCatalogStore } from '../../stores/useCatalogStore';
import { useAppStore, ShelfKind } from '../../stores/useAppStore';
import { usePlaybackActions } from '../../stores/usePlaybackStore';
import { useAnimePlayer } from '../../stores/useAnimePlayerStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { ipcService } from '../../services/ipc';
import { shelfFeedSupports } from '../../stores/useShelfFeed';
import { StatusBadge } from '../common/StatusBadge';
import { FluentButton } from '../common/FluentButton';
import { CoverImage } from '../common/CoverImage';
import { SeriesCard, SERIES_GRID_CLASS } from '../common/SeriesCard';
import { HomeShelf } from '../common/HomeShelf';
import { HomeShelfSection } from '../common/HomeShelfSection';
import { RandomWatchSection, hasRandomCandidates, PICK_CARD_SHELL } from '../common/RandomWatchSection';
import { CategoryBar } from '../common/CategoryBar';
import { BackToTop } from '../common/BackToTop';
import { SeriesItem } from '../../types/catalog';
import { SeriesDetail } from '../../types/series';
import {
  Flame,
  Sparkles,
  Play,
  TrendingUp,
  Clock,
  Moon,
} from 'lucide-react';

/**
 * 各频道的标题与量词。
 *
 * 刻意集中一处而不是散在 JSX 里写三元：`channel` 现在有四个值，再散着写
 * `channel === 'comic' ? 漫剧 : 短剧` 的话，新加的 `adult` 会静默落进"短剧"
 * 那个 else 分支——用户看到的是"精选短剧推荐"顶着 18+ 内容。
 */
const CHANNEL_COPY: Record<string, { title: string; noun: string }> = {
  drama: { title: '精选短剧推荐', noun: '短剧' },
  comic: { title: '精选漫剧推荐', noun: '漫剧' },
  adult: { title: '神秘小窝', noun: '内容' },
  anime: { title: '动漫推荐', noun: '动漫' },
};

/**
 * 「还剩 8 分 20 秒」。
 *
 * 续播卡上真正有用的数字是"还要花多久"，不是"已经花了多少"——后者进度条已经
 * 画出来了。拿不到时长（源没上报、`durationSeconds` 为 0）时返回空串，由调用方
 * 决定不渲染，而不是硬凑一个"还剩 0 秒"。
 */
function formatRemaining(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  if (total < 60) return `还剩 ${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) {
    const rest = total % 60;
    return rest > 0 ? `还剩 ${minutes} 分 ${rest} 秒` : `还剩 ${minutes} 分钟`;
  }
  return `还剩 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export const ExploreView: React.FC = () => {
  const {
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
    setCategory,
    setSort,
    refreshCatalog,
    loadMore,
    prefetchMore,
    refreshContinueWatching,
  } = useCatalogStore();

  const { currentView, navigateTo, openShelf } = useAppStore();
  // 只订阅低频动作专线。整表订阅会让本页上百张卡片跟着播放进度（约 4 次/秒）重渲染。
  const { openEpisode } = usePlaybackActions();
  const { open: openAnimeEpisode } = useAnimePlayer();
  const { settings } = useSettingsStore();
  const showAdultSources = settings.showAdultSources;

  /**
   * 关掉 18+ 总开关时，若正停在神秘小窝就退回短剧专区。
   *
   * tab 会在开关关闭时消失，但 `channel` 还停在 `adult`——不拉回来的话，
   * `sources` 变成空数组，页面会既没有 tab 高亮、也没有任何卡片，用户看到的是
   * "发现页坏了"而不是"你刚关掉了一个开关"。
   */
  useEffect(() => {
    if (!showAdultSources && channel === 'adult') setChannel('drama');
  }, [showAdultSources, channel, setChannel]);

  // 回到发现页就刷新"继续观看"：横幅的数据来自历史记录，而目录本身不会因为
  // 看了几集而变化，不单独刷新就会一直停在启动那一刻的旧进度。
  useEffect(() => {
    if (currentView === 'explore') void refreshContinueWatching();
  }, [currentView, refreshContinueWatching]);

  /**
   * 列表滚动容器。
   *
   * 这里曾经还有一个 `isContinueDismissed`：让用户叉掉「继续观看」横幅。并轨之后
   * 那个叉号被移除了 —— 它原本是"可选横幅"时代的交互，而现在这一行是页首固定的
   * "为你"区，叉掉一张只会让另一张变宽，语义上不成立。状态随之删除，别再加回来。
   */
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // 切换筛选后必须回到页首：筛选栏是当前结果的上下文，若保留旧滚动位置，
  // 用户会看到新结果却找不到刚才点过的题材，像页面没有真正更新。
  useEffect(() => {
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'instant' });
  }, [channel, category, sort]);

  /**
   * 封面不可得的卡片 id：从当前列表移除、不再展示。
   *
   * 判定条件是"确定不可得"——CoverImage 的三次加载重试已耗尽，或 guo 源的
   * 封面解析（Rust 侧带源侧 Referer 的下载）失败。切源/换筛选时整体重来：
   * 消失的卡片在下一次列表里重新获得一次出现机会（网络抖动不该永久除名）。
   */
  const [hiddenSeriesIds, setHiddenSeriesIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    setHiddenSeriesIds(new Set());
  }, [activeSources, channel, category, audience, sort]);

/**
   * 封面不可得就把卡片移出列表。
   *
   * 用 `useCallback` + 空依赖：`SeriesCard` 是 `React.memo` 的，内联箭头函数会让 props
   * 每次渲染都不相等，memo 直接失效。上百张卡时这个差别就体现在滚动帧耗时上。
   */
  const markSeriesUnavailable = useCallback((seriesId: string) => {
    setHiddenSeriesIds(prev => {
      if (prev.has(seriesId)) return prev;
      const next = new Set(prev);
      next.add(seriesId);
      return next;
    });
  }, []);

  /**
   * 卡片点击：全部卡片共用这一个回调（卡片自己带上 seriesId）。
   *
   * `navigateTo` 已是稳定引用（见 useAppStore），所以这个回调也稳定。
   */
  const handleCardClick = useCallback((seriesId: string) => {
    navigateTo('detail', seriesId);
  }, [navigateTo]);
  const handleCardPrefetch = useCallback((seriesId: string) => {
    void ipcService.series.getDetail(seriesId).catch(() => {});
  }, []);
  /**
   * 进入某个分区的「更多」页。
   *
   * 频道是这一步的全部难点：`ShelfMoreView` 内部挂的是**另一份** `CatalogProvider`，
   * 它读不到发现页的频道状态，所以必须在这一刻把当前频道一起交出去。
   * 少传这一下，用户从「漫剧次元」点进去会看到短剧列表。
   *
   * 不再有刷新动作：两颗刷新按钮已按要求移除（它们刷新的是首屏那 6 张预览卡，
   * 而用户真正要的是"这一栏还有什么"，入口交给「更多」）。
   */
  const handleShelfMore = useCallback((kind: ShelfKind) => {
    openShelf(kind, channel);
  }, [openShelf, channel]);

  /**
   * 实际展示的卡片：无封面地址的条目直接过滤（guo 源的封面不来自该字段，
   * 走 CoverImage 的异步解析，不过滤）；加载失败的按 id 移除。
   */
  const visibleItems = items.filter(item => {
    if (hiddenSeriesIds.has(item.id)) return false;
    if (!item.id.startsWith('guo:') && !(item.cover || '').trim()) return false;
    return true;
  });
  /**
   * 货架的数据源分两路。
   *
   * 短剧 / 漫剧走**红果 App 的榜单与最新上架**（与「更多」页同源、同一份首屏
   * 缓存）；18+ 没有对应的红果口径（那是本机侧"只启用成人源"的聚合概念），
   * 继续从本机启用源聚合出来的目录里切。
   *
   * 切出来那一套只服务神秘小窝；短剧/漫剧两栏不再碰 `visibleItems` —— 这也是
   * 用户报告"货架与它「更多」页内容对不上"的根源。
   */
  const feedShelves = shelfFeedSupports(channel);
  const showHomeSections = visibleItems.length >= 3;
  const hotItems = showHomeSections ? visibleItems.slice(0, 6) : [];
  const newItems = visibleItems.length >= 10 ? visibleItems.slice(6, 12) : [];
  const catalogStart = newItems.length > 0 ? 12 : showHomeSections ? 6 : 0;
  /**
   * 目录网格要不要让出前 12 条。
   *
   * 旧逻辑把这些条目藏起来，只因为"它们已经出现在货架上"；货架换成独立数据源后
   * 两者再无关系，继续让位等于**凭白吞掉 12 部剧**。
   */
  const catalogItems = feedShelves ? visibleItems : visibleItems.slice(catalogStart);

  /**
   * 「继续观看」与「猜你喜欢」并轨成同一栏的排布判定。
   *
   * `hasRandomCandidates` 用的是 `RandomWatchSection` 导出的**同一个筛选口径**，
   * 不是宿主自己再写一遍 `item.id && item.title`：口径一旦分叉，宿主会按"有内容"
   * 排成两列，而组件实际返回 `null`，结果「继续观看」孤零零占着半屏。
   *
   * 只剩一块时那一块独占整行——不为了对齐而留半屏空白。
   */
  const showContinueSlot = Boolean(continueWatching);
  const showRandomSlot = hasRandomCandidates(visibleItems);
  const mergedTwoColumns = showContinueSlot && showRandomSlot;

  /**
   * 进度条入场：从 0 长到真实进度，而不是一上来就杵在那儿。
   *
   * 两条约束必须守住：
   *   1. **用 transition，不用 keyframes。** 视图是常驻 DOM + `display:none` 的，
   *      在隐藏祖先里创建的 CSS animation 会永久卡在 0% 帧（见 `tailwind.config.js`
   *      里 `fluent-card-in` 那条长注释）。
   *   2. **先落回 0，隔一帧再抬起。** 同一批 state 更新会被 React 合并成一次渲染，
   *      合并后宽度根本没有"从 A 变到 B"的过程，过渡不会触发。
   *
   * 依赖里带 `currentView`：切回发现页时重放一次 —— 那才是用户真正看见它的时刻，
   * 而组件挂载时视图还是 `display:none`，那时跑动画等于白跑。
   */
  const [progressSettled, setProgressSettled] = useState(false);
  useEffect(() => {
    if (currentView !== 'explore' || !continueWatching) {
      setProgressSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setProgressSettled(true), 60);
    return () => window.clearTimeout(timer);
  }, [currentView, continueWatching?.updatedAt]);

  /**
   * 「继续观看」那一行的文案。
   *
   * `WatchHistoryItem` 里有四个字段一直是死的，这里把它们捡回来：
   *   - `totalEpisodes` → "共 86 集"。用户续播时最想知道的就是"还剩多少要看"，
   *     而原来只给了"看到第 12 集"，缺的正是分母；
   *   - `durationSeconds - positionSeconds` → "还剩 8 分 20 秒"。这是续播场景里
   *     唯一真正有用的数字，比"已看 42%"有用得多；
   *   - 原来那行 `已看 42%` 和下面的进度条**说的是同一件事**，纯冗余，删掉；
   *   - `isFinished` → 看完的剧不该再喊"断点续播"，那是"重新播放"。
   */
  const resume = (() => {
    if (!continueWatching) return null;
    const totalEpisodes = continueWatching.totalEpisodes || 0;
    const remaining = Math.max(
      0,
      (continueWatching.durationSeconds || 0) - (continueWatching.positionSeconds || 0),
    );
    return {
      episodeLabel: totalEpisodes > 0
        ? `第 ${continueWatching.episodeNumber} 集 · 共 ${totalEpisodes} 集`
        : `第 ${continueWatching.episodeNumber} 集`,
      remainingLabel: continueWatching.isFinished ? '已看完' : formatRemaining(remaining),
      actionLabel: continueWatching.isFinished ? '重新播放' : '断点续播',
    };
  })();

  /**
   * 首页「继续观看」那张卡的**预签名**。
   *
   * 为什么值得为它单独写一段：点击「继续观看」时前端会直接 openEpisode，
   * 而该集的整集下载要等 `resolve` 走完「两次 App API 往返 + 下载 + 解密」——
   * 实测 API 往返这一段固定 2.5 秒，占前缀通道总耗时的一半以上。
   *
   * 详情页那条路径有详情接口的往返时间可以打掩护（用户在看简介），首页这张卡
   * 是**从打开应用就一直在屏幕上的**，预热窗口有几分钟，比详情页更充分。
   *
   * `prefetchStream` 只做两次 API 往返、不下载任何媒体（几 KB），不会与首页的
   * 目录请求抢带宽；命中后点击时这一步直接跳过。动漫与 guo 源不走这条链路
   * （动漫有自己的解析、guo 是直链），所以先按 channel / id 前缀挡掉。
   */
  const warmResumeRef = useRef<string | null>(null);
  useEffect(() => {
    if (currentView !== 'explore' || !continueWatching) return;
    const item = continueWatching;
    // 动漫（dmghg / bfzy 前缀或 anime 频道）走 anime 分支的解析链路，预签名对它无意义。
    if (item.channel === 'anime') return;
    if (item.seriesId.startsWith('dmghg:') || item.seriesId.startsWith('bfzy:')) return;
    // 同一集只预热一次：continueWatching 会随进度更新而频繁变化，不设闸门会反复重发。
    const key = `${item.seriesId}:${item.episodeId}`;
    if (warmResumeRef.current === key) return;
    warmResumeRef.current = key;
    void ipcService.playback.prefetchStream([item.episodeId], 1);
  }, [currentView, continueWatching]);

  const handleRandomWatch = useCallback((series: SeriesItem, detail: SeriesDetail) => {
    const episode = detail.episodes.find(item => (item.watchedSeconds || 0) > 0 && !item.isFinished)
      || detail.episodes[0];
    if (!episode) return;
    if (detail.type === 'anime') {
      void openAnimeEpisode(detail.id, episode.id, episode.watchedSeconds || 0);
      return;
    }
    navigateTo('player', series.id);
    openEpisode(series.id, episode.id, episode.watchedSeconds || 0);
  }, [navigateTo, openAnimeEpisode, openEpisode]);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);

  /**
   * 补一次提交后的自检：卡片追加后如果哨兵**仍在**可视区，就直接再提交一页。
   *
   * IntersectionObserver 只在“穿过阀值”时回调，而提交追加的内容可能不足以把哨兵推出
   * rootMargin（典型：本轮只多出两三条，其余源都已到底）。这种情况下既不会产生新的
   * 交叉事件，`loadMore` 也不会自己再来一次 —— 表现为“滚到底停住了，再往上推一下
   * 才有反应”。真正无限流不能有这种一推一顿，所以按实际几何位置兜一次底。
   */
  useEffect(() => {
    if (!hasMore || isLoadingMore || items.length === 0) return;
    const sentinel = loadMoreSentinelRef.current;
    const root = scrollContainerRef.current;
    if (!sentinel || !root) return;
    if (sentinel.getBoundingClientRect().top - root.getBoundingClientRect().top <= root.clientHeight) {
      void loadMore('');
    }
  }, [hasMore, isLoadingMore, items.length, loadMore]);


  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    const root = scrollContainerRef.current;
if (!sentinel || !root || !hasMore) return;

    // 两条线，职责不同：
    // ① `prefetch` 哨兵离底部 800px 就触发，**不碰任何界面状态**——它只是把请求提前
    //    发出，让滚动不再等网络。store 里还有一条空闲预取做双保险，两者靠
    //    `beginFetch` 的"已有在途就复用同一个 Promise"天然幂等，不会重复打站方。
    // ② `commit` 哨兵在更靠近底部时才提交那一页；此时数据多数已在手，提交是同步的。
    //    所以底部提示条只在网络确实没赶上时闪一下，而不是每次滚动都停一下。
    //
    // 注意不再拿 isLoading / isLoadingMore 当守卫：它们进依赖会让 observer 随每次
    // 提交重建，而哨兵若仍在窗口内会立刻再触发一次，等于把提交时机交给重建节奏。
    // 单飞由 store 的 isLoadingMore 负责，这里不需要重复把关。
    const prefetchObserver = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) prefetchMore('');
      },
      { root, rootMargin: '800px 0px', threshold: 0 },
    );
    const commitObserver = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          void loadMore('');
        }
      },
      { root, rootMargin: '400px 0px', threshold: 0.01 },
    );
    prefetchObserver.observe(sentinel);
    commitObserver.observe(sentinel);
    return () => {
      prefetchObserver.disconnect();
      commitObserver.disconnect();
    };
  }, [hasMore, loadMore, prefetchMore]);


  return (
    <div ref={scrollContainerRef} className="relative flex-1 h-full overflow-y-auto p-5 flex flex-col gap-5 select-none" aria-busy={isLoading}>
      {isLoading && (
        <div className="pointer-events-none sticky top-0 z-30 -mb-5 h-0">
          <div className="relative h-0.5 w-full overflow-hidden rounded-full bg-blue-100/60">
            <div className="absolute inset-y-0 left-0 w-1/3 animate-[loading-progress_1.2s_ease-in-out_infinite] rounded-full bg-blue-500" />
          </div>
        </div>
      )}
      {/* 顶部：频道 Tab 与 核心筛选 */}
      <div className="flex flex-col gap-3.5">
        {/* 频道切换大药丸与排序 */}
        <div className="flex items-center justify-between flex-wrap gap-2.5">
          {/* 短剧 / 漫剧 Tab (嵌入式凹槽托盘) */}
          <div className="p-1 bg-slate-100/90 rounded-xl border border-slate-200/70 shadow-inner flex items-center gap-1">
            <button
              type="button"
              onClick={() => setChannel('drama')}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold transition-all duration-150 cursor-pointer ${
                channel === 'drama'
                  ? 'fluent-convex-tab text-blue-600'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
              }`}
            >
              <span>短剧专区</span>
            </button>
            <button
              type="button"
              onClick={() => setChannel('comic')}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold transition-all duration-150 cursor-pointer ${
                channel === 'comic'
                  ? 'fluent-convex-tab text-blue-600'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>漫剧次元</span>
            </button>
            {/* 神秘小窝：只在设置页打开 18+ 总开关后才出现，且**不留痕**——
                用户关掉开关时这个 tab 整体消失，而不是留在那儿点进去空空如也。
                它用玫红色而不是蓝色：这是与前两个专区语义完全不同的一类内容，
                颜色上就该一眼分得开。 */}
            {showAdultSources && (
              <button
                type="button"
                onClick={() => setChannel('adult')}
                className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold transition-all duration-150 cursor-pointer ${
                  channel === 'adult'
                    ? 'fluent-convex-tab text-rose-600'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
                }`}
              >
                <Moon className="w-3.5 h-3.5" />
                <span>神秘小窝</span>
              </button>
            )}
          </div>

          {/* 排序方式 (嵌入式凹槽托盘) */}
          <div className="p-1 bg-slate-100/90 rounded-xl border border-slate-200/70 shadow-inner flex items-center gap-1">
            <button
              type="button"
              onClick={() => setSort('recommend')}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs transition-all duration-150 cursor-pointer ${
                sort === 'recommend'
                  ? 'fluent-convex-tab text-blue-600 font-bold'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-white/50 font-medium'
              }`}
            >
              <Flame className="w-3 h-3" />
              <span>综合推荐</span>
            </button>
            <button
              type="button"
              onClick={() => setSort('latest')}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs transition-all duration-150 cursor-pointer ${
                sort === 'latest'
                  ? 'fluent-convex-tab text-blue-600 font-bold'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-white/50 font-medium'
              }`}
            >
              <Clock className="w-3 h-3" />
              <span>最新上线</span>
            </button>
            <button
              type="button"
              onClick={() => setSort('heat')}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs transition-all duration-150 cursor-pointer ${
                sort === 'heat'
                  ? 'fluent-convex-tab text-blue-600 font-bold'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-white/50 font-medium'
              }`}
            >
              <TrendingUp className="w-3 h-3" />
              <span>热度榜单</span>
            </button>
          </div>
        </div>

        {/* 题材筛选（站点官方题材；点击走服务端题材路由，结果完整可分页）
            容器/排序/溢出规则全部收口在 CategoryBar 里，见那里的注释。 */}
        <CategoryBar categories={categories} value={category} onChange={setCategory} />
      </div>

      {/*
        「继续观看」+「猜你喜欢」并轨成同一栏。

        这两块原本各占一整行：上面那条横幅右侧本来就是一大片空白，下面那个随机推荐
        又被压在 100px 的小条带里、封面只有 48×64、字号 10–11px。并轨后共用同一行
        高度——页面纵向预算不但没增加，还少了一个独立区段。

        两张卡共用 `PICK_CARD_SHELL`（从 `RandomWatchSection` 导出，见那里的注释），
        差异只允许留在配色：**蓝 = 进度语义，紫 = 随机语义**。左侧那条 3px 色标是
        并排时唯一需要被看见的区别，其余骨架逐字一致。

        这一轮去掉了两样东西：
          - **继续观看的叉号**。它是"可选横幅"时代的遗留 —— 现在这一行是页首固定的
            "为你"区，收起一张卡只会让另一张变宽，语义上不成立。
          - 外层的 `justify-between`。动作区靠 `flex-1` 的信息列自然顶到右边，不需要
            外层再分一次位置。

        窄窗口（<1180px）自动退回上下堆叠，信息层级与合并前一致。
      */}
      {(showContinueSlot || showRandomSlot) && (
        <div className={`grid shrink-0 grid-cols-1 gap-4 ${mergedTwoColumns ? 'min-[1180px]:grid-cols-2' : ''}`}>
          {showContinueSlot && continueWatching && resume && (
            <div
              onClick={() => {
                navigateTo('player', continueWatching.seriesId);
                openEpisode(continueWatching.seriesId, continueWatching.episodeId, continueWatching.positionSeconds);
              }}
              className={`${PICK_CARD_SHELL} cursor-pointer bg-gradient-to-r from-blue-50/80 via-white/92 to-white/88`}
            >
              {/* 左侧色标：与「猜你喜欢」的紫条对称，是并排时唯一允许存在的语义色差 */}
              <span aria-hidden="true" className="absolute inset-y-3 left-0 w-[3px] rounded-r-full bg-blue-500" />

              {/* 封面：严格 3:4（128×96），与「猜你喜欢」逐像素等高 */}
              <div className="relative h-32 w-24 shrink-0 overflow-hidden rounded-xl border border-white/90 bg-slate-100 shadow-xs">
                <CoverImage
                  src={continueWatching.seriesCover}
                  title={continueWatching.title}
                  placeholderTextClassName="text-2xl"
                  className="transition-transform duration-300 group-hover:scale-105"
                  loading="eager"
                />
                <div className="absolute inset-0 bg-black/10 transition-colors group-hover:bg-black/0" />
              </div>

              <div className="flex min-w-0 flex-1 flex-col justify-center gap-1.5">
                {/* `self-start`：徽章是 inline-flex，不给它定位就会被列方向拉伸成整条 */}
                <StatusBadge
                  label={continueWatching.isFinished ? '已看完' : '继续观看'}
                  variant="blue"
                  size="sm"
                  dot
                  className="self-start"
                />
                <span
                  className="truncate text-base font-extrabold tracking-tight text-slate-900"
                  title={continueWatching.title}
                >
                  {continueWatching.title}
                </span>
                <p className="truncate text-[11.5px] font-medium text-slate-500">
                  {resume.episodeLabel}
                </p>
                {/* 进度条宽度跟着并轨栏一起收放；右侧补上真正有用的那个数字。
                    宽度由 `progressSettled` 驱动做一次 0 → 真实值的入场，
                    所以这里给 700ms 而不是常用的 300ms。 */}
                <div className="mt-0.5 flex items-center gap-2.5">
                  <div className="h-1.5 min-w-0 max-w-[280px] flex-1 overflow-hidden rounded-full bg-slate-200/80 sm:max-w-[360px]">
                    <div
                      className="h-full rounded-full bg-blue-600 transition-all duration-700 ease-out"
                      style={{
                        width: progressSettled
                          ? `${Math.max(continueWatching.progressPercent || 0, continueWatching.positionSeconds > 0 ? 3 : 0)}%`
                          : '0%',
                      }}
                    />
                  </div>
                  {resume.remainingLabel ? (
                    <span className="shrink-0 text-[10.5px] font-semibold text-slate-400">
                      {resume.remainingLabel}
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="flex shrink-0 items-center">
                <FluentButton
                  variant="primary"
                  size="sm"
                  icon={<Play className="w-3.5 h-3.5 fill-current" />}
                  onClick={(e) => {
                    e.stopPropagation();
                    navigateTo('player', continueWatching.seriesId);
                    openEpisode(continueWatching.seriesId, continueWatching.episodeId, continueWatching.positionSeconds);
                  }}
                >
                  {resume.actionLabel}
                </FluentButton>
              </div>
            </div>
          )}

          {showRandomSlot && (
            <RandomWatchSection items={visibleItems} onWatch={handleRandomWatch} />
          )}
        </div>
      )}

      {/* 参考主流桌面播放器的内容货架：首屏先看热播，再接新剧，底部才进入完整目录。 */}
      {feedShelves ? (
        <>
          {/* 两栏直接吃红果 App 的榜单 / 最新上架（与各自「更多」页同源）。
              `key` 必须带 channel：换频道要整体重挂，否则会有一帧显示上一频道的
              内容（`useShelfFeed` 的状态只随挂载初始化）。 */}
          <HomeShelfSection
            key={`hot-${channel}`}
            kind="hot"
            channel={channel}
            title="正在热播"
            subtitle={`红果热播榜 · ${CHANNEL_COPY[channel].noun}`}
            onMore={() => handleShelfMore('hot')}
            onClick={handleCardClick}
          />

          <HomeShelfSection
            key={`new-${channel}`}
            kind="new"
            channel={channel}
            title="新剧"
            subtitle={`红果最新上架 · ${CHANNEL_COPY[channel].noun}`}
            accent="blue"
            onMore={() => handleShelfMore('new')}
            onClick={handleCardClick}
          />
        </>
      ) : (
        <>
          {/* 神秘小窝：红果 App 接口没有 18+ 口径，仍从本机启用源聚合出来的目录切。 */}
          <HomeShelf
            title="正在热播"
            subtitle={`当前专区热度靠前的${CHANNEL_COPY[channel].noun}`}
            items={hotItems}
            onClick={handleCardClick}
            onUnavailable={markSeriesUnavailable}
            onMore={() => handleShelfMore('hot')}
          />

          <HomeShelf
            title="新剧"
            subtitle="最近加入的内容"
            items={newItems}
            onClick={handleCardClick}
            onUnavailable={markSeriesUnavailable}
            onMore={() => handleShelfMore('new')}
            accent="blue"
          />
        </>
      )}

      {/* 剧集目录网格 (更舒展大气的卡片尺寸：4~6列排布) */}
      <div className="flex flex-col gap-3">
        <div className={`flex items-center justify-between ${showHomeSections && catalogItems.length === 0 ? 'hidden' : ''}`}>
          <h2 className="text-sm font-bold text-slate-800 flex items-center gap-1.5">
            <span>发现更多{CHANNEL_COPY[channel].noun}</span>
            <span className="text-xs font-normal text-slate-400">({catalogItems.length} 部)</span>
          </h2>
          <span className="text-[11px] text-slate-400">向下滚动自动加载</span>
        </div>

        {/* 骨架屏加载态 (保持相同舒适比例) */}
        {isLoading && items.length === 0 ? (
          <div className={SERIES_GRID_CLASS}>
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-2">
                <div className="w-full aspect-[3/4] rounded-2xl shimmer-loading shadow-xs" />
                <div className="h-4 w-3/4 rounded shimmer-loading" />
                <div className="h-3.5 w-1/2 rounded shimmer-loading" />
              </div>
            ))}
          </div>
        ) : error && items.length === 0 ? (
          <div className="py-20 flex flex-col items-center justify-center text-center gap-3">
            <p className="text-sm font-medium text-slate-600">目录加载失败</p>
            {/* 真实原因必须露出来。原来只有上面那一行通用文案，用户截图里只剩
                "目录加载失败"四个字 —— 到底是源全挂了、超时、还是命令不存在，
                一个都分不出来，只能靠猜。 */}
            <p className="text-xs text-slate-400 max-w-lg leading-relaxed break-words">{error}</p>
            <FluentButton size="sm" onClick={() => refreshCatalog('')}>重试</FluentButton>
          </div>
        ) : items.length === 0 ? (
          /* 空结果态 */
          <div className="py-20 flex flex-col items-center justify-center text-center gap-3">
            <img src="/app-icon.png" alt="" className="w-12 h-12 object-contain opacity-60" draggable={false} />
            {channel === 'adult' ? (
              <>
                <p className="text-sm font-medium text-slate-600">还没有勾选成人内容源</p>
                <p className="text-xs text-slate-400">到「系统设置 → 视频源 → 18+ 成人内容」里勾选，这里就会出现内容</p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-slate-600">没有找到匹配的{CHANNEL_COPY[channel].noun}</p>
                <p className="text-xs text-slate-400">尝试更换关键词或分类筛选项</p>
              </>
            )}
          </div>
        ) : (
          /* 舒展大气的剧集卡片网格 (带级联入场动画与平滑交互) */
          <>
          {isLoading && (
            <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold text-blue-600">
              <span className="w-3 h-3 rounded-full border-2 border-blue-500/25 border-t-blue-600 animate-spin" />
              <span>正在切换，卡片马上回来…</span>
            </div>
          )}
          {/* 切换题材/排序时保留旧卡片并压暗：清空会让整页闪白，而单纯保留旧
              内容又会让用户以为"点了没反应"（旧实现只挂一行 11px 小字，几乎
              看不见）。压暗 + 屏蔽点击同时表达"正在加载"和"这张卡不再属于
              当前筛选"，避免用户点进一个已经不属于该题材的剧。 */}
          <div className={`${SERIES_GRID_CLASS} transition-opacity duration-150 ${
            isLoading ? 'opacity-40 saturate-50 pointer-events-none' : ''
          }`}>
            {catalogItems.map((series, index) => (
              <SeriesCard
                key={series.id}
                series={series}
                index={index}
                onClick={handleCardClick}
                onUnavailable={markSeriesUnavailable}
                onPrefetch={handleCardPrefetch}
              />
            ))}
          </div>
          </>
        )}

        <div ref={loadMoreSentinelRef} className="min-h-12 flex items-center justify-center pt-1" aria-live="polite">
          {isLoadingMore && (
            <div className="px-4 py-2 rounded-xl bg-white/70 border border-slate-200/70 text-xs text-slate-500 shadow-xs">
              正在加载更多内容…
            </div>
          )}
          {!hasMore && items.length > 0 && (
            error ? (
              // 翻页连续失败后熔断（见 loadMoreFailuresRef）会走到这里：光写
              // “已加载全部”是撒谎，必须把重试入口给回用户。
              <button
                type="button"
                onClick={() => { void refreshCatalog(''); }}
                className="px-3 py-1.5 rounded-xl bg-white/70 border border-slate-200/70 text-xs text-slate-500 shadow-xs hover:text-slate-700 hover:bg-white cursor-pointer"
              >
                加载更多失败，点此重试
              </button>
            ) : (
              <span className="text-[11px] text-slate-400">已加载全部公开内容</span>
            )
          )}
        </div>
      </div>

      {/* 回到顶部：滚过阈值才出现。作为滚动容器的最后一个粘性子元素，不占独立行高。 */}
      <BackToTop targetRef={scrollContainerRef} />
    </div>
  );
};
