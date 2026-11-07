import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { SeriesItem } from '../../types/catalog';
import { SeriesCard } from './SeriesCard';
import { SeriesCardSkeleton } from './SeriesCardSkeleton';
import { RankRow } from './RankRow';
import { ShelfBadge } from './ShelfBadge';

interface HomeShelfProps {
  title: string;
  subtitle: string;
  items: SeriesItem[];
  onClick: (seriesId: string) => void;
  /**
   * 封面确定不可得时把整张卡移出列表。
   *
   * 可选：货架卡现在来自红果 App 接口（不在发现页目录里），`hiddenSeriesIds`
   * 那套除名机制管不到它们 —— 不传就只保留封面占位，不动卡片。
   */
  onUnavailable?: (seriesId: string) => void;
  /**
   * 数据还没到。
   *
   * 要的是"占位也要占住高度"：直接把货架返成 null 的话，它会先消失再出现，
   * 整页跟着跳一下。
   */
  loading?: boolean;
  /**
   * 进入该分区的「更多」页。
   *
   * 取代了原来的刷新按钮：刷新只换掉首屏那 6 张预览卡，而用户真正想要的是
   * “这一栏还有些什么”。入口交给「更多」，刷新交给「更多」页自己（或不做）。
   */
  onMore?: () => void;
  accent?: 'rose' | 'blue';
  /**
   * 标题徽章图标（渐变圆角方块，见 `ShelfBadge`）。可选：传了就渲染在色标与
   * 标题之间，不传保持原样。首页各货架各自挑语义贴合的图标。
   */
  icon?: LucideIcon;
  /** 徽章配色，缺省跟随 `accent`（rose→rose、blue→blue）。 */
  iconTone?: 'rose' | 'blue' | 'violet' | 'amber' | 'teal' | 'indigo';
  /**
   * 排布形态。
   *
   * - `row`（默认，首页五块货架）：**平铺卡片 + 横向滚动，只占一行**。
   *   卡片仍是 3:4 海报（与下方目录同一份 `SeriesCard`），一行放得下几张就露几张，
   *   其余靠横滚轴推出来；顺序即名次，滚到最右就是这一栏的最后一名。
   * - `grid`：响应式多列网格。动漫专区等仍用网格的地方显式传它。
   * - `rank`：一行一部的名次列表（历史形态，保留给需要"读榜单"的场景）。
   */
  variant?: 'grid' | 'row' | 'rank';
  /**
   * 榜单行右侧的次要指标。仅 `variant="rank"` 生效。
   *
   * 只有宿主知道"这一栏的数据源到底有没有这个数"，所以由它逐条给出；返回空串
   * 就是留空（不拿集数凑一个假指标）。
   */
  metricOf?: (series: SeriesItem, index: number) => string | undefined;
}

/**
 * 横滚条一屏放几张，取决于窗口宽度，所以卡片宽度是**固定值**而不是百分比：
 * 百分比会让卡片随容器变宽，横滚就退化成"一排大卡只露两张半"。
 * 148px 在 1440 宽的主工作区里露 5–6 张，滚动才真正有信息增量。
 */
const RAIL_CARD_WIDTH = 148;

/**
 * 内容不多时，这一栏不再横滑，而是**自适应 Grid 铺满整行**。
 *
 * ## 它修的是什么
 *
 * 横滑轨道的卡片宽度是固定 148px（见上面的理由），铺满后右侧必然留一段空白：
 * 6 条卡在 1200px 的工作区里只占 948px，右边 250px 是纯空气 —— 用户报告的
 * "App 推荐 / 红果短剧这几栏右侧空一大块"就是它。而这条栏目的数据源本身
 * 就只给 6 条（`PREVIEW_COUNT` 之外的内容在「更多」页），所以空白是**常态**，
 * 不是加载中的偶然。
 *
 * ## 阈值为什么是 6
 *
 * 6 条正好是"一屏能读完"的编辑量。超过 6 条时继续铺满网格会把卡片压到 100px
 * 以下（标题两行、meta 一行全挤在一起），而且那一栏本来就有"还有更多"的语义
 * —— 横滑 + 露半张卡才是正确的提示。所以：
 *
 * | 条数 | 形态 |
 * | --- | --- |
 * | 1–3 | 固定宽卡片横向排开，**不拉伸**（3 张拉成满屏等于把海报放大成 banner） |
 * | 4–6 | 等分列宽的 Grid，铺满整行 |
 * | 7+  | 横滑轨道（现状） |
 *
 * 空数据完全不渲染（上面的 `if (!loading && items.length === 0) return null`），
 * 不留一个空标题 + 空容器。
 */
