import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { MicaCard } from '../common/MicaCard';
import { ipcService } from '../../services/ipc';
import type { SeriesItem } from '../../types/catalog';
import { Clapperboard, Play, Star, RefreshCw, Tv } from 'lucide-react';

const PAGE_SIZE = 30;

/**
 * 动漫专区：独立数据源（暴风资源）+ 独立筛选状态。
 *
 * 与短剧 explore 不同源，不复用 useCatalogStore（那个 store 的缓存键、
 * 分类联动与红果频道切换深度耦合）；这里自带轻量分页与缓存，逻辑独立。
 */
export const AnimeView: React.FC = () => {
  const { navigateTo } = useAppStore();

  const [category, setCategory] = useState('全部');
  // 分类芯片用后端返回的真实分类（dmghg 与暴风的分类名不同），
  // 这里只是首帧渲染前的占位。
  const [categories, setCategories] = useState<string[]>([
    '全部',
    '国产动漫',
    '日韩动漫',
    '欧美动漫',
    '港台动漫',
    '海外动漫',
    '动画片',
  ]);
  const [items, setItems] = useState<SeriesItem[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cacheRef = useRef<Record<string, { items: SeriesItem[]; hasMore: boolean; page: number }>>({});
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const requestIdRef = useRef(0);
  const pageRef = useRef(1);
  pageRef.current = page;
  const loadingRef = useRef(false);

  const loadPage = useCallback(async (targetPage: number, cat: string, append: boolean) => {
    const cacheKey = `anime_${cat}_${targetPage}`;
    const cached = cacheRef.current[cacheKey];
    if (cached) {
      setItems(prev => (append ? [...prev, ...cached.items] : cached.items));
      setHasMore(cached.hasMore);
      setIsLoading(false);
      setIsLoadingMore(false);
      return;
    }
    if (append) setIsLoadingMore(true);
    else setIsLoading(true);
    setError(null);
    const requestId = ++requestIdRef.current;
    try {
      const res = await ipcService.catalog.list({
        channel: 'anime',
        category: cat,
        audience: '全部',
        sort: 'recommend',
        page: targetPage,
        pageSize: PAGE_SIZE,
        cursor: targetPage > 1 ? String(targetPage) : undefined,
      });
      if (requestId !== requestIdRef.current) return;
      cacheRef.current[cacheKey] = { items: res.items, hasMore: res.hasMore, page: targetPage };
      setItems(prev => (append ? [...prev, ...res.items] : res.items));
      setHasMore(res.hasMore);
      const nextCategories = res.categories ?? [];
      if (nextCategories.length > 0) {
        setCategories(nextCategories);
        // 换源后旧分类名可能已不存在，回落到「全部」。
        if (!nextCategories.includes(cat)) setCategory('全部');
      }
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    }
  }, []);

  // 首次进入与切换分类
  useEffect(() => {
    void loadPage(1, category, false);
  }, [category, loadPage]);

  // 无限滚动
  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    const root = scrollContainerRef.current;
    if (!sentinel || !root || !hasMore || isLoading || isLoadingMore) return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          void loadPage(pageRef.current + 1, category, true).then(() => {
            setPage(prev => prev + 1);
          });
        }
      },
      { root, rootMargin: '1200px 0px', threshold: 0.01 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, isLoading, isLoadingMore, category, loadPage]);


  return (
    <div ref={scrollContainerRef} className="flex-1 h-full overflow-y-auto p-5 flex flex-col gap-5 select-none">
      {/* 顶部：标题 + 分类筛选 */}
      <div className="flex flex-col gap-3.5">
        <div className="flex items-center justify-between flex-wrap gap-2.5">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl bg-violet-100 text-violet-600 border border-violet-200/60 flex items-center justify-center">
              <Clapperboard className="w-4.5 h-4.5" />
            </div>
            <div>
              <h1 className="text-base font-bold text-slate-800 leading-tight">动漫专区</h1>
              <p className="text-[11px] text-slate-400 font-medium">免登录直连 · 本地高速播放</p>
            </div>
          </div>

          {/* 分类筛选（嵌入式凹槽托盘） */}
          <div className="p-1 bg-slate-100/90 rounded-xl border border-slate-200/70 shadow-inner flex items-center gap-1 flex-wrap">
            {categories.map(cat => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory(cat)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all duration-150 cursor-pointer ${
                  category === cat
                    ? 'fluent-convex-tab text-violet-600'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 动漫卡片网格 */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-800 flex items-center gap-1.5">
            <Tv className="w-4 h-4 text-violet-500" />
            <span>{category === '全部' ? '精选动漫推荐' : category}</span>
            <span className="text-xs font-normal text-slate-400">({items.length} 部)</span>
          </h2>
          {error && (
            <button
              type="button"
              onClick={() => void loadPage(pageRef.current, category, false)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-black/[0.04] transition-colors cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              重试
            </button>
          )}
        </div>

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
            <p className="text-sm font-medium text-slate-600">动漫目录加载失败：{error}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="py-20 flex flex-col items-center justify-center text-center gap-3">
            <img src="/app-icon.png" alt="" className="w-12 h-12 object-contain opacity-60" draggable={false} />
            <p className="text-sm font-medium text-slate-600">该分类下暂时没有动漫</p>
            <p className="text-xs text-slate-400">尝试切换其他分类</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4 sm:gap-4.5">
            {items.map((series, index) => (
              <MicaCard
                key={`${series.id}-${index}`}
                hoverable
                onClick={() => {
                  // 动漫卡片点击直接进入播放（免登录直连）：详情页用于看简介与选集，
                  // 但动漫源选集数据同在详情里，先走 detail 保持一致的导航体验。
                  navigateTo('detail', series.id);
                }}
                className="group flex flex-col cursor-pointer animate-fluent-card-in active:scale-95 transition-transform rounded-2xl"
                style={{ animationDelay: `${Math.min(index * 20, 240)}ms` }}
              >
                <div className="relative w-full aspect-[3/4] overflow-hidden bg-slate-100 rounded-t-2xl">
                  <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-violet-50 to-slate-200">
                    <span className="text-3xl font-bold text-slate-300 select-none">
                      {(series.title || '漫').trim().slice(0, 1)}
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

                  {/* 顶部分类标签 */}
                  <div className="absolute top-2 left-2 flex gap-1">
                    <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-violet-600/95 text-white shadow-xs">
                      {series.tags[0] || '动漫'}
                    </span>
                  </div>

                  {/* 悬停快捷播放 */}
                  <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-200 bg-black/20">
                    <div className="w-11 h-11 rounded-full fluent-convex-disc text-white flex items-center justify-center shadow-lg transform scale-75 group-hover:scale-100 transition-all duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)]">
                      <Play className="w-5 h-5 fill-current ml-0.5" />
                    </div>
                  </div>

                  {/* 底部集数与来源：remarks 无数字（如"已完结"）时显示原文 */}
                  <div className="absolute bottom-2 inset-x-2 flex items-center justify-between text-[11px] text-white/95">
                    {series.episodesCount > 0 ? (
                      <span className="font-semibold">{series.latestEpisodeTitle || `${series.episodesCount} 集`}</span>
                    ) : series.brief ? (
                      <span className="font-semibold text-white/80">{series.brief}</span>
                    ) : (
                      <span className="font-semibold text-white/60">集数未知</span>
                    )}
                    <span className="text-[10px] text-white/75 truncate max-w-[80px]">{series.origin}</span>
                  </div>
                </div>

                <div className="p-3 flex flex-col gap-1">
                  <h3 className="text-xs sm:text-sm font-bold text-slate-800 truncate group-hover:text-violet-600 transition-colors duration-150">
                    {series.title}
                  </h3>
                  <div className="flex items-center gap-1.5 text-[11px] text-slate-400 truncate">
                    <span>{series.tags.slice(1, 3).join(' · ') || '动漫'}</span>
                  </div>
                </div>
              </MicaCard>
            ))}
          </div>
        )}

        <div ref={loadMoreSentinelRef} className="min-h-12 flex items-center justify-center pt-1" aria-live="polite">
          {isLoadingMore && (
            <div className="px-4 py-2 rounded-xl bg-white/70 border border-slate-200/70 text-xs text-slate-500 shadow-xs">
              正在加载更多动漫…
            </div>
          )}
          {!hasMore && items.length > 0 && (
            <span className="text-[11px] text-slate-400">已加载全部动漫内容</span>
          )}
        </div>
      </div>
    </div>
  );
};
