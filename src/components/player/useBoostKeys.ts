import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BOOST_HOLD_MS,
  BOOST_LEVELS,
  createBoostController,
  type BoostController,
  type BoostLevel,
} from '../../services/boostController';

/** 加速期间的展示状态；未加速时为 null。 */
export interface BoostState {
  /** 真实生效的速率（已含"不低于基准倍速"的修正）。 */
  rate: number;
  level: BoostLevel;
  /** 换档方向：-1 向上、+1 向下、0 首次进入。滚轮动画据此决定从哪边滑入。 */
  direction: number;
}

interface UseBoostKeysOptions {
  /** 只有播放器在前台时才响应按键（两个播放器宿主都是常驻 DOM 的）。 */
  enabled: boolean;
  isLocked: boolean;
  /** 取当前媒体元素；未挂载时返回 null。 */
  getVideo: () => HTMLVideoElement | null;
  /** 用户设定的基准倍速（松手后恢复到这个值）。 */
  getBaseRate: () => number;
  /** 未加速时 ← / → 的跳转（加速过的按下不会走到这里）。 */
  seekRelative: (seconds: number) => void;
  /** 未加速时 ↑ / ↓ 的音量步进。 */
  stepVolume: (delta: number) => void;
  /** 用户有操作（用于喂控制条自动隐藏定时器）。 */
  onUserActivity: () => void;
  /**
   * 当前播放会话号。**变化即视为换集**，会强制收掉正在进行的加速。
   *
   * ## 为什么必须有它（2026-10-18 修「长按加速时切下一集，倍速就变回正常」）
   *
   * 换集走的是 store 的 `openEpisode`：它会把 `video.playbackRate` 重新写成
   * **用户基准倍速**（`playbackRateRef.current`），这是对的 —— 新一集不该继承
   * 上一集的临时加速。
   *
   * 但加速控制器**不知道这件事**：它的 `boosting` 仍是 true、`onChange` 仍挂着
   * 提示条。于是：
   *   1. 换集瞬间画面回到基准倍速（看起来"恢复正常定速"）；
   *   2. 用户松手时 `release()` → `cancel()` 又写一次基准倍速（无害，但白写）；
   *   3. 更糟的是**如果用户没松手**（比如按着 → 触发连播跳集），提示条会一直
   *      挂在画面上，而倍速其实早就是基准值 —— 提示与实际状态脱钩。
   *
   * 传会话号进来，让换集成为一个明确的"结束加速"事件，三处状态一次对齐。
   */
  sessionId: number;
}

/**
 * 「按住 ← / → 临时加速，加速中 ↑ / ↓ 换档」的按键接线。
 *
 * 短剧与动漫两个播放器**共用这一份**：状态机在 `services/boostController`，这里只
 * 负责把 window 上的键盘事件接上去、并把展示状态交出去。此前只有短剧接了这套键位，
 * 动漫按 ← / → 永远只是跳转——同一款播放器两种手感，正是要消灭的那种不一致。
 *
 * 为什么把 ↑ / ↓ 做成**双语义**：非加速时它们调音量（既有行为，不能抢），
 * 加速期间才让位给换档。两个语义不会同时生效，所以不冲突。
 */
