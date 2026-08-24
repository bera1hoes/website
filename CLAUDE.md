# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Visualizes Maplestory guild content player data as a CP vs Score scatter plot with a power-law regression fit. Supports multiple content types (Guild Wars, Guild Boss Battle, Global GBB, Guild Conquest, Guild Training Ground), selectable via a toggle in the controls bar. Players are color-coded by guild or class, with an interactive legend and tooltip panel.

**Hosting model:** the front-end is a **static site** served by a **Cloudflare Worker** (`worker.js`, deployed via `wrangler.jsonc`) whose `assets` binding points at `public/`. Chart data lives in **Workers KV** (binding `CHART_DATA`) and is the **sole source of truth — there is no Google in the loop**. The data is captured locally by the SwissKnife mitmproxy addon (`nexon_analyzer`), which reads guild-content ranking responses out of the game traffic and **`POST`s them to the Worker's `/chart` endpoint** (mirroring the roster `/guild` flow); SwissKnife also writes a per-week CSV backup. The page fetches data over GET from the same-origin `/api`. A simple `(s)hoes` landing page (`public/index.html`) links to the chart ("Charts") and the "Arena" tool.

## Files

All browser-served assets live under **`public/`**; `worker.js` and `wrangler.jsonc` are at the repo root.

- **worker.js** — Cloudflare Worker: static-asset host + KV-backed data API + ingestion + router. **`/api?action=...` reads from KV** (binding `CHART_DATA`): `getSheetNames`/`getData`/`getLastUpdated` return the stored value, or an empty result on a miss (no upstream — KV is authoritative). `getData` serves the stored `{ rows, rosters, perfProfile, guildHistory }` object **as-is** (the client's `rowsOf`/`rostersOf`/`perfOf`/`guildHistOf` read whichever shape arrives). Responses are `cache-control: no-store` (KV *is* the store; no `caches.default` layer), so a re-read (the client's Reload) is always fresh. **`POST /chart`** is the ingestion endpoint: `Authorization: Bearer <CHART_WRITE_KEY>`, body `{ type, date: "MM-DD-YYYY", rows: [...] }` — it normalizes rows (drops missing cp/score), **embeds the guilds' roster snapshot** from `ROSTERS` (pulled fresh on first create, carried over — with any `perfProfile`/`guildHistory` — on update), writes `data:<type>:<date>`, merges `guildweeks:<type>`, and upserts the date into `names:<type>` (sorted newest-first) with a fresh `updated` stamp. The actions `refreshRosters` (re-pull the embedded roster) and `buildPerfProfile` run **KV-only**; the latter scans the prior sheets once and embeds **both** the recency-weighted per-player profile (`perfProfile`, PERF_TYPES only) and the per-guild rollup of prior appearances (`guildHistory`, every content type — total Score + participant count per prior sheet, behind the pivot table's history columns). Other routes: `/guild` (POST/GET roster KV, binding `ROSTERS`), `/charts` → `Charts.html`, `/arena` → `Arena.html` (**Basic-Auth gated** when the `ARENA_PASSWORD` secret is set — any username, password checked; the direct `/Arena.html`/`/Arena` asset paths are folded into the same route so the catch-all can't bypass the gate; no secret → open), `/userinfo` → a separate UserInfo Worker, everything else → `public/` assets.
  - **`POST /baseline`** stores mapleidle.gg's per-content power-law "baseline" fits: `Authorization: Bearer <CHART_WRITE_KEY>` (same key as `/chart`), body `{ analysis: { fourth|sub: { <mapleidle mode>: { fitA, fitB, snapshotDate } } } }`. It maps their mode keys to our content types via `MAPLEIDLE_CONTENT` (their `worldBoss` has no counterpart and is dropped — reported back as `skipped`; our Global GBB has none on their side) and writes the single KV key `baselines`. Read back with `/api?action=getBaselines` (returns `null` on a miss). The route answers CORS preflights because its only client is cross-origin — see **mapleidle baselines** below.
  - **KV key shapes:** `names:<type>` → `{ updated: <ISO>, sheets: [...] }` (`updated` is stamped at write time and rides the `getSheetNames` response as `x-last-updated`); `data:<type>:<sheet>` → `{ rows: [...], rosters: { "<guild>": [...] }, perfProfile?: { "<nick>": factor }, guildHistory?: { "<guild>": [{ sheet, total, members }, …] } }` (legacy bare-array entries are still served — the client tolerates both); `guildweeks:<type>` → `{ "<guild>": ["MM-DD-YYYY", …] }` (all content types — the lookup that lets `buildPerfProfile` skip irrelevant prior sheets); `baselines` → `{ fetchedAt: <ISO>, source, cohorts: { fourth|sub: { "<content type>": { fitA, fitB, snapshotDate } } } }` (one key for every content type and both job cohorts). `CONTENT_TYPES` in `worker.js` is the ingestion allowlist and must mirror SwissKnife's mode → content-type map in `guild_wars.py`.
- **public/Charts.html** — Chart front-end **markup only** (~210 lines). Loads `/css/*.css` and, at the bottom, the ordered `/js/*.js` files (see Architecture). Served at `/charts`.
- **public/js/** — The chart's JavaScript, split into plain (non-module) `<script src>` files that share one global scope (so the inline `onclick=` handlers keep working). Load order matters; see Architecture.
- **public/css/** — `shared.css` (theme tokens), `charts.css`, `home.css`, `arena.css`. Charts.html links `shared.css` + `charts.css`.
- **public/index.html** — `(s)hoes` landing page. Buttons: Charts → `/charts`, Arena → `/arena`.
- **public/Arena.html** — the Arena tool page (served at `/arena`).
- **public/SampleData/GWLocalData.js** — Local debug data for Guild Wars. Defines `GW_LOCAL_DATA` (`{ 'MM_DD_YYYY': '<tsv string>' }`).
- **public/SampleData/GBBLocalData.js** / **GlobalGBBLocalData.js** / **GuildConquestLocalData.js** / **GTTLocalData.js** — same format for Guild Boss Battle (`GBB_LOCAL_DATA`), Global GBB (`GGBB_LOCAL_DATA`), Guild Conquest (`GC_LOCAL_DATA`), and Guild Training Ground (`GTT_LOCAL_DATA`).
- **public/SampleData/** — Raw `.tsv` exports and the local-data JS files.
- **tools/mapleidle-baseline.user.js** — Tampermonkey userscript that scrapes mapleidle's per-content baseline fits and pushes them to `POST /baseline`. Not served by the site; install it into Tampermonkey. See **mapleidle Baselines**.

## mapleidle Baselines

The chart shows a **MAPLEIDLE BASELINE** stats card: the power-law fit
mapleidle.gg/tools/score-analysis computes for the same content type over *every
ranked character in the game* (median, all classes pooled), next to our own fit
over one guild sheet. Their form is `Score = e^fitA · CP^fitB`; the card converts
to our `A × CP^B` so the two EQUATION cards compare directly.

**Why the capture is a userscript.** That page cannot be read by us from anywhere:
a Worker `fetch` is 429'd (datacenter IP), a scripted fetch is 429'd even from a
residential IP (automation fingerprint), and a visitor's cross-origin `fetch` is
CORS-blocked — the route sends no `Access-Control-Allow-Origin`, and `mode:
'no-cors'` yields an opaque, empty response. (Verified: `/news?_rsc=` *does* send
CORS headers and reads fine from a browser, so the block is route-specific, not a
mistake on our end.) There is no JSON API behind the page — the coefficients are
server-rendered into Next's RSC flight payload. So the capture runs **inside the
page**: `tools/mapleidle-baseline.user.js` is a Tampermonkey script matching
`/tools/score-analysis`, which rebuilds the flight text, brace-slices the
`analysis` object out of it, `JSON.parse`s it, drops everything but
`fitA`/`fitB`/`snapshotDate`, and POSTs to `/baseline` via `GM_xmlhttpRequest`
(exempt from CORS; `@connect hoes.fyi`). The `CHART_WRITE_KEY` lives in
Tampermonkey's `GM_setValue` storage, not in the file — so the script is safe to
share and prompts on first use ("set key / site" re-prompts).

**Weekly refresh** is enforced at both ends: the userscript reads the stored
`fetchedAt` first and asks for confirmation if it's under 7 days old, and the
front-end caches the `/api` response in `localStorage` (`mi_baselines`, 7-day TTL)
so the read happens about once a week per browser. The chart's **Reload** button
calls `bustBaselineCache()`, so a fresh push is visible without waiting out the
week.

A sibling userscript, `tools/mapleidle-performance-vs.user.js` (not part of the
site either), annotates mapleidle's own character pages from the same payload;
the two share the flight-parsing approach.

## Adding a New Content Type

1. Add the content-type name to `CONTENT_TYPES` in `worker.js` (the ingestion allowlist), and add the matching upload mode to `_MODE_CONTENT_TYPE` in SwissKnife's `guild_wars.py`.
2. Add a toggle button in the controls bar HTML in `public/Charts.html`.
3. Add a case to `getLocalData(type)` in `public/js/data.js`.
4. Create a `public/SampleData/<Name>LocalData.js` file defining the data constant.
5. Inject the new script file in the local boot sequence in `public/js/main.js`.

## TSV Format

Tab-separated with headers: `Rank`, `Nick`, `Score`, `Class`, `Level`, `CP`, `GuildName`, `ScoreShort`, `CP Short`. Rows with empty CP or Score are skipped. CP values may be in scientific notation (e.g. `1.90229E+15`), which `Number()` handles correctly. This is the column layout of the local SampleData files and the per-week CSV backups SwissKnife writes; the same fields ride the `POST /chart` payload as a `rows` array of objects.

## Local Debugging

The env-detection block lives in **`public/js/io.js`** and chooses one of two data modes at runtime:
- `IS_LOCAL` — `file://`, `localhost`, or no `API_URL` set → inject the `SampleData/*LocalData.js` files and use them.
- `IS_REMOTE` — deployed static page with `API_URL` set → `apiCall(action, params)` does a GET `fetch` to `API_URL` and parses JSON.

`API_URL` (in `io.js`) is `'/api'` — the same-origin Worker (see `worker.js`), which reads from KV. Response handlers tolerate both strings and parsed objects (`typeof json === 'string' ? JSON.parse(json) : json`). The per-content-type "Last updated" display is driven by `getSheetNames`' `x-last-updated` header (fetched on every content-type load and on Reload) and cached in `lastUpdatedCache`.

When local, the boot sequence in **`public/js/main.js`**:

1. Dynamically injects `GWLocalData.js`, then `GBBLocalData.js`, then `GlobalGBBLocalData.js` in sequence via `<script>` tags, then calls `loadContentType('Guild Wars')`.
2. `populateLocalSheets(currentContentType)` (in `io.js`) populates the sheet dropdown from the active content type's data object.
3. Switching the content type toggle calls `loadContentType(type)`, which re-runs `populateLocalSheets` with the new type.
4. To add a new date to GW: add a new key to `GW_LOCAL_DATA` in `GWLocalData.js`. Same pattern for the others.

**Requires a local HTTP server** — opening `Charts.html` directly as `file://` blocks the `<script src>` loads (the `/js/*.js` files and the injected SampleData). Use VS Code Live Server or `python -m http.server` from `public/`.

## Architecture (public/js/)

The JS is split into plain `<script src>` files sharing **one global scope** (no
ES modules, no build step). `Charts.html` loads them in this order — d3 first,
`main.js` (boot) **last**; everything in between only *declares* functions/state
used at runtime, so cross-file references resolve regardless:

`util` → `colors` → `gw-points` → `regression` → `data` → `io` → `legend` → `panel` → `chart` → `tables` → `experiments` → `estimate` → `baselines` → `deeplink` → `history` → `guild-history` → `search` → `prediction` → `main`

| File | Responsibility |
|---|---|
| `util.js` | `$id`, `setStats`/`clearStats` (R²/exp/eq cards), `applyFitDiff`/`fitDiffColor`/`fitDiffText`, `toGamingNotation`/`parseGamingNotation` |
| `colors.js` | `GUILD_PALETTE`/`GUILD_COLORS`/`CLASS_COLORS`, `assignGuildColors`, `getColor` |
| `gw-points.js` | `GW_POINTS_DATA` (rank→points TSV literal) |
| `regression.js` | `powerRegression`, `computeClassBias`, `computeFitDiffs` |
| `data.js` | `currentData`, `localFiles`, `parseTSV`, `parseGWPoints`, `getLocalData`, embedded-payload readers (`rowsOf`/`rostersOf`/`perfOf`/`guildHistOf`) + caches |
| `io.js` | env detection (`API_URL`/`IS_LOCAL`/`IS_REMOTE`), `apiCall`, `loadContentType`, `loadSheet`, reload + sheet/content state, `loadLocalFiles` |
| `legend.js` | `colorMode`, `selectedGroups`, `setColorMode`, `updateColors`, `applyHighlights`, `buildLegend` |
| `panel.js` | `activeEl`, `isPinned`, `showPanel`, `positionPanel`, `closePanel` |
| `chart.js` | chart render handles + fit state, `buildChart` and its helpers, `resetZoom` |
| `tables.js` | player-table state, `buildPivotTable`, `buildPlayerTable`, `renderPlayerTable`, manual score overrides |
| `experiments.js` | custom-fit / CP-filter / regress / class-adjust state + handlers |
| `estimate.js` | CP → expected score (runs `activeFit` forward): readout + chart marker (`renderEstimate`, `positionEstimateMarker`) |
| `baselines.js` | mapleidle's game-wide baseline fit for the current content type: weekly-cached read of `getBaselines` + the MAPLEIDLE BASELINE stats card (`loadBaselines`, `renderBaselineCard`, `bustBaselineCache`) |
| `deeplink.js` | URL-hash state (`updateDeepLink`, `restoreDeepLink`, `copyShareLink`) |
| `history.js` | week-over-week **player** deltas vs the previous sheet (`loadHistory`, `fmtPct`) |
| `guild-history.js` | per-**guild** rollup across prior weeks (`loadGuildHistory`, `applyBuiltEntry`, pivot history cells) |
| `search.js` | find-player box (`onPlayerSearch`, highlight/dim + pin on Enter) |
| `prediction.js` | Win Prediction (rosters, projections, adjust modes, `annotateSandbag`) |
| `main.js` | boot (local SampleData injection or remote auto-load) — runs last |

**Inline `onclick=` handlers in the markup rely on these functions staying
global** — keep them as plain `function name(){}` declarations (no IIFE, no
`const name = () =>`).

**`buildChart(data)` (chart.js)** is a thin orchestrator: `assignGuildColors` →
`joinGwPoints` → `computeFit` → `buildPivotTable`/`buildPlayerTable` → `setStats`
→ `buildLegend` → `renderScatter`. Supporting helpers:
- `computeFit(data)` — runs `powerRegression`, freezes the baseline into
  `frozenFit`, sets `activeFit`, and annotates rows via `computeFitDiffs`.
- `renderScatter(data, A, B, sigma)` — builds the whole SVG (scales, grid, axes,
  fit line + band, dots, zoom); `renderDots(data)` plots+wires the circles.
- `samplePower` / `bandFromFit` / `drawFit` / `drawBand` — shared fit-curve
  geometry, reused by the zoom handler and the CP-filter code in `experiments.js`.

**Key state objects** (replacing the former scattered `frozenA`/`chartA`/… globals):
- `frozenFit = { A, B, r2, sigma, fitPts, bandPts, classBias }` — baseline fit over the full dataset.
- `activeFit = { A, B }` — the fit currently shown; differs from `frozenFit` only while "recalculate on CP filter" is on.
- `custom = { A, B, path, pts }` — the Experiments custom fit.
- `cpFilter = { dataMin, dataMax, low, high }` — dataset bounds + active slider bounds.

**GW-specific features** (hidden when `currentContentType !== 'Guild Wars'`):
- GW Points join in `joinGwPoints` (chart.js)
- Guild War Points pivot table (`#pivot-section`)
- GW Points column in the player table (`#player-th-gwpoints`)
- GW Points row in the info panel (`#p-gwpts-row`) — already gated on `d.gwPoints > 0`

**Color system:**
- Guild colors: `hoes` is hardcoded pink; all other guilds are assigned from `GUILD_PALETTE` alphabetically on each `buildChart` call.
- Class colors: hardcoded in `CLASS_COLORS`.
- UI accent color (`#f0a500` amber) is used for stats cards, toggle buttons, and panel rank.

## Deployment

One target: the **Cloudflare Worker (static front-end + KV data API + ingestion).** Deploy with **`npm run deploy:cf`** (`wrangler deploy`). `wrangler.jsonc` binds `assets.directory: ./public`, `main: worker.js`, and the `CHART_DATA` + `ROSTERS` KV namespaces. The whole `public/` tree is published as static assets — including `js/`, `css/`, and `SampleData/`. `API_URL` stays `'/api'`.

**KV namespace** (one-time): `wrangler kv namespace create CHART_DATA` (+ `--preview` for `wrangler dev`); put the returned `id`/`preview_id` in `wrangler.jsonc` under `kv_namespaces`.

**Secrets** (one-time, `wrangler secret put`): `CHART_WRITE_KEY` (guards `POST /chart` — must match SwissKnife's `chart_write_key`), `ROSTER_WRITE_KEY` (guards `POST /guild`), `USERINFO_READ_KEY` (Arena proxy), `ARENA_PASSWORD` (optional — Basic-Auth password for the `/arena` page; unset = page is open).

**Data ingestion:** chart data is written by SwissKnife's `_upload_to_kv()` (`guild_wars.py`) via `POST /chart`. There is no migration/seed step — KV is fed directly. A missing key just returns an empty result until the next upload fills it. SwissKnife also keeps an optional **direct Google Sheets** upload (`_upload_to_sheets()`, its own OAuth creds) and a **per-week CSV backup** (`backups/<mode>_<MM-DD-YYYY>.csv`) as independent safety copies the site never reads.
