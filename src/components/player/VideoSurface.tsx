import React, { useState, useEffect, useRef, useCallback } from 'react';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { useAppStore } from '../../stores/useAppStore';
import { isTauriEnvironment } from '../../services/ipc';
import { enterFullscreen, leaveFullscreen, queryFullscreen } from '../../services/windowFx';
// 起播链路的媒体事件打点：用户报的「一直在加载等待」只有在事件时间线上才看得出
// 卡在哪一段（清单未就绪 / 首个分片未到 / 解码器没起）。这些事件都不密集，
// 且打点是 fire-and-forget，不影响渲染。
import { tracePlayback } from '../../services/playbackTrace';
import { createBoostController, type BoostController } from '../../services/boostController';
import { PlayerControls } from './PlayerControls';
import { EpisodeDrawer } from './EpisodeDrawer';
import { DiagnosticsModal } from './DiagnosticsModal';
import { Loader2, AlertCircle, RefreshCw, Copy, X, FastForward } from 'lucide-react';

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
    playbackRate,
    prepareStatus,
    isSwitching,
    errorDetail,
    stallNotice,
    dismissStallNotice,
    finishedAll,
  } = usePlaybackStore();

  // 全屏状态放在 App 级：标题栏需要据此隐藏，播放器只负责切换它。
  // 返回详情页也在这里发起（而非 store 内部）：导航权归组件层，store 只出信号。
  const { isFullscreen, setIsFullscreen, showToast, currentView, navigateTo } = useAppStore();

  const [isControlsVisible, setIsControlsVisible] = useState(true);
  // 控制器锁定（用户主动收起）状态；Esc 可解锁（PlayerControls 内部监听）。
  const [isLocked, setIsLocked] = useState(false);
  // 平滑倒计时读数：worker 每 10% 才上报一次，直接用上报值会几秒才跳一下。
  const [etaTick, setEtaTick] = useState<number | null>(null);
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
      toggleFullscreen();
    } else {
      clickTimerRef.current = setTimeout(() => {
        togglePlay();
        handleUserActivity();
        clickTimerRef.current = null;
      }, 220);
    }
  };

  /**
   * 长按方向键临时 3 倍速（参考红果/果果的快捷操作）。
   *
   * **触发方式是「按住 ← / →」**，不是按住画面。
   * 旧实现把长按挂在 `<video>` 的 pointerdown 上，与单击（播放/暂停）、双击
   * （全屏）共用同一个元素：鼠标用户轻轻按久一点（>350ms）就会意外进入 3 倍速，
   * 而触屏用户想「按住画面看细节」时同样会误触加速。方向键没有这层歧义——
   * 键盘按住的语义本身就是「持续」，而且长按期间画面不会产生任何点击手势。
   *
   * 行为：按住 350ms 起效（起效前松手 = 普通快退/快进 5 秒，语义不变）；
   * 起效后松手只恢复原速、**不跳转**（否则用户会先被加速、再被弹到 +5 秒处）；
   * 失焦（窗口切走）与 Esc 也会恢复，避免倍速被永久留在 3×。
   * 临时倍速只改 video.playbackRate，不动 store 里的用户倍速设定——
   * 恢复时永远回到播放器菜单里选的那个值。
   */
  const LONG_PRESS_MS = 350;
  // 加速是**相对用户倍速的倍数**，不是固定 3x：控制栏把倍速调到 1.5x 之后，
  // 长按应当得到 4.5x（再按上限截断）。固定值会让人觉得「长按把我设的倍速重置了」。
  const BOOST_MULTIPLIER = 3;
  // 上限 4x：够快又不至于让解码/音频变形太明显。2x 基准下长按即到顶。
  const BOOST_MAX_RATE = 4;
  // 倍速的最新值。用户可能在**按住期间**去菜单里改倍速，那时恢复目标必须是新值；
  // 用 ref 而不是把 playbackRate 列进 controller 的依赖（后者会重建控制器、
  // 连带丢掉正在计时的长按定时器）。
  const playbackRateRef = useRef(playbackRate);
  playbackRateRef.current = playbackRate;

  // 状态机放在 services/boostController 里：那里的三条语义（阈值、松手的归属、
  // 恢复目标）有 20 条确定性用例覆盖（scripts/verify-boost.mjs，假时钟 + 假 video，
  // 不依赖真实定时器）。本组件只负责把按键事件接上去——这样"验证过的逻辑"
  // 与"线上跑的代码"是同一份，而不是另写一个仿制品来测。
  // 长按加速的提示条状态。用 state 而不是 ref：它要驱动 UI 显示/隐藏，
  // 而加速进入/退出本身就只发生一次（不是逐帧），不会带来重渲染压力。
  const [boostRate, setBoostRate] = useState<number | null>(null);

  const boostRef = useRef<BoostController | null>(null);
  if (boostRef.current === null) {
    boostRef.current = createBoostController({
      getVideo: () => videoRef.current,
      getBaseRate: () => playbackRateRef.current,
      holdMs: LONG_PRESS_MS,
      multiplier: BOOST_MULTIPLIER,
      maxRate: BOOST_MAX_RATE,
      // 进入加速时把**真实生效的速率**交给提示条；退出时置空隐藏。
      onChange: (boosting, rate) => setBoostRate(boosting ? rate : null),
    });
  }

  const cancelLongPressBoost = useCallback(() => boostRef.current?.cancel(), []);

  /** 按住方向键：计时到 350ms 且确实在播才加速。 */
  const beginKeyBoost = useCallback(() => boostRef.current?.press(), []);

  /** 松开方向键；返回 true 表示这次按下应被当作普通快退/快进。 */
  const endKeyBoost = useCallback(() => boostRef.current?.release() ?? true, []);

  // 指针离开画面时喂一次自动隐藏定时器（原来的 pointerdown/up 长按逻辑已移除，
  // 但这个入口本身是「用户还在操作」的信号，保留）。
  const handleSurfacePointerUp = () => {
    handleUserActivity();
  };

  // 卸载与倍速变更时收掉长按加速：卸载不清理会留下一个悬空定时器，
  // 而用户在按住期间改了倍速设定的话，恢复值也要跟着变。
  useEffect(() => cancelLongPressBoost, [cancelLongPressBoost]);

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
          togglePlay();
          handleUserActivity();
          break;
        case 'ArrowLeft':
        case 'ArrowRight':
          e.preventDefault();
          // 同一次按住只处理一次：系统的按键重复（typematic）每秒会再发十几条
          // keydown，不加这道闸门就会不停重置长按定时器，永远到不了 350ms。
          if (e.repeat) break;
          handleUserActivity();
          // 按住 350ms → 进入临时 3 倍速；不到 350ms 就松手 → 普通快退/快进 5 秒。
          // 两者共用同一次按下，所以加速起效后由 keyup 吞掉这次跳转。
          beginKeyBoost();
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
          // 方向键卡在按住状态又按了 Esc 时，避免倍速留在 3×。
          cancelLongPressBoost();
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
  }, [togglePlay, seekRelative, setVolume, volume, playPrevEpisode, playNextEpisode, toggleFullscreen, exitFullscreen, isFullscreen, handleUserActivity, currentView, isLocked, beginKeyBoost, cancelLongPressBoost]);

  /**
   * 松开方向键：接管这次按下的归属。
   *
   * 两种情形分开处理，都是为了「一次按下只做一件事」：
   *   - 加速已经起效 → 只恢复原速，**不跳转**。否则用户会先看到画面加速，
   *     松手瞬间又被弹到 ±5 秒，观感是「倍速播完还顺带跳了一段」。
   *   - 还没到 350ms → 这次按下就是一次普通快退/快进。
   */
  useEffect(() => {
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return;
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;
      if (currentView !== 'player') return;
      if (isLocked) return;
      // release() 同时收掉长按定时器并恢复倍速，并告诉你这次按下的归属：
      // 已经用在加速上就不再跳转，未到阈值则是一次普通快退/快进。
      if (endKeyBoost()) seekRelative(e.code === 'ArrowLeft' ? -5 : 5);
    };
    window.addEventListener('keyup', handleKeyUp);
    return () => window.removeEventListener('keyup', handleKeyUp);
  }, [seekRelative, currentView, isLocked, endKeyBoost]);

  // 窗口失焦（切到别的程序）时收掉临时倍速：keyup 收不到，倍速会永久留在 3×。
  useEffect(() => {
    window.addEventListener('blur', cancelLongPressBoost);
    return () => window.removeEventListener('blur', cancelLongPressBoost);
  }, [cancelLongPressBoost]);

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

      {/*
        长按加速提示：按住方向键进入加速时出现，松开即消失。
        必须给出**真实速率**（基准 × 倍数、被上限截断后的值），而不是倍数本身——
        用户在 2x 基准下长按看到的是 4x，写死"3x"会与他的实际观感对不上。
      */}
      {boostRate !== null && (
        <div className="absolute top-6 inset-x-0 z-40 pointer-events-none flex justify-center">
          <div className="ttv-boost-toast" role="status" aria-live="polite">
            <FastForward className="w-4 h-4" aria-hidden />
            <span>{boostRate}x 加速播放</span>
            <span className="ttv-boost-toast-hint">松开恢复</span>
          </div>
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
        卡死提示：复用下方"正在切换"那张晶体卡片的样式与容器（不再造一个 toast
        系统）。刻意挂在顶部而不是底部——卡死时 uiState 往往同时是 buffering，
        底部的切换提示已经占着那个位置，两张卡叠在一起会互相盖住。

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
                    : '该媒体无法由 WebView 解码，已尝试备用源与兼容 Blob 播放。'}
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
        effectivePlaybackRate={boostRate}
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