export function useBoostKeys({
  enabled,
  isLocked,
  getVideo,
  getBaseRate,
  seekRelative,
  stepVolume,
  onUserActivity,
  sessionId,
}: UseBoostKeysOptions): BoostState | null {
  const [boost, setBoost] = useState<BoostState | null>(null);

  // 回调与状态一律走 ref：它们变化（音量、倍速、跳转函数）不该重建控制器——
  // 重建会连带丢掉正在计时的长按定时器。
  const getVideoRef = useRef(getVideo);
  getVideoRef.current = getVideo;
  const getBaseRateRef = useRef(getBaseRate);
  getBaseRateRef.current = getBaseRate;
  const seekRef = useRef(seekRelative);
  seekRef.current = seekRelative;
  const volumeRef = useRef(stepVolume);
  volumeRef.current = stepVolume;
  const activityRef = useRef(onUserActivity);
  activityRef.current = onUserActivity;

  const controllerRef = useRef<BoostController | null>(null);
  if (controllerRef.current === null) {
    // 上一次的档位序号：只用来判断换档方向（滚轮该从哪边滑进来）。
    let lastIndex = -1;
    controllerRef.current = createBoostController({
      getVideo: () => getVideoRef.current(),
      getBaseRate: () => getBaseRateRef.current(),
      holdMs: BOOST_HOLD_MS,
      onChange: (boosting, rate, level) => {
        if (!boosting) {
          lastIndex = -1;
          setBoost(null);
          return;
        }
        const index = BOOST_LEVELS.indexOf(level);
        // 换档方向要按**环形**算：从末档按 ↑ 回到首档时，序号差是 +3 而不是 -1，
        // 直接用差值会让滚轮朝反方向滑进来。
        let direction = 0;
        if (lastIndex >= 0) {
          const count = BOOST_LEVELS.length;
          direction = index - lastIndex;
          if (direction > count / 2) direction -= count;
          else if (direction < -count / 2) direction += count;
        }
        lastIndex = index;
        setBoost({ rate, level, direction });
      },
    });
  }
  const controller = controllerRef.current;

  const cancelBoost = useCallback(() => controller.cancel(), [controller]);

  /**
   * 换集即结束加速。
   *
   * 与 `cancelBoost` 分开写而不是复用同一个 effect：这个 effect 只在**会话号变化**
   * 时跑，不在挂载时跑（挂载时没必要，`boosting` 本来就是 false）。
   *
   * 用 ref 记住上一次的会话号而不是把 `sessionId` 直接进依赖后无条件 cancel：
   * 后者会在每次 render 都调一次 `cancel()`，而 `cancel()` 在未加速时是空操作、
   * 加速时会**立刻降速** —— 用户长按期间任何一次无关的重渲染都会打断加速。
   */
  const lastSessionRef = useRef(sessionId);
  useEffect(() => {
    if (lastSessionRef.current === sessionId) return;
    lastSessionRef.current = sessionId;
    cancelBoost();
  }, [sessionId, cancelBoost]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (!enabled || isLocked) return;
      // 系统的按键重复每秒会再发十几条 keydown：不挡掉的话长按定时器会被不停重置，
      // 永远到不了阈值；换档也会一次按住连跳好几档。
      if (event.repeat) return;

      switch (event.code) {
        case 'ArrowLeft':
        case 'ArrowRight':
          event.preventDefault();
          activityRef.current();
          // 按住到阈值 → 进入加速；不到阈值就松手 → 一次普通快退/快进。
          // 两者共用同一次按下，所以加速起效后由 keyup 吞掉这次跳转。
          controller.press();
          break;
        case 'ArrowUp':
        case 'ArrowDown': {
          event.preventDefault();
          activityRef.current();
          const step = event.code === 'ArrowUp' ? -1 : 1;
          // 加速中换档，否则维持音量调节。
          if (controller.isBoosting()) controller.cycleLevel(step);
          else volumeRef.current(step === -1 ? 0.1 : -0.1);
          break;
        }
        case 'Escape':
          // 方向键卡在按住状态又按了 Esc 时，避免倍速留在加速值上。
          controller.cancel();
          break;
        default:
          break;
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'ArrowLeft' && event.code !== 'ArrowRight') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (!enabled || isLocked) return;
      // release() 同时收掉长按定时器并恢复倍速，并告诉你这次按下的归属：
      // 已经用在加速上就不再跳转，未到阈值则是一次普通快退/快进。
      if (controller.release()) seekRef.current(event.code === 'ArrowLeft' ? -5 : 5);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    // 窗口失焦（切到别的程序）时收掉临时倍速：keyup 收不到，倍速会永久留在加速值上。
    window.addEventListener('blur', cancelBoost);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', cancelBoost);
      // 卸载时必须收掉：留着会有一个悬空定时器在播放器已经销毁后改 playbackRate。
      cancelBoost();
    };
  }, [controller, cancelBoost, enabled, isLocked]);

  return boost;
}
