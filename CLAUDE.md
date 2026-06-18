# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Visualizes Maplestory guild content player data as a CP vs Score scatter plot with a power-law regression fit. Supports multiple content types (Guild Wars, Guild Boss Battle, Global GBB, Guild Conquest, Guild Training Ground) from separate spreadsheets, selectable via a toggle in the controls bar. Players are color-coded by guild or class, with an interactive legend and tooltip panel.

**Hosting model:** the front-end is a **static site** served by a **Cloudflare Worker** (`worker.js`, deployed via `wrangler.jsonc`) whose `assets` binding points at `public/`. Chart data lives in **Workers KV** (binding `CHART_DATA`): the `/api` read path is served entirely from KV and never touches Google. Apps Script (`Code.gs`) is kept only as a thin **read-only JSON API** over the private Google Sheets and is reached *only* on a KV miss (lazy first-fill) or an explicit Reload (`?bust=1`). The page fetches data over GET from the same-origin `/api`. A simple `(s)hoes` landing page (`public/index.html`) links to the chart ("Charts") and the "Arena" tool.

## Files

All browser-served assets live under **`public/`**; `worker.js`, `wrangler.jsonc`, and `Code.gs` are at the repo root.

- **Code.gs** — Apps Script JSON API. `CONTENT_SOURCES` maps content type names to spreadsheet objects (IDs stay server-side, never exposed). `doGet(e)` dispatches on `?action=` (`getSheetNames` / `getData` / `getLastUpdated`) and returns JSON via `ContentService`. The three functions return native arrays/strings; `doGet` stringifies. **GET-only** — JSON POST bodies would trigger a CORS preflight Apps Script can't answer.
- **worker.js** — Cloudflare Worker: static-asset host + KV-backed data API + router. **`/api?action=...` reads from KV** (binding `CHART_DATA`): `getSheetNames`/`getData` return the stored value; a missing key triggers a **lazy first-fill** from Apps Script (`APPS_SCRIPT_URL`, server-side so no browser CORS) that writes KV then serves. **`?bust=1`** (the client's Reload) bypasses KV, refetches from Apps Script, overwrites the key, and returns fresh. KV is the cache, so responses are `cache-control: no-store` — there is no `caches.default` layer. **`/admin/seed?key=<SEED_KEY>[&type=]`** populates KV (one content type or all) for the one-time migration; guarded by the `SEED_KEY` secret. Other routes: `/charts` → `Charts.html`, `/arena` → `Arena.html`, `/userinfo` → a separate UserInfo Worker, everything else → `public/` assets. **Apps Script can't set CORS headers**, so the browser never calls it directly — only the Worker does.
  - **KV key shapes:** `names:<type>` → `{ updated: <Drive ISO|null>, sheets: [...] }` (the per-spreadsheet Drive timestamp lives here once, and rides the `getSheetNames` response as `x-last-updated`); `data:<type>:<sheet>` → bare rows array (no timestamp — the client's "Last updated" display is fed by `getSheetNames`). `CONTENT_TYPES` in `worker.js` must mirror the keys of `CONTENT_SOURCES` in `Code.gs`.
- **public/Charts.html** — Chart front-end **markup only** (~210 lines). Loads `/css/*.css` and, at the bottom, the ordered `/js/*.js` files (see Architecture). Served at `/charts`.
- **public/js/** — The chart's JavaScript, split into plain (non-module) `<script src>` files that share one global scope (so the inline `onclick=` handlers keep working). Load order matters; see Architecture.
- **public/css/** — `shared.css` (theme tokens), `charts.css`, `home.css`, `arena.css`. Charts.html links `shared.css` + `charts.css`.
- **public/index.html** — `(s)hoes` landing page. Buttons: Charts → `/charts`, Arena → `/arena`.
- **public/Arena.html** — the Arena tool page (served at `/arena`).
- **public/SampleData/GWLocalData.js** — Local debug data for Guild Wars. Defines `GW_LOCAL_DATA` (`{ 'MM_DD_YYYY': '<tsv string>' }`). **Never upload to Apps Script.**
- **public/SampleData/GBBLocalData.js** / **GlobalGBBLocalData.js** / **GuildConquestLocalData.js** / **GTTLocalData.js** — same format for Guild Boss Battle (`GBB_LOCAL_DATA`), Global GBB (`GGBB_LOCAL_DATA`), Guild Conquest (`GC_LOCAL_DATA`), and Guild Training Ground (`GTT_LOCAL_DATA`).
- **public/SampleData/** — Raw `.tsv` exports and the local-data JS files.

## Adding a New Content Type

1. Add an entry to `CONTENT_SOURCES` in `Code.gs` with the spreadsheet ID.
2. Add a toggle button in the controls bar HTML in `public/Charts.html`.
3. Add a case to `getLocalData(type)` in `public/js/data.js`.
4. Create a `public/SampleData/<Name>LocalData.js` file defining the data constant.
5. Inject the new script file in the local boot sequence in `public/js/main.js`.

## TSV Format

Tab-separated with headers: `Rank`, `Nick`, `Score`, `Class`, `Level`, `CP`, `GuildName`, `ScoreShort`, `CP Short`. Rows with empty CP or Score are skipped. CP values may be in scientific notation (e.g. `1.90229E+15`), which `Number()` handles correctly. Both GW and GBB spreadsheets use this same column layout.

## Local Debugging

The env-detection block lives in **`public/js/io.js`** and chooses one of three data modes at runtime:
- `HAS_GAS` — running embedded in Apps Script (`google.script.run`). Legacy/compat path.
- `IS_LOCAL` — `file://`, `localhost`, or no `API_URL` set → inject the `SampleData/*LocalData.js` files and use them.
- `IS_REMOTE` — deployed static page with `API_URL` set → `apiCall(action, params)` does a GET `fetch` to `API_URL` and parses JSON.

`API_URL` (in `io.js`) is `'/api'` — the same-origin Worker (see `worker.js`), which reads from KV (**not** the Apps Script URL directly — that would fail CORS). The real Apps Script `/exec` URL lives in `worker.js`. Response handlers tolerate both strings and parsed objects (`typeof json === 'string' ? JSON.parse(json) : json`). The client is unchanged by the KV migration: `getData` responses no longer carry `x-last-updated`, but the per-content-type "Last updated" display is driven by `getSheetNames` (fetched on every content-type load and on Reload) and cached in `lastUpdatedCache`.

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
| `io.js` | env detection (`API_URL`/`HAS_GAS`/`IS_LOCAL`/`IS_REMOTE`), `apiCall`, `loadContentType`, `loadSheet`, reload + sheet/content state, `loadLocalFiles` |
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

Two independent targets:

1. **Apps Script (data API):** run **`npm run deploy:gas`** (clasp). It `push`es `Code.gs`, then `deploy`s to the *existing* web-app deployment id (read from the `/exec` URL in `worker.js`) so the `APPS_SCRIPT_URL` never changes. A strict **`.claspignore`** whitelists only `Code.gs` + `appsscript.json`, so the `SampleData/*LocalData.js` files and the HTML can **never** be uploaded to Apps Script. The web app must stay **Execute as: me; Who has access: Anyone** (encoded in `appsscript.json` as `USER_DEPLOYING` / `ANYONE_ANONYMOUS`) — "Anyone" is required, or the server-side fetch gets a Google login page instead of JSON.
   - **One-time setup:** `npm install`; enable the Apps Script API at <https://script.google.com/home/usersettings>; `npm run gas:login`; create `.clasp.json` = `{ "scriptId": "<your script id>", "rootDir": "." }` (Script ID is in the Apps Script editor under Project Settings). `.clasp.json` and `.clasprc.json` are git-ignored. `npm run gas:status` lists deployments.
   - **New deployment?** If you ever mint a *new* Apps Script deployment, its `/exec` URL changes — update `APPS_SCRIPT_URL` in `worker.js` and the deploy script will pick up the new id automatically.
2. **Cloudflare Worker (static front-end + KV data API):** deploy with `wrangler` (`wrangler.jsonc` binds `assets.directory: ./public`, `main: worker.js`, and the `CHART_DATA` KV namespace). The whole `public/` tree is published as static assets — including `js/`, `css/`, and `SampleData/`. `API_URL` stays `'/api'`. If you ever create a *new* Apps Script deployment, its `/exec` URL changes — update `APPS_SCRIPT_URL` in `worker.js`.

**KV namespace** (one-time): `wrangler kv namespace create CHART_DATA` (+ `--preview` for `wrangler dev`); put the returned `id`/`preview_id` in `wrangler.jsonc` under `kv_namespaces`.

**Data migration / seed:** set the seed secret (`wrangler secret put SEED_KEY`) and run `GET /admin/seed?key=<SEED_KEY>` once after deploy to populate KV from Apps Script (`&type=<contentType>` to scope it and stay under the per-invocation subrequest limit). Lazy fallback means the seed is a *latency* optimization, not a correctness requirement — any missing key self-fills on first access. **Rollback** is a `git revert` of the `worker.js` change back to the Apps Script proxy; KV keys are simply ignored, no data lost, `Code.gs` untouched.

Spreadsheet IDs live only in `Code.gs` (server-side). The public exposure is the read-only `/exec` API URL embedded in `worker.js` — same read access as before.
