import { CatalogFilter, CatalogPage, SeriesItem } from '../types/catalog';
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

/**
 * guo 封面解析结果的会话内缓存。
 *
 * key 是 seriesId，值是后端返回的**本地缓存文件路径**（或 `null` 表示该剧确实没有封面）。
 * 后端 `guo_cover` 自己也会落盘缓存，所以前端这份缓存不会拿到失效地址。
 *
 * 容量封顶：无限流会持续引入新剧，不设上限就是一个只增不减的 Map。
 */
const GUO_COVER_CACHE_LIMIT = 400;
const guoCoverCache = new Map<string, string | null>();
const guoCoverInflight = new Map<string, Promise<string | null>>();

function rememberGuoCover(seriesId: string, path: string | null): void {
  guoCoverCache.set(seriesId, path);
  if (guoCoverCache.size <= GUO_COVER_CACHE_LIMIT) return;
  // Map 保持插入序：删最早插入的那一批即可，不必维护完整 LRU。
  const excess = guoCoverCache.size - GUO_COVER_CACHE_LIMIT;
  let removed = 0;
  for (const key of guoCoverCache.keys()) {
    guoCoverCache.delete(key);
    removed += 1;
    if (removed >= excess) break;
  }
}

/**
 * 记住剧集来源。
 *
 * 只在**有值**时写入：channel 缺失不代表来源是短剧，无脑覆盖反而会把已知的
 * `anime` 抹掉。来源判定的真正权威是 id 前缀（后端 `is_anime_id`，见
 * `anime_provider::BFZY_ID_PREFIX`），这个 Map 只为兼容加前缀之前生成的旧裸数字 id。
 */
function rememberChannel(seriesId: string, channel?: string | null): void {
  if (seriesId && channel) channelBySeriesId.set(seriesId, channel);
}
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
  showAdultSources: false,
  enabledSources: ['hongguo'],
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

/**
 * Web/演示模式的目录分页（含关键词本地过滤）。
 *
 * 真实链路的搜索在 Rust 侧（红果网页 + 动漫源 + App 联想），这里只是让浏览器
 * 预览态仍能走通"输入关键词 → 出卡片"这条交互。
 */
async function mockCatalogList(filter: CatalogFilter): Promise<CatalogPage> {
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
}

/**
 * 19 个 guo 站源的实时状态，逐字段对应 guo-core 的 `nativeSourceStatus`
 * （`src-tauri/guo-core/core/app_sources.go`），Rust 侧原样透传。
 *
 * ⚠️ 这些字段不是前端设计的，改之前先去 Go 源码对齐。几个容易踩的点：
 * - `updatedAt` 是 `time.Time`，**零值是 `"0001-01-01T00:00:00Z"` 而不是 null**，
 *   那是"从未拉取过目录"，UI 必须当成未检测而不是公元 1 年。
 * - `hasMore` 在源从未被收录时**也是 true**（Go: `!found || state.HasMore`），
 *   所以"有条目时才算有更多页"是必要的，不能照字面渲染。
 * - `health` 是可选字段，缺它就是**没跑过体检**，不是"一切正常"。
 */
export interface GuoSourceStatus {
  source: string;
  count: number;
  page: number;
  hasMore: boolean;
  /** RFC3339。零值 `0001-01-01T00:00:00Z` = 从未更新。 */
  updatedAt: string;
  operation: string;
  running: boolean;
  stage: string;
  completed: number;
  total: number;
  added: number;
  /** 站源任务记录的失败原因。Go 侧已过 `publicError`（URL 的 query 被打码）。 */
  error?: string;
  storageError?: string;
  startedAt: string;
  finishedAt: string;
  retryAt: string;
  health?: GuoSourceCheck;
}

/**
 * 单源五步链路体检报告，对应 Go 的 `nativeSourceHealth` + `nativeHealthStep`
 * （`app_source_health.go`）。
 *
 * `state` 取值来自 Go：`ok` = 五步全过（入口→目录→分集→播放地址→密钥→媒体），
 * `catalogOnly` = 只验到目录就停了（`checkCatalog` 模式，不验播放），
 * `failed` = 中途失败，`checking` = 还在跑。
 */
