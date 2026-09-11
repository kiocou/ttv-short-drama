import React, { createContext, useContext, useState, useRef, useEffect, useCallback, ReactNode } from 'react';
import { PlaybackUiState } from '../types/playback';
import { SeriesDetail, EpisodeItem } from '../types/series';
import { ipcService } from '../services/ipc';

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
      const cacheKey = `${seriesId}:${episodeId}:${quality === '4k' ? '4k' : quality === '1080p' ? '1080p' : quality === '720p' ? '720p' : 'auto'}`;
      if (resolved.cached || resolved.sizeBytes > 0) {
        resolvedFileByVidRef.current.set(cacheKey, resolved.playUrl);
      }
      if (activeSessionRef.current !== Number(video.dataset.sessionId)) return true;
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      const assetUrl = convertFileSrc(resolved.playUrl);
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = '';
      }
      video.src = assetUrl;
      video.playbackRate = playbackRate;
      video.volume = isMuted ? 0 : volume;
      video.muted = isMuted;
      video.load();
      if (startPosition > 0) {
        const seekAfterMetadata = () => {
          try {
            video.currentTime = startPosition;
          } catch {
            // metadata may not be available yet; playback will start at zero
          }
          video.removeEventListener('loadedmetadata', seekAfterMetadata);
        };
        if (video.readyState >= 1) seekAfterMetadata();
        else video.addEventListener('loadedmetadata', seekAfterMetadata, { once: true });
      }
      try {
        await video.play();
      } catch (error) {
        // WebView2 blocks gesture-less playback with audio. Start muted, then
        // let the normal mute control restore sound after the user interacts.
        if (error instanceof DOMException && error.name === 'NotAllowedError' && !video.muted) {
          video.muted = true;
          setIsMuted(true);
          await video.play();
        } else {
          throw error;
        }
      }
      setIsPlaying(true);
      setUiState({ kind: 'playing', sessionId: activeSessionRef.current, position: video.currentTime });
      return true;
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

  const playLocalFile = async (
    playUrl: string,
    video: HTMLVideoElement,
    newSessionId: number,
    startPosition: number,
  ): Promise<boolean> => {
    try {
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      const assetUrl = convertFileSrc(playUrl);
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = '';
      }
      if (activeSessionRef.current !== newSessionId) return true; // 已切走
      video.dataset.sessionId = String(newSessionId);
      video.src = assetUrl;
      video.playbackRate = playbackRate;
      video.volume = isMuted ? 0 : volume;
      video.muted = isMuted;
      video.load();
      if (startPosition > 0) {
        const seekAfterMetadata = () => {
          try { video.currentTime = startPosition; } catch { /* metadata 未就绪则从 0 播 */ }
          video.removeEventListener('loadedmetadata', seekAfterMetadata);
        };
        if (video.readyState >= 1) seekAfterMetadata();
        else video.addEventListener('loadedmetadata', seekAfterMetadata, { once: true });
      }
      await video.play();
      setIsPlaying(true);
      setUiState({ kind: 'playing', sessionId: newSessionId, position: video.currentTime });
      return true;
    } catch (error) {
      // WebView2 拒绝带声自动播放时静音重试（与主链路同策略）。
      if (error instanceof DOMException && error.name === 'NotAllowedError' && !video.muted) {
        video.muted = true;
        setIsMuted(true);
        try {
          await video.play();
          setIsPlaying(true);
          setUiState({ kind: 'playing', sessionId: newSessionId, position: video.currentTime });
          return true;
        } catch {
          return false;
        }
      }
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
      const cachedKey = `${seriesId}:${ep.id}:${selectedQuality === '4k' ? '4k' : selectedQuality === '1080p' ? '1080p' : selectedQuality === '720p' ? '720p' : 'auto'}`;
      const cachedPlayUrl = resolvedFileByVidRef.current.get(cachedKey);
      if (video && cachedPlayUrl && cachedPlayUrl !== '__prefetching__') {
        video.dataset.sessionId = String(newSessionId);
        backupUrlRef.current = '';
        hasTriedBackupRef.current = true;
        hasTriedBlobRef.current = true;
        hasTriedNativeResolveRef.current = true;
        const played = await playLocalFile(cachedPlayUrl, video, newSessionId, startPosition);
        if (played) return;
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
        if (recovered) return;
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
        video.pause();
        if (objectUrlRef.current) {
          URL.revokeObjectURL(objectUrlRef.current);
          objectUrlRef.current = '';
        }
        video.preload = 'auto';
        video.src = session.url;
        video.playbackRate = playbackRate;
        video.volume = isMuted ? 0 : volume;
        // 优先保留用户音量。若 WebView 拒绝带声音自动播放，再在 catch 中静音重试。
        video.muted = preferredMuted;
        video.load();

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

  // 监听播放器事件（缓冲、时间更新、结束）
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => {
      const cur = video.currentTime;
      const dur = video.duration || 0;
      setPosition(cur);
      setDuration(dur);
      saveProgressThrottled(cur, dur);

      // 距离结束 8 秒且还有下一集时触发连播倒计时
      if (dur > 20 && dur - cur <= 8 && !countdown.active && currentSeries && currentEpisode) {
        const curIdx = currentSeries.episodes.findIndex(e => e.id === currentEpisode.id);
        if (curIdx >= 0 && curIdx < currentSeries.episodes.length - 1) {
          const nextEp = currentSeries.episodes[curIdx + 1];
          setCountdown({ active: true, remaining: 5, nextEpisode: nextEp });

          let sec = 5;
          if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
          countdownIntervalRef.current = setInterval(() => {
            sec -= 1;
            if (sec <= 0) {
              if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
              countdownIntervalRef.current = null;
              playNextEpisode();
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
      setUiState({ kind: 'buffering', sessionId: activeSessionRef.current });
    };

    const handlePlaying = () => {
      setIsPlaying(true);
      setUiState({ kind: 'playing', sessionId: activeSessionRef.current, position: video.currentTime });
      // 播放稳态后预取下一集：worker 后台下载+解密落缓存，到 handleEnded
      // 切集时缓存已热，秒开。已预取过/在预取中的集不重复拉。
      if (currentSeries && currentEpisode) {
        const idx = currentSeries.episodes.findIndex(e => e.id === currentEpisode.id);
        const nextEp = idx >= 0 ? currentSeries.episodes[idx + 1] : undefined;
          if (nextEp) {
            const key = `${currentSeries.id}:${nextEp.id}:${currentQuality === '4k' ? '4k' : currentQuality === '1080p' ? '1080p' : currentQuality === '720p' ? '720p' : 'auto'}`;
            if (!resolvedFileByVidRef.current.has(key)) {
              resolvedFileByVidRef.current.set(key, '__prefetching__'); // 占位防重
              void ipcService.playback
                .prefetchNative(currentSeries.id, nextEp.id, currentSeries.type === 'comic' ? 1004 : 1, currentQuality)
                .then(() => {
                  // 落盘完成。占位换成真路径得再查一次后端（纯缓存读，零开销），
                  // 直接 resolveNative 拿路径登记，换集时即命中快路径。
                  return ipcService.playback.resolveNative(
                    currentSeries.id,
                    nextEp.id,
                    currentSeries.type === 'comic' ? 1004 : 1,
                    currentQuality,
                  );
                })
                .then(resolved => {
                  resolvedFileByVidRef.current.set(key, resolved.playUrl);
                })
                .catch(() => {
                  resolvedFileByVidRef.current.delete(key); // 预取失败释放占位
                });
            }
          }
      }
    };

    const handleEnded = () => {
      setIsPlaying(false);
      setUiState({ kind: 'ended', sessionId: activeSessionRef.current });
      saveProgressThrottled(video.duration, video.duration, true);
      playNextEpisode();
    };

    const handleError = () => {
      // 清理旧源时 WebView2 可能派发一次空源 error，不应覆盖真实播放状态。
      if (!video.currentSrc && !video.src) return;
      // 本地解析已在途（openEpisode 或 play() 拒绝分支已启动 worker）：
      // 直链失败不代表应用内播不了，保持 opening 状态等待结果，禁止弹错误页或降级。
      if (nativeResolveInFlightRef.current) return;
      const backupUrl = backupUrlRef.current;
      if (backupUrl && !hasTriedBackupRef.current) {
        hasTriedBackupRef.current = true;
        setUiState({ kind: 'opening', sessionId: activeSessionRef.current, episodeId: currentEpisode?.id || '' });
        video.pause();
        const preferredMuted = isMuted;
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
        void fetch(sourceUrl, { cache: 'no-store' })
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
            const nativeAttempt = currentSeries && currentEpisode
              ? (() => {
                  hasTriedNativeResolveRef.current = true;
                  setUiState({ kind: 'opening', sessionId: activeSessionRef.current, episodeId: currentEpisode.id });
                  return startNativeResolve(
                    currentSeries.id,
                    currentEpisode.id,
                    currentQuality,
                    currentSeries.type === 'comic' ? 1004 : 1,
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
      if (currentSeries && currentEpisode) {
        hasTriedNativeResolveRef.current = true;
        setUiState({ kind: 'opening', sessionId: activeSessionRef.current, episodeId: currentEpisode.id });
        void startNativeResolve(
          currentSeries.id,
          currentEpisode.id,
          currentQuality,
          currentSeries.type === 'comic' ? 1004 : 1,
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
  }, [currentSeries, currentEpisode, currentQuality, countdown.active, isMuted, playNextEpisode, saveProgressThrottled]);

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
