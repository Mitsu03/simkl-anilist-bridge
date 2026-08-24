/**
 * Sync orchestration.
 *
 * Shape of a run:
 *   1. Poll Simkl's `/sync/activities` (one cheap request). If the anime
 *      timestamp is unchanged since last time, stop — this is the common case.
 *   2. Fetch only the entries that changed since the stored watermark
 *      (everything, on the very first run).
 *   3. Fetch the AniList list once and diff, so a first run over a library that
 *      is already mostly in sync costs almost no writes.
 *   4. Queue the writes and drain them under a per-invocation budget. A
 *      Cloudflare cron tick cannot run for 40 minutes, so an initial backlog of
 *      hundreds of entries is spread over successive ticks instead.
 *
 * The watermark only advances once its queue has fully drained, so an
 * interrupted run re-tries rather than silently skipping entries.
 */

import { toDesiredState, diffEntry } from './mapping.js';

const KEY_WATERMARK = 'watermark';
const KEY_QUEUE = 'queue';
const KEY_PENDING_WATERMARK = 'pendingWatermark';

export async function runSync({
  simkl,
  anilist,
  store,
  budget = 40,
  dryRun = false,
  force = false,
  allowLowering = false,
  log = console.log,
}) {
  let queue = (await store.get(KEY_QUEUE)) ?? [];
  const summary = { planned: 0, written: 0, failed: 0, remaining: 0, warnings: [] };

  if (queue.length === 0) {
    const plan = await buildPlan({ simkl, anilist, store, force, allowLowering, log });
    if (plan.status !== 'planned') return { ...summary, ...plan };

    summary.warnings = plan.warnings;
    queue = plan.queue;
    summary.planned = queue.length;

    if (dryRun) {
      return { status: 'dry-run', ...summary, remaining: queue.length, plan: plan.detail };
    }
    await store.put(KEY_PENDING_WATERMARK, plan.watermark);
    await store.put(KEY_QUEUE, queue);
  } else {
    log(`resuming a queue of ${queue.length} pending write(s)`);
    summary.planned = queue.length;
    if (dryRun) return { status: 'dry-run', ...summary, remaining: queue.length, plan: queue };
  }

  const batch = queue.slice(0, budget);
  const rest = queue.slice(budget);
  const failed = [];

  for (const item of batch) {
    try {
      await anilist.saveEntry({
        mediaId: item.anilistId,
        progress: item.progress,
        status: item.status,
        score: item.score ?? undefined,
      });
      summary.written++;
      log(`✓ ${item.title} — ${item.status} ${item.progress}`);
    } catch (err) {
      summary.failed++;
      failed.push(item);
      log(`✗ ${item.title}: ${err.message}`);
    }
  }

  // Failures go back on the queue; a persistent one will surface as a stuck
  // queue in the status endpoint rather than being lost.
  const remaining = [...failed, ...rest];
  summary.remaining = remaining.length;

  if (remaining.length === 0) {
    const pending = await store.get(KEY_PENDING_WATERMARK);
    if (pending) await store.put(KEY_WATERMARK, pending);
    await store.put(KEY_QUEUE, []);
    await store.put(KEY_PENDING_WATERMARK, null);
    log(`queue drained; watermark now ${pending}`);
  } else {
    await store.put(KEY_QUEUE, remaining);
    log(`${remaining.length} write(s) deferred to the next run`);
  }

  return { status: 'synced', ...summary };
}

async function buildPlan({ simkl, anilist, store, force, allowLowering, log }) {
  const activities = await simkl.activities();
  const watermark = activities?.anime?.all ?? activities?.all ?? null;
  const lastSeen = await store.get(KEY_WATERMARK);

  if (!force && watermark && watermark === lastSeen) {
    return { status: 'unchanged', watermark };
  }

  const isFirstRun = !lastSeen;
  const items = await simkl.animeItems(isFirstRun || force ? {} : { dateFrom: lastSeen });
  log(`Simkl returned ${items.length} ${isFirstRun ? 'total' : 'changed'} anime entr${items.length === 1 ? 'y' : 'ies'}`);
  if (items.length === 0) return { status: 'unchanged', watermark };

  const desired = items.map(toDesiredState).filter(Boolean);

  // Fill in the handful of entries Simkl has no AniList id for, via their MAL id.
  const needsLookup = desired.filter((d) => !d.anilistId && d.malId);
  if (needsLookup.length) {
    log(`resolving ${needsLookup.length} entr${needsLookup.length === 1 ? 'y' : 'ies'} by MAL id`);
    const resolved = await anilist.resolveMalIds(needsLookup.map((d) => d.malId));
    for (const d of needsLookup) {
      const hit = resolved.get(d.malId);
      if (hit) d.anilistId = hit;
    }
  }

  const warnings = [];
  const unmapped = desired.filter((d) => !d.anilistId);
  for (const d of unmapped) warnings.push(`no AniList match: ${d.title} (mal=${d.malId ?? '—'})`);

  const viewer = await anilist.viewer();
  const current = await anilist.listEntries(viewer.id);
  log(`AniList user ${viewer.name} has ${current.size} anime entr${current.size === 1 ? 'y' : 'ies'}`);

  const queue = [];
  const detail = [];
  for (const d of desired) {
    if (!d.anilistId) continue;
    const result = diffEntry(d, current.get(d.anilistId), { allowLowering });
    detail.push({ title: d.title, anilistId: d.anilistId, ...result });
    if (result.warn) warnings.push(`${d.title}: ${result.reason}`);
    if (result.action === 'skip') continue;
    queue.push({ ...d, ...result.write, anilistId: d.anilistId, reason: result.reason });
  }

  return { status: 'planned', queue, detail, warnings, watermark };
}

export async function readState(store) {
  return {
    watermark: await store.get(KEY_WATERMARK),
    pendingWatermark: await store.get(KEY_PENDING_WATERMARK),
    queued: ((await store.get(KEY_QUEUE)) ?? []).length,
  };
}
