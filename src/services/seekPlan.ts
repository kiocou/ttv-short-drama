/**
 * 「用户点了进度条的某个位置」之后，到底该怎么落位。
 *
 * ## 用户报的现象（2026-10-24）
 *
 * 「点击播放器任意位置（比如点击结尾），它会跳转到转码后的最后位置，
 *   而不是跳到点击的对应位置。」
 *
 * ## 根因：进度条的时间基 与 元素的可寻址范围 是两套时间基
 *
 * 进度条显示的 `duration` 是**源片真实时长**（后端下发的权威值，比如 93 秒）。
 * 而播放源是「边转边播」的整集 HLS：清单里此刻只有已经切好的分片，于是
 * `video.seekable.end()` 只到已转位置（比如 20 秒）。
 *
 * MSE 规范要求 seek 目标落在**可寻址范围**内，超出时浏览器把 `currentTime`
 * 夹到范围末端。所以"点结尾"在浏览器看来等于"点 20 秒"。
 *
 * 旧实现为了对付这件事，在超出范围时做了两件都不对的事：
 *
 *   1. 把播放头推到 `seekable.end - 0.05` —— 这就是用户看到的"跳到转码后的
 *      最后位置"。**它把一个"还没转好"的等待，表现成了一个"跳错位置"的错误。**
 *   2. 8 秒后超时，又把播放头推到当时的 `end` —— 于是同一个错误再犯一次，
 *      而且这次是永久的（用户以为已经落位了）。
 *
 * ## 正确语义
 *
 * 用户点哪儿就该落在哪儿。转码没跟上不是用户的错，也不该用"跳到能播的地方"
 * 来假装成功。所以：
 *
 *   - **可寻址范围内**：直接落位（这是绝大多数情况，也是唯一"立即成功"的路径）。
 *   - **超出范围**：进入等待，**播放头留在原处不动**（画面继续播，或暂停在
 *     用户按下的那一刻），等转码推进到目标再落位。期间界面显示目标位置，
 *     让用户知道"你要的位置我记着"。
 *   - **等到超时**：如实告诉用户"这一段还没转好"，并**停在原处**——绝不跳到
 *     末端冒充成功。用户可以再点一次（转码是 13~29 倍实时，通常早就不止了）。
 *
 * ## 为什么抽成纯函数
 *
 * 三个播放面（主播放器、动漫播放器、画中画小窗）都要做同一件事，而它们此前
 * 各写各的：主播放器有等待逻辑、小窗与动漫直接赋值（超出范围就静默夹取）。
 * 抽出来才能被 `verify:seek` 钉住，也才能让三处真正同构。
 */

/**
 * 目标位置落在可寻址范围内时，允许的容差（秒）。
 *
 * `seekable.end` 与用户落点之间本就有几十毫秒误差（分片边界、MSE 时间基），
 * 卡死在等号上会让每次正常拖动都触发一次等待。
 */
export const SEEK_SEEKABLE_TOLERANCE_SECONDS = 0.5;

/**
 * 落位时与转码边界之间必须保留的余量（秒）。
 *
 * ## 为什么需要它（2026-10-27 修「点了进度条，画面反复重播三四次」）
 *
 * 转码没结束时，`seekable.end` 就是"ffmpeg 刚写完的那一片的末尾"。如果落位点
 * 贴着这个边界（旧实现允许 `target <= seekableEnd + 0.5`），会出现：
 *
 *   1. `video.currentTime = target` 成功，播放器开始拉目标分片；
 *   2. 但那一片**此刻正在被写**，本地服务只能返 503（见 `media_enhance` 里
 *      "分片还没落盘"那段），hls.js 于是反复重试；
 *   3. 重试期间 `waiting` / `canplay` / `playing` 反复触发，用户看到的就是
 *      "画面反复播了三四次"，最后停在转码推进后的某个位置。
 *
 * 实测日志（ttv-playback.log，2026-10-27）：
 *
 *   转码已推进到 124.9s，落位到 111.4s
 *   媒体 waiting → canplay → playing   ← 循环 3 次
 *   媒体 waiting → canplay → playing
 *   媒体 waiting → canplay → playing
 *   timeupdate 心跳 位置=121.52s        ← 最终停在 121.52 而不是 111.4
 *
 * 留出一片（源分片实测 1.6~3.2 秒）的余量，落位后目标后面至少还有已写好的
 * 内容，hls.js 不需要为"边界那一片"重试。
 *
 * 取值 4 秒：覆盖最长的分片（3.2 秒）再留一点。代价是"点最后 4 秒会等转码"，
 * 而转码现在 5~6 秒就完成全集，这个等待比"画面反复重播"划算得多。
 */
export const SEEK_SEGMENT_SAFETY_SECONDS = 4;

