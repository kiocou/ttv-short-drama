/**
 * 「按住方向键临时加速」的状态机 + 加速档位。
 *
 * 为什么单独抽一个文件：这件事**没法靠肉眼验证**。阈值、松手的归属
 * （这一次按下算加速还是算快退/快进）、档位与恢复目标三件事叠在一起，只把时间与
 * 媒体元素都做成可注入的依赖，才能写出一组确定性的用例（`scripts/verify-boost.mjs`，
 * 假时钟 + 假 video，不依赖真实定时器）。
 *
 * 语义约定（五条互相牵制，改任意一条都必须重跑那组用例）：
 *   1. 按住达到 `holdMs` 且**当时确实在播**才进入加速；不到阈值就松手 = 一次普通快退/快进。
 *   2. 加速一旦生效，本次按下就**只属于加速**：松手只恢复倍速，不再跳转。
 *      否则用户会先看到画面加速播一段，松手瞬间又被弹到 ±5 秒处。
 *   3. 每次长按都从 `DEFAULT_BOOST_LEVEL`（智能）起步，加速期间可用 ↑ / ↓ 换档。
 *      不记住上一次的档位是有意的：长按是"临时快一下"，起点固定才可预期。
 *   4. 实际速率取「档位速率」与「基准倍速」中的**较大者**。基准已经是 3x 时，
 *      切到 1.5x 档不该把画面**降**速——"加速"这个手势的语义是"比现在更快"。
 *   5. 恢复目标永远是**用户设定的基准倍速**，不是 1。写死 1 会让倍速设定被悄悄改掉。
 *
 * 暂停中长按不加速（没有意义），但松手仍算一次快退/快进——用户是在找位置。
 */

/** 长按判定阈值（毫秒）。低于它的按下仍是一次普通快退/快进。 */
export const BOOST_HOLD_MS = 350;

/**
 * 加速档位。**数组顺序就是滚轮顺序**，且首档是每次长按的起点。
 *
 * 顺序不是随手排的：提示条的上/下邻居由它决定（智能的上方是 3x、下方是 1.5x，
 * 与红果 App 的滚轮一致）。改顺序会直接改变用户看到的手感，不是纯展示细节。
 */
export const BOOST_LEVELS = ['smart', 1.5, 2, 3] as const;
export type BoostLevel = (typeof BOOST_LEVELS)[number];

/** 长按的起点档位。 */
export const DEFAULT_BOOST_LEVEL: BoostLevel = 'smart';

/**
 * 智能档的速率：按**这一集的时长**选，短片更快。
 *
 * 短剧单集普遍 1-3 分钟，用 3x 刷完才是用户长按的意图；而长片（纪录片式的
 * 动漫合集）给 3x 会直接跳过内容，所以随时长降档。
 *
 * 时长不可知（元数据没到、直播流）时给 2x：宁可保守，也不要在用户还没看到
 * 时长时就替他做一个激进的假设。
 */
export function smartBoostRate(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 2;
  if (durationSec <= 10 * 60) return 3;
  if (durationSec <= 30 * 60) return 2;
  return 1.5;
}

/** 档位对应的速率。 */
export function levelRate(level: BoostLevel, durationSec: number): number {
  return level === 'smart' ? smartBoostRate(durationSec) : level;
}

/** 档位在 UI 上的名字（`3X` 这种大写是跟着提示条的形态定的）。 */
export function levelLabel(level: BoostLevel): string {
  return level === 'smart' ? '智能' : `${level}X`;
}

/** 按 step 在档位表里循环（-1 上一档、+1 下一档）。 */
export function cycleBoostLevel(level: BoostLevel, step: number): BoostLevel {
  const length = BOOST_LEVELS.length;
  const index = BOOST_LEVELS.indexOf(level);
  return BOOST_LEVELS[(((index + step) % length) + length) % length];
}

/** 只用到这两个成员，收窄接口以便测试注入假元素。 */
export interface BoostTarget {
  paused: boolean;
  playbackRate: number;
  /** 智能档要按时长选速率；元数据未就绪时是 NaN。 */
  duration?: number;
}

