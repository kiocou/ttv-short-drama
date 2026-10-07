/**
 * 「按住方向键临时加速」的状态机。
 *
 * 为什么单独抽一个文件：这件事**没法靠肉眼验证**。阈值、松手的归属
 * （这一次按下算加速还是算快退/快进）、恢复目标三件事叠在一起，只把时间与媒体
 * 元素都做成可注入的依赖，才能写出一组确定性的用例（`scripts/verify-boost.mjs`，
 * 假时钟 + 假 video，不依赖真实定时器）。
 *
 * 语义约定（四条互相牵制，改任意一条都必须重跑那组用例）：
 *   1. 按住达到 `holdMs` 且**当时确实在播**才进入加速；不到阈值就松手 = 一次普通快退/快进。
 *   2. 加速一旦生效，本次按下就**只属于加速**：松手只恢复倍速，不再跳转。
 *      否则用户会先看到画面加速播一段，松手瞬间又被弹到 ±5 秒处。
 *   3. 加速速率是**固定的 `BOOST_RATE`（2x）**，与用户当前所选档位无关。
 *      曾经的实现是「所选档位 × 3、上限 4x」，那是错的：用户在 0.5x 档只是想慢看，
 *      长按却把他送到 1.5x；在 2x 档长按又只多出 2 倍，同一手势在不同档位下
 *      效果差好几倍，完全不可预期。固定值才是「临时快进一下」该有的手感。
 *   3b. 但基准速率**已经达到或超过 `BOOST_RATE` 时不做任何事**。
 *      控制栏里有 3x 档，而长按只到 2x —— 不加这条，3x 用户长按会"加速"到 2x，
 *      也就是**减速**，而且画面还会弹一个「2x 加速播放」的提示，非常荒谬。
 *      「加速」这个手势的语义是"比现在更快"，达到上限就当它无效。
 *   4. 恢复目标永远是**用户设定的基准倍速**，不是 1。写死 1 会让倍速设定被悄悄改掉。
 *
 * 暂停中长按不加速（没有意义），但松手仍算一次快退/快进——用户是在找位置。
 */

/**
 * 长按方向键时的临时速率。
 *
 * **唯一来源**：VideoSurface（执行加速）与 PlayerHud（菜单里那行提示）都从这里 import。
 * 两边各写一个常量迟早会漂移——上一版就是各写了一份「倍数 3 / 上限 4」，
 * 改动时很容易只改一处，而症状是「菜单说 3x、实际加速到 4x」这种没人会去核对的不一致。
 */
export const BOOST_RATE = 2;

/** 长按判定阈值（毫秒）。低于它的按下仍是一次普通快退/快进。 */
export const BOOST_HOLD_MS = 350;

/** 只用到这两个成员，收窄接口以便测试注入假元素。 */
export interface BoostTarget {
  paused: boolean;
  playbackRate: number;
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
  /** 长按期间的固定速率。默认取本模块的 `BOOST_RATE`。 */
  rate?: number;
  /**
   * 加速状态变化回调（进入 / 退出各一次），供 UI 显示与隐藏加速提示。
   *
   * 带上 `rate` 是因为提示要显示实际生效的速率；让调用方自己再算一遍迟早会不一致。
   */
  onChange?: (boosting: boolean, rate: number) => void;
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
}

export function createBoostController(options: BoostControllerOptions): BoostController {
  const holdMs = options.holdMs ?? BOOST_HOLD_MS;
  const rate = options.rate ?? BOOST_RATE;
  const setTimer = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms) as unknown as number);
  const clearTimer = options.clearTimer ?? (id => clearTimeout(id));

  let timer: number | null = null;
  let boosting = false;

  const cancel = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (boosting) {
      boosting = false;
      const video = options.getVideo();
      if (video) video.playbackRate = options.getBaseRate();
      options.onChange?.(false, options.getBaseRate());
    }
  };

  return {
    press() {
      // 先收上一次：连续按下（自动重复之外的异常、或用户快速换按键）只留一个定时器。
      cancel();
      timer = setTimer(() => {
        timer = null;
        const video = options.getVideo();
        // 只在真正播放中加速。暂停时长按没有意义，还容易误触。
        if (!video || video.paused) return;
        // 基准已达上限（3x 档）：长按不该把它**降**到 2x。见文件头 3b。
        if (options.getBaseRate() >= rate) return;
        boosting = true;
        video.playbackRate = rate;
        options.onChange?.(true, rate);
      }, holdMs);
    },
    release() {
      const wasBoosting = boosting;
      cancel();
      // 加速过 -> 这次按下已经用在加速上，不该再跳转。
      return !wasBoosting;
    },
    cancel,
    isBoosting: () => boosting,
  };
}
