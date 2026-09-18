import React, { useEffect, useState } from 'react';
import { useFavorites } from '../../stores/useFavoritesStore';
import { useAppStore } from '../../stores/useAppStore';
import { FAVORITE_MARK_LABEL, FavoriteMark } from '../../types/favorite';
import { MicaCard } from '../common/MicaCard';
import { FluentButton } from '../common/FluentButton';
import {
  Heart,
  Play,
  Trash2,
  Bookmark,
  Eye,
  CheckCircle2,
} from 'lucide-react';

/** 追剧筛选药丸：全部 / 想看 / 在看 / 已看。 */
const MARK_FILTERS: Array<{ value: FavoriteMark | 'all'; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'want', label: '想看' },
  { value: 'watching', label: '在看' },
  { value: 'done', label: '已看' },
];

const MARK_ICONS: Record<FavoriteMark, React.ComponentType<{ className?: string }>> = {
  want: Bookmark,
  watching: Eye,
  done: CheckCircle2,
};

export const FavoritesView: React.FC = () => {
  const { favorites, loadFavorites, setMark } = useFavorites();
  const { navigateTo } = useAppStore();
  const [markFilter, setMarkFilter] = useState<FavoriteMark | 'all'>('all');

  // 视图常驻 DOM（切换只切 hidden），进入时重新拉取，
  // 保证详情页新标的收藏立刻出现在这里。
  useEffect(() => { void loadFavorites(); }, [loadFavorites]);

  const visible = markFilter === 'all'
    ? favorites
    : favorites.filter(item => item.mark === markFilter);

  const handleResume = (seriesId: string) => {
    // 收藏页不保存分集进度（那是历史记录的职责），直接进详情页续播。
    navigateTo('detail', seriesId);
  };

  return (
    <div className="flex-1 h-full overflow-y-auto p-8 max-w-5xl mx-auto flex flex-col gap-6 select-none">
      {/* 头部 */}
      <div className="flex items-center justify-between pb-4 border-b border-black/[0.05]">
        <div>
          <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <Heart className="w-5 h-5 text-rose-500" />
            <span>我的追剧</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            想看、在看、已看三档追剧清单，与观看历史相互独立
          </p>
        </div>
      </div>

      {/* 状态筛选药丸 */}
      {favorites.length > 0 && (
        <div className="ttv-chips">
          {MARK_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              onClick={() => setMarkFilter(filter.value)}
              className={`ttv-chip${markFilter === filter.value ? ' is-active' : ''}`}
            >
              {filter.label}
            </button>
          ))}
        </div>
      )}

      {visible.length === 0 ? (
        <div className="py-24 flex flex-col items-center justify-center text-center gap-3">
          <img src="/app-icon.png" alt="" className="w-14 h-14 object-contain opacity-60" draggable={false} />
          <p className="text-sm font-semibold text-slate-700">
            {favorites.length === 0
              ? (markFilter === 'all' ? '还没有追剧收藏' : `暂无「${FAVORITE_MARK_LABEL[markFilter]}」的剧`)
              : '没有匹配的追剧记录'}
          </p>
          <p className="text-xs text-slate-400">在剧集详情页点击收藏，即可加入对应清单</p>
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
      ) : (
        <div className="flex flex-col gap-3">
          {visible.map((item, index) => {
            const MarkIcon = MARK_ICONS[item.mark];
            return (
              <MicaCard
                key={item.seriesId}
                hoverable
                style={{ animationDelay: `${Math.min(index * 30, 240)}ms` }}
                className="p-4 flex items-center justify-between gap-4 animate-fluent-card-in group"
              >
                <div className="flex items-center gap-4 min-w-0">
                  {/* 封面缩略图 */}
                  <div
                    onClick={() => handleResume(item.seriesId)}
                    className="relative w-16 h-22 rounded-xl overflow-hidden shadow-sm flex-shrink-0 cursor-pointer group-hover:scale-105 transition-transform duration-300"
                  >
                    <img
                      src={item.cover}
                      alt={item.title}
                      className="w-full h-full object-cover"
                    />
                    <div className="absolute inset-0 bg-black/20 group-hover:bg-black/40 flex items-center justify-center transition-colors">
                      <Play className="w-5 h-5 text-white fill-current opacity-80 group-hover:opacity-100 transform group-hover:scale-110 transition-transform" />
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3
                        onClick={() => navigateTo('detail', item.seriesId)}
                        className="text-sm font-bold text-slate-900 truncate hover:text-blue-600 cursor-pointer transition-colors"
                      >
                        {item.title}
                      </h3>
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-rose-50 text-rose-600 border border-rose-200/60 flex items-center gap-1">
                        <MarkIcon className="w-2.5 h-2.5" />
                        {FAVORITE_MARK_LABEL[item.mark]}
                      </span>
                    </div>
                    <span className="text-xs text-slate-400">
                      {item.channel === 'comic' ? '漫剧专享' : item.channel === 'anime' ? '动漫专区' : '短剧爆款'}
                    </span>
                  </div>
                </div>

                {/* 行动点：切换状态 / 取消收藏 */}
                <div className="p-1 bg-slate-100/80 rounded-xl border border-slate-200/60 shadow-inner flex items-center gap-1.5 flex-shrink-0">
                  {item.mark !== 'watching' && (
                    <FluentButton
                      variant="secondary"
                      size="sm"
                      icon={<Eye className="w-3.5 h-3.5" />}
                      onClick={() => void setMark(item.seriesId, item.title, item.cover, 'watching', item.channel)}
                      className="shadow-sm"
                    >
                      在看
                    </FluentButton>
                  )}
                  {item.mark !== 'done' && (
                    <FluentButton
                      variant="primary"
                      size="sm"
                      icon={<CheckCircle2 className="w-3.5 h-3.5" />}
                      onClick={() => void setMark(item.seriesId, item.title, item.cover, 'done', item.channel)}
                      className="shadow-sm"
                    >
                      已看
                    </FluentButton>
                  )}
                  <button
                    onClick={() => {
                      void setMark(item.seriesId, item.title, item.cover, null, item.channel);
                    }}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-white/80 transition-colors cursor-pointer"
                    title="取消收藏"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </MicaCard>
            );
          })}
        </div>
      )}
    </div>
  );
};
