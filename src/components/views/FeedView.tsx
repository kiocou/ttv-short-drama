import React, { useEffect, useRef } from 'react';
import { LoaderCircle } from 'lucide-react';
import { feedGestureDirection } from '../../services/feedSource';
import { useAppStore } from '../../stores/useAppStore';
import { useFeedStore } from '../../stores/useFeedStore';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { FeedControls } from '../player/FeedControls';
import { FeedSlide } from '../player/FeedSlide';

const isInteractiveTarget = (target: EventTarget | null): boolean => (
  target instanceof Element
  && Boolean(target.closest('button, input, select, textarea, [role="slider"], .crystal-flyout, [data-feed-no-swipe]'))
);

const FeedCompletionBridge: React.FC<{ onFinished: (sessionId: number) => void }> = ({ onFinished }) => {
  const { finishedAll, sessionId } = usePlaybackStore();
  const handledSession = useRef<number | null>(null);

  useEffect(() => {
    if (!finishedAll) {
      handledSession.current = null;
      return;
    }
    if (handledSession.current === sessionId) return;
    handledSession.current = sessionId;
    onFinished(sessionId);
  }, [finishedAll, onFinished, sessionId]);

  return null;
};

export const FeedView: React.FC = () => {
  const { currentView } = useAppStore();
  const feed = useFeedStore();
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const active = currentView === 'feed';
  const busy = feed.isLoading || feed.isOpening || feed.isLoadingMore;
  const canSwitchSeries = feed.currentIndex + 1 < feed.items.length || feed.hasMore;
  const displaySeries = feed.currentItem && feed.detail
    ? { ...feed.currentItem, brief: feed.detail.description, episodesCount: feed.detail.episodesCount }
    : null;

  useEffect(() => {
    if (active) titleRef.current?.focus({ preventScroll: true });
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const start = { x: 0, y: 0, valid: false };
    let lastGestureAt = 0;
    let suppressVideoClick = false;
    let clearSuppressedClick: number | undefined;
    const trigger = (deltaX: number, deltaY: number, event?: Event, suppressClick = false) => {
      const direction = feedGestureDirection(deltaX, deltaY);
      if (!direction || Date.now() - lastGestureAt < 550) return;
      lastGestureAt = Date.now();
      event?.preventDefault();
      if (suppressClick) {
        suppressVideoClick = true;
        window.clearTimeout(clearSuppressedClick);
        clearSuppressedClick = window.setTimeout(() => { suppressVideoClick = false; }, 500);
      }
      if (direction === 'next') feed.nextEpisode();
      else feed.previousEpisode();
    };
    const onClickCapture = (event: MouseEvent) => {
      if (!suppressVideoClick || !(event.target instanceof HTMLVideoElement)) return;
      suppressVideoClick = false;
      window.clearTimeout(clearSuppressedClick);
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onWheel = (event: WheelEvent) => {
      if (isInteractiveTarget(event.target)) return;
      trigger(event.deltaX, event.deltaY, event);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || isInteractiveTarget(event.target)) {
        start.valid = false;
        return;
      }
      start.x = event.clientX;
      start.y = event.clientY;
      start.valid = true;
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!start.valid) return;
      start.valid = false;
      trigger(event.clientX - start.x, event.clientY - start.y, undefined, true);
    };
    const onPointerCancel = () => {
      start.valid = false;
    };
    const onTouchStart = (event: TouchEvent) => {
      if (isInteractiveTarget(event.target) || event.touches.length !== 1) {
        start.valid = false;
        return;
      }
      start.x = event.touches[0].clientX;
      start.y = event.touches[0].clientY;
      start.valid = true;
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (!start.valid || event.changedTouches.length === 0) return;
      start.valid = false;
      trigger(event.changedTouches[0].clientX - start.x, event.changedTouches[0].clientY - start.y, undefined, true);
    };

    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('click', onClickCapture, true);
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('click', onClickCapture, true);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchend', onTouchEnd);
      window.clearTimeout(clearSuppressedClick);
    };
  }, [active, feed.nextEpisode, feed.previousEpisode]);

  return (
    <div
      className={`absolute inset-0 z-50 overflow-hidden ${active ? 'block' : 'hidden'}`}
      style={{ pointerEvents: 'none', touchAction: 'pan-x' }}
      aria-hidden={!active}
      inert={!active}
    >
      {active && <FeedCompletionBridge onFinished={feed.advanceAfterFinished} />}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-24 bg-gradient-to-b from-black/65 to-transparent" aria-hidden="true" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-48 bg-gradient-to-t from-black/70 to-transparent" aria-hidden="true" />

      <div className="pointer-events-none absolute left-[4.5rem] top-4 z-50">
        <h1
          ref={titleRef}
          tabIndex={-1}
          className="text-sm font-bold text-white drop-shadow-lg focus:outline-none"
        >
          短剧推荐
        </h1>
      </div>
      <div
        className="pointer-events-auto absolute right-4 top-4 z-50 flex items-center gap-1 rounded-xl border border-white/20 bg-black/40 p-1 shadow-lg"
        role="group"
        aria-label="推荐频道"
        data-feed-no-swipe
      >
        <button
          type="button"
          onClick={() => feed.selectChannel('drama')}
          aria-pressed={feed.channel === 'drama'}
          className={`h-8 min-w-14 rounded-lg px-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/90 ${feed.channel === 'drama' ? 'bg-white text-slate-900' : 'text-white hover:bg-white/15'}`}
        >
          短剧
        </button>
        <button
          type="button"
          onClick={() => feed.selectChannel('comic')}
          aria-pressed={feed.channel === 'comic'}
          className={`h-8 min-w-14 rounded-lg px-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/90 ${feed.channel === 'comic' ? 'bg-white text-slate-900' : 'text-white hover:bg-white/15'}`}
        >
          漫剧
        </button>
      </div>

      <FeedSlide
        series={displaySeries}
        episodeNumber={feed.detail?.episodes[feed.episodeIndex]?.episodeNumber ?? feed.episodeIndex + 1}
        episodeTitle={feed.detail?.episodes[feed.episodeIndex]?.title ?? ''}
      />
      <FeedControls
        episodeIndex={feed.episodeIndex}
        episodeCount={feed.detail?.episodes.length ?? 0}
        favoriteMark={feed.favoriteMark}
        busy={busy}
        canSwitchSeries={canSwitchSeries}
        onPrevious={feed.previousEpisode}
        onNext={feed.nextEpisode}
        onSwitchSeries={feed.switchSeries}
        onToggleFavorite={feed.toggleFavorite}
        onClose={feed.close}
      />

      {(feed.error || feed.isCompleted || (feed.isLoading && !feed.detail)) && (
        <div className="pointer-events-auto absolute inset-0 z-[60] flex items-center justify-center bg-black/25 px-5" role="status" aria-live="polite">
          <div className="flex max-w-sm flex-col items-center gap-3 text-center text-white drop-shadow-lg">
            {feed.isLoading && !feed.detail && !feed.error ? (
              <LoaderCircle className="h-7 w-7 animate-spin" aria-label="正在加载推荐" />
            ) : (
              <>
                <p className="text-sm font-semibold">{feed.error || '当前短剧已播放完成'}</p>
                <div className="flex items-center gap-2">
                  {canSwitchSeries && (
                    <button
                      type="button"
                      onClick={feed.switchSeries}
                      className="rounded-lg bg-white px-3 py-2 text-xs font-bold text-slate-900 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/90"
                    >
                      换一部
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={feed.retry}
                    className="rounded-lg border border-white/35 bg-black/35 px-3 py-2 text-xs font-semibold text-white transition hover:bg-black/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/90"
                  >
                    {feed.isCompleted ? '重播' : '重试'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
