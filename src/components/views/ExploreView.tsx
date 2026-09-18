import React, { useState, useEffect, useRef } from 'react';
import { useCatalogStore } from '../../stores/useCatalogStore';
import { useAppStore } from '../../stores/useAppStore';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { MicaCard } from '../common/MicaCard';
import { StatusBadge } from '../common/StatusBadge';
import { FluentButton } from '../common/FluentButton';
import {
  Flame,
  Sparkles,
  Play,
  TrendingUp,
  Clock,
  Star,
  X
} from 'lucide-react';

export const ExploreView: React.FC = () => {
  const {
    channel,
    category,
    sort,
    categories,
    items,
    continueWatching,
    isLoading,
    isLoadingMore,
    hasMore,
    error,
    setChannel,
    setCategory,
    setSort,
    refreshCatalog,
    loadMore,
    refreshContinueWatching,
  } = useCatalogStore();

  const { currentView, navigateTo, triggerCardTransition } = useAppStore();
  const { openEpisode } = usePlaybackStore();

  // 回到发现页就刷新"继续观看"：横幅的数据来自历史记录，而目录本身不会因为
  // 看了几集而变化，不单独刷新就会一直停在启动那一刻的旧进度。
  useEffect(() => {
    if (currentView === 'explore') void refreshContinueWatching();
  }, [currentView, refreshContinueWatching]);

  // 允许用户点击叉号隐藏继续观看条，卡片自动顶上去
  const [isContinueDismissed, setIsContinueDismissed] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
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
              <img
                src={continueWatching.seriesCover}
                alt={continueWatching.title}
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                onError={(e) => {
                  (e.target as HTMLElement).style.display = 'none';
                }}
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
            <span>{channel === 'comic' ? '精选漫剧推荐' : '精选短剧推荐'}</span>
            <span className="text-xs font-normal text-slate-400">({items.length} 部)</span>
          </h2>
        </div>

        {/* 骨架屏加载态 (保持相同舒适比例) */}
        {isLoading && items.length === 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4 sm:gap-4.5">
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
            <p className="text-sm font-medium text-slate-600">没有找到匹配的{channel === 'comic' ? '漫剧' : '短剧'}</p>
            <p className="text-xs text-slate-400">尝试更换关键词或分类筛选项</p>
          </div>
        ) : (
          /* 舒展大气的剧集卡片网格 (带级联入场动画与平滑交互) */
          <>
          {isLoading && <div className="mb-2 text-[11px] text-slate-400">正在更新目录…</div>}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4 sm:gap-4.5">
            {items.map((series, index) => (
              <MicaCard
                key={series.id}
                hoverable
                onClick={() => {
                  navigateTo('detail', series.id);
                }}
                className="group flex flex-col cursor-pointer animate-fluent-card-in active:scale-95 transition-transform rounded-2xl"
                style={{ animationDelay: `${Math.min(index * 20, 240)}ms` }}
              >
                {/* 海报封面 (3:4 黄金竖屏比例) */}
                <div className="relative w-full aspect-[3/4] overflow-hidden bg-slate-100 rounded-t-2xl">
                  {/* 封面缺失时露出剧名首字，而不是留一个空框。
                      App 联想结果里有部分条目不带封面（其 video_data 为空），
                      onError 也统一走这里——图片 403/超时同样会退回占位。 */}
                  <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200">
                    <span className="text-3xl font-bold text-slate-300 select-none">
                      {(series.title || '剧').trim().slice(0, 1)}
                    </span>
                  </div>
                  <img
                    src={series.cover}
                    alt={series.title}
                    className="relative w-full h-full object-cover transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-108"
                    loading={index < 8 ? 'eager' : 'lazy'}
                    decoding="async"
                    fetchPriority={index < 4 ? 'high' : 'auto'}
                    onError={(event) => {
                      // 封面加载失败重试一次（带 cache-bust）：CDN 抖动一次就
                      // 让图永久消失等于"封面下载不出来"，仍失败才退回首字占位。
                      const img = event.currentTarget;
                      const retried = img.dataset.retried === '1';
                      if (!retried && series.cover) {
                        img.dataset.retried = '1';
                        img.src = `${series.cover}${series.cover.includes('?') ? '&' : '?'}r=1`;
                        return;
                      }
                      img.style.opacity = '0';
                    }}
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-transparent to-transparent opacity-80 group-hover:opacity-95 transition-opacity duration-300" />

                  {/* 顶部标签 */}
                  <div className="absolute top-2 left-2 flex gap-1">
                    <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-blue-600/95 text-white shadow-xs">
                      {series.tags[0] || '热门'}
                    </span>
                  </div>

                  {/* 评分角标 */}
                  {series.rating && (
                    <div className="absolute top-2 right-2 flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-black/65 text-amber-300">
                      <Star className="w-2.5 h-2.5 fill-current" />
                      <span>{series.rating.toFixed(1)}</span>
                    </div>
                  )}

                  {/* 底部集数与来源 */}
                  <div className="absolute bottom-2 inset-x-2 flex items-center justify-between text-[11px] text-white/95">
                    {series.episodesCount > 0 ? (
                      <span className="font-semibold">{series.episodesCount} 集全</span>
                    ) : (
                      <span className="font-semibold text-white/60">集数未知</span>
                    )}
                    <span className="text-[10px] text-white/75 truncate max-w-[80px]">{series.origin}</span>
                  </div>

                  {/* 悬停快捷播放图标 (实体凸出的立体浮雕圆盘) */}
                  <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-200 bg-black/20">
                    <div className="w-11 h-11 rounded-full fluent-convex-disc text-white flex items-center justify-center shadow-lg transform scale-75 group-hover:scale-100 transition-all duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)]">
                      <Play className="w-5 h-5 fill-current ml-0.5" />
                    </div>
                  </div>
                </div>

                {/* 卡片下半部元信息 (舒适舒展排版) */}
                <div className="p-3 flex flex-col gap-1">
                  <h3 className="text-xs sm:text-sm font-bold text-slate-800 truncate group-hover:text-blue-600 transition-colors duration-150">
                    {series.title}
                  </h3>
                  <div className="flex items-center gap-1.5 text-[11px] text-slate-400 truncate">
                    <span>{series.tags.slice(1, 3).join(' · ') || (series.type === 'drama' ? '精品短剧' : '精选漫剧')}</span>
                  </div>
                </div>
              </MicaCard>
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
