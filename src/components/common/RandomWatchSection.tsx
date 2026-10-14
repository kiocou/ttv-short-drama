import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Flame,
  Info,
  Layers3,
  Play,
  RefreshCw,
  Sparkles,
  Star,
} from 'lucide-react';
import { ipcService } from '../../services/ipc';
import {
  formatHeatValue,
  getSeriesTeaser,
  pickDiversifiedBatch,
} from '../../services/randomPick';
import { SeriesDetail } from '../../types/series';
import { SeriesItem } from '../../types/catalog';
import { CoverImage } from './CoverImage';
import { FluentButton } from './FluentButton';
import { StatusBadge } from './StatusBadge';

/**
 * 「继续观看」与「猜你喜欢」并轨双卡的共用外壳基础类名。
 */
export const PICK_CARD_SHELL =
  'group relative flex min-h-[156px] items-center gap-4 overflow-hidden rounded-2xl border border-white/90 p-3.5 shadow-fluent-lg fluent-raised-island transition-all duration-300 hover:-translate-y-0.5 animate-fluent-card-in';

interface RandomWatchSectionProps {
  items: SeriesItem[];
  onWatch: (series: SeriesItem, detail: SeriesDetail) => void;
  onDetail?: (seriesId: string) => void;
  /**
   * 已看过的剧集 id（历史记录）。
   */
  excludeIds?: ReadonlySet<string>;
  /**
   * 是否与「继续观看」并排处于半宽两列模式。
   */
  isMerged?: boolean;
  className?: string;
}

/**
 * 筛选口径判定，供宿主判断是否渲染
 */
export function hasRandomCandidates(items: SeriesItem[], excludeIds?: ReadonlySet<string>): boolean {
  return items.some(item => Boolean(item.id && item.title) && !excludeIds?.has(item.id));
}

/**
 * 「猜你喜欢」推荐组件。
 *
 * 核心升级与重构点：
 * 1. 刷新卡片加载动效：点击「换一批」时呈现卡片骨架微光加载动效，杜绝直接生硬出卡的单调感；
 * 2. 空间合理化：独占全宽时展示「主推大卡 + 备选精选矩阵」，多部不同题材短剧一目了然，消灭空白；
 * 3. 专注当前任务：仅在用户主动点击「立即观看」时按需加载详情，不做其他任何额外的后台预取；
 * 4. 纯净推荐：去除生硬的特定标签分组，回归自然纯粹的智能多元化推选；
 * 5. 丰富内容表达：动态提炼高光看点，杜绝“热度未提供”与“打开详情查看简介”等干瘪文案。
 */
