#!/usr/bin/env node
/**
 * Run the sync locally against your real accounts and print what it WOULD do.
 * Writes nothing to AniList and nothing to the Worker's KV — state lives in a
 * local .state.local.json so you can iterate safely.
 *
 *   node scripts/dryrun.mjs            # plan against the stored watermark
 *   node scripts/dryrun.mjs --force    # ignore the watermark, compare everything
 *   node scripts/dryrun.mjs --apply    # actually write (respects --budget)
 *   node scripts/dryrun.mjs --budget 10
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { SimklClient } from '../src/simkl.js';
import { AniListClient } from '../src/anilist.js';
import { runSync } from '../src/sync.js';
import { loadEnv } from './_env.mjs';

const env = loadEnv();
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const STATE = new URL('../.state.local.json', import.meta.url);
const store = {
  async get(key) {
    if (!existsSync(STATE)) return null;
    return JSON.parse(readFileSync(STATE, 'utf8'))[key] ?? null;
  },
  async put(key, val) {
    const current = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
    current[key] = val;
    writeFileSync(STATE, JSON.stringify(current, null, 2));
  },
};

const log = (msg) => console.log(msg);
const simkl = new SimklClient({
  clientId: env.SIMKL_CLIENT_ID,
  accessToken: env.SIMKL_ACCESS_TOKEN,
});
const anilist = new AniListClient({
  accessToken: env.ANILIST_ACCESS_TOKEN,
  minIntervalMs: Number(env.ANILIST_MIN_INTERVAL_MS ?? 2400),
  log,
});

const result = await runSync({
  simkl,
  anilist,
  store,
  log,
  dryRun: !flag('apply'),
  force: flag('force'),
  allowLowering: flag('allow-lowering'),
  budget: Number(value('budget', 40)),
});

console.log('\n─────── result ───────');
if (result.status === 'unchanged') {
  console.log('Nothing changed on Simkl since the last run.');
  process.exit(0);
}

if (result.plan) {
  const acting = result.plan.filter((p) => p.action !== 'skip');
  const skipped = result.plan.length - acting.length;
  for (const p of acting) {
    console.log(`  ${p.action.padEnd(6)} ${p.title} — ${p.reason}`);
  }
  console.log(`\n${acting.length} write(s) planned, ${skipped} already in sync.`);
}

for (const w of result.warnings ?? []) console.log(`  ! ${w}`);

console.log(
  `\nstatus=${result.status} planned=${result.planned} written=${result.written} ` +
    `failed=${result.failed} remaining=${result.remaining}`,
);
