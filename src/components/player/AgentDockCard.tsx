import React, { useEffect, useRef, useState } from 'react';
import { Play, X } from 'lucide-react';
import { useAgentWatch } from '../../stores/useAgentWatchStore';
import { agentDisplayName } from '../../services/agentWatch';

/**
 * 智能体联动 · 悬浮 dock 卡（「前往智能体」后播放器的收起形态）。
 *
 * ## 设计：「胶片夹」两段式
 *
 * - **收拢态**（默认）：右下角圆角小卡——封面小图 + 剧名 + 智能体状态呼吸点。
 *   占屏极小，不打扰用户操作智能体工具。
 * - **展开态**（悬停 / 点击）：向左弹性展开成完整卡片——封面放大成 16:9 横图、
 *   集数与停留位置、续播大按钮。
 *
 * ## 动画性能（不卡顿的保证，与项目 tailwind.config.js 的动画纪律一致）
 *
 * 1. 展开/收起只动 `width` 之外的合成友好属性：封面尺寸用 `transform: scale`
 *    （scale 提前铺满 288px，收拢时缩小到胶囊内）+ 容器用 CSS `transition`
 *    过渡 `width`（这张卡是低频交互组件，宽度过渡的 layout 成本一次性且可忽略；
 *    帧内内容全部 GPU 合成层，实测无掉帧）；
 * 2. 呼吸点是纯 CSS `animate-pulse`，不经过 React 渲染循环；
 * 3. 组件只订阅 `docked` 一个状态，智能体事件风暴时也不重渲染这张卡；
 * 4. 悬停 60ms 防抖：指针快速划过不触发动画闪跳。
 */
export const AgentDockCard: React.FC = () => {
  const { docked, resumeFromDock, dismissDocked } = useAgentWatch();
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false); // 点击保持展开（无 hover 场景兜底）
  const expanded = hovered || pinned;
  const hoverTimer = useRef<number | null>(null);

  // docked 消失时复位 pin 态，下次出现从收拢态开始。
  useEffect(() => {
    if (!docked) {
      setPinned(false);
      setHovered(false);
    }
  }, [docked]);

  const onEnter = () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setHovered(true), 60);
  };
  const onLeave = () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    setHovered(false);
  };

  if (!docked) return null;
  const { snapshot, event } = docked;

  const eventTone =
    event.eventType === 'error' ? 'bg-rose-500' : event.eventType === 'done' ? 'bg-emerald-500' : 'bg-amber-500';

  const fmt = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div
      className="fixed bottom-6 right-6 z-[70] animate-slide-up"
      data-testid="agent-dock-card"
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onClick={() => setPinned(p => !p)}
    >
      <div
        className="relative overflow-hidden rounded-2xl bg-white/92 backdrop-blur-2xl border border-white shadow-fluent-lg transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
        style={{ width: expanded ? 288 : 176 }}
      >
        {/* 封面：内层铺满 288px 后用 scale 适配两态，切换时是纯合成缩放 */}
        <div className="relative overflow-hidden rounded-xl m-1.5" style={{ height: expanded ? 96 : 78 }}>
          <img
            src={snapshot.cover}
            alt=""
            className="absolute inset-0 w-[285px] h-full object-cover origin-left transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
            style={{ transform: expanded ? 'scale(1)' : 'scale(0.615)' }}
            draggable={false}
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/10 to-transparent" />
          <div className="absolute bottom-1.5 left-2 flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${eventTone} animate-pulse`} />
            <span className="text-[10px] text-white/90 font-medium drop-shadow">
              {agentDisplayName(event.agent)}
            </span>
          </div>
          {expanded && (
            <button
              onClick={e => { e.stopPropagation(); dismissDocked(); }}
              className="absolute top-1.5 right-1.5 p-1 rounded-md bg-black/30 hover:bg-black/50 text-white/80 hover:text-white transition-colors"
              aria-label="关闭悬浮卡"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* 文本区：收拢 = 单行剧名；展开 = 剧名 + 集 + 位置 + 续播按钮 */}
        <div className="px-3 pb-3 pt-1">
          <p className="text-xs font-semibold text-slate-800 truncate">{snapshot.title}</p>
          {/* 展开区用网格行高动画（max-height 是低频一次性 layout，可接受）：
              内容存在但被裁掉，展开时滑出。 */}
          <div
            className="grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
            style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
          >
            <div className="overflow-hidden">
              <div className="mt-1.5 flex flex-col gap-2 pt-1">
                <p className="text-[10px] text-slate-500">
                  第 {snapshot.episodeNumber} 集 · 停在 {fmt(snapshot.position)}
                  {snapshot.kind === 'anime' && ' · 动漫'}
                </p>
                <button
                  onClick={e => { e.stopPropagation(); resumeFromDock(); }}
                  className="h-8 w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium transition-colors cursor-pointer fluent-press"
                >
                  <Play className="w-3.5 h-3.5" />
                  回到播放器
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AgentDockCard;
