import React from 'react';
import { ChevronRight, RotateCcw, TrendingUp } from 'lucide-react';
import type { HongguoRankBoard, HongguoRankContent, HongguoRankItem } from '../../services/ipc';
import { SeriesCard } from './SeriesCard';
import { SeriesCardSkeleton } from './SeriesCardSkeleton';
import { ShelfBadge } from './ShelfBadge';

/**
 * 首页「热度排行榜」专区 —— 平铺一行 + 横向滚动。
 *
 * ## 与首页其它货架的关系
 *
 * 会话 A 最初给这一栏做的是 Netflix Top10 式「超大排名数字 + 海报」，但用户在
 * 后续会话里明确改口：**首页排行全部改成平铺、只占一行、其余靠横向滚动条**，
 * 顺序即名次，滚到最右就是这一栏的最后一名。所以这里现在与其它四块货架用同一份
 * `SeriesCard`、同一个 148px 卡宽、同一条 `.ttv-shelf-rail` 横滚轴，只在每张卡
 * 上方留一枚小小的名次胶囊 + 服务端原文的热度/推广文案。
 *
 * 这样「榜」的语义还在（能看见第几名、能切榜），但不会再往首页塞第二套卡片体系。
 *
 * ## 数据源
 *
 * `hongguo_short_rank`（`ipcService.hongguo.shortRank`）。一次返回三样东西：
 *   - `items`：按名次排好的行，带服务端给的热度文案（`score`）与 `promoted`；
 *   - `contents`：可切换的内容分类，每类下面还有 `boards`（子榜）；
 *   - `content` / `board`：服务端**实际**选中的那一组。
 *
 * Tab 的文案、数量、选中项全部由服务端决定，前端只把用户点的那一项原样回传。
 * 不编造「日榜/周榜/月榜」这种站方可能根本没给的口径，也不画涨跌箭头——
 * 数据里没有「上周第几名」，凭空画一个就是在编事实。
 *
 * ## 分页
 *
 * 首页只取第一页前十条（`RANK_PREVIEW_COUNT`）。完整榜单交给「更多」落地页；
 * 继续翻页要带后端产出的不透明游标，那属于落地页的职责。
 */

/** 首页只铺十条：再多就不是「专区」而是整页榜单了。 */
export const RANK_PREVIEW_COUNT = 10;

/** 与其它货架的横滑卡片同宽（见 `HomeShelf.RAIL_CARD_WIDTH`）——同页两排卡片
 *  宽度不一致会让横滑手感忽轻忽重。 */
const RAIL_CARD_WIDTH = 148;

/** 前三名的名次胶囊：金 / 银 / 铜；第 4 名起中性灰。 */
const RANK_BADGE_CLASS: Record<number, string> = {
  1: 'bg-gradient-to-b from-amber-400 to-orange-500 text-white shadow-[0_2px_8px_rgba(245,158,11,0.35)]',
  2: 'bg-gradient-to-b from-slate-300 to-slate-500 text-white shadow-[0_2px_8px_rgba(100,116,139,0.28)]',
  3: 'bg-gradient-to-b from-amber-600 to-amber-800 text-white shadow-[0_2px_8px_rgba(180,83,9,0.30)]',
};

interface RankingRailProps {
  items: HongguoRankItem[];
  /** 服务端给的内容分类（综合 / 短剧 / 漫剧 …）。 */
  contents: HongguoRankContent[];
  /** 当前分类下的子榜（日榜 / 周榜 …）。为空表示这个分类没有子榜。 */
  boards: HongguoRankBoard[];
  /** 服务端实际选中的分类 / 子榜 id。 */
  activeContent: string;
  activeBoard: string;
  onSelectContent: (contentId: string) => void;
  onSelectBoard: (boardId: string) => void;
  onClick: (seriesId: string) => void;
  /** 切换分类/子榜时的取数中状态：骨架与真实卡片同构，换榜不会把页面顶下去。 */
  loading?: boolean;
  /** 取数失败。**不渲染假数据**：留着上一次的榜单；一条都没有时亮手动重试块。 */
  error?: string | null;
  /** 失败后的手动重试（自动重试由 RankingSection 负责，这里只留入口）。 */
  onRetry?: () => void;
  /** 进入完整榜单页。 */
  onMore?: () => void;
}

