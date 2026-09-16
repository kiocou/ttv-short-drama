import React, { useState, useRef, useEffect } from 'react';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { X, CheckCircle2, Search, Layers } from 'lucide-react';

/**
 * 选集巨幕。
 *
 * 与设计稿的差异：稿子里是把 80 个按钮一次性铺满网格；这里保留了项目原有的
 * 三项能力——分组分页（几十上百集时首屏不必渲染全部）、集数搜索、悬停预热，
 * 只把外观换成晶体材质。功能与视觉不冲突，没有理由为了还原外观而砍掉它们。
 */
export const EpisodeDrawer: React.FC = () => {
  const {
    currentSeries,
    currentEpisode,
    isSideDrawerOpen,
    toggleSideDrawer,
    openEpisode,
    prewarmEpisode,
  } = usePlaybackStore();

  const [filterKeyword, setFilterKeyword] = useState('');
  const [activeGroupIndex, setActiveGroupIndex] = useState(0);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 悬停预热：在用户"犹豫要不要点这一集"的间隙就把该集缓存起来。
  // 必须防抖——鼠标扫过列表会在几百毫秒内触发十几次 hover，每次都起 worker
  // 会把带宽抢空，结果当前正在播的那一集反而更卡。
  const schedulePrewarm = (episodeId: string) => {
    if (!currentSeries) return;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      if (!currentSeries) return;
      prewarmEpisode(currentSeries.id, episodeId, currentSeries.type === 'comic' ? 1004 : 1);
    }, 420);
  };

  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }, []);

  // 关闭时一并清掉搜索词：下次打开看到的是全部集数，而不是上次的过滤结果。
  const isOpen = isSideDrawerOpen && !!currentSeries;
  useEffect(() => {
    if (!isSideDrawerOpen) setFilterKeyword('');
  }, [isSideDrawerOpen]);

  if (!currentSeries) return null;

  const totalEpisodes = currentSeries.episodes.length;
  const pageSize = 50;
  const totalGroups = Math.ceil(totalEpisodes / pageSize);

  // 分组切片
  const groupStart = activeGroupIndex * pageSize;
  const groupEnd = Math.min(groupStart + pageSize, totalEpisodes);
  let currentGroupEpisodes = currentSeries.episodes.slice(groupStart, groupEnd);

  const keyword = filterKeyword.trim().toLowerCase();
  if (keyword) {
    currentGroupEpisodes = currentSeries.episodes.filter(
      ep => ep.title.toLowerCase().includes(keyword) || ep.episodeNumber.toString() === keyword
    );
  }

  return (
    <div
      onClick={() => toggleSideDrawer(false)}
      className={`ttv-drawer-overlay${isOpen ? ' open' : ''}`}
      aria-hidden={!isOpen}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="crystal-drawer-box crystal-surface-deep"
        role="dialog"
        aria-modal="true"
        aria-label="选集播放"
      >
        {/* 顶部栏 */}
        <div className="drawer-top-header">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className="w-8 h-8 rounded-[10px] flex items-center justify-center flex-shrink-0"
              style={{
                background: 'rgba(0, 120, 212, 0.22)',
                border: '1px solid rgba(56, 189, 248, 0.35)',
                color: '#38bdf8',
              }}
            >
              <Layers className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-bold text-white">选集播放</span>
                <span
                  className="text-[10px] font-bold px-1.5 py-px rounded-full"
                  style={{
                    color: '#38bdf8',
                    background: 'rgba(0, 120, 212, 0.25)',
                    border: '1px solid rgba(56, 189, 248, 0.3)',
                  }}
                >
                  共 {totalEpisodes} 集
                </span>
              </div>
              <p className="text-[11px] text-white/60 truncate max-w-[240px]">
                {currentSeries.title}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5 flex-shrink-0">
            <div className="relative w-40 sm:w-52">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/40 pointer-events-none" />
              <input
                type="text"
                value={filterKeyword}
                onChange={(e) => setFilterKeyword(e.target.value)}
                placeholder="搜索集数，例如 12..."
                aria-label="搜索集数"
                className="ttv-field w-full pl-8 pr-7"
              />
              {filterKeyword && (
                <button
                  type="button"
                  onClick={() => setFilterKeyword('')}
                  aria-label="清除搜索"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-white/45 hover:text-white p-0.5 cursor-pointer transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={() => toggleSideDrawer(false)}
              className="btn-fluent-action"
              title="关闭 (Esc)"
              aria-label="关闭选集"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 分组药丸 (1-50, 51-100...) */}
        {!keyword && totalGroups > 1 && (
          <div className="px-6 py-2.5 flex-shrink-0 border-b border-white/10">
            <div className="ttv-chips">
              {Array.from({ length: totalGroups }).map((_, idx) => {
                const start = idx * pageSize + 1;
                const end = Math.min((idx + 1) * pageSize, totalEpisodes);
                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setActiveGroupIndex(idx)}
                    className={`ttv-chip${activeGroupIndex === idx ? ' is-active' : ''}`}
                  >
                    {start}-{end}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* 集数瓦片网格 */}
        <div className="drawer-ep-grid">
          {currentGroupEpisodes.map((ep) => {
            const isPlaying = currentEpisode?.id === ep.id;
            const hasProgress = (ep.watchedSeconds || 0) > 0;

            return (
              <button
                key={ep.id}
                type="button"
                onMouseEnter={() => schedulePrewarm(ep.id)}
                onFocus={() => schedulePrewarm(ep.id)}
                onClick={() => {
                  openEpisode(currentSeries.id, ep.id, 0);
                  toggleSideDrawer(false);
                }}
                title={`第 ${ep.episodeNumber} 集 · ${ep.title}${isPlaying ? ' (当前播放)' : ep.isFinished ? ' (已看完)' : ''}`}
                className={`ep-card-item${isPlaying ? ' active' : ''}`}
              >
                <span>{ep.episodeNumber}</span>

                {/* 正在播放中脉冲指示 */}
                {isPlaying && (
                  <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-emerald-400 ring-2 ring-[#0b1220] animate-ping" />
                )}

                {/* 已看完徽章 */}
                {ep.isFinished && !isPlaying && (
                  <CheckCircle2 className="absolute top-1 right-1 w-3 h-3 text-emerald-400" />
                )}

                {/* 观看中：底部进度提示 */}
                {hasProgress && !ep.isFinished && !isPlaying && (
                  <span className="absolute bottom-1 inset-x-2 h-0.5 bg-sky-400/80 rounded-full" />
                )}
              </button>
            );
          })}

          {currentGroupEpisodes.length === 0 && (
            <div className="col-span-full py-10 text-center text-xs text-white/50">
              没有匹配「{filterKeyword}」的集数
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
