/**
 * 播放到"可播末端"的判定。
 *
 * ## 为什么这里必须分成"位置判定"与"时间维度确认"两件事
 *
 * 用户报的症状：**一集播到最后 1~2 秒会卡住一直转圈，不自动进下一集，
 * 只有手动点"下一集"才恢复**（2026-10-19 复现，`ttv-playback.log` 里
 * `媒体 waiting` 之后紧跟 `hls.js 错误 details=bufferStalledError`）。
 *
 * 播放源是边转边播的整集 HLS。末尾停住有两种形态，**都不能靠单帧快照判**：
 *
 *   A. 最后一片还没落地：`buffered.end` 比总时长少 0~2 秒，播放头追上缓冲末端；
 *   B. 末段已经全部进缓冲，但播放头再也走不到 `duration`：
 *      容器时长（`#EXTINF` 累加）与末帧 PTS 差几十毫秒，Chromium 不会派发
 *      `ended`（`ended` 要求播放位置真正到达时长末尾）。
 *
 * 旧实现（0.2.20）用一条 `bufferedEnd >= duration - 0.15 → return false`
 * 把形态 B 排除掉了，本意是"数据都完整缓冲了，那只是倍速/解码抖动的瞬时
 * waiting，不能当播完"。但实测该分支恰好把唯一的出口堵死：
 *
 *   * worker 上报的源片时长与 ffmpeg 产物时长只差 **0.00~0.07 秒**
 *     （逐集核对 120 集：diff 中位数 0.00s，最大 0.07s）；
 *   * 也就是说 `buffered.end` 几乎必然落在 `duration - 0.15` 之内；
 *   * 于是形态 B 一发生，判定恒为 false，`waiting` 之后只剩 `buffering`
 *     一条路 —— 看门狗 10 秒后把它当"卡死"：原地 seek（那里本来没下一帧）
 *     → 2 秒后重装载同一集 → 播到同一位置再卡一次。
 *
 * 所以单帧快照只回答"播放头是不是已经停在可播末端"，**是否真的播完必须由
 * 调用方再补一个时间维度**（这 1 秒里时钟有没有推进、缓冲有没有增长）。
 * `usePlaybackStore` 的 `handleWaiting` 用 1.2 秒复核做这件事，看门狗用
 * 它自己的三信号停滞计时兜底。
 */

/** 播放头进入"末尾区域"的窗口。用户实测卡住位置是最后 1~2 秒。 */
const NEAR_END_TOLERANCE_SECONDS = 2.5;

/** 播放头贴住可播末端的容差（MSE 的时间基与容器时长本就有几十毫秒误差）。 */
const PLAYHEAD_AT_TAIL_TOLERANCE_SECONDS = 0.3;

/**
 * 缓冲末端可以落后播放头多少秒，仍算"播放头贴住缓冲末端"。
 *
 * 与上面那个容差分开，是因为两者语义不同：上面那个容忍"播放头略微超前"，
 * 这个容忍"缓冲略微落后"。都取 0.3 秒——正常停住时两者差在几十毫秒内，
 * 而缓冲被清空 / 驱逐后差的是整段视频长度，判据要能一刀切开这两种情况。
 */
const TAIL_BUFFER_GAP_TOLERANCE_SECONDS = 0.3;

export interface TailSnapshot {
  currentTime: number;
  duration: number;
  bufferedEnd: number;
  paused: boolean;
  seeking: boolean;
  /** 已经派发过 `ended`：不再需要任何"补判播完"。 */
  ended?: boolean;
  /**
   * 当前播放速率（`video.playbackRate`）。缺省按 1 处理。
   *
   * ## 为什么末尾判定必须知道倍速（2026-10-22 修「长按倍速会误跳下一集」）
   *
   * `nearEndSeconds` 是**媒体时间**，而"用户是否真的快播完了"是**真实时间**的
   * 体感。同一个 2.5 秒窗口在 3x 下只等于 0.83 秒真实时间——播放头一进入这个
   * 区域，任何一次短暂 `waiting`（倍速切换、hls.js 换档重取分片）都会被读成
   * "停在末尾了"，于是误判播完、跳下一集，并把进度按 100% 落盘（进度条直接
   * 跳到结尾）。
   *
   * 按速率放大窗口，等于把判据统一到"真实时间里还剩多久"这个尺度上：
   * 3x 时窗口变成 7.5 秒媒体时间（= 2.5 秒真实时间），与 1x 的体感一致。
   */
  playbackRate?: number;
}

/**
 * 把"末尾窗口"从媒体时间换算成与倍速无关的真实时间尺度。
 *
 * 上限 4 倍：短剧单集 30~200 秒，3x 时窗口 7.5 秒已经覆盖到结尾的 1/4，
 * 再放大就会把"中间某处缓冲"也当成末尾。4 倍是这个判据的安全边界。
 */
function scaleWindowForRate(seconds: number, rate: number | undefined): number {
  if (!Number.isFinite(rate) || !rate || rate <= 1) return seconds;
  return seconds * Math.min(rate, 4);
}

/**
 * 位置判定：播放头是否已经停在"可播末端"。
 *
 * 只看位置，不看时间——同一帧快照无法区分"倍速切换抖一下"与"真的卡死"，
 * 那件事必须交给调用方的时间维度确认。
 *
 * `nearEndSeconds` 允许调用方放宽窗口：看门狗已经在"时钟/帧/缓冲三信号都停滞"
 * 上等了 10 秒，那时把窗口放宽到 5 秒是安全的（确实没有数据再进来了）。
 * 传入的窗口同样会按 `playbackRate` 缩放。
 */
