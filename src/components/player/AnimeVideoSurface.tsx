import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAnimePlayer } from '../../stores/useAnimePlayerStore';
import { useAppStore } from '../../stores/useAppStore';
import { enterFullscreen, leaveFullscreen } from '../../services/windowFx';
import { isTauriEnvironment } from '../../services/ipc';
import { PlayerHud } from './PlayerHud';
import { Loader2, AlertCircle, AlertTriangle, RefreshCw, SkipForward, Copy, X, Layers } from 'lucide-react';

/**
 * 动漫专区播放器界面。
 *
 * 与短剧的 `VideoSurface` 仍是两套**独立的状态机**（动漫源形态混着 hls/整段文件、
 * WebView2 的 canPlayType 会说谎、档位里混着 HEVC，这些只对动漫成立），但**呈现层
 * 完全共用** `PlayerHud`：同一块晶体材质控制条、同一套快捷键与收起态迷你进度条。
 * 此前动漫自绘了一套紫色控制条，与短剧的晶体语言不一致，两处维护必然继续漂移。
 *
 * 仍然保留的动漫专有部分：
 * - `<video>` **按需挂载**（进入播放时创建、退出即销毁）：动漫源的挂载方式在
 *   hls.js(MSE) 与原生 src 之间来回切，留在元素上的残留状态比"销毁重建"更难清理；
 * - 出帧失败的如实提示（HEVC 解不出视频轨时媒体元素不报错，只有看门狗能发现）；
 * - 错误卡片里的"换一集"出口——动漫源的坏档位/坏线路是常态。
 */

/** 动漫错误码 → 卡片标题（正文用 store 已经写好的中文说明）。 */
function errorTitle(code: string): string {
  switch (code) {
    case 'ANIME_AUTOPLAY_FAILED':
    case 'ANIME_RESUME_FAILED':
      return '请点击播放按钮开始';
    case 'ANIME_VIDEO_TRACK_UNSUPPORTED':
      return '这一集的画面解不出来';
    case 'ANIME_OPEN_FAILED':
      return '打不开这一集';
    default:
      return '播放源连接受阻';
  }
}

/** 主行动按钮文案：起播被拦只是要点一下，重开才是重解析。 */
function errorActionLabel(code: string): string {
  return code === 'ANIME_AUTOPLAY_FAILED' || code === 'ANIME_RESUME_FAILED'
    ? '点击播放'
    : '重新解析播放';
}

