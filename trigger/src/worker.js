/**
 * Latency trigger.
 *
 * GitHub throttles `schedule` runs hard — a 5-minute cron was observed firing
 * every 19-35 minutes — but runs started by `workflow_dispatch` begin within
 * seconds. Cloudflare's cron is punctual and can reach Simkl fine; what it
 * cannot do is talk to AniList, whose block on Workers' shared egress IPs is
 * why the sync itself lives on GitHub.
 *
 * So this Worker does the one thing Cloudflare is good for here: poll Simkl's
 * activities endpoint (a single cheap request) and, when the anime timestamp
 * moves, dispatch the GitHub workflow that does the actual writing. It never
 * touches AniList.
 *
 * Edits made on AniList alone never move Simkl's timestamp, and the Worker
 * cannot see AniList, so it also dispatches on a heartbeat (HEARTBEAT_MINUTES)
 * whenever no dispatch has happened for that long. That bounds how long an
 * AniList-only change waits for the reverse pass.
 *
 * The GitHub side keeps the authoritative watermark. The marker stored here is
 * only for dispatch de-duplication, so if the two ever diverge the worst case
 * is one redundant run that reports "unchanged".
 */

import { SimklClient } from '../../src/simkl.js';

const KEY_LAST_DISPATCHED = 'lastDispatchedAnimeActivity';
const KEY_LAST_DISPATCH_AT = 'lastDispatchAt';

// Cron ticks are not millisecond-exact; without slack a 10-minute heartbeat on
// a 2-minute cron would often wait for the 12-minute tick instead.
const TICK_SLACK_MS = 30_000;

async function poll(env, log) {
  const simkl = new SimklClient({
    clientId: env.SIMKL_CLIENT_ID,
    accessToken: env.SIMKL_ACCESS_TOKEN,
  });

  const activities = await simkl.activities();
  const current = activities?.anime?.all ?? null;
  const lastDispatched = await env.BRIDGE_STATE.get(KEY_LAST_DISPATCHED);
  const lastAt = Number(await env.BRIDGE_STATE.get(KEY_LAST_DISPATCH_AT)) || 0;

  const heartbeatMs = Number(env.HEARTBEAT_MINUTES ?? 10) * 60_000;
  const simklMoved = Boolean(current) && current !== lastDispatched;
  const heartbeatDue = heartbeatMs > 0 && Date.now() - lastAt >= heartbeatMs - TICK_SLACK_MS;

  if (!simklMoved && !heartbeatDue) return { status: 'unchanged', activity: current };

  log(
    simklMoved
      ? `Simkl anime activity moved ${lastDispatched ?? '(none)'} -> ${current}`
      : `heartbeat: no dispatch for ${Math.round((Date.now() - lastAt) / 60_000)} min`,
  );

  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'simkl-anilist-bridge-trigger',
      },
      body: JSON.stringify({ ref: env.GITHUB_REF ?? 'master' }),
    },
  );

  if (!res.ok) {
    // Leave the marker untouched so the next tick retries this same change.
    const detail = await res.text().catch(() => '');
    throw new Error(`GitHub dispatch failed: ${res.status} ${detail}`.trim());
  }

  if (current) await env.BRIDGE_STATE.put(KEY_LAST_DISPATCHED, current);
  await env.BRIDGE_STATE.put(KEY_LAST_DISPATCH_AT, String(Date.now()));
  return { status: 'dispatched', reason: simklMoved ? 'simkl' : 'heartbeat', activity: current };
}

export default {
  async scheduled(event, env) {
    const log = (m) => console.log(`[cron] ${m}`);
    try {
      log(JSON.stringify(await poll(env, log)));
    } catch (err) {
      console.error(`[cron] ${err.message}`);
      throw err;
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const supplied =
      url.searchParams.get('key') ??
      (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!env.BRIDGE_TOKEN || supplied !== env.BRIDGE_TOKEN) {
      return json({ error: 'unauthorized' }, 401);
    }

    const lines = [];
    const log = (m) => {
      lines.push(m);
      console.log(m);
    };

    try {
      if (url.pathname === '/poll') {
        if (url.searchParams.get('force') === '1') {
          await env.BRIDGE_STATE.put(KEY_LAST_DISPATCHED, '');
        }
        return json({ ...(await poll(env, log)), log: lines });
      }
      const lastAt = Number(await env.BRIDGE_STATE.get(KEY_LAST_DISPATCH_AT)) || null;
      return json({
        lastDispatched: await env.BRIDGE_STATE.get(KEY_LAST_DISPATCHED),
        lastDispatchAt: lastAt && new Date(lastAt).toISOString(),
        heartbeatMinutes: Number(env.HEARTBEAT_MINUTES ?? 10),
        repo: env.GITHUB_REPO,
        workflow: env.GITHUB_WORKFLOW,
      });
    } catch (err) {
      return json({ error: err.message, log: lines }, 500);
    }
  },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
