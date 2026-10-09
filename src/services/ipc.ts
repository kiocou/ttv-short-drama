import { CatalogFilter, CatalogPage, SeriesItem, ShelfFeedPage, ShelfKind, ChannelType } from '../types/catalog';
import { SeriesDetail } from '../types/series';
import { PlaybackSession, PlaybackSnapshot } from '../types/playback';
import { WatchHistoryItem } from '../types/history';
import { FavoriteItem } from '../types/favorite';
import { UserSettings } from '../types/settings';
import { MOCK_SERIES_LIST, getSeriesDetail, INITIAL_WATCH_HISTORY } from './mockData';

/** 后端 trace_tail 的一次增量拉取结果（字段名与 Rust 侧 camelCase 一致）。 */
export interface TraceTail {
  lines: string[];
  nextCursor: number;
  /** true 表示环形缓冲淘汰了旧行，本次拉取之前有日志被挤掉了。 */
  dropped: boolean;
}

/**
 * 一次本地播放解析的结果。
 *
 * `streamKind` 缺省表示 `playUrl` 是**本地文件路径**（走 convertFileSrc + <video>.src）；
 * `'hls'` 表示它是本地 HLS 地址（必须走 hls.js 挂载）。两者装载方式完全不同，
 * 判错的表现是「地址看起来没问题、播放器却一直黑屏」——因为 asset:// 指向一个
 * 根本不存在的文件。
 */
export interface NativeResolved {
  playUrl: string;
  width: number;
  height: number;
  sizeBytes: number;
  cached: boolean;
  /** 'hls' = 本地 HLS 地址；缺省 = 本地文件路径。 */
  streamKind?: string;
  /** 本地 HLS 失败时的回退地址（原始加密直链）。 */
  backupUrl?: string;
  /**
   * **源片真实总时长**（毫秒）。0 或缺失表示未知。
   *
   * 边转边播时浏览器算不出总时长（分片清单还没 ENDLIST），只能退回
   * `seekable`/`buffered` 末尾——而那两个值随转码进度增长，时长会一路往上跳。
   * 后端把这个值交下来，前端以它为权威，时长从此固定。
   */
  durationMs?: number;
}

export function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

/**
 * 把任意抛出物转成可读文案。
 *
 * **Tauri 的 `invoke` 被后端 `Err(String)` 拒绝时，抛出来的是那个原字符串，不是
 * `Error` 对象。** 于是 `(err as Error).message` 恒为 `undefined` —— 后端辛苦拼出来的
 * 错误详情（"红果接口错误 111104：…" 之类）会被静默换成一句通用兜底，排查时等于
 * 什么都没拿到。这里统一收口，新增的 catch 一律用它。
 */
export function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message.trim() || fallback;
  const text = typeof error === 'string' ? error : String(error ?? '');
  return text.trim() || fallback;
}

/**
 * 封面该走哪条解析通道。
 *
 * 三条路都有各自的硬理由，**不能合并成一个"万能代理"**：
 * - **guo 站源**（`guo:` 前缀）：封面直连不可用（黄果视频有 Cloudflare 防护、
 *   部分源封面是加密的），必须经 guo-core 带源侧 Referer 下载后取本地缓存文件。
 * - **红果的 HEIC**：图片服务给的是 `image/heic`，WebView2 / Chromium **解不了**，
 *   直接把地址交给 `<img>` 只会得到一块空白。必须经后端转码（见
 *   `short_drama_app_cover_proxy`）。判定用地址模板后缀 —— 红果的封面地址形如
 *   `…-aifit:400:0.heic?lk3s=…`。
 * - 其余（官网 HTML 抓来的 jpg/webp 等）：直接用原地址，别白白绕一次 IPC。
 *
 * 抽成公共函数是因为**首页货架与「更多」页都要用**：第一版只接进了「更多」页的
 * 行卡，首页那两栏走的是 `SeriesCard`，于是同一批剧在首页是空白、点进「更多」
 * 才有图（用户报告的"海报出不来"）。
 */
