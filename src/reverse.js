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
 * An entry added on AniList since the previous run is movement too, measured
 * from nothing: its episodes are pushed, and so is its status when that
 * cannot move Simkl backwards (see detectAdvances).
 *
 * Three consequences fall out of that rule and all matter:
 *
 *   - The first run must write nothing. With no baseline, every standing
 *     difference would read as new movement and be pushed at once.
 *   - After the forward sync writes to AniList, the baseline must be updated to
 *     match, or our own write looks like a user edit on the next run and is
 *     echoed straight back to Simkl.
 *   - A burst of "new" entries is not trusted. The baseline is rewritten from
 *     each run's list, so one short read followed by a full one would make
 *     every missing entry reappear as new and be bulk-pushed.
 */

const KEY_OBSERVED = 'anilistObserved';
const KEY_ID_MAP = 'anilistToSimkl';

/** More new entries than this in one run are adopted, not pushed. */
export const NEW_ENTRY_LIMIT = 15;

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

/** AniList ids with no baseline entry: added since the previous run. */
export function newEntryIds(baseline, current) {
  return Object.keys(current).filter((id) => !baseline[id]);
}

/** AniList ids detectAdvances could act on, so their Simkl ids are needed. */
export function movedIds({ baseline, current, acceptNew }) {
  return Object.entries(current)
    .filter(([id, now]) => {
      const before = baseline[id];
      if (!before) return acceptNew;
      return now.p > before.p || (now.s && now.s !== before.s);
    })
    .map(([id]) => id);
}

/**
 * What moved on AniList since the baseline.
 *
 * A new entry pushes its episodes (idempotent on Simkl) but its status only
 * when that cannot demote a title Simkl already holds: COMPLETED always, any
 * other status only when `simklHeld` (the Simkl ids on the user's list) is
 * known and lacks the title. Adding a rewatch as CURRENT must not pull a
 * completed Simkl entry back to watching.
 */
export function detectAdvances({ baseline, current, idMap, acceptNew = true, simklHeld = null }) {
  const episodeAdds = [];
  const statusChanges = [];
  const skipped = [];

  for (const [idStr, now] of Object.entries(current)) {
    const isNew = !baseline[idStr];
    if (isNew && !acceptNew) continue; // adopted by the baseline update
    const before = baseline[idStr] ?? { p: 0, s: null };

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
      const mayDemote = isNew && to !== 'completed' && !(simklHeld && !simklHeld.has(simkl.simklId));
      if (!to) {
        skipped.push(`${simkl.title}: AniList status ${now.s} has no Simkl equivalent`);
      } else if (mayDemote) {
        skipped.push(`${simkl.title}: new on AniList as ${now.s} but already on Simkl, status left alone`);
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
