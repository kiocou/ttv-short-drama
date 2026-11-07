import React, { useCallback, useEffect, useRef } from 'react';
import { ArrowLeft, Flame, Loader2, RefreshCw, Sparkles, TrendingUp } from 'lucide-react';
import { useAppStore, type SpotlightKind } from '../../stores/useAppStore';
import { useSpotlightFeed } from '../../stores/useSpotlightFeed';
import { FluentButton } from '../common/FluentButton';
import { CoverImage } from '../common/CoverImage';
import { coverResolver } from '../../services/ipc';
import type { SeriesItem } from '../../types/catalog';

/**
 * 首页顶部三档的落地页。
 *
 * ## 为什么是三个页面而不是一个排序开关
 *
 * 这三档的数据源本来就不是同一份东西：推荐流来自站方算法，最新上线按
 * `online_time` 排，热度榜单按 `hot_score` / 热播 cell 排。在首页原地换 sort
 * 参数只会换掉一句中文描述（真正的原因见 `useSpotlightFeed` 顶部注释）。
 *
 * 三页的排布也**刻意不一致**——用户要的是"点进去是另一个地方"，那么三页长得
 * 一样就又把这件事抹掉了：
 *
 *   - 综合推荐：首条做 Hero，其余双列信息流（挑剧的场景）；
 *   - 最新上线：时间轴，按到达顺序自上而下（追更的场景）；
 *   - 热度榜单：前三名台座 + Top 列表，带相对热度条（看排行的场景）。
 */

const TITLE_COPY: Record<SpotlightKind, { title: string; subtitle: string; verb: string }> = {
  recommend: {
    title: '综合推荐',
    subtitle: '按你的观看口味混排的发现流 · 与首页目录不是同一批',
    verb: '为你推荐',
  },
  latest: {
    title: '最新上线',
    subtitle: '按上架时间倒序，越靠前越新',
    verb: '刚刚上线',
  },
  heat: {
    title: '热度榜单',
    subtitle: '按站方热度排序 · 名次即热度位次',
    verb: '热度榜',
  },
};

const CHANNEL_LABEL: Record<string, string> = {
  drama: '短剧专区',
  comic: '漫剧次元',
  anime: '动漫专区',
  adult: '神秘小窝',
};

/** 集数 + 来源 + 首个标签，压成一行元信息。 */
function metaLine(series: SeriesItem): string {
  return [
    series.episodesCount > 0 ? `${series.episodesCount} 集` : '',
    series.origin || '',
    series.tags.slice(0, 2).join(' · '),
  ].filter(Boolean).join(' · ');
}

const Cover: React.FC<{ series: SeriesItem; className: string; textClass?: string }> = ({
  series,
  className,
  textClass = 'text-lg',
}) => (
  <div className={`relative overflow-hidden rounded-xl border border-white/80 bg-slate-100 ${className}`}>
    <CoverImage
      src={series.cover}
      title={series.title}
      placeholderTextClassName={textClass}
      className="h-full w-full object-cover"
      resolveSrc={coverResolver(series.id, series.cover)}
    />
  </div>
);

