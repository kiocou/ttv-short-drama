import React, { useRef, useState } from 'react';

interface ProgressBarProps {
  position: number;
  duration: number;
  buffered: number;
  onSeek: (seconds: number) => void;
}

function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

/**
 * 内嵌于底部大卡片顶部的进度槽。
 *
 * 两个刻意的实现选择：
 *   1. 播放/缓冲两层都用 `transform: scaleX()` 表达比例，而不是改宽度。
 *      播放中这里每 250ms 刷新一次，改宽度会带动整条卡片的布局重算；
 *      缩放只走合成层，滚动数字与按钮组不会跟着抖。
 *   2. 拖拽用 pointer capture。指针滑出这条 16px 高的细槽后仍能继续拖，
 *      松手即自动结束，不会像 window 监听那样留下悬挂的处理器。
 *
 * 键盘不在这里处理：左右方向键已由 VideoSurface 绑定成全局 ±5 秒，
 * 这里再绑一次会让一次按键跳两次。
 */
export const ProgressBar: React.FC<ProgressBarProps> = ({
  position,
  duration,
  buffered,
  onSeek,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);

  const ratioFromClientX = (clientX: number): number | null => {
    const el = containerRef.current;
    if (!el || duration <= 0) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return null;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    setIsScrubbing(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    const ratio = ratioFromClientX(e.clientX);
    if (ratio !== null) onSeek(ratio * duration);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const ratio = ratioFromClientX(e.clientX);
    setHoverRatio(ratio);
    if (isScrubbing && ratio !== null) onSeek(ratio * duration);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    setIsScrubbing(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // 指针已被释放时忽略
    }
  };

  // 未播放时不显示"已播放"层之外的信息：duration 为 0 的进度条只会误导。
  const playedRatio = duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0;
  const bufferedRatio = duration > 0 ? Math.max(0, Math.min(1, buffered / duration)) : 0;
  const shownRatio = hoverRatio !== null ? hoverRatio : playedRatio;

  return (
    <div
      ref={containerRef}
      role="slider"
      aria-label="播放进度"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, Math.round(duration))}
      aria-valuenow={Math.max(0, Math.round(position))}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerLeave={() => setHoverRatio(null)}
      className={`ttv-progress${isScrubbing ? ' is-scrubbing' : ''}`}
    >
      <div className="progress-track">
        <div className="progress-buffer" style={{ width: `${bufferedRatio * 100}%` }} />
        <div className="progress-played" style={{ transform: `scaleX(${playedRatio})`, width: '100%' }} />
      </div>

      {/* 拖动抓手圆点 */}
      <div className="progress-thumb" style={{ left: `${playedRatio * 100}%` }} />

      {/* 悬停 / 拖拽时的目标时间预览 */}
      {hoverRatio !== null && duration > 0 && (
        <div className="ttv-progress-hint" style={{ left: `${Math.min(100, Math.max(0, hoverRatio * 100))}%` }}>
          {formatTime(hoverRatio * duration)}
        </div>
      )}

      {/* 拖拽中显示目标位置，指针移开轨道后仍能看清落点 */}
      {isScrubbing && duration > 0 && (
        <div
          className="ttv-progress-hint"
          style={{
            left: `${shownRatio * 100}%`,
            opacity: hoverRatio !== null ? 0 : 1,
          }}
        >
          {formatTime(shownRatio * duration)}
        </div>
      )}
    </div>
  );
};
