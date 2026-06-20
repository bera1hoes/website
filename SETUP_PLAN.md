# Setup Plan — fork-and-deploy wizard for a Bera guild

A guided script (`npm run setup`) that lets another **Bera** guild stand up their
own copy of this site on **their own Cloudflare account**, automating as much as
possible.

> **Reworked 2026-06-19 — the data source changed.** PR #27
> (`Drop Google Sheets: KV is the sole chart-data source`) removed Google from the
> loop entirely. `Code.gs`, `appsscript.json`, `.claspignore`, and
> `scripts/deploy-gas.mjs` are **deleted**; `worker.js` has no `APPS_SCRIPT_URL`.
> Chart data is now **captured by SwissKnife** (the `nexon_analyzer` mitmproxy
> addon) and **`POST`ed to the Worker's `/chart` endpoint** into Workers KV, which
> is the sole source of truth. **Every Apps Script / clasp / spreadsheet task in
> the prior versions of this plan is obsolete.**

## The data pipeline now

```
Maplestory game traffic
  └─(mitmproxy intercept)─► SwissKnife nexon_analyzer (LOCAL, on the capturer's PC)
       guild_wars.py: captures /get_guild_*_ranking_list
       ├─ POST <site>/chart   (Bearer CHART_WRITE_KEY)   ← PRIMARY chart data
       ├─ POST <site>/guild   (Bearer ROSTER_WRITE_KEY)  ← rosters (Win Prediction)
       └─ optional CSV + Google-Sheets backups (the site never reads these)
                                  │
                                  ▼
            Cloudflare Worker (worker.js)
              POST /chart → CHART_DATA KV   GET /api → CHART_DATA KV (sole source; miss = empty)
              POST /guild → ROSTERS KV      GET /guild → ROSTERS KV
              static assets (public/)
                                  │
                                  ▼  browser (Charts.html)
```

So a fork no longer maintains spreadsheets — it **captures its own game traffic**
with SwissKnife. That is the new primary source of data, and the part a script
cannot fully automate.

## Already shipped / now obsolete

