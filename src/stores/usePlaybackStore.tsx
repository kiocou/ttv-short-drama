import React, { createContext, useContext, useState, useRef, useEffect, useCallback, useMemo, ReactNode } from 'react';
import { PlaybackUiState, PlaybackSession } from '../types/playback';
import { SeriesDetail, EpisodeItem } from '../types/series';
import { ipcService, isTauriEnvironment, errorText } from '../services/ipc';
import { attachSource, isHlsUrl, detachSource, takeHlsFatal, hintHlsLoadPosition } from '../services/hlsAttach';
import { dismissPip, openPip } from '../services/pip';
import { redactUrl, tracePlayback } from '../services/playbackTrace';
import { isBufferComplete, isPlayheadAtPlayableTail } from '../services/playbackTail';
import { resolveStartTarget } from '../services/playbackStart';
import { planSeek, seekableReached } from '../services/seekPlan';
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
// （这里曾有 `PREFIX_COVERAGE_SECONDS`：前缀短源时代的"续播位置超出覆盖范围就跳过前缀"判定。方案 B 用整集 HLS 后不再需要。）

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
  /**
   * 把 `<video>` 交给 store（callback ref）。
   *
   * 播放器宿主的写法必须是 `<video ref={registerVideoElement}>`——
   * 不能再用 `<video ref={videoRef}>`：那样元素被重挂时 store 感知不到，
   * 监听器会留在被丢弃的旧元素上（见 `videoElement` 那段说明）。
   */
  registerVideoElement: (element: HTMLVideoElement | null) => void;
  openEpisode: (seriesId: string, episodeId?: string, startPosition?: number, qualityOverride?: string) => Promise<void>;
  togglePlay: () => void;
  seek: (seconds: number) => void;
  seekRelative: (deltaSeconds: number) => void;
  setVolume: (vol: number) => void;
  toggleMute: () => void;
  setPlaybackRate: (rate: number) => void;
  setQuality: (quality: string) => void;
  /**
   * 视频增强（RTX VSR）当前是否开启。
   *
   * 数据源是**全局设置**（设置页与播放页共用同一个开关，落库在
   * `UserSettings.vsrEnabled`）。播放页只做"读取 + 一个写入口"，不另存一份
   * 状态——两份状态必然出现"设置页关了、播放页还显示开"。
   */
  vsrEnabled: boolean;
  /**
   * 用户在本播放页拨动 VSR 开关。
   *
   * 这里**只写设置**：让当前这一集立即重走新链路的动作统一由 Provider 内那个
   * 监听 `settings.vsrEnabled` 的 effect 负责。设置页与播放页因此走同一条生效
   * 路径——不会出现"设置页改了实时生效、播放页改了要退出再进"。
   */
  setVsrEnabled: (enabled: boolean) => void;
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
   * 当前正在播的流地址（本地 HLS / 直链）。补帧窗口要用它自己起播，
   * 所以必须能从这里取到「眼前这一集」的真实地址，而不是重新解析一次。
   */
  getCurrentStreamUrl: () => string;
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
  /**
   * 「这一段还没转好」提示，null 表示不显示。
   *
   * ## 为什么与 `stallNotice` 分开（2026-10-24）
   *
   * 两者说的完全不是一件事：
   *   - `stallNotice`：画面**卡住了**，正在自动恢复（看门狗判停滞）；
   *   - 这个：用户点了进度条上还没转好的位置，播放**没有出问题**，只是那段
   *     内容还在转码。用户要做的动作也不同（前者等它自愈，后者再点一次）。
   *
   * 合成一个字段就会出现"点了结尾 → 弹'画面卡住了，正在尝试恢复'"这种
   * 误导性文案 —— 画面根本没卡，是用户点到了还没转好的地方。
   *
   * 生命周期同样由 store 管，且**必须**在换集 / 新的一次 seek / 恢复播放时清空，
   * 否则它会一直挂在画面上。
   */
  seekNotice: string | null;
  /** 用户手动关掉「还没转好」提示。 */
  dismissSeekNotice: () => void;
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
  // `registerVideoElement` 与 `videoRef` 同理：只有播放器宿主（VideoSurface）
  // 需要它，非播放页宿主拿到它也没有元素可挂。
  | 'registerVideoElement'
  // `seekNotice` 只服务播放器自己的画面提示（VideoSurface），非播放器宿主
  // （发现页/详情页/历史/小窗桥）拿到它也没有地方渲染，不进低频动作专线。
  | 'seekNotice'
  // `vsrEnabled` 只有播放器控制条需要（`PlayerControls` 用整表）。留在专线里
  // 会让"拨一下开关"重建 `actionsValue` 并广播给发现页/详情页/历史页，
  // 而它们一个都用不上。写入函数 `setVsrEnabled` 仍留在专线上（引用稳定）。
  | 'vsrEnabled'
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

/**
 * 后台整集预热的并发上限。
 *
 * **它必须与「当前是否在跑流式转码」联动**——这是实测踩出来的：
 * 用户会同时看到三路 ffmpeg 在抢 CPU（两路预取 + 一路流式），结果是正在播的
 * 那一集整集重编码从 7 秒涨到 26–43 秒，而流式分片也来不及生成，播放器等不到
 * 分片 → hls.js 重试耗尽 → 弹错误卡片。用户看到的正是「点进去转圈然后报错」。
 *
 * 所以：**流式转码在跑时一律不接新的整集预热**（0）。流式那段通常只有几十秒，
 * 让 CPU 优先保证「正在看的那一路」远比多备一集重要。
 *
 * **上限是 1 而不是 2**（2026-10-09 实测下调）：显卡上的编码单元是**串行**的 ——
 * 两路 NVENC 同时跑实测 9455ms + 9407ms，四路 20060ms × 4，总时长不因并发而减少，
 * 只是把正在播的那一路挤慢。预热的唯一目的是"换集时产物已就绪"，而热备**一集**
 * 就够覆盖连播；备两集换来的收益是零，代价是播放卡顿。
 */
const MAX_PREWARM_INFLIGHT = 1;

/**
 * 流式转码是否正在为本会话服务。
 *
 * 用模块级计数而不是 React state：预热闸门要在**同步路径**上读它（`startPrewarmResolve`
 * 的开头），而 state 更新要等下一次渲染才可见，用它挡不住同一帧里已经排队的预热。
 */
let streamingSessionsActive = 0;

/**
 * 代际号：**只在开转码窗口时自增**（`beginStreamingWindow`），复位刻意不推进它。
 *
 * 复位后仍安全的原因：若这一集又起了流式，`beginStreamingWindow` 必然换代，旧延时
 * 回调照样失效；若不再起流式，计数已经被复位成 0，旧回调那次递减落在 `Math.max(0, …)`
 * 上，不会把任何东西减成负数。
 *
 * 为什么需要它：窗口的释放有一个**延时**（`STREAMING_TRANSCODE_SETTLE_MS`），
 * 而延时回调是无主的 —— 若用户在这 6 秒内换集，`resetStreamingWindow()` 已经把
 * 计数清零，随后那个旧回调仍会执行一次递减，把**新会话**的计数减掉，预取闸门
 * 于是提前放开，本集转码与下一集的 worker 又会抢 CPU（审查 F2）。
 *
 * 有了代际号，延时回调只在自己那一代仍然有效时才减。
 */
let streamingGeneration = 0;

function streamingInFlight(): boolean {
  return streamingSessionsActive > 0;
}

/**
 * 计数归零的最后一道保险。
 *
 * 为什么需要它：这个计数会**闸住整条整集预取链路**。只要有一条路径漏了释放
 * （会话在某个 await 里被判废弃、异常提前 return、组件卸载导致续体不再跑），
 * 计数就永久停在 1，之后所有预取静默失效——而症状只是"下一集变慢了"，
 * 几乎不可能与这里联系起来。与其指望每条 return 都记得配对，不如给它一个上限：
 * 流式转码的正常服务窗口就是几十秒（整集落盘后被替换），超过这个时间一定已经
 * 不再服务于本次播放。
 */
const STREAMING_WINDOW_MAX_MS = 90_000;

/**
 * 出画之后、还要再按住预取闸门多久。
 *
 * 依据：整集转码实测 5.6 秒（92.7 秒正片），而首片 1.3 秒就绪 —— 出画时转码
 * 大约还剩 4 秒。取 6 秒留一点余量，覆盖"源偏慢导致转码超出平均"的情况。
 * 转完之后 `start_video_cache` 会把产物按 vid 缓存下来，换集回来也不用再转。
 */
const STREAMING_TRANSCODE_SETTLE_MS = 6_000;
let streamingWindowTimer: ReturnType<typeof setTimeout> | null = null;

/** 进入流式转码窗口：占用 CPU 期间暂停整集预取。 */
function beginStreamingWindow(): void {
  streamingSessionsActive += 1;
  streamingGeneration += 1;
  const generation = streamingGeneration;
  if (streamingWindowTimer) clearTimeout(streamingWindowTimer);
  streamingWindowTimer = setTimeout(() => {
    // 代际不符说明这一轮窗口早已结束（换集复位过）：什么都不做。
    if (generation !== streamingGeneration) return;
    if (streamingSessionsActive > 0) {
      tracePlayback(`流式转码窗口超时（${STREAMING_WINDOW_MAX_MS / 1000}s），强制放开预取闸门`);
    }
    streamingSessionsActive = 0;
    streamingWindowTimer = null;
  }, STREAMING_WINDOW_MAX_MS);
}

/**
 * 延时结束窗口：给出画后的整集转码留出余量。
 *
 * 带回代际校验，理由见 `streamingGeneration` 的注释。
 *
 * ⚠️ 2026-10-21：这个余量必须**按整集转码时长**算，不能按"出画后再等一会儿"。
 *
 * 实测（ttv-playback.log）：
 *   228.5s 预转开始（槽位 1000606）→ 269.6s 才转完，**耗时 41062ms**
 *   而闸门在出画后 6 秒就放开了 —— 于是预取与正在播的那一路并行，
 *   NVENC 串行，两边都变慢。用户感受到的是"拖动要等 1.7 秒""切集要等 4 秒"。
 *
 * 正常情况下一集转码只要 3~10 秒（13~29 倍实时），但被抢时会恶化到 40 秒以上。
 * 所以这里把窗口下限抬到 8 秒、上限 24 秒：宁可预取晚一点，也不要和播放抢。
 * 上限仍由 `STREAMING_WINDOW_MAX_MS` 兜底，不会永久占着闸门。
 */
function endStreamingWindowAfter(ms: number): void {
  const settleMs = Math.min(24_000, Math.max(ms, 8_000));
  const generation = streamingGeneration;
  window.setTimeout(() => {
    if (generation !== streamingGeneration) return;
    endStreamingWindow();
  }, settleMs);
}

/** 退出流式转码窗口：递减，真正归零由超时兜底。 */
function endStreamingWindow(): void {
  streamingSessionsActive = Math.max(0, streamingSessionsActive - 1);
  if (streamingSessionsActive === 0 && streamingWindowTimer) {
    clearTimeout(streamingWindowTimer);
    streamingWindowTimer = null;
  }
}

/**
 * 硬复位：换集时用。
 *
 * 与 `endStreamingWindow` 的差别是语义而非数值：换集意味着**上一个会话整体作废**
 * （`playback_command stop` 已经把它那一路 ffmpeg 收掉了），所以这里不需要、
 * 也不应该去猜"上一条链路自己减没减"——直接归零即可。用递减的话，只要有一条
 * 路径漏了配对，计数就会慢慢涨上去并把整集预取永久关掉。
 */
function resetStreamingWindow(): void {
  streamingSessionsActive = 0;
  if (streamingWindowTimer) {
    clearTimeout(streamingWindowTimer);
    streamingWindowTimer = null;
  }
}

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
/**
 * 当前 HLS 源的**真实总时长**（秒）。0 表示未知。
 *
 * 为什么是模块级变量而不是组件里的 ref：`usableDuration` 是模块级纯函数
 * （`timeupdate` 监听器里每帧都调它），拿不到组件的 ref。而这个值在任一时刻
 * 只有"当前那一集"的含义，模块级单例正好对应。
 *
 * 写入点在流式开播成功处（后端 `open_stream` 给的 `durationMs`），
 * 清零点在 `resetStreamingSource`（换源/换集/退出播放器）。
 */
let streamingSourceTotalSeconds = 0;
function usableDuration(video: HTMLVideoElement): number {
  // 权威来源：**后端下发的源片真实时长**（`streamingSourceTotalRef`）。
  //
  // 为什么它必须优先：方案 B 的播放源是边解密边转的 HLS，转码没结束时清单里
  // 只有已切好的分片、`#EXT-X-ENDLIST` 还没写，于是 `video.duration` 要么是
  // `Infinity`、要么等于「已转到的位置」。旧实现直接退回下面那段
  // `seekable`/`buffered` 末尾的兜底 —— 而那两个值**随转码进度增长**，
  // 用户看到的时长于是一路往上跳（用户报的「时长显示不稳定」）。
  //
  // 只要拿到了源片总时长，它就是这个文件的客观属性，与转码进度无关。
  const authoritative = streamingSourceTotalSeconds;
  if (Number.isFinite(authoritative) && authoritative > 0) return authoritative;
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
  if (candidates.length === 0) return 0;
  const fallback = Math.max(...candidates);
  /**
   * ## 兜底值的下限保护（2026-10-19 修「断点续播时有时无」）
   *
   * `seekable` / `buffered` 的末端在**转码刚开始**时可能只有零点几秒
   * （实测日志里出现过 `0.1s`）。把这个值当总时长会让 `percent` 直接爆到 100%，
   * 于是 `isFinished` 被误置位、这一集从续播候选里消失。
   *
   * 1 秒以下一律视为"还没准备好"，返回 0 让调用方走 `duration=0` 分支
   * （后端对 duration=0 只更新元数据、保留旧进度，不会把已有进度冲掉）。
   * 这个阈值不设更高：真的只有 0.5 秒的源不存在，而"刚起播还没缓冲"极常见。
   */
  return fallback >= 1 ? fallback : 0;
}

/**
 * 元素上记录的事件是否属于**已经作废**的会话（迟到事件）。
 *
 * ## 为什么必须允许"没有标记"通过（2026-10-19 / 10-20 两次踩同一个坑）
 *
 * `dataset.sessionId` 只在赋 `src` / 挂 hls 的那一刻写入。首帧真正落地之前，
 * 它可能是空串 —— `Number('') === 0`、`Number(undefined) === NaN`，而会话号
 * 从 100 起（小窗从 9e8 起），于是"不相等就丢弃"会在**这段窗口里把所有事件
 * 全部丢掉**：
 *
 *   - `timeupdate`：画面在播（媒体元素与 React 无关），进度条与历史进度全不动；
 *   - `playing`：界面永远停在 opening/buffering；
 *   - `error`：hls.js 的 fatal 被整个吞掉，不弹卡、不自愈、也不留日志。
 *
 * 三次都是同一个判据写错。所以判据只留这一份，且只在**标记确实存在且为正数**
 * 时才比对——"没有标记"是未知状态，放行由各调用点自身的其它守卫兜底。
 */
function isStaleElementSession(video: HTMLVideoElement, activeSessionId: number): boolean {
  const tagged = Number(video.dataset.sessionId);
  return Number.isFinite(tagged) && tagged > 0 && tagged !== activeSessionId;
}

/** 当前媒体元素最后一个连续缓冲区间的末端；没有可读区间时返回 0。 */
function bufferedEndSeconds(video: HTMLVideoElement): number {
  try {
    if (video.buffered && video.buffered.length > 0) {
      return video.buffered.end(video.buffered.length - 1);
    }
  } catch {
    // 尚未就绪的媒体元素访问 buffered 可能抛错：按“没有缓冲信息”处理。
  }
  return 0;
}

/**
 * 把"这一集该从哪开始"真正落到媒体元素上。
 *
 * ## 为什么需要显式做这件事（2026-10-19）
 *
 * 播放器只有一块常驻 `<video>`，换集时**不换元素**：靠设置新 `src`（或 hls.js 重建
 * MSE）让浏览器重置 `currentTime`。规范上那会把位置清 0，但 `hls.js` 的
 * `startPosition` 默认值是 **-1**，语义是"拿 `media.currentTime` 当起点"——
 * 也就是说新一集的起播点取决于这一刻元素上残留的值。一旦换源时序上出现
 * "先 attach、后重置"的窗口，新一集就会从**上一集的位置**开始播，
 * 用户看到的就是"进度条不在 0、从某个莫名其妙的时间点继续"。
 *
 * 所以这里不再假设"设了 src 就一定是 0"：目标位置由调用方给定（连播/点下一集
 * 一律是 0，续播是保存的进度），偏移超过 0.5 秒时打点——这是该症状唯一的现场证据。
 */
