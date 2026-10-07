/**
 * 「按住方向键临时加速」的状态机。
 *
 * 为什么单独抽一个文件：这件事**没法靠肉眼验证**。阈值、松手的归属
 * （这一次按下算加速还是算快退/快进）、恢复目标（用户倍速还是 1x）三件事
 * 叠在一起，只把时间与媒体元素都做成可注入的依赖，才能写出一组确定性的用例
 * （`scripts/verify-boost.mjs`，假时钟 + 假 video，不依赖真实定时器）。
 *
 * 语义约定（四条互相牵制，改任意一条都必须重跑那组用例）：
 *   1. 按住达到 `holdMs` 且**当时确实在播**才进入加速；不到阈值就松手 = 一次普通快退/快进。
 *   2. 加速一旦生效，本次按下就**只属于加速**：松手只恢复倍速，不再跳转。
 *      否则用户会先看到画面加速播一段，松手瞬间又被弹到 ±5 秒处。
 *   3. 加速速率 = **用户当前倍速 × `multiplier`**，而不是写死的 3x。
 *      用户在控制栏把倍速调到 1.5x 之后，长按应当得到 4.5x —— 加速是
 *      「在你自己选的速度上再快一点」，与用户设定无关的固定值会让人以为
 *      「长按会把我设的倍速重置掉」。结果按 `maxRate` 封顶。
 *   4. 恢复目标永远是**用户设定的基准倍速**，不是 1。写死 1 会让倍速设定被悄悄改掉。
 *
 * 暂停中长按不加速（没有意义），但松手仍算一次快退/快进——用户是在找位置。
 */

/** 只用到这两个成员，收窄接口以便测试注入假元素。 */
export interface BoostTarget {
  paused: boolean;
  playbackRate: number;
}

export interface BoostControllerOptions {
  /** 取当前媒体元素；没有（未挂载）时返回 null。 */
  getVideo: () => BoostTarget | null;
  /**
   * 取用户设定的基准倍速。
   *
   * 必须是**取值函数**而不是数值：用户在按住期间改了倍速设定时，恢复目标要跟着变，
   * 而在闭包里捕获一个数值就只能恢复到旧值。
   */
  getBaseRate: () => number;
  /** 长按判定阈值（毫秒）。 */
  holdMs?: number;
  /** 加速倍数：实际速率 = 基准倍速 × 该值。默认 3。 */
  multiplier?: number;
  /** 速率上限，防止 2x 基准 × 3 得到 6x 这类离谱值。默认 4。 */
  maxRate?: number;
  /**
   * 加速状态变化回调（进入 / 退出各一次），供 UI 显示与隐藏加速提示。
   *
   * 带上 `rate` 是因为提示要显示**真实生效的速率**（基准 × 倍数、并可能被上限截断），
   * 让调用方自己再算一遍迟早会与这里不一致。
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
  const holdMs = options.holdMs ?? 350;
  const multiplier = options.multiplier ?? 3;
  const maxRate = options.maxRate ?? 4;
  const setTimer = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms) as unknown as number);
  const clearTimer = options.clearTimer ?? (id => clearTimeout(id));

  let timer: number | null = null;
  let boosting = false;

  /** 实际生效的加速速率：基准 × 倍数，并按上限截断。 */
  const boostRate = () => Math.min(maxRate, options.getBaseRate() * multiplier);

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
        const rate = boostRate();
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
