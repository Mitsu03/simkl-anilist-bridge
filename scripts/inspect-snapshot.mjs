#!/usr/bin/env node
/**
 * Offline validation: run the Simkl→AniList mapping over a Nuvio desktop sync
 * snapshot instead of the live API. Useful for checking coverage and spotting
 * odd entries without touching either account.
 *
 *   node scripts/inspect-snapshot.mjs path/to/nuvio_simkl_sync.properties
 */

import { readFileSync } from 'node:fs';
import { toDesiredState } from '../src/mapping.js';
import { simklBody } from '../src/simkl.js';

const path = process.argv[2];
if (!path) {
  console.error('usage: node scripts/inspect-snapshot.mjs <nuvio_simkl_sync.properties>');
  process.exit(1);
}

/** Undo Java Properties escaping to recover the embedded JSON. */
function unescapeProperties(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== '\\' || i + 1 >= text.length) {
      out += c;
      continue;
    }
    const n = text[++i];
    if (n === 'u') {
      out += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16));
      i += 4;
    } else if (n === 'n') out += '\\n'; // kept as a JSON escape, not a raw newline
    else if (n === 't') out += '\\t';
    else if (n === 'r') out += '\\r';
    else if (n === '\\') out += '\\'; // the pair decodes to one backslash
    else out += n;
  }
  return out;
}

const raw = readFileSync(path, 'utf8');
const line = raw.match(/^simkl_sync_snapshot_\d+=(.*)$/m);
if (!line) throw new Error('no simkl_sync_snapshot_N key found in that file');

const snapshot = JSON.parse(unescapeProperties(line[1]));
const anime = (snapshot.entries ?? []).filter((e) => e.mediaType === 'anime');

let withAnilist = 0;
let withMalOnly = 0;
let unmappable = 0;
let unsupportedStatus = 0;
const byStatus = new Map();
const samples = [];

for (const entry of anime) {
  const d = toDesiredState(entry);
  if (!d) {
    unsupportedStatus++;
    continue;
  }
  byStatus.set(d.status, (byStatus.get(d.status) ?? 0) + 1);
  if (d.anilistId) withAnilist++;
  else if (d.malId) withMalOnly++;
  else {
    unmappable++;
    samples.push(`${d.title} (simkl=${d.simklId})`);
  }
}

console.log(`anime entries:              ${anime.length}`);
console.log(`  direct AniList id:        ${withAnilist}`);
console.log(`  MAL id only (needs 1 lookup each): ${withMalOnly}`);
console.log(`  no usable id:             ${unmappable}`);
console.log(`  unsupported list status:  ${unsupportedStatus}`);
console.log('\nby AniList status:');
for (const [status, n] of [...byStatus].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${status.padEnd(10)} ${n}`);
}
if (samples.length) {
  console.log('\nunmappable:');
  for (const s of samples.slice(0, 20)) console.log(`  - ${s}`);
}

const watching = anime
  .filter((e) => e.status === 'watching')
  .map(toDesiredState)
  .filter(Boolean);
console.log(`\ncurrently watching (${watching.length}) — what would be written:`);
for (const d of watching) {
  console.log(`  ${String(d.anilistId ?? `mal:${d.malId}`).padStart(7)}  ${d.progress
    .toString()
    .padStart(3)} ep  ${d.title}`);
}
