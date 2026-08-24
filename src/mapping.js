/**
 * Translation between Simkl list entries and AniList list entries.
 *
 * The two services agree on far more than they might: Simkl splits anime into
 * per-season entries the same way AniList does, and exposes an `anilist` id on
 * ~99% of them, so this is a field rename rather than a matching problem. The
 * `mal` id (present on effectively everything) covers the remainder.
 */

import { simklBody } from './simkl.js';
import { toScoreRaw } from './anilist.js';

export const STATUS_MAP = {
  watching: 'CURRENT',
  plantowatch: 'PLANNING',
  hold: 'PAUSED',
  completed: 'COMPLETED',
  dropped: 'DROPPED',
};

/**
 * Reduce a Simkl entry to the state we want AniList to hold.
 * Returns null for entries the bridge cannot or should not act on.
 */
export function toDesiredState(entry) {
  const body = simklBody(entry);
  const ids = body.ids ?? {};
  const status = STATUS_MAP[entry.status];
  if (!status) return null;

  const total = Number(entry.total_episodes_count ?? 0);
  let progress = Number(entry.watched_episodes_count ?? 0);
  if (!Number.isFinite(progress) || progress < 0) progress = 0;

  // A completed film reads as 0/0 episodes on Simkl but is 1 episode on AniList.
  const isFilm = (body.anime_type ?? entry.anime_type) === 'movie';
  if (status === 'COMPLETED' && progress === 0) progress = total > 0 ? total : 1;
  else if (isFilm && progress > 1) progress = 1;

  // Never claim more episodes than the season has, or AniList rejects the write.
  if (total > 0 && progress > total) progress = total;

  return {
    title: body.title ?? '(untitled)',
    anilistId: ids.anilist ? Number(ids.anilist) : null,
    malId: ids.mal ? String(ids.mal) : null,
    simklId: ids.simkl ?? null,
    status,
    progress,
    score: toScoreRaw(entry.user_rating),
  };
}

/**
 * Decide whether AniList needs writing, given what it currently holds.
 *
 * `allowLowering` controls the one genuinely destructive case: Simkl reporting
 * fewer watched episodes than AniList already has. That happens legitimately
 * (you un-marked an episode) and accidentally (a half-synced entry), so it is
 * off by default and surfaced as a warning instead.
 */
export function diffEntry(desired, current, { allowLowering = false } = {}) {
  if (!current) {
    return { action: 'create', reason: 'not on AniList', write: desired };
  }

  const changes = [];
  const warnings = [];
  const write = { ...desired };

  if (desired.progress > current.progress) {
    changes.push(`progress ${current.progress}→${desired.progress}`);
  } else if (desired.progress < current.progress) {
    if (allowLowering) {
      changes.push(`progress ${current.progress}→${desired.progress} (lowered)`);
    } else {
      // Keep AniList's higher count but still let status/score changes through.
      write.progress = current.progress;
      warnings.push(`AniList ahead (${current.progress} > ${desired.progress}), progress left alone`);
    }
  }

  if (desired.status !== current.status) {
    changes.push(`status ${current.status}→${desired.status}`);
  }

  // Only push a score when Simkl has one; a missing rating is not a zero.
  if (desired.score != null && desired.score !== current.score) {
    changes.push(`score ${current.score}→${desired.score}`);
  } else {
    write.score = null;
  }

  if (!changes.length) {
    return { action: 'skip', reason: warnings[0] ?? 'already in sync', warn: warnings.length > 0 };
  }
  return {
    action: 'update',
    reason: [...changes, ...warnings].join(', '),
    warn: warnings.length > 0,
    write,
  };
}
