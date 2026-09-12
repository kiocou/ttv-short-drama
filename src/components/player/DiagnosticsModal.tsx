import React, { useEffect, useState } from 'react';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { useEnhancementStore } from '../../stores/useEnhancementStore';
import { X, Activity, Cpu, HardDrive, Wifi, ShieldCheck, Zap } from 'lucide-react';

/** WebView 真正能测到的播放指标。 */
interface LiveStats {
  fps: number;
  decoded: number;
  dropped: number;
  width: number;
  height: number;
  source: string;
}

const EMPTY_LIVE: LiveStats = { fps: 0, decoded: 0, dropped: 0, width: 0, height: 0, source: '—' };

/** 主播放器元素（本应用常驻且唯一）。 */
type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
  getVideoPlaybackQuality?: () => { totalVideoFrames: number; droppedVideoFrames: number };
};

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

  const { uiState: enhState, capabilities } = useEnhancementStore();

  // 指标直接从 <video> 采样，而不是读增强引擎的状态。
  //
  // 原因：本项目尚未接入任何补帧 SDK，后端上报的 actual_fps / 丢帧恒为空
  // （旧面板因此常年显示 0，还叠加了写死的 "0.00%" 与 "D3D11 共享纹理模式"
  // ——渲染实际是 WebView2 原生 <video>）。这里改为展示真正可测量的事实。
  const [live, setLive] = useState<LiveStats>(EMPTY_LIVE);
  useEffect(() => {
    if (!isDiagnosticsOpen) return;
    const video = document.querySelector('video') as FrameVideo | null;
    if (!video) return;
    let frames = 0;
    let handle = 0;
    let last = performance.now();
    if (video.requestVideoFrameCallback) {
      const onFrame = () => {
        frames += 1;
        handle = video.requestVideoFrameCallback?.(onFrame) ?? 0;
      };
      handle = video.requestVideoFrameCallback(onFrame);
    }
    const timer = setInterval(() => {
      const now = performance.now();
      const elapsedSeconds = (now - last) / 1000;
      const quality = video.getVideoPlaybackQuality?.();
      setLive({
        fps: elapsedSeconds > 0 ? frames / elapsedSeconds : 0,
        decoded: quality ? quality.totalVideoFrames : 0,
        dropped: quality ? quality.droppedVideoFrames : 0,
        width: video.videoWidth,
        height: video.videoHeight,
        source: video.src.startsWith('http://asset.localhost') ? '本地解密文件' : '网络直链',
      });
      frames = 0;
      last = now;
    }, 1000);
    return () => {
      clearInterval(timer);
      if (handle && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handle);
    };
  }, [isDiagnosticsOpen]);

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
                <div className="text-[10px] text-slate-400">实时帧率</div>
                <div className="text-sm font-bold text-blue-600 font-mono mt-0.5">
                  {live.fps.toFixed(1)} <span className="text-[9px] font-normal text-slate-400">FPS</span>
                </div>
              </div>
              <div className="p-2 bg-white/90 rounded-lg border border-slate-200/60 shadow-xs">
                <div className="text-[10px] text-slate-400">已解码帧</div>
                <div className="text-sm font-bold text-slate-700 font-mono mt-0.5">
                  {live.decoded}
                </div>
              </div>
              <div className="p-2 bg-white/90 rounded-lg border border-slate-200/60 shadow-xs">
                <div className="text-[10px] text-slate-400">画面尺寸</div>
                <div className="text-[11px] font-bold text-emerald-600 font-mono mt-1">
                  {live.width && live.height ? `${live.width}×${live.height}` : '—'}
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
                  {live.dropped} 帧
                  {live.decoded > 0 ? ` (${((live.dropped / live.decoded) * 100).toFixed(2)}%)` : ''}
                </p>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-slate-50/70 border border-slate-200/60 flex items-center gap-2.5">
              <Cpu className="w-4 h-4 text-purple-500" />
              <div className="truncate">
                <p className="text-[10px] text-slate-400">显卡设备探测</p>
                <p className="font-semibold text-slate-800 truncate" title={capabilities?.gpuName}>
                  {capabilities?.gpuName || '未探测'}
                </p>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-slate-50/70 border border-slate-200/60 flex items-center gap-2.5">
              <HardDrive className="w-4 h-4 text-amber-500" />
              <div>
                <p className="text-[10px] text-slate-400">片源类型</p>
                <p className="font-semibold text-slate-800">
                  {live.source}
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
