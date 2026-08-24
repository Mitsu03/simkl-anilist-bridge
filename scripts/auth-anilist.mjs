#!/usr/bin/env node
/**
 * AniList authorisation, in two non-interactive steps so it works anywhere —
 * no TTY, no local web server, no secret on a command line.
 *
 * Prerequisites:
 *   1. An app at https://anilist.co/settings/developer whose Redirect URL is
 *      exactly  https://anilist.co/api/v2/oauth/pin
 *   2. ANILIST_CLIENT_ID and ANILIST_CLIENT_SECRET present in .dev.vars.
 *
 * Then:
 *   npm run auth:anilist                 # prints the URL to approve
 *   npm run auth:anilist -- --code XXX   # exchanges the code for a token
 *
 * Tokens last about a year.
 */

import { loadEnv, saveEnv, argValue } from './_env.mjs';

const REDIRECT = 'https://anilist.co/api/v2/oauth/pin';
const env = loadEnv();

const clientId = argValue('client-id') ?? env.ANILIST_CLIENT_ID;
const clientSecret = argValue('client-secret') ?? env.ANILIST_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    'Missing credentials. Add these two lines to .dev.vars and re-run:\n\n' +
      '  ANILIST_CLIENT_ID=...\n  ANILIST_CLIENT_SECRET=...\n\n' +
      `Get them from https://anilist.co/settings/developer, with the app's\n` +
      `Redirect URL set to exactly:\n  ${REDIRECT}`,
  );
  process.exit(1);
}

const code = argValue('code');

if (!code) {
  const authUrl =
    `https://anilist.co/api/v2/oauth/authorize?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`;
  console.log(
    `\nStep 1 of 2 — open this and approve:\n\n  ${authUrl}\n\n` +
      'AniList will show you a code. Then run:\n\n' +
      '  npm run auth:anilist -- --code <the code>\n',
  );
  process.exit(0);
}

const res = await fetch('https://anilist.co/api/v2/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT,
    code,
  }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok || !body.access_token) {
  console.error(`AniList refused the exchange: ${res.status} ${JSON.stringify(body)}`);
  console.error('\nCodes are single-use and short-lived — re-run without --code to get a fresh one.');
  process.exit(1);
}

saveEnv('ANILIST_CLIENT_ID', clientId);
saveEnv('ANILIST_CLIENT_SECRET', clientSecret);
saveEnv('ANILIST_ACCESS_TOKEN', body.access_token);

const who = await fetch('https://graphql.anilist.co', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${body.access_token}` },
  body: JSON.stringify({ query: '{ Viewer { id name } }' }),
})
  .then((r) => r.json())
  .catch(() => null);

console.log(`Authorised as ${who?.data?.Viewer?.name ?? '(unknown)'}. Token written to .dev.vars.`);
console.log(`Expires in about ${Math.round((body.expires_in ?? 31536000) / 86400)} days.`);