export function coverResolver(
  seriesId: string,
  cover: string,
): (() => Promise<string | null>) | undefined {
  if (seriesId.startsWith('guo:')) {
    return () => ipcService.catalog.guoCover(seriesId);
  }
  if (/\.heic(\?|$)/i.test(cover)) {
    return () => ipcService.shelf.cover(cover);
  }
  return undefined;
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
 * 红果封面解析结果的会话内缓存（值是 `data:` URL）。
 *
 * 与上面 guo 封面那份同构、同样封顶，但**只缓存成功**：guo 那份把 null 也记下来
 * 是因为"这个源确实没有封面"，重试纯属白打一次 IPC；红果这边拿到 null 更可能是
 * 一次网络抖动（后端要下载 + 转码），不记下来才有重试的机会。
 *
 * 封顶比 guo 那份更必要：每个值都是几十 KB 的 base64。
 */
const SHELF_COVER_CACHE_LIMIT = 120;
const shelfCoverCache = new Map<string, string>();
const shelfCoverInflight = new Map<string, Promise<string | null>>();

function rememberShelfCover(url: string, dataUrl: string): void {
  shelfCoverCache.set(url, dataUrl);
  if (shelfCoverCache.size <= SHELF_COVER_CACHE_LIMIT) return;
  const excess = shelfCoverCache.size - SHELF_COVER_CACHE_LIMIT;
  let removed = 0;
  for (const key of shelfCoverCache.keys()) {
    shelfCoverCache.delete(key);
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
const detailInflight = new Map<string, Promise<SeriesDetail>>();

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
  preferredEngine: 'off',
  targetFps: 60,
  // 后端契约字段（无界面开关）：必须与 models.rs 的 UserSettings 同形，
  // 否则 settings_save 反序列化整体失败 → 所有设置都不落库。详见 types/settings.ts。
  hardwareAcceleration: true,
  catalogCacheMb: 0,
  playbackCacheMb: 1024,
  showAdultSources: false,
  enabledSources: ['hongguo'],
  launchSound: true,
  // 默认开：现状（引入 media_enhance 之后）默认就走 VSR 转码链路，
  // 默认关会让老用户升级后行为突变。详见 types/settings.ts 的字段注释。
  vsrEnabled: true,
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
 * Web 演示模式下的分区列表：从 mock 目录里切一段。
 *
 * 这条链路在 Tauri 下走的是红果 App-API（榜单/最新上架），mock 里没有那套数据，
 * 所以按分区做一次排序近似 —— 保证「更多」页在浏览器里也能点开、能翻页。
 */
async function mockShelfFeed(kind: ShelfKind, channel: ChannelType, cursor?: string): Promise<ShelfFeedPage> {
  await new Promise(resolve => setTimeout(resolve, 120));
  const pageSize = 6;
  let list = MOCK_SERIES_LIST.filter(item => item.type === channel);
  if (kind === 'hot') list = [...list].sort((a, b) => (b.heat || 0) - (a.heat || 0));
  if (kind === 'new') list = [...list].reverse();
  const start = Number.parseInt(cursor || '0', 10) || 0;
  const items = list.slice(start, start + pageSize);
  const next = start + items.length;
  return {
    items,
    hasMore: next < list.length,
    nextCursor: next < list.length ? String(next) : undefined,
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
    /**
     * 目录拉取。
     *
     * `force = true` 只由**用户手动刷新**（首页两颗货架的刷新按钮）传入，用于
     * 让 guo 站源绕过 guo-core 的 TTL 磁盘缓存。guo 源默认是「缓存优先 + SWR」：
     * TTL 内直接回缓存、过期则回旧值后台刷新——不 force 的话，刷新按钮发出的
     * 请求拿回来的和屏幕上已有的完全一样，观感就是「点了没反应」。
     */
    async list(filter: CatalogFilter, force = false): Promise<CatalogPage> {
      if (isTauriEnvironment()) {
        const page = await invokeBackend<CatalogPage>('catalog_list', { filter, force });
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

  /**
   * 首页货架「更多」页的分区列表。
   *
   * 走的是**红果 App-API**（榜单 / 最新上架），不是 `catalog.list` 那条多源聚合
   * 链路：官方客户端的「热播」与「新剧」本来就是两条不同接口，而不是同一份列表
   * 切两段（结论来自**私有渠道**调研）。
   *
   * 分页是**游标式**：`cursor` 由后端产出、这里原样回传，前端不要解析它的内容。
   */
  shelf: {
    async feed(kind: ShelfKind, channel: ChannelType, cursor?: string): Promise<ShelfFeedPage> {
      if (isTauriEnvironment()) {
        const page = await invokeBackend<ShelfFeedPage>('short_drama_app_shelf_feed', {
          kind,
          channel,
          // 显式传 null：Tauri 的 Option<String> 形参缺键时虽然也能反序列化成 None，
          // 但把"没有下一页"写成显式 null 比依赖缺省语义更不容易被后来的改动踩坏。
          cursor: cursor ?? null,
        });
        // 与 catalog.list 一致：记住来源，`SeriesCard` 之外的地方靠它判断频道。
        page.items.forEach(item => channelBySeriesId.set(item.id, item.type));
        return page;
      }
      return mockShelfFeed(kind, channel, cursor);
    },

    /**
     * 红果封面 → 可直接喂给 `<img>` 的 `data:` URL。
     *
     * **为什么不是直接用原始地址**：红果图片服务给的是 **HEIC**，WebView2 解不了，
     * 直接把地址丢给 `<img>` 只会得到一块空白（用户报告的"视频海报出不来"）。
     * 后端负责下载、必要时用随包 ffmpeg 转 JPEG、落盘缓存，再把 JPEG 以 data URL
     * 回给前端 —— 细节见 `short_drama_app_cover_proxy` 的注释。
     *
     * 失败返回 `null`（封面渲染不了不该影响列表），且**不缓存失败**。
     */
    async cover(url: string): Promise<string | null> {
      if (!isTauriEnvironment() || !url.trim()) return null;
      const cached = shelfCoverCache.get(url);
      if (cached !== undefined) return cached;
      const inflight = shelfCoverInflight.get(url);
      if (inflight) return inflight;

      const request = invokeBackend<string>('short_drama_app_cover_proxy', { url })
        .then(dataUrl => {
          rememberShelfCover(url, dataUrl);
          return dataUrl;
        })
        .catch(() => null)
        .finally(() => {
          shelfCoverInflight.delete(url);
        });
      shelfCoverInflight.set(url, request);
      return request;
    },
  },

  series: {
    async getDetail(seriesId: string): Promise<SeriesDetail> {
      const cached = detailCache.get(seriesId);
      if (cached) return cached;
      const inflight = detailInflight.get(seriesId);
      if (inflight) return inflight;
      const request = (async () => {
        if (isTauriEnvironment()) {
          return invokeBackend<SeriesDetail>('series_detail', {
            seriesId,
            channel: channelBySeriesId.get(seriesId),
          });
        }
        await new Promise(resolve => setTimeout(resolve, 100));
        const detail = getSeriesDetail(seriesId);
        if (!detail) throw new Error('未找到该剧集。');
        return detail;
      })()
        .then(detail => {
          detailCache.set(seriesId, detail);
          return detail;
        })
        .finally(() => {
          if (detailInflight.get(seriesId) === request) detailInflight.delete(seriesId);
        });
      detailInflight.set(seriesId, request);
      return request;
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

    async resolveNative(seriesId: string, vid: string, contentType?: number, quality = 'auto'): Promise<{ playUrl: string; width: number; height: number; sizeBytes: number; cached: boolean }> {
      if (!isTauriEnvironment()) throw new Error('原生短剧播放仅在桌面应用中可用。');
      // 打点放在这个唯一出口上，而不是各调用点：红果整集的"首次加载很长时间"
      // 全部发生在这一个 await 里，这里记耗时最省事，也保证 MiniPlayer / 预取
      // 走的是同一条记录口径。
      const started = performance.now();
      void ipcService.diagnostics.uiLog(`resolve 请求开始 vid=${vid} 档位=${quality}`);
      try {
        const result = await invokeBackend<{ playUrl: string; width: number; height: number; sizeBytes: number; cached: boolean }>('short_drama_app_resolve', {
          input: { seriesId, vid, contentType, quality },
        });
        const ms = Math.round(performance.now() - started);
        const mb = ((result?.sizeBytes ?? 0) / 1048576).toFixed(1);
        void ipcService.diagnostics.uiLog(`resolve 返回 耗时=${ms}ms 字节=${mb}MB 缓存=${result?.cached === true}`);
        return result;
      } catch (error) {
        void ipcService.diagnostics.uiLog(`resolve 失败 耗时=${Math.round(performance.now() - started)}ms ${errorText(error, '未知错误')}`);
        throw error;
      }
    },

    /**
     * 「先出画面」入口：红果加密源**边解密边转**本地 H.264 HLS，首片落地即返回。
     *
     * 返回结构的 `streamKind === 'hls'` 是硬信号：`playUrl` 是 `http://127.0.0.1`
     * 上的 m3u8，**必须走 hls.js 挂载**，当作文件路径 convertFileSrc 会得到一个
     * 必然 404 的 asset:// 地址。
     *
     * `sessionId` 必须与本次播放会话号一致——转码任务用它在 `playback_command` 的
     * stop 分支里被停掉（换集/退出播放器时），传别的值会让 ffmpeg 一直空转。
     */
    async openStreamNative(
      seriesId: string,
      vid: string,
      sessionId: number,
      contentType?: number,
    ): Promise<NativeResolved> {
      if (!isTauriEnvironment()) throw new Error('原生短剧播放仅在桌面应用中可用。');
      const started = performance.now();
      void ipcService.diagnostics.uiLog(`流式开播 请求开始 vid=${vid} 会话=${sessionId}`);
      try {
        const result = await invokeBackend<NativeResolved>('short_drama_app_open_stream', {
          input: { seriesId, vid, contentType, quality: 'auto' },
          sessionId,
        });
        const ms = Math.round(performance.now() - started);
        void ipcService.diagnostics.uiLog(
          `流式开播 返回 耗时=${ms}ms 形态=${result?.streamKind ?? 'file'} 缓存=${result?.cached === true}`,
        );
        return result;
      } catch (error) {
        void ipcService.diagnostics.uiLog(
          `流式开播 失败（回退既有链路） 耗时=${Math.round(performance.now() - started)}ms ${errorText(error, '未知错误')}`,
        );
        throw error;
      }
    },

    // 前缀先行开播：与 resolveNative 参数、返回结构完全一致，但产物是
    // `{vid}.prefix.mp4`——只含开头一小段，几秒内就能出画。整集是另一条并发请求，
    // 调用方拿到前缀先播、等整集落盘再切过去，用户不必盯着加载卡等满 6-11 秒。
    // 后端在整集已在盘上时直接返回整集（cached=true），调用方按"这就是最终文件"处理。
    /**
     * **已废弃**：前缀先行开播（`{vid}.prefix.mp4`）的 IPC 出口。
     *
     * 方案 B（2026-10-08）之后前端不再走两段式 —— 整集 HLS 一路播到底，
     * 因此没有任何调用点。保留它是因为 Rust 侧命令仍在注册（`main.rs` 的
     * `invoke_handler`），删掉前端封装会让"命令存在但前端无出口"成为隐性状态；
     * 真要清理应当前后端一起删，那是一次独立的改动。
     */
    async resolveNativePrefix(seriesId: string, vid: string, contentType?: number, quality = 'auto'): Promise<NativeResolved> {
      if (!isTauriEnvironment()) throw new Error('原生短剧播放仅在桌面应用中可用。');
      const started = performance.now();
      void ipcService.diagnostics.uiLog(`前缀 resolve 请求开始 vid=${vid} 档位=${quality}`);
      try {
        const result = await invokeBackend<NativeResolved>('short_drama_app_resolve_prefix', {
          input: { seriesId, vid, contentType, quality },
        });
        const ms = Math.round(performance.now() - started);
        const mb = ((result?.sizeBytes ?? 0) / 1048576).toFixed(1);
        void ipcService.diagnostics.uiLog(`前缀 resolve 返回 耗时=${ms}ms 字节=${mb}MB 缓存=${result?.cached === true}`);
        return result;
      } catch (error) {
        void ipcService.diagnostics.uiLog(`前缀 resolve 失败 耗时=${Math.round(performance.now() - started)}ms ${errorText(error, '未知错误')}`);
        throw error;
      }
    },

    /**
     * **预转下一集的整集 HLS**（用户需求：集与集之间无缝切换）。
     *
     * 后端会把这一集转好放进 `vid-{vid}` 目录，**不占播放会话、不返回地址**，
     * 因此这里 fire-and-forget：失败静默（预转是纯优化，失败时用户走"现场转"那条路）。
     *
     * 为什么值得调用：一集正片 50–140 秒，而整集转码只要 5.6 秒（实测 92.7 秒
     * 正片）。上一集播放期间完全来得及备好下一集 —— 等用户连播到它时，
     * `openStreamNative` 命中已转好的产物，切换**零等待**。
     */
    async prewarmStreamNative(seriesId: string, vid: string, contentType?: number): Promise<void> {
      if (!isTauriEnvironment()) return;
      try {
        await invokeBackend('short_drama_app_prewarm_stream', {
          input: { seriesId, vid, contentType, quality: 'auto' },
        });
      } catch (error) {
        // 静默：预转失败不该影响任何用户可见行为。
        void ipcService.diagnostics.uiLog(`预转未启动（静默） vid=${vid} ${errorText(error, '未知错误')}`);
      }
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

  /**
   * 播放诊断日志（与后端 trace.rs 的环形缓冲 + 落盘日志同一份数据）。
   *
   * 为什么要有这一组：用户反馈「视频首次加载很长时间」「开关 VSR 都没用」这两个
   * 问题都发生在 *用户自己的机器* 上，开发机上复现不了。后端早就把日志写进了
   * `%LOCALAPPDATA%\com.ttv.shortdrama\ttv-playback.log`，但要求用户去翻文件等于
   * 没有诊断——必须让日志在应用里就能看见、能复制、能一键导出。
   *
   * `tail(cursor)` 是**增量**接口：传上次拿到的 nextCursor，只回新增行。轮询时
   * 千万别每次传 0，那样每 1.5 秒会把 2000 行全量搬过 IPC 一次。
   */
  diagnostics: {
    /** 前端打点。写进与后端同一条日志流，方便按时间顺序拼出完整起播链路。 */
    async uiLog(message: string): Promise<void> {
      if (!isTauriEnvironment()) return;
      try {
        await invokeBackend('trace_ui_log', { message });
      } catch {
        // 打点本身绝不能影响播放。
      }
    },

    async tail(cursor = 0): Promise<TraceTail> {
      if (!isTauriEnvironment()) return { lines: [], nextCursor: cursor, dropped: false };
      try {
        const r = await invokeBackend<TraceTail>('trace_tail', { cursor });
        return r ?? { lines: [], nextCursor: cursor, dropped: false };
      } catch {
        return { lines: [], nextCursor: cursor, dropped: false };
      }
    },

    async clear(): Promise<void> {
      if (!isTauriEnvironment()) return;
      try {
        await invokeBackend('trace_clear');
      } catch {
        // 清空失败不阻塞界面。
      }
    },
  },
};