export function isPlayheadAtPlayableTail(
  snapshot: TailSnapshot,
  nearEndSeconds: number = NEAR_END_TOLERANCE_SECONDS,
): boolean {
  const { currentTime, duration, bufferedEnd, paused, seeking, ended, playbackRate } = snapshot;
  if (ended === true) return false;
  if (paused || seeking) return false;
  if (!Number.isFinite(duration) || duration <= 0) return false;
  if (!Number.isFinite(currentTime) || currentTime < 0) return false;
  // 1) 已进入末尾区域。窗口按倍速放大，理由见 `TailSnapshot.playbackRate`。
  const effectiveWindow = scaleWindowForRate(nearEndSeconds, playbackRate);
  if (currentTime < duration - effectiveWindow) return false;
  if (!Number.isFinite(bufferedEnd) || bufferedEnd <= 0) {
    // 没有缓冲信息时无法判断"贴住末端"，单帧快照下按未命中的保守处理。
    return false;
  }
  // 2) 没有可继续解码的数据：播放头追上缓冲末端，或缓冲本身已经覆盖到总时长。
  //
  // 第二条是形态 B 的关键：末段全部进缓冲时 `buffered.end ≈ duration`，
  // 播放头却可能还差 1~2 秒走不到 —— 这正是要判成"该结束了"的那种停住。
  //
  // ⚠️ 第一条必须**双向**约束（2026-10-20 复查修正）。
  //
  // 只写 `currentTime >= bufferedEnd - TOL`，等于把"播放头在缓冲**之前**"也算成
  // 命中：缓冲被 `recoverMediaError()` 清空、或被 MSE 驱逐之后 `bufferedEnd`
  // 会退到 0.x 秒，而播放头还停在末尾 —— `97.6 >= 0.05 - 0.3` 为真。
  // 那时真实状态是"末段数据没了、得等它重新进来"，判成播完就会提前跳集，
  // 并把这一集按 100% 写进历史（看过的集会被续播入口跳过）。
  //
  // 所以补一条"缓冲末端离播放头不能太远"：正常播到末尾停住时两者几乎相等，
  // 而缓冲被清空时差着整段时长，一眼可分。
  const bufferReachesPlayhead =
    currentTime >= bufferedEnd - PLAYHEAD_AT_TAIL_TOLERANCE_SECONDS &&
    bufferedEnd >= currentTime - TAIL_BUFFER_GAP_TOLERANCE_SECONDS;
  const bufferCoversEnd = bufferedEnd >= duration - PLAYHEAD_AT_TAIL_TOLERANCE_SECONDS;
  return bufferReachesPlayhead || bufferCoversEnd;
}

/**
 * 数据是否已经**全部到齐**——到齐了就没什么可等的，可以立刻判播完。
 *
 * ## 为什么需要这个更严的判据（2026-10-23 修「每集末尾卡一下」）
 *
 * `isPlayheadAtPlayableTail` 回答的是"播放头是不是停在可播末端"，它把两种
 * 情况都算命中：
 *
 *   A. 播放头追上了缓冲末端，但**后面还有分片没落地**（真该等一等）；
 *   B. 缓冲已经覆盖到整集末尾，**不可能再有新数据**（等的意义为零）。
 *
 * 调用方（`handleWaiting`）此前不区分两者，一律预约 1.2 秒复核。实机日志里
 * 5 次末尾停滞**全部是情况 B**：
 *
 *   current=43.19 duration=43.24 buffered=43.26
 *   current=62.39 duration=62.44 buffered=62.46
 *   current=46.41 duration=46.44 buffered=46.46
 *   current=44.63 duration=44.84 buffered=44.86   ← 3x 倍速
 *
 * 每一行的 `buffered` 都 ≥ `duration`（甚至略超，是 MSE 时间基的正常误差）。
 * 这种情况下 1.2 秒的等待是纯延迟：用户看到的是"这集明明播完了，画面却停在
 * 最后一帧不动，过了 1 秒多才切下一集"——就是他说的"看见之后还会卡一下"。
 *
 * ## 为什么这个判据是安全的
 *
 * 情况 A 里 `buffered` 明显小于 `duration`（还差一整个分片的长度，实测
 * 1~3 秒），不会命中。而"缓冲被 `recoverMediaError()` 清空"那种假象，
 * `buffered` 会退到 0.x 秒，更不会命中。
 *
 * 判据要求 `bufferedEnd >= duration`：不是"差一点点也算"，而是**真的到顶了**。
 * 上面 5 个样本全部满足，且都有 0.02~0.04 秒的余量。
 */
export function isBufferComplete(snapshot: TailSnapshot): boolean {
  const { duration, bufferedEnd, paused, seeking, ended } = snapshot;
  if (ended === true) return false;
  if (paused || seeking) return false;
  if (!Number.isFinite(duration) || duration <= 0) return false;
  if (!Number.isFinite(bufferedEnd) || bufferedEnd <= 0) return false;
  // 缓冲覆盖到整集末尾（容许 MSE 时间基的几十毫秒误差）。
  return bufferedEnd >= duration - PLAYHEAD_AT_TAIL_TOLERANCE_SECONDS;
}

/**
 * 旧名兼容：位置判定。
 *
 * ⚠️ 返回值含义已从"确认播完"降级为"停在可播末端"。调用方**必须**再补一次
 * 时间维度确认（见文件头）；直接把它当 `ended` 用会把倍速切换的瞬时 `waiting`
 * 误判成播完，那正是 0.2.20 修过的回归。
 *
 * 当前仓库内已无调用点（短剧侧与用例都直接用 `isPlayheadAtPlayableTail`）。
 * 保留只为不打断外部引用；下一个主版本删除。
 *
 * @deprecated 直接用 `isPlayheadAtPlayableTail`，语义更明确。
 */
export function shouldFinishAtBufferedTail(snapshot: TailSnapshot): boolean {
  return isPlayheadAtPlayableTail(snapshot);
}
