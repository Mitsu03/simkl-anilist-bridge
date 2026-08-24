#!/usr/bin/env node
/**
 * One-time Simkl authorisation via the device PIN flow — no redirect URI or
 * local web server needed. The resulting access token does not expire.
 *
 * Register an app first at https://simkl.com/settings/developer
 * (redirect URI can be anything, e.g. urn:ietf:wg:oauth:2.0:oob).
 */

import { loadEnv, saveEnv, ask } from './_env.mjs';

const env = loadEnv();
const clientId = await ask('Simkl client id: ', { existing: env.SIMKL_CLIENT_ID });
if (!clientId) throw new Error('a client id is required');

const pinRes = await fetch(`https://api.simkl.com/oauth/pin?client_id=${encodeURIComponent(clientId)}`, {
  headers: { Accept: 'application/json' },
});
if (!pinRes.ok) throw new Error(`Simkl refused the PIN request: ${pinRes.status} ${await pinRes.text()}`);
const pin = await pinRes.json();

console.log(`\n  Open ${pin.verification_url} and enter the code:  ${pin.user_code}\n`);
console.log(`  (expires in ${Math.round((pin.expires_in ?? 900) / 60)} minutes)\n`);

const intervalMs = (pin.interval ?? 5) * 1000;
const deadline = Date.now() + (pin.expires_in ?? 900) * 1000;

while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, intervalMs));
  const res = await fetch(
    `https://api.simkl.com/oauth/pin/${encodeURIComponent(pin.user_code)}?client_id=${encodeURIComponent(clientId)}`,
    { headers: { Accept: 'application/json' } },
  );
  const body = await res.json().catch(() => ({}));
  if (body.result === 'OK' && body.access_token) {
    saveEnv('SIMKL_CLIENT_ID', clientId);
    saveEnv('SIMKL_ACCESS_TOKEN', body.access_token);
    console.log('Authorised. SIMKL_CLIENT_ID and SIMKL_ACCESS_TOKEN written to .dev.vars.');
    process.exit(0);
  }
  process.stdout.write('.');
}

console.error('\nTimed out waiting for the code to be entered.');
process.exit(1);
