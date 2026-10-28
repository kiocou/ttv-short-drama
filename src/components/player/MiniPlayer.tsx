import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Loader2,
  Maximize2,
  Pause,
  Play,
  RotateCw,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { generateNextSessionId, ipcService } from '../../services/ipc';
import { attachAnimeSource, detachAnimeSource, streamKindOf } from '../../services/animePlayback';
import { attachSource, detachSource } from '../../services/hlsAttach';
import { isBufferComplete, isPlayheadAtPlayableTail } from '../../services/playbackTail';
import { resolveStartTarget } from '../../services/playbackStart';
import { planSeek, seekableReached } from '../../services/seekPlan';
import { hintHlsLoadPosition } from '../../services/hlsAttach';
import { tracePlayback } from '../../services/playbackTrace';
import { formatTime } from './ProgressBar';
import {
  closePip,
  listenPip,
  PIP_HANDOFF_EVENT,
  PIP_SHOW_FAILED_EVENT,
  PIP_SHOWN_EVENT,
  readPipHandoff,
  reportPipProgress,
  type PipHandoff,
} from '../../services/pip';

/**
 * 画中画小窗（独立置顶窗口）的播放界面。
 *
 * ## 它是一台**自给自足**的迷你播放器
 *
 * 主窗口把"哪部剧、哪一集、播到几秒、音量/倍速/连播设置"打包交过来，小窗自己按
 * 同一条链路解析播放地址（短剧 `short_drama_app_resolve`、动漫 `playback_open`），
 * 自己管上一集/下一集，自己上报进度。理由见 `services/pip.ts` 的文件头：跨窗口共享
 * 播放地址既不可靠（动漫是 MSE 的 blob:）也没必要。
 *
 * ## 唯一的硬约束：播放权同一时刻只属于一个窗口
 *
 * 它由三件事共同保证：
 *   1. 主窗口在下发交接包后立刻暂停自己的 `<video>`（`enterPip`）；
 *   2. 主窗口离开播放器视图时走 `stopPlayback()`，作废会话；
 *   3. 主窗口要自己起播时调 `pip_dismiss()`，把小窗拆掉。
 *
 * 本文件不引入任何主窗口的 store：小窗是独立 WebView，那些 store 在这里是另一份
 * 互不相干的实例，读它们只会得到"看起来能用、实际不同步"的假象。
 */

/** 进度上报间隔：太密会让 IPC 变成每秒十几次的噪音，太疏则系统关闭时丢进度。 */
const REPORT_INTERVAL_MS = 2000;

/**
 * 小窗「等转码追上目标再落位」的轮询参数。
 *
 * 与主播放器同量级（250ms / 8s）：转码是 13~29 倍实时，缺的内容通常几百毫秒
 * 就补上；轮询间隔比一个分片（0.6~3 秒）短一个数量级，用户感知不到延迟。
 */
const PIP_SEEK_WAIT_POLL_MS = 250;
const PIP_SEEK_WAIT_TIMEOUT_MS = 8000;

/**
 * `play()` 的保底时限。
 *
 * 整集 HLS 是"边转边播"：清单还没落地时 `<video>` 上 `play()` 既不 resolve
 * 也不 reject，小窗于是永久停在"加载中"，连错误都出不来（主播放器踩过同一个坑，
 * 见 `usePlaybackStore` 的 `playBounded`）。这里只做小窗需要的那一点：
 * 超时先看元素是否其实已经能播，否则按失败交给上层的错误提示。
 */
const PLAY_PENDING_TIMEOUT_MS = 8000;

