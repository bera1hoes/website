# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Visualizes Maplestory guild content player data as a CP vs Score scatter plot with a power-law regression fit. Supports multiple content types (Guild Wars, Guild Boss Battle, Global GBB, Guild Conquest, Guild Training Ground), selectable via a toggle in the controls bar. Players are color-coded by guild or class, with an interactive legend and tooltip panel.

**Hosting model:** the front-end is a **static site** served by a **Cloudflare Worker** (`worker.js`, deployed via `wrangler.jsonc`) whose `assets` binding points at `public/`. Chart data lives in **Workers KV** (binding `CHART_DATA`) and is the **sole source of truth — there is no Google in the loop**. The data is captured locally by the SwissKnife mitmproxy addon (`nexon_analyzer`), which reads guild-content ranking responses out of the game traffic and **`POST`s them to the Worker's `/chart` endpoint** (mirroring the roster `/guild` flow); SwissKnife also writes a per-week CSV backup. The page fetches data over GET from the same-origin `/api`. A simple `(s)hoes` landing page (`public/index.html`) links to the chart ("Charts") and the "Arena" tool.

## Files

All browser-served assets live under **`public/`**; `worker.js` and `wrangler.jsonc` are at the repo root.

- **worker.js** — Cloudflare Worker: static-asset host + KV-backed data API + ingestion + router. **`/api?action=...` reads from KV** (binding `CHART_DATA`): `getSheetNames`/`getData`/`getLastUpdated` return the stored value, or an empty result on a miss (no upstream — KV is authoritative). Responses are `cache-control: no-store` (KV *is* the store; no `caches.default` layer), so a re-read (the client's Reload) is always fresh. **`POST /chart`** is the ingestion endpoint: `Authorization: Bearer <CHART_WRITE_KEY>`, body `{ type, date: "MM-DD-YYYY", rows: [...] }` — it normalizes rows (drops missing cp/score), writes `data:<type>:<date>`, and upserts the date into `names:<type>` (sorted newest-first) with a fresh `updated` stamp. Other routes: `/guild` (POST/GET roster KV, binding `ROSTERS`), `/charts` → `Charts.html`, `/arena` → `Arena.html`, `/userinfo` → a separate UserInfo Worker, everything else → `public/` assets.
  - **KV key shapes:** `names:<type>` → `{ updated: <ISO>, sheets: [...] }` (`updated` is stamped at write time and rides the `getSheetNames` response as `x-last-updated`); `data:<type>:<sheet>` → bare rows array (no timestamp — the client's "Last updated" display is fed by `getSheetNames`). `CONTENT_TYPES` in `worker.js` is the ingestion allowlist and must mirror SwissKnife's mode → content-type map in `guild_wars.py`.
- **public/Charts.html** — Chart front-end **markup only** (~210 lines). Loads `/css/*.css` and, at the bottom, the ordered `/js/*.js` files (see Architecture). Served at `/charts`.
- **public/js/** — The chart's JavaScript, split into plain (non-module) `<script src>` files that share one global scope (so the inline `onclick=` handlers keep working). Load order matters; see Architecture.
- **public/css/** — `shared.css` (theme tokens), `charts.css`, `home.css`, `arena.css`. Charts.html links `shared.css` + `charts.css`.
- **public/index.html** — `(s)hoes` landing page. Buttons: Charts → `/charts`, Arena → `/arena`.
- **public/Arena.html** — the Arena tool page (served at `/arena`).
- **public/SampleData/GWLocalData.js** — Local debug data for Guild Wars. Defines `GW_LOCAL_DATA` (`{ 'MM_DD_YYYY': '<tsv string>' }`).
- **public/SampleData/GBBLocalData.js** / **GlobalGBBLocalData.js** / **GuildConquestLocalData.js** / **GTTLocalData.js** — same format for Guild Boss Battle (`GBB_LOCAL_DATA`), Global GBB (`GGBB_LOCAL_DATA`), Guild Conquest (`GC_LOCAL_DATA`), and Guild Training Ground (`GTT_LOCAL_DATA`).
- **public/SampleData/** — Raw `.tsv` exports and the local-data JS files.

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

`util` → `colors` → `gw-points` → `regression` → `data` → `io` → `legend` → `panel` → `chart` → `tables` → `experiments` → `main`

| File | Responsibility |
|---|---|
| `util.js` | `$id`, `setStats`/`clearStats` (R²/exp/eq cards), `applyFitDiff`/`fitDiffColor`/`fitDiffText`, `toGamingNotation` |
| `colors.js` | `GUILD_PALETTE`/`GUILD_COLORS`/`CLASS_COLORS`, `assignGuildColors`, `getColor` |
| `gw-points.js` | `GW_POINTS_DATA` (rank→points TSV literal) |
| `regression.js` | `powerRegression`, `computeClassBias`, `computeFitDiffs` |
| `data.js` | `currentData`, `localFiles`, `parseTSV`, `parseGWPoints`, `getLocalData` |
| `io.js` | env detection (`API_URL`/`IS_LOCAL`/`IS_REMOTE`), `apiCall`, `loadContentType`, `loadSheet`, reload + sheet/content state, `loadLocalFiles` |
| `legend.js` | `colorMode`, `selectedGroups`, `setColorMode`, `updateColors`, `applyHighlights`, `buildLegend` |
| `panel.js` | `activeEl`, `isPinned`, `showPanel`, `positionPanel`, `closePanel` |
| `chart.js` | chart render handles + fit state, `buildChart` and its helpers, `resetZoom` |
| `tables.js` | player-table state, `buildPivotTable`, `buildPlayerTable`, `renderPlayerTable` |
| `experiments.js` | custom-fit / CP-filter / regress / class-adjust state + handlers |
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

**Secrets** (one-time, `wrangler secret put`): `CHART_WRITE_KEY` (guards `POST /chart` — must match SwissKnife's `chart_write_key`), `ROSTER_WRITE_KEY` (guards `POST /guild`), `USERINFO_READ_KEY` (Arena proxy).

**Data ingestion:** chart data is written by SwissKnife's `_upload_to_kv()` (`guild_wars.py`) via `POST /chart`. There is no migration/seed step — KV is fed directly. A missing key just returns an empty result until the next upload fills it. SwissKnife also keeps an optional **direct Google Sheets** upload (`_upload_to_sheets()`, its own OAuth creds) and a **per-week CSV backup** (`backups/<mode>_<MM-DD-YYYY>.csv`) as independent safety copies the site never reads.
