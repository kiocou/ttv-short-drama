import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Flame, Layers3, Play, RefreshCw, Star } from 'lucide-react';
import { ipcService } from '../../services/ipc';
import { SeriesDetail } from '../../types/series';
import { SeriesItem } from '../../types/catalog';
import { CoverImage } from './CoverImage';
import { FluentButton } from './FluentButton';
import { StatusBadge } from './StatusBadge';

/**
 * 「继续观看」与「猜你喜欢」并轨双卡的**共用外壳**。
 *
 * 两张卡必须逐字一致 —— 只要有一处类名分叉（比如少个 `min-h`），并排时高度就会
 * 差几个像素，而卡片上下沿一错位，整行立刻显得是"凑"出来的。所以外壳抽成常量由
 * 双方共用，各自的差异只允许留在**配色**上（左侧色条 + 徽章色）。
 *
 * 尺寸是算出来的：封面 `h-32 w-24`（128×96，严格 3:4），外壳 `p-3.5`（14px），
 * 于是 `128 + 14×2 = 156`，与 `min-h-[156px]` 正好对齐。
 */
export const PICK_CARD_SHELL =
  'group relative flex min-h-[156px] items-center gap-4 overflow-hidden rounded-2xl border border-white/90 p-3.5 shadow-fluent-lg fluent-raised-island transition-all duration-300 hover:-translate-y-0.5 animate-fluent-card-in';

interface RandomWatchSectionProps {
  items: SeriesItem[];
  onWatch: (series: SeriesItem, detail: SeriesDetail) => void;
  /**
   * 宿主控制并轨宽度。与「继续观看」同排时两列各占一半；没有「继续观看」
   * 时独占整行。组件自己不猜列数——列宽由宿主的 grid 决定。
   */
  className?: string;
}

/**
 * 与组件内部同一套筛选口径，供宿主在并轨前判断「猜你喜欢」这次到底会不会渲染。
 *
 * 必须导出而不是让宿主自己抄一遍 `item.id && item.title`：口径一旦分叉，
 * 宿主就会按"有内容"排成两列，而组件实际返回 `null`，结果「继续观看」
 * 孤零零占着半屏——这正是并轨最容易出的那种静态错位。
 */
export function hasRandomCandidates(items: SeriesItem[]): boolean {
  return items.some(item => Boolean(item.id && item.title));
}

function formatHeat(value?: number): string {
  if (!value || value <= 0) return '热度未提供';
  if (value >= 10_000) return `${(value / 10_000).toFixed(value >= 100_000 ? 0 : 1)}万热度`;
  return `${value.toLocaleString()} 热度`;
}

/**
 * 「猜你喜欢」随机推荐卡。
 *
 * ## 与「继续观看」的关系
 *
 * 两块在发现页**并轨同排**（见 `ExploreView`），共用 `PICK_CARD_SHELL` 骨架，
 * 只在配色上分家：「继续观看」蓝（进度语义），这里紫（随机语义）。
 *
 * ## 动作层级
 *
 * 「换一部」是**对整个卡片的刷新**，不是仅次于「立即观看」的第二主操作 ——
 * 它原来带文字和主按钮并排，两个按钮一起抢注意力，反而把真正的行动点稀释了。
 * 现在收成右侧一个纯图标按钮，转圈反馈照旧跟着它自己转。
 *
 * ## 尺寸
 *
 * 封面 `96×128`（严格 3:4）。之前的 `84×112` 是迁就 140px 行高的妥协值；
 * 并轨把「猜你喜欢」从"整行的一个小条"变成半屏大卡之后，行高可以放到 156px，
 * 封面也就跟着长到 128 —— 用户最初抱怨的就是"太小，看不清"。
 */
