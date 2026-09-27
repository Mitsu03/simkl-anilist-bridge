/**
 * The AniList → Simkl pass. Kept separate from `sync.js` so the forward
 * direction, which is the load-bearing half, stays untouched.
 */

import {
  snapshotOf, readBaseline, writeBaseline, readIdMap, writeIdMap, idMapFrom,
  detectAdvances, historyPayload, listPayload, newEntryIds, movedIds, NEW_ENTRY_LIMIT,
} from './reverse.js';
import { toDesiredState } from './mapping.js';
import { simklBody } from './simkl.js';

/**
 * The forward pass builds the AniList -> Simkl id map, but only on runs where
 * the Simkl watermark moved. A user marking an episode on AniList alone changes
 * nothing on Simkl, so on exactly the runs this half exists to serve, the map
 * may never have been written. Fetch the full Simkl list once to bootstrap it.
 */
async function ensureIdMap(store, simkl, log, dryRun = false) {
  const existing = await readIdMap(store);
  if (Object.keys(existing).length) return existing;

  log('reverse: no id map yet, fetching the full Simkl list to build one');
  const desired = (await simkl.animeItems()).map(toDesiredState).filter(Boolean);
  const map = idMapFrom(desired);
  if (!dryRun) await writeIdMap(store, map);
  log(`reverse: id map built for ${Object.keys(map).length} entries`);
  return map;
}

/**
 * The map only knows titles the forward direction has seen on the Simkl list,
 * so a title added on AniList alone — or one Simkl lists without an AniList
 * id — has no entry. Ask Simkl by AniList id, for the moved ids only.
 */
async function resolveMissingIds(ids, idMap, simkl, log) {
  for (const id of ids) {
    if (idMap[id]) continue;
    const hit = await simkl.lookupAnilistId(id);
    if (hit) {
      idMap[id] = hit;
      log(`reverse: AniList ${id} resolved to Simkl ${hit.simklId} (${hit.title})`);
    }
  }
}

/** Simkl ids currently anywhere on the user's anime list. */
async function heldSimklIds(simkl) {
  const items = await simkl.animeItems();
  return new Set(items.map((e) => simklBody(e).ids?.simkl).filter(Boolean));
}

export async function runReverse({ simkl, anilist, store, dryRun = false, log = console.log }) {
  const viewer = await anilist.viewer();
  const entries = await anilist.listEntries(viewer.id);
  const current = snapshotOf(entries);
  const baseline = await readBaseline(store);

  // Without a baseline every standing disagreement between the two services
  // would read as new movement. Record and write nothing.
  if (!baseline) {
    if (!dryRun) {
      await ensureIdMap(store, simkl, log);
      await writeBaseline(store, current);
    }
    log(`reverse: baseline recorded for ${Object.keys(current).length} entries, nothing pushed`);
    return { status: 'baseline', entries: Object.keys(current).length };
  }

  const idMap = await ensureIdMap(store, simkl, log, dryRun);

  const fresh = newEntryIds(baseline, current);
  const acceptNew = fresh.length <= NEW_ENTRY_LIMIT;
  if (!acceptNew) {
    log(`  ! ${fresh.length} entries appeared on AniList at once; adopted without pushing`);
  }

  const moved = movedIds({ baseline, current, acceptNew });
  await resolveMissingIds(moved, idMap, simkl, log);
  if (!dryRun) await writeIdMap(store, idMap);

  // Only a new, not-yet-completed entry needs to know what Simkl holds, and
  // that costs a full list fetch, so pay it only on the runs that need it.
  const needsHeld = moved.some(
    (id) => !baseline[id] && current[id].s !== 'COMPLETED' && idMap[id],
  );
  const simklHeld = needsHeld ? await heldSimklIds(simkl) : null;

  const { episodeAdds, statusChanges, skipped } = detectAdvances({
    baseline, current, idMap, acceptNew, simklHeld,
  });

  for (const s of skipped) log(`  ! ${s}`);
  if (!episodeAdds.length && !statusChanges.length) {
    if (!dryRun) await writeBaseline(store, current);
    return { status: 'unchanged', pushed: 0, skipped: skipped.length };
  }

  for (const a of episodeAdds) log(`  ← ${a.title}: ${a.reason} (ep ${a.episodes.join(', ')})`);
  for (const c of statusChanges) log(`  ← ${c.title}: ${c.reason} → ${c.to}`);

  if (dryRun) {
    return { status: 'dry-run', episodeAdds, statusChanges, skipped: skipped.length };
  }

  // The baseline advances only on success, so a failed push is retried rather
  // than silently forgotten.
  if (episodeAdds.length) await simkl.addToHistory(historyPayload(episodeAdds));
  if (statusChanges.length) await simkl.addToList(listPayload(statusChanges));
  await writeBaseline(store, current);

  return {
    status: 'pushed',
    pushed: episodeAdds.length + statusChanges.length,
    skipped: skipped.length,
  };
}

/**
 * Fold what the forward direction just wrote to AniList into the baseline, so
 * our own writes are not mistaken for the user's on the next run.
 */
export async function absorbForwardWrites(store, written) {
  if (!written.length) return;
  const baseline = await readBaseline(store);
  if (!baseline) return;
  for (const w of written) {
    baseline[w.anilistId] = { p: w.progress, s: w.status };
  }
  await writeBaseline(store, baseline);
}
