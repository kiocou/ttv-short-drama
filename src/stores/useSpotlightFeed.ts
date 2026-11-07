import { useCallback, useEffect, useRef, useState } from 'react';
import { ipcService, errorText } from '../services/ipc';
import type { ChannelType, SeriesItem } from '../types/catalog';
import type { SpotlightKind } from './useAppStore';

/**
 * 三档落地页的数据源。
 *
 * ## 为什么每档必须走不同接口
 *
 * 旧实现把这三档折成 `CatalogFilter.sort` 的三个值，而目录接口在网页链路上
 * 只认频道段（`/category/real-drama`），`sort` 最终只影响返回值里那句中文
 * 描述（Rust 侧 `provider.rs::sort_label`）——三档点下去拿到的是同一批卡片，
 * 观感是"点了没反应"（用户报告）。
 *
 * 现在三档各自对齐到**真正提供这个维度**的接口：
 *
 * | 档位 | 接口 | 排序依据 |
 * | --- | --- | --- |
 * | 综合推荐 | `hongguo_discover`（推荐流） | 站方推荐算法 |
 * | 最新上线 | `short_drama_app_shelf_feed(kind=new)` | `sort=online_time` |
 * | 热度榜单 | `short_drama_app_shelf_feed(kind=hot)` | `hot_score" / cell 热播榜` |
 *
 * ## 分页
 *
 * 全部走**游标**（`nextCursor` 原样回传）。推荐流用 `cursor`，上架/榜单用后端
 * 编码过的不透明游标——这里不解析它的内容。
 */

interface FeedState {
  items: SeriesItem[];
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
}

export interface SpotlightFeed extends FeedState {
  loadMore: () => void;
  reload: () => void;
}

const EMPTY: FeedState = {
  items: [],
  hasMore: false,
  isLoading: true,
  isLoadingMore: false,
  error: null,
};

/** 落地页只服务短剧 / 漫剧；其它频道退回短剧口径，避免请求打到不存在的参数上。 */
function normalizeChannel(channel: ChannelType): 'drama' | 'comic' {
  return channel === 'comic' ? 'comic' : 'drama';
}

async function fetchPage(
  kind: SpotlightKind,
  channel: ChannelType,
  cursor?: string,
): Promise<{ items: SeriesItem[]; hasMore: boolean; nextCursor?: string }> {
  const target = normalizeChannel(channel);
  if (kind === 'recommend') {
    // 推荐流的两套口径：真人剧是 `live`，漫剧是 `comic`。
    // **不能传 `recommend`**：那是混合流，短剧专区里会掺进漫画（用户报告）。
    const page = await ipcService.hongguo.discover(
      target === 'comic' ? 'comic' : 'live',
      cursor ?? null,
    );
    return {
      items: page.items ?? [],
      hasMore: Boolean(page.hasMore),
      nextCursor: page.cursor ?? undefined,
    };
  }
  const page = await ipcService.shelf.feed(kind === 'latest' ? 'new' : 'hot', target, cursor);
  return { items: page.items, hasMore: page.hasMore, nextCursor: page.nextCursor };
}

export function useSpotlightFeed(kind: SpotlightKind, channel: ChannelType): SpotlightFeed {
  const [state, setState] = useState<FeedState>(EMPTY);
  const cursorRef = useRef<string | undefined>(undefined);
  const itemsRef = useRef<SeriesItem[]>([]);
  const requestIdRef = useRef(0);
  const inFlightRef = useRef(false);
  /** 到底了就不再发请求：游标式接口对"末尾再翻一页"不会报错，只会一直空转。 */
  const endedRef = useRef(false);

  const load = useCallback(async (more: boolean) => {
    if (more && (inFlightRef.current || endedRef.current)) return;
    inFlightRef.current = true;
    const requestId = more ? requestIdRef.current : ++requestIdRef.current;

    if (!more) {
      cursorRef.current = undefined;
      itemsRef.current = [];
      endedRef.current = false;
      setState({ ...EMPTY, isLoading: true });
    } else {
      setState(prev => ({ ...prev, isLoadingMore: true, error: null }));
    }

    try {
      const page = await fetchPage(kind, channel, more ? cursorRef.current : undefined);
      if (requestId !== requestIdRef.current) return;
      cursorRef.current = page.nextCursor;
      if (!page.hasMore || !page.nextCursor) endedRef.current = true;

      // 游标翻页可能回吐重复条目（榜单的 next_offset 与列表长度常常错位），按 id 去重。
      const seen = new Set(itemsRef.current.map(item => item.id));
      const fresh = more ? page.items.filter(item => !seen.has(item.id)) : page.items;
      const merged = more ? [...itemsRef.current, ...fresh] : fresh;
      itemsRef.current = merged;
      setState({
        items: merged,
        hasMore: page.hasMore,
        isLoading: false,
        isLoadingMore: false,
        error: null,
      });
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      setState(prev => ({
        ...prev,
        isLoading: false,
        isLoadingMore: false,
        error: errorText(error, '加载失败'),
      }));
    } finally {
      if (requestId === requestIdRef.current) inFlightRef.current = false;
    }
  }, [kind, channel]);

  // 换档位/换频道整体重来：`kind` 与 `channel` 都在依赖里，任何一项变化都重新首屏。
  useEffect(() => {
    void load(false);
  }, [load]);

  const loadMore = useCallback(() => {
    if (!state.hasMore) return;
    void load(true);
  }, [load, state.hasMore]);

  const reload = useCallback(() => {
    void load(false);
  }, [load]);

  return { ...state, loadMore, reload };
}
