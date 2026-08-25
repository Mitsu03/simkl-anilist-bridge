/**
 * The AniList → Simkl pass. Kept separate from `sync.js` so the forward
 * direction, which is the load-bearing half, stays untouched.
 */

import {
  snapshotOf, readBaseline, writeBaseline, readIdMap,
  detectAdvances, historyPayload, listPayload,
} from './reverse.js';

export async function runReverse({ simkl, anilist, store, dryRun = false, log = console.log }) {
  const viewer = await anilist.viewer();
  const entries = await anilist.listEntries(viewer.id);
  const current = snapshotOf(entries);
  const baseline = await readBaseline(store);

  // Without a baseline every standing disagreement between the two services
  // would read as new movement. Record and write nothing.
  if (!baseline) {
    if (!dryRun) await writeBaseline(store, current);
    log(`reverse: baseline recorded for ${Object.keys(current).length} entries, nothing pushed`);
    return { status: 'baseline', entries: Object.keys(current).length };
  }

  const idMap = await readIdMap(store);
  const { episodeAdds, statusChanges, skipped } = detectAdvances({ baseline, current, idMap });

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
