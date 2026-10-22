import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Layers3, Sparkles, X } from 'lucide-react';
import { ipcService } from '../../services/ipc';
import {
  currentSeasonLabel,
  fetchSeriesSeasons,
  type SeasonPick,
} from '../../services/relatedSeries';
import type { SeriesDetail } from '../../types/series';
import { SeriesCard } from './SeriesCard';
import { SeriesCardSkeleton } from './SeriesCardSkeleton';

/**
 * 弹窗内的网格列数。
 *
 * 弹窗宽 `max-w-5xl`（1024px）、内边距 24×2，可用约 976px。5 列时每张卡约 182px
 * （3:4 海报高 243px），与详情页「猜你喜欢」那一栏的观感一致；再往上排 6 列会让
 * 卡片缩到 150px 以下，季号角标和题材 chip 就会挤在一起。
 *
 * 断点跟着**视口**走（Tailwind 的行为），所以窄窗口下自动退到 4/3/2 列。
 */
const SEASON_GRID_CLASS = 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 sm:gap-4';

interface SeriesSeasonsDialogProps {
  /** 当前正在看的这一季。它的季号用于**排除**与文案，不会出现在网格里。 */
  detail: SeriesDetail;
  /** 点某一季的卡片：跳转到那一部的详情。 */
  onOpen: (seriesId: string) => void;
  onClose: () => void;
}

/** 悬停预取详情：卡片被瞄到时先发那一发请求，点下去就是秒开。 */
function prefetchDetail(seriesId: string): void {
  void ipcService.series.getDetail(seriesId).catch(() => {});
}

/**
 * 「系列剧」弹窗：把当前这部剧**其它所有季**铺成卡片网格。
 *
 * ## 为什么是弹窗而不是详情页里的第三栏
 *
 * 用户提的两条要求是配套的：猜你喜欢里**不要**再出现同系列（那一栏回答"下一部看
 * 什么"），同系列要能**完整**看到。完整看到意味着不能是"一屏 6 张 + 换一批"——
 * 一个 14 季的系列得点三次才看得全。弹窗能一次铺开、又不占详情页的常驻版面，
 * 点开才拉数据（两次搜索往返），关掉就没了。
 *
 * ## 当前季为什么不在里面（用户明确要求）
 *
 * 用户的原话：*看的是《聚宝盆》第4季，新窗口不显示第4季，而是展示其他季*。
 * 这件事在**数据层**就完成了（`pickSeasons` 的 `itemLabel.season === label.season`
 * 一条），组件里不再做二次过滤 —— 两处各过滤一次，日后改动必然漂移成"数据层漏了
 * 一季、组件层补上了"这种看不出问题的问题。
 *
 * 顺带一提，被排除的不只是"同一个 id"，而是**同一季号的任何条目**：站上同一季可能
 * 有来自不同来源的两个 id，按 id 排除的话第 4 季会以另一张卡的形式出现在窗口里，
 * 而那正是用户说"不要"的东西。
 *
 * ## 三条时序约束
 *
 * 1. **打开才发请求**：详情页常驻 DOM，跟着详情一起拉等于每进一部剧就打两次搜索。
 * 2. **关掉作废在途请求**：用户点开又立刻关掉时，回来的结果不该再写进 state
 *    （否则下次打开会先闪一帧上一部剧的季卡）。
 * 3. **换剧重置**：本组件由详情页按 `detail.id` 挂载/卸载，换剧时随详情页一起重挂。
 */
