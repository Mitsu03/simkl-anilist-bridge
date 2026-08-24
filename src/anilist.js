/**
 * AniList GraphQL client — the write side of the bridge.
 *
 * AniList's documented budget is 90 requests/minute but it has been running
 * degraded at 30/minute for long stretches, so the default limiter here is
 * deliberately conservative and every response's rate-limit headers are honoured.
 */

const ENDPOINT = 'https://graphql.anilist.co';

const VIEWER_QUERY = `
query {
  Viewer {
    id
    name
    mediaListOptions { scoreFormat }
  }
}`;

const LIST_QUERY = `
query ($userId: Int) {
  MediaListCollection(userId: $userId, type: ANIME) {
    lists {
      entries { mediaId progress status score(format: POINT_100) }
    }
  }
}`;

const SAVE_MUTATION = `
mutation ($mediaId: Int, $progress: Int, $status: MediaListStatus, $score: Int) {
  SaveMediaListEntry(mediaId: $mediaId, progress: $progress, status: $status, scoreRaw: $score) {
    id
    mediaId
    progress
    status
  }
}`;

export class AniListClient {
  constructor({ accessToken, fetchImpl = fetch, minIntervalMs = 2400, log = () => {} }) {
    if (!accessToken) throw new Error('ANILIST_ACCESS_TOKEN is required');
    this.accessToken = accessToken;
    this.fetch = fetchImpl;
    this.minIntervalMs = minIntervalMs;
    this.log = log;
    this.nextAllowedAt = 0;
  }

  async #throttle() {
    const wait = this.nextAllowedAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  async #request(query, variables, attempt = 0) {
    await this.#throttle();
    this.nextAllowedAt = Date.now() + this.minIntervalMs;

    const res = await this.fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 429) {
      // Retry-After is in seconds; AniList sometimes omits it on burst rejections.
      const retryAfter = Number(res.headers.get('retry-after') ?? 60);
      if (attempt >= 3) throw new Error(`AniList rate limited after ${attempt} retries`);
      this.log(`rate limited, backing off ${retryAfter}s`);
      await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
      return this.#request(query, variables, attempt + 1);
    }
    if (res.status === 401) throw new Error('AniList rejected the token (401) — re-run `npm run auth:anilist`');

    const body = await res.json().catch(() => null);
    if (!res.ok && !body) throw new Error(`AniList request failed: ${res.status}`);

    // Partial success is normal for aliased batch lookups: unknown ids come back
    // as null entries alongside an errors array. Only throw when nothing resolved.
    if (body?.errors?.length && body.data == null) {
      throw new Error(`AniList error: ${body.errors.map((e) => e.message).join('; ')}`);
    }
    // Remaining budget is advisory but lets us slow down before hitting 429.
    const remaining = Number(res.headers.get('x-ratelimit-remaining'));
    if (Number.isFinite(remaining) && remaining < 10) this.nextAllowedAt = Date.now() + 5000;

    return body.data;
  }

  async viewer() {
    const data = await this.#request(VIEWER_QUERY, {});
    return data.Viewer;
  }

  /**
   * The whole anime list in one request. Scores are always requested as
   * POINT_100 so the bridge can compare and write in a single scale
   * regardless of how the user has AniList configured to display them.
   */
  async listEntries(userId) {
    const data = await this.#request(LIST_QUERY, { userId });
    const byMediaId = new Map();
    for (const list of data.MediaListCollection?.lists ?? []) {
      for (const e of list.entries ?? []) byMediaId.set(e.mediaId, e);
    }
    return byMediaId;
  }

  saveEntry({ mediaId, progress, status, score }) {
    return this.#request(SAVE_MUTATION, { mediaId, progress, status, score });
  }

  /**
   * Resolve MAL ids to AniList ids using aliased fields so a batch costs one
   * request. Returns a Map of malId -> anilistId for those that resolved.
   */
  async resolveMalIds(malIds, batchSize = 25) {
    const out = new Map();
    const ids = [...new Set(malIds.map(Number).filter(Number.isFinite))];

    for (let i = 0; i < ids.length; i += batchSize) {
      const chunk = ids.slice(i, i + batchSize);
      const query = `query {\n${chunk
        .map((id) => `  m${id}: Media(idMal: ${id}, type: ANIME) { id idMal }`)
        .join('\n')}\n}`;
      const data = await this.#request(query, {});
      for (const id of chunk) {
        const hit = data?.[`m${id}`];
        if (hit?.id) out.set(String(id), hit.id);
      }
    }
    return out;
  }
}

/** Simkl ratings are 1-10; AniList's scoreRaw is an integer 0-100. */
export function toScoreRaw(simklRating) {
  if (simklRating == null) return null;
  const n = Number(simklRating);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(Math.min(10, n) * 10);
}
