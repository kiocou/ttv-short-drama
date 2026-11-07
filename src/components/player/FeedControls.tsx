import React from 'react';
import {
  ArrowLeft,
  Bookmark,
  Check,
  ChevronUp,
  ChevronDown,
  LoaderCircle,
  Shuffle,
} from 'lucide-react';
import type { FavoriteMark } from '../../types/favorite';

interface FeedControlsProps {
  episodeIndex: number;
  episodeCount: number;
  favoriteMark?: FavoriteMark;
  busy: boolean;
  canSwitchSeries: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onSwitchSeries: () => void;
  onToggleFavorite: () => void;
  onClose: () => void;
}

const ACTION_CLASS =
  'flex min-h-12 min-w-12 flex-col items-center justify-center gap-1 rounded-xl px-2 text-white drop-shadow-lg transition-colors hover:bg-black/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/90 disabled:cursor-not-allowed disabled:opacity-45';

export const FeedControls: React.FC<FeedControlsProps> = ({
  episodeIndex,
  episodeCount,
  favoriteMark,
  busy,
  canSwitchSeries,
  onPrevious,
  onNext,
  onSwitchSeries,
  onToggleFavorite,
  onClose,
}) => (
  <>
    <div className="pointer-events-auto absolute right-3 top-1/2 z-50 flex -translate-y-1/2 flex-col items-center gap-2 sm:right-5">
      <button
        type="button"
        className={ACTION_CLASS}
        onClick={onPrevious}
        disabled={busy || episodeIndex <= 0}
        aria-label="上一集"
        title="上一集"
      >
        <ChevronDown className="h-6 w-6" />
        <span className="text-[10px] font-semibold">上一集</span>
      </button>
      <button
        type="button"
        className={ACTION_CLASS}
        onClick={onNext}
        disabled={busy || episodeCount === 0}
        aria-label="下一集"
        title="下一集"
      >
        <ChevronUp className="h-6 w-6" />
        <span className="text-[10px] font-semibold">下一集</span>
      </button>
      <button
        type="button"
        className={ACTION_CLASS}
        onClick={onToggleFavorite}
        aria-label={favoriteMark ? '取消追剧收藏' : '加入追剧收藏'}
        aria-pressed={Boolean(favoriteMark)}
        title={favoriteMark ? '取消追剧收藏' : '加入追剧收藏'}
      >
        <span className="relative">
          <Bookmark className="h-6 w-6" fill={favoriteMark ? 'currentColor' : 'none'} />
          {favoriteMark && <Check className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-emerald-500 p-0.5 text-white" />}
        </span>
        <span className="text-[10px] font-semibold">{favoriteMark ? '已追剧' : '追剧'}</span>
      </button>
      <button
        type="button"
        className={ACTION_CLASS}
        onClick={onSwitchSeries}
        disabled={busy || !canSwitchSeries}
        aria-label="换一部短剧"
        title="换一部短剧"
      >
        {busy ? <LoaderCircle className="h-6 w-6 animate-spin" /> : <Shuffle className="h-6 w-6" />}
        <span className="text-[10px] font-semibold">换一部</span>
      </button>
    </div>
    <button
      type="button"
      onClick={onClose}
      className="pointer-events-auto absolute left-4 top-4 z-50 flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-black/35 text-white shadow-lg transition-colors hover:bg-black/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/90"
      aria-label="返回短剧精选"
      title="返回短剧精选"
    >
      <ArrowLeft className="h-5 w-5" />
    </button>
  </>
);
