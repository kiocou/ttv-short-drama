import React, { useRef, useState, useCallback } from 'react';

interface FluentSliderProps {
  value: number; // 0 ~ 1 or custom min~max
  min?: number;
  max?: number;
  step?: number;
  onChange: (val: number) => void;
  className?: string;
  tooltipFormat?: (val: number) => string;
}

export const FluentSlider: React.FC<FluentSliderProps> = ({
  value,
  min = 0,
  max = 1,
  step = 0.01,
  onChange,
  className = '',
  tooltipFormat,
}) => {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [hoverValue, setHoverValue] = useState<number | null>(null);

  const calculateRatio = (clientX: number): number => {
    if (!trackRef.current) return 0;
    const rect = trackRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    return x / rect.width;
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    setIsDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    const ratio = calculateRatio(e.clientX);
    const newVal = min + ratio * (max - min);
    onChange(Number(newVal.toFixed(2)));
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const ratio = calculateRatio(e.clientX);
    const val = min + ratio * (max - min);
    setHoverValue(Number(val.toFixed(2)));

    if (isDragging) {
      onChange(Number(val.toFixed(2)));
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    setIsDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const currentPercent = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));

  return (
    <div
      ref={trackRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={() => setHoverValue(null)}
      className={`group relative h-6 flex items-center cursor-pointer select-none touch-none ${className}`}
    >
      {/* 轨道背景 */}
      <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden transition-all duration-150 group-hover:h-2.5 border border-slate-300/40">
        {/* 活跃进度条 */}
        <div
          className="h-full bg-blue-600 rounded-full transition-[width] duration-75 shadow-sm"
          style={{ width: `${currentPercent}%` }}
        />
      </div>

      {/* 滑块圆钮 (Fluent Thumb) */}
      <div
        className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 bg-white border-2 border-blue-600 rounded-full shadow-md transition-transform duration-100 ease-out group-hover:scale-125"
        style={{ left: `${currentPercent}%` }}
      />

      {/* 悬停提示气泡 (Tooltip) */}
      {hoverValue !== null && tooltipFormat && (
        <div
          className="absolute -top-7 px-2 py-0.5 text-[10px] font-semibold text-slate-800 bg-white/95 backdrop-blur-md rounded-md shadow-md border border-slate-200/80 -translate-x-1/2 pointer-events-none transition-opacity"
          style={{ left: `${Math.max(0, Math.min(100, ((hoverValue - min) / (max - min)) * 100))}%` }}
        >
          {tooltipFormat(hoverValue)}
        </div>
      )}
    </div>
  );
};