| Item | Status |
|---|---|
| Apps Script + clasp deploy (old A2/A4/B3) | ❌ **Obsolete** — files deleted; no Google in the loop |
| `browser` binding / Browser Rendering `/guild` (old A3) | ❌ **Obsolete** — `/guild` is KV-backed (`ROSTERS`), fed by SwissKnife |
| Edge-cache proxy in `worker.js` | ➡️ Replaced by `CHART_DATA` KV |
| Fork docs (old Part C) | ✅ README [*Run your own copy*](README.md#L79) already describes the Worker + SwissKnife flow |

## Status (remaining work)

| Task | State |
|---|---|
| A1 — Guard `/userinfo` so a fork can omit the binding without editing `worker.js` | ✅ Done ([worker.js](worker.js)) |
| A5 — *(optional)* guild name → accent pink from config | ⬜ Not started |
| B1 — `setup.mjs`: preflight (`wrangler login`) | ✅ Built |
| B2 — `setup.mjs`: collect config + **generate write keys** → `guild.config.json` | ✅ Built |
| B3 — `setup.mjs`: provision KV + render `wrangler.fork.jsonc` | ✅ Built |
| B4 — `setup.mjs`: `wrangler deploy -c` + set secrets + worker-side smoke test | ✅ Built |
| B5 — `setup.mjs`: wire SwissKnife (`nexon_config.json` or print Settings values) | ✅ Built |
| L — **Live test** (run by the first real forker; not done by the owner) | ⬜ Pending |
| C — *(optional)* SwissKnife capture quickstart + README pointer to `npm run setup` | ⬜ Not started |

> **Build notes (2026-06-19, branch `feature/fork-setup`):** the wizard is
> `scripts/setup.mjs` (`npm run setup`), with `wrangler.template.jsonc` + a
> git-ignored `guild.config.json`/`wrangler.fork.jsonc`. Refinements vs. the
> prose below: (1) it renders a separate **`wrangler.fork.jsonc`** and deploys
> with `wrangler deploy -c wrangler.fork.jsonc`, so the owner's committed
> `wrangler.jsonc` is never even read for deploy; (2) **secrets are set after
> `deploy`** (the worker must exist first); (3) `--dry-run` previews every action
> without creating anything. Live wrangler calls are intentionally **not** run by
> the owner — see task L.

---

## Scope & constraints

1. **Bera only** — no world parameterization; the 5 content types stay fixed
   (`CONTENT_TYPES` in [worker.js:4-10](worker.js#L4) must keep mirroring
   SwissKnife's `_MODE_CONTENT_TYPE` in [guild_wars.py:52-58](../../Python/SwissKnife/mitmproxy/addons/nexon_analyzer/guild_wars.py)).
2. **Forker brings their own Cloudflare account** — their own worker name,
   `*.workers.dev` subdomain, **their own KV namespaces** (the IDs in
   [wrangler.jsonc:12-24](wrangler.jsonc#L12) are the owner's), and their own
   secrets.
3. **Arena is owner-only** — disabled in forks (no `USERINFO_WORKER`).
4. **Data comes from SwissKnife capture** — the forker must run the mitmproxy
   addon against their own game client. The wizard can *configure* SwissKnife but
   cannot capture for them.

## The two systems a fork must provision

| System | What the fork needs | Automatable? |
|---|---|---|
| **Cloudflare Worker** | `wrangler login`; create `CHART_DATA` (+ `ROSTERS`) KV; set `CHART_WRITE_KEY` (+ `ROSTER_WRITE_KEY`) secrets; rename worker, drop `services`; `wrangler deploy`. | ✅ Mostly (one OAuth gate) |
| **SwissKnife capture** | Install mitmproxy + trust its cert; route the game client through it; set `roster_worker_url` + `chart_write_key` (+ `roster_write_key`) in `nexon_config.json`; capture rankings + Push. | ⚠️ Config yes; **capture is manual** |

## Gates (what the wizard pauses on / can't do)

| Gate | Why |
|---|---|
| `wrangler login` | Browser OAuth, one-time |
| mitmproxy install + cert trust + game routing | Local, machine-specific, hands-on |
| Actually capturing rankings each week | Requires playing/triggering the in-game ranking views; **ongoing, not one-time** |

The two old Google gates (Apps Script API toggle, web-app scope consent) are
**gone**. The new core manual work is the SwissKnife capture setup.

---

## Safety — can this break the main site?

No, given the guards below. The decision is to **not** use a throwaway account —
the next real forker tests the wizard in **their own** Cloudflare account.

**Primary protection: account isolation.** The live site (`website` worker, its
`CHART_DATA`/`ROSTERS` KV, its secrets) is in the *owner's* Cloudflare account.
The wizard's `wrangler` commands act only on the account the forker logged into,
so they can't reach the owner's Worker/KV/secrets. In particular:
- **Cross-account KV corruption is impossible.** Namespace IDs are account-scoped;
  a fork that failed to replace the owner's IDs would get a `wrangler deploy`
  failure ("namespace not found"), not a silent write to the owner's live KV.
- The `userinfo-worker` service binding behaves the same — a fork without it fails
  deploy (which is why B3 omits it), with no path to the owner's worker.

**Required guards (each closes a residual, owner-side risk):**
1. **Generate, never mutate.** ✅ Implemented — the wizard writes only
   git-ignored files (`guild.config.json`, `wrangler.fork.jsonc`) and deploys with
   `wrangler deploy -c wrangler.fork.jsonc`. The owner's committed `wrangler.jsonc`
   is never written (only read, to derive the guard values below).
2. **Fail closed on owner identity.** ✅ Implemented — `assertNotOwner()` reads
   the owner's worker `name` + KV ids live from the committed `wrangler.jsonc` and
   refuses to proceed if the fork's config matches either.
3. **B5 needs an explicit path.** ✅ Implemented — `swissknifeDataDir` defaults to
   blank (prints the values instead); it only writes where the forker points it.
4. **A1 is behavior-neutral** for the owner (the guard never fires while the
   `USERINFO_WORKER` binding is present); **A5 is optional/cosmetic** — review both
   before merging to the owner's deploy.

**Tradeoff:** the wizard ships unproven, so a bug means a rough first run for that
forker — but the main site's risk is nil with the guards above.

---

## Part A — Repo prep (small)

### A1 — Make `/userinfo` fork-safe (owner keeps Arena live)
- `worker.js`: guard the `/userinfo` route ([worker.js:458-483](worker.js#L458))
  with `if (!env.USERINFO_WORKER) return 404`. No behavior change for the owner
  (binding present); a fork that omits the binding 404s gracefully instead of
  throwing.
- The wizard then **omits the `services` binding** from the fork's
  `wrangler.jsonc`. *(optional)* it also drops the Arena button
  ([index.html:15](public/index.html#L15)) from the fork's `index.html`.

### A5 — *(optional)* Guild branding from config
`hoes` is hardcoded pink in `colors.js`. Optionally drive the highlighted guild +
accent from `guild.config.json` (`guildName`, `accentColor`).

---

## Part B — `setup.mjs` wizard (`npm run setup`)

Node (toolchain is `wrangler`). Automates the README's *Run your own copy* steps
and wires the same write keys into both ends.

### B1 — Preflight
- Check `node`, `git`, network; `wrangler login` (their account).

### B2 — Collect config + generate keys → `guild.config.json`
Prompts for `workerName` (+ optional `guildName`/`accentColor`/`enableArena`).
**Generate** strong random `CHART_WRITE_KEY` and `ROSTER_WRITE_KEY` (e.g.
`crypto.randomUUID()`×2) so both the Worker secret and SwissKnife get the *same*
value. `guild.config.json` is git-ignored.

```jsonc
{
  "workerName": "myguild-charts",
  "guildName": "MyGuild",       // optional (A5)
  "accentColor": "#f0a500",     // optional (A5)
  "enableArena": false,         // owner-only; keep false for forks
  "chartWriteKey": "<generated>",
  "rosterWriteKey": "<generated>",
  "swissknifeDataDir": ""       // optional: path to write nexon_config.json (B5)
}
```

### B3 — Provision KV + secrets + generate `wrangler.jsonc`
- `wrangler kv namespace create CHART_DATA` (+ `--preview`) → parse `id`/`preview_id`.
- `wrangler kv namespace create ROSTERS` → parse `id` (Win Prediction).
- Pipe the generated keys to `wrangler secret put CHART_WRITE_KEY` and
  `ROSTER_WRITE_KEY` (and `USERINFO_READ_KEY` only if `enableArena`).
- Render `wrangler.jsonc` from a template: their `workerName`, their KV ids,
  **omit** the `services` (USERINFO) binding. (Owner's committed `wrangler.jsonc`
  is untouched — the template is consumed only by the wizard.)

### B4 — Deploy + worker-side smoke test
- `wrangler deploy`.
- `curl "https://<worker>.../api?action=getSheetNames&contentType=Guild%20Wars"`
  → expect `[]` (Worker + KV wired; empty until SwissKnife uploads).
- `curl -X POST https://<worker>.../chart` (no auth) → expect **401** (ingestion
  guard live). No seed step — KV fills on the first SwissKnife push.

### B5 — Wire SwissKnife
The site URL + keys must match on the capture side
([config.py:25-31](../../Python/SwissKnife/mitmproxy/addons/nexon_analyzer/config.py)):
`roster_worker_url` = the deployed site URL, `chart_write_key` / `roster_write_key`
= the generated keys.
- If `swissknifeDataDir` is set: write/merge those fields into its
  `nexon_config.json`.
- Otherwise: **print** the URL + both keys with a note to paste them into
  SwissKnife → Settings (Win Prediction). Then the forker handles the
  capture-side install themselves.

---

## Part C — Docs (mostly done)

README already documents the Worker + SwissKnife fork. Remaining (optional): a
short **SwissKnife capture quickstart** (mitmproxy install, cert trust, route the
game, pick the upload mode, Push) and a one-line README pointer that
`npm run setup` automates the Cloudflare half.

---

## Deliverables

- `setup.mjs` + a `"setup"` script in `package.json` (B1–B5)
- `wrangler.template.jsonc` (fork config: KV-id placeholders, no `services`)
- `guild.config.json` (per-fork, git-ignored; holds the generated keys)
- A1 guard in `worker.js`; *(optional)* A5 branding
- *(optional)* SwissKnife capture quickstart doc

## Suggested sequencing

1. **A1** — one-line guard; verify owner site unchanged (Arena + `/userinfo` still
   work) via headless check (memory: *headless-render-verification*).
2. **B1 → B4** — the whole Cloudflare half is testable end-to-end with a throwaway
   Cloudflare account, no game/SwissKnife needed (KV provisioning, secrets,
   deploy, smoke test).
3. **B5** — exercise against a real SwissKnife `nexon_config.json` path.
4. **Part C** — quickstart + README pointer last.

## Verification

- After A1: owner's site unchanged; a fork that omits `services` deploys cleanly
  and `/userinfo` 404s gracefully.
- After Part B: `npm run setup` against a throwaway Cloudflare account yields a
  live Worker where `/api?action=getSheetNames` returns `[]`, an unauthenticated
  `POST /chart` returns 401, and an authenticated `POST /chart` from SwissKnife
  fills the chart.