const AUTO_FIT_MAX = 6;

/**
 * 自适应 Grid 的列模板。
 *
 * - 4–6 条：`repeat(n, minmax(0, 1fr))` —— 每列等分、卡片随列宽缩放，
 *   `minmax(0, …)` 是必须的：默认的 `minmax(auto, 1fr)` 会把卡片内容的
 *   最小宽度顶成列宽，长标题一出现整行就被撑破。
 * - 1–3 条：固定 148px 列宽（与横滑轨道同宽），右侧留白由调用方用「更多」
 *   或相邻模块消化，宁可留白也不把海报拉成横幅。
 *
 * 返回 null 表示"这一栏照旧走横滑"。
 */
function autoFitColumns(count: number): string | null {
  if (count < 1 || count > AUTO_FIT_MAX) return null;
  if (count <= 3) return `repeat(${count}, ${RAIL_CARD_WIDTH}px)`;
  return `repeat(${count}, minmax(0, 1fr))`;
}

/** 榜单行骨架：与 `RankRow` 同高（84px），换数据时不跳。 */
const RankRowSkeleton: React.FC = () => (
  <div className="flex h-[84px] w-full items-center gap-3 rounded-2xl border border-white/70 bg-white/60 py-2 pl-2.5 pr-3">
    <span className="h-7 w-7 shrink-0 animate-pulse rounded-lg bg-slate-200/80" />
    <div className="h-[68px] w-[51px] shrink-0 animate-pulse rounded-lg bg-slate-200/80" />
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="h-3 w-2/3 animate-pulse rounded bg-slate-200/80" />
      <div className="h-2.5 w-1/3 animate-pulse rounded bg-slate-200/60" />
    </div>
  </div>
);

