/**
 * Simkl API client — read side only.
 *
 * Auth uses the device PIN flow (see scripts/auth-simkl.mjs); the resulting
 * access token does not expire, so there is no refresh path here.
 */

const BASE = 'https://api.simkl.com';

export class SimklClient {
  constructor({ clientId, accessToken, fetchImpl = fetch }) {
    if (!clientId) throw new Error('SIMKL_CLIENT_ID is required');
    if (!accessToken) throw new Error('SIMKL_ACCESS_TOKEN is required');
    this.clientId = clientId;
    this.accessToken = accessToken;
    this.fetch = fetchImpl;
  }

  async #get(path, params = {}) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const res = await this.fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${this.accessToken}`,
        'simkl-api-key': this.clientId,
        'User-Agent': 'simkl-anilist-bridge/0.1',
      },
    });
    if (res.status === 401) throw new Error('Simkl rejected the access token (401) — re-run `npm run auth:simkl`');
    if (!res.ok) throw new Error(`Simkl ${path} failed: ${res.status} ${await res.text().catch(() => '')}`.trim());
    // Simkl answers 204 with an empty body when a delta window has no changes.
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /** Cheap poll: one request returning last-modified timestamps per domain. */
  activities() {
    return this.#get('/sync/activities');
  }

  /**
   * Anime list items. Passing `dateFrom` (an ISO timestamp from a previous
   * `activities().anime.all`) returns only entries changed since then.
   */
  async animeItems({ dateFrom } = {}) {
    const body = await this.#get('/sync/all-items/anime', {
      extended: 'full',
      episode_watched_at: 'yes',
      date_from: dateFrom,
    });
    return body?.anime ?? [];
  }
}

/** Simkl nests the media under a key named after its type. */
export function simklBody(entry) {
  return entry.anime ?? entry.show ?? entry.movie ?? {};
}
