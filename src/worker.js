/**
 * Cloudflare Worker entry point.
 *
 * - The cron trigger drives normal operation.
 * - The HTTP routes exist for manual runs and for checking state from a phone;
 *   they are all gated on BRIDGE_TOKEN because the workers.dev URL is public.
 */

import { SimklClient } from './simkl.js';
import { AniListClient } from './anilist.js';
import { runSync, readState } from './sync.js';

function kvStore(kv) {
  return {
    async get(key) {
      return kv.get(key, { type: 'json' });
    },
    async put(key, value) {
      if (value === null || value === undefined) return kv.delete(key);
      return kv.put(key, JSON.stringify(value));
    },
  };
}

function clientsFor(env, log) {
  return {
    simkl: new SimklClient({
      clientId: env.SIMKL_CLIENT_ID,
      accessToken: env.SIMKL_ACCESS_TOKEN,
    }),
    anilist: new AniListClient({
      accessToken: env.ANILIST_ACCESS_TOKEN,
      minIntervalMs: Number(env.ANILIST_MIN_INTERVAL_MS ?? 2400),
      log,
    }),
    store: kvStore(env.BRIDGE_STATE),
  };
}

function optionsFor(env, overrides = {}) {
  return {
    budget: Number(env.WRITE_BUDGET ?? 40),
    allowLowering: String(env.ALLOW_LOWERING ?? 'false') === 'true',
    ...overrides,
  };
}

export default {
  async scheduled(event, env, ctx) {
    const log = (msg) => console.log(`[cron] ${msg}`);
    const { simkl, anilist, store } = clientsFor(env, log);
    try {
      const result = await runSync({ simkl, anilist, store, log, ...optionsFor(env) });
      log(JSON.stringify(result));
    } catch (err) {
      console.error(`[cron] sync failed: ${err.stack ?? err.message}`);
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
    const log = (msg) => {
      lines.push(msg);
      console.log(msg);
    };
    const { simkl, anilist, store } = clientsFor(env, log);

    try {
      if (url.pathname === '/run') {
        const dryRun = url.searchParams.get('dry') === '1';
        const force = url.searchParams.get('force') === '1';
        const budget = url.searchParams.get('budget');
        const result = await runSync({
          simkl,
          anilist,
          store,
          log,
          dryRun,
          force,
          ...optionsFor(env, budget ? { budget: Number(budget) } : {}),
        });
        return json({ ...result, log: lines });
      }

      if (url.pathname === '/reset' && request.method === 'POST') {
        await store.put('watermark', null);
        await store.put('queue', null);
        await store.put('pendingWatermark', null);
        return json({ status: 'reset', note: 'the next run will do a full comparison' });
      }

      return json(await readState(store));
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
