import React, { createContext, useContext, useState, useRef, useEffect, useCallback, ReactNode } from 'react';
import { PlaybackUiState } from '../types/playback';
import { SeriesDetail, EpisodeItem } from '../types/series';
import { ipcService, isTauriEnvironment } from '../services/ipc';
import { useSettingsStore } from './useSettingsStore';

/**
 * 整集缓存的统一 key。
 *
 * 关键决策：**不再把清晰度拼进 key**。源流实际只有有限档位（红果短剧实测仅
 * 540p / 1080p 两档），而前端菜单曾硬编码 4K/1080P/720P 三档，结果同一集被
 * 按三个名字反复下载，产物还完全重复（4k 与 auto 字节数一模一样）。
 * 现在后端已把清晰度归一到 auto 单一路径，key 也必须跟着去掉清晰度维度，
 * 否则前端缓存永远 miss、每次都重下。
 */
function episodeCacheKey(seriesId: string, episodeId: string): string {
  return `${seriesId}:${episodeId}`;
}

/**
 * 把新视频源"预载"到就绪，但不接管当前画面。
 *
 * 这是无缝切换的核心：先用一个隐藏的 <video> 把新集解到 canplay，
 * 旧画面继续播放/停留，等新源真就绪了再换 src。这样换集不再是
 * "先黑屏 → 再加载 → 才出画"，而是"旧帧停留 → 直接出画"。
 *
 * 复用已解析成功的本地路径也在这里完成——只有拿到可播放地址才建预载器。
 */
interface PreparedSource {
  url: string;
  /** 预热用的隐藏 video 元素（已解到可播状态）。 */
  element: HTMLVideoElement;
}

export function disposePrepared(prepared: PreparedSource | null): void {
  if (!prepared) return;
  try {
    prepared.element.pause();
    prepared.element.removeAttribute('src');
    prepared.element.load();
  } catch {
    // 释放失败不影响主流程
  }
}

interface CountdownState {
  active: boolean;
  remaining: number;
  nextEpisode: EpisodeItem | null;
}

interface PlaybackContextType {
  sessionId: number;
  currentSeries: SeriesDetail | null;
  currentEpisode: EpisodeItem | null;
  uiState: PlaybackUiState;
  isPlaying: boolean;
  position: number;
  duration: number;
  buffered: number;
  volume: number;
  isMuted: boolean;
  playbackRate: number;
  currentQuality: string;
  availableQualities: Array<{ label: string; value: string; resolution: string }>;
  isSideDrawerOpen: boolean;
  countdown: CountdownState;
  isDiagnosticsOpen: boolean;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  openEpisode: (seriesId: string, episodeId?: string, startPosition?: number, qualityOverride?: string) => Promise<void>;
  togglePlay: () => void;
  seek: (seconds: number) => void;
  seekRelative: (deltaSeconds: number) => void;
  setVolume: (vol: number) => void;
  toggleMute: () => void;
  setPlaybackRate: (rate: number) => void;
  setQuality: (quality: string) => void;
  playNextEpisode: () => void;
  playPrevEpisode: () => void;
  toggleSideDrawer: (open?: boolean) => void;
  toggleDiagnostics: (open?: boolean) => void;
  cancelCountdown: () => void;
  acceptCountdown: () => void;
  /** 离开播放器工作区时调用：暂停画面、取消后台连播并落盘进度。 */
  stopPlayback: () => void;
  /**
   * 是否正在"切换"到另一部剧/另一集（而非首次进入播放器）。
   *
   * 用于区分等待提示的呈现方式：
   * - 首次进入：全屏加载遮罩（画面本来就是空的）；
   * - 切换：明确的"预计 N 秒"提示——用户已经等过一次，需要知道要等多久。
   * 后台预取不进入这个状态，因此对用户完全静默。
   */
  isSwitching: boolean;
  /** 云端解析进度。null 表示当前没有在途解析。 */
  prepareStatus: PrepareStatus | null;
  /** 最近一次失败的具体原因（用于错误卡片与用户反馈定位）。 */
  errorDetail: string | null;
  /** 提前预热某一集（详情页 / 选集抽屉），已在缓存或已在途则跳过。 */
  prewarmEpisode: (seriesId: string, episodeId: string, contentType?: number) => void;
}

/** 原生解析 worker 上报的进度（Rust 转发的 `shortdrama://app-resolve` 事件）。 */
export interface PrepareStatus {
  /** 正在解析的集 vid。 */
  episodeId: string;
  /** start / sign / model / fallback / download / transcode。 */
  stage: string;
  message: string;
  /** 下载阶段才有真实百分比，其余阶段为 null。 */
  percent: number | null;
  /**
   * 预计还需多少秒才能开始播放（下载阶段才有）。
   *
   * 等待过程必须可量化：实测单集解析约 7.4 秒（其中签名与 API 往返占 3.6 秒、
   * 下载与解密占 3.9 秒），只给一个转圈动画会让用户以为卡死。
   */
  etaSeconds: number | null;
}

/** 悬停预热的最大并发数：超过它就不再受理新的预热请求。 */
const MAX_PREWARM_INFLIGHT = 2;

/**
 * 把各种来源的错误压成一行可读文本。
 *
 * 媒体链路上的错误有三类形态：`MediaError`（有 code/message，但 `String()`
 * 出来是 `[object MediaError]`）、`DOMException`（有 name/message）、
 * 以及后端直接返回的中文字符串。不统一处理的话，错误卡片上只会留下
 * "undefined"，失去了诊断价值。
 */
function describeError(error: unknown): string {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  const candidate = error as { name?: string; message?: string; code?: number };
  if (candidate.code != null && candidate.message) return `MediaError ${candidate.code}: ${candidate.message}`;
  if (candidate.name && candidate.message) return `${candidate.name}: ${candidate.message}`;
  return String(error);
}

/**
 * `startPlayback` 的结果分类。三种失败的处理方式不同，不能压成一个 false。
 */
type PlayStartResult = 'ok' | 'autoplay-blocked' | 'error';

/**
 * 一次"打开并播放"的最终结局。
 *
 * `stale` 单独列出很关键：它表示这次切换已被**更新的切换**接管，既不是成功
 * 也不是失败。上层必须原样放过——继续降级或弹错误页都会毁掉新会话刚建立的状态。
 */
type PlayOutcome = PlayStartResult | 'stale';

/**
 * 结局是否算"成功或已交棒"——供只需要判成败的调用点使用。
 *
 * 不能简单写成 `outcome === 'ok'`：`stale` 表示这次切换已被更新的切换接管，
 * 新会话自会善后，这里继续报错会毁掉它刚建立的状态。
 */
function isSettled(outcome: PlayOutcome): boolean {
  return outcome === 'ok' || outcome === 'stale';
}

/** 把结局翻译成错误码：自动播放被拦要如实报，不能混进"播放源连接受阻"。 */
function outcomeErrorCode(outcome: PlayOutcome, fallback = 'MEDIA_LOAD_FAILED'): string {
  return outcome === 'autoplay-blocked' ? 'MEDIA_AUTOPLAY_FAILED' : fallback;
}

const PlaybackContext = createContext<PlaybackContextType | null>(null);

