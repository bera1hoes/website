# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Visualizes Maplestory guild content player data as a CP vs Score scatter plot with a power-law regression fit. Supports multiple content types (Guild Wars, Guild Boss Battle, Global GBB) from separate spreadsheets, selectable via a toggle in the controls bar. Players are color-coded by guild or class, with an interactive legend and tooltip panel.

**Hosting model:** the front-end is a **static site** served by a **Cloudflare Worker** (`worker.js`, deployed via `wrangler.jsonc`) whose `assets` binding points at `public/`. Apps Script (`Code.gs`) is kept only as a thin **read-only JSON API** over the private Google Sheets — it no longer serves HTML. The page fetches data over GET through a same-origin `/api` proxy in the Worker. A simple `(s)hoes` landing page (`public/index.html`) links to the chart ("Charts") and the "Arena" tool.

## Files

All browser-served assets live under **`public/`**; `worker.js`, `wrangler.jsonc`, and `Code.gs` are at the repo root.

- **Code.gs** — Apps Script JSON API. `CONTENT_SOURCES` maps content type names to spreadsheet objects (IDs stay server-side, never exposed). `doGet(e)` dispatches on `?action=` (`getSheetNames` / `getData` / `getLastUpdated`) and returns JSON via `ContentService`. The three functions return native arrays/strings; `doGet` stringifies. **GET-only** — JSON POST bodies would trigger a CORS preflight Apps Script can't answer.
- **worker.js** — Cloudflare Worker: static-asset host + same-origin proxy/router. Routes `/api?action=...` → Apps Script `/exec` (server-side, so no browser CORS; holds `APPS_SCRIPT_URL`), `/charts` → `Charts.html`, `/arena` → `Arena.html`, `/userinfo` → a separate UserInfo Worker, everything else → `public/` assets. **Apps Script can't set CORS headers**, so direct browser→Apps Script calls fail — the `/api` proxy is the fix.
- **public/Charts.html** — Chart front-end **markup only** (~210 lines). Loads `/css/*.css` and, at the bottom, the ordered `/js/*.js` files (see Architecture). Served at `/charts`.
- **public/js/** — The chart's JavaScript, split into plain (non-module) `<script src>` files that share one global scope (so the inline `onclick=` handlers keep working). Load order matters; see Architecture.
- **public/css/** — `shared.css` (theme tokens), `charts.css`, `home.css`, `arena.css`. Charts.html links `shared.css` + `charts.css`.
- **public/index.html** — `(s)hoes` landing page. Buttons: Charts → `/charts`, Arena → `/arena`.
- **public/Arena.html** — the Arena tool page (served at `/arena`).
- **public/SampleData/GWLocalData.js** — Local debug data for Guild Wars. Defines `GW_LOCAL_DATA` (`{ 'MM_DD_YYYY': '<tsv string>' }`). **Never upload to Apps Script.**
- **public/SampleData/GBBLocalData.js** / **GlobalGBBLocalData.js** — same format for Guild Boss Battle (`GBB_LOCAL_DATA`) and Global GBB (`GGBB_LOCAL_DATA`).
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

`API_URL` (in `io.js`) is `'/api'` — the same-origin Worker proxy (see `worker.js`), **not** the Apps Script URL directly (that would fail CORS). The real Apps Script `/exec` URL lives in `worker.js`. Response handlers tolerate both strings and parsed objects (`typeof json === 'string' ? JSON.parse(json) : json`).

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

1. **Apps Script (data API):** upload **only `Code.gs`**. Deploy as a Web App (**Execute as: me; Who has access: Anyone** — "Anyone" is required, or the proxy's server-side fetch gets a Google login page instead of JSON). Copy the `/exec` URL into `APPS_SCRIPT_URL` in `worker.js`. The `SampleData/*LocalData.js` files and the HTML files must **never** be uploaded to Apps Script.
2. **Cloudflare Worker (static front-end + proxy):** deploy with `wrangler` (`wrangler.jsonc` binds `assets.directory: ./public` and `main: worker.js`). The whole `public/` tree is published as static assets — including `js/`, `css/`, and `SampleData/`. `API_URL` stays `'/api'`. If you ever create a *new* Apps Script deployment, its `/exec` URL changes — update `APPS_SCRIPT_URL` in `worker.js`.

Spreadsheet IDs live only in `Code.gs` (server-side). The public exposure is the read-only `/exec` API URL embedded in `worker.js` — same read access as before.
