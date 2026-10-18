import { isTauriEnvironment } from './ipc';

/**
 * 「检查更新」的前端入口。
 *
 * 网络请求全部由 Rust 侧发出（见 `src-tauri/src/update.rs` 的文件头）：
 * 页面只调 IPC、只订阅进度事件，因此既不碰 CSP，也不把 GitHub 域名暴露给前端。
 */

/** 下载进度事件名，与 `src-tauri/src/update.rs` 的 `EVENT_DOWNLOAD` 必须一致。 */
export const UPDATE_DOWNLOAD_EVENT = 'update://download';

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  /** Release 正文（Markdown 原文）。 */
  notes: string;
  publishedAt: string;
  htmlUrl: string;
  assetName: string | null;
  assetUrl: string | null;
  assetSize: number;
  /**
   * 官方发布的 SHA-256（纯十六进制，无 `sha256:` 前缀）。
   *
   * 下载会走国内镜像加速，而镜像是第三方——**必须**用这个值校验下载结果，
   * 否则等于把安装包的安全托付给镜像运营方。为空时后端退回弱校验（HTTPS + 体积）。
   */
  assetDigest: string | null;
}

export interface DownloadProgress {
  /**
   * 本次下载的任务号。
   *
   * 后端用 `app.emit` **广播**进度，而本应用有两处会发起下载（标题栏的更新弹窗、
   * 设置页的「检查更新」），且两处都常驻 DOM —— 不区分任务号的话，一边下载会让
   * 另一边也收到 `done` 并弹出自己的 toast，两边的进度条还会互相覆盖。
   * 前端只处理 `jobId` 与自己那次调用一致的事件。
   */
  jobId: string;
  received: number;
  total: number;
  percent: number;
  done: boolean;
  error: string | null;
  path: string | null;
}

async function invokeUpdate<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriEnvironment()) throw new Error('检查更新仅在桌面应用中可用。');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

/** 查询最新 Release。失败时抛出的是可直接展示给用户的中文原因。 */
export function checkForUpdate(): Promise<UpdateInfo> {
  return invokeUpdate<UpdateInfo>('update_check');
}

/** 网络走向：`direct` = GitHub 直连可用（默认方案），`mainland` = 走国内加速。 */
export type NetworkRoute = 'direct' | 'mainland';

/** 下载前的网络预检结论。 */
export interface NetworkProbe {
  route: NetworkRoute;
  /** 直连是否连得上。 */
  directReachable: boolean;
  /** 直连实测速率（字节/秒），0 表示没测出来。 */
  directSpeed: number;
  /** 一句话结论，可直接展示给用户。 */
  reason: string;
}

/**
 * 探测当前网络该走哪套下载方案。
 *
 * 用户点「立即下载」时先调它：GitHub 能正常访问就走默认方案（直连），
 * 否则切国内加速通道。后端在真正下载时会再判一次，所以即使这一步失败也不影响下载。
 */
export function probeUpdateNetwork(url: string): Promise<NetworkProbe> {
  return invokeUpdate<NetworkProbe>('update_probe_network', { url });
}

/**
 * 下载安装包到系统下载目录，返回落地路径。
 *
 * `jobId` 会原样回填到每一条进度事件里，调用方据此从广播事件中挑出自己的那些。
 * 不传时后端补空串（进度事件仍然会发，只是无法区分来源）。
 *
 * `digest` 是 GitHub API 给的 SHA-256：下载会走镜像加速，下完必须用它校验。
 * 不传则跳过校验（仅在拿不到 digest 时才会发生）。
 */
export function downloadUpdate(
  url: string,
  fileName: string,
  jobId?: string,
  digest?: string | null,
): Promise<string> {
  return invokeUpdate<string>('update_download', { url, fileName, jobId, digest });
}

/**
 * 取消正在进行的下载；已经结束时调用无副作用。
 *
 * 传 `jobId` 只取消那一次下载——本应用有两处能发起下载（标题栏弹窗、设置页），
 * 不区分的话在一边取消会把另一边也停掉。不传时取消全部（旧语义）。
 */
export function cancelUpdateDownload(jobId?: string): Promise<void> {
  return invokeUpdate<void>('update_cancel_download', { jobId });
}

/**
 * 打开已下载安装包的安装向导，然后退出应用。
 *
 * 调用即意味着应用即将退出：安装器要覆盖本进程的 exe 与随包资源。失败时抛错，
 * 调用方应回落到 `revealUpdate`，而不是吞掉——启动失败对用户不可见。
 */
export function installUpdate(path: string): Promise<void> {
  return invokeUpdate<void>('update_install', { path });
}

/** 在资源管理器中定位到已下载的安装包（静默安装失败时的退路）。 */
export function revealUpdate(path: string): Promise<void> {
  return invokeUpdate<void>('update_reveal', { path });
}

/** 订阅下载进度；非 Tauri 环境返回空操作，调用方不必到处写环境判断。 */
export async function listenDownloadProgress(
  handler: (progress: DownloadProgress) => void,
): Promise<() => void> {
  if (!isTauriEnvironment()) return () => {};
  try {
    const { listen } = await import('@tauri-apps/api/event');
    return await listen<DownloadProgress>(UPDATE_DOWNLOAD_EVENT, message => handler(message.payload));
  } catch {
    return () => {};
  }
}

/**
 * 生成一次下载的任务号。
 *
 * 不用 `crypto.randomUUID()`：老 WebView2 上不一定有，而这里只需要"同一次会话里
 * 两次下载不会撞号"，时间戳 + 随机后缀足够。
 */
export function createDownloadJobId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 把字节数读成人话（下载体积展示用）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '未知大小';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
