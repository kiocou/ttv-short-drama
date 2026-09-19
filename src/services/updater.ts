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
}

export interface DownloadProgress {
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

/** 下载安装包到系统下载目录，返回落地路径。 */
export function downloadUpdate(url: string, fileName: string): Promise<string> {
  return invokeUpdate<string>('update_download', { url, fileName });
}

/** 在资源管理器中定位到已下载的安装包。 */
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

/** 把字节数读成人话（下载体积展示用）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '未知大小';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
