/**
 * JSON-file-backed state store.
 *
 * The bridge's state is three small values (watermark, pending watermark, and
 * an undrained write queue), so a single file is enough. In CI the file is
 * carried between runs on a dedicated branch; locally it just sits on disk.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export function fileStore(path) {
  const read = () => {
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, 'utf8') || '{}');
    } catch {
      // A corrupt state file must not wedge the bridge: starting from scratch
      // costs one full comparison, which plans no writes when already in sync.
      console.warn(`state file at ${path} was unreadable; starting fresh`);
      return {};
    }
  };

  return {
    async get(key) {
      return read()[key] ?? null;
    },
    async put(key, value) {
      const state = read();
      if (value === null || value === undefined) delete state[key];
      else state[key] = value;
      writeFileSync(path, JSON.stringify(state, null, 2) + '\n');
    },
  };
}
