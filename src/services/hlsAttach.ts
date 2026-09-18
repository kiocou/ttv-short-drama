/**
 * m3u8 源挂载工具。
 *
 * WebView2（Chromium）原生不支持 HLS。动漫专区走本地 HLS 代理（Rust hls_proxy
 * 已把 m3u8 重写为本地分片流），但 video.src 直接指 m3u8 在 Chromium 上仍然不
 * 行——必须由 hls.js 在 MSE 上解包。这个工具负责：
 *   1. 原生支持（Safari/部分 WebView）→ 直接 src；
 *   2. 否则动态 import hls.js 挂到 video 元素上。
 *
 * 调用方只管 `attachSource(video, url)`。
 *
 * 清理有两个入口，别混用：
 *   - `detachSource(video)`   —— 连 `src` 一起清（准备换源时用）；
 *   - `releaseAttachedSource(video)` —— **只**拆 hls.js 实例，不动 `src`。
 *     离开动漫专区时必须用这个：应用只有一块常驻 `<video>`（VideoSurface），
 *     动漫挂上的 hls.js 会接管这块元素；不清掉的话，短剧/漫剧再往上面写
 *     `src` 仍被 MSE 接管，表现就是"播过动漫之后别的都播不了"。
 *     不动 `src` 是为了保住旧帧（清 `src` 会触发媒体加载算法、画面转黑）。
 */
interface HlsInstance {
  destroy(): void;
  loadSource(url: string): void;
  attachMedia(video: HTMLVideoElement): void;
}

const HLS_KEY = '__ttv_hls__';

export function isHlsUrl(url: string): boolean {
  return url.includes('.m3u8') || url.includes('/stream?u=');
}

export function nativeHlsSupported(video: HTMLVideoElement): boolean {
  return !!video.canPlayType('application/vnd.apple.mpegurl');
}

export async function attachSource(video: HTMLVideoElement, url: string): Promise<void> {
  detachSource(video);
  if (!isHlsUrl(url) || nativeHlsSupported(video)) {
    video.src = url;
    return;
  }
  try {
    const { default: Hls } = await import('hls.js');
    if (!Hls.isSupported()) {
      // 环境既不支持原生 HLS 也不支持 MSE：退回直挂（大概率失败，但不阻塞）。
      video.src = url;
      return;
    }
    const hls = new Hls({
      // 本地代理分片很小（0.6-2s），默认 30 分片缓冲对动漫分片粒度太保守。
      maxBufferLength: 45,
      maxMaxBufferLength: 90,
      // 本地代理不走网络限速，开最大加载并发让起播更快。
      maxBufferHole: 0.5,
    });
    (video as unknown as Record<string, unknown>)[HLS_KEY] = hls;
    hls.attachMedia(video);
    hls.loadSource(url);
  } catch {
    video.src = url;
  }
}

export function detachSource(video: HTMLVideoElement): void {
  const existing = (video as unknown as Record<string, unknown>)[HLS_KEY] as HlsInstance | undefined;
  if (existing) {
    try {
      existing.destroy();
    } catch {
      // 销毁失败不影响主流程
    }
    delete (video as unknown as Record<string, unknown>)[HLS_KEY];
  }
  video.removeAttribute('src');
}

/**
 * 只拆 hls.js 实例，**不动** `video.src`。
 *
 * 用于离开动漫专区：必须解除 MSE 对这块共享 `<video>` 的接管，
 * 但又不能清 `src`（清了会触发媒体加载算法、把旧帧清成黑屏）。
 * 元素上本来就没有实例时是空操作。
 */
export function releaseAttachedSource(video: HTMLVideoElement): void {
  const existing = (video as unknown as Record<string, unknown>)[HLS_KEY] as HlsInstance | undefined;
  if (!existing) return;
  try {
    existing.destroy();
  } catch {
    // 销毁失败不影响主流程
  }
  delete (video as unknown as Record<string, unknown>)[HLS_KEY];
}
