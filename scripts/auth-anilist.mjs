#!/usr/bin/env node
/**
 * One-time AniList authorisation using the authorization-code grant with
 * AniList's built-in PIN redirect, so no local web server is needed.
 *
 * On your app at https://anilist.co/settings/developer, set the redirect URI to
 *   https://anilist.co/api/v2/oauth/pin
 * AniList then shows you a code to paste back here. Tokens last a year.
 */

import { loadEnv, saveEnv, ask } from './_env.mjs';

const REDIRECT = 'https://anilist.co/api/v2/oauth/pin';
const env = loadEnv();

const clientId = await ask('AniList client id: ', { existing: env.ANILIST_CLIENT_ID });
const clientSecret = await ask('AniList client secret: ', { existing: env.ANILIST_CLIENT_SECRET });
if (!clientId || !clientSecret) throw new Error('client id and secret are both required');

const authUrl =
  `https://anilist.co/api/v2/oauth/authorize?client_id=${encodeURIComponent(clientId)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`;

console.log(`\n  Open this and approve:\n  ${authUrl}\n`);
const code = await ask('Paste the code AniList shows you: ');
if (!code) throw new Error('no code entered');

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
  throw new Error(`AniList refused the exchange: ${res.status} ${JSON.stringify(body)}`);
}

saveEnv('ANILIST_CLIENT_ID', clientId);
saveEnv('ANILIST_CLIENT_SECRET', clientSecret);
saveEnv('ANILIST_ACCESS_TOKEN', body.access_token);

const who = await fetch('https://graphql.anilist.co', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${body.access_token}`,
  },
  body: JSON.stringify({ query: '{ Viewer { id name } }' }),
}).then((r) => r.json());

console.log(`Authorised as ${who?.data?.Viewer?.name ?? '(unknown)'}. Token written to .dev.vars.`);
console.log(`Expires in about ${Math.round((body.expires_in ?? 31536000) / 86400)} days.`);
