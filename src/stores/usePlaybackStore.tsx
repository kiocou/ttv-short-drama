import React, { createContext, useContext, useState, useRef, useEffect, useCallback, useMemo, ReactNode } from 'react';
import { PlaybackUiState, PlaybackSession } from '../types/playback';
import { SeriesDetail, EpisodeItem } from '../types/series';
import { ipcService, isTauriEnvironment } from '../services/ipc';
import { attachSource, isHlsUrl, detachSource } from '../services/hlsAttach';
import { dismissPip, openPip } from '../services/pip';
import { tracePlayback } from '../services/playbackTrace';
import { useSettingsStore } from './useSettingsStore';

/**
 * 整集缓存的统一 key。
 *
 * 关键决策：**把清晰度拼进 key**。后端按 requested_quality 产出不同实体
 * （auto → `{vid}.mp4`，指定档位 → `{vid}-{quality}.mp4`），键也必须带档位，
 * 否则切换清晰度后快路径会把上一档的本地文件当作本档结果秒开，表现成"切了没反应"。
 *
 * 历史：曾有一版把清晰度从 key 里去掉，理由是"后端已把清晰度归一成 auto"——
 * 那正是画质切换完全失效的那一版。后端恢复按档落盘后，该前提已不成立。
 */
function episodeCacheKey(seriesId: string, episodeId: string, quality: string): string {
  return `${seriesId}:${episodeId}:${quality || 'auto'}`;
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

// 不能 export：本文件是组件模块，混进一个非组件导出会让 react-refresh 判定
// "无法 Fast Refresh"，之后每次编辑本文件都整树刷新（实测一次追剧连吃 4 次，
// 播放现场全灭）。它只在本文件内使用，保持模块私有即可。
function disposePrepared(prepared: PreparedSource | null): void {
  if (!prepared) return;
  try {
    prepared.element.pause();
    prepared.element.removeAttribute('src');
    prepared.element.load();
  } catch {
    // 释放失败不影响主流程
  }
}

/** 首帧预解池的容量。3 = 下一集 + 下两集，与 warmAdjacentEpisodes 的下三集对齐。 */
const PREPARED_POOL_MAX = 3;

/**
 * 前缀片段能覆盖到的秒数，用来决定这次起播值不值得走前缀先行。
 *
 * 前缀就是开头一小段（worker 按 `TTV_SD_PREFIX_BYTES` 截断），实测落盘十几秒。
 * 从这个位置往后续播时，前缀文件播几下就到头，反而会先送一次 ended —— 对
 * 继续观看这种场景得不偿失，直接等整集。取 3 秒是保守值：只有从片头（或片头
 * 附近）开播才走前缀，而这正是红果点开就看的那个主路径。
 */
const PREFIX_COVERAGE_SECONDS = 3;

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
  /** 离开播放器工作区时调用：暂停画面、取消后台连播并落盘进度。 */
  stopPlayback: () => void;
  /**
   * 全部剧集已播完（连播开启、最后一集正常 ended）。宿主读到后应返回详情页；
   * 任何新的用户接管都会把它复位。
   */
  finishedAll: boolean;
  /** 显式设置静音（从小窗回播放器时接回音频状态用）。 */
  setMuted: (value: boolean) => void;
  /**
   * 把当前这一集交给画中画小窗继续播（返回 false 表示没交出去，调用方应留在播放器）。
   */
  enterPip: () => Promise<boolean>;
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
  /**
   * 卡死提示文案，null 表示不显示。
   *
   * 生命周期由 store 管：卡死 → 非空 → 恢复成功 / 用户关闭 / 判死 → 回到 null。
   * 绝不允许它永久停在一个非空值上（那是死 UI）。
   */
  stallNotice: string | null;
  /** 用户手动关掉卡死提示。 */
  dismissStallNotice: () => void;
}

/**
 * 与时间无关的「动作 + 会话身份」。**专供非播放器宿主消费**（App 壳层、发现页、
 * 历史、详情、选集抽屉、PipReturnBridge、诊断面板）。
 *
 * ## 为什么要拆出这一份
 *
 * `PlaybackContext` 里混着高频变化的值：`position` 每次 `timeupdate` 都变（约 4 次/秒）、
 * `buffered` 每次 `progress` 都变。而 React 的 context 是**按引用**广播的，
 * 所以只要订阅了整表，这些消费者的重渲染频率就等于播放进度更新频率。
 * `AppContent` 是所有视图的父节点、`ExploreView` 下面有上百张卡片——它们跟着
 * 每秒重渲染 4 次，正是用户反馈「切换页面 / 进出播放器发涩」的直接来源。
 *
 * 这里只放低频字段：换剧/换集会变、开关抽屉与诊断会变，都发生在用户点击时。
 * 于是下面这些调用方从「每秒 4 次」降到「每次交互 1 次」，而播放器自身
 * （`VideoSurface` / `PlayerControls` / `AnimeVideoSurface`）继续用整表，行为不变。
 *
 * ⚠️ 不要往里加 `position` / `buffered` / `duration` / `uiState` / `prepareStatus`：
 * 它们会把这条专线的全部收益立刻抵消。
 */
type PlaybackActionsContextType = Omit<PlaybackContextType,
  | 'position' | 'duration' | 'buffered' | 'uiState' | 'prepareStatus'
  | 'isSwitching' | 'errorDetail' | 'stallNotice' | 'finishedAll' | 'videoRef' | 'sessionId'
>;

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
 * 取"可用于展示与落盘"的时长。
 *
 * `video.duration` 对分片 MP4 / 未知时长的源可能是 `Infinity` 或 `NaN`：
 * 前者会让进度条满格、百分比恒为 0，还会经 `Math.floor` 变成 `null`，
 * 导致整条历史记录被后端拒绝。这种情况下退一步用 `seekable` / `buffered`
 * 的末尾值——它们描述"已确定可用的时间轴终点"，是这类源最接近真实的时长。
 */
