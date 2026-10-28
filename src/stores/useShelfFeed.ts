import { useCallback, useEffect, useRef, useState } from 'react';
import { ipcService, errorText } from '../services/ipc';
import type { ChannelType, SeriesItem, ShelfKind } from '../types/catalog';

/**
 * 「正在热播 / 新剧」的分区数据源（红果 App 榜单 / 最新上架）。
 *
 * 为什么单独抽一个模块：**首页货架与「更多」页要读同一批数据**。
 * 两处各自 fetch 的话，首页已经拉过的那一页在「更多」页要再等一次 1.8s 的
 * Python 冷启动；共享一份"首页缓存"之后，「更多」页是**秒开**的（还能接着那页的
 * 游标继续翻）。
 *
 * 分页是**游标式**：游标由后端产出、这里原样回传，不要解析它的内容 ——
 * 榜单那条里编码着 `session_uuid + next_offset`，上架那条只是 `offset`。
 */

/** 首页缓存的有效期。红果自己的榜单缓存是 30 分钟，这里取更短的一档。 */
const CACHE_TTL_MS = 3 * 60 * 1000;

interface CachedPage {
  items: SeriesItem[];
  hasMore: boolean;
  nextCursor?: string;
  at: number;
}

const firstPageCache = new Map<string, CachedPage>();

const cacheKey = (kind: ShelfKind, channel: ChannelType) => `${kind}|${channel}`;

/**
 * 红果 App 接口只覆盖短剧与漫剧。
 *
 * 18+（神秘小窝）**没有对应口径** —— TTV 的 18+ 是本机侧"只启用成人源"的聚合
 * 概念，拿红果的公开榜单去填等于把普通短剧塞进 18+ 专区。那一路继续走本机启用源
 * 的多源聚合（`CatalogProvider`），见 `ShelfMoreView` 与 `ExploreView`。
 */
export function shelfFeedSupports(channel: ChannelType): boolean {
  return channel === 'drama' || channel === 'comic';
}

function readFirstPage(kind: ShelfKind, channel: ChannelType): CachedPage | null {
  const cached = firstPageCache.get(cacheKey(kind, channel));
  if (!cached) return null;
  if (Date.now() - cached.at > CACHE_TTL_MS) {
    firstPageCache.delete(cacheKey(kind, channel));
    return null;
  }
  return cached;
}

export interface ShelfFeedState {
  items: SeriesItem[];
  /** 首屏（或整体重载）进行中。 */
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  /**
   * 已落地的页数。**与 `items.length` 是两件事**。
   *
   * 为什么要单独给一个：某一页去重后可能一条新卡片都没有（站方游标错位、
   * 跨会话续翻回吐重复），此时 `items.length` 不变，但"确实又翻了一页"。
   * 调用方（`usePrefetchBackstop`）需要一个**每页都会变**的信号来重新量几何，
   * 否则那一页之后兜底就不再触发，无限流停住。
   */
  pagesLoaded: number;
}

export interface ShelfFeed extends ShelfFeedState {
  loadMore: () => void;
  reload: () => void;
}

const EMPTY_STATE: ShelfFeedState = {
  items: [],
  isLoading: false,
  isLoadingMore: false,
  hasMore: false,
  error: null,
  pagesLoaded: 0,
};

/**
 * 拉一页分区列表并维护游标翻页。
 *
 * 不退化成"把整份列表一次拉完"：榜单/上架都是服务端分页，单页 10–18 条，
 * 一次全拉既慢又浪费；调用方按需 `loadMore()`。
 */
