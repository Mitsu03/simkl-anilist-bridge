/**
 * AniList → Simkl, for changes made outside Nuvio.
 *
 * This is deliberately NOT a bidirectional reconciliation. The two services
 * disagree permanently about how many episodes some seasons have — measured on
 * a real library, 11 entries where AniList counts more and 7 where Simkl does —
 * and a symmetric sync would push those back and forth forever, because neither
 * side is wrong and neither will ever converge.
 *
 * So the trigger is movement, not difference: an entry qualifies only when its
 * AniList progress has RISEN, or its status has CHANGED, since the previous
 * run. A standing disagreement never moves, so it never fires.
 *
 * Two consequences fall out of that rule and both matter:
 *
 *   - The first run must write nothing. With no baseline, every standing
 *     difference would read as new movement and be pushed at once.
 *   - After the forward sync writes to AniList, the baseline must be updated to
 *     match, or our own write looks like a user edit on the next run and is
 *     echoed straight back to Simkl.
 */

const KEY_OBSERVED = 'anilistObserved';
const KEY_ID_MAP = 'anilistToSimkl';

/** AniList's statuses, mapped back onto Simkl's list names. */
export const STATUS_TO_SIMKL = {
  CURRENT: 'watching',
  PLANNING: 'plantowatch',
  PAUSED: 'hold',
  COMPLETED: 'completed',
  DROPPED: 'dropped',
  // AniList's rewatch state has no Simkl equivalent; treat it as watching.
  REPEATING: 'watching',
};

/** Compact per-entry snapshot: what we last saw AniList holding. */
export function snapshotOf(anilistEntries) {
  const out = {};
  for (const [mediaId, e] of anilistEntries) {
    out[mediaId] = { p: e.progress ?? 0, s: e.status ?? null };
  }
  return out;
}

export const readBaseline = (store) => store.get(KEY_OBSERVED);
export const writeBaseline = (store, snapshot) => store.put(KEY_OBSERVED, snapshot);
export const readIdMap = async (store) => (await store.get(KEY_ID_MAP)) ?? {};
export const writeIdMap = (store, map) => store.put(KEY_ID_MAP, map);

/**
 * AniList id -> Simkl id and title, built from the Simkl data the forward
 * direction already fetches. Persisted because a delta fetch won't contain the
 * entry that AniList happened to move.
 */
export function idMapFrom(desiredEntries, existing = {}) {
  const map = { ...existing };
  for (const d of desiredEntries) {
    if (d.anilistId && d.simklId) map[d.anilistId] = { simklId: d.simklId, title: d.title };
  }
  return map;
}

/** What moved on AniList since the baseline. */
export function detectAdvances({ baseline, current, idMap }) {
  const episodeAdds = [];
  const statusChanges = [];
  const skipped = [];

  for (const [idStr, now] of Object.entries(current)) {
    const before = baseline[idStr];
    if (!before) continue; // unseen entry: the baseline update will adopt it

    const gainedEpisodes = now.p > before.p;
    const changedStatus = now.s && now.s !== before.s;
    if (!gainedEpisodes && !changedStatus) continue;

    const simkl = idMap[idStr];
    if (!simkl) {
      skipped.push(`AniList ${idStr} moved but has no known Simkl entry`);
      continue;
    }

    if (gainedEpisodes) {
      // Exactly the episodes AniList gained. Simkl treats re-adding an episode
      // it already holds as a no-op, so its own progress need not be known.
      const episodes = [];
      for (let n = before.p + 1; n <= now.p; n++) episodes.push(n);
      episodeAdds.push({
        simklId: simkl.simklId,
        title: simkl.title,
        episodes,
        reason: `progress ${before.p} → ${now.p}`,
      });
    }

    if (changedStatus) {
      const to = STATUS_TO_SIMKL[now.s];
      if (!to) {
        skipped.push(`${simkl.title}: AniList status ${now.s} has no Simkl equivalent`);
      } else {
        statusChanges.push({
          simklId: simkl.simklId,
          title: simkl.title,
          to,
          reason: `status ${before.s ?? '(none)'} → ${now.s}`,
        });
      }
    }
  }

  return { episodeAdds, statusChanges, skipped };
}

/** Simkl records history as individual episodes rather than a progress count. */
export const historyPayload = (adds) => ({
  anime: adds.map((a) => ({
    ids: { simkl: a.simklId },
    episodes: a.episodes.map((number) => ({ number })),
  })),
});

export const listPayload = (changes) => ({
  anime: changes.map((c) => ({ ids: { simkl: c.simklId }, to: c.to })),
});