function alignPlayhead(video: HTMLVideoElement, startPosition: number, sessionId: number): void {
  const resolved = resolveStartTarget({
    startPosition,
    duration: video.duration,
    currentTime: video.currentTime,
  });
  if (resolved.clampedFromEnd) {
    tracePlayback(
      `起播点越界（${startPosition.toFixed(1)}s ≥ 时长 ${video.duration.toFixed(1)}s），改为从头播 会话=${sessionId}`,
    );
  }
  if (resolved.drifted) {
    tracePlayback(
      `起播点收敛 期望=${resolved.target.toFixed(2)}s 元素现值=${(Number.isFinite(video.currentTime) ? video.currentTime : 0).toFixed(2)}s 会话=${sessionId}（换源没有重置位置，强制归位）`,
    );
  }
  try {
    video.currentTime = resolved.target;
  } catch {
    // `readyState === HAVE_NOTHING` 时给 currentTime 赋值会抛 InvalidStateError。
    // 那种状态下位置天然是 0，随后的 `loadedmetadata` 会再次校准，不必在这里补救。
  }
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
 * 看门狗判"停滞点就在可播末端"的窗口。
 *
 * 比 `handleWaiting` 的 2.5 秒更宽：走到这里说明时钟、解码帧、缓冲三者
 * 已经连续 `PLAYBACK_STALL_MS`（10 秒）没有任何推进 —— 不可能还有数据在路上，
 * 再把窗口收窄只会让"最后 3~5 秒分片永远没落地"的那类样本漏掉。
 */
const TAIL_END_STALL_WINDOW_SECONDS = 5;

/**
 * 末尾复核窗口（`waiting` 命中"停在可播末端"之后的确认时间）。
 *
 * 为什么是 1.2 秒：本机回环上 hls.js 拉一片只需亚毫秒级，真还有数据在路上，
 * 这段时间里 `buffered.end` 必然已经前进；而倍速切换 / 解码抖动造成的瞬时
 * `waiting` 也会在下一个 `timeupdate` 自行恢复（那会直接撤销这次复核）。
 * 再短会让慢盘上的正常追加被误判成播完，再长则用户要盯 1 秒多的转圈。
 */
const TAIL_PROBE_DELAY_MS = 1200;

/**
 * 流式源就地重挂的额度与等待时间。
 *
 * 与 `hlsAttach` 的内层自愈（`MAX_IN_PLACE_RECOVERY`，针对 MSE/网络明细）构成两级：
 * 内层处理"hls.js 自己能修的"，这里处理"要重新问后端点名才能续转的"。
 * 两级都成功即回血，都失败才判死。
 */
const MAX_STREAM_RECOVER = 2;

/**
 * 重挂前的等待：给后端一拍时间去发现产物不完整并重新起 ffmpeg。
 *
 * 取 1200ms 与末尾复核同一个量级——短到用户还在看最后一帧，长到后端已经有反应。
 */
const STREAM_RECOVER_DELAY_MS = 1200;

/**
 * 拖到未转码区域后的等待参数。
 *
 * 转码是 13~29 倍实时，所以"缺的那几秒内容"通常几百毫秒就补上了。轮询间隔取
 * 250ms（比一个分片短一个数量级，用户感知不到延迟），超时取 8 秒 —— 覆盖
 * "要等 30 秒内容"这种最坏情况（30/15≈2 秒）仍有 4 倍余量。
 *
 * 超时后的兜底是重开这一集，不是继续等：转码真卡死时等下去没有意义。
 */
const SEEK_WAIT_POLL_MS = 250;
const SEEK_WAIT_TIMEOUT_MS = 8000;

/**
 * 一次播放生命周期内，流式源恢复的**总预算**（次数 + 时间）。
 *
 * ## 为什么需要总预算（2026-10-20）
 *
 * 恢复有三层，原本各自独立计数，叠加起来没有上界：
 *
 *   1. hls.js 内层：`MAX_IN_PLACE_RECOVERY`（2 次），每次自动重来；
 *   2. 本层：`MAX_STREAM_RECOVER`（2 次），每次 1.2 秒后重新 open_stream；
 *   3. 看门狗：10 秒停滞 → 原地重试 2 秒 → 重装载整集。
 *
 * 实测叠加结果（ttv-playback.log 会话 104）：100.8s 首次失败 → 247.2s 才把
 * 内层额度耗尽 → 256.6s 才把本层额度耗尽，期间约 180 条 `fragLoadError`，
 * 界面在缓冲态锁了 **158 秒**。用户看到的只有"卡住不动"，没有任何提示，
 * 也没有出口。
 *
 * 现在给"同一集的同一份源"一个总账：次数与时间任一超限即进入终态，
 * 如实报错而不是继续无声重试。终态必须让用户看见、并且可退出。
 */
const STREAM_RECOVERY_TOTAL_BUDGET = 4;
const STREAM_RECOVERY_DEADLINE_MS = 25_000;

/**
 * 单次流式源恢复的总账。
 *
 * `episodeKey` 换了（换集）或 `resetStreamingSource()` 被调用时清零 ——
 * 预算属于"这一集的这一份源"，不该跨集继承。
 */
interface StreamRecoveryLedger {
  attempts: number;
  startedAt: number;
}

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
    /**
     * 停住的其实是"可播末端"：这一集已经播完了，别再 seek / 重装载。
     *
     * 末尾卡住时时钟/帧/缓冲三个信号与"解码线程卡死"完全一致，但处置相反：
     * 那里没有下一帧可救，seek 回原处与重装载同一集都只会原地重演。
     * 判据交给 `isPlayheadAtPlayableTail`（放宽到 5 秒窗口：此时已经确认
     * 10 秒没有新数据进来），由它回落到 `handleEnded` 的完整语义。
     *
     * @returns 是否真的接手处理。返回 `false` 表示"这一拍没处理，下一拍再来"——
     *          看门狗据此决定 `stalled` 是否置位，否则它会永久停摆（见调用点）。
     */
    onTailEnd: () => boolean;
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
    // 停住的地方是可播末端 → 这一集其实已经播完了（见 `onTailEnd` 的说明）。
    // 必须先于 onRetry 判定：末尾没有下一帧可救，seek 回原处会把末帧倒带闪回，
    // 重装载同一集也只是把同一段结尾再卡一次。
    if (
      isPlayheadAtPlayableTail(
        {
          currentTime: video.currentTime,
          duration: usableDuration(video),
          bufferedEnd: bufferedEnd(),
          paused: video.paused,
          seeking: video.seeking,
          ended: video.ended,
          playbackRate: video.playbackRate,
        },
        TAIL_END_STALL_WINDOW_SECONDS,
      )
    ) {
      tracePlayback(
        `看门狗：停滞点在可播末端，按本集播完处理 current=${video.currentTime.toFixed(2)}s duration=${usableDuration(video).toFixed(2)}s buffered=${bufferedEnd().toFixed(2)}s`,
      );
      // ⚠️ `stalled` 只在回调**真的处理了**才置位（2026-10-20 复查修正）。
      //
      // 原先无条件先置 true 再调回调：而回调里有两处早退（会话已作废 / 用户暂停、
      // 拖进度、已 ended）。一旦早退，本函数此后每一拍都会被 `stalled` 挡在门口，
      // 既不重试、也不升级、也不再判末尾 —— 看门狗就此静默死亡，用户对着屏幕
      // 没有任何出口，直到手动点一下触发 `handlePlaying` 重新武装。
      //
      // 回调返回 false 时把 `stalled` 放回 false，下一拍（700ms 后）重新判断：
      // 末尾判定是幂等的，重复进入没有副作用，而"静默死亡"没有第二次机会。
      stalled = callbacks.onTailEnd() !== false;
      return;
    }
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
  //
  // `updateSettings` 供播放页的「增强」浮层使用（VSR 开关与设置页同一份数据）。
  const { settings, updateSettings } = useSettingsStore();
  /**
   * 视频增强（RTX VSR）开关：设置里的值是**唯一真相**。
   *
   * `!== false` 与设置页、`useSettingsStore` 的归一化完全同款：旧设置记录里没有
   * 这个字段时展开是 `undefined`，必须落到"开"（Rust 侧 `AtomicBool` 初值也是开）。
   */
  const vsrEnabled = settings.vsrEnabled !== false;
  /**
   * VSR 开关的即时镜像。
   *
   * 预取调度发生在**定时器**与**异步续体**里（`scheduleNextEpisodePrewarm`、
   * `startFull().then(...)`），那里的闭包读不到最新渲染值；而这些调度必须
   * 按"当前开关"决定预取哪种产物（整集 HLS / 整集 mp4）。
   */
  const vsrEnabledRef = useRef(vsrEnabled);
  vsrEnabledRef.current = vsrEnabled;
  /**
   * 「视频增强」的代际号。
   *
   * ## 为什么需要它
   *
   * 开关变化后要让当前这一集重走新链路，做法是拿同一位置、同一档清晰度再调一次
   * `openEpisode`。而 `openEpisode` 对"同键在途"会去重，键里只有
   * `剧|集|取整位置|清晰度`——**没有任何一位能区分链路**。
   *
   * 于是两种真实场景会静默失效：
   *   1. 首播还在解析时用户拨开关：键完全相同，命中旧任务（旧链路），开关"没反应"；
   *   2. 暂停在片头（位置 0）时连拨两次：两次键相同，第二次复用的还是第一次那条。
   *
   * 每次开关变化自增一位，键就与新链路绑定，旧任务绝不会被复用。
   */
  const enhanceEpochRef = useRef(0);
  const [sessionId, setSessionId] = useState<number>(100);
  const [currentSeries, setCurrentSeries] = useState<SeriesDetail | null>(null);
  const [currentEpisode, setCurrentEpisode] = useState<EpisodeItem | null>(null);
  /**
   * `currentSeries` / `currentEpisode` 的镜像 ref。
   *
   * 用途只有一个：`scheduleNextEpisodePrewarm` 的**定时器回调**里要读最新的
   * 剧与集。定时器是几百毫秒到二十几秒后才触发的，闭包捕获的那份 React state
   * 早已过期（用户可能已经换剧、切集、离开播放器），必须读到当前值才能判断
   * "这次调度是否还该发车"。
   *
   * 不用 `useEffect` 同步而是直接赋值：ref 的写入必须在**渲染阶段**完成，
   * 才能保证同一帧里任何同步路径读到的都是最新值（与 `openEpisodeRef`
   * 的写法一致）。写 ref 不是副作用，不会引起额外渲染。
   */
  const currentSeriesRef = useRef<SeriesDetail | null>(null);
  const currentEpisodeRef = useRef<EpisodeItem | null>(null);
  currentSeriesRef.current = currentSeries;
  currentEpisodeRef.current = currentEpisode;
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
   * 连播预取的去重标记（`seriesId:episodeId`）。
   *
   * 调度点挂在 `timeupdate` 上，每秒会触发 4 次；不去重就会反复发车。
   * 只记"最近一次预取的是哪一集"，因为连播是单向前进的——用户切到下一集后
   * 这个键自然变成新的，不需要保存整个历史。
   */
  const prewarmedNextRef = useRef<string>('');
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
  /**
   * 当前挂载的媒体元素（**元素身份**，不只是 ref）。
   *
   * ## 为什么需要它（2026-10-25 修「进度条 00:00 / 00:00」）
   *
   * 媒体监听器（timeupdate / waiting / playing / ended / error）只能绑在**具体的
   * 那个 `<video>` 元素**上，而它们所在的 effect 依赖是 `[]` —— 「只绑定一次」
   * 是刻意的（历史上把十几个 state 列进依赖，导致倒计时每秒都把 6 个监听器
   * 摘一遍再绑一遍）。
   *
   * 但一旦 `<video>` 被重挂（开发期 HMR 热替换 `VideoSurface`、宿主被 React
   * 重建、任何原因换了元素），这份"只绑一次"就永久失效：新元素在播，事件却全
   * 发给那块被丢弃的旧元素。现场表现就是本项目反复踩到的那组症状：
   *
   *   - 进度条永远 `00:00 / 00:00`、拖不动；
   *   - 到结尾不触发 `ended`（连播不生效、停在最后一帧）；
   *   - 旧的 `<video>` 仍在解码，整机观感变卡。
   *
   * 日志实证（本次）：`首帧-宿主 监听器已绑定 video` 只出现在 559s，
   * 之后一千秒里 `timeupdate 心跳`（每 5 秒一条）一条都没有。
   *
   * 所以绑定必须由**元素身份**驱动：`<video ref={registerVideoElement}>` 在
   * 挂载/卸载时把元素写进来，effect 依赖它 —— 换元素就自动重绑。
   */
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null);
  const registerVideoElement = useCallback((element: HTMLVideoElement | null) => {
    // 两个都要写：`videoRef.current` 是全文件几十处同步读的地方（起播、seek、
    // 看门狗），不能只留 state；state 只负责触发"元素变了 → 重绑监听器"。
    videoRef.current = element;
    setVideoElement(element);
  }, []);
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
  // 注：这里曾有 `prefixSourceRef`（记录「画面挂在只有开头一段的短源上」）。
  // 方案 B 之后播放源是整集 HLS，不再存在"片段播到头"这种状态，故移除。

  /**
   * 把「当前源是流式 HLS」的标记复位。
   *
   * 必须有这个统一出口：这个标记会让 `handleError` 跳过备用直链与 Blob 两步
   * （对本地 HLS 是正确的），但如果忘了复位，**下一次播放会继承它** ——
   * 于是「退出播放器后重进同一集、且在转码完成前又失败」时，错误再次被静默
   * 跳过，用户看不到任何提示（审查的 F3）。三个换源入口都调它。
   */
  const resetStreamingSource = () => {
    streamingSourceRef.current = false;
    // 地址与自愈额度都属于"这一集的这一个源"，换源即失效。
    streamUrlRef.current = '';
    streamRecoverRef.current = 0;
    // 恢复总账同理：次数与起点都属于"这一集的这一份源"。
    streamRecoveryLedgerRef.current = null;
    // 挂起的那次自愈同理：它绑的是旧源的位置与旧会话，换源之后落地就是错的。
    cancelStreamRecover();
    // 时长权威值属于"这一集的这一个源"，换源即失效。
    streamingSourceTotalSeconds = 0;
  };

  /**
   * 当前画面是否挂在**本地流式 HLS**（`127.0.0.1/rtx/...` 那个 m3u8）上。
   *
   * 为什么需要这个标记：`handleError` 的三级兜底链里有一段会 `fetch(currentSrc)`
   * 再把结果包成 Blob 重播——那对**文件**是对的，对流式 HLS **必然失败**：
   * `currentSrc` 是一个 m3u8 播放列表，fetch 回来的是几百字节文本，当成媒体源
   * 只会再报一次错，最终把用户送到「该媒体无法由 WebView 解码」那张卡片上。
   * 而真实情况往往只是「转码还没吐出新分片」，等一两秒自己就好了。
   *
   * 所以流式源出错时直接跳过 Blob 那一步（备用直链也跳过：它是同一个源的
   * 加密直链，WebView 解不了 CENC）。正确动作只有一个：让整集链路接管。
   */
  const streamingSourceRef = useRef<boolean>(false);

  /**
   * 当前这一集流式 HLS 的原始地址（`http://127.0.0.1:.../rtx/{session}/index.m3u8`）。
   *
   * 为什么要单独记：`video.currentSrc` 在 hls.js 接管后是 `blob:`（MSE 句柄），
   * 拿它重挂没有任何意义；而分片临时失败时的正确动作就是"用同一个 m3u8 再挂一次"。
   */
  const streamUrlRef = useRef<string>('');

  /**
   * 本集已经用掉几次"流式源就地重挂"。
   *
   * 上限见 `MAX_STREAM_RECOVER`：第一次覆盖"分片还没生成"，第二次覆盖"hls.js
   * 已经把 MSE 状态搞乱"。用尽仍失败才判死——那时才是真的播不了，弹错误卡不算冤。
   * 换集 / 换源时由 `resetStreamingSource` 清零；**自愈成功后也会清零回血**，
   * 否则一集里攒够两次互不相关的瞬时故障就永久判死。
   */
  const streamRecoverRef = useRef<number>(0);

  /**
   * 挂起中的"流式源就地重挂"定时器。
   *
   * 必须登记（2026-10-20 复查修正）：原先是裸 `window.setTimeout`，回调体会
   * `openStreamNative` → `attachSource` → `playBounded`，而它只靠会话号守卫。
   * `stopPlayback` 会让守卫成立，但 **HMR / StrictMode 重挂载不会改会话号** ——
   * 那时定时器照样落地，把新源挂到一块已经卸载的元素上。
   */
  const streamRecoverTimerRef = useRef<{ timer: number; sessionId: number } | null>(null);

  /** 收掉挂起中的自愈定时器（没有就什么都不做）。 */
  const cancelStreamRecover = useCallback(() => {
    if (streamRecoverTimerRef.current) {
      window.clearTimeout(streamRecoverTimerRef.current.timer);
      streamRecoverTimerRef.current = null;
    }
  }, []);

  /**
   * 流式源恢复的总账（见 `STREAM_RECOVERY_TOTAL_BUDGET`）。
   *
   * 与 `streamRecoverRef` 的区别：那个是"还允许再重开几次"的**额度**，成功后
   * 会回血；这个是"这一集的这一份源到底折腾了多久几次"的**总账**，只增不减，
   * 因为它是"该不该放弃"的判据 —— 回血的话就又会变成无界重试。
   */
  const streamRecoveryLedgerRef = useRef<StreamRecoveryLedger | null>(null);

  /**
   * 申请一次恢复机会。返回 `null` 表示预算充足，否则返回"为什么耗尽"。
   *
   * 调用点必须在真正发起恢复**之前**调用它，这样超限时不会再多排一个定时器。
   */
  const claimStreamRecovery = (): { reason: string } | null => {
    const now = performance.now();
    const ledger = streamRecoveryLedgerRef.current
      ?? { attempts: 0, startedAt: now };
    streamRecoveryLedgerRef.current = ledger;
    if (ledger.attempts >= STREAM_RECOVERY_TOTAL_BUDGET) {
      return {
        reason: `恢复次数已达上限（${ledger.attempts}/${STREAM_RECOVERY_TOTAL_BUDGET}）`,
      };
    }
    if (now - ledger.startedAt >= STREAM_RECOVERY_DEADLINE_MS) {
      return {
        reason: `恢复总时长已超限（${Math.round(now - ledger.startedAt)}ms / ${STREAM_RECOVERY_DEADLINE_MS}ms）`,
      };
    }
    ledger.attempts += 1;
    return null;
  };


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
   * 「这一段还没转好」提示（见 `PlaybackContextType.seekNotice`）。
   *
   * 与 `stallNotice` 分开：一个说"画面卡住了，正在自愈"，一个说"你点的地方还没
   * 转好，再点一次"。合成一个字段会给出误导性文案。
   */
  const [seekNotice, setSeekNotice] = useState<string | null>(null);
  const dismissSeekNotice = useCallback(() => setSeekNotice(null), []);

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

  /** 已经打过"timeupdate 丢弃"日志的会话号：同一会话只打一次，避免刷屏。 */
  const staleTickNotedRef = useRef<Set<number>>(new Set());

  /**
   * 末尾停滞复核的挂起任务。
   *
   * `waiting` 是**一次性事件**：播到末尾卡住时它只来一次（或来几次后彻底沉没），
   * 没有第二次机会重新判定。所以命中的那一帧只能"预约一次复核"，
   * 1.2 秒后再看：时钟没动、缓冲没长、仍在末尾 → 这才算这一集播完了。
   *
   * 这个窗口是 0.2.20 那版回归的分界线：它把"数据已完整缓冲"直接当成
   * "不能判播完"，于是末段全部进缓冲、播放头却差几十毫秒走不到 `duration`
   * 的那一类（实测 `buffered.end` 与 `duration` 只差 0.00~0.07 秒）永远没有出口。
   */
  const tailProbeRef = useRef<{
    timer: number;
    /** 预约时的播放位置：`timeupdate` 用它判断"画面其实还在走"，是复核的反证。 */
    position: number;
  } | null>(null);

  /**
   * 末尾**静默**兜底（2026-10-25 新增，修「关掉 VSR 后播到结尾卡住不播」）。
   *
   * ## 它解决的是哪一类
   *
   * `handleWaiting` 里那套末尾复核只认 `waiting` 事件 —— 而现场有一种更糟的
   * 情况：**没有任何事件**。日志里只看到 `playing`，之后 `timeupdate 心跳`
   * （每 5 秒必打一条）整段消失，既没有 `waiting` / `error`，也没有 `ended`。
   * 媒体时钟停走，界面停在最后一帧 —— 用户说的"卡住就不播放了"。
   *
   * 这种状态下所有事件驱动的兜底（waiting 复核、卡死看门狗、`ended`）**都不会
   * 被触发**，只能靠一个与媒体事件无关的轮询来收尾。
   *
   * ## 判据（三条同时成立才收）
   *
   *   1. 仍在播放态（`!paused && !ended && !seeking`）—— 用户暂停在结尾看画面、
   *      或正在拖动，都不算卡住；
   *   2. 播放头已在末尾 1.2 秒窗口内；
   *   3. 连续 3 拍（每拍 1 秒）位置变化 < 0.05 秒。
   *
   * 倍速播放时第 3 条天然不成立（1 秒推进 1.5~3 秒），不会误判；这也是为什么
   * 用"位置停滞"而不是"过了多少秒"做判据。
   *
   * 命中后直接走 `handleEnded` 的完整语义（落盘 100%、连播闩锁、末集返回详情），
   * 不另写一套结算逻辑 —— 一集只能被结算一次这件事由 `tryClaimAutoAdvance` 保证。
   */
  const tailEndGuardRef = useRef<number | null>(null);
  const stopTailEndGuard = useCallback(() => {
    if (tailEndGuardRef.current !== null) {
      window.clearTimeout(tailEndGuardRef.current);
      tailEndGuardRef.current = null;
    }
  }, []);

  const cancelTailProbe = useCallback(() => {
    if (tailProbeRef.current) {
      window.clearTimeout(tailProbeRef.current.timer);
      tailProbeRef.current = null;
    }
  }, []);


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
      // 这里换上的是真实的本地媒体文件：兜底链可以从"流式源"模式退出来了。
      // ⚠️ 必须走统一出口 `resetStreamingSource()` 而不是只写 ref：它同时清掉
      // "时长权威值"。只清 ref 的话，连播命中这条快路径时新集会**沿用上一集的总时长**
      // —— 进度条拖不过旧时长、`saveProgressThrottled` 的百分比虚高、历史被误判
      // "已看完"（审查 F1，本次唯一的致命项）。
      resetStreamingSource();

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

      // 起播点收敛（见 `alignPlayhead`）：目标是 0 也要显式写一次，
      // 不能依赖"设了 src 浏览器就会把位置清 0"。
      alignPlayhead(video, startPosition, sessionId);
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
      // 这里喂给 <video> 的是真实媒体文件，不再是本地 HLS：兜底链恢复常规分支。
      resetStreamingSource();

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
      alignPlayhead(video, startPosition, sessionId);
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
      //
      // 第三个参数是**起播点**：hls.js 默认（`startPosition: -1`）会拿元素残留的
      // `currentTime` 当起点，而换集不换元素 —— 不显式给，新一集就会从上一集停下的
      // 位置拉流。这里的 `alignPlayhead`（下方）虽然也会写 `currentTime`，但那是
      // 挂载**之后**的事，hls.js 的起点在 `loadSource` 那一刻就定了。
      await attachSource(video, hlsUrl, startPosition);
      markSourceCommitted(sessionId, episodeId);
      await firstFrameReady;
      if (activeSessionRef.current !== sessionId) return 'stale';
      // 判死必须同时看 hls.js 的标记。
      //
      // `hls.js` 判 fatal 时我们只能 `dispatchEvent(new Event('error'))`，而它**不会**
      // 设置 `video.error`（只读的 MediaError）。旧实现只判 `video.error`，于是这次
      // 失败被完全忽略，代码继续走到 `startPlayback`，在无源可载的 `<video>` 上等满
      // 有界看门狗（实测 8000ms，占那次 15.7 秒首屏的 51%）。
      const hlsFatal = takeHlsFatal(video);
      if (video.error || hlsFatal) {
        noteFailure('流式 HLS 失败', video.error ?? new Error(hlsFatal ?? '未知'));
        return 'error';
      }
      video.playbackRate = playbackRateRef.current;
      alignPlayhead(video, startPosition, sessionId);
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
     * 整集 mp4 解析：**惰性发车**，按需只跑一次。
     *
     * ## 为什么不再无条件先发
     *
     * 旧实现在函数开头就 `void ipcService.playback.resolveNative(...)`，理由是
     * 「HLS 起不来时它得在跑」。但代价被长期忽略了，实测日志（会话 111）：
     *
     *   - 131.823s `[红果] worker 启动` ← resolve 拉的 worker
     *   - 137.873s `[vsr] start 会话=111` ← open_stream 拉的另一路
     *   两条链路各自跑了一遍签名（`预签名已命中=false` 出现在 137.868s，
     *   也就是**整整 6.06 秒之后**才拿到直链），并且 resolve 那个 worker
     *   还会立刻开始下载整集（日志里同一集实测 16.9MB~57.1MB）并重编码。
     *
     * 后果是两路 python + 一路 ffmpeg 抢 CPU 与磁盘：同一次开播
     * `就绪判定 ready=false 进程存活=true 等待=1522ms` —— ffmpeg 1.5 秒内
     * 吐不出首片。而全日志 293 次 ready=true 的会话，首片中位只有 761ms。
     * 也就是说，**是 resolve 自己把首片拖慢了一倍**。
     *
     * 方案 B 之后整集 mp4 的唯一用途是「HLS 起不来时的退路」，而 HLS 起不来的
     * 概率很低（VSR 关闭时才是确定性的）。为这条退路在每次开播时都付两路进程
     * 的代价，明显不划算。
     *
     * ## 现在的策略
     *
     * - 只在**真的需要**时发车：HLS 失败走 `startFull`，或 HLS 出画后由
     *   `warmFullAfterStreaming` 补一次（那时 CPU 已经空出来，且能覆盖
     *   「播到一半 HLS 挂了」这种后发故障）。
     * - 用 `fullPromise` 缓存，重复调用只跑一次。
     */
    let fullPromise: Promise<{ playUrl: string; cached: boolean; sizeBytes: number }> | null = null;
    const ensureFullPromise = () => {
      if (!fullPromise) {
        fullPromise = ipcService.playback.resolveNative(seriesId, episodeId, contentType, quality)
          .then(resolved => {
            if (resolved.cached || resolved.sizeBytes > 0) {
              resolvedFileByVidRef.current.set(cacheKey, resolved.playUrl);
            }
            return resolved;
          });
        void fullPromise.catch(() => {});
      }
      return fullPromise;
    };

    /**
     * 失败回退：走旧的「整集 mp4」链路。
     *
     * 方案 B 之后整集 HLS 是**唯一**的播放源，所以这段代码不再是另一条并行链路，
     * 而是「HLS 起不来时还有一个能播的东西」。它复用同一个 `fullPromise`
     * （整集解析只跑一次），也仍然负责把结果登记进 `resolvedFileByVidRef` 供换集秒开。
     */
    const runFull = async (): Promise<PlayOutcome> => {
      try {
        const resolved = await ensureFullPromise();
        if (activeSessionRef.current !== sessionId) return `stale`;
        const outcome = await playLocalFile(resolved.playUrl, video, sessionId, startPosition, episodeId, seriesId);
        // 源本身有问题才撤掉登记；自动播放被拦时文件是完好的，撤掉会导致下次重下一整集。
        if (outcome === `error` && activeSessionRef.current === sessionId) {
          resolvedFileByVidRef.current.delete(cacheKey);
        }
        return outcome;
      } catch (error) {
        noteFailure(`本地解析失败 ${seriesId}/${episodeId}`, error);
        return `error`;
      }
    };
    const startFull = (): Promise<PlayOutcome> => {
      const attempt = runFull();
      nativeResolveInFlightRef.current = attempt;
      nativeResolveSessionRef.current = sessionId;
      return attempt.finally(() => {
        if (nativeResolveInFlightRef.current === attempt) nativeResolveInFlightRef.current = null;
      });
    };

    // 整集 mp4 解析**不再在这里发车**（见 `ensureFullPromise` 的长注释）。
    // 它只在两种时刻启动：HLS 失败走 `startFull`，或 HLS 出画后由下面那段
    // 延时补发一次 —— 那时 ffmpeg 已收工，CPU 才真正空出来。

    // ===== 唯一主路径：整集 HLS 单源到底 =====
    //
    // 实测依据（本机 RTX 5060 Laptop，真实红果加密源 1080p HEVC，正片 92.7 秒）：
    //   ffmpeg NVENC 边解密边转 → 首片 1314ms、**整集 5.6 秒**、带 ENDLIST
    //   hls.js 实播该产物：可拖动到 60s 与 85s，无错误
    // 转码速度是 16 倍实时，两段式省不下任何东西，只带来切源观感
    // （日志实证 `整集切换完成 位置=8.0s`）与两倍磁盘占用。
    const streamingStarted = performance.now();
    beginStreamingWindow();
    // 这一次 `beginStreamingWindow()` 有没有被配对释放。
    //
    // 为什么需要显式记账：`openStreamNative` 抛错（后端直接 Err —— **VSR 开关关闭时
    // 是确定性触发**）时不会进入下面任何一条分支的释放点，窗口记账就永久多出一次，
    // 之后的整集 mp4 预热会在 90 秒内全被拒（VSR 关的用户唯一能播的就是整集 mp4，
    // 于是每次换集都现场等 7 秒多，审查 F2）。
    let streamingWindowReleased = false;
    const streaming = await ipcService.playback
      .openStreamNative(seriesId, episodeId, sessionId, contentType)
      .catch((error: unknown) => {
        tracePlayback(`整集 HLS 未命中（回退整集文件） ${describeError(error)}`);
        return null;
      });
    if (activeSessionRef.current !== sessionId) {
      endStreamingWindow();
      streamingWindowReleased = true;
      return `stale`;
    }
    // 后端在「盘上只有旧链路 mp4」时会回 file 形态：那不是失败，就是走文件。
    if (streaming && streaming.streamKind !== 'hls' && streaming.cached === true) {
      endStreamingWindow();
      streamingWindowReleased = true;
      tracePlayback('整集 HLS 未启用，后端返回已缓存的整集文件');
      return startFull();
    }
    if (streaming && streaming.streamKind === 'hls') {
      const streamingOutcome = await playStreamingHls(
        streaming.playUrl, video, sessionId, startPosition, episodeId,
      );
      if (streamingOutcome === `stale`) {
        endStreamingWindow();
        streamingWindowReleased = true;
        return `stale`;
      }
      if (streamingOutcome === `ok`) {
        tracePlayback(`整集 HLS 出画 耗时=${Math.round(performance.now() - streamingStarted)}ms（单源到底，不再切源）`);
        streamingSourceRef.current = true;
        // 记下这一集的流式地址：分片临时失败时 `handleError` 要靠它就地重挂，
        // 而不是退回"整集 mp4 解析"那条 7~10 秒的旧链路。
        streamUrlRef.current = streaming.playUrl;
        streamRecoverRef.current = 0;
        // **钉住这一集的真实时长**：后端从 worker 拿到源片 `duration_ms`，
        // 它是文件的客观属性，不随转码进度变化。`usableDuration` 以它为最高
        // 优先级，进度条与时间读数从此不再"一路往上跳"。
        // 拿不到（后端返回 0）时保持 0，退回浏览器侧的判定。
        const totalMs = streaming.durationMs ?? 0;
        // ⚠️ 下限保护：明显不是"一集的毫秒数"就不采纳。实机踩过一次 `100ms`
        // （后端那个上游字段的单位不可靠）——把它当权威会让进度条恒为
        // 00:00 / 00:00 且拖不动，比"没有权威值、退回浏览器侧兜底"糟得多。
        if (Number.isFinite(totalMs) && totalMs >= 1000) {
          streamingSourceTotalSeconds = totalMs / 1000;
          // 立刻把权威时长推给 UI：第一次 timeupdate 可能还没到，
          // 而用户从出画那一刻就应当看到正确的总时长。
          setDuration(streamingSourceTotalSeconds);
          tracePlayback(`时长权威值已固定 = ${streamingSourceTotalSeconds.toFixed(1)}s（源片真实时长）`);
        } else if (totalMs > 0) {
          tracePlayback(`时长值可疑（${totalMs}ms < 1s），不采纳，退回浏览器侧判定`);
        }
        // ⚠️ 窗口**不能在这里就关**：出画只说明首片写完了，而整集转码还在跑。
        //
        // 实测（92.7 秒正片）：首片 1314ms 可播，整集转码到 5.6 秒才结束。
        // 若在出画时就放开预取闸门，之后那 4 秒里会同时跑「本集转码 + 下一集
        // 的 worker 下载/转码」两路 ffmpeg —— 那正是之前三路抢 CPU、转码跟不上
        // 播放的成因。
        //
        // 用一个覆盖转码余量的延时释放，比"立刻释放"正确、比"等后端通知"简单
        // （不必为它新增一条 IPC）。超时释放本身还有 90 秒硬上限兜底，不会泄漏。
        //
        // ⚠️ 余量按**本集实际时长**估：转码速度实测 13~29 倍实时，取保守的 8 倍
        // （被抢时会恶化），再乘 1.6 安全系数。一集 130 秒 → 约 26 秒，由
        // `endStreamingWindowAfter` 钳到 24 秒上限。
        //
        // 为什么不能写死 6 秒：实测 228.5s 起预转、269.6s 才转完（41 秒），
        // 而闸门 6 秒就放开了 —— 预取与播放并行，NVENC 串行，两边都慢。
        const episodeSeconds = streamingSourceTotalSeconds > 0
          ? streamingSourceTotalSeconds
          : (streaming.durationMs ?? 0) / 1000;
        const settleMs = episodeSeconds > 0
          ? Math.round((episodeSeconds / 8) * 1000 * 1.6)
          : STREAMING_TRANSCODE_SETTLE_MS;
        endStreamingWindowAfter(settleMs);
        // ===== 连播预取：等本集转完，再把下一集转好 =====
        //
        // ## 为什么发车时机不能直接用 `settleMs`（2026-10-22 实测修正）
        //
        // 第一版就是拿 `settleMs` 当发车时刻，结果测出「连按两次下一集，
        // 第二次仍然黑等 5431ms」——因为 `settleMs` 是**保守上界**：
        //   119 秒的集 → (119/8)×1.6 = 23.8 秒
        // 而实测整集转码只要 5.6 秒（92.7 秒正片，16 倍实时）。那 18 秒是
        // 纯白等，等完了才发车，用户早就切过去了。
        //
        // `settleMs` 那个保守值本身没写错——它管的是**闸门**（宁可多按住一会儿
        // 也不要让两路抢 CPU），宽松一点没有代价。但**发车**要的是"本集转完的
        // 那一刻"，用上界去近似就等于系统性迟到。
        //
        // ## 新的估算：用实测转码速率
        //
        // 实测 13~29 倍实时（同一台机器、同一类片源），取**偏保守的 12 倍**
        // 并加 1.5 秒固定开销（起进程 + 首片落地）。119 秒的集 → 约 11.4 秒，
        // 比 23.8 秒提前 12 秒，仍留了足够余量（真慢了也只是预取晚一点，
        // 不影响正在播的那一路）。
        //
        // 下限 4 秒：再快也不可能 4 秒内转完一集，发早了就是和本集抢。
        // 上限 20 秒：与 `settleMs` 的 24 秒上限保持同一量级，避免极端长片
        // 把预取推到用户已经切走之后。
        //
        // ⚠️ `TRANSCODE_RATE` 从 12 下调到 5（2026-10-23 修「偶发 4.5 秒等待」）。
        //
        // 12 这个值来自"最快样本"（92.7 秒正片 5.6 秒转完 = 16 倍），但实机日志里
        // 有明确的反例：
        //
        //   7775.710s  [vsr] 转码完成 会话=1003889 耗时=9746ms   ← 48 秒的集
        //
        // 48 / 9.746 ≈ **4.9 倍实时**。而当时 `prewarmDelayMs` 按 12 倍算只给了
        // 5.4 秒就发车，于是用户在预取还没转完时就切了过去（日志里
        // 「同一 vid 正在转码，共用产物」），只能陪着等 —— 那就是用户报的
        // 「偶尔卡四五秒」。
        //
        // 取 5 倍是"覆盖到最慢样本"的保守值：48 秒的集 → 约 11.1 秒发车，
        // 比真实转码完成（9.7 秒）留了 1.4 秒余量。代价是预取更晚开始，但只要
        // 早于用户切集就够——一集 48 秒，用户不会在 11 秒内切走。
        const TRANSCODE_RATE = 5;       // 倍实时，实测最慢 4.9 取 5（覆盖慢样本）
        const TRANSCODE_STARTUP_MS = 1500; // 起进程 + 首片落地
        const prewarmDelayMs = episodeSeconds > 0
          ? Math.min(20_000, Math.max(4_000, Math.round((episodeSeconds / TRANSCODE_RATE) * 1000 + TRANSCODE_STARTUP_MS)))
          : STREAMING_TRANSCODE_SETTLE_MS;
        // 为什么要等而不是立刻发：NVENC 的编码单元是串行的，本集还在转的时候
        // 起第二路，只会把两边都拖慢（实测两路各 9.4 秒 vs 单路 5.6 秒）。
        //
        // 为什么要发：不发的后果就是用户每次点「下一集」都黑等 3.6~5.1 秒
        // （日志实测），而这段时间里 CPU 其实是**空闲**的 —— 上一集早就转完了。
        // 这是纯粹的浪费，也是这次要修的东西。
        //
        // 用 `setTimeout` 而不是 `endStreamingWindowAfter` 的回调：后者是纯
        // 计数管理、不暴露钩子，改它要动那条被反复踩过的闸门逻辑，风险不对等。
        // 这里独立一个定时器，换集时由 `runOpenEpisode` 的 reset 语义自然覆盖
        // （旧集的定时器到点后 `prewarmedNextRef` 已是新键，或 series 已换，
        //  `prewarmNextEpisode` 内部的 idx 查不到就直接返回）。
        scheduleNextEpisodePrewarmRef.current(prewarmDelayMs, episodeId);
        // ⚠️ **不要在这里补发整集 mp4 解析**（2026-10-17 实测卡顿回归后移除）。
        //
        // 曾在这里延时 `STREAMING_TRANSCODE_SETTLE_MS + 1000` 调 `ensureFullPromise()`，
        // 理由是「给 HLS 挂掉留个退路」。但实测证明这笔账算错了：
        //
        //   312.402s  媒体 playing（HLS 正常出画）
        //   313.156s  resolve 请求开始（25.4MB）  ← 本行触发的补发
        //   323.062s  resolve 请求开始（19.4MB）
        //   424.083s  媒体 waiting 缓冲等待        ← 用户感知的「播着播着卡一下」
        //
        // 用户正在看的这一集是**边转边播**的 HLS：ffmpeg 还在往磁盘写后续分片。
        // 此时再起一路 worker 下 20MB+ 的整集 mp4，两者抢的是同一块磁盘与 CPU ——
        // 而那份 mp4 在整个正常播放路径上**一次都不会被读到**。
        //
        // 「HLS 挂了怎么办」这个担心由 `startFull` 覆盖：真出问题时它才现场发车，
        // 那时 CPU 是空闲的，多等几秒也远好过让用户全程卡顿。
        return `ok`;
      }
      endStreamingWindow();
      streamingWindowReleased = true;
      tracePlayback(`整集 HLS 播放失败（outcome=${streamingOutcome}，回退整集文件）`);
    }
    // 只剩「HLS 起不来」这一种情况：回退旧链路的整集文件。
    //
    // ⚠️ 补一次配对释放（`streaming === null` 这条路走不到上面任何释放点，见
    // `streamingWindowReleased` 的说明）。已释放过的路径都置了 true，不会重复减。
    if (!streamingWindowReleased) {
      endStreamingWindow();
    }
    const fullAttempt = startFull();
    /**
     * VSR 关：整集 mp4 是主路径，播起来之后立刻预取下一集。
     *
     * 这条出口是"本集第一次播放（缓存未命中）"走的路 —— 它没有经过上面的
     * `warmAdjacentEpisodes`（那条只在 mp4 快路径命中时调），所以必须在这里补一次
     * 调度，否则关闭增强时下一集永远没有预取，切集就要现场等 6~7 秒。
     */
    if (!vsrEnabledRef.current) {
      void fullAttempt.then(outcome => {
        if (outcome !== 'ok' || activeSessionRef.current !== sessionId) return;
        scheduleNextEpisodePrewarmRef.current(0, episodeId);
      });
    }
    return fullAttempt;
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
    // 探测要拉起一次 worker（秒级），这期间用户完全可能已经换集/换剧。
    // 结果只对**发起探测时**的那个会话有效 —— 否则新一集的清晰度菜单会被
    // 上一集的档位覆盖（同类调用点在别处都有这层校验，这里此前漏了，审查 F5）。
    const sessionAtProbe = activeSessionRef.current;
    try {
      const variants = await ipcService.playback.listNativeQualities(episodeId, contentType);
      if (activeSessionRef.current !== sessionAtProbe) return;
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
   * 预取队列（已停用，仅保留声明以缩小本次 diff）。
   *
   * 它原本驱动「下三集 + 上一集」的**整集 mp4** 后台解析（`startPrewarmResolve`），
   * 2026-10-17 因实测播放卡顿整体移除：那份 mp4 在方案 B 之后不是播放源，
   * 下载它只会和正在播的边转边播 HLS 抢磁盘与 CPU。
   * 详见 `warmAdjacentEpisodes` 里的实测时间线。
   */
  const prefetchQueueRef = useRef<Array<{ seriesId: string; episodeId: string; contentType: number }>>([]);
  // 队列的**属主会话**：换集后新会话会重灌队列，而旧泵还活着的那个短窗口里
  // 不能让它把新队列清掉（审查 F4）。0 表示没有属主。
  const prefetchQueueOwnerRef = useRef<number>(0);
  const prefetchPumpRunningRef = useRef<boolean>(false);

  /**
   * 本集出画后，为**下一集**预热整集 HLS（连播无缝切换）。
   *
   * ## 名字的历史包袱
   *
   * 它曾叫「warmAdjacentEpisodes」，负责预取「下三集 + 上一集」的**整集 mp4**
   * 并灌进 `prefetchQueueRef`。那条链路已于 2026-10-17 停用（实测导致播放卡顿，
   * 见下面那段长注释），现在函数体里只剩「预转下一集的整集 HLS」这一件事。
   * 名字保留是为了不动调用点（`openEpisode` 的两处），语义已由注释钉住。
   *
   * ## 为什么只预转下一集
   *
   * 每路转码会占满显卡编码单元约 6 秒，而连播只关心下一集；下两集之后用户
   * 多半还没看到，提前转纯属与当前播放抢资源（NVENC 串行是实测结论）。
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
    // 首帧预解池随会话作废——那些集已经不是"接下来要播的"了。
    // 必须连同 dispose 一起清，只清 Map 不释放会让解码器挂在脱离文档流的
    // video 上直到 WebView 回收。
    drainPreparedPool();
    /**
     * VSR 关：整集 mp4 是**播放主路径**（不是退路），所以下一集值得提前下。
     *
     * 走 `scheduleNextEpisodePrewarm(0)` 而不是这里直接发车：那条调度会读**最新**
     * 的剧/集（定时器触发时），避免这里捕获的旧闭包把已经不看的那一集预取下来。
     */
    if (!vsrEnabledRef.current) {
      scheduleNextEpisodePrewarmRef.current(0, currentEpisodeId);
      return;
    }
    // ⚠️ **整集 mp4 预取队列已停用**（2026-10-17，实测卡顿回归）。
    //
    // 原实现预取「下三集 + 上一集」，每集都是 worker 下载整集 + 解密 + 重编码
    // （实测单集 13~27MB、7~10 秒）。方案 B 之后整集 mp4 **已经不是播放源**
    // （整集 HLS 才是），它只是「HLS 起不来」的退路 —— 也就是说这条队列花掉
    // 的带宽与 CPU，在正常播放路径上**一秒钟都用不到**。
    //
    // 代价是实测出来的。ttv-playback.log 一次连播里：
    //   299.310s  resolve 请求开始（20.3MB）
    //   304.757s  resolve 请求开始（26.2MB）   ← 两路 worker 并行
    //   312.402s  媒体 playing
    //   313.156s  resolve 请求开始（25.4MB）   ← 边播边下第三路
    //   323.062s  resolve 请求开始（19.4MB）
    //   424.083s  媒体 waiting 缓冲等待        ← 用户感知的「播着播着卡一下」
    //
    // 也就是说：用户在看的这一集（HLS，边转边播）正在与最多两路"下整集 mp4"
    // 的 worker 抢磁盘与 CPU。而按项目自己的实测记录，NVENC 编码单元是**串行**的，
    // 预取不仅没加速任何东西，还把正在播的那一路挤慢了。
    //
    // 现在只保留下面那段「预转下一集的整集 HLS」—— 那才是换集时真正要用的产物。
    // 队列相关的 `prefetchQueueRef` / `prefetchQueueOwnerRef` / `startPrewarmResolve`
    // 已随之成为死代码，保留在文件里只为缩小本次 diff；下一次清理可整体移除。

    // ===== 预转**下一集**的整集 HLS（用户需求：集与集之间无缝切换）=====
    //
    // 上面那条队列预热的是**整集 mp4**，那是方案 B 的失败回退，不是播放主路径。
    // 播放主路径是整集 HLS，而它的转码实测 5.6 秒（92.7 秒正片）—— 若不提前做，
    // 连播到下一集时那 5.6 秒就是实打实的黑屏等待。
    //
    // 只预转**下一集**，不预转下三集：每路转码都会占满显卡编码单元约 6 秒，
    // 而连播只关心下一集；下两集之后用户多半还没看到，提前转纯属与当前播放抢资源。
    //
    // ===== 预转**下一集**的整集 HLS =====
    //
    // ⚠️ 这里**不再自己发车**（2026-10-23 修「联播每集都卡十几秒」）。
    //
    // 曾经这里有一份 `setTimeout(..., STREAMING_TRANSCODE_SETTLE_MS + 1000)`
    // 的预转，与 `playNativeResolvedFile` 里那条按集时长估算的调度**并存**。
    // 两者打架的后果在实机日志里非常清楚：
    //
    //   连播预取 下一集=xxx
    //   本集仍在流式转码窗口内，跳过下一集预转   ← 每一次都被挡掉
    //
    // 因为旧路径的固定 7 秒延迟**正好落在转码窗口内**（窗口按
    // `episodeSeconds / 8 × 1.6` 算，短剧 36~47 秒的集只有 7~9 秒，而
    // `streamingInFlight()` 在这整段里都是 true）。于是预取从来没成功过，
    // 每集都要现场解析——实测一次 12378ms，用户看到的就是"联播不顺畅"。
    //
    // 现在统一由 `scheduleNextEpisodePrewarm`（见 `playNativeResolvedFile`）
    // 负责：它按**实测转码速率**估算发车时刻，且不查 `streamingInFlight()`
    // ——那个闸门是为"悬停预热"设计的，连播场景下本集转完后编码单元就空闲了。
    //
    // 保留 `nextEpisode` 的求值只为下面 `prefetchStream` 那类旁路逻辑不受影响。
    const nextEpisode = series.episodes[idx + 1];
    void nextEpisode;
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

  /**
   * 为指定集提前预热（详情页选集悬停、选集抽屉悬停）。
   *
   * 从"用户瞄上某一集"到"真正点进播放器"通常有几百毫秒到数秒的间隔，
   * 这段时间足以让后端把该集备好。此前只有进入播放器之后才开始预取，
   * 等于白白丢掉这段本可以利用的时间。
   *
   * ## 预热什么：整集 HLS，而不是整集 mp4（2026-10-17 改）
   *
   * 旧实现走 `startPrewarmResolve` → `resolveNative`，也就是让 worker **下载整集
   * mp4 + 解密 + 重编码**（实测单集 13~27MB、7~10 秒）。方案 B 之后整集 HLS 才是
   * 播放源，那份 mp4 只有「HLS 起不来」时才会被读到 —— 预热它等于为一个几乎不会
   * 发生的场景，提前烧掉 20MB 带宽和一路 worker 的 CPU。
   *
   * 代价在实机上非常直观（ttv-playback.log）：用户在选集抽屉里滑过几集，
   * 后台就会并行起两路 worker 下整集，正在播的那一路（边转边播的 HLS）
   * 抢不到磁盘，表现就是「播着播着卡一下」。
   *
   * 改为 `prewarmStreamNative`：它产出 `vid-{vid}` 目录下的整集 HLS，正是用户
   * 点下去要播的东西。命中时 `open_stream` 直接复用、**零等待**（实测 132ms
   * 返回 → 368ms 出画），没命中也只是没享受到加速。
   */
  const prewarmEpisode = (seriesId: string, episodeId: string, contentType = 1) => {
    // 动漫源是流式 m3u8，没有"本地文件"可预热；起 worker 只会白跑一遍
    // 签名链路再失败（worker 只认红果 vid）。动漫的加载靠 openEpisode 直连。
    if (currentSeries?.type === 'anime' || seriesId.startsWith('anime_')) return;
    // guo 源走 guo-core 本地媒体服务，预取由 `prefetchGuoNext` 单独负责。
    if (seriesId.startsWith('guo:')) return;
    // ⚠️ 播放中不预热：编码单元是串行的（NVENC 实测），此刻发车只会挤慢
    // 正在播的那一路。悬停发生在播放器内（选集抽屉）时命中这里。
    if (streamingInFlight()) return;
    /**
     * VSR 关：要预热的产物是**整集 mp4**。
     *
     * `prewarmStreamNative` 在 VSR 关时会被后端直接跳过
     * （`short_drama_app_prewarm_stream` 的门禁：那条链路产出 H.264 HLS，属于增强
     * 链路）—— 所以关闭增强时这里以前是**空转**。改成让 worker 后台把整集下到盘上。
     */
    if (!vsrEnabled) {
      const quality = currentQuality || 'auto';
      void ipcService.playback
        .resolveNative(seriesId, episodeId, contentType, quality)
        .catch(() => undefined);
      return;
    }
    void ipcService.playback.prewarmStreamNative(seriesId, episodeId, contentType);
  };

  /**
   * 连播预取：起播稳定后，主动把**下一集**的整集 HLS 转好。
   *
   * ## 为什么必须有它（2026-10-22 修「切下一集必缓冲 3.6~5.1 秒」）
   *
   * 实机日志给出的证据（ttv-playback.log）：
   *
   *   命中缓存的那次（用户在选集里点了一集已转好的）：
   *     485.928s 打开集
   *     485.932s [vsr] 复用已转好的整集 HLS（未起转码）
   *     485.973s 整集 HLS 出画 耗时=46ms          ← 无缝
   *
   *   未命中的连播（几乎每次「下一集」都是这样）：
   *     470.486s 打开集
   *     470.904s [红果] worker stream stage=sign
   *     472.305s [红果] worker stream stage=model
   *     472.305s [红果] worker stream stage=fallback
   *     473.979s [红果] 流式开播 预签名已命中=false
   *     475.539s [vsr] 首段尚未落地，先交地址交由播放器重试
   *     475.542s 流式开播 返回 耗时=5076ms
   *     475.937s 整集 HLS 出画 耗时=5448ms      ← 用户看到的"正在缓冲"
   *
   * 也就是说：**切换本身的机制没问题（46ms 那次就是证明），缺的是"下一集
   * 在用户切过去之前就已经转好"**。后端 `start_video_cache` 早就有按 vid 目录
   * 复用 ENDLIST 产物的能力，`short_drama_app_prewarm_stream` 也早就实现好了
   * —— 但前端从来只在「选集抽屉悬停」和「详情页悬停」时调用它，**连播路径一次
   * 都没调过**。用户连着看五集，就有五次 5 秒的黑等。
   *
   * ## 为什么不能直接复用 prewarmEpisode
   *
   * 它开头有 `if (streamingInFlight()) return`——播放中一律不预热。那条闸门
   * 是为「悬停」场景设计的：悬停时用户正在看当前集，此时起第二路 ffmpeg 会和
   * 正在转的那一路抢 NVENC（编码单元串行，实测两路各 9.4 秒、四路各 20 秒，
   * 总时长不减少，只是把正在播的挤慢）。
   *
   * 连播不一样：**当前集转完之后编码单元就空闲了**。一集 44 秒、转码 13~29 倍
   * 实时，实测 5.6 秒转完 92.7 秒正片；等本集转完（`endStreamingWindowAfter`
   * 已按集时长估出余量并释放闸门），再发下一集，两者**不会重叠**。
   *
   * 所以这里不查 `streamingInFlight()`，而是等一个"本集转码已完成"的信号。
   * 用一个保守的延时窗口实现（见 `NEXT_EPISODE_PREWARM_DELAY_MS`）。
   *
   * ## 为什么只预取下一集，不预取更多
   *
   * `MAX_PREWARM_INFLIGHT` 已经是 1，且热备一集就够覆盖连播——备两集收益是零，
   * 代价是把正在播的那一路挤慢。用户看到第 N 集时只需要 N+1 就绪。
   */
  const prewarmNextEpisode = useCallback(
    (series: SeriesDetail | null, episodeId: string | null, contentType: number) => {
      if (!series || !episodeId) return;
      // 与 prewarmEpisode 同一套排除条件，理由见那里。
      if (series.type === 'anime' || series.id.startsWith('anime_')) return;
      if (series.id.startsWith('guo:')) return;
      const idx = series.episodes.findIndex(e => e.id === episodeId);
      if (idx < 0 || idx >= series.episodes.length - 1) return; // 已是最后一集
      const next = series.episodes[idx + 1];
      const key = `${series.id}:${next.id}`;
      // 同一集只发一次：`timeupdate` 会反复触发调度点，不去重就会重复发车
      // （虽然后端 `stable_slot_of` 会同槽位去重，但每次调用仍要跑一遍
      //  `ensure_stream_cached` 的签名检查，纯浪费）。
      if (prewarmedNextRef.current === key) return;
      prewarmedNextRef.current = key;
      /**
       * VSR 关：下一集的产物是**整集 mp4**，而 `prewarm_stream` 在 VSR 关时被后端
       * 直接跳过（`short_drama_app_prewarm_stream` 的门禁）—— 也就是说关闭增强时
       * **此前一次预取都没有**：每次切集都要现场让 worker 下载 6~7 秒（日志实测
       * `resolve 返回 耗时=7220ms`），用户看到的正是"关了增强，切集还是和开着一样等"。
       *
       * 这里改成让 worker 在后台把下一集整集下到盘上：下次切集 `resolve` 直接命中
       * 后端缓存（实测 `耗时=7ms`），连播种子的那次等待就消失了。
       *
       * 档位取 `handlerCtxRef` 里的当前值：后端按 requested_quality 落盘，预取与
       * 播放的档位不一致就命中不了（`episodeCacheKey` 那条历史结论同理）。
       */
      if (!vsrEnabledRef.current) {
        const quality = handlerCtxRef.current.currentQuality || 'auto';
        void ipcService.playback
          .resolveNative(series.id, next.id, contentType, quality)
          .catch(() => undefined);
        tracePlayback(`连播预取（整集） 下一集=${next.id} 档位=${quality}`);
        return;
      }
      void ipcService.playback.prewarmStreamNative(series.id, next.id, contentType);
      tracePlayback(`连播预取 下一集=${next.id} 类型=${contentType}`);
    },
    [],
  );

  /**
   * 延时调度「下一集预取」的定时器句柄。
   *
   * 同一时刻只允许有一个在等：换集时新的一次调度必须把上一次撤掉，否则
   * 旧定时器到点会为**已经不看的那一集**发一次车，白烧一路转码。
   */
  const nextPrewarmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * `scheduleNextEpisodePrewarm` 的转发 ref。
   *
   * `runOpenEpisode` 定义在它之前，而 `const` 箭头函数不提升。直接引用能跑
   * 只是因为"调用时机在渲染之后"这个偶然事实——一旦有人把 `runOpenEpisode`
   * 的调用点挪到渲染阶段，就会变成 ReferenceError。用 ref 转发把这条隐式
   * 依赖变成显式的。
   */
  const scheduleNextEpisodePrewarmRef = useRef<(delayMs: number, episodeId: string) => void>(() => {});

  /**
   * 安排一次「本集转完后预取下一集」。
   *
   * 抽成独立函数而不是内联在 `runOpenEpisode` 里，是因为它需要读**最新**的
   * `currentSeries` / `currentEpisode`（定时器触发时闭包里那份可能已经过期）。
   * 用 ref 转发拿最新值，与项目里 `openEpisodeRef` / `playNextEpisodeRef`
   * 是同一套写法。
   */
  const scheduleNextEpisodePrewarm = (delayMs: number, episodeId: string) => {
    if (nextPrewarmTimerRef.current) {
      clearTimeout(nextPrewarmTimerRef.current);
      nextPrewarmTimerRef.current = null;
    }
    nextPrewarmTimerRef.current = setTimeout(() => {
      nextPrewarmTimerRef.current = null;
      // 到点时再读一次当前上下文：延时期间用户可能已经切走、换剧或离开播放器。
      const series = currentSeriesRef.current;
      const ep = currentEpisodeRef.current;
      if (!series || !ep) return;
      // 目标集必须仍是这次调度的那一集。用户已经切到别集时，新一次
      // `runOpenEpisode` 会重新调度，旧的那次直接作废。
      if (ep.id !== episodeId) return;
      const contentType = series.type === 'comic' ? 1004 : 1;
      prewarmNextEpisode(series, ep.id, contentType);
    }, Math.max(0, delayMs));
  };
  // 转发给 `runOpenEpisode`（它定义在本函数之前）：那里是箭头函数的函数体，
  // 只在**运行时**被调用，而那时本次渲染早已把 ref 填好。
  // 不用直接引用是因为 `const` 箭头函数没有提升——直接引用虽然靠调用时序也能跑，
  // 但那属于"侥幸正确"，把顺序改一下就变成 ReferenceError。
  scheduleNextEpisodePrewarmRef.current = scheduleNextEpisodePrewarm;

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
    /**
     * 「这一集算看完了吗」——**剩余秒数是主判据，百分比只是辅助**。
     *
     * ## 为什么单看 95% 不行（2026-10-19 修「断点续播时有时无」）
     *
     * 短剧一集实测只有 33–68 秒。旧规则 `percent >= 95` 意味着：
     *   - 60 秒的一集，看到 **57 秒**就被判「已看完」——还有 3 秒内容没看；
     *   - 而所有续播入口都是 `watchedSeconds > 0 && !isFinished`（见 DetailView /
     *     ExploreView），一旦置位，这一集就被跳过，用户重进播放器会从**别的集**
     *     或第 1 集开始，表现就是"我明明看到一半，回来位置没了"。
     *   - 更糟的是它**时有时无**：取决于退出那一刻是否刚好越过 95% 这条线。
     *
     * ## 为什么不能只看百分比（第一版修法踩到的坑）
     *
     * 第一版写成「percent >= 98 且剩余 <= 3」。但 20 秒的一集看到 19 秒时
     * 剩余只有 1 秒、**确实看完了**，而 `Math.round(19/20*100)` = 95，
     * 被 98% 挡在门外 —— 越短的集越难判完，方向正好反了。
     *
     * 现在用**剩余秒数 + 百分比双条件**，两者各自挡住一类误判：
     *   - `剩余 <= 2 秒`  → 挡住"还有好几秒内容没看就算完"（旧 95% 的核心问题）
     *   - `百分比 >= 95%` → 挡住"短集里剩余 2 秒其实占比很大"
     *     （20 秒的集看到 18 秒还剩 2 秒 = 10%，不该算完）
     *
     * 这两个值是**一起调出来的**，见 `scripts/verify-resume.ts` 的 17 条边界用例：
     *   - 60s 看到 57s（95%、剩 3s）→ 不算完 ✓
     *   - 60s 看到 58s（97%、剩 2s）→ 算完   ✓
     *   - 20s 看到 18s（90%、剩 2s）→ 不算完 ✓
     *   - 20s 看到 19s（95%、剩 1s）→ 算完   ✓
     * 单用秒数会把 20s/18s 误判成看完，单用百分比会把 20s/19s 误判成未完，都不行。
     *
     * 真正的"播到结尾"由 `ended` 事件走 `saveProgressThrottled(dur, dur, true)`
     * 兜底（见 handleEnded），那条路径 position == duration，必然成立。
     */
    const remainingSeconds = safeDur > 0 ? Math.max(0, safeDur - safePos) : Number.POSITIVE_INFINITY;
    const isFinished = safeDur > 0 && remainingSeconds <= 2 && percent >= 95;

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
    /**
     * App 链路（本地解析 / 整集 HLS）没成功时的结局，用于在**最后的公开网页
     * 兜底也失败**时如实报出真正的原因，而不是那句会误导人的
     * "该集没有公开网页播放信息，可能仅限官方 App"。
     *
     * 取值：`null` 表示还没走 App 链路（例如 guo 源）；否则是 `PlayOutcome`。
     */
    let appChainOutcome: PlayOutcome | null = null;
    // H.264 增强任务会持续读取上一集源流，换集时必须显式停掉；否则旧 ffmpeg 会和新会话抢 CPU/带宽。
    if (activeSessionRef.current > 0) {
      void ipcService.playback.command(activeSessionRef.current, 'stop').catch(() => undefined);
    }
    // 末尾静默兜底属于上一集：新集要重新武装（`handlePlaying` 里做），
    // 旧的那条续体如果不能被及时收掉，会在新集播到一半时按旧位置判一次"播完"。
    stopTailEndGuard();
    // 换集 = 上一个会话整体作废（`stop` 已收掉它那一路 ffmpeg），流式转码窗口随之清零。
    // 这里用硬复位而不是递减：会话被替换时，上一条链路留在后台的续体可能再也执行不到
    // 它自己的释放点，靠递减会让计数慢慢涨上去、把整集预取永久关掉。
    resetStreamingWindow();
    // 兜底链的分支判定也一并复位：新一集还没决定走哪条源。
    // ⚠️ 同样必须走统一出口：只写 `streamingSourceRef` 会留下**上一集的时长权威值**，
    // 于是新集的总时长是上一集的（审查 F1）。
    resetStreamingSource();
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
    // 「这一段还没转好」属于**上一集/上一次拖动**：换集必须清掉，否则它会跟着
    // 新一集挂在画面上（新一集的转码进度与那条文案毫无关系）。
    setSeekNotice(null);
    stallReloadingRef.current = false;

    const newSessionId = (activeSessionRef.current += 1);
    setSessionId(newSessionId);
    if (!qualitySwitchRequested) {
      setUiState({ kind: 'opening', sessionId: newSessionId, episodeId: episodeId || '' });
      // ===== 换集必须把进度/时长/缓冲一起归零 =====
      //
      // 历史坑（用户实机报告）：进度条停在某一位置时点「下一集」，进度条不刷新、
      // 画面也定格在旧位置开始播。根因是这三项**只有** `timeupdate` / `seek` 会写，
      // 而换集时新源从 `currentTime=0` 开始、第一次 `timeupdate` 到来之前，
      // UI 一直读着上一集残留的 `position`：
      //   - 进度条停在旧位置（视觉上"没刷新"）；
      //   - `ProgressBar` 的拖动值也来自它，用户看到的"定格在进度条位置"正是
      //     旧 position 被当成新一集的起播点渲染出来。
      // 新源真正出画后 `handlePlaying` / `handleTimeUpdate` 会立刻用真实值覆盖，
      // 所以这里归零不会造成"跳回 0 再跳回去"的抖动。
      //
      // ⚠️ 切清晰度例外：那是同一集的同一位置，归零会让进度条瞬间跳到 0。
      setPosition(0);
      setDuration(0);
      setBuffered(0);
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
      // 档位探测已改到 open 之后（见下方 preload 块后的调用）：guo-core 的 resolve
      // 用全局单调序号，后发者 cancel 前发者，并发探测会把正在起播的那次掐掉。

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
        // 起播点必须随挂载一起交给 hls.js（见 `attachSource` 的同名参数）：
        // 动漫换集同样不换元素，元素上残留的是上一集的位置。
        if (isHlsUrl(session.url)) {
          await attachSource(animeVideo, session.url, startPosition);
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
      //
      // ⚠️ **VSR 开着时一律不走这条快路径**（2026-10-25 修「关闭再打开 VSR 没反应」）。
      //
      // 这张表里存的是 `resolveNative` 产出的**整集 mp4**，而它的编码是**源编码**
      // （红果实测 `h265_hvc1`）。VSR 的硬条件是 H.264（不变量 25），播这份文件
      // 等于把增强静默跳过。现场日志：
      //
      //   [+83.8s] VSR 开关生效：… 按原位置重新解析（链路=转码分片）
      //   [+83.9s] 媒体 loadeddata 首帧就绪 耗时=98ms     ← 98ms 是本地文件，不是转码
      //   [+84.7s] [红果] worker stream stage=sign        ← 转码到这时才开始
      //
      // 也就是说：VSR 关着时下载的那份 HEVC mp4 被登记在表里，开关拨回「开」之后
      // 仍然命中它 → `openStreamNative` / `playStreamingHls` 一次都没执行 → 开关
      // "看起来生效了"（日志还写着转码分片），画面却还是那份没有增强的源。
      // 与历史上「把清晰度从缓存键里去掉」是同一类错误：缓存键必须能区分**链路**。
      //
      // 代价为零：需要兜底时下面还有 `startFull()` 那条路，它用的 `ensureFullPromise`
      // 本来就不读这张表。
      const video = videoRef.current;
      const cachedKey = episodeCacheKey(seriesId, ep.id, selectedQuality);
      const cachedPlayUrl = resolvedFileByVidRef.current.get(cachedKey);
      if (video && cachedPlayUrl && cachedPlayUrl !== '__prefetching__' && !vsrEnabled) {
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
        //
        // 诊断打点（2026-10-21）：走到这里意味着 App 链路（worker 签名 / 下载 /
        // 解密 / 转码）没成功。而用户最终看到的是**公开网页**那条链路的错误
        // （"该集没有公开网页播放信息，可能仅限官方 App"）——红果剧的公开页
        // 本来就只提供默认集，这条兜底对它们是**确定性失败**的，于是真实原因被
        // 一句误导性文案顶掉。把 App 侧的真实结局记下来，兜底也失败时优先报它。
        appChainOutcome = outcome;
        tracePlayback(
          `本地解析未成功 结局=${outcome} 集=${ep.id} 会话=${newSessionId}（转公开网页兜底）`,
        );
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
          /**
           * ## 兜底也失败时，报**真正**的原因（2026-10-21）
           *
           * 红果剧的公开页只提供默认集（`provider.rs::open_episode` 里那条
           * "该集没有公开网页播放信息，可能仅限官方 App"就是这个分支），所以
           * 对绝大多数红果剧，这条兜底是**确定性失败**的。此前直接把它的错误
           * 抛上去，用户看到的就是那句"可能仅限官方 App"——而真正的原因是
           * App 链路自己没成功，与网页无关。用户正是被这句话带偏的。
           *
           * 现在把两条链路的原因拼在一起，并**以 App 链路的结局为主**：
           * 正常情况它才是决定性的那一环；只有 guo 源（`appChainOutcome` 为
           * null，没走 App 链路）才直接报网页原因。
           */
          const webText = errorText(webError, '公开网页播放失败');
          const appText = appChainOutcome ? `本地解析结局=${appChainOutcome}` : '';
          throw new Error(
            appText
              ? `${appText}；公开网页兜底也失败：${webText}`
              : webText,
          );
        }
      }
      // 预取下一集：URL 已可用即可触发，不等 play() 成功——自动播放被拦等
      // 起播问题与本集 URL 的有效性无关，预取不该为它们买单。
      if (isGuoSeries && activeSessionRef.current === newSessionId) {
        prefetchGuoNext(detail, ep.id, selectedQuality);
      }
      if (activeSessionRef.current !== newSessionId) return;

      // guo 档位探测：排在 open 完成后，命中后端刚写回的档位缓存（零 resolve）。
      // 失败时返回空数组——宁可退回单档，绝不虚构源里没有的档位。
      if (isGuoSeries) {
        const guoQualityKey = `${seriesId}::${ep.id}`;
        if (guoProbedRef.current !== guoQualityKey) {
          guoProbedRef.current = guoQualityKey;
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
      }

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
          // 起播点随挂载交给 hls.js（理由见 `attachSource` 的同名参数）。
          await attachSource(video, session.url, startPosition);
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

        // 起播点收敛：公开直链这条路的 `loadedmetadata` 可能还没到，
        // 不能只判 startPosition > 0（连播时它恒为 0，旧实现于是完全不管位置）。
        const alignWhenReady = () => {
          alignPlayhead(video, startPosition, newSessionId);
        };
        if (video.readyState >= 1) {
          alignWhenReady();
        } else {
          video.addEventListener('loadedmetadata', alignWhenReady, { once: true });
        }

        // 公开直链是"吊死连接"最高发的一条路（远端不回包也不断开），play()
        // 在这里挂死就是永久 opening。有界版本超时后走 catch → 本地解析兜底。
        playBounded(video).then(() => {
          if (pauseIfStale(newSessionId, video)) return;
          video.muted = preferredMuted;
          setIsPlaying(true);
          // ⚠️ 用 `video.currentTime` 而不是 `startPosition`：这条路径的源是
          // guo 本地媒体服务的 HLS/直链，`startPosition > 0` 时那次 seek 可能
          // 还没落地（`loadedmetadata` 尚未触发），写死 `startPosition` 会让
          // 进度条与画面脱钩。取元素真值是唯一可靠的来源。
          setUiState({ kind: 'playing', sessionId: newSessionId, position: video.currentTime });
          // ===== 主动补齐时长与进度（用户报告：新区域卡片进度/时长全是 0）=====
          //
          // guo 源走的是这条「公开直链」分支，**不经过** `openStreamNative`，
          // 因此 `streamingSourceTotalSeconds` 永远是 0（日志可证：`时长权威值
          // 已固定` 只出现在红果 HLS 路径上）。而 `usableDuration` 退回到
          // `video.duration` 时，guo 的 HLS 直链常报 `Infinity`；再退到
          // `seekable`/`buffered` 时若首片还没入缓冲就是 **0** —— 于是进度条
          // 恒为 00:00 / 00:00，但画面照常播（用户看到的正是这个）。
          //
          // 这里在起播后主动推一次真值，并且挂一个 `durationchange` 兜底：
          // 边转边播/流式源的 `duration` 是**后来才**从 Infinity 变成真实值的，
          // 只在起播这一刻读一次会永久错过它。
          const syncTimeline = () => {
            if (activeSessionRef.current !== newSessionId) return;
            const dur = usableDuration(video);
            if (dur > 0) {
              setDuration(dur);
              // 打点：这条路径（guo 源 / 非红果链路）此前改时长不留痕，
              // 排查"时长显示不对"时无法判断界面上的值来自哪条分支。
              tracePlayback(
                `时长同步（浏览器侧）= ${dur.toFixed(1)}s 来源=${
                  Number.isFinite(video.duration) && video.duration > 0 ? 'video.duration' : 'seekable/buffered'
                }`,
              );
            }
            const cur = Number.isFinite(video.currentTime) ? video.currentTime : 0;
            if (cur >= 0) setPosition(cur);
          };
          syncTimeline();
          const onDurationChange = () => syncTimeline();
          video.addEventListener('durationchange', onDurationChange);
          video.addEventListener('loadedmetadata', onDurationChange);
          // 清理：源被换掉（新的会话开始）时这两个监听必须撤掉，否则会一直
          // 往已经作废的会话里写状态。用一次性定时器做不到"会话作废即撤"，
          // 所以挂在 video 上、由 `detachSource` 之外的这条路径自己收尾。
          const timelineCleanup = () => {
            video.removeEventListener('durationchange', onDurationChange);
            video.removeEventListener('loadedmetadata', onDurationChange);
          };
          video.addEventListener('emptied', timelineCleanup, { once: true });
          // 30 秒后无条件摘掉：guo 的源一旦稳定，`duration` 不会再变，留着监听
          // 只会在每次 seek 时白跑一遍 `usableDuration`（它要读 seekable/buffered）。
          window.setTimeout(timelineCleanup, 30000);
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
        /**
         * ## 为什么这里不能写 `(err as Error).message`（2026-10-21 修「错误原因被吞」）
         *
         * Tauri 的 `invoke` 被后端 `Err(String)` 拒绝时，抛出来的是**那个原字符串
         * 本身，不是 Error 对象**。于是 `(err as Error).message` 恒为 `undefined`，
         * `||` 右侧兜底成 `'MEDIA_LOAD_FAILED'` —— 后端辛苦拼出来的真实原因
         * （"该集没有公开网页播放信息"这类）在**错误码**里彻底丢失，界面上只剩
         * 一句通用文案。用户报「播放不了」时，连是哪条链路失败都看不出来。
         *
         * 现在用 `errorText` 统一收口（它就是为了这个坑写的，见 ipc.ts），
         * 并把真实原因放进 `detail` 透传给错误卡，同时 `code` 保持稳定的机器码。
         */
        const detail = errorText(err, '未知错误');
        setUiState({
          kind: 'error',
          sessionId: newSessionId,
          code: 'MEDIA_LOAD_FAILED',
          recoverable: true,
        });
        // 真实原因单独透传：错误卡优先显示它，而不是那句通用文案。
        setErrorDetail(detail);
        tracePlayback(
          `打开集数失败 集=${episodeId || '(首集)'} 会话=${newSessionId} 原因=${detail}`,
        );
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
    // 新的一集从哪开始，必须在日志里留一条：用户报"下一集不是从头播"时，
    // 只有这行能和随后的「首帧-宿主 首次 timeupdate 位置=」对上——否则
    // 分不清是起播点传错了，还是换源没重置元素位置。
    tracePlayback(
      `打开集 ${episodeId || '(默认首集)'} 期望起点=${Math.round(startPosition)}s 清晰度=${qualityOverride || '默认'}`,
    );
    // 新的播放意图即刻撤销"全剧播完自动返回详情"的安排：用户可能在 2 秒返回窗口
    // 内从选集抽屉点了下一部/另一集，不撤销的话返回会把正在打开的播放打断。
    setFinishedAll(false);
    finishedAllEpisodeRef.current = null;
    // 换集瞬间撤销上一次结尾留下的复核：它绑的是旧会话的播放位置，
    // 落到新一集上就是"刚开始播就被推进下一集"。
    cancelTailProbe();
    // 同样撤销在途的「等待转码推进」：它的目标位置属于旧集，落到新集上是错的。
    cancelSeekWait();
    // 键里必须带「增强代际」：切换 VSR / 补帧后是同一集、同一位置、同一清晰度，
    // 只有这一位能把"新链路"和"还在途的旧链路任务"区分开（见 `enhanceEpochRef`
    // 的说明）。少了它，拨开关会命中旧任务，表现为"开关动了、画面没变"。
    const key = `${seriesId}|${episodeId || ''}|${Math.round(startPosition)}|${qualityOverride || ''}|${enhanceEpochRef.current}`;
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
              // ⚠️ 起播点必须取**元素真值**，不能用 React state 的 `position`。
              //
              // `position` 是 `timeupdate` 的节流镜像（约 4 次/秒），换集归零后
              // 到第一次 `timeupdate` 之间它是 0；而在正常播放中它又可能比真实
              // `currentTime` 落后最多 250ms。用它当恢复点会让「点一下继续播放」
              // 出现回退或从 0 重来的观感。元素自身的 `currentTime` 才是唯一真值。
              Number.isFinite(videoRef.current.currentTime) ? videoRef.current.currentTime : 0,
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

  const seek = (seconds: number, previewing = false) => {
    if (!videoRef.current) return;
    // 用户手动拖进度 = 接管播放：撤销"全剧播完自动返回首页"的安排（若有）。
    setFinishedAll(false);
    finishedAllEpisodeRef.current = null;
    const video = videoRef.current;
    /**
     * ===== 落位判定收口到 `planSeek`（2026-10-24）=====
     *
     * ## 用户报的现象
     *
     * 「点击播放器任意位置（比如点击结尾），它会跳转到转码后的最后位置，
     *   而不是跳到点击的对应位置。」
     *
     * ## 为什么
     *
     * 进度条的分母是**源片真实时长**（后端下发的权威值），而播放源是边转边播的
     * 整集 HLS —— `video.seekable.end()` 只到已转位置。旧实现为了绕开浏览器的
     * 夹取，主动把播放头推到 `seekable.end - 0.05`：
     *
     * ```ts
     * // 旧代码（已删）
     * if (shouldPush) { video.currentTime = pushTarget; }   // pushTarget = min(target, end - 0.05)
     * ```
     *
     * 于是一个"还没转好"的等待，被表现成了"跳到转码末端"的**错误落位**。
     * 超时之后还会再推一次（`video.currentTime = max(0, end - 0.05)`），
     * 把同一个错误变成永久的。
     *
     * ## 现在
     *
     * - 在可寻址范围内 → 立即落位（绝大多数情况）；
     * - 超出范围 → 进等待，**播放头不动**，等转码追上目标再落位；
     * - 超时 → 如实提示"这一段还没转好"，**停在原处**，绝不跳到末端冒充成功。
     *
     * 三个播放面共用 `planSeek` / `seekableReached`，语义只有一份。
     */
    let seekableEnd = 0;
    try {
      if (video.seekable && video.seekable.length > 0) {
        seekableEnd = video.seekable.end(video.seekable.length - 1);
      }
    } catch {
      // 尚未就绪的媒体元素访问 seekable 可能抛错：按"不可寻址"处理。
    }
    const plan = planSeek({ requested: seconds, duration, seekableEnd });

    // 拖动过程中只更新界面读数，不触发续转 —— 见 `onSeek` 的签名说明。
    // 不这样的话，拖 3 秒会经过几十个像素，每个都发一次等待。
    if (previewing) {
      setPosition(plan.target);
      return;
    }

    if (plan.kind === 'wait') {
      tracePlayback(
        `拖动到未转码区域 目标=${plan.target.toFixed(1)}s 可寻址末端=${plan.seekableEnd.toFixed(1)}s 会话=${activeSessionRef.current}（等待转码推进，播放头留在原处）`,
      );
      // 上一次的"还没转好"提示先撤掉：这次是新目标，结果还没出来。
      setSeekNotice(null);
      // 进度条先显示用户点的位置：他要的是"那里"，不是"现在能播到的地方"。
      setPosition(plan.target);
      saveProgressThrottled(plan.target, duration, true);
      waitForSeekable(video, plan.target);
      return;
    }

    // 可寻址范围内：正常落位。这一行是唯一会立即改变画面的路径。
    video.currentTime = plan.target;
    setPosition(plan.target);
    saveProgressThrottled(plan.target, duration, true);
    // 用户重新点了一次并且成功了：上一次"还没转好"的提示到此为止。
    setSeekNotice(null);
  };

  const seekRelative = (deltaSeconds: number) => {
    seek(position + deltaSeconds);
  };

  /**
   * 当前的「等待转码推进」任务（同一时刻只允许一个）。
   *
   * 为什么必须互斥：一次点击会同时触发 `pointerdown` 与 `pointerup` 两次落定，
   * 每次都会启动一个轮询器。两个轮询器各自落位一次，就是两次 `currentTime` 赋值
   * —— 用户看到的是画面闪一下。实测日志里每条「转码已推进到」都出现两次，
   * 间隔 50~170ms，正是这个原因。
   */
  const seekWaitRef = useRef<{ timer: number; target: number } | null>(null);

  /**
   * 「用户点了、但还没转好」的目标位置（秒）。
   *
   * ## 为什么必须有它（2026-10-26 修「点了 90s，进度条弹回 20s」）
   *
   * 等待期间每一拍 `timeupdate` 都会把**真实**播放头写进 `position`，于是用户
   * 刚拖到 90s、进度条立刻弹回当前能播的 20s —— `seekPlan` 的注释承诺"等待期间
   * 播放头不动、如实显示用户点的位置"，但 UI 读数被 timeupdate 覆盖了。
   *
   * 语义：非空 = 有一次等待在途，`position` / 落盘都按它显示；落位成功、用户
   * 再次拖动、换集、离开播放器时清空。
   */
  const seekWaitTargetRef = useRef<number | null>(null);

  /**
   * 「等待转码推进」任务的代际号：每次新的拖动自增一次。
   *
   * 轮询器靠它判断自己是否已被取代（见 `waitForSeekable` 里的说明）。
   * 不用 `seekWaitRef` 本身做判断，是因为 `poll` 第一行会把它清空，
   * 之后每一拍都读不到"当前目标是谁"。
   */
  const seekWaitGenerationRef = useRef(0);

  /**
   * 上一次向 hls.js 下达「从目标位置拉流」的位置（秒）。
   *
   * 用途见 `waitForSeekable` 里那段注释：等待期间每一拍都会调
   * `hintHlsLoadPosition`，而它会重建加载状态机 —— 目标不变就没必要重复下达。
   * 记住上次下达的位置，只有目标变了（或首次）才再下一次。
   *
   * 每次新的拖动/换集都要清空（`cancelSeekWait` 里一并重置），否则新目标会
   * 沿用旧目标的"已下达位置"，导致第一拍不下达。
   */
  const lastHintRef = useRef<number | null>(null);

  const cancelSeekWait = () => {
    // 推进代际号：让**已经排上队但还没跑**的那一拍也立刻失效。
    // 只清 timer 不够 —— `poll` 可能正在执行中（它已经通过了 `isCurrent()`），
    // 清 timer 对它无效，下次它自己排下一拍时才会发现代际号变了。
    seekWaitGenerationRef.current += 1;
    if (seekWaitRef.current) {
      window.clearTimeout(seekWaitRef.current.timer);
      seekWaitRef.current = null;
    }
    // "已下达位置"属于上一次拖动：不清掉的话，新目标的第一拍会因为
    // `|target - lastHint| < 1.0` 而拒绝下达。
    lastHintRef.current = null;
    // 目标位置也一并作废：新的拖动/换集会重新设置它。
    seekWaitTargetRef.current = null;
  };

  /**
   * 等转码推进到目标位置，然后落位。
   *
   * 为什么不是"重开这一集"：重开会先 stop 掉正在转的 ffmpeg，进度清零，
   * 可寻址范围反而变小 —— 用户看到「拖过去又弹回来 + 画面闪」。
   * 而转码本身是 13~29 倍实时，缺的只是时间，等它就行。
   *
   * 超时兜底：极端情况下（转码停滞、源断了）不能永远等，到点退回重开一次。
   */
  const waitForSeekable = (video: HTMLVideoElement, target: number) => {
    // 同一目标重复调用直接忽略；不同目标则取代旧的（用户又拖了一次）。
    if (seekWaitRef.current && Math.abs(seekWaitRef.current.target - target) < 0.5) return;
    cancelSeekWait();
    // 记下"用户要的是这里"：等待期间 `timeupdate` 不许把进度条弹回真实播放头
    // （见 `seekWaitTargetRef` 的说明）。
    seekWaitTargetRef.current = target;
    const sessionAtWait = activeSessionRef.current;
    /**
     * 本次等待的**代际号**。
     *
     * ## 为什么必须有它（2026-10-23 修「进度条回弹」）
     *
     * 用户连续拖动时会产生多个轮询器。旧实现在 `poll` 第一行就把
     * `seekWaitRef.current` 置 null，于是**后续每一拍都无法判断自己是否已被
     * 新的拖动取代**——一个追着 20s 的旧轮询器会继续把 `currentTime` 往 20s 推，
     * 而用户已经拖到 58s 了。日志里的证据正是这样：
     *
     *   963.548s  转码已推进到 36.9s，落位到 20.1s   ← 目标 20.1，但用户早已拖走
     *   966.417s  转码已推进到 64.1s，落位到 58.0s
     *
     * 两次落位方向相反，用户看到的就是"往前走了又弹回来"。
     *
     * 代际号让每一拍都能确认"我还是当前那一次等待吗"，不是就直接退出。
     */
    const generation = (seekWaitGenerationRef.current += 1);
    const isCurrent = () => seekWaitGenerationRef.current === generation;
    const deadline = performance.now() + SEEK_WAIT_TIMEOUT_MS;
    const poll = () => {
      // 被更新的拖动取代：这一拍什么都不做（新轮询器会接管）。
      if (!isCurrent()) return;
      seekWaitRef.current = null;
      // 会话已换（用户切集/退出）：这次等待作废。
      if (activeSessionRef.current !== sessionAtWait) return;
      if (videoRef.current !== video) return;
      let end = 0;
      try {
        if (video.seekable && video.seekable.length > 0) {
          end = video.seekable.end(video.seekable.length - 1);
        }
      } catch {
        // 读不到就当作还没就绪，下一拍再试。
      }
      if (seekableReached(end, target)) {
        tracePlayback(`转码已推进到 ${end.toFixed(1)}s，落位到 ${target.toFixed(1)}s`);
        // 已落位：读数交回真实播放头（否则 target 会一直压着 position）。
        seekWaitTargetRef.current = null;
        video.currentTime = target;
        setPosition(target);
        saveProgressThrottled(target, duration, true);
        return;
      }
      /**
       * ===== 等的时候**不动播放头**，改用 hls.js 的加载位置（2026-10-24 根治）=====
       *
       * ## 旧实现为什么错
       *
       * 旧代码每一拍都写 `video.currentTime = min(target, end - 0.05)`，
       * 注释里给的理由是"hls.js 按播放位置决定拉哪一片，播放头不动就拉不到目标分片"。
       * **这个前提是对的，但用它去移动播放头是错的**——那就是用户报的
       * 「点结尾却跳到转码后的最后位置」：
       *
       *   拍 1：end=20.0 → 播放头被写到 19.95   ← 用户看到画面跳到 19.95
       *   拍 2：end=22.5 → 又写到 22.45         ← 又跳
       *
       * 每次写 `currentTime` 都让解码器重起一组帧（"画面反复跳几帧"就是这么来的），
       * 而用户点的 90 秒始终没有被请求过。超时那一刻还会再推一次 `end - 0.05`，
       * 把这次错误落位变成**永久**的。
       *
       * ## 正确做法
       *
       * 播放头留在用户按下时的位置（画面继续播/暂停），把"我要这个位置"这件事
       * 交给 hls.js 的加载器：`startLoad(target)` 让它按目标位置重建拉流，
       * **完全不碰 `video.currentTime`**。转码追上后由上面那一支真正落位。
       *
       * 这也是唯一同时满足两个约束的做法：
       *   - 画面不能跳（用户没要求跳）；
       *   - 目标分片必须被请求（否则永远等不到）。
       *
       * 每拍只下达一次（`lastHintRef` 记住上次的位置，目标不变就不重复下达）：
       * `startLoad` 会重建加载状态机，每 250ms 来一次纯属浪费。
       */
      if (lastHintRef.current === null || Math.abs(lastHintRef.current - target) >= 1.0) {
        // ⚠️ 先下达、再记录（2026-10-26 修）。旧写法先写 `lastHintRef = target`
        // 再调 hint，而 `hintHlsLoadPosition` 在 hls 实例尚未 attach 时会返回
        // false（注释明说"下一拍再试"）—— 但目标已经被记成"已下达"，于是**永远
        // 不会再试**，整个等待窗口里分片都不会被请求。
        const hinted = hintHlsLoadPosition(video, target);
        lastHintRef.current = hinted ? target : null;
        tracePlayback(
          `催拉目标分片 目标=${target.toFixed(1)}s 可寻址末端=${end.toFixed(1)}s 方式=${hinted ? 'hls.js startLoad' : '原生（无 hls 实例）'}`,
        );
      }
      if (performance.now() >= deadline) {
        /**
         * ## 超时：如实报告，绝不跳到末端冒充成功（2026-10-24 根治）
         *
         * 旧实现在这里写 `video.currentTime = max(0, end - 0.05)`，注释是
         * "让用户至少停在能播到的地方"。但那正是这个 bug 的最后一步：
         * 用户点结尾 → 等了 8 秒 → 被强行放到已转码末端 → **看起来像是"点了结尾
         * 就跳到末端"**，而且这次是永久的，用户以为已经落位了。
         *
         * 现在停在原处，并通过 `stallNotice` 如实告诉用户"这一段还没转好"。
         * 用户可以再点一次（转码 13~29 倍实时，通常早就追上了），
         * 也可以什么都不做 —— 播放头本来就没被动过。
         */
        tracePlayback(
          `等待转码超时（${SEEK_WAIT_TIMEOUT_MS}ms）目标=${target.toFixed(1)}s 末端=${end.toFixed(1)}s，保持在原位（不跳到末端、不重开会话）`,
        );
        // 超时后把读数交回真实播放头：继续压着 target 会让进度条永远停在
        // 一个播不到的位置（用户会以为已经落位了）。提示已经如实说明。
        seekWaitTargetRef.current = null;
        setSeekNotice(
          `这一段还没转好（已转 ${Math.floor(end)} 秒 / 目标 ${Math.floor(target)} 秒），稍等再点一次`,
        );
        return;
      }
      const timer = window.setTimeout(poll, SEEK_WAIT_POLL_MS);
      seekWaitRef.current = { timer, target };
    };
    const timer = window.setTimeout(poll, SEEK_WAIT_POLL_MS);
    seekWaitRef.current = { timer, target };
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
      // 保持当前播放位置平滑切清晰度。
      // 取元素真值而非 state 的 `position`：后者是 timeupdate 的节流镜像，
      // 切换瞬间可能落后最多 250ms，表现为"切完清晰度回退了一点"。
      const at = videoRef.current && Number.isFinite(videoRef.current.currentTime)
        ? videoRef.current.currentTime
        : position;
      void openEpisode(currentSeries.id, currentEpisode.id, at, quality);
    }
  };

  /**
   * 视频增强（VSR）开关的**唯一写入口**（播放页浮层、设置页都最终落在这里）。
   *
   * 只写设置。让当前这一集立即重走新链路的动作在下面那个 effect 里统一做——
   * 这样"用户在设置页改"与"用户在播放页改"是同一套生效路径，不存在两条各说
   * 各话的实现。
   */
  const setVsrEnabled = useCallback((enabled: boolean) => {
    updateSettings({ vsrEnabled: enabled });
  }, [updateSettings]);

  /**
   * ===== 视频增强开关：播放中切换必须**立即**生效 =====
   *
   * ## 只写设置为什么不够
   *
   * `vsrEnabled` 的真实作用点是**后端 resolve 的那一刻**：`main.rs` 的
   * `enhance_short_drama_session` 读进程级 `AtomicBool`（红果 worker 读的是
   * 注入的 `TTV_SD_VSR`）。已经开播的这一集，链路在起播时就定型了：
   *   - 开 → 关：画面来自本地 H.264 分片，关掉开关不会自己变回原始源；
   *   - 关 → 开：画面来自原始源/整集 mp4，不重新 resolve 就不会触发转码。
   * 所以只写设置的表现是"开关动了、画面一点没变，要退出播放器再进才生效"——
   * 这正是历史上「开关 VSR 都没用」反馈里最容易被当成"开关没生效"的那一半。
   *
   * ## 做法：同集换源，不是重开一集
   *
   * 用**元素真值位置 + 当前清晰度**再调一次 `openEpisode`。`runOpenEpisode` 里
   * `qualitySwitchRequested` 那条分支本来就是"同一集换一路源、保留进度、不把
   * 进度条归零"的成熟路径（切清晰度走的就是它），切换增强与它完全同构：
   * 变的是链路，不是内容。
   *
   * ⚠️ `enhanceEpochRef` 必须在调用前自增：`openEpisode` 对"同键在途"会去重，
   * 而键里没有开关状态。少了这一步，首播解析途中拨开关会命中旧的解析任务。
   *
   * ## 不重载的两种情况（设置照样落库，下次开播自然走新链路）
   *
   *   - 没有当前集 / 已经离开播放器（`stopPlayback` 会把 `uiState` 复位成 idle，
   *     而 `currentSeries` 仍留着——所以判据必须是 uiState，不能只看有没有剧）。
   *   - 控制条收起、浮层关闭都不影响：这里只看设置与播放状态。
   */
  const vsrSwitchRef = useRef<boolean | null>(null);
  useEffect(() => {
    const next = settings.vsrEnabled !== false;
    // 第一次跑到这里只同步基准值：设置是**异步**从后端拉的（`useSettingsStore`
    // 的初值是"默认全开"），落库为「关」的用户在回填那一刻也会看到一次"变化"，
    // 那不是用户拨动，不能上报、更不能重载。
    if (vsrSwitchRef.current === null) {
      vsrSwitchRef.current = next;
      return;
    }
    if (vsrSwitchRef.current === next) return;
    vsrSwitchRef.current = next;
    tracePlayback(
      `VSR 开关切换为：${next ? '开（H.264 分片 / 增强链路）' : '关（原始源直链）'}`,
    );
    if (!currentSeries || !currentEpisode) return;
    if (uiState.kind === 'idle') return;
    /**
     * 「画面里装的确实就是当前这一集」才允许重载。
     *
     * 切集 / 换剧的窗口里 `currentEpisode` 已经换成新集，而 `<video>` 还挂着旧源：
     * 这时拿元素位置当新集的起播点，新集会从旧集的 30~60 秒开始播（一集才 33~68 秒，
     * 常常直接落到结尾）；而且下面这次 `openEpisode` 会递增会话号，把用户刚点的那次
     * 换集判成 stale，等于把用户的点击吃掉。
     *
     * 正常播放时三个值恒等；换集途中 / 首播解析途中必然不等 —— 跳过即可，开关值
     * 已经落库（`settings_save` 是同步命令、先写 `AtomicBool` 再落库），下一次
     * 开播自然走新链路。这也是一条隐含前提：将来若把 `settings_save` 改成 async，
     * 这里必须先 await 它。
     */
    const committed = videoCommittedRef.current;
    if (
      !committed
      || committed.episodeId !== currentEpisode.id
      || committed.sessionId !== activeSessionRef.current
    ) {
      tracePlayback('VSR 开关已落库，但画面正在换集，本次不重载（下一次开播自然走新链路）');
      return;
    }
    enhanceEpochRef.current += 1;
    /**
     * 两张「上一链路的产物」缓存必须一起清掉。
     *
     * - `resolvedFileByVidRef`：整集 mp4 地址（源编码多半是 HEVC，VSR 认不了）。
     *   不清的话 VSR 关→开 时会命中它，转码链路一次都不会被调用（P0）。
     *   上面快路径已加 `!vsrEnabled` 兜底，这里再清一遍，避免它被别的路径读到。
     * - `resolvedGuoSessionRef`：guo 源的完整会话（含增强后的 URL 与 streamKind）。
     *   键同样不含链路维度，命中就等于沿用上一轮链路的地址。
     */
    resolvedFileByVidRef.current.clear();
    resolvedGuoSessionRef.current.clear();
    const video = videoRef.current;
    const at = video && Number.isFinite(video.currentTime) ? video.currentTime : position;
    /**
     * ⚠️ **不要**在这里 `video.pause()`（2026-10-25 修「关掉增强后视频停在暂停」）。
     *
     * 曾经为了"避免新源从 `at` 起播造成倒退"这里先冻结画面。但实测这笔账算错了：
     *
     *   - 收益几乎为零：两条链路的重新准备都很快 —— VSR 关（整集 mp4 缓存命中）
     *     实测 `resolve 返回 耗时=7ms`，VSR 开（复用已转好的整集 HLS）
     *     `整集 HLS 出画 耗时=153ms`。几十毫秒的倒退用户根本感知不到；
     *   - 代价却是一个真故障：`pause()` 之后那一路 `play()` 走的是**异步续体**，
     *     WebView2 的自动播放许可（user activation）在 await 之后不再保证，
     *     `playBounded` 可能拿到 `autoplay-blocked` —— 于是视频就**停在暂停**，
     *     用户看到的正是"关一下增强，画面不动了"。
     *
     * 现在旧画面继续播，新源出画后由 `playing` 事件接管，位置差在 0.1~0.2 秒内。
     */
    tracePlayback(
      `VSR 开关生效：第 ${currentEpisode.episodeNumber} 集 @ ${at.toFixed(1)}s 按原位置重新解析（链路=${next ? '转码分片' : '原始源'}）`,
    );
    void openEpisode(currentSeries.id, currentEpisode.id, at, currentQuality);
  }, [settings.vsrEnabled]);

  // 下一集
  const playNextEpisode = useCallback(() => {
    if (!currentSeries || !currentEpisode) return;
    const currentIndex = currentSeries.episodes.findIndex(e => e.id === currentEpisode.id);
    if (currentIndex >= 0 && currentIndex < currentSeries.episodes.length - 1) {
      const nextEp = currentSeries.episodes[currentIndex + 1];
      // 打点：区分"自动连播"与"用户按键"。两者都走这里，出问题时这行能说明是谁。
      tracePlayback(
        `playNextEpisode 调用 当前集=${currentEpisode.id} → 下一集=${nextEp.id} 会话=${activeSessionRef.current} 位置=${videoRef.current ? videoRef.current.currentTime.toFixed(2) : 'n/a'}s`,
      );
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
    // 末尾复核同理：人已经离开播放器，之后那次复核若能落地，会把下一集隐形拉起。
    cancelTailProbe();
    // 等待转码推进的任务同样收掉：它会改 currentTime，人已退出时那是隐形操作。
    cancelSeekWait();
    // 兜底链的分支判定同样作废：下次进播放器时新一集还没决定走哪条源，
    // 留着旧标记会让那一次的错误被静默跳过（审查 F3）。
    resetStreamingSource();
    // 流式转码窗口一并归零（本次会话整体作废，`stop` 已收掉它那一路 ffmpeg）。
    resetStreamingWindow();
    setStallNotice(null);
    // 离开播放器：那条"还没转好"的提示不该跟着到下一个页面。
    setSeekNotice(null);

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
    // 末尾静默兜底属于"这一集"：离开播放器必须收掉，否则它的续体会在后台
    // 调一次 handleEnded，把用户已经放弃的那一集结算成"看完了"并触发连播。
    stopTailEndGuard();
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
    /**
     * 交接起点：**已播完的集必须从头开始**（2026-10-23 修「小窗卡在正在准备画面」）。
     *
     * ## 现场
     *
     * 日志显示主窗口在 `48.07s / 48.1s`（已播完）时把 `position=48` 传给了小窗：
     *
     *   225.441s  打开集 ... 期望起点=48s
     *   240.610s  timeupdate 位置=48.07s 时长=48.1s   ← 一加载就在结尾
     *
     * 小窗拿到 48 秒的起点后，视频一挂载就 `ended`，而 `handleEnded` 里的
     * `autoNext` 分支又要走 `playEpisode(下一集)` —— 那条链路在小窗刚创建、
     * 交接包还没完全就绪时会静默失败，结果就是画面永远停在「正在准备画面」。
     *
     * ## 判据
     *
     * 与 `usableDuration` 比较而不是与 `video.duration` 比：后者在边转边播时
     * 等于"已转码进度"，不可靠。留 1.5 秒余量——用户停在最后 1.5 秒内时，
     * 他要看的是"下一集"，不是"这一集的最后 1.5 秒"。
     */
    const totalForHandoff = usableDuration(video);
    const rawPosition = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const nearEnd = totalForHandoff > 0 && rawPosition >= totalForHandoff - 1.5;
    /**
     * 已播完时交接**下一集**（而不是把这一集从 0 重播）。
     *
     * 用户点画中画的意图是"继续看下去"，而这一集已经看完了——从 0 重播会让他
     * 再看一遍刚看完的内容，是更差的体验。只有当"没有下一集"时才退回从头播。
     *
     * 注意 `episode` / `position` 必须一起换：只换 id 不换起点会让小窗从上一集
     * 的进度（48 秒）开始播新一集，直接又跳到结尾。
     */
    let handoffEpisode = episode;
    let handoffPosition = rawPosition;
    if (nearEnd) {
      const idx = series.episodes.findIndex(item => item.id === episode.id);
      const nextEp = idx >= 0 ? series.episodes[idx + 1] : undefined;
      if (nextEp) {
        handoffEpisode = nextEp;
        handoffPosition = 0;
        tracePlayback(
          `进入画中画：本集已播完（${rawPosition.toFixed(2)}/${totalForHandoff.toFixed(2)}s），改交接下一集 ${nextEp.id}`,
        );
      } else {
        // 最后一集：没有下一集可接，只能从头播这一集（比停在结尾强）。
        handoffPosition = 0;
        tracePlayback(
          `进入画中画：本集已播完且是最后一集，起点归零（${rawPosition.toFixed(2)}/${totalForHandoff.toFixed(2)}s）`,
        );
      }
    }
    if (!video.paused) video.pause();
    try {
      await openPip({
        kind: 'drama',
        seriesId: series.id,
        episodeId: handoffEpisode.id,
        title: series.title,
        cover: series.cover,
        channel: series.type,
        totalEpisodes: series.episodesCount,
        episodeNumber: handoffEpisode.episodeNumber,
        quality: currentQuality || 'auto',
        position: handoffPosition,
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
      /**
       * 交接成功 = 主窗口这一路必须**交干净**（2026-10-26 修「同一集两条会话」）。
       *
       * 现在的交接只是把主窗口 `hide()`，`currentView` 仍是 `player`，所以
       * App.tsx 里那条 `if (!isPlayer) stopPlayback()` **永远不会触发**。
       * 结果是：主窗口的会话（含转码 ffmpeg）一直挂着，小窗又新开一个 ——
       * 同一集两条会话、两路转码，用户感知是"进小窗后越来越卡"。
       *
       * 直接复用 `stopPlayback`：pause + 落盘 + detachSource + 作废会话号 +
       * 收预取池/看门狗，正是这里要的"交出去"语义，不另写一份。
       */
      stopPlayback();
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

  /**
   * `handleEnded` 的稳定引用。
   *
   * 为什么需要它：`handleWaiting` 在"已播到结尾附近却仍在等数据"时要复用
   * `handleEnded` 的完整语义（落盘、连播、全剧播完），但这两个监听器都只在
   * 挂载时绑定一次（见下方那段「监听器只绑定一次」的说明），`handleEnded`
   * 的闭包早于后者定义、也拿不到最新的 `currentEpisode`。
   *
   * 用 ref 转发而不是把 `handleWaiting` 也改成依赖数组重建：媒体事件监听器
   * **绝不能重绑** —— 那会把监听挂到已被丢弃的旧元素上（进度条 00:00 那个
   * 经典故障）。ref 是这里唯一不破坏该不变量的做法。
   */
  const handleEndedRef = useRef<(() => void) | null>(null);

  // 看门狗唯一的定时器型资源，组件卸载必须收口。Provider 理论上与窗口同寿，
  // 但 HMR 与严格模式会重挂载，漏掉就是一条常驻 interval。
  useEffect(() => () => { stopStallWatchdog(); }, [stopStallWatchdog]);

  /**
   * 武装「末尾静默兜底」（每次 `playing` 重新武装，见 `tailEndGuardRef` 的说明）。
   *
   * 与卡死看门狗的分工：
   *   - 看门狗治"画面该在动却不动"，恢复手段是重试 / 重装载；
   *   - 这个治"已经播到结尾、所有事件都不再来了"，恢复手段是**当作播完**收尾
   *     （落盘 100% + 触发连播），绝不重载 —— 重载只会让用户再看一遍结尾。
   */
  const armTailEndGuard = () => {
    stopTailEndGuard();
    const sessionId = activeSessionRef.current;
    let lastPos = -1;
    let idleTicks = 0;
    const tick = () => {
      tailEndGuardRef.current = null;
      const video = videoRef.current;
      if (!video || activeSessionRef.current !== sessionId) return;
      // 用户暂停在结尾看画面 / 正在拖进度：都不是卡住，重置计数继续等。
      if (video.paused || video.ended || video.seeking) {
        lastPos = video.currentTime;
        idleTicks = 0;
        tailEndGuardRef.current = window.setTimeout(tick, 1000);
        return;
      }
      const total = usableDuration(video);
      const cur = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      if (!(total > 0) || cur < total - 1.2) {
        lastPos = cur;
        idleTicks = 0;
        tailEndGuardRef.current = window.setTimeout(tick, 1000);
        return;
      }
      if (lastPos >= 0 && Math.abs(cur - lastPos) < 0.05) {
        idleTicks += 1;
      } else {
        idleTicks = 0;
      }
      lastPos = cur;
      if (idleTicks >= 3) {
        tracePlayback(
          `末尾静默兜底：位置=${cur.toFixed(2)}s 时长=${total.toFixed(1)}s 连续 ${idleTicks}s 未推进且没有任何媒体事件 → 按播完收尾`,
        );
        handleEndedRef.current?.();
        return;
      }
      tailEndGuardRef.current = window.setTimeout(tick, 1000);
    };
    tailEndGuardRef.current = window.setTimeout(tick, 1000);
  };

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
      onTailEnd: () => {
        // 会话已作废：这次判定属于已经被切走的那一集，不能拉起任何播放。
        // 返回 false：让看门狗保持未置位，下一拍重新判断（否则它会静默死亡）。
        if (activeSessionRef.current !== sessionId) return false;
        // 用户主动暂停优先：暂停在末尾的人是在逐帧看结尾，不该被推进下一集。
        // 同样返回 false：用户随时可能继续播放，看门狗要能继续跟踪。
        if (video.paused || video.seeking || video.ended) return false;
        setStallNotice(null);
        // 与 `waiting` 那条路同一个出口：`handleEnded` 自带落盘、连播闸门、
        // 迟到旧源过滤与"全剧播完"收尾，不需要另写一套。
        handleEndedRef.current?.();
        return true;
      },
    });
  }, [stopStallWatchdog]);

  // 监听播放器事件（缓冲、时间更新、结束）——只绑定一次，永不重绑。
  useEffect(() => {
    // ⚠️ 绑定源是**元素身份**（`videoElement`），不是 `videoRef.current`：
    // 元素被重挂时只有前者会变（见 `videoElement` 的长注释）。
    const video = videoElement;
    if (!video) return;

    // 起播打点「首帧-宿主」这个基准值。正常应该远小于 2000ms（本地文件是
    // 毫秒级）。若它显示出「画面在走、进度条 00:00」那种脱钩症状，这个数会
    // 一直停在装载那一刻之后很久不再刷新 —— 即 <video> 被重挂、而这份只绑定
    // 一次的监听器还挂在被丢弃的旧元素上。
    const mountedAt = performance.now();
    let firstTickAt: number | null = null;
    /** 心跳打点节流：每 5 秒记一条位置，用于定位"画面在走、进度条不动"。 */
    let lastTickTraceAt = 0;
    tracePlayback('首帧-宿主 监听器已绑定 video');

    const handleTimeUpdate = () => {
      /**
       * 旧源的事件绝不能喂给新一集。
       *
       * 换集是"同一块 `<video>` 换源"，两条时序并不重合：`currentEpisode` 状态
       * 先变成新集，而元素上的旧源还会再派发一两次 `timeupdate`。旧实现照单全收，
       * 于是把**上一集的位置**写进新一集的历史（`saveProgressThrottled` 用的是
       * 最新闭包里的 `currentEpisode`）——表现就是"这一集下次打开时进度条不在 0、
       * 从一个莫名其妙的时间点继续播"。
       *
       * `dataset.sessionId` 是每次换源时写入的会话号（所有赋 src / 挂 hls 的落点
       * 都会写），拿它和当前活动会话比对，就能把迟到事件按源头挡掉。
       *
       * ⚠️ **只在"标记确实存在且不等于当前会话"时才丢弃**（2026-10-19 修
       * 「画面在播、进度条不动」）。
       *
       * 原因：`dataset.sessionId` 在首帧真正落地之前是空串/undefined，
       * `Number('') === 0`、`Number(undefined) === NaN` —— 而 `activeSessionRef`
       * 从 100 起。写成"不相等就 return"，会在**还没写标记的那段时间**把每一帧
       * `timeupdate` 全部丢掉：画面自己照常播（媒体元素与 React 无关），
       * 但 `position` / `duration` / 历史进度一个都不更新，界面上的进度条于是
       * 停在原地。判据必须允许"没有标记"这种未知状态通过。
       */
      const taggedSession = Number(video.dataset.sessionId);
      if (isStaleElementSession(video, activeSessionRef.current)) {
        if (!staleTickNotedRef.current.has(taggedSession)) {
          staleTickNotedRef.current.add(taggedSession);
          tracePlayback(
            `timeupdate 丢弃：元素标记会话=${taggedSession} 当前会话=${activeSessionRef.current}（迟到事件）`,
          );
        }
        return;
      }
      if (firstTickAt === null) {
        firstTickAt = performance.now();
        tracePlayback(`首帧-宿主 首次 timeupdate 距装载=${Math.round(firstTickAt - mountedAt)}ms 位置=${video.currentTime.toFixed(2)}s 时长=${usableDuration(video).toFixed(1)}s`);
      }
      const cur = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      const dur = usableDuration(video);
      // 时钟真的往前走了：这是末尾复核唯一的"反证"。只要这里推进，之前预约的
      // 那次复核就作废——倍速切换/短暂抖动同样会派发 `waiting`，而它在下一个
      // timeupdate 就自己恢复了，绝不能因此把这一集判成播完。
      //
      // 比较基准就用复核自己记下的 `position`，不另设一个"上次推进时刻"的 ref：
      // 那个 ref 在全文件里只写不读（曾经写过一个，2026-10-20 复查时删掉）。
      const probe = tailProbeRef.current;
      if (probe && cur > probe.position + 0.06) {
        window.clearTimeout(probe.timer);
        tailProbeRef.current = null;
      }
      /**
       * 等待转码期间，`position` 读数按**用户点的目标**显示。
       *
       * 否则每 250ms 一次的 `timeupdate` 会把真实播放头写回进度条：用户拖到 90s，
       * 100ms 后就弹回当前能播的 20s —— 正是 `seekPlan` 注释承诺要避免的观感
       * （2026-10-26 修）。落位/超时/再次拖动时 `seekWaitTargetRef` 会清空。
       */
      const pendingSeek = seekWaitTargetRef.current;
      setPosition(pendingSeek !== null ? pendingSeek : cur);
      setDuration(dur);
      saveProgressThrottledRef.current(pendingSeek !== null ? pendingSeek : cur, dur);
      // 心跳：5 秒一条，带齐"界面读数到底该是多少"的三个输入。
      // 用户报"画面在播、进度条不动"时，只有这行能分清是事件没来、被守卫挡掉，
      // 还是时长算成了 0 —— 三种情况的处置完全不同。
      const tickNow = performance.now();
      if (tickNow - lastTickTraceAt >= 5000) {
        lastTickTraceAt = tickNow;
        tracePlayback(
          `timeupdate 心跳 位置=${cur.toFixed(2)}s 时长=${dur.toFixed(1)}s 标记会话=${video.dataset.sessionId || '(空)'} 当前会话=${activeSessionRef.current}`,
        );
      }
    };

    const handleProgress = () => {
      if (video.buffered.length > 0) {
        const end = video.buffered.end(video.buffered.length - 1);
        // 同 `handleTimeUpdate`：换源瞬间这里的读数可能是 NaN。
        if (Number.isFinite(end)) setBuffered(end);
      }
    };

    /**
     * 预约一次末尾复核（1.2 秒后回收）。
     *
     * 只允许一次在途：末尾卡住时 `waiting` 可能连着来好几发（hls.js 在每次
     * `bufferStalledError` 后都会重新触发一次），不去重就会排出一串定时器，
     * 每个都去调 `handleEnded`。
     */
    const scheduleTailProbe = () => {
      if (tailProbeRef.current) return;
      const sessionId = activeSessionRef.current;
      const position = video.currentTime;
      const bufferedAt = bufferedEndSeconds(video);
      /**
       * 预约这一刻的播放速率。
       *
       * ## 为什么必须记下来（2026-10-22 修「长按倍速会误跳下一集」）
       *
       * 下面那个 `clockIdle` 判据比的是"1.2 秒后播放头有没有动"。在 1x 下
       * 0.06 秒的容差是合理的；但**倍速下这个判据会给出完全相反的答案**：
       *
       *   - 3x 正常播放时，1.2 秒该推进 3.6 秒，`clockIdle` 必然为 false（安全）；
       *   - 可是 `waiting` 期间时钟**是停住的**。用户长按加速 → 倍速切换让
       *     hls.js 重取分片 → 派发 `waiting` → 1.2 秒后复核读到的还是那个
       *     旧位置 → `clockIdle` 为 true → 判成播完 → **跳下一集**。
       *
       * 于是"长按倍速"变成了"跳集触发器"，而且因为 `handleEnded` 里会把进度
       * 按 100% 落盘，进度条直接飞到结尾。这就是用户报的两个症状同源。
       *
       * 记下速率，复核时按 `rate × 时间` 算"应该推进多少"，而不是用固定 0.06。
       */
      const rateAtSchedule = video.playbackRate;
      const timer = window.setTimeout(() => {
        tailProbeRef.current = null;
        // 会话已作废 / 用户离开播放器：这次复核属于旧会话，静默丢弃。
        if (activeSessionRef.current !== sessionId) return;
        // 用户主动暂停或拖进度：那是在看结尾，不是卡住。
        if (video.paused || video.seeking || video.ended) return;
        if (!isPlayheadAtPlayableTail({
          currentTime: video.currentTime,
          duration: usableDuration(video),
          bufferedEnd: bufferedEndSeconds(video),
          paused: video.paused,
          seeking: video.seeking,
          ended: video.ended,
          playbackRate: video.playbackRate,
        })) {
          // 复核期间播放头已经离开末尾（例如用户拖回去）：按实际是否还有画面
          // 决定要不要显示"缓冲中"。
          //
          // 不能无条件下 buffering（2026-10-20 复查修正）：自愈成功之后画面其实
          // 在播，这时把界面按到 buffering 上会**永久转圈**——probe 已经置 null
          // 不再重排，再没有事件来纠正它。
          if (video.readyState < 3) {
            setUiState({ kind: 'buffering', sessionId });
          }
          return;
        }
        /**
         * 时钟"停住"的判据必须按倍速换算。
         *
         * 旧写法 `Math.abs(currentTime - position) <= 0.06` 在 1x 下成立、在
         * 倍速下**恰好反过来**：3x 时正常播放 1.2 秒该推进 3.6 秒，任何小于
         * 3.6 秒的推进都会被这条判成"没动"。而 `waiting` 期间时钟本来就停着，
         * 于是这条判据对"倍速 + waiting"这个组合永远给 true —— 误判播完。
         *
         * 改成"实际推进量 vs 该推进量"的比例判据：真的在播时比例接近 1，
         * 真的停住时接近 0。取 25% 为界——解码抖动可能让推进略慢于理论值，
         * 但不会慢到只剩四分之一。
         */
        const expectedAdvance = (TAIL_PROBE_DELAY_MS / 1000) * Math.max(rateAtSchedule, 1);
        const actualAdvance = video.currentTime - position;
        const clockIdle = actualAdvance < expectedAdvance * 0.25;
        const dataIdle = bufferedEndSeconds(video) <= bufferedAt + 0.06;
        if (!clockIdle || !dataIdle) {
          // 时钟还在走 / 缓冲还在长：这不是末尾停滞，是正常播放或慢网缓冲。
          // 同上：只有真的没有可播画面时才显示 buffering。
          if (video.readyState < 3) {
            setUiState({ kind: 'buffering', sessionId });
          }
          return;
        }
        tracePlayback(
          `末尾停滞复核命中：按本集播完处理 current=${video.currentTime.toFixed(2)}s duration=${usableDuration(video).toFixed(2)}s buffered=${bufferedEndSeconds(video).toFixed(2)}s readyState=${video.readyState} 倍速=${rateAtSchedule}x 应推进=${expectedAdvance.toFixed(2)}s 实推进=${actualAdvance.toFixed(2)}s`,
        );
        handleEndedRef.current?.();
      }, TAIL_PROBE_DELAY_MS);
      tailProbeRef.current = { timer, position };
    };

    const handleWaiting = () => {
      // 只在真正有源、且确实处于播放态时才报缓冲。
      // 旧实现无条件播报，换集时 video.load() 触发的空源 waiting 会让
      // 转圈图标闪一下，加重"卡顿"的观感。
      if (!video.currentSrc && !video.src) return;
      /**
       * 换源交接期旧源补发的 `waiting` 不属于当前这一集（2026-10-20 复查修正）。
       *
       * 这是四个媒体事件里**唯一**漏了这道守卫的（`timeupdate` / `playing` /
       * `error` 都有）。伤害在于：它会用**当前**会话号预约一次末尾复核，
       * 而 `position` / `bufferedAt` 采样自**旧源**；1.2 秒后那次复核拿旧源的
       * 快照去判新集，会话号却对得上，所有下游守卫都拦不住。
       */
      if (isStaleElementSession(video, activeSessionRef.current)) return;
      /**
       * 已经播到结尾附近却还在等数据 → **这不是缓冲，是播完了**。
       *
       * ## 为什么必须在这里判（2026-10-18 修「播到最后一直缓冲」）
       *
       * 播放源是边转边播的整集 HLS。最后一小段分片落地之前，`video` 会停在
       * 倒数第二片的末尾并派发 `waiting`，界面于是显示「缓冲中…」—— 提示本身
       * 没错，问题在**之后没有出口**：
       *
       *   - ffmpeg 早已转完（清单里有 `#EXT-X-ENDLIST`），`buffered` 不再增长；
       *   - 看门狗因此判定"卡死"，第 1 级恢复是把 `currentTime` 写回原处 ——
       *     可那里本来就没有下一帧，seek 之后依然没数据；
       *   - 第 2 级重装载同一集，播到同一位置再卡一次（额度用尽后弹错误卡）。
       *
       * 而浏览器**不会**在这种情况下派发 `ended`：`ended` 要求播放位置真的到达
       * 时长末尾，差半秒停在缓冲上就不算。用户看到的就是"最后一直在转圈，
       * 切下一集才恢复正常"。
       *
       * ## 2026-10-19：判定改成"位置 + 1.2 秒复核"
       *
       * 0.2.20 那版用单帧快照 + `bufferedEnd >= duration - 0.15 → return false`
       * 排除"数据已完整缓冲"的瞬时抖动，结果把**唯一能救的那一类**也排掉了：
       * 逐集核对 120 集产物，`buffered.end` 与 `duration` 只差 **0.00~0.07 秒**
       * —— 也就是"末段全部进缓冲、播放头却再也走不到末尾"的现场必然落进那条
       * 排除条件里，判定恒 false，`waiting` 之后只剩 `buffering`，永远不结束。
       *
       * 现在单帧只负责回答"是不是停在可播末端"，是否真的播完由 1.2 秒后的
       * 复核回答：那时时钟没推进、缓冲没增长，才算这一集播完。倍速切换那种
       * 瞬时抖动会在下一个 `timeupdate` 自行前进，复核随之作废。
       */
      const total = usableDuration(video);
      const tailSnapshot = {
        currentTime: video.currentTime,
        duration: total,
        bufferedEnd: bufferedEndSeconds(video),
        paused: video.paused,
        seeking: video.seeking,
        ended: video.ended,
        playbackRate: video.playbackRate,
      };
      const atTail = isPlayheadAtPlayableTail(tailSnapshot);
      // ⚠️ 末尾复核必须放在 `readyState >= 3` 早退**之前**：末段全部进缓冲时
      // readyState 恰好是 4，而卡死就发生在这一刻。旧实现把它早退掉，
      // 判定连执行的机会都没有（这也解释了为什么打点里只剩 waiting 没有下文）。
      if (atTail) {
        /**
         * 缓冲已经覆盖整集末尾 → **不必等 1.2 秒复核**，当场判播完。
         *
         * ## 为什么可以不等（2026-10-23 修「每集末尾卡一下」）
         *
         * 实机日志里 5 次末尾停滞全部是"数据已经全部到齐"：
         *
         *   current=43.19 duration=43.24 buffered=43.26
         *   current=44.63 duration=44.84 buffered=44.86（3x 倍速）
         *
         * `buffered` 已经 ≥ `duration`，再等也不会来新数据 —— 那 1.2 秒是纯延迟，
         * 用户看到的就是"画面停在最后一帧不动，一秒多之后才切集"。
         *
         * 判据用 `isBufferComplete`（比 `atTail` 更严：要求缓冲真的到顶），
         * 所以"播放头追上缓冲、但后面还有分片没落地"的情况仍然走复核，不会误判。
         */
        if (isBufferComplete(tailSnapshot)) {
          tracePlayback(
            `末尾数据已齐，立即判定播完 current=${video.currentTime.toFixed(2)}s duration=${total.toFixed(2)}s buffered=${tailSnapshot.bufferedEnd.toFixed(2)}s`,
          );
          handleEndedRef.current?.();
          return;
        }
        scheduleTailProbe();
      }
      if (video.readyState >= 3) return;
      if (atTail) {
        // 位置已经判定在末尾：等复核结果，不再显示"缓冲中"误导用户
        // （这里不改 uiState，`playing` 会在复核命中时被 `handleEnded` 覆盖）。
        return;
      }
      // 缓冲**不**卸看门狗：解码线程卡死时 `waiting` 照样会派发且再也不回来，
      // 在这里卸掉它恰好会漏掉本次要治的那个症状。区分"慢网缓冲"与"真卡死"
      // 靠的是看门狗里那条"没有新数据在进"——缓冲期间 buffered 还在长。
      setUiState({ kind: 'buffering', sessionId: activeSessionRef.current });
    };

    const handlePlaying = () => {
      // 换源交接期旧源可能补发一次 playing：它不属于当前这一集，
      // 让它继续走会把 UI 与实际画面绑错，也会用旧位置写一条新集的历史。
      //
      // ⚠️ 同样只在"标记存在且不匹配"时丢弃。写成无脑不等判断，会在首帧落地前
      // 把每一次 playing 都丢掉 —— 界面于是永远停在 opening/buffering，
      // 而视频其实已经在播（与 `handleTimeUpdate` 那条是同一个坑）。
      if (isStaleElementSession(video, activeSessionRef.current)) {
        tracePlayback(
          `playing 丢弃：元素标记会话=${video.dataset.sessionId} 当前会话=${activeSessionRef.current}（迟到事件）`,
        );
        return;
      }
      // 播完后又重新开播（用户把进度拖回再播）即撤销"全剧播完自动返回详情"的安排。
      setFinishedAll(false);
      // 之前预约的末尾复核属于"上一次停下"的现场：画面已经重新推进，
      // 那次复核若能落地，就会在正常播放中把人推进下一集。
      cancelTailProbe();
      // 真正开播这一刻才武装看门狗（装载等待期里没有帧是正常的）。
      armStallWatchdog();
      // 末尾静默兜底同样从这一刻起算：每次 `playing` 都重新武装，换集/暂停都会
      // 由 tick 内部的条件自行退出或重置（见 `tailEndGuardRef`）。
      armTailEndGuard();
      // 画面真的回来了就收回卡死提示。第 1 级原地重试恢复时由看门狗的 onHealthy
      // 负责，但第 2 级重装载换了一个**新的**看门狗实例（stalled 初值 false，
      // onHealthy 永远不会来），只能由这里兜底——否则横幅会一直挂在正常播放上。
      setStallNotice(null);
      setIsPlaying(true);
      setUiState({
        kind: 'playing',
        sessionId: activeSessionRef.current,
        // 换源瞬间 `currentTime` 可能是 NaN，直接塞进 uiState 会污染下游进度显示。
        position: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      });
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
      /**
       * ⚠️ 这里**必须打点**（2026-10-23 补）。
       *
       * 此前整个 `handleEnded` 没有任何日志，于是"视频没播完就跳到下一集"这种
       * 故障在 `ttv-playback.log` 里**完全没有痕迹**——只能看到 `打开集`，却分不清
       * 是 `ended` 事件、末尾复核、还是用户按键触发的。排查时只能靠猜。
       *
       * 这一行把"谁触发的"和"当时播到哪"一起记下来，是后面所有判断的依据。
       */
      tracePlayback(
        `handleEnded 触发 current=${Number.isFinite(video.currentTime) ? video.currentTime.toFixed(2) : 'NaN'}s duration=${usableDuration(video).toFixed(2)}s 会话=${activeSessionRef.current} 集=${videoCommittedRef.current?.episodeId ?? '(未标记)'}`,
      );
      // 一集播完，看门狗的使命就结束了："本该在播却不播"的前提不再成立。
      // 不停掉的话，播完静置 10 秒它会照着 ended 状态（paused 仍为 false）
      // 误判成卡死并拉起恢复流程。下一集真正开播时 handlePlaying 会重新武装。
      stopStallWatchdog();
      // 末尾复核（`waiting` 那条路）与看门狗的 `onTailEnd` 可能先后都到：
      // 这里把在途复核收掉，保证一集只结算一次。
      cancelTailProbe();
      // 末尾静默兜底同理：它自己也可能正是这次的触发者，收掉避免重复排拍。
      stopTailEndGuard();
      setIsPlaying(false);
      setUiState({ kind: 'ended', sessionId: activeSessionRef.current });
      // 落盘"这一集看完了"必须归属**真正放完的那一集**。
      //
      // 旧实现无条件按 currentEpisode 写 100% 完成：交接期 currentEpisode 已经是
      // 下一集，于是一次播放结束会把下一集标成"已看完"，历史页随即显示错误的集数。
      const ctxEnded = handlerCtxRef.current;
      // 方案 B 删掉了这里的「前缀片段播到末尾 → 就地接整集」分支。
      //
      // 那一段是为「前缀只有开头十几秒」设计的补丁：短片段播到头时其实没播完，
      // 需要重载同一集接住。现在播放源是**整集 HLS**（转码产物带 ENDLIST，
      // 覆盖全片），播到末尾就是真的播完了 —— 再留这段只会把正常结束误判成
      // 「片段到头」，白白重载一次。
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

    // 交给 `handleWaiting` 复用（见 `handleEndedRef` 的说明）。
    handleEndedRef.current = handleEnded;

    const handleError = () => {
      // 清理旧源时 WebView2 可能派发一次空源 error，不应覆盖真实播放状态。
      if (!video.currentSrc && !video.src) return;
      // 源已经报错：恢复交给下面的三级兜底链（备用直链 → Blob → 本地解析），
      // 看门狗此刻只会跟它抢同一块画面。
      stopStallWatchdog();
      // 末尾静默兜底也一并收掉：这一集已经报了错，不能再被它判成"播完了"。
      stopTailEndGuard();
      // 接管流程（adoptPreparedSource / playDirect）进行中：这次 error 是它自己的
      // 事务，由它重试或判死。这里若抢先弹错误页，就会出现"视频已播起来、
      // 界面却停在错误页"，也会让 playDirect 的兜底完全失效。
      if (adoptingRef.current) return;
      // 本地解析在途：直链失败不代表应用内播不了，保持 opening 等结果。
      //
      // ⚠️ 但**必须核对归属**。方案 B 之后整集 HLS 是唯一播放源，一旦这里
      // 无脑早退，而那条在途 promise 其实属于**别的会话**（旧会话遗留、或解析
      // 早已收口只剩一个未清的引用），这次 fatal 就会被完全吞掉：
      // 下面的备用直链/Blob 会跳过、错误卡片也不弹，界面停在没有画面、没有报错、
      // 也没有重试入口的状态 —— 那是比报错更糟的黑洞。
      //
      // 判据与 `startNativeResolve` 记账时写入的 sessionId 对齐：只有"属于当前
      // 会话"的在途才有资格压住这次错误。
      if (nativeResolveInFlightRef.current) {
        const inflightSession = nativeResolveSessionRef.current;
        const currentSession = activeSessionRef.current;
        if (inflightSession === currentSession) return;
        tracePlayback(
          `handleError：在途解析属于会话 ${inflightSession}，当前 ${currentSession}，不早退`, 
        );
        nativeResolveInFlightRef.current = null;
      }
      // 会话已作废（用户已离开播放器 / 已有更新的切换接管）：整条兜底链
      // （备用直链 → Blob → 本地解析）都不再启动——它们的续体最终都会
      // play()，等于人已退出却隐形开播。
      //
      // ⚠️ 与 `handleTimeUpdate` / `handlePlaying` 同一个坑（2026-10-20 修「播放中卡住
      // 且无任何自愈」）：`dataset.sessionId` 在首帧落地前是空串（`Number('') === 0`），
      // 而当前会话号从 100 起。写成"不相等就 return"，会在那段窗口把 hls.js 的 fatal
      // **整个吞掉** —— 不弹错误卡、不进自愈、也不打一行日志，播放器就那样停在那里。
      // 日志实证：新进程里两次 `fragLoadError fatal=true` 之后没有任何「流式源自愈」行。
      const errorSession = Number(video.dataset.sessionId);
      if (isStaleElementSession(video, activeSessionRef.current)) {
        tracePlayback(
          `handleError 丢弃：元素标记会话=${errorSession} 当前会话=${activeSessionRef.current}（迟到事件）`,
        );
        return;
      }
      const ctx = handlerCtxRef.current;
      // 本地流式 HLS 出错时**不能走备用直链与 Blob 这两步**：
      //   - 备用直链是同一个源的 CENC 加密地址，WebView 根本解不开；
      //   - Blob 那一步会把 `currentSrc`（一个 m3u8 播放列表）fetch 成几百字节
      //     文本再当媒体源，必然再报一次错。
      // 两者都会把一次「转码暂时没跟上」升级成「该媒体无法由 WebView 解码」的
      // 错误卡片，而真实处置只有一个：让整集链路接管（它本来就在跑）。
      if (streamingSourceRef.current) {
        tracePlayback('流式源报错：跳过备用直链/Blob，交给整集链路接管');
        /**
         * 流式 HLS 出错时的**唯一**正确处置：用同一个 m3u8 就地重挂。
         *
         * ## 为什么不能继续往下走（2026-10-19 修「播放中偶发弹错误卡」）
         *
         * 旧实现只打了一行日志就继续往下，于是掉进"本地解析"那一级：
         * `startNativeResolve` 会重新走签名 → 下载整集 13~27MB → 解密 → 重编码，
         * 实测 7~10 秒，期间界面是全屏 `opening` 遮罩；失败就弹错误卡。
         * 而实际发生的往往只是「ffmpeg 还没写好后一个分片」——画面本来是好的。
         * 用户看到的就是"播放正常，突然卡住并提示后台还在转码"。
         *
         * 现在：重挂同一地址（命中已转好的产物时后端 10ms 级返回），最多两次。
         * 两次都不行才判死，并且**不再退回整集 mp4**（那条链路与 HLS 产物的
         * 会话/目录是同一份，重下只会更慢）。
         */
        const streamUrl = streamUrlRef.current;
        // 自愈也有会话边界：先把挂起的那次自愈收掉，避免同一集并发自愈
        // （两条 handleError 各自排一个 1.2 秒定时器，会各自 attachSource）。
        cancelStreamRecover();
        // 末尾复核也要收：它采样的是"出错前"的元素状态，自愈换源之后
        // 那次采样对新源毫无意义，落地只会把界面按在 buffering 上。
        cancelTailProbe();
        /**
         * 先问总账要不要继续（2026-10-20）。
         *
         * 这一层与 hls.js 内层（`MAX_IN_PLACE_RECOVERY`）原本各管各的计数，
         * 叠起来没有上界：实测一次卡顿里两层轮流重试，界面锁在缓冲态 158 秒，
         * 用户既看不到原因也没有出口。现在次数或总时长任一超限就进入终态。
         */
        const canRecover = (streamUrl || (ctx.currentSeries && ctx.currentEpisode))
          && streamRecoverRef.current < MAX_STREAM_RECOVER;
        const budgetDenied = canRecover ? claimStreamRecovery() : null;
        if (budgetDenied) {
          tracePlayback(`流式源恢复预算耗尽，停止重试：${budgetDenied.reason}`);
          setIsPlaying(false);
          setUiState({
            kind: 'error',
            sessionId: activeSessionRef.current,
            code: 'MEDIA_LOAD_FAILED',
            recoverable: true,
          });
          return;
        }
        if (canRecover) {
          streamRecoverRef.current += 1;
          const attempt = streamRecoverRef.current;
          const sessionAtRecover = activeSessionRef.current;
          const resumeAt = Number.isFinite(video.currentTime) ? video.currentTime : 0;
          tracePlayback(
            `流式源自愈 第 ${attempt} 次：1.2 秒后重新开播这一集（位置 ${Math.round(resumeAt)}s，触发后端续转）`,
          );
          // 轻提示，不遮画面：用户此刻还能看到最后一帧。
          setUiState({ kind: 'buffering', sessionId: sessionAtRecover });
          const timer = window.setTimeout(() => {
            streamRecoverTimerRef.current = null;
            if (activeSessionRef.current !== sessionAtRecover) return;
            const el = videoRef.current;
            const series = handlerCtxRef.current.currentSeries;
            const episode = handlerCtxRef.current.currentEpisode;
            if (!el || !series || !episode) return;
            /**
             * ⚠️ 关键：自愈必须**重新问后端要一次地址**，而不是把旧 m3u8 再挂一遍。
             *
             * 原因就是用户报的那条：「播着播着转码失败，要重新从头播放才能加载完后面」。
             * ffmpeg 中途退出后，磁盘上的产物停在半截（没有 `#EXT-X-ENDLIST`），
             * 旧地址指过去得到的永远是 404/503 —— 重挂多少次都没用。只有重新走一次
             * `open_stream`，后端才会发现这个 vid 的产物不完整、重新起一路转码
             * （`start_video_cache` 的 ENDLIST 判定），并把新地址交回来。
             *
             * 这正是"用户手动重开这一集"的等价动作，只是不用他手动、也不打断播放位置。
             */
            const contentType = series.type === 'comic' ? 1004 : 1;
            void ipcService.playback
              .openStreamNative(series.id, episode.id, sessionAtRecover, contentType)
              .catch((error: unknown) => {
                // 不能静默吞成 null（2026-10-20 复查修正）：VSR 开关关闭时后端是
                // **确定性** Err，吞掉之后就只剩"拿旧地址再挂一次、必 404、再自愈"
                // 的空转，日志里永远看不到真正的原因。
                tracePlayback(`流式源自愈：重新申请地址失败 ${describeError(error)}`);
                return null;
              })
              .then(fresh => {
                if (activeSessionRef.current !== sessionAtRecover) return null;
                const url = fresh && fresh.streamKind === 'hls' && fresh.playUrl
                  ? fresh.playUrl
                  : streamUrl;
                if (!url) {
                  // 地址彻底没了：这不是"能靠再挂一次恢复"的状态，直接抛出交给
                  // 下面的 catch 判死，别用 `return null` 把界面留在 buffering。
                  throw new Error('流式源自愈：没有可用的播放地址');
                }
                streamUrlRef.current = url;
                // 自愈重挂的是**同一集**，所以起播点就是恢复位置本身：交给 hls.js
                // 从一开始就拉正确的位置，比"从头拉再 seek 过去"少一次无效请求。
                return attachSource(el, url, resumeAt > 0.5 ? resumeAt : 0)
                  .then(() => {
                    // 恢复位置必须等 metadata（2026-10-20 复查修正）。
                    //
                    // `attachSource` 返回时只完成了 attachMedia + loadSource，
                    // `readyState` 通常还是 0；此时给元素赋 `currentTime` 抛
                    // InvalidStateError 被旧代码的空 catch 吞掉，位置静默回 0 ——
                    // 用户看到的就是"自愈之后从头播"，正是本条修复要治的症状。
                    // 仓库里 `useAnimePlayerStore` 早就是对的（先判 readyState 再挂
                    // loadedmetadata），这里照抄，并补 `{ once: true }`。
                    if (resumeAt > 0.5) {
                      const applySeek = () => {
                        try {
                          el.currentTime = resumeAt;
                        } catch {
                          // 仍不可 seek：让用户自己拖，至少不是静默从头播。
                        }
                      };
                      if (el.readyState >= 1) applySeek();
                      else el.addEventListener('loadedmetadata', applySeek, { once: true });
                    }
                    return playBounded(el);
                  });
              })
              .then(result => {
                if (result === null || activeSessionRef.current !== sessionAtRecover) return;
                setIsPlaying(true);
                setUiState({ kind: 'playing', sessionId: sessionAtRecover, position: el.currentTime });
                // 成功后回血（2026-10-20 复查修正）：恢复成功说明这个源是好的，
                // 额度必须还回去。否则一集里攒够 MAX_STREAM_RECOVER 次**互不相关**
                // 的瞬时故障就永久判死，用户得手动重开这一集。
                streamRecoverRef.current = 0;
                tracePlayback(`流式源自愈成功（第 ${attempt} 次）`);
              })
              .catch((error: unknown) => {
                if (activeSessionRef.current !== sessionAtRecover) return;
                tracePlayback(`流式源自愈失败（第 ${attempt} 次）${describeError(error)}`);
                // ⚠️ 用**本次调用的局部** `attempt` 判死，不读 `streamRecoverRef`。
                //
                // 那个计数器会被 `resetStreamingSource` 归零（换集、预载快路径都会
                // 调到它），读它就会出现"第 2 次明明失败了、却因为别人刚清零而不报错"，
                // 界面永远停在 buffering。
                if (attempt >= MAX_STREAM_RECOVER) {
                  setIsPlaying(false);
                  setUiState({
                    kind: 'error',
                    sessionId: sessionAtRecover,
                    code: 'MEDIA_LOAD_FAILED',
                    recoverable: true,
                  });
                }
              });
          }, STREAM_RECOVER_DELAY_MS);
          streamRecoverTimerRef.current = { timer, sessionId: sessionAtRecover };
          return;
        }
        // 地址丢了或额度用尽：如实报错，绝不退回整集 mp4。
        setIsPlaying(false);
        setUiState({
          kind: 'error',
          sessionId: activeSessionRef.current,
          code: 'MEDIA_LOAD_FAILED',
          recoverable: true,
        });
        return;
      } else {
      const backupUrl = backupUrlRef.current;
      if (backupUrl && !hasTriedBackupRef.current) {
        hasTriedBackupRef.current = true;
        // 用户已离开播放器（会话已作废）：不再补播备用直链，避免隐形出声。
        // 判据走 `isStaleElementSession`：首帧落地前元素上还没有标记，
        // 旧写法（不相等即 return）会把这条路整条跳过。
        if (isStaleElementSession(video, activeSessionRef.current)) return;
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
        /**
         * 发起这次 Blob 兜底的会话号，与上面 `sessionAtBackup` 同一个用意。
         *
         * 旧写法拿 `Number(video.dataset.sessionId)` 当凭证：元素上标记为空时
         * 它是 0（或 NaN），与从 100 起的会话号必然不等 → `pauseIfStale` 直接
         * 判成"已换集"，把刚挂好的 Blob 播放掐掉；`isStaleElementSession` 则
         * 反过来放行一切。两边的错法不同，根子都是"用元素标记代表发起者"。
         * 发起者只有调用点自己知道，就记在这里。
         */
        const sessionAtBlob = activeSessionRef.current;
        void fetch(sourceUrl, { cache: 'no-store', referrerPolicy: 'no-referrer' })
          .then(response => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.blob();
          })
          .then(blob => {
            if (pauseIfStale(sessionAtBlob, video)) return;
            objectUrlRef.current = URL.createObjectURL(blob);
            detachSource(video);
            video.src = objectUrlRef.current;
            const blobCtx = handlerCtxRef.current;
            if (blobCtx.currentEpisode) markSourceCommitted(sessionAtBlob, blobCtx.currentEpisode.id);
            video.load();
            // Blob 直播的 play() 同样要设保底：挂死时这条 .then 永不落地，
            // 下面的本地解析兜底就永远轮不到。
            return playBounded(video);
          })
          .then(() => {
            if (pauseIfStale(sessionAtBlob, video)) return;
            setIsPlaying(true);
            setUiState({ kind: 'playing', sessionId: sessionAtBlob, position: video.currentTime });
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
      // 宿主卸载（HMR / 严格模式重挂载）时把末尾复核与挂起的自愈一并收掉，
      // 不留孤儿定时器。自愈那条尤其重要：它的回调会 openStreamNative +
      // attachSource + play，落到已卸载的元素上就是"人走了画面还在动"。
      cancelTailProbe();
      cancelStreamRecover();
    };
    // 有意留空依赖：监听器只绑定一次。
    // 旧版把 currentSeries / currentEpisode / currentQuality / 播放进度这类状态 /
    // isMuted 都列进依赖，导致倒计时每秒、每次换集都全量摘绑 6 个监听器——
    // 既是性能抖动源，也有 listener 泄漏风险。所有需要的状态改由
    // handlerCtxRef 实时读取，saveProgressThrottled 用 ref 间接调用。
    // 依赖只留**元素身份**：同一个元素不重绑（否则每次渲染都要摘挂 7 个监听器，
    // 这正是当年把十几个 state 列进依赖踩过的坑）；换了元素必须重绑，
    // 否则进度条 00:00 / 到结尾不连播（2026-10-25 修复的正是这一类）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoElement]);

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
    setVsrEnabled,
    playNextEpisode,
    playPrevEpisode,
    toggleSideDrawer: (open) => setIsSideDrawerOpen(prev => open ?? !prev),
    toggleDiagnostics: (open) => setIsDiagnosticsOpen(prev => open ?? !prev),
    stopPlayback,
    setMuted,
    prewarmEpisode,
    enterPip,
    getCurrentStreamUrl: () => streamUrlRef.current || "",
    dismissStallNotice,
    // `seekNotice` 本身不进 actions 专线（见 `PlaybackActionsContextType` 的
    // Omit 说明），但**关闭动作**要进：小窗回流桥等宿主可能想撤掉它。
    dismissSeekNotice,
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
        registerVideoElement,
        openEpisode,
        togglePlay,
        seek,
        seekRelative,
        setVolume,
        toggleMute,
        setPlaybackRate,
        setQuality,
        vsrEnabled,
        setVsrEnabled,
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
    getCurrentStreamUrl: () => streamUrlRef.current || "",
        stallNotice,
        dismissStallNotice,
        seekNotice,
        dismissSeekNotice,
  };

  /**
   * 低频动作专线：只有换剧 / 换集 / 开关抽屉 / 音量切档这类**用户操作**才会变，
   * 播放进度（position / buffered / duration）刻意不在其中。
   *
   * 依赖里只列低频 state —— 方法走 actionsRef 转发，所以不必（也不能）列进来。
   */
  const actionsValue = useMemo<PlaybackActionsContextType>(() => ({
    currentSeries,
    getCurrentStreamUrl: () => streamUrlRef.current || "",
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
    setVsrEnabled: (enabled) => actionsRef.current!.setVsrEnabled(enabled),
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
    dismissSeekNotice: () => actionsRef.current!.dismissSeekNotice(),
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