export const HomeShelf: React.FC<HomeShelfProps> = ({
  title,
  subtitle,
  items,
  onClick,
  onUnavailable,
  loading = false,
  onMore,
  accent = 'rose',
  icon,
  iconTone,
  variant = 'row',
  metricOf,
}) => {
  const isRank = variant === 'rank';
  const isRow = variant === 'row';
  const railRef = useRef<HTMLDivElement | null>(null);
  const [canScrollPrev, setCanScrollPrev] = useState(false);
  const [canScrollNext, setCanScrollNext] = useState(false);
  const isEmpty = !loading && items.length === 0;
  const accentClass = accent === 'rose' ? 'bg-rose-500' : 'bg-blue-500';
  const showSkeleton = loading && items.length === 0;

  const updateRailButtons = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const maxScroll = Math.max(0, rail.scrollWidth - rail.clientWidth);
    setCanScrollPrev(rail.scrollLeft > 2);
    setCanScrollNext(maxScroll - rail.scrollLeft > 2);
  }, []);

  useEffect(() => {
    if (!isRow || showSkeleton) return;
    const rail = railRef.current;
    if (!rail) return;
    updateRailButtons();
    rail.addEventListener('scroll', updateRailButtons, { passive: true });
    const observer = new ResizeObserver(updateRailButtons);
    observer.observe(rail);
    return () => {
      rail.removeEventListener('scroll', updateRailButtons);
      observer.disconnect();
    };
  }, [isRow, showSkeleton, items.length, updateRailButtons]);

  const scrollRail = useCallback((direction: -1 | 1) => {
    railRef.current?.scrollBy({
      left: direction * Math.max(240, railRef.current.clientWidth * 0.82),
      behavior: 'smooth',
    });
  }, []);

  if (isEmpty) return null;

  return (
    <section className="flex shrink-0 flex-col gap-3">
      <div className="flex items-end justify-between gap-3">
        <div className="flex items-start gap-2">
          <span className={`mt-1 h-5 w-1 rounded-full ${accentClass}`} aria-hidden="true" />
          {icon && (
            <ShelfBadge icon={icon} tone={iconTone ?? (accent === 'rose' ? 'rose' : 'blue')} />
          )}
          <div>
            <h2 className="text-base font-extrabold tracking-tight text-slate-900">{title}</h2>
            <p className="mt-0.5 text-[11px] text-slate-400">{subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-slate-400 hidden sm:inline">
            {isRow
              ? `${items.length} 部 · ${items.length <= AUTO_FIT_MAX ? '本栏精选' : '左右翻页'}`
              : isRank
              ? '按名次排序'
              : '本栏精选'}
          </span>
          {onMore && (
            <button
              type="button"
              onClick={onMore}
              className="inline-flex h-8 items-center gap-0.5 rounded-lg pr-1.5 pl-3 text-xs font-bold text-slate-500 transition-colors hover:bg-white hover:text-blue-600 active:scale-95 cursor-pointer"
              title={`查看全部${title}`}
              aria-label={`查看全部${title}`}
            >
              <span>更多</span>
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {isRank ? (
        <div className="ttv-grid-in flex flex-col gap-2">
          {showSkeleton
            ? Array.from({ length: 5 }).map((_, index) => <RankRowSkeleton key={index} />)
            : items.map((series, index) => (
                <RankRow
                  key={series.id}
                  series={series}
                  rank={index + 1}
                  accent={accent}
                  onClick={onClick}
                  metric={metricOf?.(series, index)}
                />
              ))}
        </div>
      ) : isRow && autoFitColumns(items.length) && !showSkeleton ? (
        /*
          自适应 Grid：4–6 条时铺满整行，1–3 条时按固定卡宽排开（不拉伸）。
          与横滑轨道互斥，两者不要同时出现在一条栏目里。
        */
        <div
          className="ttv-grid-in grid gap-3"
          style={{ gridTemplateColumns: autoFitColumns(items.length) ?? undefined }}
        >
          {items.map((series, index) => (
            <SeriesCard
              key={series.id}
              series={series}
              index={index}
              accent={accent}
              onClick={onClick}
              onUnavailable={onUnavailable}
            />
          ))}
        </div>
      ) : isRow ? (
        /*
          平铺 + 横滚。

          ## 为什么不用 `grid` + `overflow-x-auto`
          网格的列数由断点决定，滚动容器的宽度就是可视宽度，列数一旦铺满就不再有
          溢出——"横滚"根本不出现。这里改用 `flex + shrink-0`：卡片宽度固定，
          容器 `overflow-x-auto`，放不下就一定能滚。

          ## 为什么保留 `pb-2`
          横滚轴是 6px 的全局细条（mica.css 第 90 行）。不给底部留两像素，滚动条
          会直接压在卡片的圆角上，看起来像裁切事故。

          ## `snap-x` 只是手感
          松手后停在卡片边界，而不是半张卡露在外面。它不影响"滚到最右是最后一名"
          这个语义——`snap-mandatory` 到一个整卡位置，最后一格就是末位那张。
        */
        <div className="relative -mx-1">
          <div
            ref={railRef}
            className="ttv-grid-in flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-1 ttv-shelf-rail ttv-no-scrollbar"
            aria-label={`${title}卡片列表`}
          >
          {showSkeleton
            ? Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="shrink-0 snap-start" style={{ width: RAIL_CARD_WIDTH }}>
                  <SeriesCardSkeleton />
                </div>
              ))
            : items.map((series, index) => (
                <div key={series.id} className="shrink-0 snap-start" style={{ width: RAIL_CARD_WIDTH }}>
                  <SeriesCard
                    series={series}
                    index={index}
                    accent={accent}
                    onClick={onClick}
                    onUnavailable={onUnavailable}
                  />
                </div>
              ))}
          </div>
          {!showSkeleton && canScrollPrev && (
            <button
              type="button"
              onClick={() => scrollRail(-1)}
              aria-label={`查看${title}上一页`}
              className="absolute left-2 top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/90 bg-white/90 text-slate-600 shadow-fluent transition hover:bg-white hover:text-blue-600 active:scale-95"
            >
              <ChevronRight className="h-4 w-4 rotate-180" />
            </button>
          )}
          {!showSkeleton && canScrollNext && (
            <button
              type="button"
              onClick={() => scrollRail(1)}
              aria-label={`查看${title}下一页`}
              className="absolute right-2 top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/90 bg-white/90 text-slate-600 shadow-fluent transition hover:bg-white hover:text-blue-600 active:scale-95"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          )}
        </div>
      ) : (
        /*
          列数只用 2 / 3 / 4 / 6，**刻意跳过 5**。

          货架装 6 条，5 列下排布是 5 + 1 —— 第二行孤零零挂一张卡，看起来像布局
          塌了。这里原来正是五列那档断点，1024–1280 窗口宽度下必然踩到。

          注：上面的类名刻意不写成完整形式 —— Tailwind 的提取器会扫**注释原文**，
          注释里出现一个合法的类名就会真的把它编进产物。
        */
        <div className="ttv-grid-in grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
          {showSkeleton
            ? Array.from({ length: 6 }).map((_, index) => <SeriesCardSkeleton key={index} />)
            : items.map((series, index) => (
                <SeriesCard
                  key={series.id}
                  series={series}
                  index={index}
                  accent={accent}
                  onClick={onClick}
                  onUnavailable={onUnavailable}
                />
              ))}
        </div>
      )}
    </section>
  );
};
