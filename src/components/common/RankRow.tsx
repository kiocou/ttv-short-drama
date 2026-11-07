import React from 'react';
import { Play } from 'lucide-react';
import { coverResolver } from '../../services/ipc';
import { SeriesItem } from '../../types/catalog';
import { CoverImage } from './CoverImage';

/**
 * 榜单行：一行一部剧，左侧名次。
 *
 * ## 为什么不再用海报网格
 *
 * 首页的「正在热播 / 新剧 / App 推荐 / 红果短剧榜 / 上新日历」五块原本都是 3:4
 * 海报网格。五块 × 6 张 = 30 张大海报铺满首屏，真正要看的信息（叫什么、多少集、
 * 排第几）全被压在海报下面，而且五块之间长得一模一样——用户滚到第三块就分不清
 * 自己在看哪一栏（用户报告："这些卡片平铺得太散，收纳一下"）。
 *
 * 榜单行把每一栏读成"一条名次列表"：名次是第一眼信息，标题、集数、来源在同一行
 * 里横向读完，一栏 5 行刚好一屏可见，五栏纵向叠起来仍然比原来的网格矮。这是
 * 友商榜单页（红果/抖音短剧的"热播榜"）的通行形态，也是"排行榜"这个语义真正
 * 对应的排布。
 *
 * ## 名次配色只给前三
 *
 * 金 / 银 / 铜是榜单的通用语言；第 4 名以后再用彩色只会让列表变花，所以一律
 * 中性灰。名次是**位置**，不是评分——这里刻意不画进度条也不画涨跌箭头：
 * 数据源没有"上周排名"，凭空画一条涨跌就是在编数据。
 */

/** 前三名的专属配色；其余走中性。 */
const PODIUM_CLASS: Record<number, string> = {
  1: 'bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-[0_2px_10px_rgba(245,158,11,0.45)]',
  2: 'bg-gradient-to-br from-slate-300 to-slate-400 text-white shadow-[0_2px_8px_rgba(100,116,139,0.35)]',
  3: 'bg-gradient-to-br from-amber-600 to-amber-800 text-white shadow-[0_2px_8px_rgba(180,83,9,0.35)]',
};

interface RankRowProps {
  series: SeriesItem;
  /** 1 起的名次。 */
  rank: number;
  onClick: (seriesId: string) => void;
  /**
   * 右侧的次要指标文案（热度 / 票数 / 上线日期）。
   *
   * 由宿主决定传什么：只有"这一栏的数据源真的给了这个数"时才传。传空字符串
   * 表示留空，**不要**用集数凑一个假指标。
   */
  metric?: string;
  accent?: 'rose' | 'blue';
}

/**
 * 一行的高度固定为 84px（`py-2` + 68px 封面 + 边框），五行走廊刚好压在海报网格
 * 两行的高度以内。封面用 3:4（51×68）而不是方形：短剧海报就是竖的，方形会裁掉
 * 人物脸。
 */
export const RankRow: React.FC<RankRowProps> = React.memo(({ series, rank, onClick, metric, accent = 'rose' }) => {
  const podium = PODIUM_CLASS[rank];
  const tag = series.tags[0] || '';
  const meta = [
    series.episodesCount > 0 ? `${series.episodesCount} 集` : '',
    series.origin ? series.origin : '',
  ].filter(Boolean).join(' · ');

  return (
    <button
      type="button"
      onClick={() => onClick(series.id)}
      title={series.title}
      className="group flex w-full cursor-pointer items-center gap-3 rounded-2xl border border-white/85 bg-white/85 py-2 pl-2.5 pr-3 text-left shadow-xs transition-colors duration-150 hover:border-white hover:bg-white active:scale-[0.995]"
    >
      {/* 名次 */}
      <span
        aria-hidden="true"
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[12px] font-extrabold tabular-nums ${
          podium ?? 'bg-slate-100 text-slate-500'
        }`}
      >
        {rank}
      </span>

      {/* 封面 3:4 */}
      <div className="relative h-[68px] w-[51px] shrink-0 overflow-hidden rounded-lg border border-white/80 bg-slate-100">
        <CoverImage
          src={series.cover}
          title={series.title}
          placeholderTextClassName="text-base"
          className="transition-transform duration-300 group-hover:scale-105"
          resolveSrc={coverResolver(series.id, series.cover)}
        />
        {series.rating && series.rating > 0 ? (
          <span className="absolute right-0.5 top-0.5 rounded bg-black/65 px-1 py-[1px] text-[9px] font-bold text-amber-300 tabular-nums">
            {series.rating.toFixed(1)}
          </span>
        ) : null}
      </div>

      {/* 文案 */}
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        <div className="flex min-w-0 items-center gap-1.5">
          {tag ? (
            <span
              className={`shrink-0 rounded px-1 py-[1px] text-[9.5px] font-bold ${
                accent === 'rose' ? 'bg-rose-50 text-rose-500' : 'bg-blue-50 text-blue-500'
              }`}
            >
              {tag}
            </span>
          ) : null}
          <span className="truncate text-[13px] font-extrabold tracking-tight text-slate-900">
            {series.title}
          </span>
        </div>
        <p className="truncate text-[10.5px] font-medium text-slate-400">
          {meta || '剧集信息待补全'}
        </p>
      </div>

      {/* 指标 + 悬停播放 */}
      <div className="flex shrink-0 items-center gap-2.5">
        {metric ? (
          <span className="hidden text-[10.5px] font-semibold text-slate-400 sm:inline tabular-nums">
            {metric}
          </span>
        ) : null}
        <span
          aria-hidden="true"
          className={`flex h-7 w-7 items-center justify-center rounded-full transition-all duration-150 ${
            accent === 'rose'
              ? 'bg-rose-500/10 text-rose-500 group-hover:bg-rose-500 group-hover:text-white'
              : 'bg-blue-500/10 text-blue-500 group-hover:bg-blue-500 group-hover:text-white'
          }`}
        >
          <Play className="h-3 w-3 fill-current" />
        </span>
      </div>
    </button>
  );
});

RankRow.displayName = 'RankRow';