/** 骨架：名次胶囊 + 一张与真实卡片同高的占位，仍只占一行。 */
const RankCardSkeleton: React.FC = () => (
  <div className="shrink-0" style={{ width: RAIL_CARD_WIDTH }}>
    <div className="mb-1.5 h-5 w-12 animate-pulse rounded-md bg-slate-200/80" />
    <SeriesCardSkeleton />
  </div>
);

export const RankingRail: React.FC<RankingRailProps> = ({
  items,
  contents,
  boards,
  activeContent,
  activeBoard,
  onSelectContent,
  onSelectBoard,
  onClick,
  loading = false,
  error = null,
  onRetry,
  onMore,
}) => {
  const rows = items.slice(0, RANK_PREVIEW_COUNT);
  const showSkeleton = loading && rows.length === 0;
  /*
   * 空榜单的两种去向（2026-11-07「排行榜有概率消失」）：
   * - 连托盘都没有（服务端什么都没给）→ 整块消失，与 HomeShelf 一致；
   * - 托盘还在、只是当前榜被内容类型过滤清空了（如整榜都是漫剧的"热搜榜"
   *   出现在短剧频道）→ **不能消失**：那是正常状态，消失等于"排行榜坏了"，
   *   亮出提示块（见下面轨道分支）。
   */
  if (!loading && rows.length === 0 && !error && contents.length === 0) return null;

  /** 分类多于一个才渲染 Tab —— 只有一个时那颗按钮点了也不会变，纯噪音。 */
  const showContents = contents.length > 1;
  const showBoards = boards.length > 1;
  /*
   * 高亮只认 `activeContent` / `activeBoard` **一个事实来源**。旧实现叠加了
   * 服务端的 `selected` 标记——那是**上一次响应**的快照，用户点新榜后、响应
   * 到达前，旧榜靠 selected 亮着、新榜靠 activeContent 也亮着，两颗同时高亮
   * （用户截图正是这个状态）；响应到达后 selected 才校正。
   */
  const activeContentName =
    contents.find(item => item.id === activeContent)?.name ||
    contents.find(item => item.selected)?.name ||
    '综合';

  return (
    <section className="flex shrink-0 flex-col gap-3">
      {/* 标题行：色标 + 标题 + 服务端榜名；右侧是「更多」入口 */}
      <div className="flex items-end justify-between gap-3">
        <div className="flex items-start gap-2">
          <span className="mt-1 h-5 w-1 rounded-full bg-gradient-to-b from-amber-400 to-rose-500" aria-hidden="true" />
          <div>
            <h2 className="flex items-center gap-1.5 text-base font-extrabold tracking-tight text-slate-900">
              <ShelfBadge icon={TrendingUp} tone="amber" />
              <span>热度排行榜</span>
            </h2>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {`红果 App 实时榜单 · ${activeContentName} · 榜单前十`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden text-[11px] font-medium text-slate-400 sm:inline">
            {rows.length} 部 · 横向滑动
          </span>
          {onMore && (
            <button
              type="button"
              onClick={onMore}
              className="inline-flex h-8 items-center gap-0.5 rounded-lg pr-1.5 pl-3 text-xs font-bold text-slate-500 transition-colors hover:bg-white hover:text-blue-600 active:scale-95 cursor-pointer"
              title="查看完整热度榜单"
              aria-label="查看完整热度榜单"
            >
              <span>更多</span>
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* 维度切换：分类（contents）+ 子榜（boards）。两个托盘沿用首页顶部的
          凹槽 + 凸起选中态，不引入第二套按钮体系。 */}
      {(showContents || showBoards) && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {showContents && (
            <div className="flex items-center gap-1 rounded-xl border border-slate-200/70 bg-slate-100/90 p-1 shadow-inner">
              {contents.map(content => {
                const active = content.id === activeContent;
                return (
                  <button
                    key={content.id}
                    type="button"
                    onClick={() => {
                      if (active) return;
                      onSelectContent(content.id);
                    }}
                    aria-pressed={active}
                    className={`rounded-lg px-3 py-1 text-[11px] font-bold transition-all duration-150 cursor-pointer ${
                      active
                        ? 'fluent-convex-tab text-blue-600'
                        : 'text-slate-600 hover:bg-white/50 hover:text-slate-900'
                    }`}
                  >
                    {content.name}
                  </button>
                );
              })}
            </div>
          )}
          {showBoards && (
            <div className="flex items-center gap-1 rounded-xl border border-slate-200/70 bg-slate-100/90 p-1 shadow-inner">
              {boards.map(board => {
                const active = board.id === activeBoard;
                return (
                  <button
                    key={board.id}
                    type="button"
                    onClick={() => {
                      if (active) return;
                      onSelectBoard(board.id);
                    }}
                    aria-pressed={active}
                    className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-all duration-150 cursor-pointer ${
                      active
                        ? 'bg-white text-amber-600 shadow-xs'
                        : 'text-slate-500 hover:bg-white/50 hover:text-slate-800'
                    }`}
                  >
                    {board.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/*
        平铺轨道：一行卡片 + 横向滚动，与其它货架完全一致。
        `snap-x` 只管手感；`snap-mandatory` 到整卡位置，最后一格就是末位那张。
        名次用小胶囊压在卡片上方，不再叠在海报上遮挡题材/评分角标。
      */}
      {/*
        平铺轨道：一行卡片 + 横向滚动，与其它货架完全一致。
        `snap-x` 只管手感；`snap-mandatory` 到整卡位置，最后一格就是末位那张。
        名次用小胶囊压在卡片上方，不再叠在海报上遮挡题材/评分角标。
        切榜取数中把整条压暗：给"点了、正在换"一个即时视觉反馈（乐观回显
        之外的第二重反馈），响应到达后恢复。
      */}
      <div
        className={`ttv-grid-in -mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-2 transition-opacity duration-150 ttv-shelf-rail ttv-no-scrollbar${
          loading && rows.length > 0 ? ' opacity-50' : ''
        }`}
      >
        {showSkeleton ? (
          Array.from({ length: 6 }).map((_, index) => <RankCardSkeleton key={index} />)
        ) : rows.length === 0 && error ? (
          <div className="flex w-full items-center justify-between rounded-2xl border border-white/80 bg-white/70 px-4 py-3">
            <p className="text-xs text-slate-500">榜单加载失败：{error}</p>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex h-8 items-center gap-1 rounded-lg bg-white px-3 text-xs font-bold text-blue-600 shadow-fluent transition-colors hover:bg-blue-50 active:scale-95 cursor-pointer"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>重试</span>
              </button>
            )}
          </div>
        ) : rows.length === 0 && !loading ? (
          /*
           * 取数成功但过滤后为空：这一榜的条目整榜都是其它内容类型（或未上线
           * 内容），按频道隔离被清空了。这不是故障——给一句说明 + 重试入口，
           * 让用户知道"切回来了没反应"和"榜是空的"是两回事。
           */
          <div className="flex w-full items-center justify-between rounded-2xl border border-white/80 bg-white/70 px-4 py-3">
            <p className="text-xs text-slate-500">该榜单当前没有可显示的内容（已按当前专区过滤其它类型条目）</p>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex h-8 items-center gap-1 rounded-lg bg-white px-3 text-xs font-bold text-blue-600 shadow-fluent transition-colors hover:bg-blue-50 active:scale-95 cursor-pointer"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>刷新</span>
              </button>
            )}
          </div>
        ) : (
          rows.map((row, index) => {
              const rank = row.position > 0 ? row.position : index + 1;
              const badge = RANK_BADGE_CLASS[rank] ?? 'bg-slate-200/90 text-slate-600';
              return (
                <div key={`${row.series.id}-${rank}`} className="shrink-0 snap-start" style={{ width: RAIL_CARD_WIDTH }}>
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <span
                      className={`inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md px-1 text-[10px] font-black tabular-nums ${badge}`}
                      title={`第 ${rank} 名${row.score ? ` · ${row.score}` : ''}`}
                      aria-label={`第 ${rank} 名`}
                    >
                      {rank}
                    </span>
                    <span
                      className={`truncate text-[10px] font-semibold tabular-nums ${
                        row.promoted ? 'text-slate-400' : 'text-amber-600/90'
                      }`}
                      title={row.score || `第 ${rank} 名`}
                    >
                      {row.score || `第 ${rank} 名`}
                    </span>
                  </div>
                  <SeriesCard
                    series={row.series}
                    index={index}
                    onClick={onClick}
                    /* 推广位在服务端是明确标记的，这里只把这一条事实标出来，
                       不额外美化也不隐藏。 */
                  />
                </div>
              );
            })
        )}
      </div>
    </section>
  );
};
