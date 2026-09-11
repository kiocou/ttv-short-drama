import React, { useState, useEffect, useRef, useCallback } from 'react';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { isTauriEnvironment } from '../../services/ipc';
import { PlayerControls } from './PlayerControls';
import { EpisodeDrawer } from './EpisodeDrawer';
import { NextCountdown } from './NextCountdown';
import { DiagnosticsModal } from './DiagnosticsModal';
import { Loader2, AlertCircle, RefreshCw } from 'lucide-react';

/** worker 上报的解析阶段 → 用户可读文案。 */
const STAGE_LABEL: Record<string, string> = {
  start: '正在启动云端解析…',
  sign: '正在校验播放凭据…',
  model: '正在获取播放信息…',
  fallback: '正在切换备用线路…',
  download: '正在缓存本集…',
  transcode: '正在转换格式…',
};

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
    prepareStatus,
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

  /**
   * 全屏切换。
   *
   * 这里有两条必须同时走的路径，缺一不可：
   * 1. **原生窗口全屏**（Tauri `setFullscreen`）：让 OS 窗口真正进入全屏状态。
   *    旧实现只调用 `element.requestFullscreen()`，那仅仅是让 DOM 元素撑满
   *    应用自己的窗口——窗口边框、任务栏位置、窗口层级都还是窗口态，所以
   *    用户会觉得"全屏是假的"。
   * 2. **DOM 全屏**：让视频容器占据整个视口，把标题栏与导航栏交给浏览器隐藏。
   *
   * 原生调用失败（浏览器环境或权限未授予）时静默退回纯 DOM 全屏，保证功能可用。
   */
  const toggleFullscreen = useCallback(async () => {
    const container = containerRef.current;
    if (!container) return;
    const entering = !isFullscreen;

    if (isTauriEnvironment()) {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().setFullscreen(entering);
      } catch {
        // 权限或环境不支持：继续走 DOM 全屏兜底。
      }
    }

    try {
      if (entering) {
        if (!document.fullscreenElement) await container.requestFullscreen();
      } else if (document.fullscreenElement) {
        await document.exitFullscreen();
      }
    } catch {
      // DOM 全屏被拒绝也不影响已完成的原生全屏。
    }
    setIsFullscreen(entering);
  }, [isFullscreen]);

  // 同步全屏状态：既要跟随 DOM 全屏事件，也要跟随原生窗口状态，
  // 否则用户用系统快捷键（如 F11）退出全屏后，界面按钮会停留在"退出全屏"。
  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) setIsFullscreen(false);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);

    let unlisten: (() => void) | null = null;
    let disposed = false;
    if (isTauriEnvironment()) {
      void import('@tauri-apps/api/window')
        .then(async ({ getCurrentWindow }) => {
          const win = getCurrentWindow();
          const off = await win.onResized(async () => {
            try {
              const full = await win.isFullscreen();
              setIsFullscreen(full || Boolean(document.fullscreenElement));
            } catch {
              // 查询失败时保留当前状态。
            }
          });
          if (disposed) off();
          else unlisten = off;
        })
        .catch(() => {});
    }

    return () => {
      disposed = true;
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      if (unlisten) unlisten();
    };
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
            void document.exitFullscreen();
          }
          // 原生窗口全屏下浏览器不会自动处理 Esc，需要显式退出。
          if (isTauriEnvironment()) {
            void import('@tauri-apps/api/window')
              .then(({ getCurrentWindow }) => getCurrentWindow().setFullscreen(false))
              .then(() => setIsFullscreen(false))
              .catch(() => {});
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlay, seekRelative, setVolume, volume, playPrevEpisode, playNextEpisode, toggleFullscreen, handleUserActivity]);

  // 加载态的呈现方式取决于画面上是否已有内容：换集时主播放器保留了上一集的
  // 最后一帧（切换路径刻意不调用 load()），此时用全屏遮罩等于把这一帧盖掉。
  // readyState >= HAVE_CURRENT_DATA(2) 且已有播放进度，即认为"有旧帧可留"。
  const isLoadingVisible = uiState.kind === 'opening' || uiState.kind === 'buffering';
  const hasVisibleFrame = (videoRef.current?.readyState ?? 0) >= 2 && position > 0;
  const loadingLabel = uiState.kind === 'buffering'
    ? '缓冲中…'
    : prepareStatus
      ? prepareStatus.message || STAGE_LABEL[prepareStatus.stage] || '正在准备播放源…'
      : '正在准备播放源…';

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

      {/*
        加载态分两种呈现，取决于画面上是否已有上一帧：
        - 首次进入（无帧）：全屏遮罩 + 阶段文案 + 真实下载百分比。
        - 换集（有帧）：旧画面继续留在屏幕上（这正是"无缝"的意义），
          只在角落给一个不遮挡内容的进度胶囊。全屏黑罩会把保留的旧帧盖掉，
          等于把无缝切换的设计意图又抹掉了。
      */}
      {isLoadingVisible && hasVisibleFrame && (
        <div className="absolute bottom-24 right-4 z-20 pointer-events-none">
          <div className="px-3 py-2 rounded-xl bg-black/55 backdrop-blur-md shadow-lg flex items-center gap-2.5 border border-white/15">
            <Loader2 className="w-3.5 h-3.5 text-white animate-spin flex-shrink-0" />
            <span className="text-[11px] font-semibold text-white whitespace-nowrap">
              {loadingLabel}
            </span>
            {prepareStatus?.percent != null && (
              <span className="text-[11px] font-mono text-white/80 tabular-nums w-9 text-right">
                {prepareStatus.percent}%
              </span>
            )}
          </div>
          {prepareStatus?.percent != null && (
            <div className="mt-1 h-1 w-full rounded-full bg-white/20 overflow-hidden">
              <div
                className="h-full bg-blue-400 rounded-full transition-[width] duration-300 ease-out"
                style={{ width: `${Math.min(100, Math.max(0, prepareStatus.percent))}%` }}
              />
            </div>
          )}
        </div>
      )}

      {isLoadingVisible && !hasVisibleFrame && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 backdrop-blur-xs pointer-events-none z-20">
          <div className="p-4 min-w-[232px] rounded-2xl bg-white/85 backdrop-blur-xl shadow-fluent-lg flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
            <span className="text-xs font-semibold text-slate-800 text-center">
              {loadingLabel}
            </span>
            {prepareStatus?.percent != null ? (
              <>
                <div className="w-44 h-1.5 rounded-full bg-slate-200/90 overflow-hidden">
                  <div
                    className="h-full bg-blue-600 rounded-full transition-[width] duration-300 ease-out"
                    style={{ width: `${Math.min(100, Math.max(0, prepareStatus.percent))}%` }}
                  />
                </div>
                <span className="text-[11px] font-mono text-slate-500">{prepareStatus.percent}%</span>
              </>
            ) : (
              <span className="text-[10px] text-slate-400 text-center leading-relaxed">
                首次播放需完整缓存本集，之后即可秒开
              </span>
            )}
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
