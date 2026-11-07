import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Layers3, Sparkles, X } from 'lucide-react';
import { fetchAllSeriesSeasons, type SeasonPick } from '../../services/relatedSeries';
import { parseSeasonLabel } from '../../services/seasonLabel';
import { ipcService } from '../../services/ipc';
import type { ChannelType } from '../../types/catalog';
import { SeriesCard } from './SeriesCard';
import { SeriesCardSkeleton } from './SeriesCardSkeleton';

/**
 * 弹窗内的网格列数。
 *
 * 与详情页的 `SeriesSeasonsDialog` **同一份**（那边是模块内的私有常量，没有导出；
 * 这里复制一份并保持逐字一致）。两处之所以共用同一套列数，是因为它们长得就该一样：
 * 用户在同一款产品里看到的"选季"应该是同一个东西。改动任何一边都要同步另一边。
 */
const SEASON_GRID_CLASS = 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 sm:gap-4';

interface SeriesSeasonPickerProps {
  /** 代表卡信息：只需要 id / title / type（搜索页手上没有完整的 SeriesDetail）。 */
  detail: { id: string; title: string; type: ChannelType };
  /** 该系列共几季（来自折叠时的 `seasonCount`，可能为 undefined）。 */
  seasonTotal?: number;
  onOpenSeason: (seriesId: string) => void;
  onClose: () => void;
}

/** 未上线季卡的点击占位：`SeriesCard` 的 `onClick` 是必填的，但置灰卡不该有动作。 */
const ignoreSeasonClick = (): void => {};

/** 悬停预取详情：与详情页系列剧弹窗同一套（点下去就是秒开）。 */
function prefetchDetail(seriesId: string): void {
  void ipcService.series.getDetail(seriesId).catch(() => {});
}

/**
 * 搜索页的「选季」窗口（2026-10-29）。
 *
 * ## 为什么搜索页需要它（用户原话）
 *
 * *我点击后为什么直接进入了视频的信息页，而不是进入一个新的界面？你可以在我点击
 * 卡片后，自己弹出一个窗口，然后在里面显示它全部的选季。*
 *
 * 搜索页把同系列折叠成一张卡之后，"点卡直接进详情"等于跳过了"这个系列有哪几季"这
 * 一层 —— 用户得进详情页再点「系列剧」才看得到。这个弹窗补的就是那一层：
 * **搜索页专属**，详情页原有的「系列剧」入口一个字没动（否则同一件事会有两个入口）。
 *
 * ## 与详情页弹窗的三处差异（都是语义决定的，不是样式）
 *
 * 1. **含代表那一季**：详情页的语义是"我在看第 N 季，给我别的季"，所以排除当前季；
 *    搜索页的语义是"这个系列有哪几季"，排掉代表季会让用户以为少了第一季。
 *    数据源因此是 `fetchAllSeriesSeasons` 而不是 `fetchSeriesSeasons`。
 * 2. **季号角标按每条自己的量词**：这里没有"正在看第 N 季"的基准，不能套一个全局
 *    unit —— 否则《烬九州》第 32~35 期会全被标成「第32季」。
 * 3. **不显示"正在看"徽章**：搜索页没有当前季这个概念。
 *
 * 其余（遮罩/面板/顶栏/网格/未上线置灰/关闭方式）全部沿用详情页那一套类名。
 */
