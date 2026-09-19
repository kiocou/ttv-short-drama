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
import {
  closePip,
  listenPip,
  PIP_HANDOFF_EVENT,
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

function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

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
  const [countdown, setCountdown] = useState<number | null>(null);
  /** 仅在自动播放被拦时出现：如实告诉用户"现在是静音在放"。 */
  const [muteNotice, setMuteNotice] = useState(false);

  // 会话号：任何一次换集都会让它递增，让先前的异步续体自动作废（同一个模式在
  // 主播放器里叫 sessionId，理由相同——resolve 与 play 之间隔着好几秒的 await）。
  const sessionRef = useRef(0);
  const currentEpisodeIdRef = useRef('');
  const lastReportRef = useRef(0);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /**
   * 用户的播放意图：被系统/省电策略静默暂停时，靠它与"用户主动暂停"区分开。
   *
   * 只由用户手势与起播链路的显式动作写入（**不写** pause 事件）：WebView2 对
   * "被判定为后台"的窗口会静默暂停视频，而那同样会触发 pause 事件，写进去就再也
   * 分不出"它自己停的"和"用户按的"。
   */
  const playIntentRef = useRef(false);

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
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      volume: video.volume,
      muted: video.muted,
      rate: video.playbackRate,
      episodeId: currentEpisodeIdRef.current || null,
    });
  }, []);

  /** 取最终进度：关闭窗口时用，必须与任何节流无关。 */
  const snapshotProgress = useCallback(() => {
    const video = videoRef.current;
    return {
      position: video && Number.isFinite(video.currentTime) ? video.currentTime : 0,
      duration: video && Number.isFinite(video.duration) ? video.duration : 0,
      volume: video ? video.volume : volume,
      muted: video ? video.muted : muted,
      rate: video ? video.playbackRate : 1,
      episodeId: currentEpisodeIdRef.current || null,
    };
  }, [muted, volume]);

  const clearCountdown = useCallback(() => {
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setCountdown(null);
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
    clearCountdown();

    // 只拆 hls.js 实例、不清 src：旧帧留到新源就绪，换集不黑屏（与动漫播放器同一手法）。
    detachAnimeSource(video);

    try {
      if (plan.kind === 'anime') {
        const opened = await ipcService.playback.open(
          plan.seriesId,
          episodeId,
          plan.quality || 'auto',
          startPosition,
          generateNextSessionId(),
          true,
        );
        if (sessionRef.current !== session) return;
        await attachAnimeSource(video, opened.url, streamKindOf(opened.url, opened.streamKind));
      } else {
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
      if (sessionRef.current !== session) return;

      video.playbackRate = plan.rate || 1;
      video.volume = plan.volume;
      video.muted = plan.muted;
      if (startPosition > 0) {
        try {
          video.currentTime = startPosition;
        } catch {
          // metadata 未就绪时会被忽略：播放开始后会自然回到 0，不影响起播。
        }
      }

      try {
        await video.play();
      } catch (error) {
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
    } catch (error) {
      if (sessionRef.current !== session) return;
      const detail = error instanceof Error ? error.message : String(error);
      playIntentRef.current = false;
      setErrorText(detail || '播放失败');
      setIsLoading(false);
      setIsPlaying(false);
    }
  }, [clearCountdown, report]);

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

  // 卸载：拆掉媒体链路，避免窗口销毁后仍有解码器在跑。
  useEffect(() => () => {
    sessionRef.current += 1;
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    const video = videoRef.current;
    if (video) {
      try {
        video.pause();
      } catch {
        // 忽略：元素可能已经在销毁流程里。
      }
      detachAnimeSource(video);
    }
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

  const seekTo = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(seconds)) return;
    try {
      video.currentTime = Math.max(0, seconds);
    } catch {
      // 尚未可寻址：忽略。
    }
  }, []);

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
    try {
      await closePip(mode, snapshotProgress());
    } catch {
      // 后端不可达（应用正在退出等）：窗口会随进程一起消失。
    }
  }, [snapshotProgress]);

  /** 播完一集：按设置自动连播（带倒计时），否则停在结尾等用户决定。 */
  const handleEnded = useCallback(() => {
    report(true);
    // 播完即"不该再自动续播"：否则窗口重新可见时那次续播会把结束的视频又播一遍。
    playIntentRef.current = false;
    if (!handoff || !handoff.autoNext || !hasNext) {
      setIsPlaying(false);
      return;
    }
    const seconds = Math.max(3, handoff.countdownSeconds || 5);
    setCountdown(seconds);
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    countdownTimerRef.current = setInterval(() => {
      setCountdown(previous => {
        if (previous == null) return null;
        if (previous <= 1) {
          if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
          countdownTimerRef.current = null;
          const index = handoff.episodes.findIndex(item => item.id === currentEpisodeIdRef.current);
          const next = handoff.episodes[index + 1];
          if (next) void playEpisode(handoff, next.id, 0);
          return null;
        }
        return previous - 1;
      });
    }, 1000);
  }, [handoff, hasNext, playEpisode, report]);

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
          setPosition(video.currentTime);
          setBuffered(video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) : 0);
          report();
        }}
        onDurationChange={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
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
        onWaiting={() => setIsLoading(true)}
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

      {/* 连播倒计时：与主播放器一样给出"要跳集了"的明确信号，且可取消。 */}
      {countdown != null && (
        <div className="absolute inset-x-0 bottom-16 z-30 flex justify-center">
          <div className="px-3 py-2 rounded-xl bg-black/75 border border-white/15 flex items-center gap-2.5">
            <span className="text-[11px] font-semibold text-white/90">
              {countdown} 秒后播放{hasNext && currentIndex >= 0 ? `第 ${handoff?.episodes[currentIndex + 1]?.episodeNumber} 集` : '下一集'}
            </span>
            <button
              type="button"
              onClick={clearCountdown}
              className="text-[10px] font-semibold text-blue-300 hover:text-blue-200"
            >
              取消
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
          <div className="relative w-full h-1 rounded-full bg-white/25 overflow-hidden">
            <div className="absolute inset-y-0 left-0 bg-white/30" style={{ width: `${bufferedPercent}%` }} />
            <div className="absolute inset-y-0 left-0 bg-blue-500" style={{ width: `${progressPercent}%` }} />
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