/**
 * 转码是否已完成。
 *
 * 判据是 `seekable.end` 已经追上总时长 —— 此时清单带 `#EXT-X-ENDLIST`，
 * 可寻址范围就是全片，**不能**再扣安全余量，否则点片尾最后几秒会永远等不到。
 */
function transcodeFinished(seekableEnd: number, duration: number): boolean {
  // ⚠️ 总时长未知时**不扣余量**：调用方没给 duration，就无从判断"转码是否还在跑"，
  // 此时保持旧的宽松语义（目标落在可寻址范围内即落位）。否则所有不传 duration 的
  // 调用方都会凭空多等 4 秒，那是行为回退而不是修复。
  if (!(duration > 0)) return true;
  return seekableEnd >= duration - SEEK_SEGMENT_SAFETY_SECONDS;
}

export interface SeekTargetInput {
  /** 用户点/拖到的位置（秒）。 */
  requested: number;
  /** 展示用的总时长（权威值，秒）。`0` / 非有限值表示未知。 */
  duration: number;
  /** 元素当前的可寻址末端（秒）。`0` 表示读不到。 */
  seekableEnd: number;
}

export type SeekPlan =
  | {
      /**
       * 立即落位。
       *
       * `target` 已经过 `[0, duration]` 夹取 —— 用户点在进度条最右边之外
       * （pointer 滑出轨道）时不该得到超过时长的位置。
       */
      kind: 'immediate';
      target: number;
    }
  | {
      /**
       * 目标超出可寻址范围：等转码推进。
       *
       * `target` 是用户真正想要的位置，**不是** `seekableEnd`。调用方必须
       * 原样记住它、在转码追上时落位，绝不能改成"先跳到末端"。
       */
      kind: 'wait';
      target: number;
      /** 此刻的可寻址末端，只用于打点与展示进度，不参与落位。 */
      seekableEnd: number;
    };

/**
 * 算出这次点击该怎么落位。
 *
 * 判据只有两条，顺序不能换：
 *   1. 先把目标夹进 `[0, duration]`（用户可能点到轨道外）；
 *   2. 再比较它与可寻址末端 —— 在范围内就立即落位，否则进入等待。
 *
 * `seekableEnd <= 0`（读不到）时按"立即落位"处理：那种情况多见于普通文件源
 * （`seekable` 尚未就绪但赋值不会失败），交给浏览器自己夹取比凭空进入等待好。
 */
export function planSeek(input: SeekTargetInput): SeekPlan {
  const raw = Number.isFinite(input.requested) && input.requested > 0 ? input.requested : 0;
  const duration = Number.isFinite(input.duration) && input.duration > 0 ? input.duration : 0;
  const target = duration > 0 ? Math.min(raw, duration) : raw;

  const seekableEnd =
    Number.isFinite(input.seekableEnd) && input.seekableEnd > 0 ? input.seekableEnd : 0;

  // 读不到可寻址范围：没有"超出"这回事，直接交给浏览器。
  if (seekableEnd <= 0) {
    return { kind: 'immediate', target };
  }
  // ⚠️ 2026-10-27 回退「扣一片安全余量」的做法。
  //
  // 那个余量当初是为了避免落位踩在"正在写的分片"上。但它把**可落位边界整体
  // 往前挪了 4 秒**，用户点在自己明明看得见已经转好的位置时，会被判成"未转码"
  // 而进入等待 —— 表现就是"点了进度条不跳"。日志实证：
  //
  //   拖动到未转码区域 目标=41.7s 可寻址末端=40.0s
  //   拖动到未转码区域 目标=18.4s 可寻址末端=3.2s   ← 用户认为这些位置已转好
  //
  // 边界就该以 `seekable.end` 为准：它本来就是"浏览器认为可以 seek 到哪里"。
  // 踩到正在写的分片时，本地服务会返 503、hls.js 自己重试，那是可恢复的；
  // 而"点了完全不响应"是不可接受的。
  if (target <= seekableEnd + SEEK_SEEKABLE_TOLERANCE_SECONDS) {
    return { kind: 'immediate', target };
  }
  return { kind: 'wait', target, seekableEnd };
}

/**
 * 等待转码推进时，每一拍是否已经可以落位。
 *
 * 容差与 `planSeek` 同源：`seekable.end` 是分片边界，比目标少几十毫秒是常态，
 * 要求严格 `>=` 会让最后一片永远等不到。
 */
export function seekableReached(
  seekableEnd: number,
  target: number,
  duration = 0,
): boolean {
  if (!Number.isFinite(seekableEnd) || seekableEnd <= 0) return false;
  if (!Number.isFinite(target)) return false;
  // 与 `planSeek` 同一套判据（不再扣安全余量，理由见那里的注释）。
  return seekableEnd >= target - SEEK_SEEKABLE_TOLERANCE_SECONDS;
}
