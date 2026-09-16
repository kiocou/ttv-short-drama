import React, { useRef } from 'react';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { Play, X } from 'lucide-react';

/** 环形进度周长：2πr，r = 14.5（与 CSS 的 stroke-dasharray 一致）。 */
const RING_CIRCUMFERENCE = 91.1;

/**
 * 下一集自动连播倒计时卡片。
 *
 * 与设计稿的差异：稿子里是"到点才出现"，这里始终保留在 DOM 中、用
 * .is-hidden 控制显隐。原因是淡出与下沉都需要过渡时间，直接卸载元素
 * 就没有动画可言；也避免了每次连播都重新挂载一次 SVG 环形进度。
 */
export const NextCountdown: React.FC = () => {
  const { countdown, acceptCountdown, cancelCountdown } = usePlaybackStore();

  // 记住倒计时起始总秒数：用户可在设置里把等待时间改成 3-15 秒，
  // 硬编码 5 会让圆环进度与秒数严重错位。
  const totalRef = useRef(5);
  if (countdown.active && countdown.remaining > totalRef.current) {
    totalRef.current = countdown.remaining;
  }
  if (!countdown.active) {
    totalRef.current = 5;
  }

  const nextEpisode = countdown.nextEpisode;
  const active = countdown.active && !!nextEpisode;

  const totalSeconds = Math.max(1, totalRef.current);
  const elapsedRatio = Math.max(0, Math.min(1, (totalSeconds - countdown.remaining) / totalSeconds));

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className={`ttv-countdown crystal-surface${active ? '' : ' is-hidden'}`}
      role="status"
      aria-live="polite"
      aria-hidden={!active}
    >
      {/* 环形倒计时进度 */}
      <div className="countdown-ring-wrap">
        <svg className="countdown-svg" viewBox="0 0 36 36">
          <circle className="countdown-ring-bg" cx="18" cy="18" r="14.5" />
          <circle
            className="countdown-ring-meter"
            cx="18"
            cy="18"
            r="14.5"
            style={{ strokeDashoffset: `${elapsedRatio * RING_CIRCUMFERENCE}` }}
          />
        </svg>
        <span className="countdown-num">{countdown.remaining}s</span>
      </div>

      {/* 剧集信息 */}
      <div className="countdown-info-group">
        <span className="countdown-tag">即将连播</span>
        <span className="countdown-title" title={nextEpisode?.title || ''}>
          {nextEpisode?.title || '下一集'}
        </span>
      </div>

      {/* 立即播放 */}
      <button type="button" className="btn-countdown-play" onClick={acceptCountdown} title="立即播放下一集">
        <Play className="w-[11px] h-[11px] fill-current ml-px" />
        <span>立即播放</span>
      </button>

      {/* 取消自动连播 */}
      <button
        type="button"
        className="btn-countdown-cancel"
        onClick={cancelCountdown}
        title="取消自动连播"
        aria-label="取消自动连播"
      >
        <X className="w-[13px] h-[13px]" />
      </button>
    </div>
  );
};
