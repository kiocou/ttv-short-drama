/**
 * 播放到“已缓冲末端”的判定。
 *
 * 为什么不能只看“离总时长不到 1.5 秒”：用户在这段时间里切换倍速、seek
 * 或解码器短暂抖动都会派发 `waiting`，此时数据其实已经完整缓冲；把它当成
 * 播完会让界面进入 ended、播放键与实际 paused 状态脱钩，按一次反而先暂停。
 *
 * 真正的“最后一小段没落地”必须同时满足：
 *   - 已经接近总时长；
 *   - 缓冲末端还没有到总时长；
 *   - 播放头已经追上缓冲末端（前面没有可继续播的数据）。
 */

const NEAR_END_TOLERANCE_SECONDS = 1.5;
const BUFFERED_END_TOLERANCE_SECONDS = 0.15;
const PLAYHEAD_AT_BUFFER_END_TOLERANCE_SECONDS = 0.1;

export interface TailWaitSnapshot {
  currentTime: number;
  duration: number;
  bufferedEnd: number;
  paused: boolean;
  seeking: boolean;
}

export function shouldFinishAtBufferedTail(snapshot: TailWaitSnapshot): boolean {
  const { currentTime, duration, bufferedEnd, paused, seeking } = snapshot;
  if (paused || seeking) return false;
  if (!Number.isFinite(duration) || duration <= 0) return false;
  if (!Number.isFinite(currentTime) || currentTime < duration - NEAR_END_TOLERANCE_SECONDS) return false;
  if (!Number.isFinite(bufferedEnd) || bufferedEnd <= 0) return false;
  if (bufferedEnd >= duration - BUFFERED_END_TOLERANCE_SECONDS) return false;
  return currentTime >= bufferedEnd - PLAYHEAD_AT_BUFFER_END_TOLERANCE_SECONDS;
}
