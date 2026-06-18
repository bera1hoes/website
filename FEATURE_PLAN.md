# Feature Plan — KV-backed read model (demand-driven)

Move chart data into **Cloudflare Workers KV** and serve the read path entirely
from KV. Google Sheets / Apps Script is touched only on (a) a cache miss
(lazy first-fill) and (b) an explicit user **Reload**. No cron, no edge cache.

## Status (2026-06-16)

Implemented on branch `worktree-feature+kv-data-store`. Verified locally with
`wrangler dev` (local KV) + headless Chrome remote-mode render (137 GW dots,
R²=0.8966). **Production cutover (deploy + seed the live namespace) is the only
remaining step and is intentionally gated on explicit go-ahead** — it changes the
live site.

| Task | State |
|---|---|
| T1 — Provision KV namespace + binding | ✅ Done — `CHART_DATA` created (prod `1b5aa7e0…`, preview `8dbd710f…`), bound in `wrangler.jsonc` |
| T2 — Worker read path from KV (+ lazy fallback) | ✅ Done — verified via curl (KV hit + lazy fill for an unseeded type) |
| T3 — Reload-triggered re-sync (bust) | ✅ Done — `?bust=1` refetches + overwrites; verified |
| T4 — Strip the old edge-cache machinery | ✅ Done — `caches.default`/`TS_*`/`currentTimestamp`/`tsInflight` removed |
| T5 — Client + docs (io.js, CLAUDE.md) | ✅ Done — io.js needs no change; CLAUDE.md updated |
| M — One-time migration / seed | 🟡 Mechanism built + verified locally (`/admin/seed`); **production seed pending go-ahead** |

Prior plan (F1 history, F2 search, F3 deep-links, F7 worker cache) is complete
and shipped — see git history / merged PRs #13, #14.

---

## Why

The hot path today is browser → `/api` (Worker) → `caches.default` → Apps
Script → Sheets, with timestamp-validated edge caching in `worker.js`. Two
weaknesses: `caches.default` is **per-PoP** (every cold colo re-hits Google), and
Apps Script sits **on the user's critical path** (cold-load latency + exposure to
its 6-min/30-concurrent quotas).

KV is account-global and removes Google from the request path. Because **KV is
itself an edge cache** (its `cacheTtl` pins hot values per-PoP) and **Reload is
global + demand-driven** (the first user to reload pulls fresh data into KV for
*everyone*), we need neither a `caches.default` layer nor a cron.

## Final design

### KV schema (namespace bound as `CHART_DATA`)

| Key | Value |
|---|---|
| `names:<type>` | `{ "updated": "<Drive ISO>", "sheets": ["MM-DD-YYYY", …] }` |
| `data:<type>:<sheet>` | `[ {rank, nick, score, …}, … ]` (bare rows array) |

The Drive modified timestamp is **per spreadsheet** (one per content type), so it
lives once in `names` — *not* duplicated into every `data` object. `getData`
therefore needs no timestamp: the client's "Last updated" display is per content
type and is fed by `getSheetNames`'s `x-last-updated` header (fetched on every
content-type load and on Reload). ~5 types × (1 `names` + ~30 `data`) ≈ 160 keys,
~3 MB — trivially within limits.

### Read path (normal request — never touches Google)

- `getSheetNames&contentType=X` → `CHART_DATA.get("names:X")`; return `.sheets`,
  set `x-last-updated: .updated`.
- `getData&contentType=X&sheet=S` → `CHART_DATA.get("data:X:S")`; return the array.
- **Lazy fallback:** missing key → fetch from Apps Script, write the KV key(s),
  then return. Self-heals cold starts and new content types even if the seed
  missed them.

### Reload path (`bust=1` — the only routine Google call)

`bust=1` **bypasses KV, fetches from Apps Script, overwrites KV, returns fresh.**
The client (`reloadSheet` → `loadSheet(…, bust)` + `refreshSheetNames`) already
sends `bust` on both `getData` and `getSheetNames`; each goes to Google
independently and overwrites its own KV key, so there is **no KV read-after-write
race** between them. On a `getSheetNames&bust`, also refresh `.updated` from
`getLastUpdated`. The existing 60s client cooldown gates the Apps Script quota.

### What gets deleted

`caches.default`, `currentTimestamp`, `tsInflight`, `asCacheHit`,
`TS_TTL`/`TS_BUST_REUSE_MS`/`VALIDATED_TTL`/`DEFAULT_TTL`, and the per-request
timestamp-revalidation dance. `worker.js` collapses to: KV read → fallback →
reload-sync. Responses become `cache-control: no-store` (KV is the cache).

### Tradeoff accepted

A brand-new sheet state is invisible until *someone* hits Reload; there's no
automated freshness floor. Fine for an active community (someone always reloads
during a run), and the "Last updated" display signals staleness. A cron can be
bolted on later reusing the same sync code if this ever bites.

---

## Tasks

### T1 — Provision KV namespace + binding
**Files:** `wrangler.jsonc`
- `wrangler kv namespace create CHART_DATA` and `… --preview` (for `wrangler dev`).
- Add the `kv_namespaces` binding (`binding: "CHART_DATA"`, `id`, `preview_id`).
- **Verify:** `wrangler kv namespace list` shows it; `wrangler dev` boots with the
  binding available as `env.CHART_DATA`.

### T2 — Worker read path from KV + lazy fallback
**Files:** `worker.js`
- Add `CONTENT_TYPES` (must mirror `Code.gs` `CONTENT_SOURCES` keys).
- Helpers: `appsScriptJson(action, params)` (wrap existing `fetchUpstream` + JSON
  validation), `kvNames(env, type)`, `kvData(env, type, sheet)`.
