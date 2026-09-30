import React, { useState, useEffect, useRef } from 'react';
import { useCatalogStore } from '../../stores/useCatalogStore';
import { useAppStore } from '../../stores/useAppStore';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { StatusBadge } from '../common/StatusBadge';
import { FluentButton } from '../common/FluentButton';
import { CoverImage } from '../common/CoverImage';
import { SeriesCard, SERIES_GRID_CLASS } from '../common/SeriesCard';
import {
  Flame,
  Sparkles,
  Play,
  TrendingUp,
  Clock,
  Moon,
  X
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
    refreshContinueWatching,
  } = useCatalogStore();

  const { currentView, navigateTo, triggerCardTransition } = useAppStore();
  const { openEpisode } = usePlaybackStore();
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

  // 允许用户点击叉号隐藏继续观看条，卡片自动顶上去
  const [isContinueDismissed, setIsContinueDismissed] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

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

  const markSeriesUnavailable = (seriesId: string) => {
    setHiddenSeriesIds(prev => {
      if (prev.has(seriesId)) return prev;
      const next = new Set(prev);
      next.add(seriesId);
      return next;
    });
  };

  /**
   * 实际展示的卡片：无封面地址的条目直接过滤（guo 源的封面不来自该字段，
   * 走 CoverImage 的异步解析，不过滤）；加载失败的按 id 移除。
   */
  const visibleItems = items.filter(item => {
    if (hiddenSeriesIds.has(item.id)) return false;
    if (!item.id.startsWith('guo:') && !(item.cover || '').trim()) return false;
    return true;
  });
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const searchReadyRef = useRef(false);
  const refreshCatalogRef = useRef(refreshCatalog);
  refreshCatalogRef.current = refreshCatalog;

  // 响应全局搜索关键词
  useEffect(() => {
    if (!searchReadyRef.current) {
      searchReadyRef.current = true;
      return;
    }
    void refreshCatalogRef.current('');
  }, []);

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    const root = scrollContainerRef.current;
    if (!sentinel || !root || !hasMore || isLoading || isLoadingMore) return;

    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          void loadMore('');
        }
      },
      // rootMargin 从 640px 放宽到 1200px：首屏一页只有 24 条，640px 的
      // 预加载窗口在卡片较高的布局里不够——用户中速滚动就会在请求回来前
      // 滚到底（实测表现为"滚到底才开始加载"）。1200px 约等于提前两屏。
      { root, rootMargin: '1200px 0px', threshold: 0.01 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, isLoading, isLoadingMore, loadMore]);


  return (
    <div ref={scrollContainerRef} className="flex-1 h-full overflow-y-auto p-5 flex flex-col gap-5 select-none">
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

        {/* 题材分类标签栏（站点官方题材；点击走服务端题材路由，结果完整可分页） */}
        <div className="flex flex-col gap-2 p-2.5 bg-slate-100/80 rounded-2xl border border-slate-200/70 shadow-inner">
          {/* 题材分类 */}
          <div className="flex items-center gap-1.5 flex-wrap text-xs">
            <span className="text-slate-400 font-semibold mr-1 text-[11px]">题材:</span>
            <div className="p-0.5 bg-white/60 rounded-xl border border-slate-200/60 shadow-inner flex items-center gap-1 flex-wrap">
              {categories.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategory(cat)}
                  className={`px-2.5 py-1 rounded-lg transition-all text-xs cursor-pointer ${
                    category === cat
                      ? 'fluent-convex-tab text-blue-600 font-bold'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

        </div>
      </div>

      {/* “继续观看”智能断点推荐横幅 (凸起悬浮质感磨砂浮岛，支持点击叉号关闭隐藏) */}
      {!isContinueDismissed && continueWatching && (
        <div 
          onClick={() => {
            navigateTo('player', continueWatching.seriesId);
            openEpisode(continueWatching.seriesId, continueWatching.episodeId, continueWatching.positionSeconds);
          }}
          className="relative min-h-[78px] overflow-hidden rounded-2xl border border-white/90 bg-gradient-to-r from-blue-50/70 via-white/85 to-indigo-50/60 p-3 shadow-fluent-lg fluent-raised-island flex items-center justify-between gap-4 transition-all duration-300 hover:-translate-y-0.5 animate-fluent-card-in cursor-pointer group"
        >
          <div className="flex items-center gap-3.5 min-w-0">
            {/* 核心海报：3:4 黄金竖屏比例 (48px x 64px 固定尺寸，坚决防止压缩变形) */}
            <div className="relative w-12 h-16 rounded-xl overflow-hidden shadow-xs flex-shrink-0 border border-white/90 bg-slate-100">
              <CoverImage
                src={continueWatching.seriesCover}
                title={continueWatching.title}
                placeholderTextClassName="text-base"
                className="group-hover:scale-105 transition-transform duration-300"
                loading="eager"
              />
              <div className="absolute inset-0 bg-black/10 group-hover:bg-black/0 transition-colors" />
            </div>

            <div className="flex flex-col justify-center gap-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap min-w-0">
                <StatusBadge label="继续观看" variant="blue" size="sm" dot />
                <span className="text-xs sm:text-sm font-bold text-slate-800 truncate max-w-xs sm:max-w-md md:max-w-lg" title={continueWatching.title}>
                  {continueWatching.title}
                </span>
              </div>
              <p className="text-[11px] text-slate-500 font-medium">
                看到第 {continueWatching.episodeNumber} 集 · 已看 {continueWatching.progressPercent || 0}%
              </p>
              {/* 进度条 */}
              <div className="w-36 sm:w-52 h-1.5 bg-slate-200/80 rounded-full overflow-hidden mt-0.5">
                <div
                  className="h-full bg-blue-600 rounded-full transition-all duration-300"
                  style={{ width: `${Math.max(continueWatching.progressPercent || 0, continueWatching.positionSeconds > 0 ? 3 : 0)}%` }}
                />
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
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
              断点续播
            </FluentButton>

            {/* 点击叉号关闭隐藏横幅，随后下方卡片区域自动顶上去 */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setIsContinueDismissed(true);
              }}
              className="w-8 h-8 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 flex items-center justify-center transition-colors cursor-pointer active:scale-90"
              title="隐藏此条推荐"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* 剧集目录网格 (更舒展大气的卡片尺寸：4~6列排布) */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-800 flex items-center gap-1.5">
            <span>{CHANNEL_COPY[channel].title}</span>
            <span className="text-xs font-normal text-slate-400">({visibleItems.length} 部)</span>
          </h2>
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
            {visibleItems.map((series, index) => (
              <SeriesCard
                key={series.id}
                series={series}
                index={index}
                onClick={() => {
                  navigateTo('detail', series.id);
                }}
                onUnavailable={() => markSeriesUnavailable(series.id)}
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
            <span className="text-[11px] text-slate-400">已加载全部公开内容</span>
          )}
        </div>
      </div>
    </div>
  );
};
