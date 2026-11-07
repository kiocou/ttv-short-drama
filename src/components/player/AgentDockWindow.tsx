import React, { useEffect, useState } from 'react';
import { Play, X } from 'lucide-react';

interface DockState {
  title: string;
  cover: string;
  episodeNumber: number;
  position: number;
  duration: number;
  agentName: string;
  eventType: 'done' | 'action' | 'question' | 'error';
  message: string;
  project: string;
  isAnime: boolean;
}

const TONE: Record<DockState['eventType'], { dot: string; text: string }> = {
  done: { dot: '#34d399', text: '已完成' },
  action: { dot: '#fbbf24', text: '需要操作' },
  question: { dot: '#60a5fa', text: '需要决定' },
  error: { dot: '#fb7185', text: '运行出错' },
};

const fmt = (s: number) => {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
};

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    const { invoke: call } = await import('@tauri-apps/api/core');
    return await call<T>(cmd, args);
  } catch {
    return null;
  }
}

export const AgentDockWindow: React.FC = () => {
  const [state, setState] = useState<DockState | null>(null);

  useEffect(() => {
    let disposed = false;
    let off: (() => void) | null = null;
    const reveal = (next: DockState | null) => {
      if (disposed) return;
      setState(next);
      if (next) void invoke('agent_dock_ready');
    };
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const fn = await listen<DockState | null>('agent://dock-state', message => reveal(message.payload));
      if (disposed) fn();
      else off = fn;
      reveal(await invoke<DockState | null>('agent_dock_state'));
    })();
    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  if (!state) return <div className="w-full h-full" />;
  const tone = TONE[state.eventType] ?? TONE.done;
  const progress = state.duration > 0 ? Math.min(100, (state.position / state.duration) * 100) : 0;
  const act = (action: 'resume' | 'close') => void invoke('agent_dock_action', { action });

  return (
    <div className="w-full h-full p-2 select-none" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <div
        className="w-full h-full flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-white/90"
        onPointerDown={event => {
          if (!(event.target as HTMLElement).closest('button')) void invoke('agent_dock_drag');
        }}
        style={{
          background: 'rgba(24, 26, 32, 0.96)',
          border: '1px solid rgba(255,255,255,0.12)',
          boxShadow: '0 10px 28px rgba(0,0,0,0.34)',
        }}
      >
        <div className="relative w-[96px] h-[58px] shrink-0 overflow-hidden rounded-lg bg-white/10">
          {state.cover && <img src={state.cover} alt="" draggable={false} className="absolute inset-0 w-full h-full object-cover" />}
          <div className="absolute inset-x-0 bottom-0 h-0.5 bg-white/20">
            <div className="h-full bg-sky-400" style={{ width: `${progress}%` }} />
          </div>
        </div>
        <div className="min-w-0 flex-1 self-stretch flex flex-col justify-center">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tone.dot }} />
            <p className="truncate text-[12px] font-semibold">{state.title}</p>
          </div>
          <p className="mt-1 truncate text-[10px] text-white/50">
            第 {state.episodeNumber} 集 · {fmt(state.position)}
            {state.duration > 0 && ` / ${fmt(state.duration)}`}
          </p>
          <p className="mt-1 truncate text-[10px]" style={{ color: tone.dot }}>
            {state.agentName} · {tone.text}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => act('resume')}
            className="h-7 w-7 inline-flex items-center justify-center rounded-md bg-sky-500 text-white hover:bg-sky-400 transition-colors"
            aria-label="回到播放器"
            title="回到播放器"
          >
            <Play className="w-3.5 h-3.5" fill="currentColor" />
          </button>
          <button
            onClick={() => act('close')}
            className="h-7 w-7 inline-flex items-center justify-center rounded-md text-white/45 hover:bg-white/10 hover:text-white transition-colors"
            aria-label="关闭智能体提示"
            title="关闭"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default AgentDockWindow;