export interface GuoSourceCheck {
  checkedAt: string;
  state: 'checking' | 'ok' | 'catalogOnly' | 'failed';
  /** 被抽检的剧名——用来确认"体检的到底是不是我想的那一部"。 */
  sample: string;
  steps: GuoSourceStep[];
}

export interface GuoSourceStep {
  name: string;
  state: 'ok' | 'failed';
  /**
   * ⚠️ 成功时是 Go 侧写死的字面量（"已解析 N 部剧"等）；失败时来自
   * `publicError(err)`，那是站方响应的派生物——只把 URL 的 query 打了码，
   * 不挡本地路径与裸 token。调用方只在 `state === 'ok'` 时展示它。
   */
  message: string;
  host?: string;
  /** Go 侧带 `omitempty`，无响应时该字段缺省。 */
  httpStatus?: number;
  elapsedMs: number;
}

export const ipcService = {
  catalog: {
    async list(filter: CatalogFilter): Promise<CatalogPage> {
      if (isTauriEnvironment()) {
        const page = await invokeBackend<CatalogPage>('catalog_list', { filter });
        page.items.forEach(item => channelBySeriesId.set(item.id, item.type));
        return page;
      }

      return mockCatalogList(filter);
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
     * 搜索的"快速首屏"：只跑结构化来源（红果网页 + 动漫源），不等 App 联想。
     *
     * 联想要冷启动一个 Python 进程（实测端到端 0.6-1.9s），把它留在首屏链路上
     * 会让网页结果 0.3s 就绪也得陪等到一秒以后——那是"搜索慢"的主因。调用方
     * 拿到首屏后再调 `searchSuggest` 把联想追加到尾部。
     */
    async searchFast(filter: CatalogFilter): Promise<CatalogPage> {
      if (isTauriEnvironment()) {
        const page = await invokeBackend<CatalogPage>('catalog_fast_search', { filter });
        page.items.forEach(item => channelBySeriesId.set(item.id, item.type));
        return page;
      }
      return mockCatalogList(filter);
    },
    /**
     * App 搜索联想：补齐网页搜索只返回前 10 条时漏掉的分季条目。
     *
     * 失败返回空数组——它是补充来源，不该让整次搜索报错。
     */
    async searchSuggest(keyword: string, channel: CatalogFilter['channel']): Promise<SeriesItem[]> {
      if (!isTauriEnvironment()) return [];
      try {
        const items = await invokeBackend<SeriesItem[]>('catalog_suggest', { keyword, channel });
        items.forEach(item => channelBySeriesId.set(item.id, item.type));
        return items;
      } catch {
        return [];
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
    async categories(channel: CatalogFilter['channel'], source?: string): Promise<string[]> {
      if (!isTauriEnvironment()) return [];
      try {
        return await invokeBackend<string[]>('catalog_categories', { channel, source });
      } catch {
        return [];
      }
    },
    /**
     * guo 源的封面：返回本地缓存文件路径（调用方 convertFileSrc 后呈现）。
     *
     * 不能直接把站源封面地址塞给 `<img>`：黄果视频有 Cloudflare 防护（实测
     * 裸请求 403），部分源封面还是加过密的（前端拿到密文无从解码）。统一交
     * 给 guo-core 带源侧 Referer 下载、解密、校验后落盘。失败返回 null——
     * 调用方按"无封面"处置，不重试。
     */
async guoCover(seriesId: string): Promise<string | null> {
      if (!isTauriEnvironment()) return null;
      // 会话内缓存 + 在途去重。
      //
      // 两个理由：
      // ① 同一张卡可能同时挂在多个视图上（App.tsx 所有视图常驻 DOM），同一部剧的封面
      //    就会被请求两次；这里也顺带覆盖详情页再次取同一张封面。
      // ② 后端已经把封面落盘缓存，返回的是稳定的本地路径，所以前端缓存不会拿到过期地址。
      //    缓存失败结果（null）也要记：那个源确实没有封面，重试只是白打一次 IPC。
      const cached = guoCoverCache.get(seriesId);
      if (cached !== undefined) return cached;
      const inflight = guoCoverInflight.get(seriesId);
      if (inflight) return inflight;

      const request = invokeBackend<string | null>('guo_cover', { seriesId })
        .then(path => {
          rememberGuoCover(seriesId, path);
          return path;
        })
        .catch(() => {
          rememberGuoCover(seriesId, null);
          return null;
        })
        .finally(() => {
          guoCoverInflight.delete(seriesId);
        });
      guoCoverInflight.set(seriesId, request);
      return request;
    },
    /**
     * 逐源实时状态。取代 `guoSources.ts` 里手写的 `status`——那批判定是一次性
     * 探针手填的（2026-09-29），站点状态会变，而 guo-core 本来就一直在跑体检。
     *
     * Web/演示模式返回空数组而不是编 19 条假记录：调用方按 id 查表，查不到
     * 一律显示"未检测"，与真跑一次体检的观感完全一致 —— 编造 `count` /
     * `updatedAt` 反而是在断言站方状态（不变量 8）。
     */
    async guoSourceStatus(): Promise<GuoSourceStatus[]> {
      if (!isTauriEnvironment()) return [];
      try {
        return await invokeBackend<GuoSourceStatus[]>('guo_source_status');
      } catch {
        return [];
      }
    },
    /**
     * 对单个源跑一次五步链路体检（入口→目录→分集→播放地址→密钥→媒体）。
     *
     * ⚠️ **后端返回的是整条源状态记录，体检报告嵌在 `.health` 里**（同
     * `guoSourceStatus` 的形状），不是裸的体检对象。原先按 `GuoSourceCheck`
     * 顶层断言，调用方读 `report.steps` 得到 `undefined`，`.length` 在渲染期
     * 抛错 —— 仓库里没有 ErrorBoundary，一处渲染异常就是整页白屏。
     * 后端失败时返回的是 `{error: ...}`（不是 Err），所以这里必须显式判空后
     * 抛出去，否则界面会把"失败"当"已完成"渲染（不变量 8）。
     */
    async guoSourceCheck(source: string): Promise<GuoSourceCheck> {
      if (!isTauriEnvironment()) {
        return { checkedAt: '', state: 'checking', sample: '', steps: [] };
      }
      const status = await invokeBackend<GuoSourceStatus>('guo_source_check', { source });
      if (!status || status.error || !status.health) {
        throw new Error(status?.error || '未拿到体检报告');
      }
      return status.health;
    },
    /**
     * guo 源的网络模式：`direct` 直连 / `auto` 跟随系统代理。
     *
     * 真实状态存放在 guo-core 的 resource-settings.json（后端首次运行默认
     * 直连——guo 源全是境内 CDN 站点，实测系统代理出口会被站点 403）。读取
     * 失败返回 null：设置页按"未知"渲染并禁用开关，不猜默认值。
     */
    async guoProxyMode(): Promise<'auto' | 'direct' | null> {
      if (!isTauriEnvironment()) return null;
      try {
        const mode = await invokeBackend<string>('guo_proxy_get');
        return mode === 'auto' || mode === 'direct' ? mode : null;
      } catch {
        return null;
      }
    },
    /** 切换 guo 源网络模式，guo-core 热应用并持久化，无需重启。失败时抛错。 */
    async setGuoProxyMode(mode: 'auto' | 'direct'): Promise<void> {
      if (!isTauriEnvironment()) return;
      await invokeBackend('guo_proxy_set', { mode });
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
      if (isTauriEnvironment()) {
        const items = await invokeBackend<WatchHistoryItem[]>('history_list');
        // 回填来源映射：历史是**冷启动就能直达详情**的入口，而 channelBySeriesId 是
        // 内存 Map（应用重载后为空）。不回填的话，从历史点进加前缀之前的旧动漫 id
        // 会因 channel 缺失而被路由到红果链路（实测：标题是别人的、共 0 集全）。
        items.forEach(item => rememberChannel(item.seriesId, item.channel));
        return items;
      }
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
        const items = await invokeBackend<FavoriteItem[]>('favorites_list', { mark: mark ?? null });
        // 同 history.list：收藏页也是冷启动直达详情的入口，必须回填来源映射。
        items.forEach(item => rememberChannel(item.seriesId, item.channel));
        return items;
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