export const RandomWatchSection: React.FC<RandomWatchSectionProps> = ({
  items,
  onWatch,
  onDetail,
  excludeIds,
  isMerged = false,
  className = '',
}) => {
  const candidates = useMemo(
    () => items.filter(item => item.id && item.title && !excludeIds?.has(item.id)),
    [items, excludeIds],
  );

  const [hero, setHero] = useState<SeriesItem | null>(null);
  const [deck, setDeck] = useState<SeriesItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isCardSwitching, setIsCardSwitching] = useState(false);
  const [error, setError] = useState(false);

  /** 本轮已展示过的候选池 */
  const shownIdsRef = useRef<Set<string>>(new Set());
  /** 最新选中的主推 id，用于请求归属校验 */
  const selectedIdRef = useRef<string | null>(null);
  /** 刷新动效定时器引用，防止卸载后泄露 */
  const refreshTimerRef = useRef<number | null>(null);

  /**
   * 刷新当前批次：带有平滑的骨架微光动效过渡
   */
  const refreshBatch = useCallback(
    (retainHero = false) => {
      if (candidates.length === 0) {
        setHero(null);
        setDeck([]);
        return;
      }

      setIsRefreshing(true);
      const targetCount = isMerged ? 2 : 3;

      const result = pickDiversifiedBatch(
        candidates,
        shownIdsRef.current,
        retainHero ? hero?.id || null : null,
        targetCount,
      );

      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
      }

      // 提供 350ms 的加载动效时间，让刷新具有视觉流动感与反馈
      refreshTimerRef.current = window.setTimeout(() => {
        if (result.hero) {
          setHero(result.hero);
          selectedIdRef.current = result.hero.id;
        }
        setDeck(result.deck);
        setIsRefreshing(false);
        setIsLoading(false);
        setError(false);
      }, 350);
    },
    [candidates, hero?.id, isMerged],
  );

  // 初始化与候选集变更时选取批次
  useEffect(() => {
    if (candidates.length === 0) {
      setHero(null);
      setDeck([]);
      return;
    }
    if (!hero || !candidates.some(c => c.id === hero.id)) {
      refreshBatch(false);
    }
    return () => {
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
      }
    };
  }, [candidates, hero, refreshBatch]);

  /**
   * 将备选微卡置换为主推（带轻微切换平滑过渡）
   */
  const handleSelectDeckItem = useCallback(
    (item: SeriesItem) => {
      if (!hero || hero.id === item.id) return;
      setIsCardSwitching(true);
      window.setTimeout(() => {
        const oldHero = hero;
        setHero(item);
        selectedIdRef.current = item.id;
        setDeck(prev => [oldHero, ...prev.filter(d => d.id !== item.id)].slice(0, isMerged ? 2 : 3));
        setIsCardSwitching(false);
        setIsLoading(false);
        setError(false);
      }, 160);
    },
    [hero, isMerged],
  );

  /**
   * 仅在用户主动点击「立即观看」时才加载详情，不进行其他后台预取
   */
  const handleWatch = useCallback(
    (targetSeries?: SeriesItem | null) => {
      const target = targetSeries || hero;
      if (!target || isLoading) return;
      const id = target.id;
      setIsLoading(true);
      setError(false);
      void ipcService.series
        .getDetail(id)
        .then(detail => {
          if (selectedIdRef.current !== id && (!targetSeries || targetSeries.id !== id)) return;
          onWatch(target, detail);
        })
        .catch(() => {
          if (selectedIdRef.current === id) setError(true);
        })
        .finally(() => {
          if (selectedIdRef.current === id) setIsLoading(false);
        });
    },
    [hero, isLoading, onWatch],
  );

  if (!hero) return null;

  const heroTeaser = getSeriesTeaser(hero);
  const heatLabel = formatHeatValue(hero.heat);
  const heroTags = hero.tags.slice(0, 3).join(' · ');
  const heroMeta = [hero.episodesCount > 0 ? `${hero.episodesCount} 集` : '', heroTags]
    .filter(Boolean)
    .join(' · ');

  // -------------------------------------------------------------
  // 分支 1：并轨半宽模式（与「继续观看」并排）
  // -------------------------------------------------------------
  if (isMerged) {
    return (
      <section
        aria-label="猜你喜欢"
        className={`${PICK_CARD_SHELL} bg-gradient-to-r from-violet-50/80 via-white/92 to-purple-50/40 ${
          isCardSwitching ? 'opacity-60' : ''
        } ${className}`}
      >
        <span
          aria-hidden="true"
          className="absolute inset-y-3 left-0 w-[3px] rounded-r-full bg-violet-500"
        />

        {/*
          与「继续观看」逐行同构：封面 → 信息列 → 操作列。
          并排时两卡高度由 grid stretch 拉平，内部骨架必须一致，否则行高会互相顶。
        */}
        {isRefreshing ? (
          <>
            <div className="h-32 w-24 shrink-0 rounded-xl border border-white/80 bg-violet-100/60 shimmer-loading" />
            <div className="flex min-w-0 flex-1 flex-col justify-center gap-2">
              <div className="flex items-center gap-1.5">
                <div className="h-4 w-16 rounded-full bg-violet-100/70 shimmer-loading" />
                <div className="h-4 w-12 rounded bg-slate-100 shimmer-loading" />
              </div>
              <div className="h-5 w-40 rounded bg-slate-200/70 shimmer-loading" />
              <div className="h-3.5 w-full rounded bg-slate-100 shimmer-loading" />
              <div className="h-3 w-24 rounded bg-slate-100 shimmer-loading" />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <div className="h-8 w-8 shrink-0 rounded-lg bg-violet-100/60 shimmer-loading" />
              <div className="h-8 w-20 shrink-0 rounded-lg bg-violet-200/60 shimmer-loading" />
            </div>
          </>
        ) : (
          <>
            {/* 封面尺寸与「继续观看」逐像素一致：h-32 w-24 = 128×96，严格 3:4。
                旧值 `w-21` 不在 Tailwind 刻度里（宽度实际塌掉），这是两卡不齐的直接原因。 */}
            <div
              onClick={() => handleWatch(hero)}
              className="group/hero relative h-32 w-24 shrink-0 cursor-pointer overflow-hidden rounded-xl border border-white/90 bg-slate-100 shadow-xs"
            >
              <CoverImage
                src={hero.cover}
                title={hero.title}
                placeholderTextClassName="text-2xl"
                className="transition-transform duration-300 group-hover/hero:scale-105"
                loading="eager"
                resolveSrc={hero.id.startsWith('guo:') ? () => ipcService.catalog.guoCover(hero.id) : undefined}
              />
            </div>

            <div className="flex min-w-0 flex-1 flex-col justify-center gap-1.5">
              <div className="flex items-center gap-1.5">
                <StatusBadge label="猜你喜欢" variant="purple" size="sm" dot />
                {hero.tags?.[0] ? (
                  <span className="rounded border border-violet-200/60 bg-violet-50 px-1.5 py-0.2 text-[9.5px] font-bold text-violet-700">
                    {hero.tags[0]}
                  </span>
                ) : null}
                {hero.rating ? (
                  <span className="flex items-center gap-0.5 text-[11px] font-bold text-amber-600">
                    <Star className="h-2.5 w-2.5 fill-amber-400" />
                    {hero.rating.toFixed(1)}
                  </span>
                ) : null}
              </div>

              <h3
                onClick={() => handleWatch(hero)}
                className="cursor-pointer truncate text-base font-extrabold tracking-tight text-slate-900 transition-colors hover:text-violet-700"
                title={hero.title}
              >
                {hero.title}
              </h3>

              <p className="line-clamp-1 text-[11.5px] leading-relaxed text-slate-500">
                {heroTeaser}
              </p>

              {/* 最后一行与左卡的进度条行同位置（都在信息列底部），两卡纵向节奏才一致。 */}
              <div className="mt-0.5 flex min-w-0 items-center gap-2">
                {deck.length > 0 ? (
                  <>
                    <span className="shrink-0 text-[10.5px] text-slate-400">还可看</span>
                    <div className="flex min-w-0 items-center gap-1.5">
                      {deck.map(item => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            handleSelectDeckItem(item);
                          }}
                          className="max-w-[92px] truncate rounded-md border border-slate-200/70 bg-white/80 px-1.5 py-0.5 text-[10.5px] text-slate-600 transition-colors hover:border-violet-300 hover:bg-violet-50 hover:text-violet-700"
                          title={item.title}
                        >
                          {item.title}
                        </button>
                      ))}
                    </div>
                  </>
                ) : heatLabel ? (
                  <span className="flex min-w-0 items-center gap-1 text-[10.5px] text-slate-400">
                    <Flame className="h-3 w-3 shrink-0 text-orange-500" />
                    <span className="truncate">{heatLabel}</span>
                  </span>
                ) : null}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  refreshBatch(false);
                }}
                title="换一批推荐"
                aria-label="换一批推荐"
                disabled={isRefreshing}
                className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-violet-50 hover:text-violet-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
              <FluentButton
                variant="primary"
                size="sm"
                icon={<Play className="h-3 w-3 fill-current" />}
                disabled={isLoading}
                onClick={e => {
                  e.stopPropagation();
                  handleWatch(hero);
                }}
              >
                {isLoading ? '准备中' : error ? '不可用' : '立即观看'}
              </FluentButton>
            </div>
          </>
        )}
      </section>
    );
  }

  // -------------------------------------------------------------
  // 分支 2：独占全宽展开模式（没有继续观看，或大屏独立推荐区）
  // -------------------------------------------------------------
  return (
    <section
      aria-label="猜你喜欢"
      className={`relative flex flex-col gap-3.5 overflow-hidden rounded-2xl border border-white/90 bg-gradient-to-br from-violet-50/70 via-white/95 to-purple-50/40 p-4 sm:p-5 shadow-fluent-lg fluent-raised-island transition-all duration-300 animate-fluent-card-in ${className}`}
    >
      {/* 左侧流动微光强调色条 */}
      <span
        aria-hidden="true"
        className="absolute inset-y-3.5 left-0 w-[3.5px] rounded-r-full bg-gradient-to-b from-violet-500 via-purple-500 to-indigo-500"
      />

      {/* 顶部 Header：标题、副标题、换一批操作 */}
      <div className="flex items-center justify-between gap-2.5 pl-2">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600">
            <Sparkles className="h-3.5 w-3.5" />
          </span>
          <span className="text-sm font-extrabold tracking-tight text-slate-800 sm:text-base">
            猜你喜欢
          </span>
          <span className="hidden text-xs font-normal text-slate-400 sm:inline">
            · 为你精选多元风格好剧
          </span>
        </div>

        {/* 换一批按钮 */}
        <button
          type="button"
          onClick={() => refreshBatch(false)}
          disabled={isRefreshing}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-violet-200/60 bg-violet-50/90 px-3 py-1.5 text-xs font-semibold text-violet-700 shadow-2xs transition-all duration-150 hover:bg-violet-100 active:scale-95"
          title="换一批多元化推荐"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin text-violet-600' : ''}`} />
          <span>换一批</span>
        </button>
      </div>

      {/* 动效过渡区：刷新中呈现骨架加载动效；刷新完毕呈现正式卡片 */}
      {isRefreshing ? (
        <div className="grid grid-cols-1 items-stretch gap-4.5 pt-1 pl-2 lg:grid-cols-12 animate-fade-in">
          {/* 左侧主推骨架屏 */}
          <div className="flex flex-col items-center gap-4 rounded-xl border border-white/80 bg-white/70 p-3.5 shadow-2xs sm:flex-row sm:items-stretch lg:col-span-7 xl:col-span-7">
            <div className="h-38 w-28 shrink-0 rounded-xl bg-violet-100/60 shimmer-loading sm:h-44 sm:w-32" />
            <div className="flex w-full min-w-0 flex-1 flex-col justify-between py-1 gap-2.5">
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <div className="h-4.5 w-18 rounded-full bg-violet-100/70 shimmer-loading" />
                  <div className="h-4.5 w-14 rounded-full bg-slate-100 shimmer-loading" />
                </div>
                <div className="h-6 w-3/4 rounded-md bg-slate-200/70 shimmer-loading" />
                <div className="h-3.5 w-full rounded bg-slate-100 shimmer-loading" />
                <div className="h-3.5 w-4/5 rounded bg-slate-100 shimmer-loading" />
                <div className="h-3 w-1/3 rounded bg-slate-100 shimmer-loading" />
              </div>
              <div className="flex items-center gap-2 pt-1">
                <div className="h-8 w-24 rounded-lg bg-violet-200/60 shimmer-loading" />
                <div className="h-8 w-16 rounded-lg bg-slate-100 shimmer-loading" />
              </div>
            </div>
          </div>

          {/* 右侧候选列表骨架屏 */}
          <div className="flex flex-col justify-between gap-2 rounded-xl border border-violet-100/60 bg-violet-50/30 p-3.5 lg:col-span-5 xl:col-span-5">
            <div className="h-4 w-28 rounded bg-violet-100/60 shimmer-loading" />
            <div className="flex flex-col gap-2">
              {[1, 2, 3].map(i => (
                <div key={i} className="flex items-center gap-3 rounded-xl border border-transparent bg-white/70 p-2">
                  <div className="h-13 w-10 shrink-0 rounded-lg bg-violet-100/50 shimmer-loading" />
                  <div className="flex flex-1 flex-col gap-1.5">
                    <div className="h-3.5 w-12 rounded bg-violet-100/60 shimmer-loading" />
                    <div className="h-4 w-3/4 rounded bg-slate-200/70 shimmer-loading" />
                    <div className="h-3 w-1/2 rounded bg-slate-100 shimmer-loading" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 items-stretch gap-4.5 pt-1 pl-2 lg:grid-cols-12">
          {/* 左侧：精选主推 (Hero Spotlight) */}
          <div
            className={`flex flex-col items-center gap-4 rounded-xl border border-white/80 bg-white/70 p-3.5 shadow-2xs transition-all duration-300 hover:shadow-fluent sm:flex-row sm:items-stretch lg:col-span-7 xl:col-span-7 ${
              isCardSwitching ? 'opacity-60 scale-[0.99]' : 'opacity-100 scale-100'
            }`}
          >
            {/* 封面海报 */}
            <div
              onClick={() => handleWatch(hero)}
              className="group/hero relative h-38 w-28 shrink-0 cursor-pointer overflow-hidden rounded-xl border border-white/90 bg-slate-100 shadow-sm sm:h-44 sm:w-32"
            >
              <CoverImage
                src={hero.cover}
                title={hero.title}
                placeholderTextClassName="text-2xl"
                className="transition-transform duration-300 group-hover/hero:scale-105"
                loading="eager"
                resolveSrc={hero.id.startsWith('guo:') ? () => ipcService.catalog.guoCover(hero.id) : undefined}
              />
              {hero.rating ? (
                <span className="absolute top-1.5 right-1.5 inline-flex items-center gap-0.5 rounded-md bg-black/65 px-1.5 py-0.5 text-[10.5px] font-bold text-amber-400 shadow-xs backdrop-blur-xs">
                  <Star className="h-2.5 w-2.5 fill-amber-400" />
                  {hero.rating.toFixed(1)}
                </span>
              ) : null}
              {/* 悬浮微光播放提示 */}
              <div className="absolute inset-0 flex items-center justify-center bg-black/25 opacity-0 transition-opacity group-hover/hero:opacity-100">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-violet-600 text-white shadow-md">
                  <Play className="ml-0.5 h-4 w-4 fill-current" />
                </span>
              </div>
            </div>

            {/* 剧集详情信息 */}
            <div className="flex min-w-0 flex-1 flex-col justify-between gap-2">
              <div className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge label="猜你喜欢" variant="purple" size="sm" dot />
                  {hero.tags?.[0] ? (
                    <span className="rounded-md border border-violet-200/60 bg-violet-50 px-1.5 py-0.2 text-[10px] font-bold text-violet-700">
                      {hero.tags[0]}
                    </span>
                  ) : null}
                  {heatLabel ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500">
                      <Flame className="h-3 w-3 shrink-0 text-orange-500" />
                      <span>{heatLabel}</span>
                    </span>
                  ) : null}
                  {hero.episodesCount > 0 ? (
                    <span className="text-[11px] font-medium text-slate-400">
                      全 {hero.episodesCount} 集
                    </span>
                  ) : null}
                </div>

                <h3
                  onClick={() => handleWatch(hero)}
                  className="cursor-pointer line-clamp-1 text-base font-extrabold tracking-tight text-slate-900 transition-colors hover:text-violet-700 sm:text-lg"
                  title={hero.title}
                >
                  {hero.title}
                </h3>

                <p className="line-clamp-2 min-h-[34px] text-xs leading-relaxed text-slate-500">
                  {heroTeaser}
                </p>

                {heroMeta && (
                  <span className="flex min-w-0 items-center gap-1 text-[11px] text-slate-400">
                    <Layers3 className="h-3 w-3 shrink-0" />
                    <span className="truncate">{heroMeta}</span>
                  </span>
                )}
              </div>

              {/* 操作按钮组 */}
              <div className="flex items-center gap-2.5 pt-1">
                <FluentButton
                  variant="primary"
                  size="sm"
                  icon={<Play className="h-3 w-3 fill-current" />}
                  disabled={isLoading}
                  onClick={e => {
                    e.stopPropagation();
                    handleWatch(hero);
                  }}
                >
                  {isLoading ? '准备中' : error ? '不可用' : '立即观看'}
                </FluentButton>

                {onDetail && (
                  <button
                    type="button"
                    onClick={e => {
                      e.stopPropagation();
                      onDetail(hero.id);
                    }}
                    className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-slate-200/80 bg-white/90 px-3 text-xs font-semibold text-slate-600 shadow-2xs transition-all hover:bg-slate-100 hover:text-slate-900"
                  >
                    <Info className="h-3.5 w-3.5" />
                    <span>详情</span>
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* 右侧：猜你还想看 · 多元化候选矩阵 */}
          <div className="flex flex-col justify-between gap-2 rounded-xl border border-violet-100/60 bg-violet-50/30 p-3.5 lg:col-span-5 xl:col-span-5">
            <div className="flex items-center justify-between border-b border-violet-100/50 pb-1.5">
              <span className="flex items-center gap-1.5 text-xs font-bold text-slate-700">
                <Sparkles className="h-3.5 w-3.5 text-violet-500" />
                <span>猜你还想看</span>
              </span>
              <span className="text-[10.5px] text-slate-400">
                点击切换主推
              </span>
            </div>

            <div className="flex flex-col gap-2">
              {deck.map(item => (
                <div
                  key={item.id}
                  onClick={() => handleSelectDeckItem(item)}
                  className="group/sub relative flex cursor-pointer items-center gap-3 rounded-xl border border-transparent bg-white/80 p-2 shadow-2xs transition-all duration-200 hover:border-violet-200/80 hover:bg-white hover:shadow-fluent-sm"
                >
                  <div className="relative h-13 w-10 shrink-0 overflow-hidden rounded-lg border border-white/90 bg-slate-100 shadow-2xs">
                    <CoverImage
                      src={item.cover}
                      title={item.title}
                      placeholderTextClassName="text-xs"
                      className="transition-transform duration-200 group-hover/sub:scale-105"
                      loading="lazy"
                      resolveSrc={item.id.startsWith('guo:') ? () => ipcService.catalog.guoCover(item.id) : undefined}
                    />
                  </div>

                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-center gap-1.5">
                      <span className="rounded-md border border-violet-200/60 bg-violet-50 px-1.5 py-0.2 text-[9.5px] font-bold text-violet-700">
                        {item.tags?.[0] || '精选'}
                      </span>
                      {item.rating ? (
                        <span className="flex items-center gap-0.5 text-[10px] font-bold text-amber-600">
                          ★ {item.rating.toFixed(1)}
                        </span>
                      ) : null}
                    </div>
                    <h4 className="truncate text-xs font-bold text-slate-800 transition-colors group-hover/sub:text-violet-600">
                      {item.title}
                    </h4>
                    <p className="truncate text-[10.5px] text-slate-400">
                      {item.episodesCount > 0 ? `${item.episodesCount}集` : '精选'} · {item.tags.slice(0, 2).join(' ')}
                    </p>
                  </div>

                  <div className="shrink-0 opacity-0 transition-opacity group-hover/sub:opacity-100">
                    <span className="rounded-md bg-violet-100/80 px-2 py-0.8 text-[11px] font-semibold text-violet-700">
                      切换
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
