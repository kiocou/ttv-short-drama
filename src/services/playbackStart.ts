/**
 * 换集时"这一集该从第几秒开始"的判定。
 *
 * ## 为什么需要它（2026-10-24）
 *
 * 用户报告：「画中画里切集，进度条不会重置，而是回到之前的位置继续播，
 * 导致这一集不能完整看完」。
 *
 * 根因有两层，都在**换集不换 `<video>` 元素**这件事上：
 *
 * 1. **hls.js 的起播点默认继承元素残留值。** 它的 `startPosition` 默认是 `-1`，
 *    语义是"拿 `media.currentTime` 当起点"。而 `detachSource` 里
 *    `removeAttribute('src')` 触发的位置归零是**异步**的（媒体加载算法在任务
 *    队列里跑），紧接着同步执行的 `hls.loadSource()` 读到的还是上一集停下的位置。
 *    → 解法：`attachSource` / `attachAnimeSource` 显式接 `startPosition` 参数。
 *
 * 2. **调用方只在 `startPosition > 0` 时才写 `currentTime`。** 换集/下一集传的
 *    恒为 `0`，于是"归位到 0"这一步**根本没执行**。
 *    → 解法：本文件，`0` 也要显式算出一个明确的目标位置。
 *
 * ## 为什么抽成纯函数
 *
 * 这段判定有两处调用（主播放器 `alignPlayhead`、小窗 `playEpisode` + metadata
 * 回调），而且每条分支都对应一次实测过的故障。写在两处必然漂移——第 1 层根因
 * 当初就是"主播放器修了、小窗漏了"。抽出来才能被 `verify:start` 钉住。
 */

/**
 * 播放位置与目标位置的差距超过多少秒才值得记一笔日志。
 *
 * 0.5 秒的依据：换源后浏览器自己会有一个零点几秒的落点调整（关键帧对齐、
 * MSE 时间基），把那些噪声也记下来只会把日志刷满，反而看不见真正的问题。
 */
export const START_DRIFT_LOG_SECONDS = 0.5;

/**
 * 判断"起点是否已经贴着这一集的结尾"，贴着了就该改为从头播。
 *
 * 为什么需要（2026-10-23 实测）：主窗口在 48.07s / 48.1s（**已播完**）时把
 * `position=48` 交给小窗，小窗设 `currentTime=48` 后立刻到结尾 → 触发
 * `handleEnded` → 而那条自动续播分支在窗口刚创建时静默失败 → 画面永远停在
 * 「正在准备画面」。宁可从头播，也不要在结尾卡死。
 *
 * 容差取 1 秒：不同清晰度的时长差、旧交接包里的陈旧位置都会带来零点几秒的偏差，
 * 而"真的快播完了"与"还有内容"之间差的是整段。
 *
 * **边界是闭区间**（`>= duration - 1`）：差正好 1 秒也算"贴着结尾"。选闭区间
 * 而不是开区间，是因为这个判据的代价不对称——多夹一次只是"这一集从头播"（用户
 * 顶多手动拖回去），漏夹一次是"卡在结尾再也出不来"。
 */
export const START_NEAR_END_SECONDS = 1;

export interface StartTargetInput {
  /** 调用方期望的起点（秒）。`0` / 负数 / 非有限值一律按"从头"处理。 */
  startPosition: number;
  /** 目标媒体的总时长（秒）。不可信时传 `0` 或 `NaN`。 */
  duration: number;
  /** 元素上当前的位置（秒），只用于判断"是否需要记日志"。 */
  currentTime?: number;
}

export interface StartTarget {
  /** 最终该写进 `video.currentTime` 的位置（秒，恒为非负有限值）。 */
  target: number;
  /** 起点越界、已改为从头播。调用方据此打点。 */
  clampedFromEnd: boolean;
  /** 元素当前位置与目标的偏差超过 `START_DRIFT_LOG_SECONDS`。 */
  drifted: boolean;
}

/**
 * 算出这一集真正的起播点。
 *
 * 三条规则，顺序不能换：
 *   1. 负数 / 非有限 / 缺省 → 0（"从头"是唯一安全的默认值）；
 *   2. 起点贴着结尾（`>= duration - 1`）→ 0（理由见 `START_NEAR_END_SECONDS`）；
 *   3. 其余照用。
 */
export function resolveStartTarget(input: StartTargetInput): StartTarget {
  const raw = Number.isFinite(input.startPosition) && input.startPosition > 0
    ? input.startPosition
    : 0;
  const duration = input.duration;
  const usableDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;

  const clampedFromEnd = usableDuration > 0 && raw >= usableDuration - START_NEAR_END_SECONDS;
  const target = clampedFromEnd ? 0 : raw;

  const current = Number.isFinite(input.currentTime) ? (input.currentTime as number) : 0;
  const drifted = Math.abs(current - target) > START_DRIFT_LOG_SECONDS;

  return { target, clampedFromEnd, drifted };
}