export interface BoostControllerOptions {
  /** 取当前媒体元素；没有（未挂载）时返回 null。 */
  getVideo: () => BoostTarget | null;
  /**
   * 取用户设定的基准倍速（松手后恢复到这个值）。
   *
   * 必须是**取值函数**而不是数值：用户在按住期间改了倍速设定时，恢复目标要跟着变，
   * 而在闭包里捕获一个数值就只能恢复到旧值。
   */
  getBaseRate: () => number;
  /** 长按判定阈值（毫秒）。 */
  holdMs?: number;
  /** 长按的起点档位。默认 `DEFAULT_BOOST_LEVEL`。 */
  defaultLevel?: BoostLevel;
  /**
   * 加速状态或档位变化回调（进入 / 换档 / 退出各一次），供 UI 显示。
   *
   * 带上 `rate` 是因为提示条要显示**真实生效的速率**（含"不低于基准"的修正）；
   * 让调用方自己再算一遍迟早会不一致。
   */
  onChange?: (boosting: boolean, rate: number, level: BoostLevel) => void;
  /** 定时器注入点（测试用假时钟）。 */
  setTimer?: (handler: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
}

export interface BoostController {
  /** 方向键按下（按键重复应由调用方先行过滤）。 */
  press: () => void;
  /** 松开方向键；返回 true 表示这一次按下应被当作普通快退/快进。 */
  release: () => boolean;
  /** 无条件收掉：失焦、Esc、卸载、外层需要强制恢复时调用。 */
  cancel: () => void;
  /** 当前是否处于临时加速（供 UI 或日志使用）。 */
  isBoosting: () => boolean;
  /** 加速期间切换档位（↑ 传 -1、↓ 传 +1）。未加速时无操作。 */
  cycleLevel: (step: number) => void;
  /** 当前档位。 */
  getLevel: () => BoostLevel;
}

export function createBoostController(options: BoostControllerOptions): BoostController {
  const holdMs = options.holdMs ?? BOOST_HOLD_MS;
  const defaultLevel = options.defaultLevel ?? DEFAULT_BOOST_LEVEL;
  const setTimer = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms) as unknown as number);
  const clearTimer = options.clearTimer ?? (id => clearTimeout(id));

  let timer: number | null = null;
  let boosting = false;
  /**
   * 本次按下是否已经用于加速。
   *
   * 不能只看 `boosting`：用户在加速中切换基准倍速时，外层会先 cancel()
   * 收掉加速；如果这时只按 `boosting` 判断，随后 keyup 会把同一次按下
   * 误判成普通快进/快退，画面会突然跳 5 秒。
   */
  let pressConsumed = false;
  let level: BoostLevel = defaultLevel;

  /**
   * 把当前档位写进媒体元素，返回真实生效的速率。
   *
   * 取 max 而不是直接用档位值：基准已经比档位快时（3x 基准 + 1.5x 档），
   * 按档位值写会把画面**降**速。见文件头第 4 条。
   */
  const apply = (): number => {
    const video = options.getVideo();
    const base = options.getBaseRate();
    const target = Math.max(levelRate(level, video?.duration ?? 0), base);
    if (video) video.playbackRate = target;
    return target;
  };

  const cancel = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (boosting) {
      boosting = false;
      const video = options.getVideo();
      if (video) video.playbackRate = options.getBaseRate();
      options.onChange?.(false, options.getBaseRate(), level);
    }
  };

  return {
    press() {
      // 先收上一次：连续按下（自动重复之外的异常、或用户快速换按键）只留一个定时器。
      cancel();
      pressConsumed = false;
      timer = setTimer(() => {
        timer = null;
        const video = options.getVideo();
        // 只在真正播放中加速。暂停时长按没有意义，还容易误触。
        if (!video || video.paused) return;
        boosting = true;
        pressConsumed = true;
        level = defaultLevel;
        options.onChange?.(true, apply(), level);
      }, holdMs);
    },
    release() {
      const shouldSeek = !pressConsumed;
      cancel();
      pressConsumed = false;
      // 加速过 -> 这次按下已经用在加速上，不该再跳转。
      return shouldSeek;
    },
    cancel,
    isBoosting: () => boosting,
    cycleLevel(step) {
      if (!boosting) return;
      level = cycleBoostLevel(level, step);
      options.onChange?.(true, apply(), level);
    },
    getLevel: () => level,
  };
}
