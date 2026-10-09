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
import { redactUrl, tracePlayback, urlShape } from './playbackTrace';

interface HlsInstance {
  destroy(): void;
  loadSource(url: string): void;
  attachMedia(video: HTMLVideoElement): void;
}

const HLS_KEY = '__ttv_hls__';

/**
 * hls.js 判死时留下的可读标记（错误明细字符串）。
 *
 * 存在的唯一理由：`HTMLMediaElement.error` 是只读的，`dispatchEvent(new Event('error'))`
 * 改不动它，因此调用方无法用 `video.error` 分辨"浏览器真的解码失败"与"hls.js 判死"。
 * 详见下面 ERROR 回调里的长注释。
 */
export const HLS_FATAL_KEY = '__ttvHlsFatal';

/** 读取并清除 hls.js 的判死标记。`null` 表示没有发生过 fatal。 */
export function takeHlsFatal(video: HTMLVideoElement): string | null {
  const record = video as unknown as Record<string, unknown>;
  const value = record[HLS_FATAL_KEY];
  if (typeof value !== 'string') return null;
  delete record[HLS_FATAL_KEY];
  return value;
}

/** 源即将被换掉：清掉上一次的判死标记，避免它污染下一次判死。 */
export function clearHlsFatal(video: HTMLVideoElement): void {
  delete (video as unknown as Record<string, unknown>)[HLS_FATAL_KEY];
}

export function isHlsUrl(url: string): boolean {
  return url.includes('.m3u8') || url.includes('/stream?u=');
}

/**
 * 环境是否**真的**支持原生 HLS 播放。
 *
 * ⚠️ 这条判定曾经是 `!!video.canPlayType('application/vnd.apple.mpegurl')`，而它是错的：
 * Chromium / WebView2 对这个 MIME 返回 **`"maybe"`**（谎报），于是短剧的增强 HLS 与
 * 动漫 HLS 都被判成"原生可播"、直接挂给 `<video src>` —— 而 Chromium 根本没有 HLS
 * 解复用器。实测的后果各不相同但都很难看：动漫那边是"有声音、无画面、黑屏 15 秒"
 * （见 `animePlayback.ts` 文件头第 2 点），短剧流式源这边是**挂上后 4 毫秒就 error**
 * （`ttv-playback.log`：`起播 直挂完成 形态=VSR转码HLS 耗时=1ms` → 紧接 `流式源报错`）。
 *
 * 现在改为"只在**确实没有** MSE 时才考虑原生"：MSE 是 hls.js 的硬前提，有 MSE 就一律
 * 走 hls.js。真正原生支持 HLS 的平台（Safari / iOS WebView）也支持 MSE，但它们走
 * hls.js 会多一层开销——所以**保留**一个明确的"我是 Apple 内核"判定，那种环境才直挂。
 *
 * 判据用 `canPlayType` 的返回值**只认 `"probably"`**（Safari 返回它；Chromium 返回
 * `"maybe"`），并且必须同时不具备 MSE。这样 Chromium 再谎报也骗不过去。
 */
export function nativeHlsSupported(video: HTMLVideoElement): boolean {
  // 有 MSE 就交给 hls.js：这是应用在 WebView2 上的唯一可行通路。
  if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"')) {
    return false;
  }
  // 没有 MSE（老环境 / 极少数嵌入式内核）：只能指望原生，此时只认 "probably"。
  return video.canPlayType('application/vnd.apple.mpegurl') === 'probably';
}

