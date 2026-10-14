import type { SeriesItem } from '../types/catalog.ts';

/**
 * 选取多元化推荐批次：包含 1 部主推剧 (hero) 和最多 3 部候选副剧 (deck)。
 * 优先选取本轮未展示过的条目，并兼顾不同题材的多样性，不再带有固定的风味硬编码分类。
 */
export function pickDiversifiedBatch(
  candidates: readonly SeriesItem[],
  shownIds: Set<string>,
  currentHeroId: string | null,
  targetDeckCount = 3,
): { hero: SeriesItem | null; deck: SeriesItem[] } {
  if (candidates.length === 0) {
    return { hero: null, deck: [] };
  }

  // 待选未展示池
  let unseen = candidates.filter(item => !shownIds.has(item.id));
  if (unseen.length < targetDeckCount + 1) {
    // 未看过的不足以填满一轮，重开一轮，保留当前主推
    shownIds.clear();
    if (currentHeroId) shownIds.add(currentHeroId);
    unseen = candidates.filter(item => item.id !== currentHeroId);
    if (unseen.length === 0) unseen = [...candidates];
  }

  // 选出主推 (Hero)，避免与当前相同
  const heroCandidates = unseen.filter(item => item.id !== currentHeroId);
  const hero = heroCandidates.length > 0
    ? heroCandidates[Math.floor(Math.random() * heroCandidates.length)]
    : unseen[0] || candidates[0];

  shownIds.add(hero.id);

  // 选出多元化备选 (Deck，最多 targetDeckCount 部)
  const remaining = candidates.filter(item => item.id !== hero.id);
  const deck: SeriesItem[] = [];
  const chosenPrimaryTags = new Set<string>();

  // 记录 hero 的主标签
  if (hero.tags && hero.tags[0]) {
    chosenPrimaryTags.add(hero.tags[0]);
  }

  // 优先选取与已选条目题材标签不重复的剧集，最大化多元化
  const sortedRemaining = [...remaining].sort((a, b) => {
    const aShown = shownIds.has(a.id) ? 1 : 0;
    const bShown = shownIds.has(b.id) ? 1 : 0;
    return aShown - bShown;
  });

  for (const item of sortedRemaining) {
    if (deck.length >= targetDeckCount) break;
    const primaryTag = item.tags?.[0];
    if (!primaryTag || !chosenPrimaryTags.has(primaryTag) || sortedRemaining.length <= targetDeckCount + 1) {
      deck.push(item);
      shownIds.add(item.id);
      if (primaryTag) chosenPrimaryTags.add(primaryTag);
    }
  }

  // 若因去重题材导致数量不足，兜底补齐
  if (deck.length < targetDeckCount) {
    for (const item of remaining) {
      if (deck.length >= targetDeckCount) break;
      if (!deck.some(d => d.id === item.id)) {
        deck.push(item);
        shownIds.add(item.id);
      }
    }
  }

  return { hero, deck };
}

/**
 * 动态提取短剧的看点导读，避免单调的“打开详情查看内容简介”
 */
export function getSeriesTeaser(item: SeriesItem): string {
  if (item.brief && item.brief.trim() && !item.brief.includes('打开详情查看内容简介')) {
    return item.brief.trim();
  }
  const tagStr = item.tags.slice(0, 3).join(' · ');
  const epStr = item.episodesCount > 0 ? `全${item.episodesCount}集` : '精彩短剧';
  if (tagStr) {
    return `「${tagStr}」${epStr}沉浸式追剧，高能情节反转爽快，不容错过！`;
  }
  return `${epStr}高能连贯无拖沓，剧情节奏飞起，一口气刷完全集超解压。`;
}

/**
 * 格式化热度数字，缺失时返回 null 而不是"热度未提供"
 */
export function formatHeatValue(value?: number): string | null {
  if (!value || value <= 0) return null;
  if (value >= 10000) {
    return `${(value / 10000).toFixed(value >= 100000 ? 0 : 1)}万热度`;
  }
  return `${value.toLocaleString()} 热度`;
}

/**
 * 「猜你喜欢」换一部的选择逻辑（向后兼容）。
 */
export function pickNextRandomId(
  ids: readonly string[],
  shown: Set<string>,
  currentId: string | null,
): string | null {
  if (ids.length === 0) return null;
  let pool = ids.filter(id => !shown.has(id));
  if (pool.length === 0) {
    shown.clear();
    if (currentId) shown.add(currentId);
    pool = ids.filter(id => id !== currentId);
    if (pool.length === 0) pool = [...ids];
  }
  if (pool.length === 0) return null;
  const next = pool[Math.floor(Math.random() * pool.length)];
  shown.add(next);
  return next;
}
