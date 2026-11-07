import React, { useEffect, useRef, useState } from 'react';
import { BellRing, Bot, PlayCircle, SkipForward, X } from 'lucide-react';
import { useAgentWatch } from '../../stores/useAgentWatchStore';
import { agentDisplayName, agentEventLabel } from '../../services/agentWatch';

/**
 * 智能体呼叫卡：正在播放时收到智能体事件 → 自动暂停后弹出（右下角），
 * 三选一：前往智能体 / 继续观看 / 忽略。
 *
 * ## 形态（参考 Clawd on Desk 的权限气泡 + agent-notifications 的通知分类）
 *
 * 悬浮卡片而非系统通知：点击「前往」的动作发生在本应用内（收起播放器），
 * 系统 Toast 点了就没了，应用内卡片才能承载"前往 + 收起"的完整动作。
 *
 * ## 15 秒倒计时
 *
 * 没有用户决定时 15 秒后自动按「忽略」收卡（保持暂停，继续监测）。
 * 这是 agent-notifications 的实践：交互卡片不能无限期占着屏幕。
 * 事件进来（新卡片）会重置倒计时。
 */
export const AgentCallCard: React.FC = () => {
  const { incoming, goToAgent, keepWatching, dismissIncoming } = useAgentWatch();
  const [remaining, setRemaining] = useState(15);
  const startedAtRef = useRef(0);

  // 每张新卡片重置倒计时（按事件的 timestamp 识别"新卡"）。
  useEffect(() => {
    if (incoming) {
      startedAtRef.current = Date.now();
      setRemaining(15);
    }
  }, [incoming?.event.timestamp]);

  useEffect(() => {
    if (!incoming) return;
    const timer = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000);
      const left = 15 - elapsed;
      if (left <= 0) {
        dismissIncoming();
        return;
      }
      setRemaining(left);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [incoming, dismissIncoming]);

  if (!incoming) return null;
  const { event } = incoming;
  const eventTone = event.eventType === 'error' ? 'text-rose-600' : event.eventType === 'done' ? 'text-emerald-600' : 'text-amber-600';

  return (
    <div className="fixed bottom-6 right-6 z-[70] w-80 pointer-events-none">
      <div className="pointer-events-auto rounded-2xl bg-white/92 backdrop-blur-2xl border border-white shadow-fluent-lg overflow-hidden animate-slide-up">
        {/* 顶条：智能体标识 + 事件类型 */}
        <div className="flex items-center gap-2 px-4 pt-3.5 pb-2.5">
          <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
            <span className="absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75 animate-ping" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-500" />
          </span>
          <Bot className="w-4 h-4 text-slate-700 flex-shrink-0" />
          <span className="text-xs font-semibold text-slate-800 truncate">
            {agentDisplayName(event.agent)}
          </span>
          <span className={`text-[11px] font-medium ${eventTone} flex-shrink-0`}>
            · {agentEventLabel(event.eventType)}
          </span>
          <span className="ml-auto text-[10px] text-slate-400 font-mono flex-shrink-0">{remaining}s</span>
          <button
            onClick={dismissIncoming}
            className="p-1 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
            aria-label="忽略"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        {/* 消息摘要 */}
        {event.message && (
          <p className="px-4 pb-2 text-[11px] leading-relaxed text-slate-600 line-clamp-2">
            {event.message}
          </p>
        )}
        {event.project && (
          <p className="px-4 pb-2.5 text-[10px] text-slate-400 font-mono truncate">
            {event.project}
          </p>
        )}
        {/* 动作区 */}
        <div className="flex items-center gap-2 px-4 py-3 border-t border-black/[0.05] bg-slate-50/60">
          <button
            onClick={goToAgent}
            className="flex-1 h-8 inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium transition-colors cursor-pointer fluent-press"
          >
            <BellRing className="w-3.5 h-3.5" />
            前往智能体
          </button>
          <button
            onClick={keepWatching}
            className="flex-1 h-8 inline-flex items-center justify-center gap-1.5 rounded-lg bg-white hover:bg-slate-100 border border-slate-200 text-slate-700 text-xs font-medium transition-colors cursor-pointer fluent-press"
          >
            <PlayCircle className="w-3.5 h-3.5" />
            继续观看
          </button>
          <button
            onClick={dismissIncoming}
            className="h-8 px-3 inline-flex items-center gap-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 text-xs transition-colors cursor-pointer"
            aria-label="忽略本次"
          >
            <SkipForward className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default AgentCallCard;
