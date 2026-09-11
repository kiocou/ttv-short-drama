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

export const ProgressBar: React.FC<ProgressBarProps> = ({
  position,
  duration,
  buffered,
  onSeek,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [hoverPosition, setHoverPosition] = useState<number | null>(null);

  const calculateSeconds = (clientX: number): number => {
    if (!containerRef.current || duration <= 0) return 0;
    const rect = containerRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(clientX - rect.left, rect.width)) / rect.width;
    return ratio * duration;
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    setIsScrubbing(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    const secs = calculateSeconds(e.clientX);
    onSeek(secs);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const secs = calculateSeconds(e.clientX);
    setHoverPosition(secs);
    if (isScrubbing) {
      onSeek(secs);
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    setIsScrubbing(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const playedPercent = duration > 0 ? (position / duration) * 100 : 0;
  const bufferedPercent = duration > 0 ? (buffered / duration) * 100 : 0;
  const hoverPercent = duration > 0 && hoverPosition !== null ? (hoverPosition / duration) * 100 : null;

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={() => setHoverPosition(null)}
      className="group relative w-full h-5 flex items-center cursor-pointer select-none touch-none py-1"
    >
      {/* 进度条轨道基底 */}
      <div className="relative w-full h-1.5 bg-white/30 hover:bg-white/40 rounded-full overflow-hidden transition-all duration-200 group-hover:h-2.5">
        {/* 缓冲层 */}
        <div
          className="absolute top-0 left-0 h-full bg-white/50 rounded-full transition-[width] duration-200"
          style={{ width: `${Math.min(100, bufferedPercent)}%` }}
        />

        {/* 播放进度层 */}
        <div
          className="absolute top-0 left-0 h-full bg-blue-600 rounded-full transition-[width] duration-75"
          style={{ width: `${Math.min(100, playedPercent)}%` }}
        />
      </div>

      {/* 拖动抓手圆点 */}
      <div
        className="absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 bg-white border-2 border-blue-600 rounded-full shadow-md scale-0 group-hover:scale-100 transition-transform duration-150 ease-out -ml-1.5 pointer-events-none"
        style={{ left: `${Math.min(100, playedPercent)}%` }}
      />

      {/* 悬停时间预览气泡 */}
      {hoverPercent !== null && hoverPosition !== null && (
        <div
          className="absolute -top-7 px-2 py-0.5 text-[11px] font-mono font-medium text-slate-800 bg-white/95 backdrop-blur-md rounded-md shadow-lg border border-white/80 -translate-x-1/2 pointer-events-none animate-fade-in"
          style={{ left: `${Math.min(100, Math.max(0, hoverPercent))}%` }}
        >
          {formatTime(hoverPosition)}
        </div>
      )}
    </div>
  );
};
