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

  const load = useCallback(async (more: boolean) => {
    if (!shelfFeedSupports(channel)) return;
    if (more && inFlightRef.current) return;
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
      // 按 id 去重；一页全是重复就说明到底了，不能让它继续翻。
      const seen = new Set(itemsRef.current.map(item => item.id));
      const fresh = more ? page.items.filter(item => !seen.has(item.id)) : page.items;
      const merged = more ? [...itemsRef.current, ...fresh] : fresh;
      itemsRef.current = merged;
      setState({
        items: merged,
        isLoading: false,
        isLoadingMore: false,
        hasMore: page.hasMore && (!more || fresh.length > 0),
        error: null,
      });
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
