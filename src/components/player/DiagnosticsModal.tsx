import React from 'react';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { useEnhancementStore } from '../../stores/useEnhancementStore';
import { X, Activity, Cpu, HardDrive, Wifi, ShieldCheck, Zap } from 'lucide-react';

export const DiagnosticsModal: React.FC = () => {
  const {
    sessionId,
    currentSeries,
    currentEpisode,
    position,
    duration,
    buffered,
    isDiagnosticsOpen,
    toggleDiagnostics,
  } = usePlaybackStore();

  const {
    engine,
    uiState: enhState,
    targetFps,
    currentFps,
    decodeFps,
    droppedFrames,
    latencyMs,
    capabilities,
  } = useEnhancementStore();

  if (!isDiagnosticsOpen) return null;

  const bufferSecondsAhead = Math.max(0, buffered - position);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/20 backdrop-blur-sm animate-fade-in select-none">
      <div 
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-2xl bg-white/95 backdrop-blur-2xl border border-white shadow-fluent-lg overflow-hidden animate-slide-up"
      >
        {/* 弹窗头部 */}
        <div className="h-13 px-5 flex items-center justify-between border-b border-black/[0.05] bg-slate-50/50">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-200/50">
              <Activity className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-xs font-bold text-slate-800">全链路播放与增强诊断</h3>
              <p className="text-[10px] text-slate-400">会话 ID: #{sessionId}</p>
            </div>
          </div>
          <button
            onClick={() => toggleDiagnostics(false)}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 核心指标栅格 */}
        <div className="p-5 flex flex-col gap-4 text-xs">
          {/* 渲染与插帧实时面板 */}
          <div className="p-3.5 rounded-xl bg-gradient-to-br from-blue-50/50 to-indigo-50/30 border border-blue-100/70 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-700 flex items-center gap-1.5 text-xs">
                <Zap className="w-3.5 h-3.5 text-blue-600" />
                画质增强与插帧引擎
              </span>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-600 text-white shadow-sm">
                {enhState.kind === 'running' ? '运行中 (ACTIVE)' : '关闭'}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2 pt-1 text-center">
              <div className="p-2 bg-white/90 rounded-lg border border-slate-200/60 shadow-xs">
                <div className="text-[10px] text-slate-400">输出帧率</div>
                <div className="text-sm font-bold text-blue-600 font-mono mt-0.5">
                  {currentFps} <span className="text-[9px] font-normal text-slate-400">FPS</span>
                </div>
              </div>
              <div className="p-2 bg-white/90 rounded-lg border border-slate-200/60 shadow-xs">
                <div className="text-[10px] text-slate-400">原生解码</div>
                <div className="text-sm font-bold text-slate-700 font-mono mt-0.5">
                  {decodeFps} <span className="text-[9px] font-normal text-slate-400">FPS</span>
                </div>
              </div>
              <div className="p-2 bg-white/90 rounded-lg border border-slate-200/60 shadow-xs">
                <div className="text-[10px] text-slate-400">处理延迟</div>
                <div className="text-sm font-bold text-emerald-600 font-mono mt-0.5">
                  {latencyMs} <span className="text-[9px] font-normal text-slate-400">ms</span>
                </div>
              </div>
            </div>
          </div>

          {/* 详细指标清单 */}
          <div className="grid grid-cols-2 gap-2.5">
            <div className="p-3 rounded-xl bg-slate-50/70 border border-slate-200/60 flex items-center gap-2.5">
              <Wifi className="w-4 h-4 text-emerald-500" />
              <div>
                <p className="text-[10px] text-slate-400">网络缓冲余量</p>
                <p className="font-semibold text-slate-800 font-mono">
                  {bufferSecondsAhead.toFixed(1)} 秒
                </p>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-slate-50/70 border border-slate-200/60 flex items-center gap-2.5">
              <ShieldCheck className="w-4 h-4 text-blue-500" />
              <div>
                <p className="text-[10px] text-slate-400">丢帧计数</p>
                <p className="font-semibold text-slate-800 font-mono">
                  {droppedFrames} 帧 (0.00%)
                </p>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-slate-50/70 border border-slate-200/60 flex items-center gap-2.5">
              <Cpu className="w-4 h-4 text-purple-500" />
              <div className="truncate">
                <p className="text-[10px] text-slate-400">显卡设备探测</p>
                <p className="font-semibold text-slate-800 truncate" title={capabilities?.gpuName}>
                  {capabilities?.gpuName || 'DirectX 12 硬件加速'}
                </p>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-slate-50/70 border border-slate-200/60 flex items-center gap-2.5">
              <HardDrive className="w-4 h-4 text-amber-500" />
              <div>
                <p className="text-[10px] text-slate-400">播放器渲染模式</p>
                <p className="font-semibold text-slate-800">
                  D3D11 共享纹理模式
                </p>
              </div>
            </div>
          </div>

          {/* 剧集与来源诊断 */}
          <div className="px-3 py-2 rounded-lg bg-slate-100/60 border border-slate-200/50 text-[11px] text-slate-500 flex items-center justify-between">
            <span className="truncate">当前：{currentSeries?.title} - {currentEpisode?.title}</span>
            <span className="font-mono text-[10px] text-slate-400">
              {position.toFixed(0)}s / {duration.toFixed(0)}s
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