- `handleApi`:
  - `getSheetNames`: read `names:type`; if absent → fetch `getSheetNames` +
    `getLastUpdated`, write `names:type`, then serve. Return `.sheets`,
    `x-last-updated: .updated`.
  - `getData`: read `data:type:sheet`; if absent → fetch `getData`, write key
    (and ensure `names:type` exists), then serve.
- **Verify (wrangler dev + curl):** both actions return JSON of the same shape as
  the current proxy; `wrangler kv key delete data:Guild Wars:<sheet>` then re-hit
  → repopulates and returns correct data.

### T3 — Reload-triggered re-sync (`bust=1`)
**Files:** `worker.js`, `public/js/io.js` (verify only)
- In `handleApi`, when `bust` present: skip the KV read, fetch fresh from Apps
  Script, overwrite the KV key, return fresh. `getSheetNames&bust` also refreshes
  `getLastUpdated` into `names.updated`.
- `io.js`: confirm `reloadSheet`/`refreshSheetNames` still thread `bust`; confirm
  the "Last updated" display updates from `getSheetNames`'s `x-last-updated`
  (no longer relies on `getData` carrying it).
- **Verify:** with a mocked/edited upstream, Reload swaps to fresh data and bumps
  the timestamp; a new dated sheet appears in the dropdown; cooldown still blocks
  a second Reload for 60s.

### T4 — Strip old edge-cache machinery
**Files:** `worker.js`
- Remove `caches.default` usage, `currentTimestamp`, `tsInflight`, `asCacheHit`,
  `parseTimestamp` (if now unused), and the `TS_*`/`*_TTL` constants. Set
  responses to `cache-control: no-store`. Keep `jsonError` + the upstream
  JSON-validation guard.
- **Verify:** `worker.js` diff is net-negative; `wrangler dev` still serves all
  routes; no references to removed symbols remain (grep).

### T5 — Client + docs
**Files:** `public/js/io.js`, `CLAUDE.md`
- Confirm all three data modes still work: `IS_LOCAL` (untouched), `HAS_GAS`
  (untouched), `IS_REMOTE` (now KV-backed). No functional client change expected
  beyond T3's verification.
- Update `CLAUDE.md`: `worker.js` description + Deployment section to describe the
  KV store, lazy fallback, reload-sync, and the new `wrangler` KV step.
- **Verify:** headless render check (below) passes in all three modes.

---

## Test plan

No build/test suite exists; checks are manual + headless (see memory:
*headless-render-verification*).

1. **Worker unit/integration (`wrangler dev` + curl):**
   - `GET /api?action=getSheetNames&contentType=Guild%20Wars` → JSON array, has
     `x-last-updated` header.
   - `GET /api?action=getData&contentType=Guild%20Wars&sheet=<date>` → row array.
   - Delete the KV key, re-request → lazy fallback repopulates (assert identical
     body, second request now a pure KV hit).
   - `…&bust=1` → overwrites KV from upstream and returns fresh.
2. **Local sample mode (regression):** from `public/`,
   `python -m http.server 8765 --bind 127.0.0.1`; headless Chrome
   `--headless=new --disable-gpu --dump-dom`; assert ~127 `class="dot"`,
   `fit-line`, and `id="r2"` ≈ 0.9365 for the GW sample. Confirms KV work didn't
   touch the local path.
3. **Remote e2e:** `wrangler dev` + Chrome `--host-resolver-rules` mapping the
   site host to localhost (per memory note); load `/charts`, switch content
   types, switch sheets, hit Reload, confirm chart + "Last updated" update.
4. **Cold-start:** empty namespace, load the site → every view self-fills via
   fallback and renders (slower first paint, correct data).
5. **Quota sanity:** confirm a normal session issues **zero** Apps Script calls
   after the keys exist (only KV reads); Reload issues exactly the expected
   `getLastUpdated`/`getSheetNames`/`getData` calls.

---

## M — One-time migration / seed

Goal: populate KV before cutover so first users don't all pay fallback latency.
Lazy fallback makes the seed a *latency* optimization, not a correctness
requirement — so this is low-risk.

1. **Provision** (T1) the namespace and binding; deploy is not yet flipped.
2. **Seed via a temporary guarded route.** Add a throwaway
   `/admin/seed?key=<secret>` handler to `worker.js` that loops `CONTENT_TYPES`:
   for each, `getLastUpdated` + `getSheetNames`, write `names:type`, then
   `getData` for **every** listed sheet and write each `data:type:sheet`. Guard
   with a `SEED_KEY` Wrangler secret; return a per-key summary.
   - Run once: `curl "https://hoes.fyi/admin/seed?key=<secret>"`.
   - Alternative if you'd rather not ship a route: generate the JSON locally and
     `wrangler kv bulk put`.
3. **Verify the seed:** `wrangler kv key list --binding CHART_DATA` shows
   `names:*` + `data:*:*` for all five content types; spot-check a `get`.
4. **Cutover:** deploy `worker.js` with the KV read path (T2–T4) live. Because
   lazy fallback is in place, any key the seed missed self-heals on first access.
5. **Clean up:** follow-up deploy removing the `/admin/seed` route; delete the
   `SEED_KEY` secret.

**Rollback:** `git revert` the `worker.js` change back to the Apps Script proxy.
KV keys remain but are simply ignored; no data is lost and `Code.gs` was never
modified. Cutover and rollback are both single deploys.
