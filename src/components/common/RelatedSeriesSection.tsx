import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { ipcService } from '../../services/ipc';
import {
  fetchRelatedSeries,
  relatedBatchCount,
  sliceRelatedBatch,
  SLOT_COUNT,
  type RelatedSeries,
  type RelatedSlice,
} from '../../services/relatedSeries';
import type { SeriesItem } from '../../types/catalog';
import type { SeriesDetail } from '../../types/series';
import { MicaCard } from './MicaCard';
import { SeriesCard } from './SeriesCard';
import { SeriesCardSkeleton } from './SeriesCardSkeleton';

/**
 * 网格列数：2/3/4/6，**刻意跳过 5 列**（理由同 `HomeShelf`）。
 *
 * 一屏固定装 6 条，6 条在 5 列下会排成 5+1——第二行孤零零挂一张，看起来像
 * 布局塌了。这里不复用 `SERIES_GRID_CLASS`：那份是目录网格的列宽（一页几十条，
 * 5 列不是问题），而这一栏只有一行。
 */
const RELATED_GRID_CLASS = 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 gap-3 sm:gap-4';

interface RelatedSeriesSectionProps {
  detail: SeriesDetail;
  /** 点卡片进详情。签名收 id，这样 `SeriesCard` 的 `React.memo` 才有意义。 */
  onOpen: (seriesId: string) => void;
}

/** 悬停预取详情：卡片被瞄到时先发那一发请求，点下去就是秒开。 */
function prefetchDetail(seriesId: string): void {
  void ipcService.series.getDetail(seriesId).catch(() => {});
}

/**
 * 详情页底部「猜你喜欢」。
 *
 * ## 它替代了什么
 *
 * 原先这一块是「可用播放解析通道与健康度」——把 `detail.sources` 列成卡片的面板。
 * 但真实链路里 `sources` 恒为空数组（红果/guo 的播放地址都是开集时才按需解析的，
 * 详情接口从不返回源列表），于是那块**永远**只显示一句「播放源由当前项目后端在
 * 打开集数时按需解析」。恒为占位文案的面板不是信息，是版面噪音，还占着详情页
 * 最后一屏最值钱的位置。
 *
 * ## 现在放什么
 *
 * 用户在这里最想做的事是"接着看下一部"：刚看完《聚宝盆》第 1 季，下一部就该是
 * 第 2、3、4… 季。所以第一优先级是**同系列其它季**（「第N季」角标标出接续关系），
 * 凑不满一屏才用同频道其它剧补位。两路都拿不到时整块不渲染——不留空话占位置。
 *
 * ## 「换一批」为什么需要 batch 计数
 *
 * 早期实现里这个按钮只是"清缓存重拉"，而 `fetchRelatedSeries` 是**确定性函数**：
 * 同一部剧搜同样的词、过同样的筛选排序，重拉必然得到同一批 —— 点了完全没反应。
 * 现在数据层返回的是**候选池**（可达 4 屏），这个按钮推进 `batch`，由
 * `sliceRelatedBatch` 在池子里换一个起点；池子翻完还想要新的，就再去拉下一页兜底
 * 目录（`fallbackPage` 递增）。两者合起来才叫"换一批"。
 *
 * ## 四条时序约束
 *
 * 1. **详情到手才发请求**：`fetchRelatedSeries` 以剧名为关键词，标题还没到手时
 *    发出去等于搜一个空词。
 * 2. **换剧作废在途请求**：详情页常驻 DOM，用户点进另一部剧时上一部的推荐可能
 *    还在路上；按 requestId 复查，不复查就会把上一部的季卡画在这一部下面。
 * 3. **换剧先清屏并重置 batch**：换剧后从第 0 批重新开始，否则新剧会从"第 3 批"
 *    开始显示，看起来像漏了一半。
 * 4. **换剧要重置已翻页数**：`fallbackPage` 属于"这一部剧"的翻页进度，跨剧累加
 *    会让新剧直接从目录第 5 页开始拉。
 */
