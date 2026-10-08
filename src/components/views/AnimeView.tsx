import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { ipcService } from '../../services/ipc';
import type { SeriesItem } from '../../types/catalog';
import { Clapperboard, RefreshCw, Tv, ChevronDown, ChevronUp } from 'lucide-react';
import { SeriesCard, SERIES_GRID_CLASS } from '../common/SeriesCard';
import { BackToTop } from '../common/BackToTop';

const PAGE_SIZE = 30;

/**
 * 动漫专区：独立数据源（暴风资源）+ 独立筛选状态。
 *
 * 与短剧 explore 不同源，不复用 useCatalogStore（那个 store 的缓存键、
 * 分类联动与红果频道切换深度耦合）；这里自带轻量分页与缓存，逻辑独立。
 */
export const AnimeView: React.FC = () => {
  const { navigateTo, currentView } = useAppStore();

  /**
   * 全部卡片共用这一个点击回调（卡片自己带上 seriesId）。
   *
   * 必须是稳定的 `useCallback`：否则每张卡的内联箭头函数都会让 `SeriesCard` 的
   * `React.memo` 失效，上百张卡全量重渲染。`navigateTo` 在 useAppStore 里已稳定。
   */
  const handleCardClick = useCallback((seriesId: string) => {
    // 动漫卡片点击直接进入播放（免登录直连）：详情页用于看简介与选集，
    // 但动漫源选集数据同在详情里，先走 detail 保持一致的导航体验。
    navigateTo('detail', seriesId);
  }, [navigateTo]);

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
  const [showAllCategories, setShowAllCategories] = useState(false);
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

  /*
    首次**进入本页**与切换分类时才取数。

    历史：这个 effect 只依赖 `[category, loadPage]`，而本视图是**常驻 DOM**
    （切换视图只切 hidden，不卸载），于是它在**应用启动那一刻**就会发一次动漫
    目录请求——即使用户根本没打算看动漫。冷启动本来就有设置/收藏/历史/红果目录
    四条 IPC 在抢窗口，再叠一条跨进程 FFI 的动漫目录，首屏可用时间被白白推后。

    加上 currentView 守卫之后：只在真的停在动漫页时才拉；从别的页面切回来时
    currentView 变化会重新触发一次（`loadPage` 自带 `anime_${cat}_${page}` 缓存，
    命中即同步返回，所以来回切页面不会产生重复请求）。
  */
  useEffect(() => {
    if (currentView !== 'anime') return;
    void loadPage(1, category, false);
  }, [currentView, category, loadPage]);

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
    <div ref={scrollContainerRef} className="relative flex-1 h-full overflow-y-auto p-5 flex flex-col gap-5 select-none" aria-busy={isLoading}>
      {isLoading && (
        <div className="pointer-events-none sticky top-0 z-30 -mb-5 h-0">
          <div className="relative h-0.5 w-full overflow-hidden rounded-full bg-violet-100/70">
            <div className="absolute inset-y-0 left-0 w-1/3 animate-[loading-progress_1.2s_ease-in-out_infinite] rounded-full bg-violet-500" />
          </div>
        </div>
      )}
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
          <div className="flex min-w-0 max-w-full items-center gap-1 overflow-hidden rounded-xl border border-slate-200/70 bg-slate-100/90 p-1 shadow-inner">
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {(showAllCategories ? categories : categories.slice(0, 8)).map(cat => (
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
            {categories.length > 8 && (
              <button
                type="button"
                onClick={() => setShowAllCategories(value => !value)}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border-l border-slate-200/70 bg-white/75 px-2 text-[11px] font-semibold text-slate-500 hover:text-violet-600"
                title={showAllCategories ? '收起分类' : '查看全部分类'}
              >
                {showAllCategories ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                {showAllCategories ? '收起' : `更多 ${categories.length - 8}`}
              </button>
            )}
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
            <p className="text-sm font-medium text-slate-600">动漫目录加载失败：{error}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="py-20 flex flex-col items-center justify-center text-center gap-3">
            <img src="/app-icon.png" alt="" className="w-12 h-12 object-contain opacity-60" draggable={false} />
            <p className="text-sm font-medium text-slate-600">该分类下暂时没有动漫</p>
            <p className="text-xs text-slate-400">尝试切换其他分类</p>
          </div>
        ) : (
          <div className={SERIES_GRID_CLASS}>
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

      {/* 回到顶部：滚过阈值才出现。作为滚动容器的最后一个粘性子元素，不占独立行高。 */}
      <BackToTop targetRef={scrollContainerRef} />
    </div>
  );
};
