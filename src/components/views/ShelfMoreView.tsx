import React, { useCallback, useEffect, useRef, useState, ReactNode } from 'react';
import { useAppStore, ShelfKind } from '../../stores/useAppStore';
import { CatalogProvider, useCatalogStore } from '../../stores/useCatalogStore';
import { useShelfFeed } from '../../stores/useShelfFeed';
import { MicaCard } from '../common/MicaCard';
import { FluentButton } from '../common/FluentButton';
import { BackToTop } from '../common/BackToTop';
import { CoverImage } from '../common/CoverImage';
import { ipcService, errorText, coverResolver } from '../../services/ipc';
import type { ChannelType, SeriesItem } from '../../types/catalog';
import { ArrowLeft, ChevronRight, Flame, Play, Sparkles } from 'lucide-react';

/**
 * 首页货架的「更多」页。
 *
 * ## 数据源是两条不同接口，不是同一份列表切两段
 *
 * 官方红果客户端里「热播」与「新剧」本来就是两条接口（榜单 `cell/change` 与
 * 最新上架 `landpage`），结论来自**私有渠道**调研。这里照那条结论走：
 *
 * | 分区 | 频道 | 数据源 |
 * | --- | --- | --- |
 * | 正在热播 | 漫剧 | 榜单 `board=hot`（`comic_series_hot_play`） |
 * | 正在热播 | 短剧 | 上架 `sort=hot_score`（短剧没有 cell 榜） |
 * | 新剧 | 短剧 / 漫剧 | 上架 `sort=online_time` |
 * | 两者 | 神秘小窝 | **不走 App 接口** —— 见下 |
 *
 * ## 神秘小窝为什么例外
 *
 * 红果 App 的榜单/上架接口**没有 18+ 口径**（TTV 的 18+ 是本机侧"只启用成人源"
 * 的聚合概念）。拿它填神秘小窝等于把普通短剧塞进 18+ 专区，直接违反门闩不变量。
 * 所以该频道继续走本机启用源的多源聚合（`CatalogProvider`），页面版式完全一致，
 * 只有取数链路不同。
 *
 * ## 版式与「我的追剧 / 观看历史」同构
 *
 * 同一个页面壳（`p-8 / max-w-5xl / mx-auto / gap-6`）、同一个页头（图标 + 标题 +
 * 副标题 + 底边框）、同一套 `MicaCard` 行卡。这是用户明确要求的对齐目标。
 */

const SHELF_META: Record<ShelfKind, {
  title: string;
  /** 短剧 / 漫剧通用描述；18+ 频道另说，见 `shelfSubtitle`。 */
  generic: string;
  /** 仅"神秘小窝"用的描述。 */
  aggregated: string;
  icon: React.ComponentType<{ className?: string }>;
  iconClass: string;
  /** 走本机多源聚合时的排序（App 接口那条不读它）。 */
  sort: 'recommend' | 'latest' | 'heat';
}> = {
  hot: {
    title: '正在热播',
    generic: '红果热播榜',
    aggregated: '本机启用源 · 按热度',
    icon: Flame,
    iconClass: 'text-rose-500',
    sort: 'heat',
  },
  new: {
    title: '新剧',
    generic: '红果最新上架',
    aggregated: '本机启用源 · 最新加入',
    icon: Sparkles,
    iconClass: 'text-blue-600',
    sort: 'latest',
  },
};

export const ShelfMoreView: React.FC = () => {
  const { shelfView, goBack } = useAppStore();

  // 视图常驻 DOM：还没进过「更多」页时 shelfView 为 null，此时被 hidden 包着，
  // 渲染一个空壳即可。
  if (!shelfView) return <div className="h-full w-full" />;

  const meta = SHELF_META[shelfView.kind];

  if (shelfView.channel === 'adult') {
    return (
      <CatalogProvider
        key={`adult-${shelfView.kind}`}
        initialChannel="adult"
        initialSort={meta.sort}
      >
        <ShelfAggregatedList kind={shelfView.kind} onBack={goBack} />
      </CatalogProvider>
    );
  }

  return <ShelfAppFeed kind={shelfView.kind} channel={shelfView.channel} onBack={goBack} />;
};

/* ------------------------------------------------------------------ 共用零件 */