export const AnimeVideoSurface: React.FC = () => {
  const {
    bindVideo,
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
    close,
    open,
    togglePlay,
    seekTo,
    seekRelative,
    setVolume,
    toggleMute,
    setPlaybackRate,
    setQuality,
    playNext,
    playPrev,
    dismissNotice,
    enterPip,
  } = useAnimePlayer();
  const { isFullscreen, setIsFullscreen, navigateTo, previousView, showToast } = useAppStore();

  /**
   * 进入画中画。
   *
   * 顺序不能反：`enterPip` 要读 `video.currentTime` 交接进度，而 `close()` 会走
   * `haltCurrent` 清掉 src——清完再读就只剩 0 秒了。交接失败则什么都不动。
   * 最后离开播放器视图，让用户在主界面继续浏览。
   */
  const handleEnterPip = async () => {
    const handed = await enterPip();
    if (!handed) return;
    close();
    navigateTo(previousView === 'player' ? 'anime' : previousView);
  };

  const [isControlsVisible, setIsControlsVisible] = useState(true);
  const [isLocked, setIsLocked] = useState(false);
  const [showEpisodes, setShowEpisodes] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);

  // 集数徽章文案。动漫源的 title 常常就是"第 N 集"（含"第1集"这种无空格写法），
  // 与集数基名等价时不再拼接，否则会显示成"第 1 集 · 第1集"。
  const episodeLabel = (() => {
    if (!episode) return '';
    const base = `第 ${episode.episodeNumber} 集`;
    const title = (episode.title || '').trim();
    const compact = (text: string) => text.replace(/\s+/g, '');
    return title && compact(title) !== compact(base) ? `${base} · ${title}` : base;
  })();

  /**
   * 自动隐藏计时器（2.5s）。
   *
   * 只在**播放中**倒计时：暂停时把控制条收起来，用户反而要多一次移动鼠标才能
   * 继续操作（短剧播放器就是这个行为，两边保持一致）。
   */
  const handleUserActivity = useCallback(() => {
    setIsControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (isPlaying) {
      hideTimerRef.current = setTimeout(() => setIsControlsVisible(false), 2500);
    }
  }, [isPlaying]);

  useEffect(() => {
    handleUserActivity();
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [isPlaying, handleUserActivity]);

  /**
   * 指针位移过滤：播放时进度条读数会持续重绘，Chromium 会派发合成 mousemove，
   * 不去重的话控制条永远收不起来（短剧那边踩过同一个坑）。
   */
  const handlePointerMove = useCallback((event: React.MouseEvent) => {
    const last = lastPointerRef.current;
    if (last) {
      const dx = event.clientX - last.x;
      const dy = event.clientY - last.y;
      if (dx * dx + dy * dy < 16) return;
    }
    lastPointerRef.current = { x: event.clientX, y: event.clientY };
    handleUserActivity();
  }, [handleUserActivity]);

  // 全屏只走原生窗口全屏（windowFx 内部会先静默解除最大化），状态以窗口真实状态为准。
  const toggleFullscreen = useCallback(async () => {
    const entering = !isFullscreen;
    if (!isTauriEnvironment()) {
      setIsFullscreen(entering);
      return;
    }
    const actual = entering ? await enterFullscreen() : await leaveFullscreen();
    setIsFullscreen(actual);
  }, [isFullscreen, setIsFullscreen]);

  const exitFullscreen = useCallback(async () => {
    if (!isTauriEnvironment()) {
      setIsFullscreen(false);
      return;
    }
    await leaveFullscreen();
    setIsFullscreen(false);
  }, [setIsFullscreen]);

  // 与原生窗口状态保持同步：用户可能用系统方式（F11 / Win+Up）改变全屏，
  // 界面按钮不能与实际状态脱节。
  useEffect(() => {
    if (!isTauriEnvironment()) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void import('@tauri-apps/api/window')
      .then(async ({ getCurrentWindow }) => {
        const win = getCurrentWindow();
        const sync = async () => {
          try {
            setIsFullscreen(await win.isFullscreen());
          } catch {
            // 查询失败时保留当前状态。
          }
        };
        const off = await win.onResized(sync);
        if (disposed) {
          off();
          return;
        }
        unlisten = off;
        await sync();
      })
      .catch(() => {});
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [setIsFullscreen]);

  // 全屏时给一个短暂的退出提示：纯原生全屏没有浏览器自带的全屏提示条。
  const [showFsHint, setShowFsHint] = useState(false);
  useEffect(() => {
    if (!isFullscreen) {
      setShowFsHint(false);
      return;
    }
    setShowFsHint(true);
    const timer = setTimeout(() => setShowFsHint(false), 3200);
    return () => clearTimeout(timer);
  }, [isFullscreen]);

  const exitToDetail = useCallback(() => {
    if (isFullscreen) {
      void leaveFullscreen().then(() => setIsFullscreen(false));
    }
    close();
    if (series?.id) navigateTo('detail', series.id);
  }, [close, isFullscreen, navigateTo, series, setIsFullscreen]);

  useEffect(() => () => {
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
  }, []);

  // 键盘：与短剧播放器同一套键位（空格 / 方向键 / F / [ ] / Esc）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
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
          setVolume(Math.min(1, volume + 0.1));
          break;
        case 'ArrowDown':
          event.preventDefault();
          setVolume(Math.max(0, volume - 0.1));
          break;
        case 'KeyF':
          event.preventDefault();
          void toggleFullscreen();
          break;
        case 'BracketLeft':
          event.preventDefault();
          playPrev();
          break;
        case 'BracketRight':
          event.preventDefault();
          playNext();
          break;
        case 'Escape':
          // 优先级：先关选集弹层；控制器处于收起态时 Esc 交给 HUD 解锁（它自己
          // 监听）；再退全屏；最后才离开播放器——用户最不想在按 Esc 时直接退出。
          if (showEpisodes) {
            setShowEpisodes(false);
          } else if (isLocked) {
            return;
          } else if (isFullscreen) {
            void exitFullscreen();
          } else {
            exitToDetail();
          }
          break;
        default:
          break;
      }
      handleUserActivity();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    exitFullscreen,
    exitToDetail,
    handleUserActivity,
    isFullscreen,
    isLocked,
    playNext,
    playPrev,
    seekRelative,
    setVolume,
    showEpisodes,
    toggleFullscreen,
    togglePlay,
    volume,
  ]);

  // 单击播放/暂停，双击全屏。
  const handleSurfaceClick = () => {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      void toggleFullscreen();
      return;
    }
    clickTimerRef.current = setTimeout(() => {
      togglePlay();
      handleUserActivity();
      clickTimerRef.current = null;
    }, 220);
  };

  const handleErrorAction = () => {
    if (uiState.kind !== 'error') return;
    if (uiState.code === 'ANIME_AUTOPLAY_FAILED' || uiState.code === 'ANIME_RESUME_FAILED') {
      togglePlay();
      return;
    }
    if (series && episode) void open(series.id, episode.id, position);
  };

  const handleCopyDiagnosis = () => {
    if (uiState.kind !== 'error') return;
    const report = [
      `错误码: ${uiState.code}`,
      `原因: ${uiState.message}`,
      `剧集: ${series?.title ?? '未知'} (${series?.id ?? '-'})`,
      `集数: 第 ${episode?.episodeNumber ?? '-'} 集 (${episode?.id ?? '-'})`,
      `档位: ${quality}`,
      `源形态: ${streamKind === 'hls' ? 'HLS(m3u8)' : streamKind === 'file' ? '整段直链' : '--'}`,
      `位置: ${Math.round(position)}s`,
    ].join('\n');
    void navigator.clipboard?.writeText(report)
      .then(() => showToast('诊断信息已复制', 'success'))
      .catch(() => showToast('复制失败，请手动截图', 'error'));
  };

  return (
    <div
      // `ttv-player`：把整棵播放器子树标记为"舞台"，crystal.css 里据此关闭
      // 作用域内的 backdrop-filter。见那里的注释——背景模糊会让视频失去独立
      // 呈现平面，RTX 视频增强（VSR）随之失效。
      className="ttv-player w-full h-full bg-black relative overflow-hidden select-none"
      onMouseMove={handlePointerMove}
    >
      {/*
        播放器元素始终渲染：bindVideo 一旦拿到元素就会挂上全部媒体监听。
        动漫播放器按需挂载/销毁，所以这里刷新页面不会留下"上次那集的残留状态"。
      */}
      <video
        ref={bindVideo}
        className="w-full h-full object-contain cursor-pointer"
        onClick={handleSurfaceClick}
        playsInline
      />

      {/* 全屏退出提示：纯原生全屏没有浏览器自带的提示条，短暂告知 Esc 可用。 */}
      {isFullscreen && showFsHint && (
        <div className="absolute top-6 inset-x-0 z-40 pointer-events-none flex justify-center">
          <div className="px-3.5 py-2 rounded-xl bg-black/70 border border-white/15 shadow-lg text-[11px] font-semibold text-white/90">
            已进入全屏 · 按 Esc 退出
          </div>
        </div>
      )}

      {/*
        等待提示分两种：
        - **首次进入**：画面本来就是空的，用全屏遮罩卡片（与短剧播放器同款浅色玻璃卡）；
        - **切换**（isSwitching）：画面里还留着上一集的最后一帧，只给一张居下提示卡，
          明确写出"正在切换到第 N 集"，绝不把那一帧盖掉。
      */}
      {uiState.kind === 'opening' && !isSwitching && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 backdrop-blur-xs pointer-events-none z-20">
          <div className="p-4 min-w-[232px] rounded-2xl bg-white/85 backdrop-blur-xl shadow-fluent-lg flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
            <span className="text-xs font-semibold text-slate-800 text-center">正在解析动漫源…</span>
            <span className="text-[10px] text-slate-400 text-center leading-relaxed">
              动漫为在线流：先解析线路与档位，再挂载播放
            </span>
          </div>
        </div>
      )}

      {uiState.kind === 'opening' && isSwitching && (
        <div className="absolute bottom-28 inset-x-0 z-20 pointer-events-none flex justify-center">
          <div className="min-w-[268px] px-4 py-3 rounded-2xl bg-black/70 shadow-2xl border border-white/15 flex flex-col gap-2.5">
            <div className="flex items-center gap-2.5">
              <Loader2 className="w-4 h-4 text-blue-400 animate-spin flex-shrink-0" />
              <span className="text-xs font-semibold text-white whitespace-nowrap">
                {episode ? `正在切换到第 ${episode.episodeNumber} 集` : '正在切换剧集'}
              </span>
              <span className="ml-auto text-xs font-bold font-mono tabular-nums text-blue-300 whitespace-nowrap">
                准备中
              </span>
            </div>
            <div className="h-1 w-full rounded-full bg-white/20 overflow-hidden">
              <div className="h-full w-1/3 bg-blue-400 rounded-full animate-[eta-slide_1.1s_ease-in-out_infinite]" />
            </div>
            <span className="text-[10px] text-white/60 text-center">正在解析动漫源…</span>
          </div>
        </div>
      )}

      {/*
        缓冲态只给一个小胶囊，不用全屏遮罩：动漫是在线流，卡顿会反复出现，
        每次卡一下就把画面盖住是倒退。
      */}
      {uiState.kind === 'buffering' && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
          <div className="crystal-surface px-3.5 py-2.5 rounded-2xl flex items-center gap-2.5">
            <Loader2 className="w-4 h-4 text-white animate-spin" />
            <span className="text-xs font-semibold text-white/90">缓冲中…</span>
          </div>
        </div>
      )}

      {/* 如实提示（不打断播放）：例如"画面解码卡住、进度条仍在走"。 */}
      {notice && (
        <div className="absolute top-[74px] left-1/2 -translate-x-1/2 z-40 max-w-xl px-4 py-2.5 rounded-2xl crystal-surface flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-300 mt-0.5 shrink-0" />
          <span className="text-amber-50 text-[12px] leading-relaxed">{notice}</span>
          <button
            type="button"
            onClick={dismissNotice}
            className="text-white/60 hover:text-white"
            title="关闭提示"
            aria-label="关闭提示"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* 错误态覆盖（与短剧播放器同款卡片，保留"换一集"这个动漫特有的出口） */}
      {uiState.kind === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm z-30">
          <div className="p-6 max-w-sm rounded-2xl bg-white/95 backdrop-blur-2xl shadow-fluent-lg flex flex-col items-center text-center gap-3 border border-white">
            <AlertCircle className="w-10 h-10 text-rose-500" />
            <h3 className="text-sm font-bold text-slate-800">{errorTitle(uiState.code)}</h3>
            <p className="text-xs text-slate-500 leading-relaxed">{uiState.message}</p>

            {/* 失败原因必须可见：用户截图即可定位是解析失败、解码失败还是 play 被打断。 */}
            <button
              type="button"
              onClick={handleCopyDiagnosis}
              title="复制诊断信息（错误码 / 原因 / 剧集 / 集数 / 档位）"
              className="max-w-[17rem] text-left px-2.5 py-2 rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-200 transition-colors cursor-pointer group"
            >
              <span className="block text-[10px] leading-relaxed text-slate-500 font-mono break-words">
                {uiState.code}
              </span>
              <span className="mt-1 flex items-center gap-1 text-[10px] font-semibold text-slate-400 group-hover:text-blue-600">
                <Copy className="w-3 h-3" />
                复制诊断信息
              </span>
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleErrorAction}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-sm transition-transform active:scale-95"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>{errorActionLabel(uiState.code)}</span>
              </button>
              <button
                type="button"
                onClick={playNext}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold transition-colors"
              >
                <SkipForward className="w-3.5 h-3.5" />
                <span>下一集</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 共用 HUD：短剧与动漫同一套晶体控制条 */}
      <PlayerHud
        title={series?.title ?? '动漫专区'}
        episodeLabel={episodeLabel}
        backTitle="返回详情（Esc）"
        position={position}
        duration={duration}
        buffered={buffered}
        isPlaying={isPlaying}
        isFullscreen={isFullscreen}
        isVisible={isControlsVisible}
        isLocked={isLocked}
        volume={volume}
        isMuted={muted}
        playbackRate={playbackRate}
        currentQuality={quality}
        qualityOptions={qualities}
        onToggleLock={() => setIsLocked(value => !value)}
        onToggleFullscreen={toggleFullscreen}
        onUserActivity={handleUserActivity}
        onPointerMove={handlePointerMove}
        onTogglePlay={togglePlay}
        onSeek={seekTo}
        onSeekRelative={seekRelative}
        onVolumeChange={setVolume}
        onToggleMute={toggleMute}
        onPlaybackRate={setPlaybackRate}
        onQualityChange={setQuality}
        onPlayPrev={playPrev}
        onPlayNext={playNext}
        onOpenEpisodes={() => setShowEpisodes(true)}
        onBack={exitToDetail}
        onEnterPip={handleEnterPip}
      />

      {/* 选集巨幕：与短剧选集抽屉同一个晶体面板（此处只需列出剧集，无需分页/搜索） */}
      {series && (
        <div
          className={`ttv-drawer-overlay${showEpisodes ? ' open' : ''}`}
          aria-hidden={!showEpisodes}
          onClick={() => setShowEpisodes(false)}
        >
          <div
            className="crystal-drawer-box crystal-surface-deep"
            role="dialog"
            aria-modal="true"
            aria-label="选集播放"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-top-header">
              <div className="flex items-center gap-2.5 min-w-0">
                <div
                  className="w-8 h-8 rounded-[10px] flex items-center justify-center flex-shrink-0"
                  style={{
                    background: 'rgba(0, 120, 212, 0.22)',
                    border: '1px solid rgba(56, 189, 248, 0.35)',
                    color: '#38bdf8',
                  }}
                >
                  <Layers className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-bold text-white">选集播放</span>
                    <span
                      className="text-[10px] font-bold px-1.5 py-px rounded-full"
                      style={{
                        color: '#38bdf8',
                        background: 'rgba(0, 120, 212, 0.25)',
                        border: '1px solid rgba(56, 189, 248, 0.3)',
                      }}
                    >
                      共 {series.episodes.length} 集
                    </span>
                  </div>
                  <p className="text-[11px] text-white/60 truncate max-w-[240px]">{series.title}</p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setShowEpisodes(false)}
                className="btn-fluent-action"
                title="关闭 (Esc)"
                aria-label="关闭选集"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="drawer-ep-grid">
              {series.episodes.map(item => {
                const active = episode?.id === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setShowEpisodes(false);
                      void open(series.id, item.id, 0);
                    }}
                    title={`第 ${item.episodeNumber} 集 · ${item.title}${active ? ' (当前播放)' : ''}`}
                    className={`ep-card-item${active ? ' active' : ''}`}
                  >
                    <span>{item.episodeNumber}</span>
                    {active && (
                      <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-emerald-400 ring-2 ring-[#0b1220] animate-ping" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
