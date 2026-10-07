import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { ipcService } from '../../services/ipc';
import { CatalogFilter, SeriesItem } from '../../types/catalog';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { SeriesCard, SERIES_GRID_CLASS } from '../common/SeriesCard';
import { BackToTop } from '../common/BackToTop';
import { FluentButton } from '../common/FluentButton';

type Channel = 'drama' | 'comic';

/** 搜索默认频道：站点搜索接口不做频道过滤（实测所有结果都是 doc_type:23 的剧集），
 *  固定 drama 让 card 的 type 标记一致，避免两个频道搜出同一批结果的假象。 */
const SEARCH_CHANNEL: Channel = 'drama';

/**
 * 搜索结果页。
 *
 * 唯一的搜索输入在顶部标题栏：聚焦弹搜索历史浮层、回车直接进这里。本视图只
 * 负责展示结果——此前页面内再放一个输入框与历史卡片的中间态已移除（用户反馈
 * "这个页面是多余的"）。无关键词时给一个指向上方搜索框的占位提示。
 */
export const SearchView: React.FC = () => {
  const {
    currentView,
    searchKeyword,
    rememberSearch,
    navigateTo,
  } = useAppStore();

  /**
   * 全部卡片共用这一个点击回调（卡片自己带上 seriesId）。
   *
   * 必须是稳定的 `useCallback`：内联箭头函数会让 `SeriesCard` 的 `React.memo` 失效，
   * 搜索结果页一次 40 张卡就会因为任何无关重渲染全部重画。`rememberSearch` /
   * `navigateTo` 在 useAppStore 里已稳定，依赖数组因此保持不变。
   */
  const handleCardClick = useCallback((seriesId: string) => {
    rememberSearch(searchKeyword.trim());
    navigateTo('detail', seriesId);
  }, [navigateTo, rememberSearch, searchKeyword]);

  const [channel] = useState<Channel>(SEARCH_CHANNEL);
  const [items, setItems] = useState<SeriesItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 后端给的来源说明（正常是"红果官网搜索 · 关键词"，失败时追加降级说明）。
   *  染不染琥珀色看 `degraded`，不看这段文字——见下方 `degraded` 的注释。 */
  const [sourceNote, setSourceNote] = useState<string | null>(null);
  /** 后端给的降级标志位（有没有来源真的挂了）。 */
  const [degraded, setDegraded] = useState(false);
  /** 分页：hasMore 决定底部显示"加载更多"还是"已显示全部"，nextPage 是下次要拉的页。 */
  const [hasMore, setHasMore] = useState(false);
  const [nextPage, setNextPage] = useState(2);
  const [total, setTotal] = useState(0);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  // 请求编号：关键词变化很快时，旧请求不允许覆盖新结果。
  const requestIdRef = useRef(0);
  /** 首屏那一发的 filter：加载更多直接复用它翻页，在别处重建迟早漏字段。 */
  const filterRef = useRef<CatalogFilter | null>(null);

  /**
   * 换关键词（或清空）时把分页状态整体归零。
   *
   * 不归零的话，上一轮的 hasMore / nextPage 会跟着新结果一起显示——新关键词
   * 明明只有一页，底部却挂着个翻到别的关键词那页去的"加载更多"。
   */
  const resetPaging = () => {
    setSourceNote(null);
    setDegraded(false);
    setHasMore(false);
    setNextPage(2);
    setIsLoadingMore(false);
    setLoadMoreError(null);
  };

  useEffect(() => {
    // 只在结果页激活时发起搜索：顶部搜索框的输入是全局状态，用户在其它页面
    // 敲字（尚未回车提交）不该在后台空跑一轮请求。
    if (currentView !== 'search') return;
    const keyword = searchKeyword.trim();
    // 每次关键词变化立即作废在途请求：防抖窗口内用户又敲了一个字时，
    // 上一次的响应回来不该再往屏幕上画。加载更多复用同一个编号。
    const requestId = ++requestIdRef.current;
    if (!keyword) {
      setItems([]);
      setError(null);
      setIsLoading(false);
      resetPaging();
      filterRef.current = null;
      return;
    }
    // 防抖 300ms：旧实现每敲一个字就发一次全量搜索，而每一发在后端都要
    // 冷启动一个 Python 进程跑 App 联想，打字快时等于连开好几个进程。
    const timer = window.setTimeout(() => {
      setIsLoading(true);
      setError(null);
      resetPaging();
      const filter: CatalogFilter = {
        channel,
        // 不带 source：搜索恒走全源（红果官网 + 动漫 + App 联想）。此前把浏览页
        // 选中的站源拼进来，用户在发现页选了什么就只搜得到什么——换个源连搜索
        // 结果都跟着换，搜索失去了"帮我找"的意义。source 为空后端才走三路合并。
        category: '全部',
        audience: '全部',
        sort: 'recommend',
        keyword,
        page: 1,
        pageSize: 40,
      };
      filterRef.current = filter;
      /**
       * 两路**并行**发出，不再串联。
       *
       * 旧实现把联想挂在 `searchFast` 的 `.then` 里，于是总耗时 = 快路 + 联想
       * （实测 0.3-0.6s + 0.6-1.9s，联想要冷启动一个 Python 进程）。而联想是纯补充
       * （补网页漏掉的分季条目），从头到尾不阻塞首屏——串联唯一的作用就是让尾部凭空
       * 多等一拍。改成并行后总耗时是两者的**最大值**，那条慢链路完整地藏进了用户读
       * 首屏结果的时间里。
       */
      const suggestPromise = ipcService.catalog.searchSuggest(keyword, channel);
      ipcService.catalog
        .searchFast(filter)
        .then(page => {
          if (requestId !== requestIdRef.current) return;
          setItems(page.items);
          setSourceNote(page.source ?? null);
          setDegraded(page.degraded === true);
          setHasMore(page.hasMore);
          setTotal(page.total);
          // 红果官网搜索本身有分页，此前固定只要第 1 页，hasMore / total 一直
          // 被白白丢掉：命中多页的长尾剧永远只剩首屏那几十张卡片。
          setNextPage(page.page + 1);
          // 首屏已可用，先收掉 loading，用户不用为补充来源继续等。
          setIsLoading(false);
        })
        .catch((err: unknown) => {
          if (requestId !== requestIdRef.current) return;
          setError((err as Error).message || '搜索失败，请稍后重试。');
          setItems([]);
        })
        .finally(() => {
          if (requestId === requestIdRef.current) setIsLoading(false);
        });

      // 联想单独一条链：失败静默（它是补充来源），且必须复查 requestId。
      void suggestPromise
        .then(suggestions => {
          if (!suggestions || requestId !== requestIdRef.current) return;
          // 联想按 id 去重后追加：它只是补齐网页漏掉的分季条目，
          // 不打断用户已经在看的首屏结果。
          setItems(previous => {
            const seen = new Set(previous.map(item => item.id));
            const extra = suggestions.filter(item => !seen.has(item.id));
            return extra.length > 0 ? [...previous, ...extra] : previous;
          });
        })
        .catch(() => {
          // 联想失败不影响已有结果。
        });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [currentView, searchKeyword, channel]);

  /**
   * 加载更多：复用首屏的 filter，只把 page 往后推一格。
   *
   * 必须复查 requestIdRef —— 用户在加载途中改了关键词，这一页的响应属于上一轮，
   * 直接追加就会把别的关键词的剧混进当前列表。页号在 await 之前快照，避免续体
   * 读到已经翻过一次的 nextPage。
   */
  const loadMore = async () => {
    const filter = filterRef.current;
    if (!filter || isLoadingMore) return;
    const requestId = requestIdRef.current;
    const page = nextPage;
    setIsLoadingMore(true);
    setLoadMoreError(null);
    try {
      const result = await ipcService.catalog.list({ ...filter, page });
      if (requestId !== requestIdRef.current) return;
      // 去重同样是必需的：后端 catalog_list 带关键词时也会合并 App 联想，
      // 联想是整批重复的，不滤掉每翻一页都会白长出同样几张卡片。
      setItems(previous => {
        const seen = new Set(previous.map(item => item.id));
        const extra = result.items.filter(item => !seen.has(item.id));
        return extra.length > 0 ? [...previous, ...extra] : previous;
      });
      setHasMore(result.hasMore);
      setTotal(result.total);
      setNextPage(page + 1);
    } catch (err) {
      // 不动已有结果：翻页失败没理由把用户已经看到的几十张卡片清空。
      if (requestId === requestIdRef.current) {
        setLoadMoreError((err as Error).message || '加载更多失败，请重试。');
      }
    } finally {
      if (requestId === requestIdRef.current) setIsLoadingMore(false);
    }
  };

  const hasKeyword = searchKeyword.trim().length > 0;

  /** 回到顶部要自己拿得到滚动容器。与发现页 / 动漫专区同一套交互。 */
  const scrollRef = useRef<HTMLDivElement | null>(null);

  return (
    <div ref={scrollRef} className="w-full h-full overflow-y-auto select-none p-6 sm:p-8">
      <div className="max-w-5xl mx-auto flex flex-col gap-5 pb-24">
        {/* 结果页头部：返回 + 当前关键词 + 计数（搜索输入与历史都在顶部搜索框） */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigateTo('explore')}
            className="w-9 h-9 rounded-xl bg-white hover:bg-slate-50 text-slate-600 border border-slate-200/80 shadow-xs flex items-center justify-center transition-all active:scale-95 cursor-pointer flex-shrink-0"
            title="返回发现"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>

          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-bold text-slate-800 truncate">
              {hasKeyword ? `「${searchKeyword.trim()}」的搜索结果` : '搜索'}
            </h2>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {hasKeyword
                ? (isLoading ? '搜索中…' : `按相关度排序 · 精确匹配在前 · 找到 ${items.length} 部`)
                : '在顶部的搜索框输入关键词开始搜索'}
            </p>
            {/* 来源说明：正常态是灰字（哪种来源、搜的什么），后端给出 degraded
                标志位（有一路来源真的挂了）就染成琥珀色——降级不等于失败，
                不该借用 rose 那套错误色。
                此前这里是拿 `source` 文案去匹配「不可用/已跳过/失败/超时」等词表的，
                而这段文案里本来就嵌着用户搜的词：搜"失败"会把正常来源行染成警告色。
                标志位是结构化的，同样的文案换个关键词不再误判。 */}
            {sourceNote && (
              <p className={`mt-0.5 text-[11px] ${degraded ? 'text-amber-600' : 'text-slate-400'}`}>
                {sourceNote}
              </p>
            )}
          </div>
        </div>

        {/* 无关键词时的占位 */}
        {!hasKeyword && (
          <div className="rounded-2xl bg-white/88 border border-white/80 shadow-fluent p-8 text-center">
            <p className="text-sm font-semibold text-slate-700">在上方搜索框输入剧名开始搜索</p>
            <p className="mt-1.5 text-xs text-slate-400">
              支持剧名关键词与分季名称；点击搜索框可查看历史记录。
            </p>
          </div>
        )}

        {/* 有关键词：结果区 */}
        {hasKeyword && (
          <>
            {error && (
              <div className="rounded-2xl bg-rose-50/80 border border-rose-200/70 p-4 text-xs text-rose-700">
                {error}
              </div>
            )}

            {!error && !isLoading && items.length === 0 && (
              <div className="rounded-2xl bg-white/88 border border-white/80 shadow-fluent p-8 text-center">
                <p className="text-sm font-semibold text-slate-700">没有找到匹配的剧集</p>
                <p className="mt-1.5 text-xs text-slate-400">
                  试试更短的关键词，或换到另一个频道。分季剧集可以只搜主标题（如「聚宝仙盆」）。
                </p>
              </div>
            )}

            {items.length > 0 && (
              <div className={SERIES_GRID_CLASS}>
                {items.map((series, index) => (
                  <SeriesCard
                    key={`${series.id}-${index}`}
                    series={series}
                    index={index}
onClick={handleCardClick}
                  />
                ))}
              </div>
            )}

            {/* 分页：按钮与"已显示全部"互斥，翻页出错只在这块提示，不清空上面的结果 */}
            {items.length > 0 && (
              <div className="flex flex-col items-center gap-2">
                {loadMoreError && <p className="text-[11px] text-rose-600">{loadMoreError}</p>}
                {hasMore ? (
                  <FluentButton
                    size="md"
                    disabled={isLoadingMore}
                    onClick={loadMore}
                    icon={isLoadingMore ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : undefined}
                  >
                    {isLoadingMore ? '加载中…' : '加载更多'}
                  </FluentButton>
                ) : (
                  // 取 max：联想是前端追加的，后端 total 未必算上它，直接显示
                  // 会出现"已显示全部 8 部"底下摆着 14 张卡片。
                  <p className="text-[11px] text-slate-400">
                    已显示全部 {Math.max(total, items.length)} 部
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <BackToTop targetRef={scrollRef} />
    </div>
  );
};
