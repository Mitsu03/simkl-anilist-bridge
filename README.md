# simkl-anilist-bridge

Mirrors your Simkl anime progress onto AniList. Runs on Cloudflare Workers on a
cron trigger, so it keeps working whether you tick an episode off in Nuvio, on
simkl.com, on your phone, or on the TV — nothing depends on a particular machine
being switched on.

Simkl has no two-way AniList sync and no webhooks; the [feature request][req]
has sat unanswered since February 2024. This closes the gap in one direction.

[req]: https://support.simkl.org/forums/264009-top-ideas-from-the-community/suggestions/47761910-full-sync-with-anilist

## Why this is simpler than it sounds

Simkl exposes an `anilist` id on nearly every anime entry, and splits anime into
per-season entries the same way AniList does. So there is no title matching and
no season-numbering translation — the hard parts of this problem don't exist.
Measured against a real 974-entry Simkl library:

| | |
|---|---|
| entries with a direct AniList id | 960 (98.6%) |
| resolvable via their MAL id | 14 |
| unmappable | 0 |

The field mapping is close to a rename:

| Simkl | AniList |
|---|---|
| `watched_episodes_count` | `progress` |
| `watching` | `CURRENT` |
| `plantowatch` | `PLANNING` |
| `hold` | `PAUSED` |
| `completed` | `COMPLETED` |
| `dropped` | `DROPPED` |
| `user_rating` (1–10) | `scoreRaw` (0–100) |

## How a run works

1. Poll Simkl `/sync/activities` — one cheap request. If the anime timestamp is
   unchanged, stop. This is what almost every run does.
2. Fetch only entries changed since the stored watermark (everything on the
   first run).
3. Fetch the AniList list once and diff, so a first run over an already-aligned
   library costs almost no writes.
4. Queue the writes and drain them under a per-invocation budget. A cron tick
   can't run for 40 minutes, so an initial backlog spreads over several ticks.

The watermark only advances once its queue has fully drained, so an interrupted
run retries rather than silently skipping entries.

## Setup

### 1. Credentials

Register a Simkl app at <https://simkl.com/settings/developer> (the redirect URI
is unused by the PIN flow — `urn:ietf:wg:oauth:2.0:oob` is fine).

For AniList, use an app from <https://anilist.co/settings/developer> with its
redirect URI set to `https://anilist.co/api/v2/oauth/pin`.

```bash
npm install
npm run auth:simkl      # device PIN flow, no local server needed
npm run auth:anilist    # paste the code AniList shows you
```

Both write into `.dev.vars`, which is gitignored. Simkl tokens don't expire;
AniList tokens last about a year.

### 2. Check what it would do

```bash
npm run dryrun -- --force
```

Writes nothing. Prints every entry it would create or update and why. Run this
before deploying — the first run against an AniList list that is behind Simkl
can be several hundred writes.

You can also validate the mapping fully offline against a Nuvio desktop sync
snapshot, without credentials or network:

```bash
node scripts/inspect-snapshot.mjs ~/path/to/nuvio_simkl_sync.properties
```

### 3. Deploy

```bash
npx wrangler login
npx wrangler kv namespace create BRIDGE_STATE   # paste the id into wrangler.toml
npx wrangler secret put SIMKL_CLIENT_ID
npx wrangler secret put SIMKL_ACCESS_TOKEN
npx wrangler secret put ANILIST_ACCESS_TOKEN
npx wrangler secret put BRIDGE_TOKEN            # any long random string
npm run deploy
```

The cron runs every 10 minutes by default; edit `crons` in `wrangler.toml` to
change that. This sits far inside the Workers free tier.

## Operating it

All HTTP routes require the `BRIDGE_TOKEN`, as either `?key=…` or an
`Authorization: Bearer …` header — the workers.dev URL is public.

| Route | Does |
|---|---|
| `GET /?key=…` | current watermark and queue depth |
| `GET /run?key=…` | run now |
| `GET /run?key=…&dry=1` | plan without writing |
| `GET /run?key=…&force=1` | ignore the watermark, re-compare everything |
| `POST /reset?key=…` | clear state; the next run does a full comparison |

`npm run tail` streams live logs.

## Deliberate limits

- **One direction only.** Simkl → AniList. Changes made on AniList are not
  pushed back, and a two-way version would need conflict resolution that Simkl's
  API gives no good basis for.
- **It never deletes.** Removing something from your Simkl list leaves the
  AniList entry alone. Simkl's delta feed reports removals separately and acting
  on them automatically is too destructive for the value it adds.
- **It won't lower progress by default.** If Simkl reports fewer watched
  episodes than AniList already has, the write is skipped and logged as a
  warning; status and score changes still go through. Set `ALLOW_LOWERING=true`
  if you want an exact mirror.
- **Latency is the cron interval.** Simkl has no webhooks, so polling is the
  only option.
