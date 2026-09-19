import { isTauriEnvironment } from './ipc';

/**
 * 画中画小窗的交接协议（前端侧唯一入口）。
 *
 * ## 形态
 *
 * 小窗是一个**独立的 Tauri 窗口**（label: `mini`，无边框 + 置顶 + 不进任务栏），
 * window-wide 的职责划分见 `src-tauri/src/pip.rs` 的文件头注释。这里只负责前端
 * 侧的三件事：识别"我现在在哪个窗口"、把播放权交出去、接回来。
 *
 * ## 为什么用"交接包"而不是共享 store
 *
 * 两个窗口是两个独立的 WebView，各自有独立的 JS 内存：主窗口的 React store 在
 * 小窗里不存在，全局单例也各是一份。所以唯一的通道是 IPC——主窗口把"身份 + 播放
 * 参数"打包下发给 Rust，小窗启动后自己取走（`pip_handoff`），关闭时再把最终进度
 * 回传（`pip://returned`）。
 *
 * ## 传输的是"哪一集"，不是"播放地址"
 *
 * 小窗拿到 seriesId / episodeId 后**自己解析**播放地址：主窗口的 `video.src` 在
 * 动漫链路下是 MSE 的 `blob:`（跨窗口不可用），短剧链路的本地文件地址也无法可靠
 * 地跨 store 取出。让每个窗口只对自己那条媒体链路负责，才不会出现"主窗口换了源
 * 小窗还挂着旧地址"这类幽灵状态。
 */

/** 小窗的窗口标签，与 `src-tauri/src/pip.rs` 的 `WINDOW_LABEL` 必须一致。 */
export const PIP_WINDOW_LABEL = 'mini';

/** 主窗口 → 小窗：复用已存在的小窗时下发新的交接包。 */
export const PIP_HANDOFF_EVENT = 'pip://handoff';
/** 小窗 → 主窗口：小窗已关闭，附带最终进度。 */
export const PIP_RETURNED_EVENT = 'pip://returned';

/** 小窗用哪条解析链路：短剧/漫剧，或动漫专区。 */
export type PipKind = 'drama' | 'anime';

/** 小窗选集用的一集。 */
export interface PipEpisodeRef {
  id: string;
  episodeNumber: number;
  title: string;
}

/** 主窗口交给小窗的接力包。 */
export interface PipHandoff {
  kind: PipKind;
  seriesId: string;
  /** 交接时正在播的那一集。 */
  episodeId: string;
  title: string;
  cover: string;
  /** 落历史用：`drama` / `comic` / `anime`。 */
  channel: 'drama' | 'comic' | 'anime';
  totalEpisodes: number;
  /** 交接时那一集的集号：集列表缺失时小窗至少还能显示"第 N 集"。 */
  episodeNumber: number;
  quality: string;
  position: number;
  volume: number;
  muted: boolean;
  rate: number;
  /** 短剧 worker 的内容类型（1 短剧 / 1004 漫剧）；动漫链路为空。 */
  contentType?: number | null;
  autoNext: boolean;
  countdownSeconds: number;
  episodes: PipEpisodeRef[];
}

/** 小窗回报的实时进度。 */
export interface PipProgress {
  position: number;
  duration: number;
  volume: number;
  muted: boolean;
  rate: number;
  /** 小窗可能已连播到下一集：这里记的是"此刻真正在播的那一集"。 */
  episodeId?: string | null;
}

/** 小窗关闭时回传的负载。 */
export interface PipReturnedPayload {
  /** `return` 回到播放器 / `close` 只关闭 / `system` 被系统销毁。 */
  mode: 'return' | 'close' | 'system';
  handoff: PipHandoff | null;
  progress: PipProgress;
}

/**
 * 当前窗口标签，读的是 Tauri 注入的元数据（同步、无 IPC）。
 *
 * 不能用 `getCurrentWindow()` 之外的花招：窗口标签是"我该渲染哪个入口"的唯一
 * 依据，而 `WebviewUrl::App("index.html")` 对小窗与主窗口是同一个地址——没有
 * 查询参数可以依赖，也不该依赖（生产环境走 asset 协议，参数处理更易出岔子）。
 */
export function currentWindowLabel(): string | null {
  if (typeof window === 'undefined') return null;
  const internals = (window as unknown as {
    __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } };
  }).__TAURI_INTERNALS__;
  return internals?.metadata?.currentWindow?.label ?? null;
}

/** 当前是否运行在画中画小窗里。 */
export function isPipWindow(): boolean {
  return currentWindowLabel() === PIP_WINDOW_LABEL;
}

async function invokePip<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriEnvironment()) throw new Error('画中画仅在桌面应用中可用。');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

/**
 * 把播放权交给小窗（主窗口调用）。
 *
 * 调用方必须紧接着停掉自己的播放：主窗口的 `video` 元素不会因为小窗打开就自动
 * 暂停，两路同时出声是这块功能最容易踩的坑。
 */
export async function openPip(handoff: PipHandoff): Promise<void> {
  await invokePip('pip_open', { handoff });
}

/** 小窗启动时取走接力包。 */
export async function readPipHandoff(): Promise<PipHandoff | null> {
  try {
    return await invokePip<PipHandoff | null>('pip_handoff');
  } catch {
    return null;
  }
}

/** 小窗上报进度（失败静默：上报只是为了让关闭时能接得上，不该打断播放）。 */
export function reportPipProgress(progress: PipProgress): void {
  if (!isTauriEnvironment()) return;
  void invokePip('pip_report', { progress }).catch(() => {});
}

/** 小窗请求关闭自己；`mode = 'return'` 表示主窗口要接着播。 */
export async function closePip(mode: 'return' | 'close', progress: PipProgress): Promise<void> {
  await invokePip('pip_close', { mode, progress });
}

/**
 * 主窗口请求收掉小窗（不等待）。
 *
 * 用途是"播放权唯一"：主窗口一旦要自己起播，小窗必须立刻让位。因此这里刻意
 * fire-and-forget——起播链路不该被一次窗口销毁阻塞。
 */
export function dismissPip(): void {
  if (!isTauriEnvironment()) return;
  void invokePip('pip_dismiss').catch(() => {});
}

/** 小窗当前是否开着。 */
export async function pipIsOpen(): Promise<boolean> {
  try {
    return await invokePip<boolean>('pip_is_open');
  } catch {
    return false;
  }
}

/**
 * 订阅画中画相关事件。
 *
 * 返回 unlisten；非 Tauri 环境返回空操作，调用方不必到处写环境判断。
 */
export async function listenPip<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (!isTauriEnvironment()) return () => {};
  try {
    const { listen } = await import('@tauri-apps/api/event');
    return await listen<T>(event, (message) => handler(message.payload));
  } catch {
    return () => {};
  }
}