export const SeriesSeasonsDialog: React.FC<SeriesSeasonsDialogProps> = ({
  detail,
  onOpen,
  onClose,
}) => {
  const [seasons, setSeasons] = useState<SeasonPick[] | null>(null);
  const requestIdRef = useRef(0);

  /**
   * 当前季基准。**用 `currentSeasonLabel` 而不是裸的 `parseSeasonLabel`**：
   * 站方对第一季常常只写裸剧名（《聚宝盆》而不是《聚宝盆》第1季），裸名解析
   * 不出季号，旧写法会让头部徽章整个不渲染，看起来像"这部剧没有季"。
   */
  const currentLabel = useMemo(() => currentSeasonLabel(detail), [detail]);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    setSeasons(null);
    void fetchSeriesSeasons(detail)
      .then(result => {
        if (requestId !== requestIdRef.current) return;
        setSeasons(result);
      })
      .catch(() => {
        if (requestId !== requestIdRef.current) return;
        // 两路搜索都在 `fetchSeriesSeasons` 里用 allSettled 收口了，走到这里说明是
        // 意料之外的异常。按"没有其它季"呈现，不弹错误提示——这是增量信息。
        setSeasons([]);
      });

    return () => {
      if (requestId === requestIdRef.current) requestIdRef.current += 1;
    };
  }, [detail]);

  /**
   * Esc 关闭。
   *
   * 挂到 `document` 而不是弹窗根节点上：详情页是常驻 DOM、焦点未必在弹窗内
   * （用户点开按钮后焦点仍在按钮上），只在元素上监听就收不到这一下。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  /**
   * 点某一季：先关窗再跳转。
   *
   * 跳转会换掉 `selectedSeriesId`，详情页随之按新 id 重挂（见 App.tsx 的
   * `workspaceKey`），弹窗本来也会消失；显式关一次是为了**同 id 重进**的情形
   * （例如从这一季点回自己那一部）——那时不会重挂，弹窗会留在屏幕上。
   */
  const handleOpen = useCallback(
    (seriesId: string) => {
      onClose();
      onOpen(seriesId);
    },
    [onClose, onOpen],
  );

  const nextCount = seasons?.filter(pick => pick.relation === 'next').length ?? 0;
  const prevCount = seasons?.filter(pick => pick.relation === 'previous').length ?? 0;

  const subtitle = useMemo(() => {
    if (!seasons) return '正在整理这个系列的各季…';
    if (seasons.length === 0) return '这个系列暂时没有其它季可看';
    if (nextCount > 0 && prevCount > 0) return `后续 ${nextCount} 季 · 前作 ${prevCount} 季`;
    if (nextCount > 0) return `后续 ${nextCount} 季`;
    return `前作 ${prevCount} 季`;
  }, [nextCount, prevCount, seasons]);

  return (
    <div
      onClick={onClose}
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/40 backdrop-blur-sm animate-fade-in select-none"
    >
      <div
        onClick={event => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`${detail.title} 的系列剧`}
        className="w-full max-w-5xl max-h-[80vh] rounded-3xl bg-white/95 backdrop-blur-2xl border border-white shadow-fluent-hud flex flex-col overflow-hidden animate-fluent-scale-in"
      >
        {/* 顶部栏：与「全部选集」弹窗同一套尺寸与配色，两个弹窗并排看不出差别。 */}
        <div className="h-14 px-6 flex items-center justify-between border-b border-black/[0.05] bg-slate-50/70 flex-shrink-0">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="w-8 h-8 shrink-0 rounded-lg bg-violet-50 text-violet-600 flex items-center justify-center border border-violet-200/60">
              <Layers3 className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="flex items-center gap-1.5 text-sm font-bold text-slate-800">
                <span>系列剧</span>
                {currentLabel && (
                  <span className="rounded-md bg-slate-200/70 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">
                    正在看第{currentLabel.season}
                    {currentLabel.unit}
                  </span>
                )}
              </h3>
              <p className="mt-0.5 truncate text-[11px] text-slate-400">
                {currentLabel ? currentLabel.base : detail.title} · {subtitle}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            title="关闭"
            className="shrink-0 p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 内容区：季卡网格。当前季**不在**这里（数据层已排除）。 */}
        <div className="flex-1 overflow-y-auto p-6">
          {!seasons ? (
            <div className={SEASON_GRID_CLASS} aria-busy="true">
              {Array.from({ length: 5 }).map((_, index) => (
                <SeriesCardSkeleton key={index} />
              ))}
            </div>
          ) : seasons.length === 0 ? (
            /*
              空状态。三种成因（本来不分季 / 只有这一季 / 搜索两路都失败）在用户
              视角是同一件事，所以只给一句话 + 一个明确的出口，不编造"暂无数据"
              之类的模糊措辞，也不假装是加载中。
            */
            <div className="flex flex-col items-center justify-center gap-2.5 py-14 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-50 text-violet-500">
                <Sparkles className="h-5 w-5" />
              </span>
              <p className="text-sm font-bold text-slate-700">这个系列暂时没有其它季</p>
              <p className="max-w-sm text-xs leading-relaxed text-slate-400">
                站上目前只收录了这一季。换个来源或稍后再看，可能会有新的季上架。
              </p>
            </div>
          ) : (
            <div className={`${SEASON_GRID_CLASS} ttv-grid-in`}>
              {seasons.map((pick, index) => (
                <SeriesCard
                  key={pick.item.id}
                  series={pick.item}
                  index={index}
                  seasonBadge={`第${pick.season}${currentLabel?.unit ?? '季'}`}
                  seasonBadgeTone={pick.relation}
                  onClick={handleOpen}
                  onPrefetch={prefetchDetail}
                />
              ))}
            </div>
          )}
        </div>

        {/* 底部说明：把"为什么没有当前季"直接写出来，省得用户以为漏了。 */}
        {seasons && seasons.length > 0 && (
          <div className="h-10 shrink-0 border-t border-black/[0.05] bg-slate-50/60 px-6 flex items-center justify-between">
            <span className="text-[11px] text-slate-400">
              已排除正在观看的这一季 · 共 {seasons.length} 季
            </span>
            <span className="text-[11px] text-slate-400">点击卡片切换到那一季</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default SeriesSeasonsDialog;
