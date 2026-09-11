import React from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { CheckCircle2, AlertCircle, Info, XCircle, X } from 'lucide-react';

export const ToastContainer: React.FC = () => {
  const { toasts, removeToast } = useAppStore();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-14 right-4 z-50 flex flex-col gap-2 pointer-events-none max-w-sm w-full">
      {toasts.map((toast) => {
        const iconMap = {
          success: <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />,
          warning: <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0" />,
          error: <XCircle className="w-4 h-4 text-rose-600 flex-shrink-0" />,
          info: <Info className="w-4 h-4 text-blue-600 flex-shrink-0" />,
        };

        return (
          <div
            key={toast.id}
            className="pointer-events-auto flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-white/90 backdrop-blur-xl border border-white shadow-fluent-lg text-xs text-slate-800 animate-slide-up"
          >
            <div className="flex items-center gap-2.5">
              {iconMap[toast.type]}
              <span className="font-medium leading-relaxed">{toast.message}</span>
            </div>
            <button
              onClick={() => removeToast(toast.id)}
              className="p-1 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
