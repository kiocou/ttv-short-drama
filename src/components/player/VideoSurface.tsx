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
  fallback: '正在获取分集直链…',
  download: '正在缓存本集…',
  transcode: '正在转换格式…',
};

/**
 * 各阶段的预估剩余秒数（下载阶段除外——那个用真实速率推算）。
 *
 * 依据实测：单集解析总计约 7.4 秒，其中
 *   - 签名 + API 往返     约 3.6 秒（Python 启动仅 0.3 秒，其余是签名计算与网络）
 *   - 下载 + 解密转存     约 3.9 秒（随集大小波动，按速率推算更准）
 * 这些常数用于"还没开始下载"时也能给出一个像样的等待预期，
 * 而不是让用户对着转圈猜。
 */
const STAGE_BASELINE_SECONDS: Record<string, number> = {
  start: 6,
  sign: 5,
  model: 4,
  fallback: 3,
  transcode: 1,
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
    isSwitching,
  } = usePlaybackStore();

  const [isControlsVisible, setIsControlsVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // 平滑倒计时读数：worker 每 10% 才上报一次，直接用上报值会几秒才跳一下。
  const [etaTick, setEtaTick] = useState<number | null>(null);
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

  /**
   * 本次解析的预计剩余秒数。
   *
   * 下载阶段用真实速率推算（store 侧采样相邻两次百分比），
   * 下载开始前用阶段基准值。两者都是"还要多久"，而不是"已经过了多久"。
   */
  const estimatedRemaining = (() => {
    if (!prepareStatus) return null;
    if (prepareStatus.etaSeconds != null) return prepareStatus.etaSeconds + 1; // +1 秒解密转存
    const base = STAGE_BASELINE_SECONDS[prepareStatus.stage];
    return base ?? null;
  })();

  // 平滑递减：读数每秒往下走，避免每 10% 才跳一次造成"卡住了"的错觉。
  useEffect(() => {
    if (estimatedRemaining == null || !isLoadingVisible) {
      setEtaTick(null);
      return;
    }
    setEtaTick(estimatedRemaining);
    const timer = setInterval(() => {
      setEtaTick(prev => (prev == null || prev <= 1 ? 1 : prev - 1));
    }, 1000);
    return () => clearInterval(timer);
    // 只在预估秒数变化时重置，避免每次 render 都重建定时器。
  }, [estimatedRemaining, isLoadingVisible]);

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
        等待提示分两种，取决于用户是"切换"还是"首次进入"：

        - **切换**（isSwitching）：用户已经等待过一次，需要知道还要多久。
          给一个居下、不遮挡画面的提示卡，明确写出"切换到第 N 集 · 预计 X 秒"。
        - **首次进入**（无旧帧）：画面本来就是空的，用全屏遮罩 + 进度。

        后台预取（warmAdjacentEpisodes / 悬停预热）**不进入任何提示分支**，
        对用户完全静默——这正是"播放时就该开始加载，但别打扰我"。
      */}
      {isLoadingVisible && isSwitching && (
        <div className="absolute bottom-28 inset-x-0 z-20 pointer-events-none flex justify-center">
          <div className="min-w-[268px] px-4 py-3 rounded-2xl bg-black/70 shadow-2xl border border-white/15 flex flex-col gap-2.5">
            <div className="flex items-center gap-2.5">
              <Loader2 className="w-4 h-4 text-blue-400 animate-spin flex-shrink-0" />
              <span className="text-xs font-semibold text-white whitespace-nowrap">
                {currentEpisode
                  ? `正在切换到第 ${currentEpisode.episodeNumber} 集`
                  : '正在切换剧集'}
              </span>
              <span className="ml-auto text-xs font-bold font-mono tabular-nums text-blue-300 whitespace-nowrap">
                {etaTick != null ? `约 ${etaTick} 秒` : '准备中'}
              </span>
            </div>
            {/* 进度条：下载阶段用真实百分比，之前的阶段给一段循环动画，
                让"正在签名/取直链"这段（实测约 3.6 秒）也有明确的进行感。 */}
            <div className="h-1 w-full rounded-full bg-white/20 overflow-hidden">
              {prepareStatus?.percent != null ? (
                <div
                  className="h-full bg-blue-400 rounded-full transition-[width] duration-300 ease-out"
                  style={{ width: `${Math.min(100, Math.max(0, prepareStatus.percent))}%` }}
                />
              ) : (
                <div className="h-full w-1/3 bg-blue-400 rounded-full animate-[eta-slide_1.1s_ease-in-out_infinite]" />
              )}
            </div>
            <span className="text-[10px] text-white/60 text-center">
              {loadingLabel}
            </span>
          </div>
        </div>
      )}

      {isLoadingVisible && !isSwitching && (
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
