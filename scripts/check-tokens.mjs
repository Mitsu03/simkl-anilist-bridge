#!/usr/bin/env node
/**
 * Credential health check.
 *
 * Two different failure modes matter and only one of them is a date:
 *   - the AniList token expires about a year after issue, which is knowable in
 *     advance because it is a JWT and carries its own `exp` claim; and
 *   - either token can stop working early (revoked, app deleted, password
 *     reset), which no expiry date predicts.
 *
 * So this reads the expiry locally AND makes one live call per service. Simkl
 * tokens do not expire, which is exactly why the live check is what covers them.
 *
 *   node scripts/check-tokens.mjs [--warn-days 30]
 */

import { writeFileSync, appendFileSync } from 'node:fs';
import { SimklClient } from '../src/simkl.js';
import { loadEnv, argValue } from './_env.mjs';

const env = loadEnv();
const warnDays = Number(argValue('warn-days') ?? 30);
const findings = [];
let worst = 'ok';

const escalate = (level) => {
  const order = { ok: 0, warn: 1, critical: 2 };
  if (order[level] > order[worst]) worst = level;
};

// --- AniList expiry, read from the token itself ---
let anilistDays = null;
try {
  const claim = JSON.parse(
    Buffer.from(env.ANILIST_ACCESS_TOKEN.split('.')[1], 'base64url').toString(),
  );
  const expires = new Date(claim.exp * 1000);
  anilistDays = Math.floor((expires - Date.now()) / 86_400_000);
  const when = expires.toISOString().slice(0, 10);

  if (anilistDays <= 0) {
    findings.push(`**AniList token expired** on ${when}.`);
    escalate('critical');
  } else if (anilistDays <= warnDays) {
    findings.push(`**AniList token expires in ${anilistDays} days** (${when}).`);
    escalate('warn');
  } else {
    findings.push(`AniList token valid for ${anilistDays} more days (${when}).`);
  }
} catch (err) {
  findings.push(`Could not read the AniList token's expiry: ${err.message}`);
  escalate('critical');
}

// --- Live checks: an unexpired token can still be revoked ---
try {
  const simkl = new SimklClient({
    clientId: env.SIMKL_CLIENT_ID,
    accessToken: env.SIMKL_ACCESS_TOKEN,
  });
  await simkl.activities();
  findings.push('Simkl token works (tokens there do not expire).');
} catch (err) {
  findings.push(`**Simkl token is not working**: ${err.message}`);
  escalate('critical');
}

try {
  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.ANILIST_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ query: '{ Viewer { name } }' }),
  });
  const body = await res.json();
  if (body?.data?.Viewer?.name) findings.push(`AniList token works (${body.data.Viewer.name}).`);
  else throw new Error(body?.errors?.map((e) => e.message).join('; ') ?? `HTTP ${res.status}`);
} catch (err) {
  findings.push(`**AniList token is not working**: ${err.message}`);
  escalate('critical');
}

const body = [
  worst === 'ok'
    ? 'All credentials healthy.'
    : 'The bridge needs a credential refreshed, or it will stop syncing.',
  '',
  ...findings.map((f) => `- ${f}`),
  '',
  '---',
  '',
  'To refresh the AniList token:',
  '',
  '```bash',
  'npm run auth:anilist                 # prints the URL to approve',
  'npm run auth:anilist -- --code XXX   # exchanges the code',
  'gh secret set ANILIST_ACCESS_TOKEN   # paste the new value from .dev.vars',
  '```',
  '',
  'The GitHub PAT used by the Cloudflare trigger is not checked here. If it',
  'lapses the Worker stops dispatching and latency falls back to the `*/5`',
  'schedule — degraded, but nothing stops syncing and nothing is lost.',
].join('\n');

console.log(body);
writeFileSync('token-health.md', body + '\n');

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `status=${worst}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `anilist_days=${anilistDays ?? -1}\n`);
}
console.log(`\nstatus=${worst}`);
