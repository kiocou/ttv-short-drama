import React, { useState } from 'react';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { X, Play, CheckCircle2, Search, Layers } from 'lucide-react';

export const EpisodeDrawer: React.FC = () => {
  const {
    currentSeries,
    currentEpisode,
    isSideDrawerOpen,
    toggleSideDrawer,
    openEpisode,
  } = usePlaybackStore();

  const [filterKeyword, setFilterKeyword] = useState('');
  const [activeGroupIndex, setActiveGroupIndex] = useState(0);

  if (!isSideDrawerOpen || !currentSeries) return null;

  const totalEpisodes = currentSeries.episodes.length;
  const pageSize = 50;
  const totalGroups = Math.ceil(totalEpisodes / pageSize);

  // 分组切片
  const groupStart = activeGroupIndex * pageSize;
  const groupEnd = Math.min(groupStart + pageSize, totalEpisodes);
  let currentGroupEpisodes = currentSeries.episodes.slice(groupStart, groupEnd);

  if (filterKeyword.trim()) {
    const kw = filterKeyword.toLowerCase();
    currentGroupEpisodes = currentSeries.episodes.filter(
      ep => ep.title.toLowerCase().includes(kw) || ep.episodeNumber.toString() === kw
    );
  }

  return (
    <div 
      onClick={() => toggleSideDrawer(false)}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/55 backdrop-blur-sm animate-fade-in select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-4xl max-h-[85vh] rounded-3xl bg-white/90 backdrop-blur-2xl border border-white shadow-fluent-hud flex flex-col overflow-hidden animate-slide-up"
      >
        {/* 弹窗顶部栏 */}
        <div className="h-14 px-6 flex items-center justify-between border-b border-black/[0.05] bg-slate-50/70 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-200/60 shadow-xs">
              <Layers className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-slate-800">
                  选集播放
                </h3>
                <span className="text-[10px] font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full border border-blue-200/50">
                  共 {totalEpisodes} 集
                </span>
              </div>
              <p className="text-[11px] text-slate-400 truncate max-w-xs sm:max-w-md">
                {currentSeries.title}
              </p>
            </div>
          </div>

          {/* 快速数字搜索框与关闭按钮 */}
          <div className="flex items-center gap-3">
            <div className="relative w-44 sm:w-52">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
              <input
                type="text"
                value={filterKeyword}
                onChange={(e) => setFilterKeyword(e.target.value)}
                placeholder="搜索集数，例如 12..."
                className="w-full h-8 pl-8 pr-7 text-xs bg-white rounded-lg border border-slate-200/80 focus:outline-none focus:border-blue-500 shadow-xs"
              />
              {filterKeyword && (
                <button
                  type="button"
                  onClick={() => setFilterKeyword('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5 cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={() => toggleSideDrawer(false)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
              title="关闭窗口"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 分组药丸 (1-50, 51-100...) */}
        {!filterKeyword && totalGroups > 1 && (
          <div className="px-6 py-2.5 border-b border-black/[0.04] bg-slate-50/40 flex-shrink-0">
            <div className="p-1 bg-slate-100/80 rounded-xl border border-slate-200/60 inline-flex gap-1 overflow-x-auto max-w-full">
              {Array.from({ length: totalGroups }).map((_, idx) => {
                const start = idx * pageSize + 1;
                const end = Math.min((idx + 1) * pageSize, totalEpisodes);
                const isActive = activeGroupIndex === idx;

                return (
                  <button
                    key={idx}
                    onClick={() => setActiveGroupIndex(idx)}
                    className={`px-3 py-1 rounded-lg text-xs font-semibold whitespace-nowrap transition-all cursor-pointer ${
                      isActive
                        ? 'bg-white text-blue-600 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
                    }`}
                  >
                    {start}-{end}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* 弹窗内容：扁平化集数数字瓦片网格 */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="p-3.5 bg-slate-50/70 rounded-2xl border border-slate-200/60 grid grid-cols-5 sm:grid-cols-8 md:grid-cols-10 gap-2 content-start">
            {currentGroupEpisodes.map((ep) => {
              const isPlaying = currentEpisode?.id === ep.id;
              const hasProgress = (ep.watchedSeconds || 0) > 0;

              return (
                <button
                  key={ep.id}
                  type="button"
                  onClick={() => {
                    openEpisode(currentSeries.id, ep.id, 0);
                    toggleSideDrawer(false);
                  }}
                  title={`第 ${ep.episodeNumber} 集 · ${ep.title}${isPlaying ? ' (当前播放)' : ep.isFinished ? ' (已看完)' : ''}`}
                  className={`group relative h-10 rounded-xl flex items-center justify-center transition-all duration-150 cursor-pointer ${
                    isPlaying
                      ? 'bg-blue-600 text-white font-bold shadow-sm shadow-blue-500/25'
                      : 'bg-white hover:bg-blue-50/80 text-slate-700 hover:text-blue-600 border border-slate-200/70 hover:border-blue-300 shadow-xs'
                  }`}
                >
                  <span className={`text-xs ${isPlaying ? 'font-black' : 'font-bold'}`}>
                    {ep.episodeNumber}
                  </span>

                  {/* 正在播放中脉冲指示 */}
                  {isPlaying && (
                    <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-emerald-400 ring-2 ring-white animate-ping" />
                  )}

                  {/* 已看完：绿色右上角徽章 */}
                  {ep.isFinished && !isPlaying && (
                    <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-emerald-500 ring-2 ring-white" />
                  )}

                  {/* 观看中：底部蓝色小进度条 */}
                  {hasProgress && !ep.isFinished && !isPlaying && (
                    <span className="absolute bottom-1 inset-x-2 h-0.5 bg-blue-500 rounded-full" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