function usableDuration(video: HTMLVideoElement): number {
  const native = video.duration;
  if (Number.isFinite(native) && native > 0) return native;
  const ends: number[] = [];
  try {
    if (video.seekable && video.seekable.length > 0) {
      ends.push(video.seekable.end(video.seekable.length - 1));
    }
  } catch {
    // 尚未就绪的媒体元素访问 seekable 可能抛错：忽略，退回 buffered。
  }
  try {
    if (video.buffered && video.buffered.length > 0) {
      ends.push(video.buffered.end(video.buffered.length - 1));
    }
  } catch {
    // 同上。
  }
  const candidates = ends.filter(value => Number.isFinite(value) && value > 0);
  return candidates.length > 0 ? Math.max(...candidates) : 0;
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

/**
 * `play()` 的保底时限。
 *
 * `play()` 的 promise 有一种**永不落定**的挂法：源已经赋给 video 元素，却既不
 * 派发 `loadeddata` 也不派发 `error`（本地 asset 协议请求与探针并发读同一文件
 * 被顶住、远端连接吊死等），`play()` 就会一直 pending——上层 `openEpisode` 的
 * await 永不返回，界面永远停在旧帧/00:00:00，连错误卡都不出（实测：连播
 * 42 → 43 集时画面停死十分钟无任何进展、无任何报错）。装载链上其余每个等待
 * （preload 探针、firstFrame、webFirstFrame）都有超时兜底，唯独这最后一跳
 * 没有；超时后按 error 交给既有降级链（清缓存 → 重解析 → 公开直链兜底 →
 * 错误卡），把死局变成自愈。
 */
const PLAY_PENDING_TIMEOUT_MS = 8000;

// 导出给动漫链路复用：不变量 21 要求"起播必须有界"，而 useAnimePlayerStore 是
// 独立 store、不引用本文件的状态。这个函数是纯 DOM 工具（只碰传入的元素），
// 导出它不会把两条播放链路耦合起来。
export function playBounded(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      // 判死前再看一眼：play() 迟到但确实已经在播（慢盘/慢解码），按成功算，
      // 否则会把一段已经起来的播放重装载一遍。
      if (video.readyState >= 3 && !video.error) {
        resolve();
        return;
      }
      reject(new DOMException('play() 超时未落定（源无数据也无错误）', 'TimeoutError'));
    }, PLAY_PENDING_TIMEOUT_MS);
    video.play().then(
      () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ==================== 卡死看门狗（短剧链路） ====================

/**
 * 判定"播到一半卡死"的窗口。
 *
 * 为什么比动漫侧的 9 秒更宽：动漫侧的 `onStalled` 判的是"**从没解出过**一帧"
 * （HEVC 本机解不了，硬伤，重试无意义，所以判出来就直接判死），而这里要判的是
 * "播着播着解码线程不再吐帧"——真实内容里一次正常 seek、一次重新缓冲同样会让
 * 时钟停上几秒，窗口太窄会把这些正常现象当成卡死，白白触发一次重装载。
 */
const PLAYBACK_STALL_MS = 10000;

/** 第 1 级原地重试后，等这么久仍未见恢复就升级到"重装载当前这一集"。 */
const STALL_RETRY_SETTLE_MS = 2000;

/**
 * 重装载时回退的秒数。
 *
 * 卡死多半发生在某个 GOP 上，退一点落回上一个关键帧比原地再来一次更容易解开；
 * 代价只是几秒的重复播放，比整集卡死划算得多。
 */
const STALL_REWIND_SECONDS = 3;

/** 卡死提示文案。恢复成功 / 用户关闭 / 判死都会把它收回 null，不留死 UI。 */
const STALL_RETRY_NOTICE = '画面卡住了，正在尝试恢复…';

/**
 * 出帧停滞看门狗（短剧链路）。
 *
 * 判定："本该在播"（非 paused、非 seeking）却连续 `PLAYBACK_STALL_MS` 既没有
 * 时钟推进、也没有新的解码帧、**也没有新数据在进**。
 *
 * "数据在进"这一条是必须的：网络卡顿也会让时钟停住、画面冻在最后一帧，
 * 但缓冲期间 `progress` 持续推进 buffered 末端。少了它，一次 10 秒的慢网
 * 缓冲就会被当成解码卡死，白白触发一次 7 秒级的重装载。
 *
 * 反过来，解码线程卡死时 buffered 也不再增长——这才是真正无解的那种：
 * 既没有新数据，也没有新帧，`waiting` 还会照常派发且再也不回来。
 *
 * 为什么不能只看 `readyState`：解码线程卡死时它会长期停在 2（HAVE_CURRENT_DATA），
 * 而用户看到的现象"画面停住、进度条不动"与网络缓冲时完全一致——只有把
 * `paused` / `seeking` 排除掉之后，剩下的那个交集才是"本该在播却不播"。
 *
 * 与 `startAnimeFrameWatchdog` 的关键区别：那边是**分类器**（判出来直接判死，
 * 因为 HEVC 无画面重试也没用，所以它 `stop()` 自己）；这边是**自愈器**——判定成立
 * 先做一次原地重试（`onRetry`），一段时间内仍不见恢复才升级到既有兜底入口
 * 重装载当前这一集（`onEscalate`），再失败才停。因此本函数不会把自己停掉，
 * 一次卡死只报一次，恢复与否由调用方从 `onHealthy` 得到答复。
 *
 * 返回停止函数。**换源 / 出错 / 离开播放器 / 组件卸载都必须执行**，否则会留下
 * 孤儿定时器，在用户已经切走之后继续判定并拉起播放。
 */
function startDramaStallWatchdog(
  video: HTMLVideoElement,
  callbacks: {
    /** 第 1 级：原地重试（同一个时间点重拉数据）。 */
    onRetry: () => void;
    /** 第 2 级：重装载当前这一集。 */
    onEscalate: () => void;
    /** 画面重新推进了（恢复成功）：用来收回卡死提示。 */
    onHealthy: () => void;
  },
): () => void {
  const bufferedEnd = (): number => (video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0);
  let lastFrames = -1;
  let lastClock = video.currentTime;
  let lastBuffered = bufferedEnd();
  let lastAdvancedAt = performance.now();
  let escalateTimer: number | null = null;
  let stalled = false;
  let settled = false;

  const tick = () => {
    if (settled) return;
    const now = performance.now();
    const quality = video.getVideoPlaybackQuality?.();
    const frames = quality ? quality.totalVideoFrames : -1;
    const end = bufferedEnd();
    const clockMoved = video.currentTime > lastClock + 0.05;
    const framesMoved = frames >= 0 && lastFrames >= 0 && frames > lastFrames;
    const dataArrived = end > lastBuffered + 0.05;
    if (clockMoved || framesMoved || dataArrived) {
      lastClock = video.currentTime;
      lastFrames = frames;
      lastBuffered = end;
      lastAdvancedAt = now;
      if (escalateTimer !== null) {
        window.clearTimeout(escalateTimer);
        escalateTimer = null;
      }
      if (stalled) {
        stalled = false;
        callbacks.onHealthy();
      }
      return;
    }
    // 用户暂停、正在 seek、**已经播完**、以及本次恢复流程还没走完，都不是卡死。
    // 最后一条尤其重要：升级到重装载之后若不置位，会每 700ms 重复报一次。
    // `ended` 必须单列：规范上播到结尾后 `paused` 仍是 false，而"播完停在结尾"
    // 与"解码线程卡死"在时钟/帧/缓冲三个信号上完全一致——少了这条，每集播完
    // 10 秒后都会被误判成卡死，末帧被 seek 倒带闪回一次，再触发一次假重装载。
    if (video.paused || video.ended || video.seeking || stalled) return;
    if (now - lastAdvancedAt < PLAYBACK_STALL_MS) return;
    stalled = true;
    callbacks.onRetry();
    escalateTimer = window.setTimeout(() => {
      escalateTimer = null;
      callbacks.onEscalate();
    }, STALL_RETRY_SETTLE_MS);
  };

  const timer = window.setInterval(tick, 700);
  return () => {
    settled = true;
    window.clearInterval(timer);
    if (escalateTimer !== null) window.clearTimeout(escalateTimer);
    escalateTimer = null;
  };
}

// ==================== 弹幕（曾接入，0.2.x 整段移除） ====================

/**
 * 为什么这里没有弹幕层：红果走 TTV 自有链路，剧集 id 是裸 `series_id`、不带
 * `guo:` 前缀，而按集 id 关联的弹幕数据源只认带前缀的那一族 id，接不上。
 * 详见 CHANGELOG 的负面结论——别再接一遍。
 */

const PlaybackContext = createContext<PlaybackContextType | null>(null);

/** 低频动作专线。见 PlaybackActionsContextType 的说明。 */
const PlaybackActionsContext = createContext<PlaybackActionsContextType | null>(null);

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
  /**
   * 音量 / 静音 / 倍速的"最新值"镜像。
   *
   * 起播链路（adoptPreparedSource、兜底直链、公开直链兜底）是在**异步续体**里把
   * 这三个值写进媒体元素的，那时读到的 state 是发起这次起播时的那份快照。日常操作
   * 没有差别，但"从小窗回到播放器"是同一 tick 里先 setVolume/setMuted 再 openEpisode：
   * 读快照会把元素写回旧值，表现为"在小窗里静音了，回到播放器第一声却是外放的"。
   */
  const volumeRef = useRef(volume);
  const isMutedRef = useRef(isMuted);
  const playbackRateRef = useRef(playbackRate);
  // 真实清晰度档位：来自后端 variants，不再硬编码。空数组表示尚未探测，
  // 此时只显示"自动"，绝不虚构 4K/1080P 这类源里根本不存在的档位。
  const [availableQualities, setAvailableQualities] = useState<Array<{ label: string; value: string; resolution: string }>>([]);
  const [currentQuality, setCurrentQuality] = useState<string>('auto');
  const [isSideDrawerOpen, setIsSideDrawerOpen] = useState<boolean>(false);
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState<boolean>(false);
  const [prepareStatus, setPrepareStatus] = useState<PrepareStatus | null>(null);
  const [isSwitching, setIsSwitching] = useState<boolean>(false);
  // 悬停预热的在途计数，见 prewarmEpisode 的并发上限说明。
  const prewarmInflightRef = useRef<number>(0);
  /**
   * 首帧预解池：episodeCacheKey → 已解到 canplay 的探针。
   *
   * 为什么要这一层（预取只做到"文件就绪"是不够的）：
   * 预取链条的终点一直是 `resolvedFileByVidRef` 里存一个 **URL 字符串**，
   * 而首帧就绪（preloadSource → canplay）是在**用户切集那一刻**才做的。
   * 于是连播的时间轴是：ended → 快路径命中（URL 已在盘）→ preloadSource
   * (~150~400ms) → adoptPreparedSource 等 loadeddata (~100~200ms)。
   * 解析那 7.4s 早就被预取吃掉了，**剩下的缝就是这 200~600ms**——画面停在
   * 旧帧（不是黑屏），声音已断，用户感知是"顿一下"。
   *
   * 所以这里把"首帧预解"的产物也留下来：预取解析成功后顺手预解一次，
   * 切集时直接接管，整个 preloadSource 环节被跳过。
   *
   * 安全性：`preloadSource` 本来就造一个不挂进文档流的隐藏 video（避免
   * Layout/绘制开销），所以池里的探针**不产生额外合成层**；数量封顶 3，
   * 离 MicaCard 注释里记的"79 个 backdrop-filter 元素 → p95 164.8ms"差两个
   * 数量级。回收一律走 disposePrepared，否则解码器不释放。
   *
   * 边界：**只对本地整集文件 / 直链生效**。dmghg / 暴风是 m3u8，预解会把 MSE
   * 实例建起来，主播放器接管时反而要重建，那条链路继续靠 prefetchStream。
   */
  const preparedPoolRef = useRef<Map<string, PreparedSource>>(new Map());
  /** 池命中 / 池查询次数——没有这个指标就不知道预留窗口够不够长。 */
  const preparedPoolStatRef = useRef<{ hit: number; miss: number }>({ hit: 0, miss: 0 });
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
  // 在途本地解析所属的会话号。用于判断"这个在途任务还是不是本次会话的"——
  // 只看 ref 是否为 null 会误复用上一会话的任务，拿到 'stale' 后既不播放
  // 也不报错，界面就永远停在转圈。
  const nativeResolveSessionRef = useRef<number>(0);
  /**
   * 当前画面是不是"前缀片段"（而不是完整文件）。
   *
   * 前缀只含开头一小段，播到它的末尾会派发一次 `ended`——而这一集其实远没
   * 播完。`handleEnded` 必须能分辨"真播完"与"前缀播到头"，否则会把用户半路
   * 甩进下一集，甚至把这一集记成"已看完"。谁把源换成了完整文件，就由谁清掉
   * 这个标记（切整集成功、整集链路起播成功）。
   */
  const prefixSourceRef = useRef<{ episodeId: string; sessionId: number } | null>(null);
  /**
   * 是否正在把新源接管到主播放器（`adoptPreparedSource` / `playDirect`）。
   *
   * 这期间主 <video> 派发的任何 `error` 都属于**本次接管的内部事务**：
   * 接管流程自己会重试（`playDirect`）或自己判死。
   * `handleError` 必须让路——否则它会在重试成功之前抢先弹出错误页，
   * 结果是"视频其实已经播起来了，界面却停在错误页"。
   */
  const adoptingRef = useRef<boolean>(false);
  // 供"只绑定一次"的事件监听器间接调用的稳定引用。
  const playNextEpisodeRef = useRef<() => void>(() => {});
  const openEpisodeRef = useRef<
    (seriesId: string, episodeId?: string, startPosition?: number, qualityOverride?: string) => Promise<void>
  >(() => Promise.resolve());
  const saveProgressThrottledRef = useRef<(pos: number, dur: number, force?: boolean) => void>(() => {});

  const [stallNotice, setStallNotice] = useState<string | null>(null);

  /**
   * 全剧播完信号：连播开启时最后一集正常 ended。
   *
   * 常驻 `<video>` 没有"剧集播完"的呈现，停在 ended 上就是一块黑屏——所以由
   * 宿主（VideoSurface）读到它后返回详情页。判定放在 store 里是因为只有这里
   * 拿得到完整的闸门（autoNext、连播闩锁、迟到事件过滤，见 handleEnded）；
   * 组件层自己看 `uiState === 'ended'` 判断会把交接期的旧源 ended 误判进来。
   * 任何用户接管（seek / 重新开播 / 换集 / 离开播放器）都必须把它复位，
   * 否则 2 秒后的返回会在用户已经另有安排时突然发生。
   */
  const [finishedAll, setFinishedAll] = useState<boolean>(false);
  // 最后一集的 ended 事件在部分 WebView2 版本会重复派发一次。
  // 记住已经处理过的末集，避免第二次事件把末集重新装载或再次触发收尾。
  const finishedAllEpisodeRef = useRef<string | null>(null);

  /**
   * 卡死看门狗的停止函数。
   *
   * 换源、进入缓冲、error、离开播放器、组件卸载都要调它：看门狗的续体会重起播
   * 甚至重装载整集，孤儿定时器等于"人已退出却仍被后台拉起播放"——与
   * "离开播放器必须 stopPlayback" 是同一类事故。
   */
  const stallWatchdogStopRef = useRef<(() => void) | null>(null);
  const stopStallWatchdog = useCallback(() => {
    if (stallWatchdogStopRef.current) {
      stallWatchdogStopRef.current();
      stallWatchdogStopRef.current = null;
    }
  }, []);
  /**
   * 已经为"卡死自动重装载"花掉机会的集。
   *
   * 每集只给一次：重装载本身是 7 秒级的重活，若不给上限，一集反复卡死就会
   * 变成"卡死 → 重装载 → 再卡死"的循环。
   */
  const stallRecoveredRef = useRef<Set<string>>(new Set());
  /** 本次 `openEpisode` 由看门狗发起（用户手动切集要清空重装载额度，它不能）。 */
  const stallReloadingRef = useRef<boolean>(false);

  /** 用户手动关掉卡死提示。 */
  const dismissStallNotice = useCallback(() => setStallNotice(null), []);

  /**
   * 主播放器里**实际装载的是哪一集**（连同装载它时的会话号与时刻）。
   *
   * 自动跳集必须以"画面里正在放的这一集"为准，而不是 React 状态。两者的推进
   * 时机不同：切换第 N+1 集时状态立刻变成 N+1，而画面里还在放第 N 集（新源要
   * 解析/下载几秒才接管）。这段窗口里如果又收到一次针对第 N 集的触发
   * （`ended` 迟到、旧倒计时到点），按状态算出来的"下一集"就是 N+2——
   * 用户看到的就是"有时候一次跳好几集"。
   *
   * `at` 是"源落到 video 元素上的时刻"，用于判断这次触发是否来得太早（见
   * `tryClaimAutoAdvance`）：刚装载的源不可能已经播到结尾。
   */
  const videoCommittedRef = useRef<{ episodeId: string; sessionId: number; at: number } | null>(null);
  /**
   * 自动跳集的去重闩锁，键为 `${sessionId}:${episodeId}`。
   *
   * `ended` 与连播倒计时是两条独立链路，都可能要求"放下一集"，而且可能先后都到
   * （倒计时先跳、旧源的 `ended` 迟到）。闩锁保证同一次装载只被消费一次；
   * 键里带会话号，所以用户"重新打开同一集再看一遍"仍能正常连播。
   */
  const autoAdvanceLatchRef = useRef<string>('');

  /**
   * 源装载后多久才允许自动跳集。
   *
   * 装载瞬间到下一次 loadeddata 之间，媒体元素上的 `duration` / `currentTime`
   * 仍是**上一集**的残留值（接管刻意不调 video.load()，见 adoptPreparedSource）。
   * 实测：3 连发 `ended` 时，按下"刚装载就跳"的实现会从第 3 集一路跳到第 5 集。
   * 真实内容不可能在 2 秒内播完，因此这段时间内的自动跳集触发一律作废。
   */
  const AUTO_ADVANCE_SETTLE_MS = 2000;

  /**
   * 记录"这一刻起，video 元素装载的源属于哪一集"。
   * 所有给 video 赋 src 的落点都必须调用它（含兜底与 Blob 分支）。
   */
  const markSourceCommitted = (sessionId: number, episodeId: string) => {
    videoCommittedRef.current = { episodeId, sessionId, at: Date.now() };
  };

  /**
   * 申请"从 `fromEpisodeId` 自动往后跳一集"的资格；返回 false 表示这次触发已过期。
   *
   * 四重把关，任一不满足即拒绝——这是"连跳多集"的根治点：
   *   1. 画面里装的必须就是 `fromEpisodeId`（不是它说明触发属于上一集）；
   *   2. 期间不能有更新的切换在途（装载时的会话号必须仍是当前会话）；
   *   3. 源装载后要经过"结算期"，否则这次触发还是旧源残留的事件；
   *   4. 同一次装载还没被自动跳过（闩锁）。
   */
  const tryClaimAutoAdvance = (fromEpisodeId: string): boolean => {
    const committed = videoCommittedRef.current;
    if (!committed || committed.episodeId !== fromEpisodeId) return false;
    if (committed.sessionId !== activeSessionRef.current) return false;
    if (Date.now() - committed.at < AUTO_ADVANCE_SETTLE_MS) return false;
    const latchKey = `${committed.sessionId}:${fromEpisodeId}`;
    if (autoAdvanceLatchRef.current === latchKey) return false;
    autoAdvanceLatchRef.current = latchKey;
    return true;
  };

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
   * 预解一集并放进池（LRU 淘汰）。解析成功后由预取链路调用。
   *
   * 入池前先做 LRU 淘汰：Map 保持插入序，删第一个键就是最久未用的。
   * 淘汰必须 disposePrepared——只删不释放的话，解码器会一直挂在那些
   * 脱离文档流的 video 上，直到 WebView 回收，实测能把内存推到 GB 级。
   */
  const pushPreparedPool = async (key: string, assetUrl: string): Promise<void> => {
    if (preparedPoolRef.current.has(key)) return;
    const existing = preparedPoolRef.current;
    while (existing.size >= PREPARED_POOL_MAX) {
      const oldest = existing.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const evicted = existing.get(oldest);
      existing.delete(oldest);
      disposePrepared(evicted ?? null);
    }
    const probe = await preloadSource(assetUrl, 0, 8000);
    if (!probe) return;
    // 预解期间用户可能已经切走/换剧，那一轮的池早被清空了，别再塞回去。
    const prepared: PreparedSource = { url: assetUrl, element: probe };
    existing.set(key, prepared);
  };

  /** 清空池并释放全部探针。换剧、退出播放器、会话失效时调用。 */
  const drainPreparedPool = (): void => {
    preparedPoolRef.current.forEach(disposePrepared);
    preparedPoolRef.current.clear();
  };

  /**
   * 取池里的预解结果。
   *
   * **只在 startPosition === 0 时命中**：池里的探针是按"从头播"预解的，
   * 带历史进度重入时 currentTime 对不上，硬用会跳帧——那种情况老老实实走
   * preloadSource 重新定位。连播与新集前进都是 startPosition=0，
   * 正好覆盖主场景。
   *
   * 取出即从池里删除：同一集的探针只能被接管一次，
   * 留着会被下一轮 LRU 重复命中成"已用过"的对象。
   */
  const takePreparedPool = (key: string, startPosition: number): PreparedSource | null => {
    if (startPosition > 0) {
      preparedPoolStatRef.current.miss += 1;
      return null;
    }
    const pooled = preparedPoolRef.current.get(key);
    if (!pooled) {
      preparedPoolStatRef.current.miss += 1;
      return null;
    }
    preparedPoolRef.current.delete(key);
    preparedPoolStatRef.current.hit += 1;
    const s = preparedPoolStatRef.current;
    console.debug(
      `[ttv] 首帧预解命中 ${key}（池剩 ${preparedPoolRef.current.size}/${PREPARED_POOL_MAX}，` +
      `命中 ${s.hit} / 未命中 ${s.miss}）`,
    );
    return pooled;
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
      // 必须走有界版本：这条 await 是"打开并播放"链路的最后一跳，此前每个
      // 等待都有超时，唯独它挂死时整条链路（含错误卡）就再也走不到了。
      await playBounded(video);
      return 'ok';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        // 静音还有救：再试一次。注意判断必须基于"是否还能静音"，
        // 而不是"当前是否已静音"——若视频本来就是静音的（比如上一次自动播放
        // 被拦后被我们静音过），再判断 !video.muted 就会漏判，
        // 把"源是好的、只差用户手势"误报成 error，进而触发删缓存 + 整集重解析。
        if (!video.muted) {
          video.muted = true;
          setIsMuted(true);
          // 镜像同步：这条兜底路径绕过 setMuted，起播链路读的是 ref。
          isMutedRef.current = true;
          try {
            await video.play();
            return 'ok';
          } catch { /* 落到下面的 autoplay-blocked */ }
        }
        noteFailure('自动播放被拒绝（需用户手势）', error);
        return 'autoplay-blocked';
      }
      noteFailure('起播失败', error);
      return 'error';
    }
  };
  /**
   * 会话已作废（用户离开播放器 / 已有更新的切换接管）时立即暂停。
   * 返回 true 表示已 stale。背景：播放器宿主常驻 DOM，离开页面只是隐藏；
   * 异步起播链（首帧等待、play() 本身）可能在最后一次守卫检查之后才 resolve，
   * 不在这里补暂停，就会出现"人已退出、声音照放"。
   */
  const pauseIfStale = (sessionId: number, video: HTMLVideoElement): boolean => {
    if (activeSessionRef.current === sessionId) return false;
    if (!video.paused) video.pause();
    return true;
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
    episodeId: string,
  ): Promise<PlayOutcome> => {
    adoptingRef.current = true;
    try {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = '';
      }
      video.dataset.sessionId = String(sessionId);
      video.playbackRate = playbackRateRef.current;
      video.volume = isMutedRef.current ? 0 : volumeRef.current;
      video.muted = isMutedRef.current;

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
      detachSource(video);
      video.src = prepared.url;
      // 从这一刻起，画面属于这一集——自动跳集只认这个事实来源。
      markSourceCommitted(sessionId, episodeId);
      await firstFrameReady;

      // 已被更新的切换接管：不是失败，别让调用方降级。
      if (activeSessionRef.current !== sessionId) return 'stale';
      // 解码层明确报错：不浪费一次 play()，直接交给调用方重试/换源。
      if (video.error) {
        noteFailure('解码失败', video.error);
        return 'error';
      }
      // 换源后再次写入用户倍速：媒体装载期间可能把 playbackRate 恢复成默认值，
      // 而这一行必须放在新源就绪之后，才能保证下一集仍按用户选择的速度播放。
      video.playbackRate = playbackRateRef.current;

      if (startPosition > 0) {
        try {
          video.currentTime = startPosition;
        } catch {
          // metadata 未就绪则从 0 播
        }
      }
      const started = await startPlayback(video);
      if (started !== 'ok') return started;
      if (pauseIfStale(sessionId, video)) return 'stale';
      setIsPlaying(true);
      setUiState({ kind: 'playing', sessionId, position: video.currentTime });
      return 'ok';
    } catch (error) {
      noteFailure('接管新源异常', error);
      return 'error';
    } finally {
      adoptingRef.current = false;
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
    episodeId: string,
  ): Promise<PlayOutcome> => {
    adoptingRef.current = true;
    try {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = '';
      }
      video.dataset.sessionId = String(sessionId);
      video.playbackRate = playbackRateRef.current;
      video.volume = isMutedRef.current ? 0 : volumeRef.current;
      video.muted = isMutedRef.current;

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
      detachSource(video);
      video.src = assetUrl;
      markSourceCommitted(sessionId, episodeId);
      video.load();
      await ready;

      if (activeSessionRef.current !== sessionId) return 'stale';
      if (video.error) {
        noteFailure('直接播放解码失败', video.error);
        return 'error';
      }
      // 同上：`src`/`load()` 之后再恢复倍速，避免换集后回到 1x。
      video.playbackRate = playbackRateRef.current;
      if (startPosition > 0) {
        try {
          video.currentTime = startPosition;
        } catch {
          // metadata 未就绪则从 0 播
        }
      }
      const started = await startPlayback(video);
      if (started !== 'ok') return started;
      if (pauseIfStale(sessionId, video)) return 'stale';
      setIsPlaying(true);
      setUiState({ kind: 'playing', sessionId, position: video.currentTime });
      return 'ok';
    } catch (error) {
      noteFailure('直接播放异常', error);
      return 'error';
    } finally {
      adoptingRef.current = false;
    }
  };

  /**
   * 播放**本地 HLS**（流式转码产物）——「先出画面」链路的落点。
   *
   * 与 `playLocalFile` 的区别只有一个但很关键：源是 `http://127.0.0.1` 上的 m3u8，
   * 必须走 hls.js（`attachSource` 内部判断），不能 convertFileSrc——把 m3u8 当文件
   * 路径处理会得到一个必然 404 的 asset:// 地址，表现是「地址没问题、播放器全黑」。
   *
   * 首帧等待给了 15 秒而不是常规的 8–10 秒：这条链路的分片是**边转边生成**的，
   * 播放器很可能先拿到清单、再等首个分片写完（实测 ffmpeg 侧首片 1.1 秒，但加上
   * 网络往返与 hls.js 自身的重试节奏会更宽）。`hlsAttach` 已配好
   * `manifestLoadingMaxRetry=4` / `fragLoadingMaxRetry=8` / `fragLoadingRetryDelay=500`，
   * 这里给足预算，别在播放器还在正常重试时判死。
   */
  const playStreamingHls = async (
    hlsUrl: string,
    video: HTMLVideoElement,
    sessionId: number,
    startPosition: number,
    episodeId: string,
  ): Promise<PlayOutcome> => {
    adoptingRef.current = true;
    try {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = '';
      }
      video.dataset.sessionId = String(sessionId);
      video.playbackRate = playbackRateRef.current;
      video.volume = isMutedRef.current ? 0 : volumeRef.current;
      video.muted = isMutedRef.current;

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
        const timer = setTimeout(done, 15000);
        video.addEventListener('loadeddata', done, { once: true });
        video.addEventListener('error', done, { once: true });
      });
      // attachSource 内部会先 detachSource，并把 hls.js 实例挂在 video 上，
      // 换集/退出时由 detachSource 统一拆掉——不需要在这里手动管生命周期。
      await attachSource(video, hlsUrl);
      markSourceCommitted(sessionId, episodeId);
      await firstFrameReady;
      if (activeSessionRef.current !== sessionId) return 'stale';
      if (video.error) {
        noteFailure('流式 HLS 解码失败', video.error);
        return 'error';
      }
      video.playbackRate = playbackRateRef.current;
      if (startPosition > 0) {
        try {
          video.currentTime = startPosition;
        } catch {
          // metadata 未就绪则从 0 播。
        }
      }
      const started = await startPlayback(video);
      if (started !== 'ok') return started;
      if (pauseIfStale(sessionId, video)) return 'stale';
      setIsPlaying(true);
      setUiState({ kind: 'playing', sessionId, position: video.currentTime });
      return 'ok';
    } catch (error) {
      noteFailure('流式 HLS 挂载异常', error);
      return 'error';
    } finally {
      adoptingRef.current = false;
    }
  };

  /**
   * 红果起播：**前缀先行，整集后到替身**。
   *
   * 用户点上"播放"之后，等待全部发生在"整集下载+解密+转存"这一个 await 里
   * （实测 6.1–11.2 秒），而 resolve 返回后到首帧只要毫秒级。所以把这一件事拆成
   * 两条并发链路：前缀（开头一小段）先出画，整集在后台照常下，落盘后把同一块
   * <video> 悄悄换到完整文件上。
   *
   * 三条硬性前提：
   *   1. **不能多等**。整集请求与原来完全一样（同样的缓存登记、同样的失败语义），
   *      整集先到就用整集，前缀只是"先到先得"的另一档，绝不叠加延迟。
   *   2. **不能黑屏、不能弹错**。前缀没来 / 播不起来 / 切源失败，一律静默退回原
   *      链路；切换走 `adoptPreparedSource`（不调 `load()`，旧帧保留到新源就绪）。
   *   3. **不能换会话**。全程同一个 sessionId、同一个 episodeId，`markSourceCommitted`
   *      与 `pauseIfStale` 的语义原样复用，自动跳集四重闸门不受影响。
   */
  const playNativeResolvedFile = async (
    seriesId: string,
    episodeId: string,
    quality: string,
    contentType: number,
    video: HTMLVideoElement,
    sessionId: number,
    startPosition = 0,
  ): Promise<PlayOutcome> => {
    const cacheKey = episodeCacheKey(seriesId, episodeId, quality);

    /**
     * 整集链路本体（即改造前的全部行为），只在"必须等完整文件"时才走：
     * 前缀被跳过 / 前缀没命中 / 前缀播不起来 / 起播那一刻整集已经落盘。
     * 复用同一个 `fullPromise`，所以无论走到这里几次，整集都只下载一次。
     */
    const runFull = async (): Promise<PlayOutcome> => {
      try {
        const resolved = await fullPromise;
        if (activeSessionRef.current !== sessionId) return `stale`;
        const outcome = await playLocalFile(resolved.playUrl, video, sessionId, startPosition, episodeId, seriesId);
        // 画面已经换成完整文件：前缀标记必须撤掉，否则这一集真播完时会被当成
        // "前缀播到头"再重载一次。
        if (outcome === `ok` && prefixSourceRef.current?.episodeId === episodeId) {
          prefixSourceRef.current = null;
        }
        // 只有"源本身有问题"才撤掉登记。自动播放被拦（autoplay-blocked）时
        // 文件是完好的，撤掉会导致下次重下一整集——白等 7 秒。
        if (outcome === `error` && activeSessionRef.current === sessionId) {
          resolvedFileByVidRef.current.delete(cacheKey);
        }
        return outcome;
      } catch (error) {
        noteFailure(`本地解析失败 ${seriesId}/${episodeId}`, error);
        return `error`;
      }
    };
    // 走原来的整集链路，并把它在途的 promise 记回 ref 上——`handleError` 的
    // "本地解析在途就别弹错误页"闸门读的正是这个 ref，前缀先行不能让这道闸门
    // 失效（整集没落盘之前，任何源错误都还该被兜住）。
    const startFull = (): Promise<PlayOutcome> => {
      const attempt = runFull();
      nativeResolveInFlightRef.current = attempt;
      nativeResolveSessionRef.current = sessionId;
      return attempt.finally(() => {
        if (nativeResolveInFlightRef.current === attempt) nativeResolveInFlightRef.current = null;
      });
    };

    // 整集链路**先发车、先不 await**：Rust 侧两条链路是并发 worker（在途去重键
    // 带 `:prefix` 后缀），谁先落盘谁先被用上。这里的 promise 是"最终一定会拿到
    // 的完整文件"，也是唯一会写进 resolvedFileByVidRef 的东西——前缀路径永远不
    // 登记，否则下次换集会命中一个只剩开头十几秒的短命文件。
    const fullPromise = ipcService.playback.resolveNative(seriesId, episodeId, contentType, quality)
      .then(resolved => {
        // 解析成功立刻登记本地文件路径：换集/切清晰度第二次进入同一集时秒开。
        if (resolved.cached || resolved.sizeBytes > 0) {
          resolvedFileByVidRef.current.set(cacheKey, resolved.playUrl);
        }
        return resolved;
      });
    // 前缀路径可能在拿到整集之前就返回（stale / 失败回退）：那之后没人 await
  
    // fullPromise 在极端情况下（会话早已切换）没人 await，必须自己挂一个
    // no-op 捕获，否则会冒出 unhandled rejection。
    void fullPromise.catch(() => {});
    // 续播时，前缀文件几乎立刻播到头，反而会先触发一次 ended —— 对"继续观看"
    // 这条路径，老老实实等整集才是对的。
    if (startPosition > PREFIX_COVERAGE_SECONDS) {
      tracePlayback(`前缀起播 跳过（续播位置 ${startPosition.toFixed(1)}s 超出前缀覆盖范围）`);
      return startFull();
    }

    // ===== 「先出画面」主路径：流式 HLS =====

    //
    // 这是用户明确要的"先把视频画面出来、播放的同时再加载"。实测对比：
    //   流式 HLS   首片 1005–1126ms 落地（含 API 往返总首屏 3.1–3.5 秒）
    //   前缀 mp4   整段 6219–7174ms（要先下载 2MB + 解密转码 + 落盘）
    //   整集 mp4   6600–22320ms
    //
    // 它失败不是错误——整集链路早就在跑了，回退到前缀/整集即可。
    // 注意它必须排在**前缀之前**：前缀要等下载完一段才能出画，而流式是边转边出。
    const streamingStarted = performance.now();
    const streaming = await ipcService.playback
      .openStreamNative(seriesId, episodeId, sessionId, contentType)
      .catch((error: unknown) => {
        tracePlayback(`流式开播 未命中（回退前缀/整集） ${describeError(error)}`);
        return null;
      });
    if (activeSessionRef.current !== sessionId) return `stale`;
    if (streaming && streaming.cached !== true && streaming.streamKind === 'hls') {
      const streamingOutcome = await playStreamingHls(
        streaming.playUrl, video, sessionId, startPosition, episodeId,
      );
      if (streamingOutcome === `stale`) return `stale`;
      if (streamingOutcome === `ok`) {
        tracePlayback(`流式开播 出画 耗时=${Math.round(performance.now() - streamingStarted)}ms（整集仍在后台下载）`);
        // 与前缀同款标记：画面还挂在「非整集」源上，这一集播到头时不能算看完。
        prefixSourceRef.current = { episodeId, sessionId };
        // 后台等整集落盘切源（与下面前缀分支完全同一段逻辑，抽不抽都行——
        // 但这里刻意**不抽**：抽成函数会让这段的会话复查与 ref 清理多一层间接，
        // 而它恰恰是最需要一眼看清的地方）。
        void (async () => {
          try {
            const resolved = await fullPromise;
            if (activeSessionRef.current !== sessionId) return;
            if (!resolved.playUrl || resolved.playUrl === streaming.playUrl) return;
            const { convertFileSrc } = await import(`@tauri-apps/api/core`);
            const assetUrl = convertFileSrc(resolved.playUrl);
            const probe = await preloadSource(assetUrl, 0, 8000);
            if (!probe) return;
            if (activeSessionRef.current !== sessionId) {
              disposePrepared({ url: assetUrl, element: probe });
              return;
            }
            const resumeAt = Number.isFinite(video.currentTime) ? video.currentTime : 0;
            const switchedAt = performance.now();
            const outcome = await adoptPreparedSource(
              { url: assetUrl, element: probe }, video, sessionId, resumeAt, episodeId,
            );
            disposePrepared({ url: assetUrl, element: probe });
            if (outcome !== `ok`) {
              tracePlayback(`整集切换未完成（outcome=${outcome}，继续播流式源）`);
              return;
            }
            prefixSourceRef.current = null;
            tracePlayback(`整集切换完成 耗时=${Math.round(performance.now() - switchedAt)}ms 位置=${resumeAt.toFixed(1)}s 字节=${(resolved.sizeBytes / 1048576).toFixed(1)}MB`);
          } catch (error) {
            tracePlayback(`整集切换异常（继续播流式源） ${describeError(error)}`);
          }
        })();
        return `ok`;
      }
      // 流式播不起来：不弹错误页，继续走前缀/整集。
      tracePlayback(`流式开播 失败（outcome=${streamingOutcome}，回退前缀）`);
    }

    // 前缀失败不是错误，只是没享受到加速：整集链路早就在跑，继续等它就行。
    const prefixStarted = performance.now();
    const prefix = await ipcService.playback
      .resolveNativePrefix(seriesId, episodeId, contentType, quality)
      .catch((error: unknown) => {
        tracePlayback(`前缀起播 未命中（继续等整集） ${describeError(error)}`);
        return null;
      });
    if (!prefix) return startFull();
    // 整集已在盘上时后端直接把整集当"前缀"还回来：没有第二条链路要等。
    if (prefix.cached === true) return startFull();
    if (activeSessionRef.current !== sessionId) return `stale`;

    const prefixOutcome = await playLocalFile(prefix.playUrl, video, sessionId, startPosition, episodeId, seriesId);
    if (prefixOutcome === `stale`) return `stale`;
    if (prefixOutcome !== `ok`) {
      // 前缀播不起来（片段解码失败、自动播放被拦）：**不弹错误页**，把结果交给
      // 整集链路重新决定。此时整集多半已经在路上，不会比原实现更慢。
      tracePlayback(`前缀起播 失败（outcome=${prefixOutcome}，回退整集）`);
      return startFull();
    }
    prefixSourceRef.current = { episodeId, sessionId };
    tracePlayback(`前缀起播 耗时=${Math.round(performance.now() - prefixStarted)}ms 字节=${(prefix.sizeBytes / 1048576).toFixed(1)}MB（整集仍在后台下载）`);

    // 画面已经在前缀上了：后台等整集，落盘后把同一会话、同一 <video> 切到完整
    // 文件。这段刻意 fire-and-forget —— 上层的 isSettled / 预取落点不该为一个
    // "锦上添花"的切源多等 7 秒，而切源本身自带完整的失败退让。
    void (async () => {
      try {
        const resolved = await fullPromise;
        if (activeSessionRef.current !== sessionId) return;
        if (!resolved.playUrl || resolved.playUrl === prefix.playUrl) return;
        const { convertFileSrc } = await import(`@tauri-apps/api/core`);
        const assetUrl = convertFileSrc(resolved.playUrl);
        // 先让隐藏探针把整集解到可播，再交给 adoptPreparedSource：不调 load()、
        // 旧帧一直保留到新源 loadeddata —— 这是"切源不黑屏"的全部依据。
        const probe = await preloadSource(assetUrl, 0, 8000);
        if (!probe) return;
        if (activeSessionRef.current !== sessionId) {
          disposePrepared({ url: assetUrl, element: probe });
          return;
        }
        // 从前缀当前播放位置续上：两个文件同一源同一编码，直接按秒对齐即可。
        const resumeAt = Number.isFinite(video.currentTime) ? video.currentTime : 0;
        const switchedAt = performance.now();
        const outcome = await adoptPreparedSource(
          { url: assetUrl, element: probe }, video, sessionId, resumeAt, episodeId,
        );
        disposePrepared({ url: assetUrl, element: probe });
        if (outcome !== `ok`) {
          // 切不过去就继续播前缀：用户已经看了十几秒画面，不该因为这次替换
          // 失败而弹错或变黑。下次换集/重开会命中整集缓存，问题自然消失。
          tracePlayback(`整集切换未完成（outcome=${outcome}，继续播前缀）`);
          return;
        }
        prefixSourceRef.current = null;
        tracePlayback(`整集切换完成 耗时=${Math.round(performance.now() - switchedAt)}ms 位置=${resumeAt.toFixed(1)}s 字节=${(resolved.sizeBytes / 1048576).toFixed(1)}MB`);
      } catch (error) {
        tracePlayback(`整集切换异常（继续播前缀） ${describeError(error)}`);
      }
    })();
    return `ok`;
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
    nativeResolveSessionRef.current = sessionId;
    return attempt;
  };

  /**
   * 取"属于当前会话"的在途本地解析；没有则 null。
   *
   * 直接读 `nativeResolveInFlightRef` 有个坑：它可能挂着**上一会话**的任务。
   * 复用它只会拿到 'stale'——既不起播也不报错，界面永久转圈。
   */
  const currentSessionResolve = (): Promise<PlayOutcome> | null => (
    nativeResolveInFlightRef.current && nativeResolveSessionRef.current === activeSessionRef.current
      ? nativeResolveInFlightRef.current
      : null
  );

  // 已预取/已解析成功的集（seriesId:episodeId → playUrl）。命中则换集秒开，
  // 跳过注定被 CDN 防盗链拦截的公开直链链路（直链→备用→Blob 三连失败）。
  const resolvedFileByVidRef = useRef<Map<string, string>>(new Map());

  // guo 连播预取（seriesId:episodeId → 该集 playback.open 的完整会话，或
  // '__prefetching__' 占位）。guo 的 open 产物是 guo-core 本地媒体服务的
  // URL + streamKind，与红果的本地文件路径语义不同、装载方式也不同，所以
  // 单独一张表，不复用 resolvedFileByVidRef。
  const resolvedGuoSessionRef = useRef<Map<string, PlaybackSession | '__prefetching__'>>(new Map());
  // 预取专用会话号：绝不能走 activeSessionRef（推进它 = 当前播放立即 stale）。
  // 基数压过主会话（100 起、几百量级）；Rust 侧的会话表随真实播放的 retain
  // 滚动清理，前端装载只靠 URL，不依赖这些表。
  const guoPrefetchSessionRef = useRef(1_000_000);

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
  // 动漫档位探测的"已探过"键（`seriesId::episodeId`）。与短剧的 probedVidsRef
  // 分开：那条记的是红果 vid，这里是动漫集 id，混用会互相顶掉。
  const animeProbedRef = useRef<string>('');
  // guo 外部站源档位探测的"已探过"键（`seriesId::episodeId`）。与动漫那条分开，
  // 避免两个链路来回顶掉、重复付 resolve 的网络成本。
  const guoProbedRef = useRef<string>('');
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
          // 必须是 worker / Rust 认得的档位字面量（`{digits}p`）。此前这里硬编码
          // 'auto'，于是每个选项都等价于"自动"：点击后 setQuality('auto') 与
          // currentQuality 相等，在守卫处直接 return——画质这条轴整条是死的
          // （菜单能开、能显示真实档位，但点了没有任何效果）。
          value: `${item.height}p`,
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
    const key = episodeCacheKey(seriesId, episodeId, 'auto');
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
      .then(async resolved => {
        clearTimeout(guard);
        if (!resolved.playUrl) {
          resolvedFileByVidRef.current.delete(key);
          return;
        }
        resolvedFileByVidRef.current.set(key, resolved.playUrl);
        // 解析成功只是"文件在盘上"，首帧还没解。顺手再预解一次并入池，
        // 切集时就能整段跳过 preloadSource（那 200~600ms 的缝就在这里）。
        // 失败静默：预解只是加速手段，拿不到就退回原来的慢路径。
        try {
          const { convertFileSrc } = await import('@tauri-apps/api/core');
          await pushPreparedPool(key, convertFileSrc(resolved.playUrl));
        } catch {
          // 忽略：预解失败不影响解析成果
        }
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
    if (series.id.startsWith('guo:')) return;
    const idx = series.episodes.findIndex(e => e.id === currentEpisodeId);
    if (idx < 0) return;
    const contentType = series.type === 'comic' ? 1004 : 1;
    // 每次重新排队前先清空旧队列：换了剧或换了集之后，之前的预测已经过时。
    prefetchQueueRef.current = [];
    // 旧队列对应的首帧预解也随之作废——那些集已经不是"接下来要播的"了。
    // 必须连同 dispose 一起清，只清 Map 不释放会让解码器挂在脱离文档流的
    // video 上直到 WebView 回收。
    drainPreparedPool();
    // 下三集优先（连播与随手点开的主要目标），上一集兜底"回看"。
    const next = series.episodes.slice(idx + 1, idx + 4);
    const prev = series.episodes[idx - 1] ? [series.episodes[idx - 1]] : [];
    const targets = [...next, ...prev];
    // 先把整个序列一次性登记为"在途"，避免队列还没轮到某一集时，
    // 悬停预热又对同一集发起第二次解析（后端虽有 leader/follower 去重，
    // 但前端这一层多打一次请求同样浪费）。
    targets.forEach(target => {
      const key = episodeCacheKey(series.id, target.id, 'auto');
      if (!resolvedFileByVidRef.current.has(key)) {
        prefetchQueueRef.current.push({
          seriesId: series.id,
          episodeId: target.id,
          contentType,
        });
      }
    });
    // 交给泵消费。泵会在消费过程中校验会话，用户切走后立即停止。
    // 首拍延迟 800ms：换集瞬间前台解析正要拉起 worker，预取同时入队会让
    // 两者抢锁串行（worker 单实例），前台那一集白等一拍。让前台先跑。
    setTimeout(() => pumpPrefetchQueueForSession(sessionAtRequest), 800);
  };

  /**
   * guo 连播预取：本集起播稳定后，后台把下一集的 playback.open 做掉。
   *
   * guo 不走红果预取队列（上面那张表存的是本地文件路径，走 startNativeResolve；
   * guo 的产物是 guo-core 本地媒体服务 URL，走 playback.open），此前连播每一集
   * 都要播完才现场 resolve（实测 0.6~5.8s，用户感知就是"播完才开始加载"）。
   * 现在命中预取的集由 openEpisode 的快路径直接装载，resolve 等待消失。
   *
   * 预取失败静默清占位，前台自然重试完整链路。预取会推进 guo-core 的解析高
   * 水位并 cancel 上一个在途 resolve——对**正在播**的集无影响（它的 resolve 早已
   * 完成，媒体服务流与会话独立存在；画质探测在播放中调 resolve 是既有实证）。
   */
  const prefetchGuoNext = useCallback((series: SeriesDetail, episodeId: string, quality: string) => {
    if (!series.id.startsWith('guo:')) return;
    const idx = series.episodes.findIndex(e => e.id === episodeId);
    const next = series.episodes[idx + 1];
    if (!next) return;
    const key = episodeCacheKey(series.id, next.id, quality);
    if (resolvedGuoSessionRef.current.has(key)) return;
    if (resolvedGuoSessionRef.current.size > 16) resolvedGuoSessionRef.current.clear();
    resolvedGuoSessionRef.current.set(key, '__prefetching__');
    const sessionId = (guoPrefetchSessionRef.current += 1);
    void ipcService.playback.open(series.id, next.id, quality, 0, sessionId, true)
      .then(session => {
        if (resolvedGuoSessionRef.current.get(key) === '__prefetching__') {
          resolvedGuoSessionRef.current.set(key, session);
        }
      })
      .catch(() => {
        resolvedGuoSessionRef.current.delete(key);
      });
  }, []);

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
      // 前台正在解析（换集 / 自动连播）时，暂缓后台预取。
      //
      // 预取走的是 startPrewarmResolve → 直接调 resolveNative，不会登记
      // nativeResolveInFlightRef，所以这个判断只对**前台**生效，不会自己卡自己。
      //
      // 必要性：单集解析要拉起 python worker + ffmpeg（下载 + 解密 + 转存），
      // 前台 1 个加上预取 2 个就是 3 个进程同时抢带宽与 CPU。而前台那一集是
      // 用户**正在等**的，预取只是"最好有"——让前台先跑完更符合直觉，
      // 也避免前台的探针预热被拖到超时（那会白白多绕一圈 playDirect）。
      if (nativeResolveInFlightRef.current) {
        setTimeout(step, 500);
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
    // 动漫源是流式 m3u8，没有"本地文件"可预热；起 worker 只会白跑一遍
    // 签名链路再失败（worker 只认红果 vid）。动漫的加载靠 openEpisode 直连。
    if (currentSeries?.type === 'anime' || seriesId.startsWith('anime_')) return;
    startPrewarmResolve(seriesId, episodeId, contentType);
  };

  const playLocalFile = async (
    playUrl: string,
    video: HTMLVideoElement,
    sessionId: number,
    startPosition: number,
    episodeId: string,
    seriesId?: string,
  ): Promise<PlayOutcome> => {
    try {
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      const assetUrl = convertFileSrc(playUrl);
      if (activeSessionRef.current !== sessionId) return 'stale'; // 已切走
      // 池里有这一集的首帧就先用池里的（走连播时预解早已完成），
      // 直接进接管，**整段 preloadSource 被跳过**——这就是"进下一集直接播"。
      const pooled = seriesId
        ? takePreparedPool(episodeCacheKey(seriesId, episodeId, 'auto'), startPosition)
        : null;
      if (activeSessionRef.current !== sessionId) {
        disposePrepared(pooled);
        return 'stale';
      }
      // 本地整集文件同样走"先预载、再接管"：即便文件已在盘上，
      // 也让旧帧留到新源解码就绪，避免同一条换集链路上出现两套体验。
      const prepared = pooled ? pooled.element : await preloadSource(assetUrl, startPosition, 10000);
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
          episodeId,
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
      return await playDirect(assetUrl, video, sessionId, startPosition, episodeId);
    } catch (error) {
      noteFailure(`本地文件播放失败 ${playUrl}`, error);
      return 'error';
    }
  };

  // 节流保存历史记录
  const lastSaveTimeRef = useRef<number>(0);

  /**
   * 把可能非有限的媒体时间压成可以安全落库的数字。
   *
   * 为什么必须做：`Math.floor(Infinity)` 还是 `Infinity`，而 `JSON.stringify`
   * 会把 `Infinity`/`NaN` 序列化成 **null**；后端 `WatchHistoryItem` 里
   * `position_seconds` / `duration_seconds` 是必填 f64，收到 null 会**整个
   * 参数反序列化失败**——`history_save` 直接拒绝，一集看完历史页里什么都没有。
   *
   * 这不是假想：部分源（分片 MP4 / 未知时长的流）在 WebView 里 `duration`
   * 长期是 `Infinity`，而原本的写法 `Math.floor(dur)` 正好把它变成 null。
   * 漫剧里这类源尤其常见，表现为"漫剧播放后历史记录根本不出现"。
   */
  const safeSeconds = (value: number): number => (
    Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  );

  /**
   * 保存进度。
   *
   * - 非有限时长一律按 0 上报（后端对 duration=0 有专门的"只更新元数据、
   *   保留旧进度"分支，不会把已有进度冲掉）；
   * - 保存失败必须**可见**：旧实现既不 await 也不 catch，一次序列化失败
   *   就变成静默的 unhandled rejection，用户只看到"历史没同步"。
   */
  const saveProgressThrottled = useCallback((pos: number, dur: number, force = false) => {
    if (!currentSeries || !currentEpisode) return;
    const now = Date.now();
    if (!force && now - lastSaveTimeRef.current < 4000) return;
    lastSaveTimeRef.current = now;

    const safeDur = Number.isFinite(dur) && dur > 0 ? dur : 0;
    const safePos = Number.isFinite(pos) && pos > 0 ? Math.min(pos, safeDur > 0 ? safeDur : pos) : 0;
    const percent = safeDur > 0 ? Math.min(100, Math.max(0, Math.round((safePos / safeDur) * 100))) : 0;
    const isFinished = percent >= 95;

    ipcService.history.save({
      seriesId: currentSeries.id,
      episodeId: currentEpisode.id,
      title: currentSeries.title,
      seriesCover: currentSeries.cover,
      episodeNumber: currentEpisode.episodeNumber,
      totalEpisodes: currentSeries.episodesCount,
      positionSeconds: safeSeconds(safePos),
      durationSeconds: safeSeconds(safeDur),
      progressPercent: percent,
      updatedAt: now,
      isFinished,
      channel: currentSeries.type,
    }).catch((error: unknown) => {
      // 落盘失败必须留痕：否则用户只会看到"历史记录没同步"，无从排查。
      console.warn('[playback] 历史记录保存失败', describeError(error), {
        seriesId: currentSeries.id,
        episodeId: currentEpisode.id,
        positionSeconds: safeSeconds(safePos),
        durationSeconds: safeSeconds(safeDur),
      });
    });
  }, [currentSeries, currentEpisode]);
  // 喂给"只绑定一次"的事件监听器，保证它们拿到最新闭包。
  saveProgressThrottledRef.current = saveProgressThrottled;

  // 打开剧集与换集核心（实现体；对外暴露的 openEpisode 只做同键去重）
  //
  // 入口先收掉画中画小窗：播放权同一时刻只能属于一个窗口。用户在小窗开着的时候
  // 又点了一集，主窗口这边必须先把小窗拆掉，否则两路声音会同时响。同理，从小窗
  // "回到播放器"时这一步是空操作（窗口已经关掉了）。
  const runOpenEpisode = async (seriesId: string, episodeId?: string, startPosition = 0, qualityOverride?: string) => {
    // H.264 增强任务会持续读取上一集源流，换集时必须显式停掉；否则旧 ffmpeg 会和新会话抢 CPU/带宽。
    if (activeSessionRef.current > 0) {
      void ipcService.playback.command(activeSessionRef.current, 'stop').catch(() => undefined);
    }
    dismissPip();
    const qualitySwitchRequested = Boolean(
      qualityOverride
      && currentSeries?.id === seriesId
      && currentEpisode?.id === episodeId,
    );
    // 清除现有的连播倒计时。换集后上一集的"已武装"标记必须一起作废，
    // 否则新一集（sessionId 变了、键不同）之外的残留状态会互相干扰。
    // 上一集的解析进度与失败原因都不能留到这一集：新的解析会立刻重新上报，
    // 而残留的旧错误说明会让本次失败的原因被误读。
    setPrepareStatus(null);
    setErrorDetail(null);
    // 卡死自动重装载的额度：用户自己切集/重开是"新的开始"，额度应当清掉；
    // 而看门狗自己发起的重装载不清（否则刚花掉就被自己抹掉，防不住循环）。
    //
    // 卡死提示走同一条判据：开新会话就没必要留着上一会话的横幅（实测：卡死自愈
    // 成功、或用户在卡死期间手动切集后，"画面卡住了…"会一直挂在正常播放的画面上，
    // 只能手点 ✕ 或离开播放器才消失）。看门狗那条是例外——重装载是"恢复动作"，
    // 提示要一直留到画面真的回来，由 handlePlaying 收回，不在重装载刚开始就撤掉。
    if (!stallReloadingRef.current) {
      stallRecoveredRef.current.clear();
      setStallNotice(null);
    }
    stallReloadingRef.current = false;

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
      const isGuoSeries = seriesId.startsWith('guo:');
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

      // guo 外部站源的档位藏在 resolve 结果里（详情接口不带 qualities），与动漫
      // 链路同理：按"剧+集"探测一次。探测异步进行、不阻塞起播；`animeQualities`
      // 失败时返回空数组——宁可退回单档"自动"，也绝不虚构源里没有的档位；
      // 结果回来时若会话已被更新的切换作废则丢弃。
      // （不能改用详情里的 availableQualities 直填：那里对 guo 源恒为空，
      // 每次换集都会把已探测到的档位清掉，清晰度按钮就永远是禁用的。）
      if (isGuoSeries) {
        const guoQualityKey = `${seriesId}::${ep.id}`;
        if (guoProbedRef.current !== guoQualityKey) {
          guoProbedRef.current = guoQualityKey;
          void ipcService.playback.animeQualities(seriesId, ep.id)
            .then(options => {
              if (activeSessionRef.current !== newSessionId) return;
              setAvailableQualities(options);
            });
        }
      }

      const selectedQuality = qualityOverride || currentQuality;

      // ===== 动漫专区：直连播放链路 =====
      // 动漫源（暴风资源）的播放地址是 m3u8，经本地 HLS 代理转流后直接喂
      // <video>，全程不经红果 worker（worker 的签名/下载/解密链路对动漫源
      // 无意义，跑一遍只会白等 3-10 秒再失败）。也不走预取快路径——m3u8
      // 是流式的，没有"本地文件"可缓存，缓存快路径对它不适用。
      if (detail.type === 'anime') {
        // 动漫的清晰度档位藏在播放解析里，与短剧那条 `probeQualities`
        // （走红果 worker）完全不通用，这里单独探一次。探测有网络成本，
        // 所以按"剧+集"记忆：同一集重复进入不重探。
        const qualityKey = `${seriesId}::${ep.id}`;
        if (animeProbedRef.current !== qualityKey) {
          animeProbedRef.current = qualityKey;
          void ipcService.playback.animeQualities(seriesId, ep.id)
            .then(options => {
              if (activeSessionRef.current !== newSessionId) return;
              setAvailableQualities(options);
            })
            .catch(() => {
              if (activeSessionRef.current !== newSessionId) return;
              setAvailableQualities([]);
            });
        }
        let session;
        try {
          session = await ipcService.playback.open(seriesId, ep.id, selectedQuality, startPosition, newSessionId, true);
        } catch (animeError) {
          if (activeSessionRef.current !== newSessionId) return;
          throw animeError;
        }
        if (activeSessionRef.current !== newSessionId) return;
        if (!videoRef.current) return;
        const animeVideo = videoRef.current;
        animeVideo.dataset.sessionId = String(newSessionId);
        backupUrlRef.current = '';
        hasTriedBackupRef.current = true;
        hasTriedBlobRef.current = true;
        hasTriedNativeResolveRef.current = true;
        if (objectUrlRef.current) {
          URL.revokeObjectURL(objectUrlRef.current);
          objectUrlRef.current = '';
        }
        animeVideo.preload = 'auto';
        animeVideo.playbackRate = playbackRateRef.current;
        animeVideo.volume = isMutedRef.current ? 0 : volumeRef.current;
        animeVideo.muted = isMutedRef.current;
        // m3u8（本地代理流）经 hls.js 挂载；mp4 直链仍走普通 src。
        if (isHlsUrl(session.url)) {
          await attachSource(animeVideo, session.url);
        } else {
          detachSource(animeVideo);
          animeVideo.src = session.url;
        }
        // 源挂载完成后恢复用户倍速：换集路径必须以 ref 为准，不能读取可能滞后的
        // React state，否则用户改完倍速后自动连播仍会拿旧值。
        animeVideo.playbackRate = playbackRateRef.current;
        // HLS 挂载（attachSource）是长时间 await：期间用户可能已离开播放器。
        if (pauseIfStale(newSessionId, animeVideo)) return;
        markSourceCommitted(newSessionId, ep.id);
        if (startPosition > 0) {
          const handleAnimeMetadata = () => {
            try {
              animeVideo.currentTime = startPosition;
            } catch {
              // ignore
            }
            animeVideo.removeEventListener('loadedmetadata', handleAnimeMetadata);
          };
          if (animeVideo.readyState >= 1) {
            animeVideo.currentTime = startPosition;
          } else {
            animeVideo.addEventListener('loadedmetadata', handleAnimeMetadata);
          }
        }
        try {
          await animeVideo.play();
          if (pauseIfStale(newSessionId, animeVideo)) return;
          setIsPlaying(true);
          setUiState({ kind: 'playing', sessionId: newSessionId, position: animeVideo.currentTime || startPosition });
        } catch (playError) {
          if (activeSessionRef.current !== newSessionId) return; // 会话已作废：不静音重试、不弹错误卡
          if (playError instanceof DOMException && playError.name === 'NotAllowedError' && !animeVideo.muted) {
            // WebView 拒绝带声音自动播放：静音起播，让用户手动恢复声音。
            animeVideo.muted = true;
            setIsMuted(true);
            isMutedRef.current = true;
            try {
              await animeVideo.play();
              if (pauseIfStale(newSessionId, animeVideo)) return;
              setIsPlaying(true);
              setUiState({ kind: 'playing', sessionId: newSessionId, position: animeVideo.currentTime });
            } catch {
              setIsPlaying(false);
              setUiState({ kind: 'error', sessionId: newSessionId, code: 'MEDIA_AUTOPLAY_FAILED', recoverable: true });
            }
          } else if (
            playError instanceof DOMException &&
            playError.name === 'AbortError'
          ) {
            // "video-only background media was paused to save power"：WebView 把
            // 被判定为后台的窗口里的视频暂停以省电——**源已就绪**（loadeddata 已
            // 触发），这不是播放源问题。实测窗口未聚焦/被遮挡时就会出现，弹
            // "播放源连接受阻"完全误导。此时静默重试一次：窗口回前台后 play()
            // 就能成功；仍 Abort 则回到"可播"的暂停态，等用户的播放手势。
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (activeSessionRef.current !== newSessionId) return;
            try {
              await animeVideo.play();
              if (pauseIfStale(newSessionId, animeVideo)) return;
              setIsPlaying(true);
              setUiState({ kind: 'playing', sessionId: newSessionId, position: animeVideo.currentTime });
            } catch (retryError) {
              if (retryError instanceof DOMException && retryError.name === 'NotAllowedError') {
                setIsPlaying(false);
                setUiState({ kind: 'error', sessionId: newSessionId, code: 'MEDIA_AUTOPLAY_FAILED', recoverable: true });
                return;
              }
              // 源已就绪（不是连接受阻）：显示缓冲/暂停态而不是错误页。
              setIsPlaying(false);
              setUiState({ kind: 'buffering', sessionId: newSessionId });
            }
          } else {
            setIsPlaying(false);
            setUiState({ kind: 'error', sessionId: newSessionId, code: 'MEDIA_LOAD_FAILED', recoverable: true });
          }
        }
        return;
      }

      // ===== 复位三级兜底开关（跨源/跨会话污染修复）=====
      //
      // 这三个开关（备用直链 / Blob / 本地解析）的语义是"本会话已试过、别再试"，
      // 但原实现**没有任何路径在新会话开始时复位它们**：
      //   - 动漫分支（上方）置 true 后直接 return；
      //   - 短剧主链路（下方）自己也置 true。
      // 于是"播过一次动漫/短剧之后，其它源就再也播不了"——三条兜底腿全被
      // 上一会话的残留顶掉，这正是"播完动漫后漫剧/短剧播不了"的根因。
      // 在进入非动漫路径前统一复位，恢复"每次打开都从干净的兜底状态开始"。
      // （快路径若命中会在下面自己置 true，不受影响。）
      hasTriedBackupRef.current = false;
      hasTriedBlobRef.current = false;
      hasTriedNativeResolveRef.current = false;
      // 快路径：该集此前已解析出本地文件（首次播放成功或预取完成）。
      // 直接秒开本地 mp4，跳过注定失败的公开直链试探（省 3-10 秒）。
      const video = videoRef.current;
      const cachedKey = episodeCacheKey(seriesId, ep.id, selectedQuality);
      const cachedPlayUrl = resolvedFileByVidRef.current.get(cachedKey);
      if (video && cachedPlayUrl && cachedPlayUrl !== '__prefetching__') {
        video.dataset.sessionId = String(newSessionId);
        backupUrlRef.current = '';
        hasTriedBackupRef.current = true;
        hasTriedBlobRef.current = true;
        hasTriedNativeResolveRef.current = true;
        const outcome = await playLocalFile(cachedPlayUrl, video, newSessionId, startPosition, ep.id, seriesId);
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
      if (!isGuoSeries && videoRef.current && activeSessionRef.current === newSessionId) {
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
            resolvedFileByVidRef.current.delete(episodeCacheKey(seriesId, ep.id, selectedQuality));
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
          // 额度已用掉就释放。原来只在成功时清除，导致这一集一旦失败过，
          // 之后每次打开都不再自动重试——用户手动点"重新解析播放"也拿不回额度。
          resolveRetriedRef.current.delete(ep.id);
        }
        if (isSettled(outcome)) {
          if (activeSessionRef.current !== newSessionId) return;
          resolveRetriedRef.current.delete(ep.id);
          // 首次进入该集且播放成功：后台探测真实清晰度档位，不阻塞播放。
          // 延后 3 秒：此刻 warmAdjacentEpisodes 刚把预取队列灌进 worker，
          // 立即探测会和预取串行抢锁（worker 单实例），两边都慢。放完这一拍
          // 再探，探测本身不赶时间——清晰度只是附加信息。
          setTimeout(() => {
            void probeQualities(ep.id, detail.type === 'comic' ? 1004 : 1);
          }, 3000);
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

      // 本地解析失败后的公开直链兜底：会话已作废（用户已离开）就直接放弃——
      // open 会白跑 Rust/worker，其进度事件还会污染下一会话的加载提示卡。
      if (activeSessionRef.current !== newSessionId) return;
      // guo 预取快路径：连播的下一集已被后台 open 过（resolvedGuoSessionRef），
      // 直接拿那个会话装载，跳过现场 resolve（实测 0.6~5.8s）——这是"小窗返回
      // 主播放器后连播每集都黑等一轮"的主要修复。占位中/无缓存照常走完整 open。
      const guoPrefetchKey = isGuoSeries ? episodeCacheKey(seriesId, ep.id, selectedQuality) : '';
      const guoPrefetched = guoPrefetchKey
        ? resolvedGuoSessionRef.current.get(guoPrefetchKey)
        : undefined;
      let session: PlaybackSession;
      if (isGuoSeries && guoPrefetched && guoPrefetched !== '__prefetching__') {
        // URL 幂等（guo-core 本地媒体服务），保留条目以便重播同集时继续命中。
        session = {
          ...guoPrefetched,
          sessionId: newSessionId,
          position: startPosition,
          quality: selectedQuality,
        };
      } else {
        try {
          session = await ipcService.playback.open(seriesId, ep.id, selectedQuality, startPosition, newSessionId);
        } catch (webError) {
          if (activeSessionRef.current !== newSessionId) return;
          throw webError;
        }
      }
      // 预取下一集：URL 已可用即可触发，不等 play() 成功——自动播放被拦等
      // 起播问题与本集 URL 的有效性无关，预取不该为它们买单。
      if (isGuoSeries && activeSessionRef.current === newSessionId) {
        prefetchGuoNext(detail, ep.id, selectedQuality);
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
        const preferredMuted = isMutedRef.current;
        video.dataset.sessionId = String(newSessionId);
        if (objectUrlRef.current) {
          URL.revokeObjectURL(objectUrlRef.current);
          objectUrlRef.current = '';
        }
        video.preload = 'auto';
        video.playbackRate = playbackRateRef.current;
        video.volume = isMutedRef.current ? 0 : volumeRef.current;
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
        if (session.streamKind === 'hls' || isHlsUrl(session.url)) {
          await attachSource(video, session.url);
        } else {
          detachSource(video);
          video.src = session.url;
        }
        markSourceCommitted(newSessionId, ep.id);
        await webFirstFrame;
        // 首帧等待是本段链路里唯一的长时间 await：期间用户可能已离开播放器
        // （会话已作废）。不复查就 play()，正是"退出后声音照放"的主通道。
        if (pauseIfStale(newSessionId, video)) return;
        video.playbackRate = playbackRateRef.current;

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

        // 公开直链是"吊死连接"最高发的一条路（远端不回包也不断开），play()
        // 在这里挂死就是永久 opening。有界版本超时后走 catch → 本地解析兜底。
        playBounded(video).then(() => {
          if (pauseIfStale(newSessionId, video)) return;
          video.muted = preferredMuted;
          setIsPlaying(true);
          setUiState({ kind: 'playing', sessionId: newSessionId, position: startPosition });
        }).catch((error: unknown) => {
          if (activeSessionRef.current !== newSessionId) return; // 会话已作废：不补播、不弹错误卡
          // WebView2 may reject the first gesture-less attempt only because it has audio.
          // Retry muted so the episode starts, then let the user restore sound explicitly.
          if (error instanceof DOMException && error.name === 'NotAllowedError' && !video.muted) {
            video.muted = true;
            setIsMuted(true);
            isMutedRef.current = true;
            // 静音重试的源仍是公开直链：play() 挂死时靠有界版本的超时走到
            // MEDIA_AUTOPLAY_FAILED，而不是永久停在 opening。
            void playBounded(video).then(() => {
              if (pauseIfStale(newSessionId, video)) return;
              setIsPlaying(true);
              setUiState({ kind: 'playing', sessionId: newSessionId, position: video.currentTime });
            }).catch(() => {
              if (activeSessionRef.current !== newSessionId) return; // 会话已作废
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
      } else {
        // 播放器宿主缺失（VideoSurface 常驻 DOM，理论上不会发生；但一旦发生，
        // 上面两个分支都不进，uiState 会永远停在 opening——既不出画也不报错，
        // "正在切换到第 N 集"的提示也会一直挂着）。这里兜底宣判失败。
        noteFailure('播放器宿主不可用', new Error('videoRef.current 为空'));
        setIsPlaying(false);
        setUiState({
          kind: 'error',
          sessionId: newSessionId,
          code: 'MEDIA_LOAD_FAILED',
          recoverable: true,
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
    // 新的播放意图即刻撤销"全剧播完自动返回详情"的安排：用户可能在 2 秒返回窗口
    // 内从选集抽屉点了下一部/另一集，不撤销的话返回会把正在打开的播放打断。
    setFinishedAll(false);
    finishedAllEpisodeRef.current = null;
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
  // 只绑定一次的事件监听器需要**最新**的 openEpisode：首帧那次渲染的闭包里
  // currentSeries 还是 null，直接调用会拿不到任何上下文（与 playNextEpisodeRef 同一理由）。
  openEpisodeRef.current = openEpisode;

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play().then(() => {
        setIsPlaying(true);
        setUiState({ kind: 'playing', sessionId: activeSessionRef.current, position: videoRef.current?.currentTime || 0 });
      }).catch((error: unknown) => {
        if (currentSeries && currentEpisode && videoRef.current) {
          // 复用已在途的解析任务（error 事件链可能已启动 worker），没有才新起。
          // 只复用**当前会话**的：旧会话的任务返回 'stale'，拿来用等于什么都不做。
          const attempt = currentSessionResolve() ?? (() => {
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
    // 用户手动拖进度 = 接管播放：撤销"全剧播完自动返回详情"的安排（若有）。
    setFinishedAll(false);
    finishedAllEpisodeRef.current = null;
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
    volumeRef.current = clamped;
    if (videoRef.current) {
      videoRef.current.volume = clamped;
      // 是否顺带解除静音读 ref：同一 tick 里先 setMuted(true) 再 setVolume 时
      // state 还没提交，读 `isMuted` 会误判成"本来就没静音"，音量调上去却没声音。
      if (clamped > 0 && isMutedRef.current) {
        setIsMuted(false);
        isMutedRef.current = false;
        videoRef.current.muted = false;
      }
    }
  };

  const toggleMute = () => {
    // 与动漫播放器同一算法：先读 ref 求反，保证连点两次的结果可预期。
    const next = !isMutedRef.current;
    setIsMuted(next);
    isMutedRef.current = next;
    if (videoRef.current) {
      videoRef.current.muted = next;
    }
  };

  /**
   * 显式设置静音（`toggleMute` 做不到：它要先知道当前值）。
   *
   * 从小窗回播放器时用它接回静音状态：小窗里用户可能已经按成静音，只接回音量
   * 而不接回静音，回到播放器的第一声会与用户预期相反。
   */
  const setMuted = (value: boolean) => {
    setIsMuted(value);
    isMutedRef.current = value;
    if (videoRef.current) {
      videoRef.current.muted = value;
    }
  };

  const setPlaybackRate = (rate: number) => {
    setPlaybackRateState(rate);
    playbackRateRef.current = rate;
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
    // 会话号即将作废，先把增强转码与 guo 会话停掉；只停 <video> 不够，ffmpeg 还在后台读源。
    if (activeSessionRef.current > 0) {
      void ipcService.playback.command(activeSessionRef.current, 'stop').catch(() => undefined);
    }
    // 离开播放器 = 当前会话作废：在途的 openEpisode/预热续体全部按 stale 处理。
    // 不作废的后果（实测）：换集长期卡在切线重试 → 用户返回主界面 → worker
    // 稍后成功 → 旧会话续体照常 setSrc/play()，常驻 <video> 被隐藏着出声。
    activeSessionRef.current += 1;
    // 首帧预解池同理：会话已作废，池里的探针不会再被接管，
    // 不释放就是几份解码器白挂在脱离文档流的 video 上。
    drainPreparedPool();
    // 在途 open 任务绑定的是刚作废的会话，不能留在复用池：重进播放器再点
    // 同一集若复用到这条"所有续体都会 stale"的死任务，会表现为点了没反应。
    openInFlightRef.current.clear();
    // 看门狗必须一起收掉：它的续体会重起播、甚至重装载整集，留着就是"人已退出
    // 却仍被后台定时器拉起播放"。提示同时收回，播放器下次进来是干净的。
    stopStallWatchdog();
    setStallNotice(null);

    const video = videoRef.current;
    if (video) {
      if (!video.paused) video.pause();
      // 时长不可信（分片 MP4 会报 Infinity）时也要落盘：此时按 0 上报，
      // 后端保留旧的时长/百分比，只更新"看到哪一集、哪个位置"。
      // 旧实现用 `Number.isFinite(duration)` 直接跳过保存，那类源于是永远
      // 留不下历史记录——漫剧里最容易中。
      saveProgressThrottledRef.current(video.currentTime, usableDuration(video), true);
      // 增强流是 hls.js/MSE 接管，只 pause 会把上一集的 SourceBuffer 留在常驻 video 上；
      // 下次直接播放本地 mp4 时必须先解除接管。
      detachSource(video);
    }
    setIsPlaying(false);
    // 已置位的"全剧播完"信号一并撤销：用户已离开播放器，别再自动把人拉去详情页。
    setFinishedAll(false);
    finishedAllEpisodeRef.current = null;
    // 回到 idle 而不是保留 playing/buffering：否则重新进入播放器时
    // 界面会先闪一下上一集的加载遮罩。
    setUiState(prev => (prev.kind === 'idle' ? prev : { kind: 'idle' }));
  }, []);

  /**
   * 把当前这一集交给画中画小窗继续播。
   *
   * 交接的是"身份 + 播放参数"，**不是播放地址**：小窗会用同一条链路自行解析
   * （理由见 services/pip.ts 的文件头）。这里只有两件事必须做对：
   *   1. 交接前先 `pause()`——常驻的 `<video>` 不会因为小窗打开就自己停，两路
   *      同时出声是这块功能最典型的故障；
   *   2. 交接后调用方要离开播放器视图，App 会随之走 `stopPlayback()`（作废会话
   *      + 落盘进度），主窗口这边就彻底交干净了。
   *
   * 返回 false 表示没能交出去（非桌面环境、没有正在播的集、或后端拒绝）：
   * 调用方应当留在播放器里，而不是把用户扔到一个空白页。
   */
  const enterPip = useCallback(async (): Promise<boolean> => {
    const video = videoRef.current;
    const series = currentSeries;
    const episode = currentEpisode;
    if (!video || !series || !episode) return false;
    const position = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    if (!video.paused) video.pause();
    try {
      await openPip({
        kind: 'drama',
        seriesId: series.id,
        episodeId: episode.id,
        title: series.title,
        cover: series.cover,
        channel: series.type,
        totalEpisodes: series.episodesCount,
        episodeNumber: episode.episodeNumber,
        quality: currentQuality || 'auto',
        position,
        volume,
        muted: isMuted,
        rate: playbackRate,
        // worker 的内容类型：漫剧与短剧在 App-API 上是两套参数（1004 / 1）。
        contentType: series.type === 'comic' ? 1004 : 1,
        autoNext: settings.autoNext,
        episodes: series.episodes.map(item => ({
          id: item.id,
          episodeNumber: item.episodeNumber,
          title: item.title,
        })),
      });
      return true;
    } catch (error) {
      noteFailure('进入画中画失败', error);
      return false;
    }
  }, [
    currentSeries, currentEpisode, currentQuality, volume, isMuted, playbackRate,
    settings.autoNext,
  ]);

  /**
   * 事件处理器上下文。
   *
   * 旧实现把 6 个监听器直接绑在 effect 里，依赖数组带着若干每秒都会变的状态——
   * 倒计时每秒跳一下就会把 6 个监听器全部摘掉重绑，换集瞬间还叠加
   * currentSeries/currentEpisode 变化，造成成片的事件抖动与 listener 泄漏风险。
   * 现在监听器**只绑定一次**，通过这个 ref 读到最新状态。
   */
  const handlerCtxRef = useRef({
    currentSeries,
    currentEpisode,
    currentQuality,
    isMuted,
    autoNext: settings.autoNext,
  });
  handlerCtxRef.current = {
    currentSeries,
    currentEpisode,
    currentQuality,
    isMuted,
    autoNext: settings.autoNext,
  };

  // 看门狗唯一的定时器型资源，组件卸载必须收口。Provider 理论上与窗口同寿，
  // 但 HMR 与严格模式会重挂载，漏掉就是一条常驻 interval。
  useEffect(() => () => { stopStallWatchdog(); }, [stopStallWatchdog]);

  /**
   * 武装卡死看门狗——**只在真正开播这一刻调用**。
   *
   * 装源之前的等待期里没有帧是正常的，那段该由 `opening` / `buffering` 表达；
   * 交给看门狗只会把"正在解析"误判成"卡死"，在解析还没回来时就触发重装载。
   */
  const armStallWatchdog = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    stopStallWatchdog();
    const sessionId = activeSessionRef.current;
    stallWatchdogStopRef.current = startDramaStallWatchdog(video, {
      onRetry: () => {
        // 已被更新的切换接管：连提示都不该再弹（人已经在看别的集了）。
        if (activeSessionRef.current !== sessionId) return;
        // 播完的视频绝不能碰：此时 seek 会把已 ended 的视频"倒带重生"再立刻
        // 播回结尾，用户看到的就是结尾几秒无故闪回一次。
        if (video.paused || video.ended || video.seeking) return;
        setStallNotice(STALL_RETRY_NOTICE);
        const el = videoRef.current;
        if (!el) return;
        // 第 1 级：原地重试。同一个时间点重拉一次数据就能唤醒卡死的解码线程的
        // 场合不少，而重装载一整集要 7 秒左右——先试便宜的那一下。
        try {
          el.currentTime = el.currentTime;
        } catch {
          // 源尚未可 seek：交给第 2 级。
        }
        if (el.paused) void el.play().catch(() => { /* 第 2 级接手 */ });
      },
      onEscalate: () => {
        // 恢复动作与 §5-2 的其余续体同一条规矩：先复查会话号，否则用户在卡死期间
        // 早就手动切集了，这里会把已切走的集重新拉回来。
        if (activeSessionRef.current !== sessionId) return;
        // 第 1 级 tick 的两条排除判据在这里必须复读一遍：那两条此前只挡 tick，
        // 而升级发生在 2 秒之后——卡死后用户按暂停是极常见的反应，不复读就会把
        // "用户主动暂停"当成"还在卡"，强行重装载并出声。**用户主动暂停优先于自动
        // 恢复**：自动恢复的理由是"本来该在播却没播"，用户按了暂停就已经否掉了这个
        // 前提。返回后不重试是安全的——`stalled` 仍为 true，tick 会继续挡着；用户
        // 重新播放、时钟恢复推进时 tick 走健康分支并回调 onHealthy 收回提示。
        if (video.paused || video.seeking) return;
        const ctx = handlerCtxRef.current;
        if (!ctx.currentSeries || !ctx.currentEpisode) return;
        const episodeId = ctx.currentEpisode.id;
        if (stallRecoveredRef.current.has(episodeId)) {
          // 额度用尽：这一集已经重装载过一次还是卡，如实停下来，把决定权交回用户。
          // 提示在这里收回 null——终局由错误卡负责表达，不留一个撤不掉的横幅。
          setStallNotice(null);
          setIsPlaying(false);
          setUiState({ kind: 'error', sessionId, code: 'MEDIA_PLAYBACK_STALLED', recoverable: true });
          return;
        }
        stallRecoveredRef.current.add(episodeId);
        // 第 2 级：复用**既有的**换集入口重装载同一集。它自带完整的降级链
        // （本地快路径 → 整集解析 + 一次重试 → 公开直链兜底）与三级兜底开关复位，
        // 复用它就不必再写一套恢复逻辑。
        //
        // 这只是"重新装载当前这一集"：会话号在那个入口里照常递增，所有在途续体
        // 一律按 stale 处理；**绝不**推进到下一集，因此 §5-3 的连播四重闸门原样
        // 保留（`autoAdvanceLatchRef` / `videoCommittedRef` 全不碰）。
        const resumeAt = Number.isFinite(video.currentTime) ? video.currentTime : 0;
        stallReloadingRef.current = true;
        // 标志必须由这次调用自己回收，不能指望 runOpenEpisode 复位：openEpisode 对
        // "同键重复打开"会去重，命中在途任务时 runOpenEpisode 根本不执行，标志就
        // 永久停在 true，之后用户手动切集也不再清 stallRecoveredRef（每集一次的重
        // 装载额度从此不再重置）。正常路径下 runOpenEpisode 在第一个 await 之前就
        // 读走并复位了它，这里的复位是幂等的兜底。
        void openEpisodeRef.current(
          ctx.currentSeries.id,
          episodeId,
          Math.max(0, resumeAt - STALL_REWIND_SECONDS),
        ).finally(() => { stallReloadingRef.current = false; });
      },
      onHealthy: () => {
        if (activeSessionRef.current !== sessionId) return;
        // 恢复成功：提示必须回到 null，否则它会一直挂在画面上（死 UI）。
        setStallNotice(null);
      },
    });
  }, [stopStallWatchdog]);

  // 监听播放器事件（缓冲、时间更新、结束）——只绑定一次，永不重绑。
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // 起播打点「首帧-宿主」这个基准值。正常应该远小于 2000ms（本地文件是
    // 毫秒级）。若它显示出「画面在走、进度条 00:00」那种脱钩症状，这个数会
    // 一直停在装载那一刻之后很久不再刷新 —— 即 <video> 被重挂、而这份只绑定
    // 一次的监听器还挂在被丢弃的旧元素上。
    const mountedAt = performance.now();
    let firstTickAt: number | null = null;
    tracePlayback('首帧-宿主 监听器已绑定 video');

    const handleTimeUpdate = () => {
      if (firstTickAt === null) {
        firstTickAt = performance.now();
        tracePlayback(`首帧-宿主 首次 timeupdate 距装载=${Math.round(firstTickAt - mountedAt)}ms 时长=${usableDuration(video).toFixed(1)}s`);
      }
      const cur = video.currentTime;
      const dur = usableDuration(video);
      setPosition(cur);
      setDuration(dur);
      saveProgressThrottledRef.current(cur, dur);
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
      // 缓冲**不**卸看门狗：解码线程卡死时 `waiting` 照样会派发且再也不回来，
      // 在这里卸掉它恰好会漏掉本次要治的那个症状。区分"慢网缓冲"与"真卡死"
      // 靠的是看门狗里那条"没有新数据在进"——缓冲期间 buffered 还在长。
      setUiState({ kind: 'buffering', sessionId: activeSessionRef.current });
    };

    const handlePlaying = () => {
      // 播完后又重新开播（用户把进度拖回再播）即撤销"全剧播完自动返回详情"的安排。
      setFinishedAll(false);
      // 真正开播这一刻才武装看门狗（装载等待期里没有帧是正常的）。
      armStallWatchdog();
      // 画面真的回来了就收回卡死提示。第 1 级原地重试恢复时由看门狗的 onHealthy
      // 负责，但第 2 级重装载换了一个**新的**看门狗实例（stalled 初值 false，
      // onHealthy 永远不会来），只能由这里兜底——否则横幅会一直挂在正常播放上。
      setStallNotice(null);
      setIsPlaying(true);
      setUiState({ kind: 'playing', sessionId: activeSessionRef.current, position: video.currentTime });
      // 真正出画就立刻落一条历史，而不是等第一次 timeupdate 的 4 秒节流窗口。
      //
      // 这样"打开一集看两眼就退出"也会留下"看到第 N 集"；时长此刻可能还没就绪，
      // 按 0 上报——后端对 duration=0 有专门分支，只更新元数据、不覆盖已有进度，
      // 所以这次提前上报不会有副作用。
      saveProgressThrottledRef.current(video.currentTime, usableDuration(video), true);
      // 预取已迁移到 openEpisode 落点（warmAdjacentEpisodes），这里不再重复发起：
      // 挂在 playing 上会导致"必须真正开播才预取"，而用户往往在开播瞬间就切集，
      // 预取来不及完成，等于没做。
    };

    const handleEnded = () => {
      // 一集播完，看门狗的使命就结束了："本该在播却不播"的前提不再成立。
      // 不停掉的话，播完静置 10 秒它会照着 ended 状态（paused 仍为 false）
      // 误判成卡死并拉起恢复流程。下一集真正开播时 handlePlaying 会重新武装。
      stopStallWatchdog();
      setIsPlaying(false);
      setUiState({ kind: 'ended', sessionId: activeSessionRef.current });
      // 落盘"这一集看完了"必须归属**真正放完的那一集**。
      //
      // 旧实现无条件按 currentEpisode 写 100% 完成：交接期 currentEpisode 已经是
      // 下一集，于是一次播放结束会把下一集标成"已看完"，历史页随即显示错误的集数。
      const ctxEnded = handlerCtxRef.current;
      // 前缀先行开播的副作用：前缀文件只有开头一小段（实测十几秒）。画面还挂在
      // 前缀上就播到头时，这一集其实远没播完，而整集多半刚好落盘。就地重载同一集
      // 接住它：openEpisode 会命中刚登记好的整集路径秒起，而且此时播放位置已远超
      // `PREFIX_COVERAGE_SECONDS`，会**自动跳过前缀**——不存在"前缀播完 → 重载 →
      // 又播前缀"的循环。放在落盘判定之前，是因为这一次 ended 并不代表看完。
      const prefixSource = prefixSourceRef.current;
      if (
        prefixSource
        && prefixSource.sessionId === activeSessionRef.current
        && prefixSource.episodeId === (videoCommittedRef.current?.episodeId ?? ``)
        && ctxEnded.currentSeries
      ) {
        prefixSourceRef.current = null;
        const resumeAt = Number.isFinite(video.currentTime) ? video.currentTime : 0;
        tracePlayback(`前缀片段播到末尾 位置=${resumeAt.toFixed(1)}s，就地接整集`);
        void openEpisodeRef.current(ctxEnded.currentSeries.id, prefixSource.episodeId, resumeAt);
        return;
      }
      const committed = videoCommittedRef.current;
      const endedEpisodeId = committed?.episodeId ?? ctxEnded.currentEpisode?.id ?? null;
      if (endedEpisodeId && endedEpisodeId === ctxEnded.currentEpisode?.id) {
        const endedDuration = usableDuration(video);
        saveProgressThrottledRef.current(endedDuration, endedDuration, true);
      }
      // 主播放器正在把新源接管进来：这次 ended 属于被交接掉的旧一集，
      // 再发起下一集就会连跳两级（用户点"立即播放"后旧视频恰好播完时最容易中）。
      if (adoptingRef.current) return;
      if (!endedEpisodeId) return;
      // 画面里装的已经不是 currentEpisode（说明这次 ended 是迟到的旧源事件），
      // 或这一集刚被倒计时跳过——一律不再往后跳，否则就是"一次跳好几集"。
      if (endedEpisodeId !== ctxEnded.currentEpisode?.id) return;
      // 这里是**唯一**的自动跳集触发点：倒计时只做提示，不参与跳转。
      // 上面 `endedEpisodeId !== ctxEnded.currentEpisode?.id` 挡掉迟到的旧源事件，
      // `tryClaimAutoAdvance` 保证同一集只跳一次。加上「只有一个触发器」这个前提，
      // 「一次跳好几集」这个历史上反复出现的故障就没有第二条路径可钻了。
      if (!ctxEnded.autoNext) return;
      if (!tryClaimAutoAdvance(endedEpisodeId)) return;
      // 已经是最后一集：连播链到头，没有"下一集"可进。置位交给宿主返回详情页
      // ——常驻 <video> 停在 ended 上就是黑屏，不能什么都不做。
      const endedSeries = ctxEnded.currentSeries;
      const endedIndex = endedSeries
        ? endedSeries.episodes.findIndex(e => e.id === endedEpisodeId)
        : -1;
      if (endedSeries && endedIndex >= 0 && endedIndex >= endedSeries.episodes.length - 1) {
        if (finishedAllEpisodeRef.current === endedEpisodeId) return;
        finishedAllEpisodeRef.current = endedEpisodeId;
        setFinishedAll(true);
        return;
      }
      playNextEpisodeRef.current();
    };

    const handleError = () => {
      // 清理旧源时 WebView2 可能派发一次空源 error，不应覆盖真实播放状态。
      if (!video.currentSrc && !video.src) return;
      // 源已经报错：恢复交给下面的三级兜底链（备用直链 → Blob → 本地解析），
      // 看门狗此刻只会跟它抢同一块画面。
      stopStallWatchdog();
      // 接管流程（adoptPreparedSource / playDirect）进行中：这次 error 是它自己的
      // 事务，由它重试或判死。这里若抢先弹错误页，就会出现"视频已播起来、
      // 界面却停在错误页"，也会让 playDirect 的兜底完全失效。
      if (adoptingRef.current) return;
      // 本地解析已在途（openEpisode 或 play() 拒绝分支已启动 worker）：
      // 直链失败不代表应用内播不了，保持 opening 状态等待结果，禁止弹错误页或降级。
      if (nativeResolveInFlightRef.current) return;
      // 会话已作废（用户已离开播放器 / 已有更新的切换接管）：整条兜底链
      // （备用直链 → Blob → 本地解析）都不再启动——它们的续体最终都会
      // play()，等于人已退出却隐形开播。
      if (activeSessionRef.current !== Number(video.dataset.sessionId)) return;
      const ctx = handlerCtxRef.current;
      const backupUrl = backupUrlRef.current;
      if (backupUrl && !hasTriedBackupRef.current) {
        hasTriedBackupRef.current = true;
        // 用户已离开播放器（会话已作废）：不再补播备用直链，避免隐形出声。
        if (activeSessionRef.current !== Number(video.dataset.sessionId)) return;
        const sessionAtBackup = activeSessionRef.current;
        setUiState({ kind: 'opening', sessionId: activeSessionRef.current, episodeId: ctx.currentEpisode?.id || '' });
        video.pause();
        const preferredMuted = ctx.isMuted;
        video.muted = true;
        detachSource(video);
        video.src = backupUrl;
        if (ctx.currentEpisode) markSourceCommitted(activeSessionRef.current, ctx.currentEpisode.id);
        video.load();
        // 备用直链同样是远端地址，play() 挂死会永久停在 opening；超时后走
        // catch 的 MEDIA_BACKUP_LOAD_FAILED，让位给 Blob / 本地解析兜底。
        void playBounded(video)
          .then(() => {
            if (pauseIfStale(sessionAtBackup, video)) return;
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
            detachSource(video);
            video.src = objectUrlRef.current;
            const blobCtx = handlerCtxRef.current;
            if (blobCtx.currentEpisode) markSourceCommitted(activeSessionRef.current, blobCtx.currentEpisode.id);
            video.load();
            // Blob 直播的 play() 同样要设保底：挂死时这条 .then 永不落地，
            // 下面的本地解析兜底就永远轮不到。
            return playBounded(video);
          })
          .then(() => {
            if (pauseIfStale(Number(video.dataset.sessionId), video)) return;
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
        ).then(result => {
          // 必须收口：漏掉这个 .then 的话，一旦解析也失败，uiState 会永远停在
          // opening —— 既不出画也不报错，用户只能看着转圈干等。
          if (isSettled(result)) return;
          setIsPlaying(false);
          setUiState({
            kind: 'error',
            sessionId: activeSessionRef.current,
            code: outcomeErrorCode(result),
            recoverable: true,
          });
        });
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

    /**
     * 首帧真的出来了：把「云端解析中…」那条进度提示收掉。
     *
     * 为什么需要单独一条：解析进度来自 worker 的 `shortdrama://app-resolve` 事件，
     * 而 worker 是在**下载整集**的过程中上报的。现在的链路是"worker 一边下载、
     * 播放器一边播"（增强转码流尤其如此：第一段分片落地就能出画，此后 worker 还在
     * 为后续分片继续拉源）。于是进度提示会一直挂到整集下完为止 —— 用户看到的正是
     * 「视频都开始播了，还在转圈等我」，而它等的其实是一件**已经不影响当前播放**
     * 的后台任务。
     *
     * 判定用 `currentTime > 0` 而不是单纯 `playing`：`playing` 在缓冲挖坑后
     * 恢复播放时也会触发，那时进度提示还有意义；只有真的推进了播放位置才说明
     * 首帧已经渲染出来了。
     */
    const clearResolveOverlay = () => {
      if (video.currentTime <= 0) return;
      downloadSampleRef.current = null;
      setPrepareStatus(null);
    };

    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('progress', handleProgress);
    video.addEventListener('waiting', handleWaiting);
    video.addEventListener('playing', handlePlaying);
    video.addEventListener('playing', clearResolveOverlay);
    video.addEventListener('ended', handleEnded);
    video.addEventListener('error', handleError);

    return () => {
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('progress', handleProgress);
      video.removeEventListener('waiting', handleWaiting);
      video.removeEventListener('playing', handlePlaying);
      video.removeEventListener('playing', clearResolveOverlay);
      video.removeEventListener('ended', handleEnded);
      video.removeEventListener('error', handleError);
    };
    // 有意留空依赖：监听器只绑定一次。
    // 旧版把 currentSeries / currentEpisode / currentQuality / 播放进度这类状态 /
    // isMuted 都列进依赖，导致倒计时每秒、每次换集都全量摘绑 6 个监听器——
    // 既是性能抖动源，也有 listener 泄漏风险。所有需要的状态改由
    // handlerCtxRef 实时读取，saveProgressThrottled 用 ref 间接调用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 两条 context 的拆分（见 PlaybackActionsContextType 的说明）。
   *
   * `actionsRef` 每次渲染刷新，让下面 memo 出来的专线里放的是**稳定转发层**：
   * 调用时永远转发到最新实现，所以既不会拿到过期闭包，也不需要把每次渲染都
   * 新建的函数列进依赖（列了就等于没有 memo）。
   */
  const actionsRef = useRef<PlaybackActionsContextType | null>(null);
  actionsRef.current = {
    currentSeries,
    currentEpisode,
    isPlaying,
    volume,
    isMuted,
    playbackRate,
    currentQuality,
    availableQualities,
    isSideDrawerOpen,
    isDiagnosticsOpen,
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
    stopPlayback,
    setMuted,
    prewarmEpisode,
    enterPip,
    dismissStallNotice,
  };

  /**
   * 全量 value：**只给播放器自己**（VideoSurface / PlayerControls）。
   *
   * 它刻意不 memo：里面 12 个动作函数（openEpisode / seek / setVolume …）都是每次
   * 渲染新建的普通函数，把它们列进依赖等于没有 memo，只会让人误以为这里已经是
   * 「只在必要时才换引用」。真实语义就是「每次渲染一份新的」，写成一个普通对象
   * 更诚实 —— 而它的消费者本来就依赖 position 级别的刷新。
   *
   * 代价被限定在播放器自己的那两棵子树里：其它调用方走下一份 `actionsValue`。
   */
  const playbackValue: PlaybackContextType = {
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
        stopPlayback,
        setMuted,
        finishedAll,
        isSwitching,
        prepareStatus,
        errorDetail,
        prewarmEpisode,
        enterPip,
        stallNotice,
        dismissStallNotice,
  };

  /**
   * 低频动作专线：只有换剧 / 换集 / 开关抽屉 / 音量切档这类**用户操作**才会变，
   * 播放进度（position / buffered / duration）刻意不在其中。
   *
   * 依赖里只列低频 state —— 方法走 actionsRef 转发，所以不必（也不能）列进来。
   */
  const actionsValue = useMemo<PlaybackActionsContextType>(() => ({
    currentSeries,
    currentEpisode,
    isPlaying,
    volume,
    isMuted,
    playbackRate,
    currentQuality,
    availableQualities,
    isSideDrawerOpen,
    isDiagnosticsOpen,
    openEpisode: (seriesId, episodeId, startPosition, qualityOverride) =>
      actionsRef.current!.openEpisode(seriesId, episodeId, startPosition, qualityOverride),
    togglePlay: () => actionsRef.current!.togglePlay(),
    seek: (seconds) => actionsRef.current!.seek(seconds),
    seekRelative: (delta) => actionsRef.current!.seekRelative(delta),
    setVolume: (value) => actionsRef.current!.setVolume(value),
    toggleMute: () => actionsRef.current!.toggleMute(),
    setPlaybackRate: (rate) => actionsRef.current!.setPlaybackRate(rate),
    setQuality: (quality) => actionsRef.current!.setQuality(quality),
    playNextEpisode: () => actionsRef.current!.playNextEpisode(),
    playPrevEpisode: () => actionsRef.current!.playPrevEpisode(),
    toggleSideDrawer: (open) => actionsRef.current!.toggleSideDrawer(open),
    toggleDiagnostics: (open) => actionsRef.current!.toggleDiagnostics(open),
    stopPlayback: () => actionsRef.current!.stopPlayback(),
    setMuted: (value) => actionsRef.current!.setMuted(value),
    prewarmEpisode: (seriesId, episodeId, contentType) =>
      actionsRef.current!.prewarmEpisode(seriesId, episodeId, contentType),
    enterPip: () => actionsRef.current!.enterPip(),
    dismissStallNotice: () => actionsRef.current!.dismissStallNotice(),
  }), [
    currentSeries, currentEpisode, isPlaying, volume, isMuted, playbackRate, currentQuality,
    availableQualities, isSideDrawerOpen, isDiagnosticsOpen,
  ]);

  return (
    <PlaybackContext.Provider value={playbackValue}>
      <PlaybackActionsContext.Provider value={actionsValue}>
        {children}
      </PlaybackActionsContext.Provider>
    </PlaybackContext.Provider>
  );
};

export function usePlaybackStore(): PlaybackContextType {
  const ctx = useContext(PlaybackContext);
  if (!ctx) throw new Error('usePlaybackStore must be used within PlaybackProvider');
  return ctx;
}

/**
 * 低频动作专线：给**非播放器宿主**用（App 壳层、发现页、历史、详情、选集抽屉、
 * PipReturnBridge、诊断面板）。
 *
 * 用它可以避免「播放进度一变、整棵树跟着重渲染」：这一份里没有 position/buffered，
 * 只在换剧、换集、开关抽屉/诊断、音量切档这些**用户操作**时才换引用。
 *
 * 需要 position 级别的实时读数（进度条、时间码、诊断面板）请继续用
 * `usePlaybackStore()`——那是它存在的理由，不是漏网之鱼。
 */
export function usePlaybackActions(): PlaybackActionsContextType {
  const ctx = useContext(PlaybackActionsContext);
  if (!ctx) throw new Error('usePlaybackActions must be used within PlaybackProvider');
  return ctx;
}

/**
 * 仅读取一个字段的选择器版本。
 *
 * ⚠️ 它**只省掉解构、不省重渲染**：`useContext` 仍然订阅整个 `PlaybackContext`，
 * 播放进度一变照样重渲染。真正要摘掉高频扇出请用 `usePlaybackActions()`。
 * 保留这个 API 是因为「语义更清楚」本身有价值，但别指望它提速。
 */
export function usePlaybackSelector<T>(selector: (context: PlaybackContextType) => T): T {
  const ctx = useContext(PlaybackContext);
  if (!ctx) throw new Error('usePlaybackStore must be used within PlaybackProvider');
  return selector(ctx);
}
