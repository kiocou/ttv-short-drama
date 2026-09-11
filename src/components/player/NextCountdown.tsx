import React, { useRef } from 'react';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { Play, X } from 'lucide-react';

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

  if (!countdown.active || !countdown.nextEpisode) return null;

  // 计算圆环进度
  const totalSeconds = Math.max(1, totalRef.current);
  const progressRatio = Math.max(0, Math.min(100, (countdown.remaining / totalSeconds) * 100));
  const strokeDashoffset = 100 - progressRatio;

  return (
    <div 
      onClick={(e) => e.stopPropagation()}
      className="fixed bottom-24 right-8 z-50 flex items-center gap-3 p-3 bg-white/95 backdrop-blur-2xl rounded-2xl border border-white shadow-fluent-lg animate-slide-up select-none"
    >
      {/* 倒计时环形进度 */}
      <div className="relative w-10 h-10 flex items-center justify-center">
        <svg className="w-10 h-10 -rotate-90" viewBox="0 0 36 36">
          <circle
            cx="18"
            cy="18"
            r="15"
            fill="none"
            className="stroke-slate-100"
            strokeWidth="3"
          />
          <circle
            cx="18"
            cy="18"
            r="15"
            fill="none"
            className="stroke-blue-600 transition-all duration-1000 ease-linear"
            strokeWidth="3"
            strokeDasharray="94.2"
            strokeDashoffset={(strokeDashoffset / 100) * 94.2}
            strokeLinecap="round"
          />
        </svg>
        <span className="absolute text-xs font-bold text-slate-800">
          {countdown.remaining}s
        </span>
      </div>

      {/* 剧集信息 */}
      <div className="flex flex-col pr-1 max-w-[200px]">
        <span className="text-[11px] text-slate-400 font-medium">即将连播</span>
        <span className="text-xs font-semibold text-slate-800 truncate">
          {countdown.nextEpisode.title}
        </span>
      </div>

      {/* 立即播放按钮 */}
      <button
        onClick={acceptCountdown}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-sm transition-transform active:scale-95"
      >
        <Play className="w-3 h-3 fill-current" />
        <span>立即播放</span>
      </button>

      {/* 取消按钮 */}
      <button
        onClick={cancelCountdown}
        className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
        title="取消连播"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
};
