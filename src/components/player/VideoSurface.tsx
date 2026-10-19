import React, { useState, useEffect, useRef, useCallback } from 'react';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { useAppStore } from '../../stores/useAppStore';
import { isTauriEnvironment } from '../../services/ipc';
import { enterFullscreen, leaveFullscreen, queryFullscreen } from '../../services/windowFx';
// 起播链路的媒体事件打点：用户报的「一直在加载等待」只有在事件时间线上才看得出
// 卡在哪一段（清单未就绪 / 首个分片未到 / 解码器没起）。这些事件都不密集，
// 且打点是 fire-and-forget，不影响渲染。
import { tracePlayback } from '../../services/playbackTrace';
import { PlayerControls } from './PlayerControls';
import { useBoostKeys } from './useBoostKeys';
import { BoostToast } from './BoostToast';
import { PlayerToast } from './PlayerToast';
import { usePlayerToast, formatClock } from './usePlayerToast';
import { EpisodeDrawer } from './EpisodeDrawer';
import { DiagnosticsModal } from './DiagnosticsModal';
import {
  Loader2,
  AlertCircle,
  RefreshCw,
  Copy,
  X,
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  SkipBack,
  SkipForward,
  RotateCcw,
  RotateCw,
} from 'lucide-react';

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
    playbackRate,
    errorDetail,
    stallNotice,
    dismissStallNotice,
    finishedAll,
    sessionId,
  } = usePlaybackStore();

  /**
   * 画面中央的操作提示（形态照 B 站播放器）。
   *
   * 每个快捷键都要有反馈：按了空格画面停了，用户得能分清"暂停了"还是"卡住了"；
   * 按 ↑↓ 调音量，得看见具体数值；按 [ ] 切集，得知道切到了第几集。
   * 提示内容由下面的各个处理函数在**动作发生时**调 `showPlayerToast` 决定。
   */
  const {
    toast: playerToast,
    tick: playerToastTick,
    show: showPlayerToast,
  } = usePlayerToast();

  // 全屏状态放在 App 级：标题栏需要据此隐藏，播放器只负责切换它。
  // 返回详情页也在这里发起（而非 store 内部）：导航权归组件层，store 只出信号。
  const { isFullscreen, setIsFullscreen, showToast, currentView, navigateTo } = useAppStore();

  const [isControlsVisible, setIsControlsVisible] = useState(true);
  // 控制器锁定（用户主动收起）状态；Esc 可解锁（PlayerControls 内部监听）。
  const [isLocked, setIsLocked] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // 起播计时基准。用 ref 而不是 state：它只喂给日志，不该引发任何重渲染。
  const surfaceReadyAt = useRef<number>(performance.now());
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);

  // 单击/双击判定用的 220ms 定时器必须在卸载时清掉。
  //
  // 历史坑：旧实现只在"第二次点击"那条同步路径里 clearTimeout，卸载时不管。
  // 于是单击画面后 220ms 内退出播放器（返回详情页 / 切到发现页）时，App.tsx 已经
  // stopPlayback()、video 也已经 pause，但这个定时器照样到点执行 togglePlay() ——
  // 常驻的 <video> 会在用户已经离开播放器之后重新出声。
  // 对照：AnimeVideoSurface 的同款定时器早已做了卸载清理。
  useEffect(() => () => {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
  }, []);

  // 控制条自动隐藏定时器 (2.5s)。锁定时保持可见（HUD 隐藏但锁与迷你条接管），
  // 这里不需要特判——锁定态 HUD 是否显示由 PlayerControls 内部决定。
  const handleUserActivity = useCallback(() => {
    setIsControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (isPlaying) {
      hideTimerRef.current = setTimeout(() => {
        setIsControlsVisible(false);
      }, 2500);
    }
  }, [isPlaying]);

  /**
   * 指针移动 → 自动隐藏的统一入口。
   *
   * 不把 handleUserActivity 直接挂 mousemove：播放中进度条与时间读数在光标
   * 下方持续动画时，Chromium 会派发合成 mousemove，反复重置 2.5s 定时器，
   * 表现为"控制栏永不收起"。这里按真实位移过滤——不足 4px 的合成事件忽略。
   */
  const handlePointerMove = useCallback((e: React.MouseEvent) => {
    const last = lastPointerRef.current;
    if (last) {
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      if (dx * dx + dy * dy < 16) return;
    }
    lastPointerRef.current = { x: e.clientX, y: e.clientY };
    handleUserActivity();
  }, [handleUserActivity]);

  useEffect(() => {
    handleUserActivity();
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [isPlaying, handleUserActivity]);

  // 全剧播完 → 返回详情页。
  //
  // store 在"连播开启 + 最后一集正常播完"时置位 finishedAll（闸门判定只能在
  // store 做：交接期的旧源 ended、连播闩锁这些只有它分得清）。这里留 2 秒再走，
  // 让最后一集的收尾和提示被看到，而不是播完瞬间就把画面抽走；期间用户的任何
  // 接管（拖进度、重新开播、选集、离开播放器）都会把 finishedAll 复位，本定时器
  // 随 cleanup 作废。全屏不用管：App 在离开播放视图时会自动退全屏。
  // currentView 是双保险——即使 finishedAll 尚未来得及复位，人已不在播放器
  // 也不该再触发导航。
  useEffect(() => {
    if (!finishedAll || !currentSeries) return;
    showToast('本剧已播完', 'success');
    const timer = setTimeout(() => {
      if (currentView !== 'player') return;
      const video = videoRef.current;
      // 用户已把进度拖回重新看：不再自动返回（配合 store 的复位，双保险）。
      if (video && !video.ended) return;
      navigateTo('detail', currentSeries.id);
    }, 2000);
    return () => clearTimeout(timer);
  }, [finishedAll, currentSeries, currentView, navigateTo, showToast, videoRef]);


  /**
   * 全屏切换（**只使用原生窗口全屏**）。
   *
   * 为什么不再用 element.requestFullscreen()：
   * 两套机制各自独立、无法可靠同步，实测导致两类故障——
   *   1. 窗口进了全屏但 DOM 全屏失败（await 之后用户手势已失效），视频仍被
   *      挤在标题栏下方，表现为"全屏后视频不放大"；
   *   2. Esc 由 Chromium 处理退出 DOM 全屏、状态置为 false，而原生窗口仍停在
   *      全屏，表现为"退出全屏后整个程序还是全屏"。
   *
   * 现在窗口真正铺满屏幕，由 App 在 isFullscreen 时隐藏标题栏，播放器即可
   * 占满整个窗口。单一事实来源，不存在失步。
   *
   * **窗口最大化时必须先解除最大化再进全屏**（详见 windowFx 的注释）：
   * tao 对仍带最大化的无边框窗口会把客户区裁到"屏幕减任务栏"，于是全屏后
   * 任务栏还在、画面铺不满——这正是用户报告的"窗口全屏下打开播放器全屏不对"。
   */
  const toggleFullscreen = useCallback(async () => {
    const entering = !isFullscreen;
    if (!isTauriEnvironment()) {
      // 浏览器（Mock）模式没有原生窗口，退化为纯 CSS 全屏展示。
      setIsFullscreen(entering);
      return;
    }
    // 状态以窗口真实状态为准（windowFx 内部会核实），不乐观写入。
    const actual = entering ? await enterFullscreen() : await leaveFullscreen();
    setIsFullscreen(actual);
  }, [isFullscreen, setIsFullscreen]);

  /**
   * 退出全屏（离开播放器、或用户按 Esc 时调用）。
   *
   * 独立成函数是因为它有多个调用点，且必须幂等——重复调用不能报错。
   * 同样会还原进入全屏前的最大化状态。
   */
  const exitFullscreen = useCallback(async () => {
    if (!isTauriEnvironment()) {
      setIsFullscreen(false);
      return;
    }
    await leaveFullscreen();
    setIsFullscreen(false);
  }, [setIsFullscreen]);

  /**
   * 与原生窗口状态保持同步。
   *
   * 用户可能用系统方式（F11、Win+Up、窗口快捷键）改变全屏，那样界面按钮会
   * 与实际状态脱节。这里直接查询窗口的真实全屏状态作为唯一依据，
   * 不再参考 document.fullscreenElement。
   */
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

  // 视频单击播放/暂停，双击全屏优化。
  // 锁定态一律忽略：锁的语义就是"除解锁外一切输入失效"，点画面不许再暂停/全屏。
  const handleVideoSurfaceClick = () => {
    if (isLocked) return;
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      // 双击进/退全屏：与键盘 F 同一套提示，用户不必猜刚才那下是什么。
      showPlayerToast({
        key: 'fullscreen',
        icon: isFullscreen ? <Minimize className="w-10 h-10" /> : <Maximize className="w-10 h-10" />,
        label: isFullscreen ? '退出全屏' : '全屏播放',
      });
      toggleFullscreen();
    } else {
      clickTimerRef.current = setTimeout(() => {
        // 单击暂停/播放：提示要反映**切换后**的状态，所以按 isPlaying 取反。
        showPlayerToast({
          key: 'playback',
          icon: isPlaying ? <Pause className="w-10 h-10" /> : <Play className="w-10 h-10" />,
          label: isPlaying ? '暂停' : '播放',
        });
        togglePlay();
        handleUserActivity();
        clickTimerRef.current = null;
      }, 220);
    }
  };

  // 指针离开画面时喂一次自动隐藏定时器（原来的 pointerdown/up 长按逻辑已移除，
  // 但这个入口本身是「用户还在操作」的信号，保留）。
  const handleSurfacePointerUp = () => {
    handleUserActivity();
  };

  /**
   * 长按 ← / → 临时加速，加速中 ↑ / ↓ 换档（智能 / 1.5x / 2x / 3x）。
   *
   * 键位与状态机都在 `useBoostKeys` + `services/boostController`：动漫播放器用的是
   * **同一份**。此前只有这里接了长按加速，动漫按 ← / → 永远只是跳转 —— 同一款控制条
   * 两种手感，正是要消灭的不一致。
   */
  /**
   * 快进 / 快退 + 中央提示。
   *
   * 只在**普通跳转**时弹（长按进入加速由 BoostToast 负责，两者不会同时出现：
   * `useBoostKeys` 在加速起效后会吞掉这次跳转，根本不会走到这里）。
   *
   * 提示里带「目标时间 / 总时长」：只写"快进 5 秒"用户还得自己算跳到哪了；
   * 直接给出目标位置，一眼就知道落点对不对。
   */
  const seekWithToast = useCallback(
    (delta: number) => {
      const video = videoRef.current;
      const duration = video?.duration ?? 0;
      const target = Math.min(
        Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY,
        Math.max(0, position + delta),
      );
      showPlayerToast({
        key: delta >= 0 ? 'seek-forward' : 'seek-back',
        icon: delta >= 0 ? <RotateCw className="w-10 h-10" /> : <RotateCcw className="w-10 h-10" />,
        label: delta >= 0 ? `快进 ${Math.abs(delta)} 秒` : `快退 ${Math.abs(delta)} 秒`,
        detail:
          Number.isFinite(duration) && duration > 0
            ? `${formatClock(target)} / ${formatClock(duration)}`
            : formatClock(target),
      });
      seekRelative(delta);
    },
    [position, seekRelative, showPlayerToast, videoRef],
  );

  /**
   * 音量步进 + 中央提示。
   *
   * 单独抽出来是因为它有**两个调用方**：`useBoostKeys` 的 ↑/↓（非加速时调音量），
   * 以及键盘处理里的其它入口。提示只在真正发生音量变化时才弹——
   * 已经 100% 时再按 ↑ 不该闪一个"音量 100%"让人以为又调大了，
   * 但也得给一次反馈，否则用户会以为按键没生效。
   *
   * ## 基准值必须读"当下真实音量"，不能用闭包里的 `volume`（2026-10-19 修）
   *
   * 按住 ↑ / ↓ 时系统会连续派发 keydown（每秒十几条）。旧实现用闭包捕获的
   * `volume` 算 `next = volume + delta`，而 React 的 state 提交是异步的 ——
   * 同一帧内连续几条事件读到的都是**同一个旧值**，于是：
   *   - 第一次按 0.5 → 0.6（生效）
   *   - 紧接着的第二条仍读到 0.5 → 又算成 0.6（等于没动）
   * 表现就是"按住只加一格，之后不涨了"。
   *
   * 现在以 `video.volume`（媒体元素的真实值，`setVolume` 里是同步写的）为基准，
   * 保证每一档都在上一档的基础上累加。元素不存在时才退回 state。
   */
  const stepVolumeWithToast = useCallback(
    (delta: number) => {
      const video = videoRef.current;
      // 优先读媒体元素的真实音量：它是同步写入的，不受 React 提交时机影响。
      const base = video && Number.isFinite(video.volume) ? video.volume : volume;
      const next = Math.min(1, Math.max(0, base + delta));
      const atEdge = Math.abs(next - base) < 0.001;
      const silent = next <= 0.001;
      if (!atEdge) setVolume(next);
      showPlayerToast({
        key: atEdge ? 'volume-edge' : 'volume',
        icon: silent ? <VolumeX className="w-10 h-10" /> : <Volume2 className="w-10 h-10" />,
        label: silent ? '静音' : atEdge ? (delta > 0 ? '音量已满' : '音量已静音') : '音量',
        detail: `${Math.round(next * 100)}%`,
        // 传当前音量：圆底外圈会画一道进度弧，直观表达"现在多大音量"。
        volume: next,
      });
    },
    [volume, setVolume, showPlayerToast, videoRef],
  );

  const boost = useBoostKeys({
    enabled: currentView === 'player',
    isLocked,
    getVideo: () => videoRef.current,
    getBaseRate: () => playbackRate,
    seekRelative: seekWithToast,
    stepVolume: stepVolumeWithToast,
    onUserActivity: handleUserActivity,
    // 换集即结束加速：新一集由 store 把 playbackRate 重置成基准倍速，
    // 而加速控制器若不自知，提示条会留在画面上、与实际倍速脱钩。
    sessionId,
  });

  // 键盘全局快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;
      // 播放器宿主常驻 DOM（离开页面只是隐藏），而这里的监听挂在 window 上：
      // 不挡住的话，在发现/详情页按空格会"操控看不见的视频"——暂停/续播、
      // [] 换集都会在后台真实生效。
      if (currentView !== 'player') return;
      // 锁定态：快捷键全部失效，唯一出口是解锁（PlayerHud 里的 Esc 监听负责）。
      // 与动漫播放器同一语义——锁住后连"Esc 退全屏"都没有，先解锁再操作。
      if (isLocked) return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          // 提示要反映**切换后**的状态：`isPlaying` 是切换前的值，所以取反。
          // 直接读切换后的值需要等 store 更新，这里用取反更即时也更稳。
          showPlayerToast({
            key: 'playback',
            icon: isPlaying ? <Pause className="w-10 h-10" /> : <Play className="w-10 h-10" />,
            label: isPlaying ? '暂停' : '播放',
          });
          togglePlay();
          handleUserActivity();
          break;
        case 'KeyF':
          e.preventDefault();
          showPlayerToast({
            key: 'fullscreen',
            icon: isFullscreen ? <Minimize className="w-10 h-10" /> : <Maximize className="w-10 h-10" />,
            label: isFullscreen ? '退出全屏' : '全屏播放',
          });
          toggleFullscreen();
          break;
        case 'BracketLeft': // [
          e.preventDefault();
          showPlayerToast({
            key: 'episode-prev',
            icon: <SkipBack className="w-10 h-10" />,
            label: '上一集',
          });
          playPrevEpisode();
          break;
        case 'BracketRight': // ]
          e.preventDefault();
          showPlayerToast({
            key: 'episode-next',
            icon: <SkipForward className="w-10 h-10" />,
            label: '下一集',
          });
          playNextEpisode();
          break;
        case 'Escape':
          // 方向键卡在按住状态又按了 Esc 时，避免倍速留在加速值上——
          // 这一处由 useBoostKeys 自己的 Esc 分支负责。
          // 纯原生全屏下浏览器不会代为处理 Esc（那是 DOM 全屏的行为），
          // 必须显式退出，否则用户会觉得"退不出全屏"。
          if (isFullscreen) {
            void exitFullscreen();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlay, playPrevEpisode, playNextEpisode, toggleFullscreen, exitFullscreen, isFullscreen, handleUserActivity, currentView, isLocked, isPlaying, showPlayerToast]);

  // 全屏时给一个短暂的退出提示：纯原生全屏没有浏览器自带的全屏提示条，
  // 用户不一定会想到 Esc。
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

  // 加载态只有一种呈现：右下角的小胶囊（spinner + "缓冲中…"）。
  // 首次起播与换集走同一条路径——之前那种全屏遮罩会把旧帧盖掉，而且和换集时的
  // 大卡片长得完全不同，同一个"正在等源"的状态出现两套视觉。具体的解析阶段、
  // 百分比与预计秒数属于排查信息，统一挪到设置页的播放诊断面板。
  const isLoadingVisible = uiState.kind === 'opening' || uiState.kind === 'buffering';

  return (
    <div
      ref={containerRef}
      onMouseMove={handlePointerMove}
      className="ttv-video-stage relative w-full h-full bg-black flex items-center justify-center overflow-hidden select-none"
    >
      {/* 核心 HTML5 视频渲染宿主 */}
      <video
        ref={videoRef}
        playsInline
        className="w-full h-full object-contain cursor-pointer"
        onClick={handleVideoSurfaceClick}
        onPointerUp={handleSurfacePointerUp}
        onPointerCancel={handleSurfacePointerUp}
        onPointerLeave={handleSurfacePointerUp}
        onLoadStart={() => {
          // 基准重置点必须挂在 loadstart 上：loadstart 属于媒体加载算法的一部分，
          // 换源时必然触发，比在 React 层订阅 sessionId 更贴近真实的"这一集从哪一刻开始拉"。
          surfaceReadyAt.current = performance.now();
          tracePlayback('媒体 loadstart 开始加载');
        }}
        onLoadedData={event =>
          tracePlayback(`媒体 loadeddata 首帧就绪 readyState=${event.currentTarget.readyState} 耗时=${Math.round(performance.now() - surfaceReadyAt.current)}ms`)
        }
        onCanPlay={() => tracePlayback('媒体 canplay 可播放')}
        onPlaying={() => tracePlayback('媒体 playing 开始播放')}
        onWaiting={() => tracePlayback('媒体 waiting 缓冲等待（这是「一直在加载」的关键证据）')}
        onStalled={() => tracePlayback('媒体 stalled 拉流停滞')}
      />

      {/* 长按加速提示：按住方向键进入加速时出现，松开即消失。 */}
      {boost && (
        <div className="absolute top-6 inset-x-0 z-40 pointer-events-none flex justify-center">
          <BoostToast level={boost.level} direction={boost.direction} />
        </div>
      )}

      {/*
        操作提示（空格 / ← → / ↑ ↓ / F / [ ]）：画面正中央闪一下就淡出。

        层级 z-40 与加速提示同级、但两者不会同时出现——加速期间 ← → 被
        `useBoostKeys` 吞掉、↑ ↓ 改去换档，都不会走到这里的提示。
        不挂在控制条里：控制条会自动隐藏，而提示需要在任何时刻都能看见。

        视觉重心比几何中心略高（padding-bottom: 40）：纯居中时提示显得偏低。
        用 padding 而不是 translateY —— 位移会引入额外合成层，而本舞台内任何
        常驻 transform 都可能影响 RTX VSR（不变量 26）。padding 只改变 flex
        的可用空间，把内容自然推上去，不产生新层。

        **外层容器也条件渲染**：没有提示时整块不挂载，避免在播放器舞台上
        常留一个 `absolute inset-0` 的透明层（它会参与命中测试与合成树遍历）。
      */}
      {playerToast && (
        <div
          className="absolute inset-0 z-40 pointer-events-none flex items-center justify-center"
          style={{ paddingBottom: 40 }}
        >
          <PlayerToast payload={playerToast} tick={playerToastTick} />
        </div>
      )}

      {/* 全屏退出提示：纯原生全屏没有浏览器自带的提示条，短暂告知 Esc 可用。 */}
      {isFullscreen && showFsHint && (
        <div className="absolute top-6 inset-x-0 z-30 pointer-events-none flex justify-center">
          <div className="px-3.5 py-2 rounded-xl bg-black/70 border border-white/15 shadow-lg text-[11px] font-semibold text-white/90">
            已进入全屏 · 按 Esc 退出
          </div>
        </div>
      )}

      {/*
        卡死提示：刻意挂在顶部而不是底部——卡死时 uiState 往往同时是 buffering，
        底部正被"缓冲中…"胶囊占着，两张卡叠在一起会互相盖住。

        生命周期归 store：恢复成功后它自己置回 null，这里只管"用户手动关掉"。
      */}
      {stallNotice && (
        <div className="absolute top-20 inset-x-0 z-30 flex justify-center pointer-events-none px-6">
          <div className="min-w-[268px] max-w-md px-4 py-3 rounded-2xl bg-black/70 shadow-2xl border border-white/15 flex items-center gap-2.5">
            <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0" />
            <span className="text-xs font-semibold text-white leading-relaxed">
              {stallNotice}
            </span>
            <button
              type="button"
              onClick={dismissStallNotice}
              className="btn-fluent-action -mr-1.5 flex-shrink-0 pointer-events-auto"
              title="关闭提示"
              aria-label="关闭提示"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/*
        唯一的加载提示：右下角小胶囊。首次起播与换集共用同一形态，
        不遮挡画面也不覆盖上一帧。详细的解析阶段/百分比/预计秒数见设置页
        的「播放诊断日志」面板。
      */}
      {isLoadingVisible && (
        <div className="absolute inset-x-0 bottom-32 z-20 pointer-events-none flex justify-center">
          <div className="flex items-center gap-2 rounded-full bg-black/55 px-3 py-1.5 shadow-lg border border-white/10">
            <Loader2 className="w-3.5 h-3.5 text-white/80 animate-spin flex-shrink-0" />
            <span className="text-[11px] font-medium text-white/90 whitespace-nowrap">缓冲中…</span>
          </div>
        </div>
      )}

      {/* 错误态覆盖 */}
      {uiState.kind === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm z-30">
          <div className="p-6 max-w-sm rounded-2xl bg-white/95 backdrop-blur-2xl shadow-fluent-lg flex flex-col items-center text-center gap-3 border border-white">
            <AlertCircle className="w-10 h-10 text-rose-500" />
            {/* 卡死与解码失败是两回事：源是好的、是解码线程不再吐帧。原先它落进
                默认分支显示"该媒体无法由 WebView 解码"，等于把这个结论错误地归因给
                源与 WebView —— 与不变量 8「诚实报告边界」冲突。 */}
            {/* 站方资源下线同理：guo 站源 404（后端 sanitize_guo_error 的稳定字面量，
                见 CHANGELOG 2026-09-30）是站方的数据死了，与 WebView 解码无关。
                同一部剧多源转载是 guo 站常态（实测《蜂门》花果死而无果 63 章全可播），
                所以这里直接给出换源出路，而不是让用户对着一个错误的归因反复重试。 */}
            {uiState.code === 'MEDIA_PLAYBACK_STALLED' ? (
              <>
                <h3 className="text-sm font-bold text-slate-800">播放已停止响应</h3>
                <p className="text-xs text-slate-500 leading-relaxed">
                                    画面长时间没有推进，自动重试播放仍无响应。已为你回到 3 秒前重新载入本集；若仍然卡住，请换一集。
                </p>
              </>
            ) : uiState.code === 'MEDIA_LOAD_FAILED' && errorDetail?.includes('播放文件不存在或已下线') ? (
              <>
                <h3 className="text-sm font-bold text-slate-800">这一集在当前站源已失效</h3>
                <p className="text-xs text-slate-500 leading-relaxed">
                  站方已下线本集的播放文件，重试无效。可换看其他集，或回到发现页切换其他站源观看同一部剧。
                </p>
              </>
            ) : (
              <>
                <h3 className="text-sm font-bold text-slate-800">
                  {uiState.code === 'MEDIA_AUTOPLAY_FAILED'
                    ? '请点击播放按钮开始'
                    : '播放源连接受阻'}
                </h3>
                <p className="text-xs text-slate-500 leading-relaxed">
                  {uiState.code === 'MEDIA_AUTOPLAY_FAILED'
                    ? '浏览器限制了自动播放，点击下方按钮即可继续。'
                    // ⚠️ 不要谎称"已尝试备用源与兼容 Blob 播放"：整集 HLS 收敛为单源之后，
                    // 那两步在有流式源时是被**主动跳过**的（`resetStreamingSource` 的注释
                    // 里有原因）。按字面读完再点重试的用户会发现"它说试过，其实没试"。
                    : '这集的画面没能解出来。可能是源本身的问题，也可能是后台还在转码。'}
                </p>
                {/*
                  当设备同时跑着整集下载与转码时，最先失败的往往是"分片还来不及
                  生成"，而不是源本身有问题。此时上面那句"无法由 WebView 解码"
                  是错误归因 —— 用户按它的字面意思只会去怀疑自己的电脑或网络。
                  补一句可能的原因，并明确"再试一次通常就好"，避免用户直接弃剧。
                */}
                <p className="mt-1.5 text-[11px] text-slate-400 leading-relaxed">
                  若刚点开就报错，可能是后台仍在下载与转码；稍等几秒点"重新解析播放"通常即可。
                </p>
              </>
            )}
            {/* 失败原因必须可见：否则用户（和排查者）只能看到一句笼统的
                "播放源连接受阻"，分不清是整集解析失败、解码失败还是 play 被打断。 */}
            {errorDetail && (
              <button
                onClick={() => {
                  const report = [
                    `错误码: ${uiState.kind === 'error' ? uiState.code : '未知'}`,
                    `原因: ${errorDetail}`,
                    `剧集: ${currentSeries?.title ?? '未知'} (${currentSeries?.id ?? '-'})`,
                    `集数: 第 ${currentEpisode?.episodeNumber ?? '-'} 集 (${currentEpisode?.id ?? '-'})`,
                    `位置: ${Math.round(position)}s`,
                  ].join('\n');
                  void navigator.clipboard?.writeText(report)
                    .then(() => showToast('诊断信息已复制', 'success'))
                    .catch(() => showToast('复制失败，请手动截图', 'error'));
                }}
                title="复制诊断信息（错误码 / 原因 / 剧集 / 集数）"
                className="max-w-[17rem] text-left px-2.5 py-2 rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-200 transition-colors cursor-pointer group"
              >
                <span className="block text-[10px] leading-relaxed text-slate-500 font-mono break-words">
                  {errorDetail}
                </span>
                <span className="mt-1 flex items-center gap-1 text-[10px] font-semibold text-slate-400 group-hover:text-blue-600">
                  <Copy className="w-3 h-3" />
                  复制诊断信息
                </span>
              </button>
            )}
            <button
              onClick={() => {
                if (uiState.code === 'MEDIA_AUTOPLAY_FAILED') {
                  if (videoRef.current) videoRef.current.muted = isMuted;
                  togglePlay();
                } else if (uiState.code === 'MEDIA_BACKUP_LOAD_FAILED' && currentSeries && currentEpisode) {
                  openEpisode(currentSeries.id, currentEpisode.id, position);
                } else if (currentSeries && currentEpisode) {
                  // 卡死是从头看回退 3 秒，与看门狗的自动重装载保持同一套起播点；
                  // 其它错误码才是"源可能已经坏了，从头重解一次"的语义。
                  const restartAt = uiState.code === 'MEDIA_PLAYBACK_STALLED'
                    ? Math.max(0, position - 3)
                    : 0;
                  openEpisode(currentSeries.id, currentEpisode.id, restartAt);
                }
              }}
              className="mt-2 flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-sm transition-transform active:scale-95"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>
                {/* 标签必须与下方 onClick 的真实调用同语义：卡死走的是"回退 3 秒重载本集"，
                    旧文案"重新解析播放"会诱导用户以为点完换了条链路，实际上还是这一集
                    （整集已缓存，不重签名不重下），点完只会再卡一次（不变量 8）。 */}
                {uiState.code === 'MEDIA_AUTOPLAY_FAILED'
                  ? '点击播放'
                  : uiState.code === 'MEDIA_PLAYBACK_STALLED'
                    ? '重新载入本集'
                    : '重新解析播放'}
              </span>
            </button>
          </div>
        </div>
      )}

      {/* 悬浮云母控制层 HUD */}
      <PlayerControls
        effectivePlaybackRate={boost?.rate ?? null}
        isVisible={isControlsVisible}
        isLocked={isLocked}
        onToggleLock={() => setIsLocked((value) => !value)}
        isFullscreen={isFullscreen}
        onToggleFullscreen={toggleFullscreen}
        onUserActivity={handleUserActivity}
        onPointerMove={handlePointerMove}
      />

      {/* 连播倒计时悬浮窗 */}

      {/* 侧边选集抽屉 */}
      <EpisodeDrawer />

      {/* 诊断悬浮弹窗 */}
      <DiagnosticsModal />
    </div>
  );
};