export async function attachSource(video: HTMLVideoElement, url: string): Promise<void> {
  detachSource(video);
  // 打点：这是整条起播链路上最关键的一处「此刻到底把什么交给了 <video>」。
  // 用户报的「一直加载」无法在开发机复现，只能靠这一行分辨当时走的是 VSR 转码
  // HLS、动漫 HLS 还是本地文件——三种形态的等待时间差一个数量级。
  const shape = urlShape(url);
  const started = performance.now();
  tracePlayback(`起播 attachSource 形态=${shape} ${redactUrl(url)}`);
  if (!isHlsUrl(url) || nativeHlsSupported(video)) {
    video.src = url;
    tracePlayback(`起播 直挂完成 形态=${shape} 耗时=${Math.round(performance.now() - started)}ms`);
    return;
  }
  try {
    const { default: Hls } = await import('hls.js');
    if (!Hls.isSupported()) {
      // 环境既不支持原生 HLS 也不支持 MSE：退回直挂（大概率失败，但不阻塞）。
      video.src = url;
      tracePlayback('起播 环境不支持 MSE，退回直挂（大概率失败）');
      return;
    }
    const hls = new Hls({
      // 本地代理分片很小（0.6-2s），默认 30 分片缓冲对动漫分片粒度太保守。
      maxBufferLength: 45,
      maxMaxBufferLength: 90,
      // 本地代理不走网络限速，开最大加载并发让起播更快。
      maxBufferHole: 0.5,
      // 增强转码是"边转边播"：后端可能在首个分片落地前就把 m3u8 地址交回来，
      // 此刻播放列表还不存在。hls.js 默认 `manifestLoadingMaxRetry=1`，约两秒
      // 就判死并派发 fatal → 调用方只能降级回 HEVC 原流。后端此前正是为了躲开
      // 这一点，才在 `media_enhance::start()` 里按住用户最多 15 秒等首段。
      //
      // 补齐重试之后，"等首段"这件事交回给播放器：后端可以立刻返回地址，
      // 首段由这里按 4 次清单重试 + 8 次分片重试等到。数值与动漫专区
      // （`animePlayback.ts`）保持一致，两个播放面不该有两套起播脾气。
      manifestLoadingMaxRetry: 4,
      levelLoadingMaxRetry: 4,
      fragLoadingMaxRetry: 8,
      fragLoadingRetryDelay: 500,
    });
    (video as unknown as Record<string, unknown>)[HLS_KEY] = hls;
    hls.on(Hls.Events.ERROR, (_event, data) => {
      // 打点带 type/details：manifest 拉不到、分片 404、解码失败在这条日志里
      // 是可区分的——[vsr] 转码链路的"卡在加载"多数是清单还没落地时的分片 404。
      tracePlayback(`hls.js 错误 type=${String(data.type)} details=${String(data.details)} fatal=${data.fatal === true}`);
      if (!data.fatal) return;
      // ⚠️ 这里**不能只 dispatchEvent**。
      //
      // `new Event('error')` 能唤醒 `addEventListener('error', ...)` 的监听者，但它
      // **不会设置 `HTMLMediaElement.error`** —— 那是只读的 `MediaError`，只有浏览器
      // 自己的媒体加载算法才会写。于是调用方那层 `if (video.error)` 的判死守卫完全
      // 看不见这次失败，继续走到 `startPlayback`；而在一个没有任何可加载媒体的
      // `<video>` 上 `play()` 既不会 resolve 也不会 reject，只能干等有界看门狗的整拍
      // 超时（`PLAY_PENDING_TIMEOUT_MS = 8000`）。
      //
      // 实测代价：日志里 `hls.js 错误 … manifestParsingError fatal=true` 出现在
      // t=56.921s，而 `流式开播 失败` 出现在 t=64.921s —— 相差**精确 8000ms**，
      // 占那次 15.7 秒首屏的 51%。播放器早就知道失败了，前端又花 8 秒自己确认一遍。
      //
      // 所以除了补发事件，还要显式留下一个**可读的**失败标记，让调用方一眼判死。
      (video as unknown as Record<string, unknown>)[HLS_FATAL_KEY] = String(data.details);
      video.dispatchEvent(new Event('error'));
    });
    hls.attachMedia(video);
    hls.loadSource(url);
    tracePlayback(`起播 hls.js 已挂载 形态=${shape} 耗时=${Math.round(performance.now() - started)}ms`);
  } catch (err) {
    tracePlayback(`起播 hls.js 加载失败，退回直挂：${String(err)}`);
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
  // 换源即作废旧标记：留着会让下一次判死读到上一次的明细。
  clearHlsFatal(video);
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
