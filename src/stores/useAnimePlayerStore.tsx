import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { generateNextSessionId, ipcService } from '../services/ipc';
import {
  attachAnimeSource,
  detachAnimeSource,
  startAnimeFrameWatchdog,
  streamKindOf,
  type AnimeStreamKind,
} from '../services/animePlayback';
import type { EpisodeItem, SeriesDetail } from '../types/series';
import { useAppStore } from './useAppStore';
import { useSettingsStore } from './useSettingsStore';

/**
 * 动漫专区专用播放状态机。
 *
 * ## 为什么不复用 usePlaybackStore
 *
 * 用户的要求是"动漫专区一套新的、对动漫特定优化的播放器，短剧/漫剧保持原样"。
 * 从工程角度这也更安全：`usePlaybackStore` 里那套"三级兜底（备用直链 → Blob →
 * 本地解析）+ 预取队列 + 红果 worker"完全是为红果源写的，对 dmghg 的 m3u8 一条
 * 都用不上，却与动漫共用同一块常驻 `<video>` 和同一个会话号空间——历史上多个
 * 事故（"播完动漫后漫剧播不了"、"退出播放器还有声音"）都源自这份共享。
 *
 * 这里做成独立 store + 独立 `<video>`（按需挂载、退出即销毁），与短剧链路零耦合。
 *
 * ## 与短剧的互斥
 *
 * 同一时刻只允许一条链路持有媒体元素：进入动漫播放前由 `App` 隐藏短剧
 * `VideoSurface` 并停止其会话；退出动漫播放器时本 store 会销毁 hls.js 实例并
 * 清空 `src`。两边都不会在对方播放时偷偷起播。
 */

/**
 * 动漫档位。
 *
 * 不复用 `VideoQualityOption`：那个类型的 `value` 是红果的固定字面量联合
 * （`'4k' | '1080p' | '720p' | 'auto'`），而 dmghg 的档位名与数量都来自源端，
 * 是任意字符串（实测 1~2 档，形如 `1080P 高清` / `4K 超清`）。硬塞进旧类型
 * 只会得到一个假契约。
 */
export interface AnimeQualityOption {
  label: string;
  value: string;
  resolution: string;
}

type AnimeUiState =
  | { kind: 'idle' }
  | { kind: 'opening' }
  | { kind: 'playing' }
  | { kind: 'buffering' }
  | { kind: 'error'; code: string; message: string; recoverable: boolean };

interface AnimePlayerContextValue {
  bindVideo: (element: HTMLVideoElement | null) => void;
  isOpen: boolean;
  series: SeriesDetail | null;
  episode: EpisodeItem | null;
  uiState: AnimeUiState;
  isPlaying: boolean;
  position: number;
  duration: number;
  /** 已缓冲到的时间点（秒），供进度条的缓冲层使用。 */
  buffered: number;
  volume: number;
  muted: boolean;
  playbackRate: number;
  quality: string;
  qualities: AnimeQualityOption[];
  isSwitching: boolean;
  /** 播放中的如实技术提示（如"视频轨未出帧"），可关闭。 */
  notice: string | null;
  streamKind: AnimeStreamKind | null;
  open: (seriesId: string, episodeId?: string, startPosition?: number, qualityOverride?: string) => Promise<void>;
  close: () => void;
  togglePlay: () => void;
  seekTo: (seconds: number) => void;
  seekRelative: (delta: number) => void;
  setVolume: (value: number) => void;
  toggleMute: () => void;
  setPlaybackRate: (rate: number) => void;
  setQuality: (value: string) => void;
  playNext: () => void;
  playPrev: () => void;
  dismissNotice: () => void;
}

const AnimePlayerContext = createContext<AnimePlayerContextValue | null>(null);

/** 出帧看门狗的判定窗口：动漫分片 5-8 秒，给足两片仍无帧才判失败。 */
const FRAME_STALL_MS = 9000;