export const PlaybackProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  // 接通用户设置：默认清晰度、自动连播、倒计时秒数此前全是死代码——
  // SettingsView 能改、能存盘，但播放器从不读取，等于摆设。
  const { settings } = useSettingsStore();
  const [sessionId, setSessionId] = useState<number>(100);
  const [currentSeries, setCurrentSeries] = useState<SeriesDetail | null>(null);
  const [currentEpisode, setCurrentEpisode] = useState<EpisodeItem | null>(null);
  const [uiState, setUiState] = useState<PlaybackUiState>({ kind: 'idle' });
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [position, setPosition] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [buffered, setBuffered] = useState<number>(0);
  const [volume, setVolumeState] = useState<number>(0.85);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [playbackRate, setPlaybackRateState] = useState<number>(1.0);
  // 真实清晰度档位：来自后端 variants，不再硬编码。空数组表示尚未探测，
  // 此时只显示"自动"，绝不虚构 4K/1080P 这类源里根本不存在的档位。
  const [availableQualities, setAvailableQualities] = useState<Array<{ label: string; value: string; resolution: string }>>([]);
  const [currentQuality, setCurrentQuality] = useState<string>('auto');
  const [isSideDrawerOpen, setIsSideDrawerOpen] = useState<boolean>(false);
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState<boolean>(false);
  const [countdown, setCountdown] = useState<CountdownState>({
    active: false,
    remaining: 5,
    nextEpisode: null,
  });
  const [prepareStatus, setPrepareStatus] = useState<PrepareStatus | null>(null);
  const [isSwitching, setIsSwitching] = useState<boolean>(false);
  // 悬停预热的在途计数，见 prewarmEpisode 的并发上限说明。
  const prewarmInflightRef = useRef<number>(0);
  // 下载速率采样：worker 每 10% 上报一次百分比，用相邻两点算出速率再推算剩余时间。
  const downloadSampleRef = useRef<{ percent: number; at: number } | null>(null);
  /**
   * 最近一次失败的具体原因。
   *
   * 换集失败此前只有一句"播放源连接受阻"，无法区分是整集解析被服务端拒绝、
   * 解码失败，还是 play() 被另一次切换打断——而这三种的修法完全不同。
   * 错误卡片会把它显示出来，用户截图即可定位。
   */
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const noteFailure = (stage: string, error: unknown) => {
    const line = `${stage} — ${describeError(error)}`;
    console.warn('[playback]', line);
    setErrorDetail(line);
  };

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeSessionRef = useRef<number>(100);
  const backupUrlRef = useRef<string>('');
  const hasTriedBackupRef = useRef<boolean>(false);
  const hasTriedBlobRef = useRef<boolean>(false);
  const hasTriedNativeResolveRef = useRef<boolean>(false);
  const objectUrlRef = useRef<string>('');
  // 在途的本地解析 promise。play() 拒绝与 video error 事件可能先后触发同一次
  // 恢复流程，记录在途任务让后到的分支等待同一结果，而不是重复起 worker 或提前报错。
  const nativeResolveInFlightRef = useRef<Promise<PlayOutcome> | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 供"只绑定一次"的事件监听器间接调用的稳定引用。
  const playNextEpisodeRef = useRef<() => void>(() => {});
  const saveProgressThrottledRef = useRef<(pos: number, dur: number, force?: boolean) => void>(() => {});

  // 播放一旦真正开始，"切换中"就结束。
  // 用 effect 统一收口，而不是在 9 处 setIsPlaying(true) 旁边各写一行——
  // 那些分支分别对应快路径、本地解析、公开直链兜底、自动连播等，漏掉任何一处
  // 都会让"预计 N 秒"的提示永久停在屏幕上。
  useEffect(() => {
    if (uiState.kind === 'playing' || uiState.kind === 'error') {
      setIsSwitching(false);
    }
  }, [uiState.kind]);

  // ============ 解析进度订阅 ============

  /**
   * 订阅原生解析进度。
   *
   * worker 每推进 10% 就会输出一行 download 进度，Rust 侧已经原样转发到
   * `shortdrama://app-resolve`——但此前**前端没有任何监听者**，于是换集时用户
   * 只能面对一个不透明的转圈，无法区分"正在签名""正在下载 40%"还是卡死了。
   * 这里把阶段与百分比接出来，等待过程因此变得可解释。
   */
  useEffect(() => {
    if (!isTauriEnvironment()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<{ vid?: string; stage?: string; message?: string; percent?: number | null }>(
          'shortdrama://app-resolve',
          event => {
            const payload = event.payload || {};
            const stage = String(payload.stage ?? '');
            if (stage === 'done' || stage === 'error') {
              downloadSampleRef.current = null;
              setPrepareStatus(null);
              return;
            }
            const percent = typeof payload.percent === 'number' ? payload.percent : null;

            // 用相邻两次百分比采样估算剩余时间。
            // worker 每 10% 上报一次，两点之间足以得到一个稳定的速率；
            // 首次采样（或换了新的下载任务）时无法估算，先给 null。
            let etaSeconds: number | null = null;
            if (percent != null) {
              const now = Date.now();
              const prev = downloadSampleRef.current;
              if (prev && percent > prev.percent && now > prev.at) {
                const perMs = (percent - prev.percent) / (now - prev.at);
                if (perMs > 0) {
                  etaSeconds = Math.max(1, Math.round((100 - percent) / perMs / 1000));
                }
                downloadSampleRef.current = { percent, at: now };
              } else if (!prev || percent < prev.percent) {
                // 新任务开始（百分比回退），重新起算。
                downloadSampleRef.current = { percent, at: now };
              }
            } else {
              downloadSampleRef.current = null;
            }

            setPrepareStatus({
              episodeId: String(payload.vid ?? ''),
              stage,
              message: typeof payload.message === 'string' ? payload.message : '',
              percent,
              etaSeconds,
            });
          },
        ),
      )
      .then(off => {
        if (disposed) {
          off();
          return;
        }
        unlisten = off;
      })
      .catch(() => {
        // 事件通道不可用时不影响播放主流程。
      });
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  // ============ 无缝切换基础设施 ============

  /**
   * 把候选源解到「可播」状态，但不接触主播放器。返回 null 表示这源不可用。
   *
   * 用提前量换掉黑屏：新集先在后台完成元数据与首批数据缓冲
   * （readyState >= HAVE_FUTURE_DATA，即 canplay），旧画面一直留着，
   * 等就绪再真正换 src，用户看不到中间态。
   *
   * 说明：预载用独立的隐藏 <video> 预热，浏览器对同一 URL 会复用已建立的
   * 连接与缓存，主播放器接管时不必再从零握手，因此这里的"预热"是真实收益
   * 而非纯检查。setup 中把音量/静音提前对齐，避免接管后二次调音造成跳变。
   */
  const preloadSource = async (
    assetUrl: string,
    startPosition: number,
    timeoutMs = 12000,
  ): Promise<HTMLVideoElement | null> => {
    const probe = document.createElement('video');
    probe.preload = 'auto';
    probe.muted = true;
    probe.playsInline = true;
    // 不设 crossOrigin：这块只负责把新源"解到可播"，从不读取像素。
    // 设了反而让 WebView 对本地 asset 也走一次 CORS 校验——只有失败面，没有收益。
    // 不挂进文档流，避免 Layout/绘制开销。
    probe.src = assetUrl;
    const ready = await new Promise<boolean>(resolve => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        probe.removeEventListener('canplay', onReady);
        probe.removeEventListener('error', onError);
        resolve(ok);
      };
      const onReady = () => finish(true);
      const onError = () => finish(false);
      const timer = setTimeout(() => finish(false), timeoutMs);
      probe.addEventListener('canplay', onReady, { once: true });
      probe.addEventListener('error', onError, { once: true });
      probe.load();
    });
    if (!ready) {
      probe.removeAttribute('src');
      probe.load();
      return null;
    }
    if (startPosition > 0) {
      try {
        probe.currentTime = startPosition;
      } catch {
        // 从 0 播，由主播放器再兜一次 seek
      }
    }
    return probe;
  };

  /**
   * 让主播放器真正起播。
   *
   * 返回**结果分类**而不是布尔值，是因为三种失败的处理方式完全不同，
   * 压成一个 false 会让上层只能无差别重试：
   * - `ok`：起播成功；
   * - `autoplay-blocked`：WebView2 连静音都不让自动播。**源是好的**，
   *   重试毫无意义——正确做法是提示用户点一下，而不是谎报"播放源连接受阻"；
   * - `error`：解码失败或 `play()` 被新 load()/pause() 打断（AbortError）。
   *   换一次 load() 能自愈，值得重试。
   */
  const startPlayback = async (video: HTMLVideoElement): Promise<PlayStartResult> => {
    try {
      await video.play();
      return 'ok';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotAllowedError' && !video.muted) {
        // WebView2 拒绝带声自动播放时静音重试，之后由用户手动恢复音量。
        video.muted = true;
        setIsMuted(true);
        try {
          await video.play();
          return 'ok';
        } catch {
          noteFailure('自动播放被拒绝（静音重试仍失败）', error);
          return 'autoplay-blocked';
        }
      }
      noteFailure('起播失败', error);
      return 'error';
    }
  };

  /**
   * 把主播放器切换到已预载好的源。
   *
   * 关键：**不调用 `video.load()`**。
   *
   * `load()` 会强制重置媒体元素并立即清空当前帧——这正是旧实现黑屏的
   * 直接机制。这里改用 `src = ...` + 等待 `loadeddata` 的策略：
   * 浏览器在拿到新源且首批数据就绪前会保留上一帧的绘制，
   * 等到有画面了才切换，用户看不到中间的黑场。
   */
  const adoptPreparedSource = async (
    prepared: PreparedSource,
    video: HTMLVideoElement,
    sessionId: number,
    startPosition: number,
  ): Promise<PlayOutcome> => {
    try {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = '';
      }
      video.dataset.sessionId = String(sessionId);
      video.playbackRate = playbackRate;
      video.volume = isMuted ? 0 : volume;
      video.muted = isMuted;

      // 等首批可绘制数据到位再切入：旧帧一直保留到这一刻。
      const firstFrameReady = new Promise<void>(resolve => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          video.removeEventListener('loadeddata', done);
          video.removeEventListener('error', done);
          resolve();
        };
        const timer = setTimeout(done, 8000);
        video.addEventListener('loadeddata', done, { once: true });
        video.addEventListener('error', done, { once: true });
      });
      video.src = prepared.url;
      await firstFrameReady;

      // 已被更新的切换接管：不是失败，别让调用方降级。
      if (activeSessionRef.current !== sessionId) return 'stale';
      // 解码层明确报错：不浪费一次 play()，直接交给调用方重试/换源。
      if (video.error) {
        noteFailure('解码失败', video.error);
        return 'error';
      }

      if (startPosition > 0) {
        try {
          video.currentTime = startPosition;
        } catch {
          // metadata 未就绪则从 0 播
        }
      }
      const started = await startPlayback(video);
      if (started !== 'ok') return started;
      if (activeSessionRef.current !== sessionId) return 'stale';
      setIsPlaying(true);
      setUiState({ kind: 'playing', sessionId, position: video.currentTime });
      return 'ok';
    } catch (error) {
      noteFailure('接管新源异常', error);
      return 'error';
    }
  };

  /**
   * 不经隐藏探针，直接把源喂给主播放器。
   *
   * 这是所有"探针预热没就绪 / 接管失败"之后的统一兜底：文件在盘上、
   * 本地解析也返回了路径，仅仅因为预热超时就判定整集不可用是完全不划算的。
   * 旧实现在 playLocalFile 里遇到探针失败直接 return false，于是换集时
   * 明明命中了本机缓存，也会掉到公开直链（已知被防盗链拦截）→ 错误页。
   */
  const playDirect = async (
    assetUrl: string,
    video: HTMLVideoElement,
    sessionId: number,
    startPosition: number,
  ): Promise<PlayOutcome> => {
    try {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = '';
      }
      video.dataset.sessionId = String(sessionId);
      video.playbackRate = playbackRate;
      video.volume = isMuted ? 0 : volume;
      video.muted = isMuted;

      const ready = new Promise<void>(resolve => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          video.removeEventListener('loadeddata', done);
          video.removeEventListener('error', done);
          resolve();
        };
        const timer = setTimeout(done, 10000);
        video.addEventListener('loadeddata', done, { once: true });
        video.addEventListener('error', done, { once: true });
      });
      video.src = assetUrl;
      video.load();
      await ready;

      if (activeSessionRef.current !== sessionId) return 'stale';
      if (video.error) {
        noteFailure('直接播放解码失败', video.error);
        return 'error';
      }
      if (startPosition > 0) {
        try {
          video.currentTime = startPosition;
        } catch {
          // metadata 未就绪则从 0 播
        }
      }
      const started = await startPlayback(video);
      if (started !== 'ok') return started;
      if (activeSessionRef.current !== sessionId) return 'stale';
      setIsPlaying(true);
      setUiState({ kind: 'playing', sessionId, position: video.currentTime });
      return 'ok';
    } catch (error) {
      noteFailure('直接播放异常', error);
      return 'error';
    }
  };

  const playNativeResolvedFile = async (
    seriesId: string,
    episodeId: string,
    quality: string,
    contentType: number,
    video: HTMLVideoElement,
    sessionId: number,
    startPosition = 0,
  ): Promise<PlayOutcome> => {
    try {
      const resolved = await ipcService.playback.resolveNative(
        seriesId,
        episodeId,
        contentType,
        quality,
      );
      // 解析成功立刻登记本地文件路径：换集/切清晰度第二次进入同一集时秒开。
      if (resolved.cached || resolved.sizeBytes > 0) {
        resolvedFileByVidRef.current.set(episodeCacheKey(seriesId, episodeId), resolved.playUrl);
      }
      if (activeSessionRef.current !== sessionId) return 'stale';
      const outcome = await playLocalFile(resolved.playUrl, video, sessionId, startPosition);
      // 只有"源本身有问题"才撤掉登记。自动播放被拦（autoplay-blocked）时
      // 文件是完好的，撤掉会导致下次重下一整集——白等 7 秒。
      if (outcome === 'error' && activeSessionRef.current === sessionId) {
        resolvedFileByVidRef.current.delete(episodeCacheKey(seriesId, episodeId));
      }
      return outcome;
    } catch (error) {
      noteFailure(`本地解析失败 ${seriesId}/${episodeId}`, error);
      return 'error';
    }
  };

  // 统一的本地解析入口：把在途 promise 记到 ref 上，供 error 事件链等待复用。
  //
  // `sessionId` 必须是**调用那一刻**的会话号。旧实现改用
  // `video.dataset.sessionId` 判活，而它永远指向最新的会话——于是旧会话的解析
  // 在 await 之后发现自己"还算当前"，继续去改 video.src 并 play()，把新会话
  // 刚设好的源打断（AbortError），两边一起失败。这正是换集/自动连播弹错误页
  // 的主要来源：连播时 ended 与倒计时可能各发一次 openEpisode。
  const startNativeResolve = (
    seriesId: string,
    episodeId: string,
    quality: string,
    contentType: number,
    video: HTMLVideoElement,
    sessionId: number,
    startPosition = 0,
  ): Promise<PlayOutcome> => {
    const attempt = playNativeResolvedFile(
      seriesId, episodeId, quality, contentType, video, sessionId, startPosition,
    )
      .finally(() => {
        if (nativeResolveInFlightRef.current === attempt) nativeResolveInFlightRef.current = null;
      });
    nativeResolveInFlightRef.current = attempt;
    return attempt;
  };

  // 已预取/已解析成功的集（seriesId:episodeId → playUrl）。命中则换集秒开，
  // 跳过注定被 CDN 防盗链拦截的公开直链链路（直链→备用→Blob 三连失败）。
  const resolvedFileByVidRef = useRef<Map<string, string>>(new Map());

  /**
   * 探测该集源流真实提供的清晰度档位。
   *
   * 只在首次进入某集时做一次，失败静默（清晰度是附加信息）。目的不是让用户
   * "切清晰度"，而是诚实地告诉用户源到底有几档——之前硬编码的 4K/1080P/720P
   * 与真实分辨率完全对不上（4K 实为 1080p、1080P 实为 540p）。
   *
   * 探测要额外拉起一次 worker，成本不低，因此按 vid 记忆结果，同一集只探一次。
   */
  const probedVidsRef = useRef<Set<string>>(new Set());
  const probeQualities = async (episodeId: string, contentType: number) => {
    if (probedVidsRef.current.has(episodeId)) return;
    probedVidsRef.current.add(episodeId);
    try {
      const variants = await ipcService.playback.listNativeQualities(episodeId, contentType);
      if (!variants.length) {
        setAvailableQualities([]);
        return;
      }
      const seen = new Set<number>();
      const options = variants
        .filter(item => item.height > 0)
        .sort((a, b) => b.height - a.height)
        .filter(item => {
          if (seen.has(item.height)) return false;
          seen.add(item.height);
          return true;
        })
        .map(item => ({
          label: `${item.height}P`,
          value: 'auto',
          resolution: `${item.width}x${item.height}`,
        }));
      setAvailableQualities(options);
    } catch {
      setAvailableQualities([]);
    }
  };

  /**
   * 发起一次后台整集预热（内部实现，所有预热入口共用同一个并发闸门）。
   *
   * 闸门是必要的：warmAdjacentEpisodes 一次要备 3 集，悬停入口还可能同时进来；
   * 若不限并发，鼠标扫过一屏选集就能让十几个 worker 同时抢带宽与 CPU，
   * 结果正在播的那一集反而更卡——适得其反。
   *
   * 返回是否真的发起了请求。
   */
  const startPrewarmResolve = (seriesId: string, episodeId: string, contentType: number): boolean => {
    if (!isTauriEnvironment()) return false;
    if (prewarmInflightRef.current >= MAX_PREWARM_INFLIGHT) return false;
    const key = episodeCacheKey(seriesId, episodeId);
    if (resolvedFileByVidRef.current.has(key)) return false; // 已缓存或已在途
    resolvedFileByVidRef.current.set(key, '__prefetching__');
    prewarmInflightRef.current += 1;
    // 占位必须保证最终释放：网络异常会被吞掉，若不在约定时间内收尾，
    // '__prefetching__' 会永久占住 key，导致该集再也无法被预热或被快路径命中。
    const guard = setTimeout(() => {
      if (resolvedFileByVidRef.current.get(key) === '__prefetching__') {
        resolvedFileByVidRef.current.delete(key);
      }
    }, 330_000);
    // 只发一次请求：prefetchNative 与 resolveNative 调用的是同一条
    // short_drama_app_resolve 命令，串成 .then 链等于把同一集解析两遍。
    void ipcService.playback
      .resolveNative(seriesId, episodeId, contentType, 'auto')
      .then(resolved => {
        clearTimeout(guard);
        if (resolved.playUrl) resolvedFileByVidRef.current.set(key, resolved.playUrl);
        else resolvedFileByVidRef.current.delete(key);
      })
      .catch(() => {
        clearTimeout(guard);
        resolvedFileByVidRef.current.delete(key);
      })
      .finally(() => {
        prewarmInflightRef.current = Math.max(0, prewarmInflightRef.current - 1);
      });
    return true;
  };

  /**
   * 预取队列：播放期间把"接下来可能被点开"的集按优先级排队，逐个在后台解析。
   *
   * 为什么需要队列而不是一次性并发：
   * - 单集解析实测约 7.4 秒（签名 3.6s + 下载解密 3.9s），而一集时长 50~140 秒，
   *   所以**只要持续排队，播放期间完全来得及把后面几集都备好**；
   * - 反过来若一次并发很多个，worker 会互相抢带宽与 CPU，正在播的那一集反而更卡。
   * 因此这里用"顺序推进 + 并发上限"：既覆盖更深的往后集数，又不影响当前播放。
   */
  const prefetchQueueRef = useRef<Array<{ seriesId: string; episodeId: string; contentType: number }>>([]);
  const prefetchPumpRunningRef = useRef<boolean>(false);

  /**
   * 播放期间预热后续集数（下三集优先，其次上一集兜底回看）。
   *
   * 旧实现只备 idx+1/idx+2，用户进剧后若直接跳到第 5 集仍要等完整解析；
   * 而且预取曾经挂在 handlePlaying 上、占位符还会被快路径跳过，等于从未生效。
   * 现在改成 openEpisode 落点即入队，由队列泵在播放期间持续消费——
   * 目标是"用户随手点后面任意一集，大概率已经在本机"。
   */
  const warmAdjacentEpisodes = (
    series: SeriesDetail,
    currentEpisodeId: string,
    sessionAtRequest: number,
  ) => {
    const idx = series.episodes.findIndex(e => e.id === currentEpisodeId);
    if (idx < 0) return;
    const contentType = series.type === 'comic' ? 1004 : 1;
    // 每次重新排队前先清空旧队列：换了剧或换了集之后，之前的预测已经过时。
    prefetchQueueRef.current = [];
    // 下三集优先（连播与随手点开的主要目标），上一集兜底"回看"。
    const next = series.episodes.slice(idx + 1, idx + 4);
    const prev = series.episodes[idx - 1] ? [series.episodes[idx - 1]] : [];
    const targets = [...next, ...prev];
    // 先把整个序列一次性登记为"在途"，避免队列还没轮到某一集时，
    // 悬停预热又对同一集发起第二次解析（后端虽有 leader/follower 去重，
    // 但前端这一层多打一次请求同样浪费）。
    targets.forEach(target => {
      const key = episodeCacheKey(series.id, target.id);
      if (!resolvedFileByVidRef.current.has(key)) {
        prefetchQueueRef.current.push({
          seriesId: series.id,
          episodeId: target.id,
          contentType,
        });
      }
    });
    // 交给泵消费。泵会在消费过程中校验会话，用户切走后立即停止。
    pumpPrefetchQueueForSession(sessionAtRequest);
  };

  /// 带会话校验的队列泵入口：用户切走后不再为旧会话继续占用带宽。
  const pumpPrefetchQueueForSession = (sessionAtQueueBuild: number) => {
    if (prefetchPumpRunningRef.current) return;
    prefetchPumpRunningRef.current = true;
    const step = () => {
      if (activeSessionRef.current !== sessionAtQueueBuild) {
        prefetchQueueRef.current = [];
        prefetchPumpRunningRef.current = false;
        return;
      }
      if (prewarmInflightRef.current >= MAX_PREWARM_INFLIGHT) {
        setTimeout(step, 400);
        return;
      }
      const next = prefetchQueueRef.current.shift();
      if (!next) {
        prefetchPumpRunningRef.current = false;
        return;
      }
      const accepted = startPrewarmResolve(next.seriesId, next.episodeId, next.contentType);
      // 未受理（已缓存/在途）就立刻继续下一项，不占用节奏。
      setTimeout(step, accepted ? 250 : 0);
    };
    step();
  };

  /**
   * 为指定集提前预热（详情页选集悬停、选集抽屉悬停）。
   *
   * 从"用户瞄上某一集"到"真正点进播放器"通常有几百毫秒到数秒的间隔，
   * 这段时间足以让 worker 把该集下载推进一截。此前只有进入播放器之后才
   * 才开始预取，等于白白丢掉这段本可以利用的时间。
   */
  const prewarmEpisode = (seriesId: string, episodeId: string, contentType = 1) => {
    startPrewarmResolve(seriesId, episodeId, contentType);
  };

  const playLocalFile = async (
    playUrl: string,
    video: HTMLVideoElement,
    sessionId: number,
    startPosition: number,
  ): Promise<PlayOutcome> => {
    try {
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      const assetUrl = convertFileSrc(playUrl);
      if (activeSessionRef.current !== sessionId) return 'stale'; // 已切走
      // 本地整集文件同样走"先预载、再接管"：即便文件已在盘上，
      // 也让旧帧留到新源解码就绪，避免同一条换集链路上出现两套体验。
      const prepared = await preloadSource(assetUrl, startPosition, 10000);
      if (activeSessionRef.current !== sessionId) {
        disposePrepared(prepared ? { url: assetUrl, element: prepared } : null);
        return 'stale';
      }
      if (prepared) {
        const adopted = await adoptPreparedSource(
          { url: assetUrl, element: prepared },
          video,
          sessionId,
          startPosition,
        );
        disposePrepared({ url: assetUrl, element: prepared });
        // 自动播放被拦说明源是好的、只是缺一次用户手势，再 load() 一次也没用；
        // 直接把结果交回上层，让它如实提示"点击播放"，而不是谎报源故障。
        if (adopted !== 'error') return adopted;
        if (activeSessionRef.current !== sessionId) return 'stale';
      }
      // 探针没就绪、或接管时解码/起播失败，都**不等于这个文件坏了**。
      //
      // 旧实现在这里直接 return false，调用方于是清掉缓存登记、掉到公开直链
      // 兜底——而那条链路已被证实会被防盗链拦截，结果就是"整集明明在本机，
      // 换集却弹播放失败"。这里改成退一步直接喂给主播放器再试一次。
      return await playDirect(assetUrl, video, sessionId, startPosition);
    } catch (error) {
      noteFailure(`本地文件播放失败 ${playUrl}`, error);
      return 'error';
    }
  };

  // 节流保存历史记录
  const lastSaveTimeRef = useRef<number>(0);
  const saveProgressThrottled = useCallback((pos: number, dur: number, force = false) => {
    if (!currentSeries || !currentEpisode) return;
    const now = Date.now();
    if (!force && now - lastSaveTimeRef.current < 4000) return;
    lastSaveTimeRef.current = now;

    const percent = dur > 0 ? Math.min(100, Math.round((pos / dur) * 100)) : 0;
    const isFinished = percent >= 95;

    ipcService.history.save({
      seriesId: currentSeries.id,
      episodeId: currentEpisode.id,
      title: currentSeries.title,
      seriesCover: currentSeries.cover,
      episodeNumber: currentEpisode.episodeNumber,
      totalEpisodes: currentSeries.episodesCount,
      positionSeconds: Math.floor(pos),
      durationSeconds: Math.floor(dur),
      progressPercent: percent,
      updatedAt: now,
      isFinished,
      channel: currentSeries.type,
    });
  }, [currentSeries, currentEpisode]);
  // 喂给"只绑定一次"的事件监听器，保证它们拿到最新闭包。
  saveProgressThrottledRef.current = saveProgressThrottled;

  // 打开剧集与换集核心（实现体；对外暴露的 openEpisode 只做同键去重）
  const runOpenEpisode = async (seriesId: string, episodeId?: string, startPosition = 0, qualityOverride?: string) => {
    const qualitySwitchRequested = Boolean(
      qualityOverride
      && currentSeries?.id === seriesId
      && currentEpisode?.id === episodeId,
    );
    // 清除现有的连播倒计时
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    setCountdown({ active: false, remaining: 5, nextEpisode: null });
    // 上一集的解析进度与失败原因都不能留到这一集：新的解析会立刻重新上报，
    // 而残留的旧错误说明会让本次失败的原因被误读。
    setPrepareStatus(null);
    setErrorDetail(null);

    const newSessionId = (activeSessionRef.current += 1);
    setSessionId(newSessionId);
    if (!qualitySwitchRequested) {
      setUiState({ kind: 'opening', sessionId: newSessionId, episodeId: episodeId || '' });
    }

    // ===== 切换的瞬间就停掉旧视频 =====
    //
    // 旧实现的换集链路刻意不暂停主播放器（为了"旧帧保留、避免黑屏"），
    // 但那条链路只覆盖"同一个 video 元素换 src"的场景。实测发现两个后果：
    //   1. 点击另一部剧播放时，**上一部剧的声音会继续播放**，直到新剧下载解
    //      析完成才被替换——用户听到的是自己已经放弃的那部剧，非常困惑；
    //   2. 这段时间里画面与声音属于不同内容，观感割裂。
    //
    // 关键点：pause() **不会清空当前帧**（清空画面的是 load()，见
    // adoptPreparedSource 的注释）。因此这里暂停即可同时满足两个目标——
    // 声音立即停止，而最后一帧继续留在屏幕上，不给用户黑屏。
    //
    // 只有"同一集切清晰度"例外：那本来就是同一路内容，不该打断播放。
    if (!qualitySwitchRequested) {
      const currentVideo = videoRef.current;
      if (currentVideo && !currentVideo.paused) {
        currentVideo.pause();
      }
      setIsPlaying(false);
      // 已经有内容在播（或刚播过）才算"切换"；从发现页首次进入播放器不算，
      // 那种场景画面本来就是空的，用全屏遮罩更合适。
      setIsSwitching(Boolean(currentEpisode && currentSeries));
    }

    try {
      const detail = await ipcService.series.getDetail(seriesId);
      if (activeSessionRef.current !== newSessionId) return; // 已有更新的请求

      setCurrentSeries(detail);
      // 首次进入某剧且用户未显式指定：采用设置里的默认清晰度。
      // 此前 currentQuality 硬编码 'auto'，设置页的选择从未生效。
      const isFirstOpenOfSeries = currentSeries?.id !== seriesId;
      if (isFirstOpenOfSeries && !qualityOverride && settings.defaultQuality && settings.defaultQuality !== 'auto') {
        setCurrentQuality(settings.defaultQuality);
      }
      const ep = episodeId
        ? detail.episodes.find(e => e.id === episodeId) || detail.episodes[0]
        : detail.episodes[0];
      if (!ep) {
        throw new Error('该剧集暂无可播放的集数。');
      }
      setCurrentEpisode(ep);

      const selectedQuality = qualityOverride || currentQuality;

      // 快路径：该集此前已解析出本地文件（首次播放成功或预取完成）。
      // 直接秒开本地 mp4，跳过注定失败的公开直链试探（省 3-10 秒）。
      const video = videoRef.current;
      const cachedKey = episodeCacheKey(seriesId, ep.id);
      const cachedPlayUrl = resolvedFileByVidRef.current.get(cachedKey);
      if (video && cachedPlayUrl && cachedPlayUrl !== '__prefetching__') {
        video.dataset.sessionId = String(newSessionId);
        backupUrlRef.current = '';
        hasTriedBackupRef.current = true;
        hasTriedBlobRef.current = true;
        hasTriedNativeResolveRef.current = true;
        const outcome = await playLocalFile(cachedPlayUrl, video, newSessionId, startPosition);
        if (isSettled(outcome)) {
          // 已被更新的切换接管就直接退出：warmAdjacentEpisodes 会先清空预取队列，
          // 而队列是共享的——这里再排一次会把新会话刚建好的队列清掉。
          if (activeSessionRef.current !== newSessionId) return;
          // 命中快路径才预热相邻集：此时播放已稳定，后台下载不影响出画。
          warmAdjacentEpisodes(detail, ep.id, newSessionId);
          return;
        }
        if (outcome === 'autoplay-blocked') {
          // 源已经就绪，只是 WebView 不允许无手势起播。如实告知用户点一下，
          // 绝不降级到公开直链——那样会显示成"播放源连接受阻"，完全误导。
          setIsPlaying(false);
          setUiState({
            kind: 'error',
            sessionId: newSessionId,
            code: 'MEDIA_AUTOPLAY_FAILED',
            recoverable: true,
          });
          return;
        }
        // 本地文件播不了（被删/损坏）：清缓存回退完整链路。
        resolvedFileByVidRef.current.delete(cachedKey);
      }

      // 无预取缓存时的路径选择：红果公开 /player 直链在 WebView 里被防盗链
      // 拦截（直链→备用→Blob 三连失败后才到本地解析），对未缓存集直接跳过
      // 公开链路走本地解析，省 3-10 秒无谓等待。已缓存的集由上面的快路径处理。
      if (videoRef.current && activeSessionRef.current === newSessionId) {
        const video = videoRef.current;
        video.dataset.sessionId = String(newSessionId);
        backupUrlRef.current = '';
        hasTriedBackupRef.current = true;
        hasTriedBlobRef.current = true;
        setUiState({ kind: 'opening', sessionId: newSessionId, episodeId: ep.id });
        hasTriedNativeResolveRef.current = true;
        let outcome = await startNativeResolve(
          seriesId,
          ep.id,
          selectedQuality,
          detail.type === 'comic' ? 1004 : 1,
          video,
          newSessionId,
          startPosition,
        );
        // autoplay-blocked 不重试：源已经解析好、文件也在盘上，重跑一整集
        // 只是让用户多等 7 秒，结果还是"需要点一下"。
        if (outcome === 'error' && activeSessionRef.current === newSessionId && !resolveRetriedRef.current.has(ep.id)) {
          // 整集解析要走"签名 → 取直链 → 下载 → 解密转存"，任何一环都可能是
          // 瞬时故障（签名过期、网络抖动、worker 被并发挤掉）。这类失败重试一次
          // 大概率就过了，直接弹错误页太浪费——用户点"重新解析播放"做的也是同一件事。
          // 只重试一次：真失败时再多等一轮只会拖延用户看到结论的时间。
          resolveRetriedRef.current.add(ep.id);
          await new Promise(resolve => setTimeout(resolve, 700));
          if (activeSessionRef.current === newSessionId) {
            // 撤掉登记，确保这一轮是真正的重新解析而不是再读一次坏文件。
            resolvedFileByVidRef.current.delete(episodeCacheKey(seriesId, ep.id));
            setUiState({ kind: 'opening', sessionId: newSessionId, episodeId: ep.id });
            outcome = await startNativeResolve(
              seriesId,
              ep.id,
              selectedQuality,
              detail.type === 'comic' ? 1004 : 1,
              video,
              newSessionId,
              startPosition,
            );
          }
        }
        if (isSettled(outcome)) {
          if (activeSessionRef.current !== newSessionId) return;
          resolveRetriedRef.current.delete(ep.id);
          // 首次进入该集且播放成功：后台探测真实清晰度档位，不阻塞播放。
          void probeQualities(ep.id, detail.type === 'comic' ? 1004 : 1);
          warmAdjacentEpisodes(detail, ep.id, newSessionId);
          return;
        }
        if (outcome === 'autoplay-blocked') {
          // 源已就绪、只差一次用户手势：如实提示，别去碰公开直链。
          setIsPlaying(false);
          setUiState({
            kind: 'error',
            sessionId: newSessionId,
            code: 'MEDIA_AUTOPLAY_FAILED',
            recoverable: true,
          });
          return;
        }
        // 本地解析也失败（API 拒绝/网络断）：最后再试公开网页直链兜底。
      }

      let session;
      try {
        session = await ipcService.playback.open(seriesId, ep.id, selectedQuality, startPosition, newSessionId);
      } catch (webError) {
        if (activeSessionRef.current !== newSessionId) return;
        throw webError;
      }
      if (activeSessionRef.current !== newSessionId) return;

      // 走到这里只剩公开网页直链兜底（本地解析失败的罕见场景）。
      // 清晰度切换预热保留：旧画面继续播，预热完成才切，避免黑屏。

      backupUrlRef.current = session.backupUrl || '';
      hasTriedBackupRef.current = false;
      hasTriedBlobRef.current = false;
      hasTriedNativeResolveRef.current = false;

      if (videoRef.current) {
        const video = videoRef.current;
        const preferredMuted = isMuted;
        video.dataset.sessionId = String(newSessionId);
        if (objectUrlRef.current) {
          URL.revokeObjectURL(objectUrlRef.current);
          objectUrlRef.current = '';
        }
        video.preload = 'auto';
        video.playbackRate = playbackRate;
        video.volume = isMuted ? 0 : volume;
        // 优先保留用户音量。若 WebView 拒绝带声音自动播放，再在 catch 中静音重试。
        video.muted = preferredMuted;
        // 不 pause()、不 load()：旧帧保留到新源首批数据就绪，避免兜底路径又黑一次。
        const webFirstFrame = new Promise<void>(resolve => {
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(webTimer);
            video.removeEventListener('loadeddata', done);
            video.removeEventListener('error', done);
            resolve();
          };
          const webTimer = setTimeout(done, 8000);
          video.addEventListener('loadeddata', done, { once: true });
          video.addEventListener('error', done, { once: true });
        });
        video.src = session.url;
        await webFirstFrame;

        if (startPosition > 0) {
          const handleMetadata = () => {
            try {
              video.currentTime = startPosition;
            } catch {
              // ignore
            }
            video.removeEventListener('loadedmetadata', handleMetadata);
          };
          if (video.readyState >= 1) {
            video.currentTime = startPosition;
          } else {
            video.addEventListener('loadedmetadata', handleMetadata);
          }
        }

        video.play().then(() => {
          video.muted = preferredMuted;
          setIsPlaying(true);
          setUiState({ kind: 'playing', sessionId: newSessionId, position: startPosition });
        }).catch((error: unknown) => {
          // WebView2 may reject the first gesture-less attempt only because it has audio.
          // Retry muted so the episode starts, then let the user restore sound explicitly.
          if (error instanceof DOMException && error.name === 'NotAllowedError' && !video.muted) {
            video.muted = true;
            setIsMuted(true);
            void video.play().then(() => {
              setIsPlaying(true);
              setUiState({ kind: 'playing', sessionId: newSessionId, position: video.currentTime });
            }).catch(() => {
              setIsPlaying(false);
              setUiState({ kind: 'error', sessionId: newSessionId, code: 'MEDIA_AUTOPLAY_FAILED', recoverable: true });
            });
            return;
          }
          const code = error instanceof DOMException && error.name === 'NotAllowedError'
            ? 'MEDIA_AUTOPLAY_FAILED'
            : 'MEDIA_LOAD_FAILED';
          if (code === 'MEDIA_LOAD_FAILED' && !hasTriedNativeResolveRef.current) {
            hasTriedNativeResolveRef.current = true;
            // 切清晰度/首开失败：CDN 直链不通，转入本地解析下载。下载需要
            // 时间，画面停在 opening（缓冲转圈），不再闪错误页。
            setUiState({ kind: 'opening', sessionId: newSessionId, episodeId: ep.id });
            void startNativeResolve(
              seriesId,
              ep.id,
              selectedQuality,
              detail.type === 'comic' ? 1004 : 1,
              video,
              newSessionId,
            ).then(result => {
              if (isSettled(result)) return;
              setIsPlaying(false);
              setUiState({
                kind: 'error',
                sessionId: newSessionId,
                code: outcomeErrorCode(result, code),
                recoverable: true,
              });
            });
            return;
          }
          setIsPlaying(false);
          setUiState({
            kind: 'error',
            sessionId: newSessionId,
            code,
            recoverable: true,
          });
        });
      }
    } catch (err) {
      if (activeSessionRef.current === newSessionId) {
        noteFailure('打开集数失败', err);
        setUiState({
          kind: 'error',
          sessionId: newSessionId,
          code: (err as Error).message || 'MEDIA_LOAD_FAILED',
          recoverable: true,
        });
      }
    }
  };

  /**
   * 对"同一集、同一起点"的重复打开做去重。
   *
   * 自动连播是这条防线存在的理由：倒计时到点会调用一次 playNextEpisode，
   * 而 `ended` 事件在 React 状态（currentEpisode）尚未落地时也会再调一次，
   * 于是同一集在几百毫秒内被打开两次。旧实现让两条解析链并行跑：
   * 后到的 session 改掉 `video.dataset.sessionId` 并抢先设 src/play()，
   * 先到的那条在 await 之后仍认为自己是当前的，跟着再设一次 src——
   * 于是两次 `play()` 互相 Abort，双双失败并弹错误页。
   *
   * 去重后第二次调用直接复用第一次的 promise，既省一次解析，也消除了互殴。
   */
  // 已经整集重试过的 vid：见 runOpenEpisode 里的"只重试一次"约定。
  const resolveRetriedRef = useRef<Set<string>>(new Set());
  const openInFlightRef = useRef<Map<string, Promise<void>>>(new Map());
  const openEpisode = (seriesId: string, episodeId?: string, startPosition = 0, qualityOverride?: string): Promise<void> => {
    const key = `${seriesId}|${episodeId || ''}|${Math.round(startPosition)}|${qualityOverride || ''}`;
    const inflight = openInFlightRef.current.get(key);
    if (inflight) return inflight;
    const task = runOpenEpisode(seriesId, episodeId, startPosition, qualityOverride)
      .finally(() => {
        if (openInFlightRef.current.get(key) === task) openInFlightRef.current.delete(key);
      });
    openInFlightRef.current.set(key, task);
    return task;
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play().then(() => {
        setIsPlaying(true);
        setUiState({ kind: 'playing', sessionId: activeSessionRef.current, position: videoRef.current?.currentTime || 0 });
      }).catch((error: unknown) => {
        if (currentSeries && currentEpisode && videoRef.current) {
          // 复用已在途的解析任务（error 事件链可能已启动 worker），没有才新起。
          const attempt = nativeResolveInFlightRef.current ?? (() => {
            hasTriedNativeResolveRef.current = true;
            setUiState({ kind: 'opening', sessionId: activeSessionRef.current, episodeId: currentEpisode.id });
            return startNativeResolve(
              currentSeries.id,
              currentEpisode.id,
              currentQuality,
              currentSeries.type === 'comic' ? 1004 : 1,
              videoRef.current,
              activeSessionRef.current,
              position,
            );
          })();
          void attempt.then(result => {
            if (!isSettled(result)) {
              setUiState({
                kind: 'error',
                sessionId: activeSessionRef.current,
                code: outcomeErrorCode(result),
                recoverable: true,
              });
            }
          });
          return;
        }
        const code = error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'MEDIA_AUTOPLAY_FAILED'
          : 'MEDIA_LOAD_FAILED';
        setUiState({ kind: 'error', sessionId: activeSessionRef.current, code, recoverable: true });
      });
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
      saveProgressThrottled(position, duration, true);
    }
  };

  const seek = (seconds: number) => {
    if (!videoRef.current) return;
    const clamped = Math.max(0, Math.min(seconds, duration || 0));
    videoRef.current.currentTime = clamped;
    setPosition(clamped);
    saveProgressThrottled(clamped, duration, true);
  };

  const seekRelative = (deltaSeconds: number) => {
    seek(position + deltaSeconds);
  };

  const setVolume = (vol: number) => {
    const clamped = Math.max(0, Math.min(1, vol));
    setVolumeState(clamped);
    if (videoRef.current) {
      videoRef.current.volume = clamped;
      if (clamped > 0 && isMuted) {
        setIsMuted(false);
        videoRef.current.muted = false;
      }
    }
  };

  const toggleMute = () => {
    setIsMuted(prev => {
      const next = !prev;
      if (videoRef.current) {
        videoRef.current.muted = next;
      }
      return next;
    });
  };

  const setPlaybackRate = (rate: number) => {
    setPlaybackRateState(rate);
    if (videoRef.current) {
      videoRef.current.playbackRate = rate;
    }
  };

  const setQuality = (quality: string) => {
    // 源流只提供单一路径时，"切清晰度"不再是真实操作：直接返回，
    // 不再触发一次无意义的重解析（旧版会因此重下一遍同一集）。
    if (quality === currentQuality) return;
    setCurrentQuality(quality);
    if (currentSeries && currentEpisode) {
      // 保持当前播放位置平滑切清晰度
      void openEpisode(currentSeries.id, currentEpisode.id, position, quality);
    }
  };

  // 下一集
  const playNextEpisode = useCallback(() => {
    if (!currentSeries || !currentEpisode) return;
    const currentIndex = currentSeries.episodes.findIndex(e => e.id === currentEpisode.id);
    if (currentIndex >= 0 && currentIndex < currentSeries.episodes.length - 1) {
      const nextEp = currentSeries.episodes[currentIndex + 1];
      openEpisode(currentSeries.id, nextEp.id, 0);
    }
  }, [currentSeries, currentEpisode]);
  playNextEpisodeRef.current = playNextEpisode;

  // 上一集
  const playPrevEpisode = useCallback(() => {
    if (!currentSeries || !currentEpisode) return;
    const currentIndex = currentSeries.episodes.findIndex(e => e.id === currentEpisode.id);
    if (currentIndex > 0) {
      const prevEp = currentSeries.episodes[currentIndex - 1];
      openEpisode(currentSeries.id, prevEp.id, 0);
    }
  }, [currentSeries, currentEpisode]);

  // 连播倒计时处理
  const cancelCountdown = () => {
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    setCountdown({ active: false, remaining: 5, nextEpisode: null });
  };

  const acceptCountdown = () => {
    cancelCountdown();
    playNextEpisode();
  };

  /**
   * 离开播放器工作区时停止播放。
   *
   * 为什么必须显式停止：播放器宿主是**常驻 DOM** 的（为了保住 videoRef 就绪、
   * 切换不闪屏），离开播放器时它只是被 `display:none` 隐藏——`<video>` 并不会
   * 因此暂停，于是退出后声音继续在后台播放（实测：返回主界面后 paused 仍为
   * false，currentTime 持续前进）。
   *
   * 连播倒计时必须一并取消：否则它在后台到点仍会调用 playNextEpisode，
   * 在用户看不到画面的情况下自动开播下一集、继续出声。
   *
   * 同时强制落盘进度，避免"看了半集、退出后进度丢失"。
   */
  const stopPlayback = useCallback(() => {
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    setCountdown({ active: false, remaining: 5, nextEpisode: null });

    const video = videoRef.current;
    if (video) {
      if (!video.paused) video.pause();
      if (video.duration > 0 && Number.isFinite(video.duration)) {
        saveProgressThrottledRef.current(video.currentTime, video.duration, true);
      }
    }
    setIsPlaying(false);
    // 回到 idle 而不是保留 playing/buffering：否则重新进入播放器时
    // 界面会先闪一下上一集的加载遮罩。
    setUiState(prev => (prev.kind === 'idle' ? prev : { kind: 'idle' }));
  }, []);

  /**
   * 事件处理器上下文。
   *
   * 旧实现把 6 个监听器直接绑在 effect 里，依赖数组带着 `countdown.active`——
   * 倒计时每秒跳一下就会把 6 个监听器全部摘掉重绑，换集瞬间还叠加
   * currentSeries/currentEpisode 变化，造成成片的事件抖动与 listener 泄漏风险。
   * 现在监听器**只绑定一次**，通过这个 ref 读到最新状态。
   */
  const handlerCtxRef = useRef({
    currentSeries,
    currentEpisode,
    currentQuality,
    isMuted,
    countdownActive: countdown.active,
    autoNext: settings.autoNext,
    countdownSeconds: settings.countdownSeconds,
  });
  handlerCtxRef.current = {
    currentSeries,
    currentEpisode,
    currentQuality,
    isMuted,
    countdownActive: countdown.active,
    autoNext: settings.autoNext,
    countdownSeconds: settings.countdownSeconds,
  };

  // 监听播放器事件（缓冲、时间更新、结束）——只绑定一次，永不重绑。
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => {
      const cur = video.currentTime;
      const dur = video.duration || 0;
      setPosition(cur);
      setDuration(dur);
      saveProgressThrottledRef.current(cur, dur);

      const ctx = handlerCtxRef.current;
      // 距离结束 8 秒且还有下一集时触发连播倒计时（尊重用户的自动连播开关）。
      if (dur > 20 && dur - cur <= 8 && !ctx.countdownActive && ctx.autoNext
          && ctx.currentSeries && ctx.currentEpisode) {
        const curIdx = ctx.currentSeries.episodes.findIndex(e => e.id === ctx.currentEpisode!.id);
        if (curIdx >= 0 && curIdx < ctx.currentSeries.episodes.length - 1) {
          const nextEp = ctx.currentSeries.episodes[curIdx + 1];
          const total = Math.max(3, Math.min(15, ctx.countdownSeconds || 5));
          setCountdown({ active: true, remaining: total, nextEpisode: nextEp });

          let sec = total;
          if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
          countdownIntervalRef.current = setInterval(() => {
            sec -= 1;
            if (sec <= 0) {
              if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
              countdownIntervalRef.current = null;
              // 倒计时读秒期间用户若关掉了自动连播，则不跳集。
              if (handlerCtxRef.current.autoNext) playNextEpisodeRef.current();
            } else {
              setCountdown(prev => ({ ...prev, remaining: sec }));
            }
          }, 1000);
        }
      }
    };

    const handleProgress = () => {
      if (video.buffered.length > 0) {
        setBuffered(video.buffered.end(video.buffered.length - 1));
      }
    };

    const handleWaiting = () => {
      // 只在真正有源、且确实处于播放态时才报缓冲。
      // 旧实现无条件播报，换集时 video.load() 触发的空源 waiting 会让
      // 转圈图标闪一下，加重"卡顿"的观感。
      if (!video.currentSrc && !video.src) return;
      if (video.readyState >= 3) return;
      setUiState({ kind: 'buffering', sessionId: activeSessionRef.current });
    };

    const handlePlaying = () => {
      setIsPlaying(true);
      setUiState({ kind: 'playing', sessionId: activeSessionRef.current, position: video.currentTime });
      // 预取已迁移到 openEpisode 落点（warmAdjacentEpisodes），这里不再重复发起：
      // 挂在 playing 上会导致"必须真正开播才预取"，而用户往往在开播瞬间就切集，
      // 预取来不及完成，等于没做。
    };

    const handleEnded = () => {
      setIsPlaying(false);
      setUiState({ kind: 'ended', sessionId: activeSessionRef.current });
      saveProgressThrottledRef.current(video.duration, video.duration, true);
      if (handlerCtxRef.current.autoNext) {
        playNextEpisodeRef.current();
      }
    };

    const handleError = () => {
      // 清理旧源时 WebView2 可能派发一次空源 error，不应覆盖真实播放状态。
      if (!video.currentSrc && !video.src) return;
      // 本地解析已在途（openEpisode 或 play() 拒绝分支已启动 worker）：
      // 直链失败不代表应用内播不了，保持 opening 状态等待结果，禁止弹错误页或降级。
      if (nativeResolveInFlightRef.current) return;
      const ctx = handlerCtxRef.current;
      const backupUrl = backupUrlRef.current;
      if (backupUrl && !hasTriedBackupRef.current) {
        hasTriedBackupRef.current = true;
        setUiState({ kind: 'opening', sessionId: activeSessionRef.current, episodeId: ctx.currentEpisode?.id || '' });
        video.pause();
        const preferredMuted = ctx.isMuted;
        video.muted = true;
        video.src = backupUrl;
        video.load();
        void video.play()
          .then(() => {
            video.muted = preferredMuted;
            setIsPlaying(true);
            setUiState({ kind: 'playing', sessionId: activeSessionRef.current, position: video.currentTime });
          })
          .catch(() => {
            setUiState({
              kind: 'error',
              sessionId: activeSessionRef.current,
              code: 'MEDIA_BACKUP_LOAD_FAILED',
              recoverable: true,
            });
          });
        return;
      }
      const sourceUrl = video.currentSrc || video.src;
      if (sourceUrl && !sourceUrl.startsWith('blob:') && !hasTriedBlobRef.current) {
        hasTriedBlobRef.current = true;
        void fetch(sourceUrl, { cache: 'no-store', referrerPolicy: 'no-referrer' })
          .then(response => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.blob();
          })
          .then(blob => {
            if (activeSessionRef.current !== Number(video.dataset.sessionId)) return;
            objectUrlRef.current = URL.createObjectURL(blob);
            video.src = objectUrlRef.current;
            video.load();
            return video.play();
          })
          .then(() => {
            setIsPlaying(true);
            setUiState({ kind: 'playing', sessionId: activeSessionRef.current, position: video.currentTime });
          })
          .catch(() => {
            // 走到这里说明 CDN 直链与 Blob 代理都被挡了。唯一可行路径就是
            // 本地解析（worker 下载→解密→本地 mp4），在播放页内完成，不弹外部播放器。
            const snapshot = handlerCtxRef.current;
            const nativeAttempt = snapshot.currentSeries && snapshot.currentEpisode
              ? (() => {
                  hasTriedNativeResolveRef.current = true;
                  setUiState({ kind: 'opening', sessionId: activeSessionRef.current, episodeId: snapshot.currentEpisode!.id });
                  return startNativeResolve(
                    snapshot.currentSeries!.id,
                    snapshot.currentEpisode!.id,
                    snapshot.currentQuality,
                    snapshot.currentSeries!.type === 'comic' ? 1004 : 1,
                    video,
                    activeSessionRef.current,
                  );
                })()
              : Promise.resolve<PlayOutcome>('error');
            void nativeAttempt.then(result => {
              if (isSettled(result)) return;
              setIsPlaying(false);
              setUiState({
                kind: 'error',
                sessionId: activeSessionRef.current,
                code: outcomeErrorCode(result),
                recoverable: true,
              });
            });
          });
        return;
      }
      // 已试过直链/备用/Blob 且无在途解析：此时才宣判失败。
      if (hasTriedNativeResolveRef.current) {
        setIsPlaying(false);
        setUiState({
          kind: 'error',
          sessionId: activeSessionRef.current,
          code: 'MEDIA_LOAD_FAILED',
          recoverable: true,
        });
        return;
      }
      // 还有本地解析这张牌：直接打，不打错误页。
      if (ctx.currentSeries && ctx.currentEpisode) {
        hasTriedNativeResolveRef.current = true;
        setUiState({ kind: 'opening', sessionId: activeSessionRef.current, episodeId: ctx.currentEpisode.id });
        void startNativeResolve(
          ctx.currentSeries.id,
          ctx.currentEpisode.id,
          ctx.currentQuality,
          ctx.currentSeries.type === 'comic' ? 1004 : 1,
          video,
          activeSessionRef.current,
        );
        return;
      }
      setIsPlaying(false);
      setUiState({
        kind: 'error',
        sessionId: activeSessionRef.current,
        code: 'MEDIA_LOAD_FAILED',
        recoverable: true,
      });
    };

    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('progress', handleProgress);
    video.addEventListener('waiting', handleWaiting);
    video.addEventListener('playing', handlePlaying);
    video.addEventListener('ended', handleEnded);
    video.addEventListener('error', handleError);

    return () => {
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('progress', handleProgress);
      video.removeEventListener('waiting', handleWaiting);
      video.removeEventListener('playing', handlePlaying);
      video.removeEventListener('ended', handleEnded);
      video.removeEventListener('error', handleError);
    };
    // 有意留空依赖：监听器只绑定一次。
    // 旧版把 currentSeries / currentEpisode / currentQuality / countdown.active /
    // isMuted 都列进依赖，导致倒计时每秒、每次换集都全量摘绑 6 个监听器——
    // 既是性能抖动源，也有 listener 泄漏风险。所有需要的状态改由
    // handlerCtxRef 实时读取，saveProgressThrottled 用 ref 间接调用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <PlaybackContext.Provider
      value={{
        sessionId,
        currentSeries,
        currentEpisode,
        uiState,
        isPlaying,
        position,
        duration,
        buffered,
        volume,
        isMuted,
        playbackRate,
        currentQuality,
        availableQualities,
        isSideDrawerOpen,
        countdown,
        isDiagnosticsOpen,
        videoRef,
        openEpisode,
        togglePlay,
        seek,
        seekRelative,
        setVolume,
        toggleMute,
        setPlaybackRate,
        setQuality,
        playNextEpisode,
        playPrevEpisode,
        toggleSideDrawer: (open) => setIsSideDrawerOpen(prev => open ?? !prev),
        toggleDiagnostics: (open) => setIsDiagnosticsOpen(prev => open ?? !prev),
        cancelCountdown,
        acceptCountdown,
        stopPlayback,
        isSwitching,
        prepareStatus,
        errorDetail,
        prewarmEpisode,
      }}
    >
      {children}
    </PlaybackContext.Provider>
  );
};

export function usePlaybackStore() {
  const ctx = useContext(PlaybackContext);
  if (!ctx) throw new Error('usePlaybackStore must be used within PlaybackProvider');
  return ctx;
}