export const SeriesSeasonPicker: React.FC<SeriesSeasonPickerProps> = ({
  detail,
  seasonTotal,
  onOpenSeason,
  onClose,
}) => {
  const [seasons, setSeasons] = useState<SeasonPick[] | null>(null);
  const requestIdRef = useRef(0);

  /**
   * 系列名：优先用「去掉季号」的 base。
   *
   * 代表卡可能是「烬九州第三季」（用户搜的是第 3 季），标题写「《烬九州第三季》的
   * 全部季」读着别扭；用 base 就是「《烬九州》的全部季」。解析不出（裸名）时退回原名。
   */
  const seriesName = parseSeasonLabel(detail.title)?.base ?? detail.title;

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    setSeasons(null);
    void fetchAllSeriesSeasons(detail.id, detail.title, detail.type)
      .then(result => {
        if (requestId !== requestIdRef.current) return;
        setSeasons(result);
      })
      .catch(() => {
        if (requestId !== requestIdRef.current) return;
        // `fetchAllSeriesSeasons` 内部已把异常收成空数组，走到这里属意料之外。
        // 按"没有其它季"呈现，不弹错误提示 —— 这是增量信息。
        setSeasons([]);
      });

    return () => {
      // 关窗/换剧时作废在途请求：晚到的结果不该写进下一次打开的窗口。
      if (requestId === requestIdRef.current) requestIdRef.current += 1;
    };
  }, [detail.id, detail.title, detail.type]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleOpenSeason = useCallback(
    (seriesId: string) => {
      // 关窗与跳转都由父层做（`SearchView` 里 setPicking(null) + 跳详情），
      // 这里只把 id 交出去：同一份"点季"语义不要在两层各写一遍。
      onOpenSeason(seriesId);
    },
    [onOpenSeason],
  );

  const subtitle = seasonTotal && seasonTotal > 1
    ? `共 ${seasonTotal} 季 · 选择一季开始看`
    : '选择一季开始看';

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
        aria-label={`《${seriesName}》的全部季`}
        className="w-full max-w-5xl max-h-[80vh] rounded-3xl bg-white/95 backdrop-blur-2xl border border-white shadow-fluent-hud flex flex-col overflow-hidden animate-fluent-scale-in"
      >
        {/* 顶栏：与详情页「系列剧」弹窗同一套尺寸与配色，两个窗口并排看不出差别。 */}
        <div className="h-14 px-6 flex items-center justify-between border-b border-black/[0.05] bg-slate-50/70 flex-shrink-0">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="w-8 h-8 shrink-0 rounded-lg bg-violet-50 text-violet-600 flex items-center justify-center border border-violet-200/60">
              <Layers3 className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="truncate text-sm font-bold text-slate-800">
                《{seriesName}》的全部季
              </h3>
              <p className="mt-0.5 truncate text-[11px] text-slate-400">{subtitle}</p>
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

        {/* 内容区：该系列**全部季**（含代表那一季）。 */}
        <div className="flex-1 overflow-y-auto p-6">
          {!seasons ? (
            <div className={SEASON_GRID_CLASS} aria-busy="true">
              {Array.from({ length: 5 }).map((_, index) => (
                <SeriesCardSkeleton key={index} />
              ))}
            </div>
          ) : seasons.length === 0 ? (
            /*
              空态。搜索页比详情页更容易碰到它：季表不可用时要靠"剧名 + 猜季号"去搜，
              裸名剧搜不到同系列条目是常态。不当成错误，给一句实话。
            */
            <div className="flex flex-col items-center justify-center gap-2.5 py-14 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-50 text-violet-500">
                <Sparkles className="h-5 w-5" />
              </span>
              <p className="text-sm font-bold text-slate-700">这个系列暂时没有更多季</p>
              <p className="max-w-sm text-xs leading-relaxed text-slate-400">
                点下面的「进入详情」也能直接看这一季。
              </p>
              <button
                type="button"
                onClick={() => handleOpenSeason(detail.id)}
                className="mt-1 rounded-xl bg-slate-900 px-3.5 py-1.5 text-xs font-bold text-white transition-colors hover:bg-slate-700"
              >
                进入详情
              </button>
            </div>
          ) : (
            <div className={`${SEASON_GRID_CLASS} ttv-grid-in`}>
              {seasons.map((pick, index) => {
                /**
                 * 季号角标：量词按**每条自己的 unit**（`季` / `期` / `部`）。
                 *
                 * 这里没有"正在看第 N 季"的基准可借（那是详情页的 `currentLabel`），
                 * 硬套一个全局 unit 会把《烬九州》第 32~35 期全标成「第32季」。
                 */
                const unit = parseSeasonLabel(pick.item.title)?.unit ?? '季';
                const badge = `第${pick.season}${unit}`;

                if (!pick.available) {
                  // 未上线：保留卡位、置灰、不给动作（与详情页弹窗同一套处理）。
                  return (
                    <div
                      key={pick.item.id}
                      role="group"
                      aria-label={`${badge} 尚未上架`}
                      className="relative"
                    >
                      <div className="pointer-events-none select-none opacity-55 grayscale">
                        <SeriesCard
                          series={pick.item}
                          index={index}
                          seasonBadge={badge}
                          seasonBadgeTone="next"
                          onClick={ignoreSeasonClick}
                        />
                      </div>
                      <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-900/75 px-2.5 py-1 text-[11px] font-bold text-white shadow-sm">
                        未上线
                      </span>
                    </div>
                  );
                }

                return (
                  <SeriesCard
                    key={pick.item.id}
                    series={pick.item}
                    index={index}
                    seasonBadge={badge}
                    seasonBadgeTone="next"
                    onClick={handleOpenSeason}
                    onPrefetch={prefetchDetail}
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* 底部说明：与详情页弹窗同款高度与底色。 */}
        {seasons && seasons.length > 0 && (
          <div className="h-10 shrink-0 border-t border-black/[0.05] bg-slate-50/60 px-6 flex items-center justify-between">
            <span className="text-[11px] text-slate-400">共 {seasons.length} 季 · 点一季进入详情</span>
            <span className="text-[11px] text-slate-400">灰色卡尚未上架，暂时不能播放</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default SeriesSeasonPicker;
