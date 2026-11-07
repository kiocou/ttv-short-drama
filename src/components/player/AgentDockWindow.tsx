import React, { useEffect, useRef, useState } from 'react';
import { Play, X, Bot, GripVertical } from 'lucide-react';

/**
 * 智能体联动的桌面悬浮卡（运行在**独立置顶窗口** `agentdock` 里）。
 *
 * ## 视觉（重做，2026-10-29）
 *
 * 上一版是"把主界面的卡片缩小"，问题有三：白底方块太实、和桌面/其它应用格格
 * 不入、而且只能活在主窗口里（主窗口一被遮住就没了）。这一版：
 *
 * - **窗口透明**：卡片自己是唯一的实体，圆角外全是真透明（Rust 侧
 *   `transparent(true)` + capabilities），贴在桌面上没有白框；
 * - **暗色玻璃**：深色半透明 + 背景模糊 + 内描边高光，在浅色 IDE 和深色终端上
 *   都稳；不跟随应用主题，因为它要贴在**别的程序**上面；
 * - **横向影视卡**：左侧 16:9 封面（带播放进度细条），右侧信息区；
 * - **无边框、可拖动**：整块卡片按住就能拖（`agent_dock_drag`），位置会被记住。
 *
 * ## 动效（不卡顿的保证）
 *
 * 全部走合成层：`transform` / `opacity` / `filter`，不碰 layout。悬停时
 * 卡片抬升 2px + 封面微放大 + 播放按钮浮出，都是 GPU 合成属性。呼吸点是纯 CSS
 * 动画，不经过 React 渲染。整个窗口只有一块静态 DOM，事件驱动一次 setState。
 */

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

/** 事件类型 → 状态点颜色与文案。 */
const TONE: Record<string, { dot: string; text: string; label: string }> = {
  done: { dot: 'bg-emerald-400', text: 'text-emerald-300', label: '已完成' },
  action: { dot: 'bg-amber-400', text: 'text-amber-300', label: '需要操作' },
  question: { dot: 'bg-sky-400', text: 'text-sky-300', label: '需要你决定' },
  error: { dot: 'bg-rose-400', text: 'text-rose-300', label: '出错了' },
};

