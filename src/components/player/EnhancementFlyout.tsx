import React, { useRef, useEffect } from 'react';
import { useEnhancementStore } from '../../stores/useEnhancementStore';
import { Sparkles } from 'lucide-react';

interface EnhancementFlyoutProps {
  isOpen: boolean;
  onClose: () => void;
}

export const EnhancementFlyout: React.FC<EnhancementFlyoutProps> = ({ isOpen, onClose }) => {
  const { engine, uiState, setEngine, capabilities } = useEnhancementStore();
  const flyoutRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (flyoutRef.current && !flyoutRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const engines = capabilities?.supportedEngines ?? [];

  return (
    <div
      ref={flyoutRef}
      className="absolute bottom-16 right-16 z-50 w-72 p-3 bg-white/95 backdrop-blur-2xl rounded-2xl border border-white shadow-fluent-hud animate-slide-up select-none"
    >
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-black/[0.05]">
        <div className="flex items-center gap-1.5 text-xs font-bold text-slate-800">
          <Sparkles className="w-3.5 h-3.5 text-blue-600" />
          <span>画面插帧与增强</span>
        </div>
        <span className="text-[10px] text-slate-400">
          {capabilities?.gpuName?.split(' ')[0] || 'GPU'} 加速
        </span>
      </div>

      {/* 嵌入式凹槽托盘 */}
      <div className="p-1.5 bg-slate-100/80 rounded-xl border border-slate-200/70 shadow-inner flex flex-col gap-1.5">
        {engines.map((item) => {
          const isSelected = engine === item.id;

          return (
            <button
              key={item.id}
              onClick={() => {
                void setEngine(item.id);
                onClose();
              }}
              className={`flex flex-col text-left p-2.5 rounded-xl border transition-all duration-150 fluent-press cursor-pointer ${
                isSelected
                  ? 'bg-white border-blue-400 text-blue-600 shadow-sm ring-1 ring-blue-400/40'
                  : 'bg-white/80 hover:bg-white border-slate-200/70 hover:border-slate-300 shadow-xs'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className={`text-xs font-semibold ${isSelected ? 'text-blue-600' : 'text-slate-800'}`}>
                  {item.name}
                </span>
                <span
                  className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md ${
                    isSelected
                      ? 'bg-blue-600 text-white shadow-xs'
                      : 'bg-slate-100 text-slate-500'
                  }`}
                >
                  {item.id === 'off' ? '原生' : `${item.targetFps} FPS`}
                </span>
              </div>
              <p className="text-[10px] text-slate-400 mt-1 leading-normal">
                {item.description}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
};
