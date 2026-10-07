import React from 'react';
import { ChevronRight } from 'lucide-react';
import { SeriesItem } from '../../types/catalog';
import { SeriesCard } from './SeriesCard';

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
}

export const HomeShelf: React.FC<HomeShelfProps> = ({
  title,
  subtitle,
  items,
  onClick,
  onUnavailable,
  loading = false,
  onMore,
  accent = 'rose',
}) => {
  if (!loading && items.length === 0) return null;
  const accentClass = accent === 'rose' ? 'bg-rose-500' : 'bg-blue-500';
  const showSkeleton = loading && items.length === 0;

  return (
    <section className="flex shrink-0 flex-col gap-3">
      <div className="flex items-end justify-between gap-3">
        <div className="flex items-start gap-2">
          <span className={`mt-1 h-5 w-1 rounded-full ${accentClass}`} aria-hidden="true" />
          <div>
            <h2 className="text-base font-extrabold tracking-tight text-slate-900">{title}</h2>
            <p className="mt-0.5 text-[11px] text-slate-400">{subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-slate-400 hidden sm:inline">本栏精选</span>
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
      {/*
        列数只用 2 / 3 / 4 / 6，**刻意跳过 5**。

        货架固定装 6 条（`slice(0, 6)`），而 6 条在 5 列下的排布是 5 + 1 ——
        第二行孤零零挂一张卡，看起来像布局塌了。这里原来正是五列那档断点，
        1024–1280 窗口宽度下必然踩到。6 列则刚好一行装完。

        注：上面的类名刻意不写成完整形式 —— Tailwind 的提取器会扫**注释原文**，
        注释里出现一个合法的类名就会真的把它编进产物。
      */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
        {showSkeleton
          ? Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="flex flex-col gap-2">
                <div className="w-full aspect-[3/4] rounded-2xl shimmer-loading shadow-xs" />
                <div className="h-4 w-3/4 rounded shimmer-loading" />
              </div>
            ))
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
    </section>
  );
};