export const RelatedSeriesSection: React.FC<RelatedSeriesSectionProps> = ({ detail, onOpen }) => {
  const [pool, setPool] = useState<RelatedSeries | null>(null);
  const [batch, setBatch] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  /** 「换一批」正在取下一批（池子耗尽、要拉下一页目录时）。 */
  const [isSwitching, setIsSwitching] = useState(false);
  const requestIdRef = useRef(0);
  /**
   * 已算好的候选池，按剧 id 缓存。
   *
   * 存**池子**而不是只存"拉过没有"的标记：详情页是常驻 DOM，用户从 A 剧点进 B 剧、
   * 再点回 A 剧时 effect 会重跑；如果只记"拉过"就直接跳过，而 pool 已被换剧逻辑
   * 清成 null —— 界面会永久停在骨架屏（实测踩过）。缓存池子则能立刻回填，
   * 来回切换还是 0 延迟，且 batch 仍可继续翻。
   */
  const poolCacheRef = useRef<Map<string, RelatedSeries>>(new Map());
  /** 这一部剧已经拉到第几页兜底目录。换剧时重置。 */
  const fallbackPageRef = useRef(1);

  useEffect(() => {
    const cached = poolCacheRef.current.get(detail.id);
    // 换剧：batch 与翻页进度都要归零，否则新剧会从旧剧的批号/页号开始。
    fallbackPageRef.current = 1;
    setBatch(0);

    if (cached) {
      requestIdRef.current += 1;
      setPool(cached);
      setIsLoading(false);
      setIsSwitching(false);
      return;
    }

    const requestId = ++requestIdRef.current;
    setPool(null);
    setIsLoading(true);
    setIsSwitching(false);

    void fetchRelatedSeries(detail, { fallbackPage: 1 })
      .then(result => {
        if (requestId !== requestIdRef.current) return;
        poolCacheRef.current.set(detail.id, result);
        setPool(result);
      })
      .catch(() => {
        if (requestId !== requestIdRef.current) return;
        // 失败与"确实没有推荐"都落到空结果：这一栏是增量信息，不值得弹错误提示。
        // **失败不入缓存**：下次进来应当重试，而不是把一次抖动记成"这部没有推荐"。
        setPool({ seasons: [], others: [] });
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setIsLoading(false);
      });

    return () => {
      // 卸载 / 换剧时作废在途请求。
      if (requestId === requestIdRef.current) requestIdRef.current += 1;
    };
  }, [detail]);

  /**
   * 「换一批」。
   *
   * 两段式：
   * 1. 池子里**还有没翻过的内容**时，纯本地推进 batch —— 零延迟，点下去立刻换。
   * 2. 池子翻完一整轮了才去拉下一页兜底目录，把新剧并进池子再切。
   *
   * 第 1 步先做是刻意的：如果每次都先拉网络，"换一批"会变成 1 秒的等待，而绝大多数
   * 点击其实池子里还有内容。
   */
  const handleNextBatch = useCallback(() => {
    if (!pool || isSwitching) return;

    const nextBatch = batch + 1;

    // 池子里还有可翻的内容：纯本地换一批，立刻生效。
    if (nextBatch < relatedBatchCount(pool)) {
      setBatch(nextBatch);
      return;
    }

    /**
     * 池子翻完一整轮：拉下一页兜底目录，把新剧并进池子再切。
     *
     * 同系列季不重复拉（它们与页号无关），只追加新的兜底条目；已见过的 id 不重复
     * 追加，否则池子会被重复条目灌满，`relatedBatchCount` 虚高，翻几批之后就全是
     * 重复内容。
     */
    const nextPage = fallbackPageRef.current + 1;
    const requestId = ++requestIdRef.current;
    setIsSwitching(true);

    void fetchRelatedSeries(detail, { fallbackPage: nextPage })
      .then(result => {
        if (requestId !== requestIdRef.current) return;
        const known = new Set(pool.others.map(item => item.id));
        const fresh = result.others.filter(item => !known.has(item.id));
        if (fresh.length === 0) {
          // 目录到头了：没有新剧可加。回绕到第 0 批，而不是原地不动——否则用户
          // 会以为按钮坏了（那正是这次要修的 bug 的观感）。
          fallbackPageRef.current = 1;
          setBatch(0);
          return;
        }
        const merged: RelatedSeries = {
          seasons: pool.seasons,
          others: [...pool.others, ...fresh],
        };
        fallbackPageRef.current = nextPage;
        poolCacheRef.current.set(detail.id, merged);
        setPool(merged);
        setBatch(nextBatch);
      })
      .catch(() => {
        // 拉不到下一页就留在当前批：不清屏、不报错，用户再点一次会重试。
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setIsSwitching(false);
      });
  }, [batch, detail, isSwitching, pool]);

  /** 当前这一屏。纯派生，不额外存 state。 */
  const slice: RelatedSlice | null = useMemo(
    () => (pool ? sliceRelatedBatch(pool, batch) : null),
    [pool, batch],
  );

  const seasonCount = slice?.seasons.length ?? 0;
  const total = seasonCount + (slice?.others.length ?? 0);

  const subtitle = useMemo(() => {
    if (isLoading) return '正在按当前剧集找接续内容…';
    if (isSwitching) return '正在换一批…';
    if (seasonCount > 0 && (slice?.others.length ?? 0) === 0) {
      return `同系列已收录 ${seasonCount} 季 · 按接续顺序排好`;
    }
    if (seasonCount > 0) return `同系列还有 ${seasonCount} 季，后面是同频道精选`;
    return '同频道的其它热门';
  }, [isLoading, isSwitching, seasonCount, slice]);

  // 加载中：骨架占住版面（与真实卡片同构），数据到达时布局不跳。
  if (isLoading && !pool) {
    return (
      <MicaCard className="p-5 flex flex-col gap-4">
        <div className="flex items-center justify-between pb-3 border-b border-black/[0.04]">
          <div className="flex items-center gap-2.5">
            <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600">
              <Sparkles className="h-3.5 w-3.5" />
            </span>
            <h2 className="text-sm font-bold text-slate-800">猜你喜欢</h2>
            <span className="text-[11px] text-slate-400">正在匹配接续内容…</span>
          </div>
        </div>
        <div className={RELATED_GRID_CLASS} aria-busy="true">
          {Array.from({ length: SLOT_COUNT }).map((_, index) => (
            <SeriesCardSkeleton key={index} />
          ))}
        </div>
      </MicaCard>
    );
  }

  // 两路都空：整块不渲染。写一句「暂无推荐」只是占着版面说废话。
  if (!slice || total === 0) return null;

  return (
    <MicaCard className="p-5 flex flex-col gap-4">
      <div className="flex items-end justify-between gap-3 pb-3 border-b border-black/[0.04]">
        <div className="flex items-start gap-2.5">
          <span
            aria-hidden="true"
            className="mt-1 h-5 w-1 shrink-0 rounded-full bg-gradient-to-b from-violet-500 to-indigo-500"
          />
          <div>
            <h2 className="flex items-center gap-1.5 text-sm font-bold text-slate-800">
              <Sparkles className="h-4 w-4 text-violet-500" />
              <span>猜你喜欢</span>
            </h2>
            <p className="mt-0.5 text-[11px] text-slate-400">{subtitle}</p>
          </div>
        </div>

        <button
          type="button"
          onClick={handleNextBatch}
          disabled={isSwitching}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border border-slate-200/80 bg-white/85 px-3 py-1.5 text-[11px] font-semibold text-slate-600 shadow-xs transition-all duration-150 hover:bg-white hover:text-violet-600 active:scale-95 disabled:cursor-wait disabled:opacity-60"
          title="换一批推荐"
        >
          <RefreshCw className={`h-3 w-3 ${isSwitching ? 'animate-spin' : ''}`} />
          <span>{isSwitching ? '换批中' : '换一批'}</span>
        </button>
      </div>

      {/*
        换批时给网格一个 key：`key` 变化会让整块重挂，`.ttv-grid-in` 的入场动画
        重新播放一遍。没有它时"换一批"是卡片原地替换，用户几乎看不出变化——
        那正是"点了没反应"的观感来源之一（即便数据已经换了）。
      */}
      <div key={`batch-${batch}`} className={`${RELATED_GRID_CLASS} ttv-grid-in`}>
        {slice.seasons.map((pick, index) => (
          <SeriesCard
            key={pick.item.id}
            series={pick.item}
            index={index}
            seasonBadge={`第${pick.season}季`}
            seasonBadgeTone={pick.relation}
            onClick={onOpen}
            onPrefetch={prefetchDetail}
          />
        ))}
        {slice.others.map((series, index) => (
          <SeriesCard
            key={series.id}
            series={series}
            index={seasonCount + index}
            onClick={onOpen}
            onPrefetch={prefetchDetail}
          />
        ))}
      </div>
    </MicaCard>
  );
};

export default RelatedSeriesSection;
