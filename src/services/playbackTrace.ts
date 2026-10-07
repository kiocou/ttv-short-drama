/**
 * 播放链路轻量打点。
 *
 * 为什么单独开一个模块、而不是直接用 `ipcService.diagnostics.uiLog`：
 *   * `hlsAttach.ts` 是播放内核的最底层工具，刻意不依赖 ipc 层（它连 hls.js 都是
 *     动态 import 的，就是为了不把 595KB 的 hls 拉进主 chunk）。让它静态依赖
 *     ipcService，等于把 ipc 的依赖图拖进每个引用它的模块。
 *   * 这里 fire-and-forget、零 await、零返回值：打点失败绝不允许影响播放，
 *     调用方也不必关心结果。
 *
 * 与后端 `trace.rs` 写入的是同一条日志流（`[ui]` 前缀），因此设置页面板里能看到
 * 前端与后端按时间顺序交错的完整链路。
 */

function inTauri(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

export function tracePlayback(message: string): void {
  if (!inTauri()) return;
  void (async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('trace_ui_log', { message });
    } catch {
      // 打点是旁路，失败静默。
    }
  })();
}

/**
 * URL 脱敏：日志会被用户导出并发出来，**只能留到 host + 路径前段**。
 *
 * 红果的分集直链带签名参数（`?lk3s=…&x-expires=…&x-signature=…`），完整写进日志
 * 等于把可用的临时播放凭证写进一个会被外发的文本文件。后端 trace.rs 只对它自己
 * 写的行做脱敏，前端打点走的是同一条缓冲区，所以脱敏必须在这里做。
 */
export function redactUrl(url: string): string {
  if (!url) return '(空)';
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.length > 60 ? `${parsed.pathname.slice(0, 60)}~` : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    // asset:// / 本地路径等非标准 URL：只留长度与尾段，足够定位链路形态。
    return `(非标准URL ${url.length}字符 尾:${url.slice(-12)})`;
  }
}

/**
 * 链路形态标签：回答「这一集走的到底是哪条路」，必须只有一处定义。
 *
 * 判据与后端 trace.rs 的 redact_url / media_enhance 的本地服务前缀保持一致：
 * /rtx/ 是 VSR 转码本地 HLS 的唯一标记。
 */
export function urlShape(url: string): string {
  if (!url) return '空';
  if (url.startsWith('http://asset.localhost') || url.startsWith('asset:')) return '本地文件';
  if (url.includes('127.0.0.1') && url.includes('/rtx/')) return 'VSR转码HLS';
  if (url.includes('.m3u8') || url.includes('/stream?u=')) return 'HLS';
  if (url.startsWith('http://') || url.startsWith('https://')) return '网络直链';
  return '其他';
}