export const AnimePlayerProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { navigateTo, showToast } = useAppStore();
  // 自动连播开关来自设置页：动漫链路此前无条件连播，用户关掉开关后仍在跳集。
  const { settings } = useSettingsStore();

  const [isOpen, setIsOpen] = useState(false);
  const [series, setSeries] = useState<SeriesDetail | null>(null);
  const [episode, setEpisode] = useState<EpisodeItem | null>(null);
  const [uiState, setUiState] = useState<AnimeUiState>({ kind: 'idle' });
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  // 默认音量与短剧播放器对齐（0.85）：两个播放器起播音量不同，用户会以为音量键失灵。
  const [volume, setVolumeState] = useState(0.85);
  const [muted, setMutedState] = useState(false);
  const [playbackRate, setPlaybackRateState] = useState(1);
  const [quality, setQualityState] = useState('auto');
  const [qualities, setQualities] = useState<AnimeQualityOption[]>([]);
  const [isSwitching, setIsSwitching] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [streamKind, setStreamKind] = useState<AnimeStreamKind | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  /**
   * 当前挂载的媒体元素。
   *
   * 动漫 Surface 是**按需挂载**的（退出即销毁），所以监听器不能只绑一次；
   * 但也不能让 effect 无依赖数组——timeupdate 每秒会让位置状态更新数次，
   * 那样 9 个监听器会被反复摘挂。用元素本身作为依赖最稳。
   */
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const sessionRef = useRef(0);
  const watchdogRef = useRef<(() => void) | null>(null);
  const lastSaveRef = useRef(0);
  const seriesRef = useRef<SeriesDetail | null>(null);
  const episodeRef = useRef<EpisodeItem | null>(null);
  const qualityRef = useRef('auto');
  const volumeRef = useRef(1);
  const mutedRef = useRef(false);
  const rateRef = useRef(1);

  /**
   * 自动连播开关的最新值。
   *
   * `ended` 监听器只在元素挂载时绑一次，闭包里读不到最新的 settings，用 ref 取
   * 最新值。设置页关掉"自动连播"后，动漫不再自动跳下一集。
   */
  const autoNextRef = useRef(settings.autoNext);
  autoNextRef.current = settings.autoNext;

  const stopWatchdog = useCallback(() => {
    if (watchdogRef.current) {
      watchdogRef.current();
      watchdogRef.current = null;
    }
  }, []);

  /**
   * 等动漫 `<video>` 挂载完成。
   *
   * 这块元素是**按需挂载**的：`open()` 先 `setIsOpen(true)`，React 提交 DOM 之后
   * `bindVideo` 才会写入 `videoRef`。中间隔着一两次渲染与一次网络往返，直接读
   * `videoRef.current` 有概率为空——那时把整次打开判为失败就太冤了。
   */
  const waitForVideo = useCallback(async (sessionId: number): Promise<HTMLVideoElement | null> => {
    for (let i = 0; i < 40; i += 1) {
      if (videoRef.current) return videoRef.current;
      if (sessionRef.current !== sessionId) return null;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return videoRef.current;
  }, []);

  /**
   * 进度落库（节流 4 秒 + 强制）。
   *
   * 复用短剧那条 `history_save`：历史页/发现页的"继续观看"对动漫同样要生效。
   * 非有限时长一律按 0 上报——分片 MP4 的 `duration` 会是 `Infinity`，
   * `JSON.stringify` 把它变 null，会让整条参数反序列化失败（历史里什么都不剩）。
   */
  const persistHistory = useCallback((force: boolean) => {
    const currentSeries = seriesRef.current;
    const currentEpisode = episodeRef.current;
    const video = videoRef.current;
    if (!currentSeries || !currentEpisode || !video) return;
    const now = Date.now();
    if (!force && now - lastSaveRef.current < 4000) return;
    lastSaveRef.current = now;
    const rawDuration = video.duration;
    const safeDuration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
    const safePosition = Number.isFinite(video.currentTime) && video.currentTime > 0
      ? (safeDuration > 0 ? Math.min(video.currentTime, safeDuration) : video.currentTime)
      : 0;
    const percent = safeDuration > 0
      ? Math.min(100, Math.max(0, Math.round((safePosition / safeDuration) * 100)))
      : 0;
    void ipcService.history.save({
      seriesId: currentSeries.id,
      episodeId: currentEpisode.id,
      title: currentSeries.title,
      seriesCover: currentSeries.cover,
      episodeNumber: currentEpisode.episodeNumber,
      totalEpisodes: currentSeries.episodesCount,
      positionSeconds: Math.floor(safePosition),
      durationSeconds: Math.floor(safeDuration),
      progressPercent: percent,
      updatedAt: now,
      isFinished: percent >= 95,
      channel: 'anime',
    }).catch(() => {
      // 历史写入失败不影响播放，静默即可（后端已记录日志）。
    });
  }, []);

  const clearNotice = useCallback(() => setNotice(null), []);

  /** 停止当前会话：拆 hls、停看门狗、清源。 */
  const haltCurrent = useCallback((clearSource: boolean) => {
    stopWatchdog();
    const video = videoRef.current;
    if (video) {
      try {
        video.pause();
      } catch {
        // 忽略：元素可能已卸载
      }
      detachAnimeSource(video);
      if (clearSource) {
        video.removeAttribute('src');
        try {
          video.load();
        } catch {
          // 某些状态下 load() 会抛，忽略
        }
      }
    }
    setIsPlaying(false);
  }, [stopWatchdog]);

  const close = useCallback(() => {
    sessionRef.current += 1;
    // 落盘必须早于拆源：persistHistory 读的是 video.currentTime / duration，
    // 而 haltCurrent 会清掉 src——媒体加载算法一执行，这两个读数就归零，
    // 历史里只会留下"看到 0 秒"。
    persistHistory(true);
    haltCurrent(true);
    setIsOpen(false);
    setUiState({ kind: 'idle' });
    setSeries(null);
    setEpisode(null);
    seriesRef.current = null;
    episodeRef.current = null;
    setPosition(0);
    setDuration(0);
    setBuffered(0);
    setNotice(null);
    setStreamKind(null);
  }, [haltCurrent, persistHistory]);

  /**
   * 起播一集。
   *
   * 与短剧链路的三点关键差异（也是这个播放器存在的理由）：
   * 1. 源形态由后端 `streamKind` 决定，**不看 `canPlayType`**——它对 HLS 返回
   *    `"maybe"`，照它判就会把 m3u8 交给原生 `<video>`，15 秒后仍
   *    `videoWidth === 0`（只有声音），这正是"有声无画黑屏"。
   * 2. m3u8 恒走 hls.js（MSE）；整段 MP4 才走原生 src。
   * 3. 起播后挂出帧看门狗：没有视频帧就如实报错并停止，而不是让用户对着黑屏
   *    把一集听完。
   */
  const open = useCallback(async (
    seriesId: string,
    episodeId?: string,
    startPosition = 0,
    qualityOverride?: string,
  ) => {
    // 本地会话号只用于"这次打开是否已被更新的打开接管"的守卫（stale 判定）。
    // 传给后端的是另一套**全局递增**的会话号：后端按 session_id 保留最近 8 条
    // 会话，动漫用自己从 1 开始的私有号段会与短剧号段撞车，也会让
    // `sessions.retain(|id, _| *id >= session_id - 8)` 永远删不掉旧条目。
    const sessionId = ++sessionRef.current;
    const wireSessionId = generateNextSessionId();
    const keepPlaying = qualityOverride !== undefined && episodeRef.current?.id === episodeId;
    if (!keepPlaying) {
      haltCurrent(false);
      setIsSwitching(Boolean(episodeRef.current && seriesRef.current));
      setNotice(null);
      setUiState({ kind: 'opening' });
      setBuffered(0);
    }
    setIsOpen(true);
    navigateTo('player');

    try {
      const detail = await ipcService.series.getDetail(seriesId);
      if (sessionRef.current !== sessionId) return;
      setSeries(detail);
      seriesRef.current = detail;

      const target = episodeId
        ? detail.episodes.find(item => item.id === episodeId) ?? detail.episodes[0]
        : detail.episodes[0];
      if (!target) throw new Error('该剧集暂无可播放的集数。');
      setEpisode(target);
      episodeRef.current = target;

      const wanted = qualityOverride ?? qualityRef.current;
      const session = await ipcService.playback.open(
        seriesId,
        target.id,
        wanted,
        startPosition,
        wireSessionId,
        true,
      );
      if (sessionRef.current !== sessionId) return;

      const kind = streamKindOf(session.url, session.streamKind);
      setStreamKind(kind);

      const video = await waitForVideo(sessionId);
      if (!video) throw new Error('播放器未就绪。');
      video.preload = 'auto';
      video.playbackRate = rateRef.current;
      video.muted = mutedRef.current;
      video.volume = mutedRef.current ? 0 : volumeRef.current;
      video.dataset.sessionId = String(sessionId);

      await attachAnimeSource(video, session.url, kind);
      if (sessionRef.current !== sessionId) return;

      if (startPosition > 0) {
        const applySeek = () => {
          try {
            video.currentTime = startPosition;
          } catch {
            // 源尚未可 seek：忽略，用户可手动拖
          }
          video.removeEventListener('loadedmetadata', applySeek);
        };
        if (video.readyState >= 1) applySeek();
        else video.addEventListener('loadedmetadata', applySeek);
      }

      // 看门狗必须在 play() 之前挂上：HEVC 解不出视频轨时 play() 会成功返回、
      // readyState 也到 4，只有帧数停在 0，事后检查已经错过判定窗口。
      stopWatchdog();
      watchdogRef.current = startAnimeFrameWatchdog(video, {
        stallMs: FRAME_STALL_MS,
        onHealthy: () => {
          if (sessionRef.current === sessionId) setNotice(null);
        },
        onStalled: info => {
          if (sessionRef.current !== sessionId) return;
          stopWatchdog();
          try {
            video.pause();
          } catch {
            // 忽略
          }
          setIsPlaying(false);
          const audioOnly = info.audioAdvanced;
          setUiState({
            kind: 'error',
            code: 'ANIME_VIDEO_TRACK_UNSUPPORTED',
            message: audioOnly
              ? '这集的画面解不出来（源是 HEVC，且本机解码器没有吐出画面），只有声音。换一集或换清晰度试试。'
              : '这集的视频轨没有数据，无法播放。',
            recoverable: true,
          });
        },
        onStallAfterStart: () => {
          if (sessionRef.current !== sessionId) return;
          setNotice('画面解码已卡住，进度条仍会走 —— 建议切到下一集。');
        },
      });

      try {
        await video.play();
        if (sessionRef.current !== sessionId) return;
        setIsPlaying(true);
        setUiState({ kind: 'playing' });
      } catch (playError) {
        if (sessionRef.current !== sessionId) return;
        if (playError instanceof DOMException && playError.name === 'NotAllowedError' && !video.muted) {
          // 带声音被拒：静音起播，让用户手动恢复声音。
          video.muted = true;
          setMutedState(true);
          mutedRef.current = true;
          try {
            await video.play();
            if (sessionRef.current !== sessionId) return;
            setIsPlaying(true);
            setUiState({ kind: 'playing' });
          } catch {
            setIsPlaying(false);
            setUiState({
              kind: 'error',
              code: 'ANIME_AUTOPLAY_FAILED',
              message: '浏览器拒绝了自动播放，请点击画面播放。',
              recoverable: true,
            });
          }
        } else if (playError instanceof DOMException && playError.name === 'AbortError') {
          // WebView2 会把"被判定为后台"的窗口里的媒体暂停以省电；源本身没问题。
          setIsPlaying(false);
          setUiState({ kind: 'buffering' });
        } else {
          setIsPlaying(false);
          setUiState({
            kind: 'error',
            code: 'ANIME_PLAY_FAILED',
            message: '播放源连接受阻，请重试或换一集。',
            recoverable: true,
          });
        }
      }

      // 档位探测与当前集并行：探测要跑一次 dmghg 解析，不该挡住起播。
      void ipcService.playback.animeQualities(seriesId, target.id)
        .then(options => {
          if (sessionRef.current !== sessionId) return;
          setQualities(options ?? []);
        })
        .catch(() => {
          if (sessionRef.current !== sessionId) return;
          setQualities([]);
        });
    } catch (error) {
      if (sessionRef.current !== sessionId) return;
      setIsPlaying(false);
      const message = error instanceof Error ? error.message : String(error);
      setUiState({
        kind: 'error',
        code: 'ANIME_OPEN_FAILED',
        message: '打开失败：' + message,
        recoverable: true,
      });
      showToast('打开动漫剧集失败：' + message, 'error');
    } finally {
      if (sessionRef.current === sessionId) setIsSwitching(false);
    }
  }, [haltCurrent, navigateTo, showToast, stopWatchdog, waitForVideo]);

  /**
   * `open` 的最新引用。
   *
   * `open` 依赖 `navigateTo`/`showToast`（它们每次渲染都是新函数），直接进
   * effect 依赖数组会让监听器每次渲染都重绑。用 ref 取最新值，依赖数组里就只留
   * 真正会变的东西。
   */
  const openRef = useRef(open);
  openRef.current = open;

  /** 媒体元素事件绑定：DOM 事件只在这里转成状态，避免散落在组件里。 */
  const bindVideo = useCallback((element: HTMLVideoElement | null) => {
    videoRef.current = element;
    setVideoEl(element);
  }, []);

  useEffect(() => {
    const video = videoEl;
    if (!video) return;
    const onTime = () => {
      setPosition(video.currentTime || 0);
      persistHistory(false);
    };
    const onDuration = () => {
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
    };
    /**
     * 缓冲层读数。
     *
     * 分片源的 `buffered` 会出现多个不连续区间（hls.js 只保最近若干分片），
     * 取最后一段的末端表示"已连续缓冲到哪儿"——与短剧播放器同一套取法。
     */
    const onProgress = () => {
      if (video.buffered.length > 0) {
        setBuffered(video.buffered.end(video.buffered.length - 1));
      }
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onWaiting = () => setUiState(prev => (prev.kind === 'playing' ? { kind: 'buffering' } : prev));
    const onPlaying = () => setUiState(prev => (prev.kind === 'error' ? prev : { kind: 'playing' }));
    const onError = () => {
      setIsPlaying(false);
      setUiState({
        kind: 'error',
        code: 'ANIME_MEDIA_ERROR',
        message: '媒体解码失败（错误码 ' + String(video.error?.code ?? '?') + '）。',
        recoverable: true,
      });
    };
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('durationchange', onDuration);
    video.addEventListener('loadedmetadata', onDuration);
    video.addEventListener('progress', onProgress);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('error', onError);
    return () => {
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('durationchange', onDuration);
      video.removeEventListener('loadedmetadata', onDuration);
      video.removeEventListener('progress', onProgress);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('error', onError);
    };
  }, [videoEl, persistHistory]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch(() => {
        setUiState({
          kind: 'error',
          code: 'ANIME_RESUME_FAILED',
          message: '无法继续播放，请重试。',
          recoverable: true,
        });
      });
    } else {
      video.pause();
      persistHistory(true);
    }
  }, [persistHistory]);

  const seekTo = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    try {
      video.currentTime = Math.max(0, seconds);
      setPosition(video.currentTime);
    } catch {
      // 目标超出可 seek 范围（流式源在极端情况下）：忽略
    }
  }, []);

  const seekRelative = useCallback((delta: number) => {
    const video = videoRef.current;
    if (!video) return;
    seekTo((video.currentTime || 0) + delta);
  }, [seekTo]);

  const setVolume = useCallback((value: number) => {
    const clamped = Math.min(1, Math.max(0, value));
    setVolumeState(clamped);
    volumeRef.current = clamped;
    const video = videoRef.current;
    if (!video) return;
    video.volume = clamped;
    if (clamped > 0 && video.muted) {
      video.muted = false;
      setMutedState(false);
      mutedRef.current = false;
    }
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    const next = !mutedRef.current;
    setMutedState(next);
    mutedRef.current = next;
    if (video) video.muted = next;
  }, []);

  const setPlaybackRate = useCallback((rate: number) => {
    setPlaybackRateState(rate);
    rateRef.current = rate;
    const video = videoRef.current;
    if (video) video.playbackRate = rate;
  }, []);

  /** 换清晰度 = 重新解析该档位地址并续播（位置保留）。 */
  /**
   * 换清晰度 = 重新解析该档位地址并续播（位置保留）。
   *
   * `value` 必须是源端档位字面量（`auto` / `1080p`），**不是**中文档位名：
   * Rust 侧 `parse_quality_value` 只认 `{digits}p`，拿到"1080P 高清"会解析成 0
   * 并静默回落到 auto 档——表现就是"点了 4K，其实还是 1080P"。
   */
  const setQuality = useCallback((value: string) => {
    // 源只提供单一档位时，切同一档位不该再跑一次解析。
    if (value === qualityRef.current) return;
    setQualityState(value);
    qualityRef.current = value;
    const currentSeries = seriesRef.current;
    const currentEpisode = episodeRef.current;
    if (!currentSeries || !currentEpisode) return;
    const resumeAt = videoRef.current?.currentTime ?? 0;
    void open(currentSeries.id, currentEpisode.id, resumeAt, value);
  }, [open]);

  const playNext = useCallback(() => {
    const currentSeries = seriesRef.current;
    const currentEpisode = episodeRef.current;
    if (!currentSeries || !currentEpisode) return;
    const index = currentSeries.episodes.findIndex(item => item.id === currentEpisode.id);
    const next = currentSeries.episodes[index + 1];
    if (!next) {
      showToast('已经是最后一集了', 'info');
      return;
    }
    void open(currentSeries.id, next.id, 0);
  }, [open, showToast]);

  const playPrev = useCallback(() => {
    const currentSeries = seriesRef.current;
    const currentEpisode = episodeRef.current;
    if (!currentSeries || !currentEpisode) return;
    const index = currentSeries.episodes.findIndex(item => item.id === currentEpisode.id);
    const prev = currentSeries.episodes[index - 1];
    if (!prev) {
      showToast('已经是第一集了', 'info');
      return;
    }
    void open(currentSeries.id, prev.id, 0);
  }, [open, showToast]);

  /** 自动连播：动漫没有倒计时（与短剧不同），播完直接进下一集。 */
  useEffect(() => {
    const video = videoEl;
    if (!video) return;
    const onEnded = () => {
      persistHistory(true);
      // 尊重设置页的"自动连播"开关（关掉后停在结尾，由用户决定下一步）。
      if (!autoNextRef.current) return;
      const currentSeries = seriesRef.current;
      const currentEpisode = episodeRef.current;
      if (!currentSeries || !currentEpisode) return;
      const index = currentSeries.episodes.findIndex(item => item.id === currentEpisode.id);
      if (index >= 0 && index + 1 < currentSeries.episodes.length) {
        void openRef.current(currentSeries.id, currentSeries.episodes[index + 1].id, 0);
      }
    };
    video.addEventListener('ended', onEnded);
    return () => video.removeEventListener('ended', onEnded);
  }, [videoEl, persistHistory]);

  /** 组件卸载（退出应用）时确保不留后台声音。 */
  useEffect(() => () => {
    sessionRef.current += 1;
    stopWatchdog();
    const video = videoRef.current;
    if (video) {
      try {
        video.pause();
      } catch {
        // 忽略
      }
      detachAnimeSource(video);
    }
  }, [stopWatchdog]);

  const value = useMemo<AnimePlayerContextValue>(() => ({
    bindVideo,
    isOpen,
    series,
    episode,
    uiState,
    isPlaying,
    position,
    duration,
    buffered,
    volume,
    muted,
    playbackRate,
    quality,
    qualities,
    isSwitching,
    notice,
    streamKind,
    open,
    close,
    togglePlay,
    seekTo,
    seekRelative,
    setVolume,
    toggleMute,
    setPlaybackRate,
    setQuality,
    playNext,
    playPrev,
    dismissNotice: clearNotice,
  }), [
    bindVideo, isOpen, series, episode, uiState, isPlaying, position, duration, buffered, volume,
    muted, playbackRate, quality, qualities, isSwitching, notice, streamKind, open, close,
    togglePlay, seekTo, seekRelative, setVolume, toggleMute, setPlaybackRate, setQuality,
    playNext, playPrev, clearNotice,
  ]);

  return <AnimePlayerContext.Provider value={value}>{children}</AnimePlayerContext.Provider>;
};

export function useAnimePlayer(): AnimePlayerContextValue {
  const context = useContext(AnimePlayerContext);
  if (!context) throw new Error('useAnimePlayer 必须在 AnimePlayerProvider 内使用');
  return context;
}