/**
 * 页面壳：返回行 + 页头 + 内容 + 底部状态槽。
 *
 * 两个数据源共用它，保证「我的追剧 / 观看历史」那套版式只有一份实现
 * —— 否则 App 接口那条与聚合那条迟早会长歪。
 */
const ShelfShell: React.FC<{
  kind: ShelfKind;
  subtitle: string;
  count: number;
  onBack: () => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  footer: ReactNode;
  children: ReactNode;
}> = ({ kind, subtitle, count, onBack, scrollRef, sentinelRef, footer, children }) => {
  const meta = SHELF_META[kind];
  const Icon = meta.icon;
  return (
    <div
      ref={scrollRef}
      className="flex-1 h-full overflow-y-auto p-8 max-w-5xl mx-auto flex flex-col gap-6 select-none"
    >
      {/* 返回行：详情页同款。这一页不是导航栏的常驻目的地，不给返回入口用户只能
          靠左侧导航离开，而侧栏此时没有任何一项是选中态。 */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-white/85 hover:bg-white text-slate-700 hover:text-blue-600 shadow-xs border border-slate-200/70 backdrop-blur-md transition-all text-xs font-semibold cursor-pointer active:scale-95"
          title="返回发现精选"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>返回发现</span>
        </button>

        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span>发现精选</span>
          <span>/</span>
          <span className="text-slate-700 font-semibold truncate max-w-xs">{meta.title} · 更多</span>
        </div>
      </div>

      {/* 头部：与「我的追剧 / 观看历史」同一骨架 */}
      <div className="flex items-center justify-between pb-4 border-b border-black/[0.05]">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <Icon className={`w-5 h-5 ${meta.iconClass}`} />
            <span>{meta.title} · 更多</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1 truncate">{subtitle}</p>
        </div>
        {count > 0 && (
          <span className="text-xs text-slate-400 shrink-0">已加载 {count} 部</span>
        )}
      </div>

      {children}

      {/* 无限流哨兵 + 底部状态 */}
      <div ref={sentinelRef} className="min-h-12 flex items-center justify-center pt-1" aria-live="polite">
        {footer}
      </div>

      {/* 回到顶部：与发现页 / 动漫专区同一套。放在页面壳里所以两条数据源（红果 App
          接口与 18+ 多源聚合）都自动带上，不会只有一边有。 */}
      <BackToTop targetRef={scrollRef} />
    </div>
  );
};

/** 底部状态槽：加载中 / 失败重试 / 已到底。 */
const ShelfFooter: React.FC<{
  isLoadingMore: boolean;
  hasMore: boolean;
  hasItems: boolean;
  error: string | null;
  onRetry: () => void;
}> = ({ isLoadingMore, hasMore, hasItems, error, onRetry }) => {
  /**
   * 「正在加载更多…」要不要露头，看的不是"有没有在加载"，而是"这次加载有没有久到
   * 需要解释"。
   *
   * 红果这条接口首次要等 Python 冷启动（约 1.8s），原来只要 `isLoadingMore` 为真
   * 就把提示挂出来，于是**每次翻页底部都会先跳出一行字再被内容顶走**。用户明确
   * 表示不想看到它。现在延迟 400ms：请求在这之内回来就全程不显示，只有真的卡住了
   * 才给一句解释 —— 那时它是必要的，不是噪音。
   *
   * 底部槽有 `min-h-12` 兜着，显示与否都不会让整页跳一下。
   */
  const [slowEnoughToTell, setSlowEnoughToTell] = useState(false);
  useEffect(() => {
    if (!isLoadingMore) {
      setSlowEnoughToTell(false);
      return;
    }
    const timer = window.setTimeout(() => setSlowEnoughToTell(true), 400);
    return () => window.clearTimeout(timer);
  }, [isLoadingMore]);

  // 失败必须**优先**于"还没到底"这个判断。
  // 原来这句是 `if (hasMore || !hasItems) return null;` 写在最前面，于是翻页失败时
  // `hasMore` 仍为 true → 直接 return null → 错误被整段吞掉。用户看到的现象就是
  // "滚下去没反应、没有新卡片出来"，而界面上一个字都不解释。
  if (error && hasItems) {
    return (
      <button
        type="button"
        onClick={onRetry}
        // 真实原因放进 title：默认那一行是给人看的状态，具体报错留给悬停排查。
        title={error}
        className="px-3 py-1.5 rounded-xl bg-white/70 border border-slate-200/70 text-xs text-slate-500 shadow-xs hover:text-slate-700 hover:bg-white cursor-pointer"
      >
        加载更多失败，点此重试
      </button>
    );
  }
  if (isLoadingMore && slowEnoughToTell) {
    return (
      <div className="px-4 py-2 rounded-xl bg-white/70 border border-slate-200/70 text-xs text-slate-500 shadow-xs">
        正在加载更多…
      </div>
    );
  }
  if (hasMore || !hasItems) return null;
  return <span className="text-[11px] text-slate-400">已加载全部内容</span>;
};

/** 空态 / 首屏失败态（与「我的追剧」的空态同一骨架）。 */
const ShelfNotice: React.FC<{ title: string; detail: string; onRetry?: () => void }> = ({ title, detail, onRetry }) => (
  <div className="py-24 flex flex-col items-center justify-center text-center gap-3">
    <img src="/app-icon.png" alt="" className="w-14 h-14 object-contain opacity-60" draggable={false} />
    <p className="text-sm font-semibold text-slate-700">{title}</p>
    <p className="text-xs text-slate-400 max-w-md">{detail}</p>
    {onRetry && (
      <div className="p-1 bg-slate-100/90 rounded-xl border border-slate-200/70 shadow-inner inline-flex mt-2">
        <FluentButton variant="primary" size="sm" onClick={onRetry} className="shadow-sm">
          重试
        </FluentButton>
      </div>
    )}
  </div>
);

const ShelfSkeleton: React.FC = () => (
  <div className="flex flex-col gap-3">
    {Array.from({ length: 6 }).map((_, index) => (
      <div key={index} className="h-[120px] rounded-xl shimmer-loading" />
    ))}
  </div>
);

/**
 * 行卡。与「我的追剧」的行卡同构：64×88 封面 + 标题 + 题材/来源 + 集数/评分 +
 * 右侧动作区。
 */
const ShelfRow: React.FC<{
  series: SeriesItem;
  index: number;
  onOpen: (seriesId: string) => void;
}> = ({ series, index, onOpen }) => {
  // 封面通道统一由 `coverResolver` 决定：guo 走 guo-core、红果的 HEIC 走后端转码、
  // 其余直连。这里**不要**自己再写一遍判定 —— 首页走的是 `SeriesCard`，两边口径
  // 一旦分叉就会出现"同一部剧在首页空白、点进来才有图"。
  const resolveSrc = coverResolver(series.id, series.cover);

  return (
    <MicaCard
      hoverable
      onClick={() => onOpen(series.id)}
      className="p-4 flex items-center justify-between gap-4 animate-fluent-card-in group"
    >
      <div className="flex items-center gap-4 min-w-0">
        {/* 3:4 = 64×88。必须写 `h-[88px]`：`h-22` 不在 Tailwind 的 spacing 刻度里
            （…/20/24/…），从来没被生成过——占位层是 `absolute inset-0`，父级没有
            高度时它会塌成 0px，封面加载失败的小图会整个消失。 */}
        <div className="relative w-16 h-[88px] rounded-xl overflow-hidden shadow-sm flex-shrink-0 bg-slate-100">
          <CoverImage
            src={series.cover}
            title={series.title}
            fallbackChar="剧"
            placeholderTextClassName="text-base"
            loading={index < 8 ? 'eager' : 'lazy'}
            resolveSrc={resolveSrc}
          />
          <div className="absolute inset-0 bg-black/20 group-hover:bg-black/40 flex items-center justify-center transition-colors">
            <Play className="w-5 h-5 text-white fill-current opacity-80 group-hover:opacity-100 transform group-hover:scale-110 transition-transform" />
          </div>
        </div>

        <div className="flex flex-col gap-1.5 min-w-0">
          <h3 className="text-sm font-bold text-slate-900 truncate group-hover:text-blue-600 transition-colors">
            {series.title}
          </h3>
          <div className="flex items-center gap-2 text-xs text-slate-400 min-w-0">
            {series.tags[0] && (
              <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-200/60 font-bold text-[10px] shrink-0">
                {series.tags[0]}
              </span>
            )}
            <span className="truncate">{series.origin}</span>
          </div>
          <span className="text-xs text-slate-400">
            {series.episodesCount > 1 ? `${series.episodesCount} 集` : '集数未知'}
            {series.rating ? ` · 评分 ${series.rating.toFixed(1)}` : ''}
          </span>
        </div>
      </div>

      <div className="p-1 bg-slate-100/80 rounded-xl border border-slate-200/60 shadow-inner flex items-center gap-1.5 flex-shrink-0">
        <FluentButton
          variant="secondary"
          size="sm"
          icon={<ChevronRight className="w-3.5 h-3.5" />}
          onClick={(event) => {
            event.stopPropagation();
            onOpen(series.id);
          }}
          className="shadow-sm"
        >
          查看详情
        </FluentButton>
      </div>
    </MicaCard>
  );
};

/** 打开详情：顺手预取，点进去瞬时出内容（与发现页一致）。 */
function useOpenDetail() {
  const { navigateTo } = useAppStore();
  return useCallback((seriesId: string) => {
    void ipcService.series.getDetail(seriesId).catch(() => {});
    navigateTo('detail', seriesId);
  }, [navigateTo]);
}

/* ------------------------------------------------------- 数据源 A：红果 App */

// 分区列表的取数与游标翻页收口在 `stores/useShelfFeed`：**首页货架读的是同一份
// 数据与同一份首屏缓存**，所以从货架点进「更多」是秒开的。

/**
 * 滚动到底自动翻页 —— **永远保持前方有一段已加载的缓冲**。
 *
 * ## 为什么是"两条腿"而不是一条观察器
 *
 * 观察器只在**跨界那一下**回调。用户一记快速滑动把哨兵直接带过去、或者一次提交
 * 追加的内容还不够把哨兵推出边界，都不会再产生新的交叉事件 —— 表现就是"停在
 * 那儿不动了"。而 `rootMargin` 调多大都治不了这个，因为问题在**事件语义**上，
 * 不在距离上。
 *
 * 所以：
 *   - **观察器**负责"越过缓冲线就发请求"，`rootMargin: 2400px`；
 *   - **几何兜底**在每次页码变化后按 `getBoundingClientRect` 实测哨兵与视口的
 *     真实距离，只要还在缓冲线内就继续补一页。它对"跨不跨界"毫不知情，因此
 *     不会漏掉上面那两种情况。
 *
 * ## 为什么是 2400px
 *
 * 原来只有一条 `rootMargin: 400px`，400px 不到一屏，而红果这条接口要等 Python
 * 冷启动（约 1.8s），于是用户滚到底时底部**必然**先跳一行"正在加载更多…"。
 * 单页约 1300–2400px，2400px 意味着**始终手里压着约两页没看过的内容**：
 * 请求在用户还看得见"下面的下面"时就结束了，加载态根本没机会露头。
 * 代价是打开这一页会多拉一两页 —— 这是用户主动点进"更多"的页面，值得。
 *
 * `loadMore` 内部有 `inFlight` 单飞 + 游标幂等（见 `useShelfFeed`），
 * 两条腿同时触发是安全的，不会重复打站方。
 */
function useInfiniteScroll(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  sentinelRef: React.RefObject<HTMLDivElement | null>,
  hasMore: boolean,
  loadMore: () => void,
) {
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root || !hasMore) return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) loadMore();
      },
      { root, rootMargin: PREFETCH_MARGIN_PX, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadMore, scrollRef, sentinelRef]);
}

