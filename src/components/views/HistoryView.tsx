import React, { useEffect, useState } from 'react';
import { useHistoryStore } from '../../stores/useHistoryStore';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { useAppStore } from '../../stores/useAppStore';
import { MicaCard } from '../common/MicaCard';
import { FluentButton } from '../common/FluentButton';
import { StatusBadge } from '../common/StatusBadge';
import {
  History,
  Trash2,
  Play,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Search,
  X
} from 'lucide-react';

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}分${s}秒`;
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const hours = Math.floor(diff / (3600 * 1000));
  if (hours < 1) return '刚刚观看';
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

export const HistoryView: React.FC = () => {
  const { records, loadHistory, removeRecord, clearHistory } = useHistoryStore();
  const { openEpisode } = usePlaybackStore();
  const { currentView, navigateTo, showToast } = useAppStore();

  const [showClearConfirm, setShowClearConfirm] = useState(false);
  // 即时筛选：历史条数多了以后，翻找某部剧只能从头扫到尾。
  // 只在前端过滤，不额外打后端。
  const [filterKeyword, setFilterKeyword] = useState('');

  // 每次进入历史页都重新拉取一次。
  //
  // 视图是常驻 DOM（切换只切 hidden，不卸载），而 HistoryProvider 只在应用
  // 启动时 loadHistory 一次——于是启动之后看过的任何一集都不会出现在这里。
  // 用户看到的现象就是"某些剧的播放历史不出现"（漫剧、短剧都会中招，
  // 取决于它是不是启动前就看过）。
  useEffect(() => {
    if (currentView === 'history') void loadHistory();
  }, [currentView, loadHistory]);

  const handleResume = (seriesId: string, episodeId: string, position: number) => {
    navigateTo('player', seriesId);
    openEpisode(seriesId, episodeId, position);
  };

  const handleClearAll = async () => {
    await clearHistory();
    setShowClearConfirm(false);
    showToast('观看历史已全部清空', 'info');
  };

  const keyword = filterKeyword.trim().toLowerCase();
  const visibleRecords = keyword
    ? records.filter(item => item.title.toLowerCase().includes(keyword))
    : records;

  return (
    <div className="flex-1 h-full overflow-y-auto p-8 max-w-5xl mx-auto flex flex-col gap-6 select-none">
      {/* 头部：标题与清空按钮 */}
      <div className="flex items-center justify-between pb-4 border-b border-black/[0.05]">
        <div>
          <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <History className="w-5 h-5 text-blue-600" />
            <span>观看历史记录</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            按最近观看时间排序，支持一键断点续播与无感进度同步
          </p>
        </div>

        {records.length > 0 && (
          <div className="flex items-center gap-3">
            {/* 即时搜索：按剧名筛选历史记录 */}
            <div className="relative w-52">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
              <input
                type="text"
                value={filterKeyword}
                onChange={(e) => setFilterKeyword(e.target.value)}
                placeholder="搜索看过的剧..."
                aria-label="搜索历史记录"
                className="w-full h-8 pl-8 pr-7 text-xs bg-white rounded-lg border border-slate-200/80 focus:outline-none focus:border-blue-500 shadow-xs"
              />
              {filterKeyword && (
                <button
                  type="button"
                  onClick={() => setFilterKeyword('')}
                  aria-label="清除搜索"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="p-1 bg-slate-100/90 rounded-xl border border-slate-200/70 shadow-inner inline-flex">
              <FluentButton
                variant="danger"
                size="sm"
                icon={<Trash2 className="w-3.5 h-3.5" />}
                onClick={() => setShowClearConfirm(true)}
                className="shadow-sm"
              >
                清空历史
              </FluentButton>
            </div>
          </div>
        )}
      </div>

      {/* 历史记录列表 */}
      {records.length === 0 ? (
        <div className="py-24 flex flex-col items-center justify-center text-center gap-3">
          <img src="/app-icon.png" alt="" className="w-14 h-14 object-contain opacity-60" draggable={false} />
          <p className="text-sm font-semibold text-slate-700">暂无观看历史</p>
          <p className="text-xs text-slate-400">在发现页寻找心仪短剧开启追剧体验吧</p>
          <div className="p-1 bg-slate-100/90 rounded-xl border border-slate-200/70 shadow-inner inline-flex mt-2">
            <FluentButton
              variant="primary"
              size="sm"
              onClick={() => navigateTo('explore')}
              className="shadow-sm"
            >
              前往发现精选
            </FluentButton>
          </div>
        </div>
      ) : visibleRecords.length === 0 ? (
        <div className="py-24 flex flex-col items-center justify-center text-center gap-3">
          <img src="/app-icon.png" alt="" className="w-14 h-14 object-contain opacity-60" draggable={false} />
          <p className="text-sm font-semibold text-slate-700">
            {keyword ? `没有匹配「${filterKeyword.trim()}」的历史记录` : '暂无观看历史'}
          </p>
          <p className="text-xs text-slate-400">
            {keyword ? '换个关键词试试，或清除筛选查看全部' : '在发现页寻找心仪短剧开启追剧体验吧'}
          </p>
          {!keyword && (
            <div className="p-1 bg-slate-100/90 rounded-xl border border-slate-200/70 shadow-inner inline-flex mt-2">
              <FluentButton
                variant="primary"
                size="sm"
                onClick={() => navigateTo('explore')}
                className="shadow-sm"
              >
                前往发现精选
              </FluentButton>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {visibleRecords.map((item, index) => (
            <MicaCard
              key={`${item.seriesId}-${item.episodeId}`}
              hoverable
              style={{ animationDelay: `${Math.min(index * 30, 240)}ms` }}
              className="p-4 flex items-center justify-between gap-4 animate-fluent-card-in group"
            >
              <div className="flex items-center gap-4 min-w-0">
                {/* 封面缩略图 */}
                <div
                  onClick={() => handleResume(item.seriesId, item.episodeId, item.positionSeconds)}
                  className="relative w-16 h-22 rounded-xl overflow-hidden shadow-sm flex-shrink-0 cursor-pointer group-hover:scale-105 transition-transform duration-300"
                >
                  <img
                    src={item.seriesCover}
                    alt={item.title}
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute inset-0 bg-black/20 group-hover:bg-black/40 flex items-center justify-center transition-colors">
                    <Play className="w-5 h-5 text-white fill-current opacity-80 group-hover:opacity-100 transform group-hover:scale-110 transition-transform" />
                  </div>
                </div>

                {/* 详细文字信息 */}
                <div className="flex flex-col gap-1.5 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3
                      onClick={() => navigateTo('detail', item.seriesId)}
                      className="text-sm font-bold text-slate-900 truncate hover:text-blue-600 cursor-pointer transition-colors"
                    >
                      {item.title}
                    </h3>
                    {item.isFinished ? (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600 border border-emerald-200/60 flex items-center gap-1">
                        <CheckCircle2 className="w-2.5 h-2.5" /> 已看完
                      </span>
                    ) : (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-200/60">
                        看到第 {item.episodeNumber} 集
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-3 text-xs text-slate-400">
                    <span>
                  进度：
                  {item.durationSeconds > 0
                    ? `${formatDuration(item.positionSeconds)} / ${formatDuration(item.durationSeconds)}`
                    /* 时长拿不到（分片 MP4 报 Infinity）时，仍然如实显示"看到哪儿"，
                       而不是一句"尚未开始播放"——位置是有效信息，不该被时长拖累。 */
                    : item.positionSeconds > 0
                      ? `已看 ${formatDuration(item.positionSeconds)}`
                      : '尚未开始播放'}
                </span>
                    <span>·</span>
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {formatRelativeTime(item.updatedAt)}
                    </span>
                  </div>

                  {/* 进度条 */}
                  <div className="w-48 h-1.5 bg-slate-200/70 rounded-full overflow-hidden mt-0.5">
                    <div
                      className="h-full bg-blue-600 rounded-full"
                      style={{ width: `${item.progressPercent}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* 右侧行动点 (嵌入式操作底座) */}
              <div className="p-1 bg-slate-100/80 rounded-xl border border-slate-200/60 shadow-inner flex items-center gap-1.5 flex-shrink-0">
                <FluentButton
                  variant="primary"
                  size="sm"
                  icon={<Play className="w-3 h-3 fill-current" />}
                  onClick={() => handleResume(item.seriesId, item.episodeId, item.positionSeconds)}
                  className="shadow-sm"
                >
                  继续播放
                </FluentButton>

                <button
                  onClick={() => removeRecord(item.seriesId)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-white/80 transition-colors cursor-pointer"
                  title="移除此条记录"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </MicaCard>
          ))}
        </div>
      )}

      {/* 清空历史二次确认弹窗 */}
      {showClearConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-fade-in">
          <div className="w-full max-w-sm rounded-3xl bg-white/95 backdrop-blur-2xl border border-white shadow-fluent-hud p-5 flex flex-col gap-4 animate-fluent-scale-in">
            <div className="flex items-center gap-3 text-amber-600">
              <div className="w-9 h-9 rounded-xl bg-amber-50 flex items-center justify-center border border-amber-200/60">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <h3 className="text-sm font-bold text-slate-800">确认清空所有历史？</h3>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">
              此操作将永久移除所有剧集的观看进度和断点记录，无法撤销。
            </p>
            <div className="flex items-center justify-end gap-2 pt-2">
              <FluentButton
                variant="secondary"
                size="sm"
                onClick={() => setShowClearConfirm(false)}
              >
                取消
              </FluentButton>
              <FluentButton
                variant="danger"
                size="sm"
                onClick={handleClearAll}
              >
                确认清空
              </FluentButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
