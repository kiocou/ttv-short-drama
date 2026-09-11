import React, { createContext, useContext, useState, useRef, useEffect, useCallback, ReactNode } from 'react';
import { PlaybackUiState } from '../types/playback';
import { SeriesDetail, EpisodeItem } from '../types/series';
import { ipcService } from '../services/ipc';
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

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeSessionRef = useRef<number>(100);
  const backupUrlRef = useRef<string>('');
  const hasTriedBackupRef = useRef<boolean>(false);
  const hasTriedBlobRef = useRef<boolean>(false);
  const hasTriedNativeResolveRef = useRef<boolean>(false);
  const objectUrlRef = useRef<string>('');
  // 在途的本地解析 promise。play() 拒绝与 video error 事件可能先后触发同一次
  // 恢复流程，记录在途任务让后到的分支等待同一结果，而不是重复起 worker 或提前报错。
  const nativeResolveInFlightRef = useRef<Promise<boolean> | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 供"只绑定一次"的事件监听器间接调用的稳定引用。
  const playNextEpisodeRef = useRef<() => void>(() => {});
  const saveProgressThrottledRef = useRef<(pos: number, dur: number, force?: boolean) => void>(() => {});

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
    probe.crossOrigin = 'anonymous';
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
    newSessionId: number,
    startPosition: number,
  ): Promise<boolean> => {
    try {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = '';
      }
      video.dataset.sessionId = String(newSessionId);
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

      if (startPosition > 0) {
        try {
          video.currentTime = startPosition;
        } catch {
          // metadata 未就绪则从 0 播
        }
      }
      try {
        await video.play();
      } catch (error) {
        // WebView2 拒绝带声自动播放时静音重试。
        if (error instanceof DOMException && error.name === 'NotAllowedError' && !video.muted) {
          video.muted = true;
          setIsMuted(true);
          await video.play();
        } else {
          throw error;
        }
      }
      setIsPlaying(true);
      setUiState({ kind: 'playing', sessionId: newSessionId, position: video.currentTime });
      return true;
    } catch (error) {
      console.warn('[playback] adopt prepared source failed', { error });
      return false;
    }
  };

  const playNativeResolvedFile = async (
    seriesId: string,
    episodeId: string,
    quality: string,
    contentType: number,
    video: HTMLVideoElement,
    startPosition = 0,
  ): Promise<boolean> => {
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
      if (activeSessionRef.current !== Number(video.dataset.sessionId)) return true;
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      const assetUrl = convertFileSrc(resolved.playUrl);
      // 先预载到可播，再接管主播放器——旧画面在新源就绪前一直保留。
      const prepared = await preloadSource(assetUrl, startPosition);
      if (activeSessionRef.current !== Number(video.dataset.sessionId)) {
        disposePrepared(prepared ? { url: assetUrl, element: prepared } : null);
        return true;
      }
      if (!prepared) {
        // 预载失败：退化为直接喂给主播放器，至少给出真实错误而不是静默卡住。
        if (objectUrlRef.current) {
          URL.revokeObjectURL(objectUrlRef.current);
          objectUrlRef.current = '';
        }
        video.src = assetUrl;
        video.load();
        try {
          await video.play();
          setIsPlaying(true);
          setUiState({ kind: 'playing', sessionId: activeSessionRef.current, position: video.currentTime });
          return true;
        } catch {
          return false;
        }
      }
      const adopted = await adoptPreparedSource(
        { url: assetUrl, element: prepared },
        video,
        activeSessionRef.current,
        startPosition,
      );
      disposePrepared({ url: assetUrl, element: prepared });
      return adopted;
    } catch (error) {
      console.warn('[playback] native resolve failed', { seriesId, episodeId, contentType, quality, error });
      return false;
    }
  };

  // 统一的本地解析入口：把在途 promise 记到 ref 上，供 error 事件链等待复用。
  const startNativeResolve = (
    seriesId: string,
    episodeId: string,
    quality: string,
    contentType: number,
    video: HTMLVideoElement,
    startPosition = 0,
  ): Promise<boolean> => {
    const attempt = playNativeResolvedFile(seriesId, episodeId, quality, contentType, video, startPosition)
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
   * 预热当前集相邻的集（下一集优先，其次上一集）。
   *
   * 旧实现的预取挂在 handlePlaying 上，只有"真正开始播"才触发，而且占位符
   * `__prefetching__` 会被快路径主动跳过——等于预取从未生效，用户每次换集
   * 都还是要等完整下载。现在改成 openEpisode 落点就发起，提前一整集的
   * 播放时长（1-3 分钟）去后台下载，换集时大概率已命中缓存。
   */
  const warmAdjacentEpisodes = (
    series: SeriesDetail,
    currentEpisodeId: string,
    sessionAtRequest: number,
  ) => {
    const idx = series.episodes.findIndex(e => e.id === currentEpisodeId);
    if (idx < 0) return;
    const contentType = series.type === 'comic' ? 1004 : 1;
    // 下一集优先（连播的主要目标），其次上一集。
    const targets = [series.episodes[idx + 1], series.episodes[idx - 1]].filter(Boolean) as EpisodeItem[];
    targets.forEach(target => {
      const key = episodeCacheKey(series.id, target.id);
      const existing = resolvedFileByVidRef.current.get(key);
      if (existing && existing !== '__prefetching__') return; // 已热
      if (existing === '__prefetching__') return; // 在途
      if (activeSessionRef.current !== sessionAtRequest) return;
      resolvedFileByVidRef.current.set(key, '__prefetching__');
      // 占位必须保证最终释放：prefetchNative 会吞掉网络异常，若不在约定时间内
      // 收尾，'__prefetching__' 会永久占住 key，导致该集再也无法被预取或被
      // 快路径命中。用一个兜底定时器强制清理。
      const guard = setTimeout(() => {
        if (resolvedFileByVidRef.current.get(key) === '__prefetching__') {
          resolvedFileByVidRef.current.delete(key);
        }
      }, 330_000);
      void ipcService.playback
        .prefetchNative(series.id, target.id, contentType, 'auto')
        .then(() => ipcService.playback.resolveNative(series.id, target.id, contentType, 'auto'))
        .then(resolved => {
          clearTimeout(guard);
          if (resolved.playUrl) resolvedFileByVidRef.current.set(key, resolved.playUrl);
          else resolvedFileByVidRef.current.delete(key);
        })
        .catch(() => {
          clearTimeout(guard);
          resolvedFileByVidRef.current.delete(key); // 预取失败释放占位
        });
    });
  };

  const playLocalFile = async (
    playUrl: string,
    video: HTMLVideoElement,
    newSessionId: number,
    startPosition: number,
  ): Promise<boolean> => {
    try {
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      const assetUrl = convertFileSrc(playUrl);
      if (activeSessionRef.current !== newSessionId) return true; // 已切走
      // 本地整集文件同样走"先预载、再接管"：即便文件已在盘上，
      // 也让旧帧留到新源解码就绪，避免同一条换集链路上出现两套体验。
      const prepared = await preloadSource(assetUrl, startPosition, 6000);
      if (activeSessionRef.current !== newSessionId) {
        disposePrepared(prepared ? { url: assetUrl, element: prepared } : null);
        return true;
      }
      if (!prepared) {
        // 预载失败（文件被删/损坏）：交回调用方清缓存并走完整链路。
        return false;
      }
      const adopted = await adoptPreparedSource(
        { url: assetUrl, element: prepared },
        video,
        newSessionId,
        startPosition,
      );
      disposePrepared({ url: assetUrl, element: prepared });
      return adopted;
    } catch (error) {
      console.warn('[playback] local file play failed', { playUrl, error });
      return false;
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

  // 打开剧集与换集核心
  const openEpisode = async (seriesId: string, episodeId?: string, startPosition = 0, qualityOverride?: string) => {
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

    const newSessionId = (activeSessionRef.current += 1);
    setSessionId(newSessionId);
    if (!qualitySwitchRequested) {
      setUiState({ kind: 'opening', sessionId: newSessionId, episodeId: episodeId || '' });
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
        const played = await playLocalFile(cachedPlayUrl, video, newSessionId, startPosition);
        if (played) {
          // 命中快路径才预热相邻集：此时播放已稳定，后台下载不影响出画。
          warmAdjacentEpisodes(detail, ep.id, newSessionId);
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
        const recovered = await startNativeResolve(
          seriesId,
          ep.id,
          selectedQuality,
          detail.type === 'comic' ? 1004 : 1,
          video,
          startPosition,
        );
        if (recovered) {
          // 首次进入该集且播放成功：后台探测真实清晰度档位，不阻塞播放。
          void probeQualities(ep.id, detail.type === 'comic' ? 1004 : 1);
          warmAdjacentEpisodes(detail, ep.id, newSessionId);
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
            ).then(recovered => {
              if (recovered) return;
              setIsPlaying(false);
              setUiState({ kind: 'error', sessionId: newSessionId, code, recoverable: true });
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
        setUiState({
          kind: 'error',
          sessionId: newSessionId,
          code: (err as Error).message || 'MEDIA_LOAD_FAILED',
          recoverable: true,
        });
      }
    }
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
              position,
            );
          })();
          void attempt.then(recovered => {
            if (!recovered) {
              setUiState({ kind: 'error', sessionId: activeSessionRef.current, code: 'MEDIA_LOAD_FAILED', recoverable: true });
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
                  );
                })()
              : Promise.resolve(false);
            void nativeAttempt.then(recovered => {
              if (recovered) return;
              setIsPlaying(false);
              setUiState({ kind: 'error', sessionId: activeSessionRef.current, code: 'MEDIA_LOAD_FAILED', recoverable: true });
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
