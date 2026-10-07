/**
 * 播放诊断日志面板（设置页内嵌）。
 *
 * 存在理由：用户报的两个问题（「视频首次加载很长时间」「开关 VSR 都没用」）都只
 * 在用户自己的机器上发生，开发机复现不出来。后端 trace.rs 早就在写
 * `%LOCALAPPDATA%\com.ttv.shortdrama\ttv-playback.log`，但让用户去翻文件等于没有
 * 诊断——日志必须在应用里能看见、能复制、能导出，才能做到「根据日志一步一步优化」。
 *
 * 三个刻意的实现选择：
 *   1. **增量拉取**：用 trace_tail 的 nextCursor 游标，只取新增行。每次传 0 会每
 *      1.5 秒把 2000 行全量搬过 IPC 一遍，反而把诊断工具本身变成卡顿源。
 *   2. **渲染上限**：只在 DOM 里保留最后 MAX_RENDER_LINES 行。日志本身有 2000 行
 *      环形上限，但面板可能开着几十分钟，不设上限会让这个常驻页面的 DOM 一直长。
 *   3. **手动上滚即暂停自动滚底**：否则用户往回看的时候会被新行不断顶走。
 *
 * 不引入任何常驻合成层动画（AGENTS.md 不变量 26）：设置页是常驻 DOM，一个
 * forwards 的 opacity/transform 会被永久钉住，历史上因此让 NVIDIA VSR 失效过。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ipcService } from '../../services/ipc';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { FluentButton } from './FluentButton';
import { ChevronDown, ClipboardCopy, Download, Trash2 } from 'lucide-react';

/** 轮询间隔。1.5s 足够跟上起播链路（毫秒级打点会几行一起到），又不至于刷屏。 */
const POLL_MS = 1500;
/** DOM 里最多保留的行数。 */
const MAX_RENDER_LINES = 800;

/** 单行着色：越接近「出问题了」越显眼，正常链路保持安静。 */
function lineClass(line: string): string {
  if (line.includes('失败') || line.includes('错误') || line.includes('error')) return 'text-amber-300';
  if (line.includes('[vsr]')) return 'text-sky-300';
  if (line.includes('[ui]')) return 'text-emerald-300';
  return 'text-slate-300';
}

export const PlaybackLogPanel: React.FC = () => {
  const { settings } = useSettingsStore();
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [dropped, setDropped] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [status, setStatus] = useState('');
  const cursorRef = useRef(0);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const pull = useCallback(async () => {
    const r = await ipcService.diagnostics.tail(cursorRef.current);
    if (r.nextCursor !== cursorRef.current) cursorRef.current = r.nextCursor;
    if (r.dropped) setDropped(true);
    if (r.lines.length > 0) {
      setLines(prev => {
        const next = prev.concat(r.lines);
        return next.length > MAX_RENDER_LINES ? next.slice(next.length - MAX_RENDER_LINES) : next;
      });
    }
  }, []);

  // 只有展开时才轮询——折叠状态下不产生任何 IPC 流量。
  useEffect(() => {
    if (!open) return;
    void pull();
    const timer = setInterval(() => void pull(), POLL_MS);
    return () => clearInterval(timer);
  }, [open, pull]);

  useEffect(() => {
    if (!open || !autoScroll) return;
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [lines, open, autoScroll]);

  const handleScroll = () => {
    const box = boxRef.current;
    if (!box) return;
    // 距底部 24px 以内才算「在底部」，继续跟随。
    setAutoScroll(box.scrollHeight - box.scrollTop - box.clientHeight < 24);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setStatus(`已复制 ${lines.length} 行`);
    } catch {
      setStatus('复制失败，请改用「导出日志」');
    }
  };

  const handleExport = () => {
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ttv-playback-log-${Date.now()}.txt`;
    a.click();
    // 立刻 revoke 可能在下载真正开工前把 blob 撤掉（设置页里已有同样的坑记录）。
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setStatus('已导出');
  };

  const handleClear = async () => {
    await ipcService.diagnostics.clear();
    cursorRef.current = 0;
    setLines([]);
    setDropped(false);
    setStatus('已清空');
  };

  // 起播摘要：从已有行里倒着找最近一条起播相关记录，一眼看到这一集走的是哪条链路
  // （HLS 转码 / 本地文件 / 直链）。
  const lastStartLine = [...lines].reverse().find(l => l.includes('起播') || l.includes('就绪判定') || l.includes('resolve 完成'));

  return (
    <div className="pt-4 border-t border-black/[0.04]">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-slate-800">播放诊断日志</div>
          <div className="text-[11px] text-slate-400 leading-relaxed">
            实时跟踪拉流、转存与起播全链路。遇到播放问题把它导出发我，就能按日志定位。
          </div>
        </div>
        <FluentButton
          variant="secondary"
          size="sm"
          icon={<ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />}
          onClick={() => setOpen(v => !v)}
        >
          {open ? '收起' : '展开'}
        </FluentButton>
      </div>

      {open && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
            <span>
              RTX VSR：
              <span className={settings.vsrEnabled !== false ? 'text-blue-600 font-semibold' : 'text-slate-500 font-semibold'}>
                {settings.vsrEnabled !== false ? '开' : '关'}
              </span>
            </span>
            <span>已显示行数：{lines.length}</span>
            {dropped && <span className="text-amber-600">旧日志已被淘汰</span>}
            {status && <span className="text-emerald-600">{status}</span>}
          </div>

          {lastStartLine && (
            <div className="text-[11px] font-mono text-slate-600 bg-slate-50 rounded-lg px-2.5 py-1.5 break-all">
              最近起播：{lastStartLine}
            </div>
          )}

          <div
            ref={boxRef}
            onScroll={handleScroll}
            className="h-56 overflow-y-auto rounded-lg bg-slate-900 px-3 py-2 font-mono text-[11px] leading-relaxed"
          >
            {lines.length === 0 ? (
              <div className="text-slate-500">暂无日志。去播一集，这里会出现完整的拉流记录。</div>
            ) : (
              lines.map((line, index) => (
                <div key={index} className={lineClass(line)}>
                  {line}
                </div>
              ))
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <FluentButton variant="secondary" size="sm" icon={<ClipboardCopy className="w-3.5 h-3.5" />} onClick={handleCopy}>
              复制全部
            </FluentButton>
            <FluentButton variant="secondary" size="sm" icon={<Download className="w-3.5 h-3.5" />} onClick={handleExport}>
              导出日志
            </FluentButton>
            <FluentButton variant="secondary" size="sm" icon={<Trash2 className="w-3.5 h-3.5" />} onClick={handleClear}>
              清空
            </FluentButton>
          </div>
        </div>
      )}
    </div>
  );
};