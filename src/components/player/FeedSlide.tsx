import React from 'react';
import type { SeriesItem } from '../../types/catalog';

interface FeedSlideProps {
  series: SeriesItem | null;
  episodeNumber: number;
  episodeTitle: string;
}

export const FeedSlide: React.FC<FeedSlideProps> = ({ series, episodeNumber, episodeTitle }) => {
  if (!series) return null;
  const titleTail = episodeTitle.replace(/^第\s*\d+\s*集\s*[·：:—-]?\s*/, '').trim();
  const description = series.brief?.trim();

  return (
    <section
      className="pointer-events-none absolute inset-x-0 bottom-32 z-20 px-5 sm:px-8"
      aria-label="当前短剧"
      aria-live="polite"
    >
      <div className="max-w-[min(32rem,calc(100vw-9rem))] text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.95)]">
        <h1 className="line-clamp-2 text-lg font-bold leading-6">{series.title}</h1>
        <p className="mt-1 text-xs font-medium text-white/85">
          第 {episodeNumber} 集{titleTail ? ` · ${titleTail}` : ''}{series.episodesCount > 0 ? ` · 共 ${series.episodesCount} 集` : ''}
        </p>
        {description && <p className="mt-2 line-clamp-2 text-xs leading-5 text-white/90">{description}</p>}
        {series.tags.length > 0 && (
          <p className="mt-1.5 line-clamp-1 text-[11px] text-white/75">{series.tags.slice(0, 3).join(' · ')}</p>
        )}
      </div>
    </section>
  );
};
