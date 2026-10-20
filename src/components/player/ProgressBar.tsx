import React, { useRef, useState } from 'react';

interface ProgressBarProps {
  position: number;
  duration: number;
  buffered: number;
  /**
   * 落点变更。第二个参数表示"这次只是拖动过程中的预览，还没松手"。
   *
   * 为什么需要它（2026-10-21）：拖到未转码区域时，上层要向后端请求续转
   * （`open_stream`）。如果不区分预览与落定，一次拖动经过的每个像素都会发一次
   * 续转请求 —— 拖 3 秒能发几十次，每次都重建会话。
   */
  onSeek: (seconds: number, previewing?: boolean) => void;
}

/**
 * 秒 → mm:ss。两个播放面（主进度条与画中画小窗）共用同一份格式化，
 * 免得两处各写一遍、格式悄悄分叉（如 "5:03" vs "05:03"）。
 */
export function formatTime(seconds: number): string {
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
    // 拖动过程中只做**预览**：真正落定交给 pointerup。
    //
    // 理由见 `onSeek` 的签名说明：未转码区的落定会触发一次后端续转，
    // 拖动过程中每个像素都落定的话，拖 3 秒能发出几十次重建请求。
    if (isScrubbing && ratio !== null) onSeek(ratio * duration, true);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const wasScrubbing = isScrubbing;
    setIsScrubbing(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // 指针已被释放时忽略
    }
    // 松手这一刻才真正落定：补一次最终落点，续转只发这一次。
    if (wasScrubbing) {
      const ratio = ratioFromClientX(e.clientX);
      if (ratio !== null) onSeek(ratio * duration);
    }
  };

  // 未播放时不显示"已播放"层之外的信息：duration 为 0 的进度条只会误导。
  //
  // ⚠️ 三个值都必须**有限**：`video.currentTime` / `buffered.end()` 在 MSE 重新
  // 挂载或换源的那一瞬间可能读成 `NaN`，而 `Math.min(1, NaN)` 还是 `NaN` ——
  // `scaleX(NaN)` 是无效值，已播段会整个不渲染。用户看到的是"进度条消失了"
  // （2026-10-19 现场：长按倍速 + 切集后必现）。所以统一在下面这个收口里过滤。
  const clampRatio = (value: number): number => {
    if (duration <= 0 || !Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value / duration));
  };
  const playedRatio = clampRatio(position);
  const bufferedRatio = clampRatio(buffered);
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