/** ---------------- 综合推荐：Hero + 双列信息流 ---------------- */
const RecommendLayout: React.FC<{ items: SeriesItem[]; onClick: (id: string) => void }> = ({ items, onClick }) => {
  const [hero, ...rest] = items;
  if (!hero) return null;
  return (
    <div className="mx-auto flex w-full max-w-[1040px] min-w-0 flex-col gap-5">
      <button
        type="button"
        onClick={() => onClick(hero.id)}
        className="group grid w-full min-w-0 cursor-pointer grid-cols-[147px_minmax(0,1fr)] gap-3.5 rounded-3xl border border-white/85 bg-gradient-to-br from-white/95 via-white/90 to-rose-50/70 p-4 text-left shadow-fluent transition-colors hover:border-white hover:from-white"
      >
        <Cover series={hero} className="h-[196px] w-[147px] shrink-0" textClass="text-3xl" />
        <div className="flex min-w-0 flex-col justify-center gap-3 overflow-hidden">
          <span className="inline-flex w-fit items-center gap-1 rounded-full bg-rose-500/10 px-2.5 py-1 text-[11px] font-bold text-rose-600">
            <Sparkles className="h-3 w-3" />
            今日主推
          </span>
          <h3 className="w-full truncate text-2xl font-extrabold tracking-tight text-slate-900">{hero.title}</h3>
          <p className="line-clamp-3 text-[12.5px] leading-relaxed text-slate-500">
            {hero.brief || metaLine(hero) || '暂无简介'}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {hero.tags.slice(0, 4).map(tag => (
              <span key={tag} className="rounded-md bg-slate-100 px-2 py-0.5 text-[10.5px] font-semibold text-slate-500">
                {tag}
              </span>
            ))}
          </div>
          <div className="mt-1 flex items-center gap-3 text-[11px] font-semibold text-slate-400">
            {hero.episodesCount > 0 && <span>{hero.episodesCount} 集</span>}
            {hero.rating ? <span className="text-amber-500">{hero.rating.toFixed(1)} 分</span> : null}
            {hero.origin && <span>{hero.origin}</span>}
          </div>
        </div>
      </button>

      <div className="grid min-w-0 grid-cols-1 gap-2.5 lg:grid-cols-[repeat(2,minmax(0,1fr))]">
        {rest.map((series, index) => (
          <button
            key={series.id}
            type="button"
            onClick={() => onClick(series.id)}
            className="group flex cursor-pointer items-center gap-3 rounded-2xl border border-white/80 bg-white/80 p-2.5 text-left transition-colors hover:bg-white"
          >
            <span className="w-6 shrink-0 text-center text-[11px] font-bold text-slate-300 tabular-nums">
              {String(index + 2).padStart(2, '0')}
            </span>
            <Cover series={series} className="h-[76px] w-[57px] shrink-0" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="truncate text-[13px] font-bold text-slate-900">{series.title}</span>
              <span className="truncate text-[10.5px] text-slate-400">{metaLine(series) || '—'}</span>
            </div>
            {series.heat ? (
              <span className="shrink-0 rounded-md bg-orange-50 px-1.5 py-0.5 text-[10px] font-bold text-orange-500 tabular-nums">
                <Flame className="mr-0.5 inline h-2.5 w-2.5" />
                {series.heat}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
};

/** ---------------- 最新上线：时间轴 ---------------- */
const LatestLayout: React.FC<{ items: SeriesItem[]; onClick: (id: string) => void }> = ({ items, onClick }) => (
  <div className="relative mx-auto flex w-full max-w-[1040px] min-w-0 flex-col gap-1 pl-6">
    {/* 轴线：最后一格不画，避免轴线拖出一条无内容的尾巴 */}
    <span aria-hidden="true" className="absolute bottom-8 left-[9px] top-3 w-px bg-gradient-to-b from-blue-300/80 via-slate-200 to-transparent" />
    {items.map((series, index) => (
      <div key={series.id} className="relative">
        <span
          aria-hidden="true"
          className={`absolute -left-6 top-[26px] h-2 w-2 rounded-full ring-4 ring-white ${
            index === 0 ? 'bg-blue-500' : 'bg-slate-300'
          }`}
        />
        <button
          type="button"
          onClick={() => onClick(series.id)}
          className="group my-1 flex w-full cursor-pointer items-center gap-3 rounded-2xl border border-white/70 bg-white/70 px-3 py-2 text-left transition-colors hover:bg-white"
        >
          <span className="w-14 shrink-0 text-[10px] font-bold text-slate-400 tabular-nums">
            {index === 0 ? 'NEW' : series.updateTime || `#${index + 1}`}
          </span>
          <Cover series={series} className="h-[64px] w-[48px] shrink-0" textClass="text-sm" />
          <div className="flex min-w-0 flex-1 flex-col gap-1 overflow-hidden">
            <span className="truncate text-[13px] font-bold text-slate-900">{series.title}</span>
            <span className="truncate text-[10.5px] text-slate-400">{metaLine(series) || '—'}</span>
          </div>
          <span className="shrink-0 rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-bold text-blue-600 opacity-0 transition-opacity group-hover:opacity-100">
            查看
          </span>
        </button>
      </div>
    ))}
  </div>
);

/** ---------------- 热度榜单：台座 + Top 列表 ---------------- */
const HeatLayout: React.FC<{ items: SeriesItem[]; onClick: (id: string) => void }> = ({ items, onClick }) => {
  const top = items.slice(0, 3);
  const rest = items.slice(3);
  // 相对热度：只在这一页内部做归一化（源头没有统一量纲），第一条恒为 100%。
  const peak = Math.max(...items.map(item => item.heat ?? 0), 1);
  const podiumClass = ['bg-gradient-to-b from-amber-400 to-orange-500', 'bg-gradient-to-b from-slate-300 to-slate-400', 'bg-gradient-to-b from-amber-600 to-amber-800'];

  return (
    <div className="mx-auto flex w-full max-w-[1040px] min-w-0 flex-col gap-6">
      <div className="grid min-w-0 grid-cols-[repeat(3,minmax(0,1fr))] gap-3">
        {top.map((series, index) => (
          <button
            key={series.id}
            type="button"
            onClick={() => onClick(series.id)}
            className="group relative flex cursor-pointer flex-col items-center gap-2 rounded-2xl border border-white/80 bg-white/80 px-3 pb-3 pt-8 text-center transition-colors hover:bg-white"
          >
            <span
              aria-hidden="true"
              className={`absolute -top-2 left-1/2 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full text-[12px] font-extrabold text-white shadow-md ${podiumClass[index]}`}
            >
              {index + 1}
            </span>
            <Cover series={series} className="h-[150px] w-[112px]" textClass="text-2xl" />
            <span className="line-clamp-1 w-full text-[12.5px] font-extrabold text-slate-900">{series.title}</span>
            <span className="text-[10.5px] font-semibold text-orange-500">
              {series.heat ? `${series.heat} 热度` : metaLine(series) || '—'}
            </span>
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        {rest.map((series, index) => {
          const rank = index + 4;
          const percent = Math.max(4, Math.round(((series.heat ?? 0) / peak) * 100));
          return (
            <button
              key={series.id}
              type="button"
              onClick={() => onClick(series.id)}
              className="group flex w-full cursor-pointer items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-white/90"
            >
              <span className="w-8 shrink-0 text-center text-[15px] font-extrabold text-slate-300 tabular-nums">
                {rank}
              </span>
              <Cover series={series} className="h-[56px] w-[42px] shrink-0" textClass="text-xs" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[12.5px] font-bold text-slate-900">{series.title}</span>
                  <span className="shrink-0 text-[10px] text-slate-400">{metaLine(series) || ''}</span>
                </div>
                <div className="h-1 w-full max-w-[280px] overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-orange-400 to-rose-500 transition-[width] duration-500"
                    style={{ width: `${percent}%` }}
                  />
                </div>
              </div>
              <TrendingUp className="h-3.5 w-3.5 shrink-0 text-slate-300 group-hover:text-orange-500" />
            </button>
          );
        })}
      </div>
    </div>
  );
};

/** 骨架：三档共用一份，高度接近各自首屏，避免数据到达时跳一下。 */
const SpotlightSkeleton: React.FC = () => (
  <div className="flex flex-col gap-3">
    <div className="h-[260px] w-full animate-pulse rounded-3xl bg-white/60" />
    {Array.from({ length: 6 }).map((_, index) => (
      <div key={index} className="h-[88px] w-full animate-pulse rounded-2xl bg-white/50" />
    ))}
  </div>
);

export const SpotlightView: React.FC = () => {
  const { spotlight, goBack, navigateTo, openSpotlight } = useAppStore();
  const kind: SpotlightKind = spotlight?.kind ?? 'recommend';
  const channel = spotlight?.channel ?? 'drama';
  const feed = useSpotlightFeed(kind, channel);
  const copy = TITLE_COPY[kind];

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  /** 换档位后回到页首：否则会停在上一个页面的滚动位置，读起来像没切成功。 */
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'instant' });
  }, [kind, channel]);

  /** 触底自动续页。用 root 限定在滚动容器内，避免整页滚动容器的交叉干扰。 */
  useEffect(() => {
    const root = scrollRef.current;
    const target = sentinelRef.current;
    if (!root || !target) return;
    if (!feed.hasMore || feed.isLoading || feed.isLoadingMore) return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) feed.loadMore();
      },
      { root, rootMargin: '240px 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [feed.hasMore, feed.isLoading, feed.isLoadingMore, feed.loadMore]);

  const handleClick = useCallback((seriesId: string) => navigateTo('detail', seriesId), [navigateTo]);

  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
      {/* 页头：返回 + 标题 + 频道切换 + 刷新 */}
      <header className="flex shrink-0 items-center gap-3 border-b border-slate-200/60 px-6 py-4">
        <button
          type="button"
          onClick={goBack}
          title="返回"
          aria-label="返回"
          className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-white hover:text-slate-900"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-lg font-extrabold tracking-tight text-slate-900">
            {copy.title}
            <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">
              {CHANNEL_LABEL[channel] ?? channel}
            </span>
          </h1>
          <p className="mt-0.5 truncate text-[11px] text-slate-400">{copy.subtitle}</p>
        </div>
        {/* 三档之间直接互跳，不必先退回首页 */}
        <div className="flex shrink-0 items-center gap-1 rounded-xl border border-slate-200/70 bg-slate-100/90 p-1">
          {(['recommend', 'latest', 'heat'] as SpotlightKind[]).map(item => (
            <button
              key={item}
              type="button"
              onClick={() => openSpotlight(item, channel)}
              className={`rounded-lg px-2.5 py-1 text-[11px] transition-colors cursor-pointer ${
                item === kind
                  ? 'fluent-convex-tab font-bold text-blue-600'
                  : 'font-medium text-slate-500 hover:bg-white/60 hover:text-slate-900'
              }`}
            >
              {TITLE_COPY[item].title}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={feed.reload}
          title="刷新"
          aria-label="刷新"
          className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-white hover:text-blue-600"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${feed.isLoading ? 'animate-spin' : ''}`} />
        </button>
      </header>

      <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-5">
        {feed.isLoading && feed.items.length === 0 ? (
          <SpotlightSkeleton />
        ) : feed.error && feed.items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
            <p className="text-sm font-semibold text-slate-600">内容加载失败</p>
            <p className="max-w-lg break-words text-xs leading-relaxed text-slate-400">{feed.error}</p>
            <FluentButton size="sm" onClick={feed.reload}>重试</FluentButton>
          </div>
        ) : feed.items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
            <p className="text-sm font-semibold text-slate-600">这一栏暂时没有内容</p>
            <p className="text-xs text-slate-400">换个频道，或稍后刷新试试</p>
          </div>
        ) : (
          <>
            {kind === 'recommend' && <RecommendLayout items={feed.items} onClick={handleClick} />}
            {kind === 'latest' && <LatestLayout items={feed.items} onClick={handleClick} />}
            {kind === 'heat' && <HeatLayout items={feed.items} onClick={handleClick} />}

            <div ref={sentinelRef} className="flex h-14 items-center justify-center">
              {feed.isLoadingMore && (
                <span className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  正在加载更多…
                </span>
              )}
              {!feed.hasMore && feed.items.length > 0 && (
                <span className="text-[11px] text-slate-300">已经到底了 · 共 {feed.items.length} 部</span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
