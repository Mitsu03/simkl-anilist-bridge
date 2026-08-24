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
 * The GitHub side keeps the authoritative watermark. The marker stored here is
 * only for dispatch de-duplication, so if the two ever diverge the worst case
 * is one redundant run that reports "unchanged".
 */

import { SimklClient } from '../../src/simkl.js';

const KEY_LAST_DISPATCHED = 'lastDispatchedAnimeActivity';

async function poll(env, log) {
  const simkl = new SimklClient({
    clientId: env.SIMKL_CLIENT_ID,
    accessToken: env.SIMKL_ACCESS_TOKEN,
  });

  const activities = await simkl.activities();
  const current = activities?.anime?.all ?? null;
  const lastDispatched = await env.BRIDGE_STATE.get(KEY_LAST_DISPATCHED);

  if (!current) return { status: 'no-activity-timestamp' };
  if (current === lastDispatched) return { status: 'unchanged', activity: current };

  log(`Simkl anime activity moved ${lastDispatched ?? '(none)'} -> ${current}`);

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

  await env.BRIDGE_STATE.put(KEY_LAST_DISPATCHED, current);
  return { status: 'dispatched', activity: current };
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
      return json({
        lastDispatched: await env.BRIDGE_STATE.get(KEY_LAST_DISPATCHED),
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
