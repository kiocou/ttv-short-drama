import { CatalogFilter, CatalogPage } from '../types/catalog';
import { SeriesDetail } from '../types/series';
import { PlaybackSession, PlaybackSnapshot } from '../types/playback';
import { WatchHistoryItem } from '../types/history';
import { FavoriteItem } from '../types/favorite';
import { UserSettings } from '../types/settings';
import { MOCK_SERIES_LIST, getSeriesDetail, INITIAL_WATCH_HISTORY } from './mockData';

export function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

async function invokeBackend<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriEnvironment()) throw new Error('短剧桌面后端未启动。');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

let currentGlobalSessionId = 100;
const channelBySeriesId = new Map<string, string>();
// 会话级详情缓存：同一部剧换集/切清晰度时跳过网络往返，直接复用详情。
// 独立缓存不过期，重新打开应用自然刷新。
const detailCache = new Map<string, SeriesDetail>();

export function invalidateSeriesCache(seriesId?: string): void {
  if (seriesId) detailCache.delete(seriesId);
  else detailCache.clear();
}

export function generateNextSessionId(): number {
  currentGlobalSessionId += 1;
  return currentGlobalSessionId;
}

const STORAGE_KEYS = {
  HISTORY: 'ttv_short_drama_history_v1',
  SETTINGS: 'ttv_short_drama_settings_v1',
  FAVORITES: 'ttv_short_drama_favorites_v1',
};

export const DEFAULT_SETTINGS: UserSettings = {
  defaultQuality: 'auto',
  autoNext: true,
  countdownSeconds: 5,
  preferredEngine: 'off',
  targetFps: 60,
  catalogCacheMb: 0,
  playbackCacheMb: 0,
};

function loadStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveStorage<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn(`Storage save failed for ${key}:`, error);
  }
}

