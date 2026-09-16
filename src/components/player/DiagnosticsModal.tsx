import React, { useEffect, useState } from 'react';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { X, Activity, Cpu, HardDrive, Wifi, ShieldCheck } from 'lucide-react';

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


  // 指标直接从 <video> 采样：后端没有增强引擎上报的 actual_fps / 丢帧，
  // 这里展示的是真正可测量的事实。
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
              <h3 className="text-xs font-bold text-slate-800">全链路播放诊断</h3>
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