function playBounded(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      if (video.readyState >= 3 && !video.error) {
        resolve();
        return;
      }
      reject(new DOMException('播放超时：源没有数据也没有报错', 'TimeoutError'));
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

/** 无边框窗口没有系统边框，缩放方向必须由前端算好传给 `startResizeDragging`。 */
type ResizeDir =
  | 'North'
  | 'South'
  | 'East'
  | 'West'
  | 'NorthEast'
  | 'NorthWest'
  | 'SouthEast'
  | 'SouthWest';

/** 八向缩放把手：方向 + 命中区（无边框窗口没有系统边框，方向得由前端告诉原生窗口）。 */
const RESIZE_HANDLES: Array<{ direction: ResizeDir; className: string }> = [
  { direction: 'North', className: 'top-0 inset-x-0 h-1.5 cursor-ns-resize' },
  { direction: 'South', className: 'bottom-0 inset-x-0 h-1.5 cursor-ns-resize' },
  { direction: 'West', className: 'left-0 inset-y-0 w-1.5 cursor-ew-resize' },
  { direction: 'East', className: 'right-0 inset-y-0 w-1.5 cursor-ew-resize' },
  { direction: 'NorthWest', className: 'top-0 left-0 w-3 h-3 cursor-nwse-resize' },
  { direction: 'NorthEast', className: 'top-0 right-0 w-3 h-3 cursor-nesw-resize' },
  { direction: 'SouthWest', className: 'bottom-0 left-0 w-3 h-3 cursor-nesw-resize' },
  { direction: 'SouthEast', className: 'bottom-0 right-0 w-3 h-3 cursor-nwse-resize' },
];

/** 集数文案：标题与"第 N 集"等价时不再重复拼接（与两个主播放器同一规则）。 */
function episodeLabel(episodeNumber: number, title?: string): string {
  const base = `第 ${episodeNumber} 集`;
  const trimmed = (title || '').trim();
  if (!trimmed) return base;
  const compact = (text: string) => text.replace(/\s+/g, '');
  return compact(trimmed) === compact(base) ? base : `${base} · ${trimmed}`;
}

export const MiniPlayer: React.FC = () => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [handoff, setHandoff] = useState<PipHandoff | null>(null);
  const [currentEpisodeId, setCurrentEpisodeId] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(0.85);
  const [muted, setMuted] = useState(false);
  /** 仅在自动播放被拦时出现：如实告诉用户"现在是静音在放"。 */
  const [muteNotice, setMuteNotice] = useState(false);

  // 会话号：任何一次换集都会让它递增，让先前的异步续体自动作废（同一个模式在
  // 主播放器里叫 sessionId，理由相同——resolve 与 play 之间隔着好几秒的 await）。
  const sessionRef = useRef(0);
  const currentEpisodeIdRef = useRef('');
  const lastReportRef = useRef(0);
  /**
   * 用户的播放意图：被系统/省电策略静默暂停时，靠它与"用户主动暂停"区分开。
   *
   * 只由用户手势与起播链路的显式动作写入（**不写** pause 事件）：WebView2 对
   * "被判定为后台"的窗口会静默暂停视频，而那同样会触发 pause 事件，写进去就再也
   * 分不出"它自己停的"和"用户按的"。
   */
  const playIntentRef = useRef(false);

  /**
   * 这一集的**源片真实时长**（秒），来自后端的 `durationMs`。
   *
   * 整集 HLS 是边转边播：转码没结束时清单里还没有 `#EXT-X-ENDLIST`，浏览器的
   * `video.duration` 要么是 `Infinity`、要么等于"已经转到的位置"，进度条于是
   * 一路往上跳。后端在开播时就把源片时长交下来了，以它为权威，读数为准。
   */
  const streamingTotalRef = useRef(0);

  /**
   * 当前这一集在**后端**的播放会话号。
   *
   * 与 `sessionRef`（前端用来作废异步续体的计数器）不是一回事：这个号交给后端
   * 管 VSR 转码会话与本地服务路径，离开小窗时必须显式 `stop`，否则那一路 ffmpeg
   * 会继续转、继续占磁盘与 CPU（主播放器在 `stopPlayback` 里做的就是这件事）。
   */
  const backendSessionRef = useRef(0);
  /**
   * 这一集"该从第几秒开始"—— 等 `loadedmetadata` 到达后再校准一次的期望值。
   *
   * ## 为什么需要它（2026-10-24）
   *
   * `playEpisode` 在 `attachSource` 之后立刻写 `video.currentTime = target`，但那一刻
   * 新源的 metadata 往往还没到（整集 HLS 的清单可能刚落地，`readyState` 还是
   * `HAVE_NOTHING`）。规范里这种赋值要么抛 `InvalidStateError`、要么被静默忽略，
   * **两种情况都不会记住这个意图**：等 metadata 真的到了，位置仍是元素残留的旧值。
   *
   * 主播放器用"等首帧就绪（`firstFrameReady`）再 `alignPlayhead`"解决这件事；
   * 小窗没有那条等待链，所以改成"记下意图，metadata 一到就落实"。
   *
   * `null` 表示没有待落实的起播点（正常播放中）。落实一次即清空——否则用户手动
   * 拖动进度条后会被这个残留值拽回去。
   */
  const pendingStartRef = useRef<number | null>(null);
  /**
   * 末尾复核的定时器（判"播完却收不到 `ended`"用的）。
   *
   * 声明放在这里（而不是 `handleWaiting` 旁边）是因为 `playEpisode` 也要用它：
   * 换集时必须撤掉上一集的复核，否则它判的是上一集的结尾，会让新一集刚起播
   * 就被判成"播完"直接跳集。`const` 不提升，放在后面 `playEpisode` 会撞 TDZ。
   */
  const tailProbeRef = useRef<{ timer: number; position: number } | null>(null);
  /** 取"该信哪个时长"：权威值优先，拿不到才退回媒体元素。 */
  const usableDuration = useCallback((video: HTMLVideoElement | null): number => {
    if (streamingTotalRef.current > 0) return streamingTotalRef.current;
    const native = video?.duration;
    return Number.isFinite(native) && native && native > 0 ? native : 0;
  }, []);

  const currentEpisode = handoff?.episodes.find(item => item.id === currentEpisodeId) ?? null;
  const currentIndex = handoff ? handoff.episodes.findIndex(item => item.id === currentEpisodeId) : -1;
  const hasPrev = currentIndex > 0;
  const hasNext = Boolean(handoff) && currentIndex >= 0 && currentIndex + 1 < (handoff?.episodes.length ?? 0);

  /** 进度上报（节流）：小窗被系统关闭时，能回传的就是最近这一次。 */
  const report = useCallback((force = false) => {
    const video = videoRef.current;
    if (!video) return;
    const now = Date.now();
    if (!force && now - lastReportRef.current < REPORT_INTERVAL_MS) return;
    lastReportRef.current = now;
    reportPipProgress({
      position: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      // 时长优先用源片权威值：边转边播期间 `video.duration` 会一路往上跳，
      // 拿它算出的百分比落进历史后，续播点会明显偏后。
      duration: usableDuration(video),
      volume: video.volume,
      muted: video.muted,
      rate: video.playbackRate,
      episodeId: currentEpisodeIdRef.current || null,
    });
  }, [usableDuration]);

  /** 取最终进度：关闭窗口时用，必须与任何节流无关。 */
  const snapshotProgress = useCallback(() => {
    const video = videoRef.current;
    return {
      position: video && Number.isFinite(video.currentTime) ? video.currentTime : 0,
      duration: usableDuration(video),
      volume: video ? video.volume : volume,
      muted: video ? video.muted : muted,
      rate: video ? video.playbackRate : 1,
      episodeId: currentEpisodeIdRef.current || null,
    };
  }, [muted, usableDuration, volume]);

  /**
   * 媒体事件全量打点（临时诊断，2026-10-24）。
   *
   * 现象：小窗里 `attachSource` 成功、`hls.js 已挂载`，但日志里**没有一条**
   * `loadstart` / `loadeddata` / `canplay` / `playing` / `waiting` ——
   * 说明 `<video>` 元素根本没开始加载。没有媒体事件，我加的所有兜底
   * （`onWaiting` 里的末尾判定）就永远没有触发机会。
   *
   * 这里把原生事件直接挂到元素上并打点，绕过 React 的合成事件，
   * 拿到的是"元素到底收到了什么"。定位完可以删。
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const events = [
      'loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough',
      'playing', 'waiting', 'stalled', 'suspend', 'abort', 'emptied',
      'seeking', 'seeked', 'ended', 'error', 'durationchange',
    ];
    const handlers = events.map(name => {
      const fn = () => {
        tracePlayback(
          `小窗媒体事件 ${name} readyState=${video.readyState} paused=${video.paused} t=${video.currentTime.toFixed(2)} dur=${Number.isFinite(video.duration) ? video.duration.toFixed(2) : 'NaN'} err=${video.error ? video.error.code : 0}`,
        );
      };
      video.addEventListener(name, fn);
      return { name, fn };
    });
    return () => {
      for (const { name, fn } of handlers) video.removeEventListener(name, fn);
    };
  }, []);

  /**
   * 解析并播放指定集。
   *
   * 所有 `await` 之后都要复查会话号：解析（短剧要等工作线程下载、动漫要重新取直链）
   * 动辄数百毫秒到数秒，期间用户完全可能已经切了集或关了窗口。不复查就会出现
   * "点了下一集，结果上一集的声音又响起来"。
   */
  const playEpisode = useCallback(async (plan: PipHandoff, episodeId: string, startPosition: number) => {
    const video = videoRef.current;
    if (!video) return;
    const session = sessionRef.current + 1;
    sessionRef.current = session;
    currentEpisodeIdRef.current = episodeId;
    setCurrentEpisodeId(episodeId);
    setErrorText(null);
    setIsLoading(true);

    // 只拆 hls.js 实例、不清 src：旧帧留到新源就绪，换集不黑屏（动漫链路的手法）。
    detachAnimeSource(video);
    // 上一集如果是短剧整集 HLS，那条 hls.js 实例挂在另一个键（`__ttv_hls__`）上，
    // 必须单独拆：两套实例同时接管同一块元素，表现就是新一集起不来或声音串台。
    // 它会顺带清掉 `src`，所以短剧换集会有极短一黑——整集 HLS 首片在本地回环上
    // 通常 50~200ms 就绪，比留着一帧旧画面更划算（留着反而会掩盖起播失败）。
    detachSource(video);
    // 换集即作废旧时长权威值，否则进度条会沿用上一集的总长。
    streamingTotalRef.current = 0;
    /**
     * 界面上的时长与位置也要**当场**清掉（2026-10-24）。
     *
     * 只清 `streamingTotalRef` 是不够的：`duration` / `position` 是 state，新源就绪前
     * 它们仍是上一集的值。用户点"下一集"的那一帧于是看到"进度条还在上一集的位置、
     * 分母还是上一集的时长"，直到新源 `timeupdate` 才跳回去 —— 这正是"进度条没有
     * 重置"的一半来源（另一半是 hls.js 真的从旧位置起播，见下方 `pendingStartRef`）。
     *
     * 清成 0 是诚实的：此刻确实还没有任何可播数据。等 metadata 到了再由
     * `onLoadedMetadata` 填上真实值。
     */
    setPosition(0);
    setDuration(0);
    setBuffered(0);
    /**
     * 上一集的末尾复核一并撤销。
     *
     * 它判的是**上一集**的结尾（`tailProbeRef` 里存着上一集的位置），留着会让
     * 新一集刚起播就被它判成"播完"直接跳集。
     *
     * ⚠️ 这里不能直接调 `cancelTailProbe()`：那个 `useCallback` 定义在本函数
     * **之后**（它依赖 `handleWaiting`，而 `handleWaiting` 又依赖本函数用到的
     * 一批状态），`const` 不提升，调用会撞 TDZ。所以直接操作 ref —— 逻辑只有
     * "清定时器 + 置 null"两步，没必要为它把整条依赖链倒过来。
     */
    if (tailProbeRef.current) {
      window.clearTimeout(tailProbeRef.current.timer);
      tailProbeRef.current = null;
    }

    // 换集前先停掉上一集的后端会话（2026-10-26 修「连按两次下一集留下两路 ffmpeg」）。
    // 下面两条链路都会覆盖 `backendSessionRef.current`，旧会话号一丢就再没人能停它：
    // 两路转码同时读源、写盘、抢 CPU，用户看到的是"小窗越切越卡"。
    const previousBackendSession = backendSessionRef.current;
    if (previousBackendSession > 0) {
      backendSessionRef.current = 0;
      void ipcService.playback.command(previousBackendSession, 'stop').catch(() => undefined);
    }

    try {
      // guo 与动漫同走 playback_open（后端按 id 前缀路由到 guo-core / 动漫源）：
      // resolveNative 只认红果纯数字 vid，guo id 进去必报"缺少有效的集 vid"——
      // 此前 guo 剧的画中画整条链路就是坏的。
      if (plan.kind === 'anime' || plan.seriesId.startsWith('guo:')) {
        const backendSession = generateNextSessionId();
        backendSessionRef.current = backendSession;
        const opened = await ipcService.playback.open(
          plan.seriesId,
          episodeId,
          plan.quality || 'auto',
          startPosition,
          backendSession,
          true,
        );
        if (sessionRef.current !== session) return;
        await attachAnimeSource(
          video,
          opened.url,
          streamKindOf(opened.url, opened.streamKind),
          startPosition,
        );
      } else {
        /**
         * 短剧/漫剧：**优先走整集 HLS**，与主播放器同一条链路。
         *
         * ## 为什么换掉原来的 `resolveNative`（2026-10-19）
         *
         * `resolveNative` 的产物是**整集 mp4**：签名 → 取直链 → 下载整集（实测
         * 13~27MB）→ 解密 → 重编码，实测 7~10 秒才出画。而主播放器早在方案 B
         * 之后就用整集 HLS 了：首片落地就能播（本机实测 132ms 返回 → 368ms 出画），
         * 连播预取 `prewarmStreamNative` 转好的也正是这份产物。
         *
         * 也就是说小窗此前一直在走"已经废弃的慢链路"，而且和它自己的预取**不匹配**：
         * 预取暖的是 HLS 产物，实际播放却在等整集 mp4 —— 用户看到的就是
         * "主窗口切进小窗要等好几秒才有画面"，切集同理。
         *
         * 现在优先 `openStreamNative`：命中已转好的产物时后端 10ms 级返回，
         * 小窗只负责把 m3u8 挂给 hls.js。只有后端明确回 `file`（VSR 关闭 /
         * 盘上只有旧链路的 mp4）时才退回原来的整集解析。
         */
        const backendSession = generateNextSessionId();
        backendSessionRef.current = backendSession;
        const stream = await ipcService.playback
          .openStreamNative(plan.seriesId, episodeId, backendSession, plan.contentType ?? 1)
          .catch(() => null);
        if (sessionRef.current !== session) return;
        if (stream && stream.streamKind === 'hls' && stream.playUrl) {
          const totalMs = stream.durationMs ?? 0;
          if (Number.isFinite(totalMs) && totalMs >= 1000) streamingTotalRef.current = totalMs / 1000;
          // 起播点必须随挂载一起交给 hls.js：它默认拿元素残留的 `currentTime`
          // 当起点，而换集时那里是上一集停下的位置（见 attachSource 的同名参数）。
          await attachSource(video, stream.playUrl, startPosition);
        } else {
          // 后端明确回 "file"（VSR 关闭 / 盘上只有旧链路的整集 mp4）：
          // 那条会话不用再停，`open_stream` 自己不会留转码进程。
          backendSessionRef.current = 0;
          const resolved = await ipcService.playback.resolveNative(
            plan.seriesId,
            episodeId,
            plan.contentType ?? 1,
            plan.quality || 'auto',
          );
          if (sessionRef.current !== session) return;
          const { convertFileSrc } = await import('@tauri-apps/api/core');
          video.src = convertFileSrc(resolved.playUrl);
          video.load();
        }
      }
      if (sessionRef.current !== session) return;

      video.playbackRate = plan.rate || 1;
      video.volume = plan.volume;
      video.muted = plan.muted;
      /**
       * ===== 起播点必须**无条件**归位，不能只在 `startPosition > 0` 时写 =====
       *
       * ## 现场（2026-10-24 用户报告）
       *
       * 「画中画里切集，进度条不会重置，而是回到之前的位置继续播，导致这一集
       * 看不到后面」—— 也就是换集后进度条不从 0 开始。
       *
       * ## 根因
       *
       * 小窗只有一块常驻 `<video>`，换集**不换元素**。旧写法是：
       *
       * ```ts
       * if (startPosition > 0) { video.currentTime = safeStart; }
       * ```
       *
       * 而换集/下一集/上一集传进来的 `startPosition` 恒为 **0**（见 `stepEpisode`
       * 与 `handleEnded`），于是这一整段**根本不执行** —— 元素上的 `currentTime`
       * 还是上一集停下的那个值。
       *
       * 为什么这会真的从旧位置起播：hls.js 的 `startPosition` 默认值是 `-1`，
       * 语义正是"拿 `media.currentTime` 当起点"（见 `usePlaybackStore` 里
       * `alignPlayhead` 的同一段注释，主播放器早就踩过并修好了，小窗漏了）。
       * 于是 `attachSource` 重建 MediaSource 后，hls.js 顺着元素残留的位置开始
       * 拉流：进度条停在上集的位置、只播剩下的那点，本集后半段永远看不到。
       *
       * 更隐蔽的一层：`attachSource` 内部先 `detachSource`（`removeAttribute('src')`）
       * 再挂新实例。清 `src` 按规范会把 `currentTime` 归 0，但那是**异步**的
       * （媒体加载算法在任务队列里跑），而 hls.js 紧接着就同步读了 `currentTime`。
       * 也就是说"清 src 就自动归零"这个假设在两个异步时序之间是不成立的。
       *
       * ## 所以
       *
       * 目标位置由调用方给定（连播/换集一律是 0，只有从主窗口交接进来才可能是
       * 续播点），**0 也要显式写一次**。偏移超过 0.5 秒时打点 —— 这是该症状
       * 唯一能留在日志里的现场证据。
       *
       * 起点还必须**夹在时长之内**，否则一挂载就 `ended`（2026-10-23）：主窗口在
       * 48.07s / 48.1s（已播完）时把 `position=48` 传了过来，小窗设 `currentTime=48`
       * 后立刻到结尾 → 触发 `handleEnded` → 而那条自动续播分支在窗口刚创建时
       * 静默失败 → 画面永远停在「正在准备画面」。万一时长与起点仍不匹配（不同
       * 清晰度的时长差、旧交接包），宁可从头播也不要在结尾卡死。
       *
       * 用 `video.duration` 而不是权威时长：此处只能拿到元素自己的值，而它是判断
       * "这个位置对当前这个源合不合法"的唯一依据。
       */
      const resolved = resolveStartTarget({
        startPosition,
        duration: video.duration,
        currentTime: video.currentTime,
      });
      if (resolved.clampedFromEnd) {
        tracePlayback(
          `小窗起播点越界（${startPosition.toFixed(1)}s ≥ 时长 ${video.duration.toFixed(1)}s），改为从头播`,
        );
      }
      if (resolved.drifted) {
        tracePlayback(
          `小窗起播点收敛 期望=${resolved.target.toFixed(2)}s 元素现值=${(Number.isFinite(video.currentTime) ? video.currentTime : 0).toFixed(2)}s 会话=${session}（换集没有重置位置，强制归位）`,
        );
      }
      try {
        video.currentTime = resolved.target;
      } catch {
        // `readyState === HAVE_NOTHING` 时给 currentTime 赋值会抛 InvalidStateError。
        // 那种状态下位置天然是 0，随后的 `loadedmetadata` 会再次校准（见
        // `pendingStartRef`），不必在这里补救。
      }
      // 记下"这一集该从哪开始"：metadata 到达后要再校准一次。原因见
      // `pendingStartRef` 的注释 —— 上面这次赋值在源还没就绪时会被忽略。
      pendingStartRef.current = resolved.target;

      try {
        // 有界起播：整集 HLS 的清单还没落地时，`play()` 会一直挂着不返回，
        // 小窗就会永久停在"加载中"而没有错误可看（见 PLAY_PENDING_TIMEOUT_MS）。
        tracePlayback(
          `小窗起播前状态 readyState=${video.readyState} paused=${video.paused} currentSrc=${video.currentSrc ? 'yes' : 'no'} duration=${video.duration}`,
        );
        await playBounded(video);
        tracePlayback(`小窗 playBounded 成功 readyState=${video.readyState} paused=${video.paused}`);
      } catch (error) {
        tracePlayback(
          `小窗 playBounded 失败 ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)} readyState=${video.readyState}`,
        );
        if (sessionRef.current !== session) return;
        const blocked = error instanceof DOMException && error.name === 'NotAllowedError';
        const aborted = error instanceof DOMException && error.name === 'AbortError';
        if (aborted) {
          // "video-only background media was paused to save power"：WebView2 会把被判定
          // 为后台/被遮挡的窗口里的视频暂停以省电——**源已经就绪**（loadeddata 已触发），
          // 根本不是播放源问题，弹错误卡片完全误导。静默重试一次；仍失败就停在"可播"的
          // 暂停态，等窗口重新可见时自动续播（意图保持为"要播"）。
          playIntentRef.current = true;
          await new Promise(resolve => setTimeout(resolve, 1000));
          if (sessionRef.current !== session) return;
          try {
            await video.play();
          } catch {
            // 画面已就绪，交给用户。
          }
        } else if (blocked) {
          // 起播被拦（WebView2 偶尔仍会拦带声音的自动播放）：静音续上，并如实提示，
          // 而不是把用户扔在一张错误卡片前。真实理由与主播放器的处理一致。
          video.muted = true;
          setMuted(true);
          setMuteNotice(true);
          await video.play();
        } else {
          throw error;
        }
      }
      if (sessionRef.current !== session) return;
      // 真播起来了才记"用户要在播"：这是省电暂停后自动续播的前提；停在暂停态
      // （上面那条省电分支）时意图由那条分支自己维护。
      if (!video.paused) playIntentRef.current = true;
      setIsLoading(false);
      setIsPlaying(!video.paused);
      report(true);
      prefetchNextEpisode(plan, episodeId);
    } catch (error) {
      if (sessionRef.current !== session) return;
      const detail = error instanceof Error ? error.message : String(error);
      playIntentRef.current = false;
      setErrorText(detail || '播放失败');
      setIsLoading(false);
      setIsPlaying(false);
    }
  }, [report]);

  /**
   * 连播预取：起播稳定后把**下一集的整集 HLS**提前转好。
   *
   * ## 为什么从 `prefetchNative` 改成 `prewarmStreamNative`（2026-10-17）
   *
   * `prefetchNative` 走 `short_drama_app_resolve`，产物是**整集 mp4**（下载 + 解密
   * + 重编码，实测单集 13~27MB、7~10 秒）。方案 B 之后整集 HLS 才是播放源，
   * 那份 mp4 只有「HLS 起不来」时才会被读到 —— 在正常连播路径上一秒都用不到。
   *
   * 而它的代价很实在：小窗里的这一路（边转边播的 HLS）正与后台"下整集 mp4"的
   * worker 抢磁盘和 CPU，表现就是「播着播着卡一下」（主窗口日志里已复现：
   * 连下四集整集后出现 `媒体 waiting 缓冲等待`）。
   *
   * `prewarmStreamNative` 产出 `vid-{vid}` 目录下的整集 HLS，正是连播到下一集
   * 时要播的东西；命中时 `open_stream` 零等待（实测 132ms 返回 → 368ms 出画）。
   *
   * 动漫/guo 不预取：它们走 playback.open 取直链（秒级轻请求），且直链有
   * 时效，提前拿到的 URL 到播时可能已失效。
   */
  // 预取延时的句柄。旧实现直接把 setTimeout 丢掉、不存 handle，于是小窗在起播后
  // 3 秒内被关掉时，这个定时器照样到点发出 prefetch_native —— 触发一次红果整集
  // 解析（实测约 7.4 秒的签名+下载+解密），在小窗已经销毁之后继续占网络与 worker。
  const prefetchTimerRef = useRef<number | null>(null);

  const prefetchNextEpisode = useCallback((plan: PipHandoff, episodeId: string) => {
    if (plan.kind !== 'drama' || plan.seriesId.startsWith('guo:')) return;
    const index = plan.episodes.findIndex(item => item.id === episodeId);
    const next = plan.episodes[index + 1];
    if (!next) return;
    // 同一小窗里换集会重复调用：先把上一次还没到点的预取撤掉，避免堆积多个定时器。
    if (prefetchTimerRef.current !== null) window.clearTimeout(prefetchTimerRef.current);
    prefetchTimerRef.current = window.setTimeout(() => {
      prefetchTimerRef.current = null;
      void ipcService.playback.prewarmStreamNative(
        plan.seriesId,
        next.id,
        plan.contentType ?? 1,
      );
    }, 3000);
  }, []);

  /** 启动：取接力包并起播。 */
  const boot = useCallback(async (plan?: PipHandoff | null) => {
    const payload = plan ?? (await readPipHandoff());
    if (!payload) {
      setErrorText('没有可续播的会话，请回到播放器重新打开。');
      setIsLoading(false);
      return;
    }
    setHandoff(payload);
    setVolume(payload.volume);
    setMuted(payload.muted);
    currentEpisodeIdRef.current = payload.episodeId;
    await playEpisode(payload, payload.episodeId, payload.position);
  }, [playEpisode]);

  // 启动取包 + 订阅"复用小窗时下发的新接力包"。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void boot();
    void listenPip<PipHandoff>(PIP_HANDOFF_EVENT, (payload) => {
      if (disposed || !payload) return;
      void boot(payload);
    }).then(off => {
      if (disposed) off();
      else unlisten = off;
    });
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
    // boot 由 useCallback 稳定（依赖 playEpisode），只在挂载时跑一次。
  }, [boot]);

  // 卸载：拆掉媒体链路，避免窗口销毁后仍有解码器在跑；同时撤掉还没到点的连播预取
  // 定时器（否则小窗关了还会发 prefetch_native，白占一次整集解析）。
  useEffect(() => () => {
    sessionRef.current += 1;
    // 窗口被系统销毁 / 页面被卸载时也要收掉后端会话：这是最后一道兜底，
    // 正常路径由 `leave` 负责（那条能拿到返回值，这条只能尽力而为）。
    if (backendSessionRef.current > 0) {
      void ipcService.playback.command(backendSessionRef.current, 'stop').catch(() => undefined);
      backendSessionRef.current = 0;
    }
    if (prefetchTimerRef.current !== null) {
      window.clearTimeout(prefetchTimerRef.current);
      prefetchTimerRef.current = null;
    }
    const video = videoRef.current;
    if (video) {
      try {
        video.pause();
      } catch {
        // 忽略：元素可能已经在销毁流程里。
      }
      detachAnimeSource(video);
      // 短剧整集 HLS 的实例挂在 `__ttv_hls__` 上（见 hlsAttach）：卸载时一并拆掉，
      // 否则窗口销毁后那条 MSE 仍持有解码器与分片请求。
      detachSource(video);
    }
  }, []);

  /**
   * 把窗口显示出来，并告诉主窗口"小窗已经就绪"。
   *
   * 窗口由 Rust 侧以 `visible(false)` 创建：页面加载 + JS 执行那段"白底空窗"
   * 不该被用户看到。这里在挂载后的第一帧过去再 show，用户看到的直接就是
   * 带加载态的播放界面。
   *
   * 顺序是硬约束：`show()` 让这一帧真正可见，**之后**才广播 `pip://shown`。
   * 主窗口收到它才隐藏自己；反过来做就会出现"播放界面先没了、小窗还没出来"
   * 的空档。失败静默——Rust 侧还有 1.5 秒的强制显示兜底。
   */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
        const current = getCurrentWindow();
        /**
         * ⚠️ **只有 show() 真的成功，才允许广播 `pip://shown`**（2026-10-23 修
         * 「点画中画后两个窗口都没了」）。
         *
         * 旧写法是 `void current.show().catch(() => {})` 之后**无条件** emit：
         * 一旦 show 失败（窗口创建时 WebView2 参数不当、窗口被系统拒绝显示等），
         * 主窗口仍然收到 `pip://shown` 并隐藏自己 —— 结果是**两个窗口都看不见**，
         * 用户只能去任务管理器结束进程。实测日志里只剩一条
         * 「画中画就绪：主窗口已隐藏」，之后再无 `画中画结束`，正是这个形态。
         *
         * 现在把 show 的结果当作闸门：
         *   - 成功 → 广播 `pip://shown`，主窗口隐藏（正常路径）；
         *   - 失败 → 不广播，并广播 `pip://show-failed`，主窗口据此**保持可见**，
         *     用户至少还能看到主界面并重试。
         */
        let shown = false;
        try {
          await current.show();
          shown = true;
        } catch {
          shown = false;
        }
        // 焦点失败不影响"窗口已显示"，单独兜住即可。
        void current.setFocus().catch(() => {});
        try {
          const { emit } = await import('@tauri-apps/api/event');
          if (shown) {
            await emit(PIP_SHOWN_EVENT);
          } else {
            // 主窗口监听这个事件把界面恢复回来（见 PipReturnBridge）。
            await emit(PIP_SHOW_FAILED_EVENT);
          }
        } catch {
          // 事件系统不可达：什么都不做。主窗口仍保持可见（没有收到 shown），
          // 用户看到的是"点了画中画但没反应"，比两个窗口全消失好得多。
        }
      }).catch(() => {});
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    // 用户意图以"按下时是否处于暂停"为准：只有它说了算的暂停才允许被忽略，
    // 反过来（正在播时按下）则明确表示"别再自动续播"。
    playIntentRef.current = video.paused;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  }, []);

  /**
   * 被"省电暂停"后的自动续播（意图驱动 + 周期重试）。
   *
   * 小窗的常态是"别的窗口在前台"，而 WebView2 会把被判定为后台/被遮挡的窗口里的
   * 视频静默暂停（`AbortError: video-only background media was paused to save power`）。
   * 交接时小窗刚创建、还没有前台激活权限，于是起播那一次几乎必定撞上它：
   * 实测主窗口已暂停、小窗稳定停在首帧的暂停态（`paused: true`，手动 `play()` 立刻
   * 成功），用户看到的是"点了画中画却没有在播"。
   *
   * 只挂 `focus` / `visibilitychange` 监听不够可靠：窗口被遮挡不一定改变
   * `document.visibilityState`，也不一定发原生 focus。因此改成周期重试：
   * 条件苛刻（有播放意图 + 确实暂停 + 文档可见），窗口一旦重新被系统当成前台
   * 就自己接上；用户主动暂停、播完、退出手势都早已把意图置假，绝不会被重新拉起。
   * 上限 50 次（约 30 秒）后收手：长时间重试没有意义，等用户点一下就行。
   */
  useEffect(() => {
    let attempts = 0;
    const timer = setInterval(() => {
      const video = videoRef.current;
      if (!video || !playIntentRef.current || !video.paused) {
        attempts = 0;
        return;
      }
      if (document.visibilityState !== 'visible') return;
      // 到顶只跳过本次，**不清掉定时器**：用户手动播一次（paused 变 false）就会把
      // 计数归零，于是又能获得一轮额度；清掉定时器就再也接不上了。
      if (attempts >= 50) return;
      attempts += 1;
      void video.play().catch(() => {});
    }, 600);
    return () => clearInterval(timer);
  }, []);

  /**
   * 小窗的「等转码追上目标再落位」。
   *
   * 与主播放器同一套语义（`planSeek` / `seekableReached`），但小窗没有自愈链，
   * 所以实现刻意更小：
   *   - 每拍只做两件事：读 `seekable.end`、够到了就落位；
   *   - **不动播放头**（旧写法会推到 `end - 0.05`，那正是"点结尾跳到转码末端"）；
   *   - 目标变了（用户又点了一次）就由新的等待取代旧的；
   *   - 会话变了（换集/关窗）立刻作废。
   *
   * 超时给 8 秒，与主播放器同量级：转码是 13~29 倍实时，缺的内容通常几百毫秒
   * 就补上；真卡住时继续等没有意义，`handleWaiting` 的末尾兜底会接手。
   */
  const seekWaitRef = useRef<{ timer: number; target: number; generation: number } | null>(null);
  const seekWaitGenerationRef = useRef(0);

  const cancelSeekWaitInPip = useCallback(() => {
    seekWaitGenerationRef.current += 1;
    if (seekWaitRef.current) {
      window.clearTimeout(seekWaitRef.current.timer);
      seekWaitRef.current = null;
    }
  }, []);

  const waitForSeekableInPip = useCallback((video: HTMLVideoElement, target: number) => {
    // 同一目标重复触发（pointerdown + pointerup）直接忽略。
    if (seekWaitRef.current && Math.abs(seekWaitRef.current.target - target) < 0.5) return;
    cancelSeekWaitInPip();
    const generation = seekWaitGenerationRef.current;
    const sessionAtWait = sessionRef.current;
    const deadline = performance.now() + PIP_SEEK_WAIT_TIMEOUT_MS;

    const poll = () => {
      if (seekWaitGenerationRef.current !== generation) return;
      seekWaitRef.current = null;
      if (sessionRef.current !== sessionAtWait) return;
      if (videoRef.current !== video) return;
      let end = 0;
      try {
        if (video.seekable && video.seekable.length > 0) {
          end = video.seekable.end(video.seekable.length - 1);
        }
      } catch {
        // 读不到：下一拍再试。
      }
      // 与主播放器同一判据：转码中要求目标后方还有一片已落盘的内容。
      if (seekableReached(end, target, duration)) {
        tracePlayback(`小窗转码已推进到 ${end.toFixed(1)}s，落位到 ${target.toFixed(1)}s`);
        try {
          video.currentTime = target;
          setPosition(target);
        } catch {
          // 元素已失效：放弃。
        }
        return;
      }
      if (performance.now() >= deadline) {
        // 超时保持原位：不跳到末端（那正是要根治的错误落位）。
        tracePlayback(
          `小窗等待转码超时 目标=${target.toFixed(1)}s 末端=${end.toFixed(1)}s，保持在原位`,
        );
        return;
      }
      const timer = window.setTimeout(poll, PIP_SEEK_WAIT_POLL_MS);
      seekWaitRef.current = { timer, target, generation };
    };
    const timer = window.setTimeout(poll, PIP_SEEK_WAIT_POLL_MS);
    seekWaitRef.current = { timer, target, generation };
  }, [cancelSeekWaitInPip]);

  /**
   * 落位。
   *
   * ## 为什么不再直接赋值（2026-10-24 根治）
   *
   * 用户报的是「点击播放器任意位置（比如点击结尾），它会跳转到转码后的最后位置」。
   * 小窗的进度条分母同样是**源片真实时长**（`streamingTotalRef`），而播放源是
   * 边转边播的整集 HLS —— `seekable.end` 只到已转位置。MSE 会把超范围的 seek
   * 静默夹到末端，于是"点结尾"变成"跳到能播到的最后一点"。
   *
   * 现在与主播放器同一套判定（`planSeek`）：
   *   - 范围内 → 立即落位；
   *   - 超出 → 只更新读数 + 让 hls.js 从目标位置拉流，**播放头不动**；
   *   - 等转码追上后由 `waitForSeekableInPip` 落位。
   */
  const seekTo = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(seconds)) return;
    let seekableEnd = 0;
    try {
      if (video.seekable && video.seekable.length > 0) {
        seekableEnd = video.seekable.end(video.seekable.length - 1);
      }
    } catch {
      // 尚未就绪：按"不可寻址"处理。
    }
    const plan = planSeek({
      requested: seconds,
      duration: usableDuration(video),
      seekableEnd,
    });
    if (plan.kind === 'immediate') {
      cancelSeekWaitInPip();
      try {
        video.currentTime = plan.target;
        setPosition(plan.target);
      } catch {
        // 尚未可寻址：忽略。
      }
      return;
    }
    // 超出可寻址范围：只改读数与加载位置，绝不动播放头（见 `planSeek` 的注释）。
    setPosition(plan.target);
    hintHlsLoadPosition(video, plan.target);
    waitForSeekableInPip(video, plan.target);
  }, [cancelSeekWaitInPip, usableDuration, waitForSeekableInPip]);

  const seekRelative = useCallback((delta: number) => {
    const video = videoRef.current;
    if (!video) return;
    seekTo((video.currentTime || 0) + delta);
  }, [seekTo]);

  const applyVolume = useCallback((next: number, nextMuted: boolean) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = Math.min(1, Math.max(0, next));
    video.muted = nextMuted;
    setVolume(video.volume);
    setMuted(nextMuted);
    if (!nextMuted) setMuteNotice(false);
    report(true);
  }, [report]);

  const stepEpisode = useCallback((delta: number) => {
    if (!handoff) return;
    const index = handoff.episodes.findIndex(item => item.id === currentEpisodeIdRef.current);
    const target = index >= 0 ? handoff.episodes[index + delta] : undefined;
    if (!target) return;
    void playEpisode(handoff, target.id, 0);
  }, [handoff, playEpisode]);

  const leave = useCallback(async (mode: 'return' | 'close') => {
    sessionRef.current += 1;
    // 主动离开：不允许后来任何自动续播再把画面拉起来。
    playIntentRef.current = false;
    const video = videoRef.current;
    if (video && !video.paused) video.pause();
    // 停掉后端那一路转码会话：整集 HLS 是"边转边播"，小窗走了之后没人再读它的
    // 分片，不停就会留下一个继续写磁盘、继续占 CPU 的 ffmpeg（返回值不 await：
    // 关窗不该被一次 IPC 往返拖住）。
    if (backendSessionRef.current > 0) {
      void ipcService.playback.command(backendSessionRef.current, 'stop').catch(() => undefined);
      backendSessionRef.current = 0;
    }
    try {
      await closePip(mode, snapshotProgress());
    } catch {
      // 后端不可达（应用正在退出等）：窗口会随进程一起消失。
    }
  }, [snapshotProgress]);

  /** 播完一集：按设置自动连播，否则停在结尾等用户决定。 */
  const handleEnded = useCallback(() => {
    report(true);
    // 播完即"不该再自动续播"：否则窗口重新可见时那次续播会把结束的视频又播一遍。
    playIntentRef.current = false;
    if (!handoff || !handoff.autoNext || !hasNext) {
      setIsPlaying(false);
      return;
    }
    const index = handoff.episodes.findIndex(item => item.id === currentEpisodeIdRef.current);
    const next = handoff.episodes[index + 1];
    if (next) void playEpisode(handoff, next.id, 0);
  }, [handoff, hasNext, playEpisode, report]);

  /**
   * 末尾停滞兜底：**播完却收不到 `ended` 时，自己判播完**（2026-10-24）。
   *
   * ## 现场（ttv-playback.log，小窗会话 900000001）
   *
   * ```
   *  58.020s  画中画就绪
   *  67.068s  连播预取 下一集=...          ← 下一集其实已经备好
   *  81.922s  hls.js 错误 bufferAppendNoProgress
   * 102.021s  hls.js 错误 bufferStalledError
   * 107.575s  hls.js 错误 mediaSourceRequiresReset
   * 107.577s  小窗回流 位置=48s            ← 用户手动关掉，位置停在结尾
   * ```
   *
   * 整段里**没有任何 `ended`**。原因与主播放器当年踩的是同一个：
   * 播放源是边转边播的整集 HLS，末尾分片与容器时长差几十毫秒，Chromium
   * 不会派发 `ended`；而 MSE 在末尾追加不动时会抛 `bufferStalledError`，
   * 随后 `mediaSourceRequiresReset` —— 播放器既不放下一集，也永远停在
   * 「正在准备画面」。
   *
   * ## 为什么主播放器没这个问题
   *
   * `usePlaybackStore` 里有 `isPlayheadAtPlayableTail` + 1.2 秒复核 +
   * `isBufferComplete` 立即判定三件套。**小窗一个都没有** ——
   * 它的 `onWaiting` 只有 `setIsLoading(true)`，然后就一直等下去。
   *
   * ## 这里的做法
   *
   * 与主播放器同一套判据（复用 `playbackTail` 的纯函数，不重复实现）：
   * `waiting` 时若"播放头停在可播末端"且"缓冲已覆盖末尾"，立即按播完处理；
   * 否则预约 1.2 秒复核，期间时钟推进就撤销。判完调 `handleEnded`，
   * 于是自动连播、进度落盘、`isLoading` 复位全都走既有路径。
   */
  const cancelTailProbe = useCallback(() => {
    if (tailProbeRef.current) {
      window.clearTimeout(tailProbeRef.current.timer);
      tailProbeRef.current = null;
    }
  }, []);

  const handleWaiting = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      setIsLoading(true);
      return;
    }
    const snapshot = {
      currentTime: video.currentTime,
      duration: usableDuration(video),
      bufferedEnd: video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) : 0,
      paused: video.paused,
      seeking: video.seeking,
      ended: video.ended,
      playbackRate: video.playbackRate,
    };
    // 数据已全部到齐：不必等复核，当场判播完。
    if (isPlayheadAtPlayableTail(snapshot) && isBufferComplete(snapshot)) {
      tracePlayback(
        `小窗末尾数据已齐，立即判定播完 current=${video.currentTime.toFixed(2)}s duration=${snapshot.duration.toFixed(2)}s`,
      );
      setIsLoading(false);
      handleEnded();
      return;
    }
    // 停在可播末端但缓冲未到顶：预约一次复核（与主播放器同一个 1.2 秒窗口）。
    if (isPlayheadAtPlayableTail(snapshot) && !tailProbeRef.current) {
      const position = video.currentTime;
      const timer = window.setTimeout(() => {
        tailProbeRef.current = null;
        const v = videoRef.current;
        if (!v || v.paused || v.seeking || v.ended) return;
        const after = {
          currentTime: v.currentTime,
          duration: usableDuration(v),
          bufferedEnd: v.buffered.length > 0 ? v.buffered.end(v.buffered.length - 1) : 0,
          paused: v.paused,
          seeking: v.seeking,
          ended: v.ended,
          playbackRate: v.playbackRate,
        };
        if (!isPlayheadAtPlayableTail(after)) {
          setIsLoading(v.readyState < 3);
          return;
        }
        // 时钟没推进才算真的停住（按倍速换算，与主播放器一致）。
        const expected = 1.2 * Math.max(v.playbackRate || 1, 1);
        if (v.currentTime - position < expected * 0.25) {
          tracePlayback(
            `小窗末尾停滞复核命中：按本集播完处理 current=${v.currentTime.toFixed(2)}s duration=${after.duration.toFixed(2)}s`,
          );
          setIsLoading(false);
          handleEnded();
        } else {
          setIsLoading(v.readyState < 3);
        }
      }, 1200);
      tailProbeRef.current = { timer, position };
    }
    setIsLoading(true);
  }, [handleEnded, usableDuration]);

  // 换集 / 卸载时收掉在途复核，避免它落到新一集上。
  useEffect(() => () => cancelTailProbe(), [cancelTailProbe]);

  // 键盘快捷键与主播放器保持一致（空格/方向键/Esc）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      switch (event.code) {
        case 'Space':
          event.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          seekRelative(-5);
          break;
        case 'ArrowRight':
          event.preventDefault();
          seekRelative(5);
          break;
        case 'ArrowUp':
          event.preventDefault();
          applyVolume(Math.min(1, volume + 0.05), false);
          break;
        case 'ArrowDown':
          event.preventDefault();
          applyVolume(Math.max(0, volume - 0.05), muted);
          break;
        case 'Escape':
          event.preventDefault();
          void leave('return');
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [applyVolume, leave, muted, seekRelative, togglePlay, volume]);

  const startDragging = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().startDragging();
    } catch {
      // 非 Tauri 环境（浏览器里预览）：没有原生窗口可拖，忽略。
    }
  }, []);

  const startResize = useCallback(async (direction: ResizeDir) => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().startResizeDragging(direction);
    } catch {
      // 同上。
    }
  }, []);

  const progressPercent = duration > 0 ? Math.min(100, Math.max(0, (position / duration) * 100)) : 0;
  const bufferedPercent = duration > 0 ? Math.min(100, Math.max(0, (buffered / duration) * 100)) : 0;
  const title = handoff?.title || '正在播放';
  const badge = currentEpisode
    ? episodeLabel(currentEpisode.episodeNumber, currentEpisode.title)
    : handoff ? episodeLabel(handoff.episodeNumber) : '';

  // 与主窗口一致：这是播放器而不是浏览器，右键不该弹出 WebView 的上下文菜单。
  return (
    <div
      onContextMenu={(event) => event.preventDefault()}
      className="relative w-full h-full bg-black text-white overflow-hidden select-none group"
    >
      <video
        ref={videoRef}
        playsInline
        className="w-full h-full object-contain bg-black cursor-pointer"
        onClick={togglePlay}
        onTimeUpdate={(event) => {
          const video = event.currentTarget;
          // 时钟真的往前走了 → 撤销在途的末尾复核（与主播放器同一条反证）。
          const probe = tailProbeRef.current;
          if (probe && video.currentTime > probe.position + 0.06) cancelTailProbe();
          setPosition(video.currentTime);
          setDuration(usableDuration(video));
          setBuffered(video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) : 0);
          report();
        }}
        onDurationChange={(event) => setDuration(usableDuration(event.currentTarget))}
        /**
         * 新源 metadata 到达：把 `playEpisode` 记下的起播点真正落实。
         *
         * 这一步不能省（2026-10-24）。`playEpisode` 里那次 `video.currentTime = target`
         * 发生在 `attachSource` 之后，而整集 HLS 那一刻常常还是 `HAVE_NOTHING`：
         * 赋值被忽略、也不会有任何报错。等到 metadata 就绪（这里）才是唯一保证
         * 生效的时机 —— 少了它，换集后就会从上一集残留的位置起播。
         *
         * 落实后立刻清空：用户随后手动拖进度条不该被这个残留意图拽回去。
         */
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          setDuration(usableDuration(video));
          const pending = pendingStartRef.current;
          if (pending === null) return;
          pendingStartRef.current = null;
          const resolved = resolveStartTarget({
            startPosition: pending,
            duration: video.duration,
            currentTime: video.currentTime,
          });
          if (!resolved.drifted) return;
          try {
            video.currentTime = resolved.target;
            tracePlayback(
              `小窗 metadata 就绪后校准起播点 期望=${resolved.target.toFixed(2)}s 校正前=${(Number.isFinite(video.currentTime) ? video.currentTime : 0).toFixed(2)}s`,
            );
          } catch {
            // 极少数情况下仍不可寻址：位置保持现状，至少不会卡死。
          }
        }}
        onProgress={(event) => {
          const video = event.currentTarget;
          setBuffered(video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) : 0);
        }}
        onPlay={() => {
          setIsPlaying(true);
          report(true);
        }}
        onPause={() => {
          setIsPlaying(false);
          report(true);
        }}
        onWaiting={handleWaiting}
        onPlaying={() => setIsLoading(false)}
        onVolumeChange={(event) => {
          setVolume(event.currentTarget.volume);
          setMuted(event.currentTarget.muted);
        }}
        onEnded={handleEnded}
        onError={() => {
          setErrorText('这一集的画面解不出来，可直接换台或回到播放器。');
          setIsLoading(false);
        }}
      />

      {/* 顶部：拖动区 + 标题 + 两个出口。不播放时常显，播放时悬停浮现——小窗太小，
          常显会长期占掉画面。 */}
      <div
        onMouseDown={(event) => {
          if (event.button !== 0) return;
          if ((event.target as HTMLElement).closest('[data-window-interactive]')) return;
          void startDragging();
        }}
        className={`absolute top-0 inset-x-0 z-30 h-9 px-2 flex items-center gap-2 bg-gradient-to-b from-black/75 to-transparent cursor-move transition-opacity duration-200 ${
          isPlaying ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold truncate leading-tight">{title}</div>
          {badge && <div className="text-[10px] text-white/60 truncate leading-tight">{badge}</div>}
        </div>
        <button
          type="button"
          data-window-interactive
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => void leave('return')}
          title="回到播放器继续观看（Esc）"
          aria-label="回到播放器"
          className="w-7 h-7 flex items-center justify-center rounded-lg text-white/85 hover:text-white hover:bg-white/15 transition-colors"
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          data-window-interactive
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => void leave('close')}
          title="关闭小窗（进度会保留）"
          aria-label="关闭小窗"
          className="w-7 h-7 flex items-center justify-center rounded-lg text-white/85 hover:text-white hover:bg-rose-500/80 transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 加载态：小窗很窄，不用整屏遮罩，只在中间给一个转圈，旧帧继续留着。 */}
      {isLoading && !errorText && (
        <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
          <div className="px-3 py-2 rounded-xl bg-black/70 border border-white/15 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" />
            <span className="text-[11px] font-semibold text-white/90">正在准备画面…</span>
          </div>
        </div>
      )}

      {errorText && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-black/80 px-4 text-center">
          <AlertCircle className="w-6 h-6 text-rose-400" />
          <p className="text-[11px] leading-relaxed text-white/85">{errorText}</p>
          <div className="flex items-center gap-2 mt-1">
            <button
              type="button"
              onClick={() => {
                if (!handoff) {
                  void boot();
                  return;
                }
                void playEpisode(handoff, currentEpisodeIdRef.current || handoff.episodeId, 0);
              }}
              className="px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-[11px] font-semibold flex items-center gap-1.5 transition-colors"
            >
              <RotateCw className="w-3 h-3" />
              重试
            </button>
            <button
              type="button"
              onClick={() => void leave('return')}
              className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-[11px] font-semibold transition-colors"
            >
              回到播放器
            </button>
          </div>
        </div>
      )}

      {/* 静音起播提示：只有真的被自动播放策略拦住时才出现。 */}
      {muteNotice && (
        <button
          type="button"
          onClick={() => applyVolume(volume, false)}
          className="absolute top-10 inset-x-0 z-30 mx-auto w-fit px-3 py-1.5 rounded-lg bg-black/75 border border-white/15 text-[10px] font-semibold text-white/90 hover:bg-black/85"
        >
          已静音起播 · 点此恢复声音
        </button>
      )}

      {/* 底部控制条：播放/暂停、上下集、进度、时间、音量。 */}
      <div
        className={`absolute bottom-0 inset-x-0 z-30 px-2 pb-1.5 pt-3 bg-gradient-to-t from-black/85 to-transparent transition-opacity duration-200 ${
          isPlaying ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'
        }`}
      >
        <div
          className="h-3 flex items-center cursor-pointer"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
            if (duration > 0) seekTo(ratio * duration);
          }}
        >
          {/* 进度条三色与主播放器**同一组语义值**（见 crystal.css 的 --progress-*）：
              底轨必须用中性灰 —— 纯白半透明叠在白墙/白西装/雪景上亮度差为 0，
              细条等于不存在；已播放段与主播放器同为黑红，不再一块蓝一块红。 */}
          <div className="relative w-full h-1 rounded-full bg-[rgba(128,128,128,0.55)] overflow-hidden">
            <div className="absolute inset-y-0 left-0 bg-[rgba(213,213,213,0.6)]" style={{ width: `${bufferedPercent}%` }} />
            <div className="absolute inset-y-0 left-0 bg-[var(--progress-played-to)]" style={{ width: `${progressPercent}%` }} />
          </div>
        </div>

        <div className="mt-0.5 flex items-center gap-1">
          <button
            type="button"
            onClick={togglePlay}
            title={isPlaying ? '暂停' : '播放'}
            aria-label={isPlaying ? '暂停' : '播放'}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/15 transition-colors"
          >
            {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => stepEpisode(-1)}
            disabled={!hasPrev}
            title="上一集"
            aria-label="上一集"
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/15 disabled:opacity-35 disabled:hover:bg-transparent transition-colors"
          >
            <SkipBack className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => stepEpisode(1)}
            disabled={!hasNext}
            title="下一集"
            aria-label="下一集"
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/15 disabled:opacity-35 disabled:hover:bg-transparent transition-colors"
          >
            <SkipForward className="w-3.5 h-3.5" />
          </button>

          <span className="ml-1 text-[10px] font-mono tabular-nums text-white/75">
            {formatTime(position)} / {formatTime(duration)}
          </span>

          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => applyVolume(volume, !muted)}
              title={muted ? '取消静音' : '静音'}
              aria-label={muted ? '取消静音' : '静音'}
              className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/15 transition-colors"
            >
              {muted || volume === 0 ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              onChange={(event) => applyVolume(Number(event.target.value), false)}
              title="音量"
              aria-label="音量"
              className="w-16 h-1 accent-blue-500 cursor-pointer"
            />
          </div>
        </div>
      </div>

      {/* 八向缩放把手：无边框窗口没有系统边框，靠它们把方向交回给原生窗口。
          尺寸刻意小（视觉 1.5px、命中 3px），不然会盖住画面。 */}
      {RESIZE_HANDLES.map(({ direction, className }) => (
        <div
          key={direction}
          onMouseDown={(event) => {
            event.preventDefault();
            void startResize(direction);
          }}
          className={`absolute z-40 ${className}`}
        />
      ))}
    </div>
  );
};

export default MiniPlayer;