export const ipcService = {
  catalog: {
    async list(filter: CatalogFilter): Promise<CatalogPage> {
      if (isTauriEnvironment()) {
        const page = await invokeBackend<CatalogPage>('catalog_list', { filter });
        page.items.forEach(item => channelBySeriesId.set(item.id, item.type));
        return page;
      }

      await new Promise(resolve => setTimeout(resolve, 120));
      let list = MOCK_SERIES_LIST.filter(item => item.type === filter.channel);
      if (filter.category !== '全部') list = list.filter(item => item.tags.includes(filter.category));
      if (filter.audience !== '全部') list = list.filter(item => item.tags.some(tag => tag.includes(filter.audience)));
      if (filter.keyword?.trim()) {
        const keyword = filter.keyword.trim().toLocaleLowerCase();
        list = list.filter(item => item.title.toLocaleLowerCase().includes(keyword)
          || item.tags.some(tag => tag.toLocaleLowerCase().includes(keyword)));
      }
      if (filter.sort === 'heat') list = [...list].sort((a, b) => (b.heat || 0) - (a.heat || 0));
      if (filter.sort === 'latest') list = [...list].reverse();
      const start = (filter.page - 1) * filter.pageSize;
      const items = list.slice(start, start + filter.pageSize);
      return {
        items,
        total: list.length,
        hasMore: start + items.length < list.length,
        page: filter.page,
        categories: ['全部', ...[...new Set(list.flatMap(item => item.tags))].slice(0, 12)],
      };
    },
    /**
     * 批量补齐真实集数（实际上只有漫剧需要）。
     *
     * 漫剧列表来自公开榜单页 HTML，而该页（含内嵌 router data）不含任何集数文案
     * ——实测整页 `episode_cnt` 出现 0 次，所以卡片只能显示"集数未知"。真实集数
     * 在 App 侧：album_detail 支持一次传多个 series_ids，一次可覆盖整页卡片。
     * 失败返回空对象——集数未知不该影响目录可用性。
     */
    async episodeCounts(seriesIds: string[]): Promise<Record<string, number>> {
      if (seriesIds.length === 0 || !isTauriEnvironment()) return {};
      try {
        return await invokeBackend<Record<string, number>>(
          'short_drama_app_episode_counts',
          { seriesIds },
        );
      } catch {
        return {};
      }
    },
    /**
     * 全站题材词表。
     *
     * 目录分页一次只有 24 条，按页取词表会让题材栏随翻页/筛选变来变去，也拿不到
     * 全站的题材。这里由后端汇总全站目录后给出稳定全集（首次调用要建索引，约数秒），
     * 所以调用方应在首屏渲染完成后后台调用。失败返回空数组——题材栏保留原有内容，
     * 不该因为一次抖动而空掉。
     */
    async categories(channel: CatalogFilter['channel']): Promise<string[]> {
      if (!isTauriEnvironment()) return [];
      try {
        return await invokeBackend<string[]>('catalog_categories', { channel });
      } catch {
        return [];
      }
    },
  },

  series: {
    async getDetail(seriesId: string): Promise<SeriesDetail> {
      const cached = detailCache.get(seriesId);
      if (cached) return cached;
      if (isTauriEnvironment()) {
        const detail = await invokeBackend<SeriesDetail>('series_detail', { seriesId, channel: channelBySeriesId.get(seriesId) });
        detailCache.set(seriesId, detail);
        return detail;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      const detail = getSeriesDetail(seriesId);
      if (!detail) throw new Error('未找到该剧集。');
      return detail;
    },
  },

  playback: {
    async open(seriesId: string, episodeId: string, quality = 'auto', position = 0, sessionId = generateNextSessionId(), isAnime = false): Promise<PlaybackSession> {
      if (isTauriEnvironment()) {
        return invokeBackend<PlaybackSession>('playback_open', {
          input: { sessionId, seriesId, episodeId, quality, position, isAnime },
        });
      }
      const detail = getSeriesDetail(seriesId);
      const episode = detail?.episodes.find(item => item.id === episodeId) ?? detail?.episodes[0];
      return {
        sessionId,
        seriesId,
        episodeId: episode?.id ?? episodeId,
        position,
        quality,
        url: episode?.videoUrl ?? '',
      };
    },

    async command(sessionId: number, action: 'play' | 'pause' | 'seek' | 'volume' | 'stop', payload?: unknown): Promise<void> {
      if (isTauriEnvironment()) await invokeBackend('playback_command', { sessionId, action, payload });
    },

    async openExternal(url: string): Promise<void> {
      if (isTauriEnvironment()) await invokeBackend('external_player_open', { url });
    },

    async resolveNative(seriesId: string, vid: string, contentType?: number, quality = 'auto'): Promise<{ playUrl: string; width: number; height: number; sizeBytes: number; cached: boolean }> {
      if (!isTauriEnvironment()) throw new Error('原生短剧播放仅在桌面应用中可用。');
      return invokeBackend('short_drama_app_resolve', {
        input: { seriesId, vid, contentType, quality },
      });
    },

    // 后台预取：只暖缓存，不接管播放器。命中缓存时后端零开销直接返回。
    async prefetchNative(seriesId: string, vid: string, contentType?: number, quality = 'auto'): Promise<void> {
      if (!isTauriEnvironment()) return;
      try {
        // resolveNative 缓存命中时直接返回路径，未命中则 worker 后台下载。
        await invokeBackend('short_drama_app_resolve', {
          input: { seriesId, vid, contentType, quality },
        });
      } catch {
        // 预取失败静默：前台播放时自然会再试一遍完整链路。
      }
    },

    async streamNative(vid: string, contentType?: number): Promise<{ url: string; decryptionKey: string; width: number; height: number }> {
      if (!isTauriEnvironment()) throw new Error('原生短剧播放仅在桌面应用中可用。');
      return invokeBackend('short_drama_app_stream', {
        input: { vid, contentType },
      });
    },

    // 真实清晰度档位：由后端签名取回该集的 variants，报出源流实际提供的
    // 分辨率。失败返回空数组——清晰度是附加信息，不该阻塞播放。
    async listNativeQualities(vid: string, contentType?: number): Promise<Array<{ id: string; label: string; width: number; height: number; bitrate: number }>> {
      if (!isTauriEnvironment()) return [];
      try {
        const variants = await invokeBackend<Array<{ id: string; label: string; width: number; height: number; bitrate: number }>>(
          'short_drama_app_qualities',
          { input: { vid, contentType } },
        );
        return variants ?? [];
      } catch {
        return [];
      }
    },

    /**
     * 动漫专区的清晰度档位。
     *
     * 与 `listNativeQualities` 的区别：那条走的是红果 worker，对动漫源无效；
     * 动漫的档位藏在播放解析里，必须由后端解析一次才能拿到（1~2 档）。
     * 失败返回空数组——清晰度是附加信息，不该阻塞播放。
     */
    async animeQualities(
      seriesId: string,
      episodeId: string,
    ): Promise<Array<{ label: string; value: string; resolution: string }>> {
      if (!isTauriEnvironment()) return [];
      try {
        const options = await invokeBackend<Array<{ label: string; value: string; resolution: string }>>(
          'anime_qualities',
          { seriesId, episodeId },
        );
        return options ?? [];
      } catch {
        return [];
      }
    },

    // 预签名：只取播放直链与解密密钥，不下载任何媒体数据。
    //
    // 后端实测这条链路是两次 App API 往返、固定 2.16s，是首播耗时里最大的一块
    // 固定开销。提前做完，点集时 resolve 就不必再等它。
    async prefetchStream(vids: string[], contentType?: number): Promise<number> {
      if (!isTauriEnvironment() || vids.length === 0) return 0;
      try {
        const ready = await invokeBackend<number>('short_drama_app_prefetch_stream', {
          input: { vids, contentType },
        });
        return ready ?? 0;
      } catch {
        // 纯优化：失败静默，点集时后端照常走完整签名链路。
        return 0;
      }
    },

    async snapshot(sessionId: number): Promise<PlaybackSnapshot> {
      if (isTauriEnvironment()) return invokeBackend<PlaybackSnapshot>('playback_snapshot', { sessionId });
      return {
        sessionId,
        state: { kind: 'idle' },
        position: 0,
        duration: 0,
        buffered: 0,
        volume: 1,
        muted: false,
        playbackRate: 1,
      };
    },
  },

  history: {
    async list(): Promise<WatchHistoryItem[]> {
      if (isTauriEnvironment()) return invokeBackend<WatchHistoryItem[]>('history_list');
      return loadStorage<WatchHistoryItem[]>(STORAGE_KEYS.HISTORY, INITIAL_WATCH_HISTORY);
    },

    async save(item: WatchHistoryItem): Promise<void> {
      if (isTauriEnvironment()) {
        await invokeBackend('history_save', { item });
        return;
      }
      const list = loadStorage<WatchHistoryItem[]>(STORAGE_KEYS.HISTORY, INITIAL_WATCH_HISTORY);
      saveStorage(STORAGE_KEYS.HISTORY, [item, ...list.filter(existing => existing.seriesId !== item.seriesId)]);
    },

    async remove(seriesId: string): Promise<void> {
      if (isTauriEnvironment()) {
        await invokeBackend('history_remove', { seriesId });
        return;
      }
      const list = loadStorage<WatchHistoryItem[]>(STORAGE_KEYS.HISTORY, INITIAL_WATCH_HISTORY);
      saveStorage(STORAGE_KEYS.HISTORY, list.filter(item => item.seriesId !== seriesId));
    },

    async clear(): Promise<void> {
      if (isTauriEnvironment()) {
        await invokeBackend('history_clear');
        return;
      }
      saveStorage(STORAGE_KEYS.HISTORY, []);
    },
  },

  favorites: {
    async list(mark?: string): Promise<FavoriteItem[]> {
      if (isTauriEnvironment()) {
        return invokeBackend<FavoriteItem[]>('favorites_list', { mark: mark ?? null });
      }
      const list = loadStorage<FavoriteItem[]>(STORAGE_KEYS.FAVORITES, []);
      return mark ? list.filter(item => item.mark === mark) : list;
    },

    async save(item: FavoriteItem): Promise<void> {
      if (isTauriEnvironment()) {
        await invokeBackend('favorites_save', { item });
        return;
      }
      const list = loadStorage<FavoriteItem[]>(STORAGE_KEYS.FAVORITES, []);
      saveStorage(STORAGE_KEYS.FAVORITES, [item, ...list.filter(existing => existing.seriesId !== item.seriesId)]);
    },

    async remove(seriesId: string): Promise<void> {
      if (isTauriEnvironment()) {
        await invokeBackend('favorites_remove', { seriesId });
        return;
      }
      const list = loadStorage<FavoriteItem[]>(STORAGE_KEYS.FAVORITES, []);
      saveStorage(STORAGE_KEYS.FAVORITES, list.filter(item => item.seriesId !== seriesId));
    },
  },

  settings: {
    async get(): Promise<UserSettings> {
      if (isTauriEnvironment()) return invokeBackend<UserSettings>('settings_get');
      return loadStorage<UserSettings>(STORAGE_KEYS.SETTINGS, DEFAULT_SETTINGS);
    },

    async save(settings: UserSettings): Promise<void> {
      if (isTauriEnvironment()) {
        await invokeBackend('settings_save', { settings });
        return;
      }
      saveStorage(STORAGE_KEYS.SETTINGS, settings);
    },

    /** 查询真实缓存占用（短剧 + 漫剧合计）。返回 { files, bytes }。 */
    async cacheUsage(): Promise<{ files: number; bytes: number }> {
      if (isTauriEnvironment()) {
        const r = await invokeBackend<{ removedFiles: number; freedBytes: number }>(
          'short_drama_app_cache_usage',
        );
        return { files: r.removedFiles ?? 0, bytes: r.freedBytes ?? 0 };
      }
      return { files: 0, bytes: 0 };
    },

    async clearCache(): Promise<{ freedMb: number }> {
      if (isTauriEnvironment()) return invokeBackend<{ freedMb: number }>('cache_clear');
      await new Promise(resolve => setTimeout(resolve, 300));
      return { freedMb: 0 };
    },
  },
};