export const RandomWatchSection: React.FC<RandomWatchSectionProps> = ({
  items,
  onWatch,
  className = '',
}) => {
  const candidates = useMemo(
    () => items.filter(item => item.id && item.title).slice(0, 24),
    [items],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SeriesDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(false);

  const selectRandom = useCallback(() => {
    if (candidates.length === 0) return;
    const pool = candidates.filter(item => item.id !== selectedId);
    const next = (pool.length > 0 ? pool : candidates)[Math.floor(Math.random() * (pool.length || candidates.length))];
    setSelectedId(next.id);
  }, [candidates, selectedId]);

  useEffect(() => {
    if (candidates.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !candidates.some(item => item.id === selectedId)) {
      setSelectedId(candidates[Math.floor(Math.random() * candidates.length)].id);
    }
  }, [candidates, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    setIsLoading(true);
    setError(false);
    setDetail(null);
    void ipcService.series.getDetail(selectedId)
      .then(next => {
        if (active) setDetail(next);
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedId]);

  const series = candidates.find(item => item.id === selectedId);
  if (!series) return null;

  const episode = detail?.episodes.find(item => (item.watchedSeconds || 0) > 0 && !item.isFinished)
    || detail?.episodes[0];
  const tagLine = series.tags.slice(0, 3).join(' · ');
  const episodeCount = detail?.episodes.length || series.episodesCount || 0;
  const canWatch = Boolean(detail && episode) && !isLoading && !error;

  return (
    <section
      aria-label="猜你喜欢"
      onClick={() => { if (canWatch && detail) onWatch(series, detail); }}
      className={`${PICK_CARD_SHELL} cursor-pointer bg-gradient-to-r from-violet-50/80 via-white/92 to-white/88 ${className}`}
    >
      {/* 左侧色条：与「继续观看」的蓝条对称，是两张卡唯一允许存在的语义色差 */}
      <span aria-hidden="true" className="absolute inset-y-3 left-0 w-[3px] rounded-r-full bg-violet-500" />

      {/*
        详情在途期间，封面与信息列一起轻微下沉 + 淡出；拿到数据后归位。
        首次挂载时这就是**入场**动效，点「换一部」时就是**切换反馈** —— 同一套
        机制两处收益。没有它的话，"换一部"点下去内容只是静静变掉，看着像没反应。

        刻意用 transition 而不是 keyframes：视图是常驻 DOM + `display:none` 的，
        在隐藏祖先里创建的 CSS animation 会永久卡在 0% 帧（见 `tailwind.config.js`
        里 `fluent-card-in` 那条长注释）。action 列不参与淡出 —— 按钮不该跟着闪。
      */}
      <div
        className={`flex min-w-0 flex-1 items-center gap-4 transition-all duration-300 ease-out ${
          isLoading ? 'translate-y-0.5 opacity-60' : 'translate-y-0 opacity-100'
        }`}
      >
        <div className="relative h-32 w-24 shrink-0 overflow-hidden rounded-xl border border-white/90 bg-slate-100 shadow-xs">
          <CoverImage
            src={series.cover}
            title={series.title}
            placeholderTextClassName="text-2xl"
            className="transition-transform duration-300 group-hover:scale-105"
            loading="eager"
            resolveSrc={series.id.startsWith('guo:') ? () => ipcService.catalog.guoCover(series.id) : undefined}
          />
        </div>

        <div className="flex min-w-0 flex-1 flex-col justify-center gap-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <StatusBadge label="猜你喜欢" variant="purple" size="sm" dot />
            {series.rating ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-bold text-amber-600">
                <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                {series.rating.toFixed(1)}
              </span>
            ) : null}
            <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-slate-500">
              <Flame className="h-3 w-3 shrink-0 text-orange-500" />
              <span className="truncate">{formatHeat(series.heat)}</span>
            </span>
          </div>

          <h3 className="truncate text-base font-extrabold tracking-tight text-slate-900">
            {series.title}
          </h3>

          <p className="line-clamp-1 text-[11.5px] leading-relaxed text-slate-500">
            {series.brief || '打开详情查看内容简介'}
          </p>

          <span className="flex min-w-0 items-center gap-1 text-[10.5px] text-slate-400">
            <Layers3 className="h-3 w-3 shrink-0" />
            <span className="truncate">{episodeCount} 集{tagLine ? ` · ${tagLine}` : ''}</span>
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {/* 纯图标：它是对整卡的刷新，不是第二主操作，不该和「立即观看」抢注意力 */}
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); selectRandom(); }}
          title="换一部随机内容"
          aria-label="换一部随机内容"
          className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-violet-50 hover:text-violet-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
        <FluentButton
          variant="primary"
          size="sm"
          icon={<Play className="h-3 w-3 fill-current" />}
          disabled={!canWatch}
          onClick={(event) => {
            event.stopPropagation();
            if (canWatch && detail) onWatch(series, detail);
          }}
        >
          {isLoading ? '准备中' : error ? '不可用' : '立即观看'}
        </FluentButton>
      </div>
    </section>
  );
};
