#!/usr/bin/env node
/**
 * Entry point for a scheduled run. Reads credentials from the environment
 * (GitHub Actions secrets in CI, .dev.vars locally) and state from a JSON file.
 *
 *   node scripts/run-sync.mjs --state state.json
 */

import { SimklClient } from '../src/simkl.js';
import { AniListClient } from '../src/anilist.js';
import { runSync } from '../src/sync.js';
import { runReverse, absorbForwardWrites } from '../src/reverse-sync.js';
import { fileStore } from '../src/store-file.js';
import { loadEnv, argValue } from './_env.mjs';

const env = loadEnv();
const missing = ['SIMKL_CLIENT_ID', 'SIMKL_ACCESS_TOKEN', 'ANILIST_ACCESS_TOKEN'].filter(
  (k) => !env[k],
);
if (missing.length) {
  console.error(`Missing credentials: ${missing.join(', ')}`);
  process.exit(1);
}

const log = (msg) => console.log(msg);
const dryRun = process.argv.includes('--dry-run');

const simkl = new SimklClient({
  clientId: env.SIMKL_CLIENT_ID,
  accessToken: env.SIMKL_ACCESS_TOKEN,
});
const anilist = new AniListClient({
  accessToken: env.ANILIST_ACCESS_TOKEN,
  minIntervalMs: Number(env.ANILIST_MIN_INTERVAL_MS ?? 2400),
  log,
});
const store = fileStore(argValue('state') ?? 'state.json');

// Simkl -> AniList first, then fold those writes into the reverse baseline so
// they are not mistaken for the user's own edits, then AniList -> Simkl.
const result = await runSync({
  simkl,
  anilist,
  store,
  log,
  dryRun,
  force: process.argv.includes('--force'),
  allowLowering: String(env.ALLOW_LOWERING ?? 'false') === 'true',
  budget: Number(env.WRITE_BUDGET ?? 40),
});

if (!dryRun) await absorbForwardWrites(store, result.writtenItems ?? []);

const reverse = String(env.REVERSE_SYNC ?? 'true') === 'true'
  ? await runReverse({ simkl, anilist, store, dryRun, log })
  : { status: 'disabled' };

for (const w of result.warnings ?? []) console.log(`  ! ${w}`);
console.log(
  `forward: status=${result.status} planned=${result.planned ?? 0} ` +
    `written=${result.written ?? 0} failed=${result.failed ?? 0} ` +
    `remaining=${result.remaining ?? 0}`,
);
console.log(`reverse: status=${reverse.status} pushed=${reverse.pushed ?? 0}`);

// A failed write is retried on the next run, so it is not a build failure.
// Only an outright crash (thrown above) should fail the job.
