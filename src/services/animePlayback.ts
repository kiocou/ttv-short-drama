/**
 * 动漫专区播放内核。
 *
 * ## 为什么动漫必须有一条自己的播放链路
 *
 * 实测（2026-09，dmghg 正式源）动漫与短剧在三个维度上完全不同，沿用同一条
 * 链路播放必然出问题：
 *
 * 1. **源形态是混的**。同一部剧的不同集回来的是 m3u8（hls）或整段 MP4（file）。
 *    而所有地址都会先经本地代理改写成 `.../stream?u=<base64url>`，于是旧的
 *    `isHlsUrl()`（判 `url.includes('/stream?u=')`）**恒为 true**——整段 MP4 也被
 *    塞给 hls.js，解析播放列表直接失败。真值只有解析出地址的 Rust 侧知道，
 *    所以 `PlaybackSession.streamKind` 显式下发，这里做兜底判定。
 * 2. **WebView2 的 canPlayType 会说谎**。`canPlayType('application/vnd.apple.mpegurl')`
 *    返回 `"maybe"`，旧的 `nativeHlsSupported()` 据此判真，把 m3u8 直接交给
 *    `<video src>`。实测这条原生通路 15 秒后仍 `videoWidth === 0`（只有声音）、
 *    20 秒后才可能出帧；而同一集改由 hls.js 挂 MSE，13 秒稳定出 326 帧。
 *    **"有声音、无画面、黑屏"就是这么来的。**
 * 3. **档位里混着 HEVC**。dmghg 只给中文档位名（`4K 超清` / `1080P 高清`），
 *    不给编码。实测 4K 档恒为 HEVC，1080P 档也可能是（牧神记 181964、无尽神域
 *    181652、食草老龙 181468、虎鹤妖师录 181637）。MSE 的 HEVC 通路能出帧，
 *    但不保证，所以还需要一条"出帧看门狗"：宁可如实降级，也不让用户对着黑屏
 *    把一集听完。
 *
 * ## 与短剧链路的关系
 *
 * 完全独立：短剧/漫剧仍走 `hlsAttach.ts` + `VideoSurface`（那块常驻 `<video>`），
 * 这个模块只服务于动漫专区，改这里不会碰到短剧。
 */

/** 动漫源形态：`hls` = m3u8 播放列表（必须挂 MSE）；`file` = 整段媒体直链。 */
export type AnimeStreamKind = 'hls' | 'file';

/** hls.js / 源类型的挂载标记，挂在 `<video>` 元素上便于诊断与清理。 */
const HLS_KEY = '__ttv_anime_hls__';
const KIND_KEY = '__ttv_anime_kind__';

interface AnimeHlsInstance {
  destroy(): void;
  loadSource(url: string): void;
  attachMedia(video: HTMLVideoElement): void;
  levels?: Array<{ videoCodec?: string; audioCodec?: string; height?: number }>;
}

/** 诊断面板/日志用：把远端地址从本地代理地址里还原出来。 */
export function remoteUrlOf(proxied: string): string | null {
  try {
    const encoded = new URL(proxied).searchParams.get('u');
    if (!encoded) return null;
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padding = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
    return atob(base64 + padding);
  } catch {
    return null;
  }
}

/**
 * 判定源形态。
 *
 * 优先采信后端下发的 `streamKind`；缺失时（旧数据、非动漫源）退回"还原远端
 * 地址后看扩展名"。**绝不采信 `canPlayType`**：WebView2 对 HLS 返回 `"maybe"`，
 * 那是这条链路上最贵的一个谎言（见文件头注释第 2 点）。
 */
export function streamKindOf(url: string, declared?: string | null): AnimeStreamKind {
  if (declared === 'hls' || declared === 'file') return declared;
  const remote = remoteUrlOf(url) ?? url;
  return /\.m3u8?(\?|$)/i.test(remote) ? 'hls' : 'file';
}

/**
 * 动漫专用的 hls.js 配置。
 *
 * 每一项都对应一个实测过的动漫源特性，不是通用调参：
 * - 分片粒度：动漫是 5-8 秒的 TS，比点播常见的 10 秒更碎，默认 30 秒缓冲只够
 *   垫 3-4 个分片，CDN 抖一下就见底；
 * - 分片偶尔被 CDN 掐断（img.nxjunyu.asia 实测间歇性连接重置），默认重试 4 次
 *   后直接判 fatal，会把一整集白白判死；
 * - 转封装必须放 worker：CSP 已放行 `worker-src 'self' blob:`，主线程转封装在
 *   1080p 上会吃掉一整个核，表现为进度条与字幕卡顿。
 */
function animeHlsConfig() {
  return {
    maxBufferLength: 45,
    maxMaxBufferLength: 90,
    maxBufferSize: 60 * 1000 * 1000,
    backBufferLength: 30,
    fragLoadingMaxRetry: 8,
    fragLoadingRetryDelay: 500,
    manifestLoadingMaxRetry: 4,
    levelLoadingMaxRetry: 4,
    enableWorker: true,
    lowLatencyMode: false,
    capLevelToPlayerSize: false,
  };
}

export interface AnimeAttachResult {
  kind: AnimeStreamKind;
  /** m3u8 里声明/探测到的编码（hls.js 解析后才有，可能为空）。 */
  codecs: string[];
}

