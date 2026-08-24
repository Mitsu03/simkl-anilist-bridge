/**
 * Minimal .dev.vars loader + prompt helper, so the auth and dry-run scripts can
 * run with plain node and no dependencies. .dev.vars uses the same KEY=value
 * format wrangler reads for local development.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const FILE = new URL('../.dev.vars', import.meta.url);

export function loadEnv() {
  const out = { ...process.env };
  if (!existsSync(FILE)) return out;
  for (const line of readFileSync(FILE, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Upsert a key in .dev.vars, preserving everything else. */
export function saveEnv(key, value) {
  const lines = existsSync(FILE) ? readFileSync(FILE, 'utf8').split('\n') : [];
  const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
  if (idx === -1) lines.push(`${key}=${value}`);
  else lines[idx] = `${key}=${value}`;
  writeFileSync(FILE, lines.filter((l, i) => l !== '' || i < lines.length - 1).join('\n').replace(/\n*$/, '\n'));
}

export async function ask(question, { existing } = {}) {
  if (existing) return existing;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}