/** 预取缓冲线：哨兵与视口底部的距离小于它，就继续补下一页。 */
const PREFETCH_MARGIN_PX = '2400px 0px';
const PREFETCH_DISTANCE_PX = 2400;

/**
 * 几何兜底：页码变化后实测"哨兵离视口底部还有多远"，仍在缓冲线内就继续补。
 *
 * 依赖里**必须**有 `items.length`：每落一页就重新量一次，缓冲被填满就自然停下，
 * 这是这套机制唯一的收敛条件。`isLoadingMore` 也必须在依赖里，否则会在同一帧里
 * 连发好几次（`loadMore` 有单飞，但会白跑几轮 setState）。
 */
function usePrefetchBackstop(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  sentinelRef: React.RefObject<HTMLDivElement | null>,
  hasMore: boolean,
  isLoadingMore: boolean,
  itemCount: number,
  loadMore: () => void,
) {
  useEffect(() => {
    if (!hasMore || isLoadingMore || itemCount === 0) return;
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;
    const distance = sentinel.getBoundingClientRect().top - root.getBoundingClientRect().bottom;
    if (distance <= PREFETCH_DISTANCE_PX) loadMore();
  }, [hasMore, isLoadingMore, itemCount, loadMore, scrollRef, sentinelRef]);
}

