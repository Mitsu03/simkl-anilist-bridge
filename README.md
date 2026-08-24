# simkl-anilist-bridge

Mirrors your Simkl anime progress onto AniList. Runs on a GitHub Actions
schedule, so it keeps working whether you tick an episode off in Nuvio, on
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

Push the repository to GitHub, then add three secrets:

```bash
gh secret set SIMKL_CLIENT_ID       # values from .dev.vars
gh secret set SIMKL_ACCESS_TOKEN
gh secret set ANILIST_ACCESS_TOKEN
```

`.github/workflows/sync.yml` then runs every 5 minutes. Trigger one by hand
with `gh workflow run sync.yml`, or add `-f force=true` to ignore the watermark
and re-compare the whole library.

State — the Simkl watermark and any undrained write queue — is a single JSON
file kept on an orphan `state` branch, so scheduled runs stay stateful without
adding commit noise to the default branch.

### Cost

The repository is public, so Actions minutes are unlimited. On a **private**
repo a 5-minute cron would blow straight through a free account's 2 000
minutes/month — lengthen the cron a long way before making it private.

Two GitHub behaviours worth knowing: scheduled runs are queued at low priority
and get dropped under load, so a 5-minute cron in practice fires every 5-15
minutes; and GitHub disables scheduled workflows on a public repository after
60 days with no commits, which needs a manual re-enable.

## Why not Cloudflare Workers

The first version of this ran on a Worker, which is a better fit on paper: cron
triggers, KV for state, generous free tier. **AniList blocks the Cloudflare
Workers egress IPs.** The same token and query answer `200` from a laptop and
are refused from a Worker with *"You have been manually blocked"* — the block is
on the shared origin, not on any credential, and no amount of retrying or
throttling gets around it. Simkl works fine from a Worker; only the AniList side
is affected, which is unfortunately the half that matters.

GitHub's runners are not blocked, which is why the bridge lives here. Any host
you move it to needs checking the same way — one `{ Viewer { id name } }` query
from that host answers it.

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
