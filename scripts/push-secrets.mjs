#!/usr/bin/env node
/**
 * Upload the secrets the Worker needs from .dev.vars to Cloudflare.
 *
 * Values are piped to wrangler over stdin rather than passed as arguments, so
 * they never appear in a command line, a shell history, or a process listing.
 *
 *   npm run push:secrets
 */

import { spawn } from 'node:child_process';
import { loadEnv } from './_env.mjs';

const REQUIRED = [
  'SIMKL_CLIENT_ID',
  'SIMKL_ACCESS_TOKEN',
  'ANILIST_ACCESS_TOKEN',
  'BRIDGE_TOKEN',
];

const env = loadEnv();
const missing = REQUIRED.filter((k) => !env[k]);
if (missing.length) {
  console.error(`Missing from .dev.vars: ${missing.join(', ')}`);
  process.exit(1);
}

for (const key of REQUIRED) {
  await new Promise((resolve, reject) => {
    const child = spawn('npx', ['wrangler', 'secret', 'put', key], {
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: process.platform === 'win32',
    });
    child.stdin.write(env[key]);
    child.stdin.end();
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`wrangler secret put ${key} exited ${code}`)),
    );
  });
  console.log(`  ${key} uploaded`);
}