const ShelfAppFeed: React.FC<{
  kind: ShelfKind;
  channel: ChannelType;
  onBack: () => void;
}> = ({ kind, channel, onBack }) => {
  const { items, isLoading, isLoadingMore, hasMore, error, loadMore, reload } = useShelfFeed(kind, channel);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const openDetail = useOpenDetail();

  useInfiniteScroll(scrollRef, sentinelRef, hasMore, loadMore);
  usePrefetchBackstop(scrollRef, sentinelRef, hasMore, isLoadingMore, items.length, loadMore);

  const meta = SHELF_META[kind];
  const noun = channel === 'comic' ? '漫剧' : '短剧';
  const subtitle = `${meta.generic} · ${noun}`;

  return (
    <ShelfShell
      kind={kind}
      subtitle={subtitle}
      count={items.length}
      onBack={onBack}
      scrollRef={scrollRef}
      sentinelRef={sentinelRef}
      footer={
        <ShelfFooter
          isLoadingMore={isLoadingMore}
          hasMore={hasMore}
          hasItems={items.length > 0}
          error={error}
          onRetry={reload}
        />
      }
    >
      {isLoading ? (
        <ShelfSkeleton />
      ) : items.length === 0 ? (
        <ShelfNotice
          title={error ? '列表加载失败' : '这一栏暂时是空的'}
          detail={error || '红果这条接口没有返回内容。稍后再试，或到「系统设置」里换一组视频源。'}
          onRetry={error ? reload : undefined}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((series, index) => (
            <ShelfRow key={series.id} series={series} index={index} onOpen={openDetail} />
          ))}
        </div>
      )}
    </ShelfShell>
  );
};

