import React, { useState, useEffect, useRef, useCallback } from 'react';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { PlayerControls } from './PlayerControls';
import { EpisodeDrawer } from './EpisodeDrawer';
import { NextCountdown } from './NextCountdown';
import { DiagnosticsModal } from './DiagnosticsModal';
import { Loader2, AlertCircle, RefreshCw } from 'lucide-react';

export const VideoSurface: React.FC = () => {
  const {
    videoRef,
    uiState,
    isPlaying,
    togglePlay,
    seekRelative,
    setVolume,
    volume,
    playNextEpisode,
    playPrevEpisode,
    openEpisode,
    currentSeries,
    currentEpisode,
    position,
    isMuted,
  } = usePlaybackStore();

  const [isControlsVisible, setIsControlsVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 控制条自动隐藏定时器 (2.5s)
  const handleUserActivity = useCallback(() => {
    setIsControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (isPlaying) {
      hideTimerRef.current = setTimeout(() => {
        setIsControlsVisible(false);
      }, 2500);
    }
  }, [isPlaying]);

  useEffect(() => {
    handleUserActivity();
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [isPlaying, handleUserActivity]);

  // 全屏切换
  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // 视频单击播放/暂停，双击全屏优化
  const handleVideoSurfaceClick = () => {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      toggleFullscreen();
    } else {
      clickTimerRef.current = setTimeout(() => {
        togglePlay();
        handleUserActivity();
        clickTimerRef.current = null;
      }, 220);
    }
  };

  // 键盘全局快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          togglePlay();
          handleUserActivity();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          seekRelative(-5);
          handleUserActivity();
          break;
        case 'ArrowRight':
          e.preventDefault();
          seekRelative(5);
          handleUserActivity();
          break;
        case 'ArrowUp':
          e.preventDefault();
          setVolume(Math.min(1, volume + 0.1));
          handleUserActivity();
          break;
        case 'ArrowDown':
          e.preventDefault();
          setVolume(Math.max(0, volume - 0.1));
          handleUserActivity();
          break;
        case 'KeyF':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'BracketLeft': // [
          e.preventDefault();
          playPrevEpisode();
          break;
        case 'BracketRight': // ]
          e.preventDefault();
          playNextEpisode();
          break;
        case 'Escape':
          if (document.fullscreenElement) {
            document.exitFullscreen();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlay, seekRelative, setVolume, volume, playPrevEpisode, playNextEpisode, toggleFullscreen, handleUserActivity]);

  return (
    <div
      ref={containerRef}
      onMouseMove={handleUserActivity}
      className="relative w-full h-full bg-black flex items-center justify-center overflow-hidden select-none"
    >
      {/* 核心 HTML5 视频渲染宿主 */}
      <video
        ref={videoRef}
        playsInline
        className="w-full h-full object-contain cursor-pointer"
        onClick={handleVideoSurfaceClick}
      />

      {/* 缓冲与加载状态覆盖 */}
      {(uiState.kind === 'opening' || uiState.kind === 'buffering') && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 backdrop-blur-xs pointer-events-none z-20">
          <div className="p-4 rounded-2xl bg-white/85 backdrop-blur-xl shadow-fluent-lg flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
            <span className="text-xs font-semibold text-slate-800">
              {uiState.kind === 'opening' ? '正在连接高码流源...' : '缓冲中...'}
            </span>
          </div>
        </div>
      )}

      {/* 错误态覆盖 */}
      {uiState.kind === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm z-30">
          <div className="p-6 max-w-sm rounded-2xl bg-white/95 backdrop-blur-2xl shadow-fluent-lg flex flex-col items-center text-center gap-3 border border-white">
            <AlertCircle className="w-10 h-10 text-rose-500" />
            <h3 className="text-sm font-bold text-slate-800">
              {uiState.code === 'MEDIA_AUTOPLAY_FAILED'
                ? '请点击播放按钮开始'
                : '播放源连接受阻'}
            </h3>
            <p className="text-xs text-slate-500 leading-relaxed">
              {uiState.code === 'MEDIA_AUTOPLAY_FAILED'
                ? '浏览器限制了自动播放，点击下方按钮即可继续。'
                : '该媒体无法由 WebView 解码，已尝试备用源与兼容 Blob 播放。'}
            </p>
            <button
              onClick={() => {
                if (uiState.code === 'MEDIA_AUTOPLAY_FAILED') {
                  if (videoRef.current) videoRef.current.muted = isMuted;
                  togglePlay();
                } else if (uiState.code === 'MEDIA_BACKUP_LOAD_FAILED' && currentSeries && currentEpisode) {
                  openEpisode(currentSeries.id, currentEpisode.id, position);
                } else if (currentSeries && currentEpisode) {
                  openEpisode(currentSeries.id, currentEpisode.id, 0);
                }
              }}
              className="mt-2 flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-sm transition-transform active:scale-95"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>{uiState.code === 'MEDIA_AUTOPLAY_FAILED' ? '点击播放' : '重新解析播放'}</span>
            </button>
          </div>
        </div>
      )}

      {/* 悬浮云母控制层 HUD */}
      <PlayerControls
        isVisible={isControlsVisible}
        isFullscreen={isFullscreen}
        onToggleFullscreen={toggleFullscreen}
        onUserActivity={handleUserActivity}
      />

      {/* 连播倒计时悬浮窗 */}
      <NextCountdown />

      {/* 侧边选集抽屉 */}
      <EpisodeDrawer />

      {/* 诊断悬浮弹窗 */}
      <DiagnosticsModal />
    </div>
  );
};