/** 把动漫源挂到 `<video>` 上：hls 恒走 hls.js，file 才用原生 src。 */
export async function attachAnimeSource(
  video: HTMLVideoElement,
  url: string,
  kind: AnimeStreamKind,
): Promise<AnimeAttachResult> {
  detachAnimeSource(video);
  const record = video as unknown as Record<string, unknown>;
  if (kind === 'file') {
    video.src = url;
    record[KIND_KEY] = 'file';
    return { kind: 'file', codecs: [] };
  }
  try {
    const { default: Hls } = await import('hls.js');
    // 到这里才真正判断 MSE 可用性：`Hls.isSupported()` 看的是 MediaSource，
    // 与那条会说谎的 canPlayType 无关。
    if (!Hls.isSupported()) {
      video.src = url;
      record[KIND_KEY] = 'file';
      return { kind: 'file', codecs: [] };
    }
    const hls = new Hls(animeHlsConfig()) as unknown as AnimeHlsInstance;
    record[HLS_KEY] = hls;
    record[KIND_KEY] = 'hls';
    hls.attachMedia(video);
    hls.loadSource(url);
    return { kind: 'hls', codecs: [] };
  } catch {
    // hls.js chunk 加载失败（安装包缺文件等）：退回原生直挂，至少不白屏。
    video.src = url;
    record[KIND_KEY] = 'file';
    return { kind: 'file', codecs: [] };
  }
}

/**
 * 拆掉动漫的 hls.js 实例，但**不动** `src`。
 *
 * 与短剧的 `releaseAttachedSource` 语义一致：清 `src` 会触发媒体加载算法把
 * 当前帧刷黑。真正要换源时由 `attachAnimeSource` 内部的 `video.src = …` 覆盖。
 */
export function detachAnimeSource(video: HTMLVideoElement): void {
  const record = video as unknown as Record<string, unknown>;
  const existing = record[HLS_KEY] as AnimeHlsInstance | undefined;
  if (existing) {
    try {
      existing.destroy();
    } catch {
      // 销毁失败不影响后续挂载
    }
    delete record[HLS_KEY];
  }
  delete record[KIND_KEY];
}

/** 当前挂在元素上的 hls.js 实例（仅诊断用）。 */
export function animeHlsOf(video: HTMLVideoElement): AnimeHlsInstance | undefined {
  return (video as unknown as Record<string, unknown>)[HLS_KEY] as AnimeHlsInstance | undefined;
}

export interface FrameWatchdogInfo {
  /** 判定失败时音频是否在推进（推进 = 用户此刻正"听着黑屏"）。 */
  audioAdvanced: boolean;
  videoWidth: number;
  frameCount: number;
  /** 已解码出帧的总数；-1 表示宿主不支持该指标。 */
  unsupportedMetric: boolean;
}

export interface FrameWatchdogOptions {
  /** 多久没出帧就判定"视频轨没解出来"（默认 9 秒）。 */
  stallMs?: number;
  onStalled?: (info: FrameWatchdogInfo) => void;
  onHealthy?: () => void;
  /** 帧数不增长但已出过帧时的回调（解码卡死，与"从未出帧"不同）。 */
  onStallAfterStart?: (info: FrameWatchdogInfo) => void;
}

/**
 * 出帧看门狗：区分"在播"和"只有声音在播"。
 *
 * 为什么不能只看 `readyState`：HEVC 解不出视频轨时，媒体元素依然会把
 * `readyState` 推到 4、`currentTime` 正常前进（音频轨是好的），只有
 * `videoWidth` 与 `totalVideoFrames` 停在 0。这两个指标才是"画面到底出没出"。
 *
 * 返回停止函数，调用方在换集/退出播放器时必须执行。
 */
export function startAnimeFrameWatchdog(
  video: HTMLVideoElement,
  options: FrameWatchdogOptions = {},
): () => void {
  const stallMs = options.stallMs ?? 9000;
  const startedAt = performance.now();
  const startedClock = video.currentTime;
  let lastFrames = -1;
  let sawFrames = false;
  let settled = false;
  let timer: number | null = null;

  const read = (): FrameWatchdogInfo => {
    const quality = video.getVideoPlaybackQuality?.();
    const frameCount = quality ? quality.totalVideoFrames : -1;
    return {
      audioAdvanced: video.currentTime > startedClock + 0.4,
      videoWidth: video.videoWidth,
      frameCount,
      unsupportedMetric: frameCount < 0,
    };
  };

  const stop = () => {
    settled = true;
    if (timer !== null) window.clearInterval(timer);
    timer = null;
  };

  const tick = () => {
    if (settled) return;
    const info = read();
    if (info.unsupportedMetric) {
      // 宿主不给帧指标时退回"分辨率是否就绪"这个弱判据，并且只在超时后判一次。
      if (performance.now() - startedAt >= stallMs) {
        stop();
        if (info.videoWidth > 0) options.onHealthy?.();
        else options.onStalled?.(info);
      }
      return;
    }
    if (info.frameCount > 0) {
      if (!sawFrames) {
        sawFrames = true;
        lastFrames = info.frameCount;
        options.onHealthy?.();
        return;
      }
      if (info.frameCount > lastFrames) {
        lastFrames = info.frameCount;
        return;
      }
      // 出过帧却长时间不再增长：解码线程卡死。给足一个分片的余量再判。
      if (info.audioAdvanced && performance.now() - startedAt >= stallMs * 2.5) {
        stop();
        options.onStallAfterStart?.(info);
      }
      return;
    }
    if (performance.now() - startedAt >= stallMs) {
      stop();
      options.onStalled?.(info);
    }
  };

  timer = window.setInterval(tick, 700);
  return stop;
}