/* -------------------------------------------- 数据源 B：本机启用源聚合（18+） */

const ShelfAggregatedList: React.FC<{
  kind: ShelfKind;
  onBack: () => void;
}> = ({ kind, onBack }) => {
  const { items, isLoading, isLoadingMore, hasMore, error, loadMore, refreshCatalog } = useCatalogStore();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const openDetail = useOpenDetail();

  // 稳定回调：内联箭头每次渲染都是新 identity，会让两条 effect 每渲染重建一次
  // 观察器，也会让几何兜底在同一帧里反复触发。
  const handleLoadMore = useCallback(() => { void loadMore(''); }, [loadMore]);
  useInfiniteScroll(scrollRef, sentinelRef, hasMore, handleLoadMore);
  usePrefetchBackstop(scrollRef, sentinelRef, hasMore, isLoadingMore, items.length, handleLoadMore);

  const meta = SHELF_META[kind];
  const subtitle = `${meta.aggregated} · 内容`;

  return (
    <ShelfShell
      kind={kind}
      subtitle={subtitle}
      count={items.length}
      onBack={onBack}
      scrollRef={scrollRef}
      sentinelRef={sentinelRef}
      footer={
        <ShelfFooter
          isLoadingMore={isLoadingMore}
          hasMore={hasMore}
          hasItems={items.length > 0}
          error={error}
          onRetry={() => void refreshCatalog('')}
        />
      }
    >
      {isLoading && items.length === 0 ? (
        <ShelfSkeleton />
      ) : items.length === 0 ? (
        <ShelfNotice
          title={error ? '列表加载失败' : '还没有勾选成人内容源'}
          detail={error || '到「系统设置 → 视频源 → 18+ 成人内容」里勾选，这里就会出现内容'}
          onRetry={error ? () => void refreshCatalog('') : undefined}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((series, index) => (
            <ShelfRow key={series.id} series={series} index={index} onOpen={openDetail} />
          ))}
        </div>
      )}
    </ShelfShell>
  );
};