export function useShelfFeed(kind: ShelfKind, channel: ChannelType): ShelfFeed {
  const supported = shelfFeedSupports(channel);
  const [state, setState] = useState<ShelfFeedState>(() => {
    if (!supported) return EMPTY_STATE;
    const cached = readFirstPage(kind, channel);
    return cached
      ? { ...EMPTY_STATE, items: cached.items, hasMore: cached.hasMore }
      : { ...EMPTY_STATE, isLoading: true };
  });
  const cursorRef = useRef<string | undefined>(undefined);
  const itemsRef = useRef<SeriesItem[]>([]);
  const requestIdRef = useRef(0);
  const inFlightRef = useRef(false);
  /**
   * 连续多少页"去重后为空"。
   *
   * 用来区分"这一页恰好重复"与"真的到头了"：前者不该终止无限流
   * （旧实现正是在这里把 hasMore 永久置 false，导致第 10 部就停）。
   * 连续 3 页都空才认输。
   */
  const emptyPagesRef = useRef(0);
  /**
   * 请求在途时又被要求翻页：记下这次意图，等当前请求结束后补发。
   *
   * 见 `load` 开头的长注释 —— 这是"无限流不彻底"的第二条根因：
   * observer 与几何兜底会各触发一次，第二次被静默丢弃后就再也没人补。
   */
  const pendingMoreRef = useRef(false);

  const load = useCallback(async (more: boolean) => {
    if (!shelfFeedSupports(channel)) return;
    /**
     * 在途单飞 —— 但**不能静默丢弃翻页意图**。
     *
     * ## 旧实现的 bug（2026-10-18）
     *
     * 旧代码是 `if (more && inFlightRef.current) return;`，直接 return 掉。
     * 而 `useInfiniteScroll` 的 observer 与 `usePrefetchBackstop` 的几何兜底
     * 都可能在同一帧里各触发一次 —— 第二次被这样吞掉之后，没有任何东西会
     * "记得"这次意图：
     *   - 第一次请求成功回来，`itemCount` 变了 → 兜底重算 → 可能再发一次（运气好）；
     *   - 但若第一次返回的条目数不足以把哨兵推出缓冲线，兜底**不会再触发**
     *     （它的依赖里 `itemCount` 没变、`isLoadingMore` 也没变），
     *     于是无限流就停在那里，底部还挂着上一次的"正在加载更多…"。
     *
     * 现在改成**记下这次意图**，等当前请求结束后自动补发一次。这样无论谁先谁后
     * 触发，翻页都不会丢。
     */
    if (more && inFlightRef.current) {
      pendingMoreRef.current = true;
      return;
    }
    inFlightRef.current = true;
    // 首页把 requestId 推进一格作废在途请求；翻页沿用它，只靠 inFlightRef 单飞。
    const requestId = more ? requestIdRef.current : ++requestIdRef.current;

    if (!more) {
      const cached = readFirstPage(kind, channel);
      // 命中首页缓存：先把旧内容摆出来（0ms），不闪白也不空一屏。
      cursorRef.current = cached?.nextCursor;
      itemsRef.current = cached?.items ?? [];
      setState(cached
        ? { ...EMPTY_STATE, items: cached.items, hasMore: cached.hasMore }
        : { ...EMPTY_STATE, isLoading: true });
      if (cached) {
        inFlightRef.current = false;
        // 命中缓存是"首屏"路径，但 pending 意图仍要照顾：若之前有翻页被
        // 挡在 inFlight 之外，这里不补发就永远丢了。
        if (pendingMoreRef.current) {
          pendingMoreRef.current = false;
          window.setTimeout(() => void load(true), 0);
        }
        return;
      }
    } else {
      setState(prev => ({ ...prev, isLoadingMore: true, error: null }));
    }

    try {
      const page = await ipcService.shelf.feed(kind, channel, more ? cursorRef.current : undefined);
      if (requestId !== requestIdRef.current) return;
      cursorRef.current = page.nextCursor;
      if (!more) {
        firstPageCache.set(cacheKey(kind, channel), {
          items: page.items,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
          at: Date.now(),
        });
      }
      // 游标翻页可能回吐重复条目（尤其榜单的 next_offset 与本站列表长度不一致时），
      // 按 id 去重。
      const seen = new Set(itemsRef.current.map(item => item.id));
      const fresh = more ? page.items.filter(item => !seen.has(item.id)) : page.items;
      const merged = more ? [...itemsRef.current, ...fresh] : fresh;
      itemsRef.current = merged;

      /**
       * 「这一页全是重复」**不等于**「到底了」。
       *
       * ## 旧实现的 bug（2026-10-18）
       *
       * 旧判据是 `hasMore: page.hasMore && (!more || fresh.length > 0)` ——
       * 只要某一页去重后为空，就永久把 `hasMore` 置 false。而翻页链路上有两种
       * **正常**情况会让某一页全重复：
       *
       *   1. 站方游标与实际条目数错位（`next_offset` 比列表长度大/小），
       *      偶尔会回吐上一页；
       *   2. 榜单接口按 `session_uuid` 串会话，跨会话续翻时可能先吐一小段重复。
       *
       * 这两种都只是"这一页没新东西"，下一页往往又有。旧实现把它们当成终点，
       * 于是用户滚到第 10 部就被判定"已加载全部"，而站方其实还有几十页 ——
       * 这正是「无限流不彻底」的直接原因。
       *
       * ## 新判据
       *
       * 以**站方的 `hasMore`** 为准，只在连续多页都空时才收尾（防止真的陷入
       * 死循环）。计数用 ref，不进 state —— 它只是收敛判据，不需要触发渲染。
       */
      if (fresh.length > 0) {
        emptyPagesRef.current = 0;
      } else if (more) {
        emptyPagesRef.current += 1;
      }
      // 连续 3 页都去重为空：这时才认为确实到头了。
      const exhaustedByEmptyPages = emptyPagesRef.current >= 3;
      setState(prev => ({
        items: merged,
        isLoading: false,
        isLoadingMore: false,
        hasMore: page.hasMore && !exhaustedByEmptyPages,
        error: null,
        // 每落地一页就 +1，**与这一页带来几条新卡片无关** ——
        // 这是 `usePrefetchBackstop` 重新量几何的唯一信号，缺了它，
        // 去重为空的页会让无限流停住。
        pagesLoaded: prev.pagesLoaded + 1,
      }));
      /**
       * 卡片落地即预热封面（2026-10-24）。
       *
       * 货架的条目来自红果 App 接口，其中一部分是 guo id（用户启用了 guo 源时），
       * 它们的封面要走 guo-core。`guoCoverPrefetch` 只处理 guo id，非 guo 的
       * （红果 HEIC）由各自卡片走 `shelf.cover`，这里不碰。
       *
       * 放在 `setState` 之后、不 await：封面是装饰，预热失败由卡片自己的退避
       * 重试兜住。
       */
      void ipcService.catalog.guoCoverPrefetch(merged.map(item => item.id));
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      setState(prev => ({
        ...prev,
        isLoading: false,
        isLoadingMore: false,
        error: errorText(error, '列表加载失败'),
      }));
    } finally {
      inFlightRef.current = false;
      // 在途期间被丢弃的翻页意图：现在补发。
      //
      // 用微任务而不是同步调用：`setState` 刚刚提交，同步递归会在 React 还没
      // 渲染出"这一页已落地"时又发一次请求，算出的游标仍是旧的。
      // 延迟一拍让状态先落定，再按新游标继续翻。
      if (pendingMoreRef.current) {
        pendingMoreRef.current = false;
        window.setTimeout(() => void load(true), 0);
      }
    }
  }, [kind, channel]);

  useEffect(() => {
    if (!shelfFeedSupports(channel)) {
      itemsRef.current = [];
      cursorRef.current = undefined;
      setState(EMPTY_STATE);
      return;
    }
    void load(false);
  }, [load, channel]);

  return {
    ...state,
    loadMore: useCallback(() => void load(true), [load]),
    reload: useCallback(() => {
      // 手动重试要先丢掉缓存，否则 `load(false)` 会拿同一份缓存直接返回。
      firstPageCache.delete(cacheKey(kind, channel));
      void load(false);
    }, [kind, channel, load]),
  };
}