const fmt = (s: number) => {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
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
  const [hovered, setHovered] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const readyRef = useRef(false);

  /**
   * 内容来源有两条，缺一不可：
   *
   * 1. **主动拉**（`agent_dock_state`）：窗口是 Rust 侧建的，build 完成到页面 JS
   *    开始执行之间有一段时间，期间 emit 出去的事件没有监听器接 —— 全丢。挂载时
   *    先拉一次，把这个窗口补上；
   * 2. **订阅推**（`agent://dock-state`）：同一部剧换了集、或用户又触发了新事件，
   *    主窗口会用事件更新内容。
   *
   * 只有真的拿到内容才 `agent_dock_ready` 显示窗口。拿不到就一直透明 ——
   * 一块空白的置顶窗比没有窗口更让人困惑。
   */
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | null = null;
    const reveal = (next: DockState | null) => {
      if (disposed) return;
      setState(next);
      if (next && !readyRef.current) {
        readyRef.current = true;
        void invoke('agent_dock_ready');
      }
    };

    void (async () => {
      // 先订阅再拉取：避免"拉取返回之后、订阅生效之前"这段时间漏掉更新。
      const { listen } = await import('@tauri-apps/api/event');
      const fn = await listen<DockState | null>('agent://dock-state', message => {
        if (disposed) return;
        setState(message.payload);
        if (message.payload && !readyRef.current) {
          readyRef.current = true;
          void invoke('agent_dock_ready');
        }
      });
      if (disposed) {
        fn();
        return;
      }
      off = fn;
      const current = await invoke<DockState | null>('agent_dock_state');
      if (current) reveal(current);
    })();

    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  if (!state) {
    // 还没内容：整窗透明。不能返回 null——根节点没了 CSS 背景就不会被绘制，
    // 但窗口本身仍在，表现正常（全透明）。
    return <div className="w-full h-full" />;
  }

  const tone = TONE[state.eventType] ?? TONE.done;
  const progress = state.duration > 0 ? Math.min(100, (state.position / state.duration) * 100) : 0;

  const act = async (action: 'resume' | 'close') => {
    if (action === 'close') setLeaving(true);
    await invoke('agent_dock_action', { action });
  };

  return (
    <div
      className="w-full h-full flex items-center justify-center p-3 select-none"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <style>{`
        @keyframes dockIn {
          from { opacity: 0; transform: translateY(10px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes dockOut {
          to { opacity: 0; transform: translateY(8px) scale(0.97); }
        }
        .dock-card { animation: dockIn 260ms cubic-bezier(0.16,1,0.3,1) both; }
        .dock-card.leaving { animation: dockOut 180ms ease-in both; }
        /* 悬停：只动合成属性（transform / opacity），不触发重排 */
        .dock-card .cover-img { transition: transform 420ms cubic-bezier(0.16,1,0.3,1); }
        .dock-card:hover .cover-img { transform: scale(1.06); }
        .dock-card .play-fab {
          opacity: 0; transform: scale(0.86);
          transition: opacity 200ms ease, transform 260ms cubic-bezier(0.16,1,0.3,1);
        }
        .dock-card:hover .play-fab { opacity: 1; transform: scale(1); }
        .dock-card .sheen {
          opacity: 0; transition: opacity 300ms ease;
        }
        .dock-card:hover .sheen { opacity: 1; }
      `}</style>

      <div
        className={`dock-card ${leaving ? 'leaving' : ''} relative w-full rounded-[20px] overflow-hidden cursor-pointer`}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onClick={() => void act('resume')}
        onPointerDown={e => {
          // 只对"不是按钮"的区域启用拖动，避免点击播放键时把窗口拖走。
          if ((e.target as HTMLElement).closest('button')) return;
          void invoke('agent_dock_drag');
        }}
        style={{
          background: 'linear-gradient(140deg, rgba(24,26,32,0.92) 0%, rgba(16,18,23,0.96) 100%)',
          backdropFilter: 'blur(28px) saturate(1.4)',
          border: '1px solid rgba(255,255,255,0.10)',
          boxShadow:
            '0 18px 48px -12px rgba(0,0,0,0.62), 0 2px 8px -2px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.09)',
          transform: hovered ? 'translateY(-2px)' : 'translateY(0)',
          transition: 'transform 260ms cubic-bezier(0.16,1,0.3,1), box-shadow 260ms ease',
        }}
      >
        {/* 顶部一道极细的彩色高光：暗色卡片在深色背景上靠它"立"起来 */}
        <div
          className="absolute inset-x-0 top-0 h-px sheen"
          style={{
            background:
              'linear-gradient(90deg, transparent, rgba(120,180,255,0.55), rgba(180,140,255,0.45), transparent)',
          }}
        />

        <div className="flex gap-3.5 p-3">
          {/* 封面：16:9，带进度细条 */}
          <div className="relative shrink-0 w-[132px] h-[74px] rounded-[12px] overflow-hidden bg-white/5">
            {state.cover ? (
              <img
                src={state.cover}
                alt=""
                draggable={false}
                className="cover-img absolute inset-0 w-full h-full object-cover"
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-white/20">
                <Play className="w-5 h-5" />
              </div>
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent" />
            {/* 悬停浮出的播放按钮 */}
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="play-fab w-8 h-8 rounded-full bg-white/95 flex items-center justify-center shadow-lg">
                <Play className="w-3.5 h-3.5 text-slate-900 ml-0.5" fill="currentColor" />
              </div>
            </div>
            {/* 进度细条 */}
            <div className="absolute bottom-0 inset-x-0 h-[3px] bg-white/15">
              <div
                className="h-full bg-gradient-to-r from-sky-400 to-indigo-400"
                style={{ width: `${progress}%`, transition: 'width 300ms ease' }}
              />
            </div>
            {state.isAnime && (
              <span className="absolute top-1.5 left-1.5 px-1.5 py-px rounded bg-black/55 text-[9px] text-white/85 font-medium">
                动漫
              </span>
            )}
          </div>

          {/* 信息区 */}
          <div className="min-w-0 flex-1 flex flex-col justify-between py-0.5">
            <div className="flex items-start gap-1.5">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-white/95 leading-tight truncate">
                  {state.title}
                </p>
                <p className="mt-1 text-[10.5px] text-white/45 tabular-nums">
                  第 {state.episodeNumber} 集 · 停在 {fmt(state.position)}
                  {state.duration > 0 && <span className="text-white/30"> / {fmt(state.duration)}</span>}
                </p>
              </div>
              <button
                onClick={e => {
                  e.stopPropagation();
                  void act('close');
                }}
                className="shrink-0 -mt-0.5 -mr-0.5 p-1 rounded-md text-white/35 hover:text-white/80 hover:bg-white/10 transition-colors"
                aria-label="关闭"
              >
                <X className="w-3 h-3" />
              </button>
            </div>

            {/* 智能体状态行 */}
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="relative flex h-1.5 w-1.5 shrink-0">
                <span className={`absolute inline-flex h-full w-full rounded-full ${tone.dot} opacity-70 animate-ping`} />
                <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${tone.dot}`} />
              </span>
              <Bot className="w-3 h-3 text-white/40 shrink-0" />
              <span className="text-[10.5px] text-white/60 truncate">
                {state.agentName}
                <span className={`ml-1 ${tone.text}`}>· {tone.label}</span>
              </span>
            </div>
          </div>
        </div>

        {/* 底部提示条：只在悬停时展开（grid-rows 过渡，内容不跳动） */}
        <div
          className="grid overflow-hidden"
          style={{
            gridTemplateRows: hovered ? '1fr' : '0fr',
            transition: 'grid-template-rows 280ms cubic-bezier(0.16,1,0.3,1)',
          }}
        >
          <div className="min-h-0">
            <div className="flex items-center gap-2 px-3 pb-2.5 pt-0.5">
              <span className="text-[10px] text-white/35 truncate">
                {state.message || (state.project ? state.project : '点击任意位置回到播放器')}
              </span>
              <span className="ml-auto shrink-0 text-[10px] text-white/45">点击回到播放器 →</span>
            </div>
          </div>
        </div>

        {/* 左侧拖动把手（视觉提示，实际整卡可拖） */}
        <div className="absolute left-0 inset-y-0 w-1.5 flex items-center justify-center pointer-events-none">
          <GripVertical className="w-3 h-3 text-white/0" />
        </div>
      </div>
    </div>
  );
};

export default AgentDockWindow;
