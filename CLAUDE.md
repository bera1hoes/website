# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Visualizes Maplestory guild content player data as a CP vs Score scatter plot with a power-law regression fit. Supports multiple content types (Guild Wars, Guild Boss Battle, Global GBB) from separate spreadsheets, selectable via a toggle in the controls bar. Players are color-coded by guild or class, with an interactive legend and tooltip panel.

**Hosting model:** the front-end is a **static site** (intended for Cloudflare Pages at `hoes.fyi`). Apps Script (`Code.gs`) is kept only as a thin **read-only JSON API** over the private Google Sheets — it no longer serves HTML. The static page fetches data from it over GET (`doGet`). A simple `(s)hoes` landing page (`Home.html`) links to the chart ("Charts") and a future "Arena" tool.

## Files

- **Code.gs** — Apps Script JSON API. `CONTENT_SOURCES` maps content type names to spreadsheet objects (IDs stay server-side, never exposed). `doGet(e)` dispatches on `?action=` (`getSheetNames` / `getData` / `getLastUpdated`) and returns JSON via `ContentService`. The three functions return native arrays/strings; `doGet` stringifies. **GET-only** — JSON POST bodies would trigger a CORS preflight Apps Script can't answer.
- **Charts.html** — The entire chart front-end: CSS, HTML, and JavaScript in one file. Hosted statically (Cloudflare), served at `/charts`. Picks a data source at runtime (see Local Debugging): `apiCall()` (remote fetch), `google.script.run` (legacy embedded), or local sample files.
- **Home.html** — Standalone `(s)hoes` landing page (self-contained theme). Buttons: Charts → `/charts`, Arena (disabled, "soon"). Hosted statically.
- **_redirects** — Cloudflare Pages routing: `/` → `Home.html`, `/charts` → `Charts.html`.
- **functions/api.js** — Cloudflare Pages Function. Same-origin proxy: the browser calls `/api?action=...`, and this fetches the Apps Script `/exec` server-side (no browser CORS). Holds the Apps Script URL. **Apps Script can't set CORS headers**, so direct browser→Apps Script calls fail with "No Access-Control-Allow-Origin" — this proxy is the fix.
- **SampleData/GWLocalData.js** — Local debug data for Guild Wars. Defines `GW_LOCAL_DATA` (`{ 'MM_DD_YYYY': '<tsv string>' }`). **Never upload to Apps Script.**
- **SampleData/GBBLocalData.js** — Local debug data for Guild Boss Battle. Defines `GBB_LOCAL_DATA` in the same format. **Never upload to Apps Script.**
- **SampleData/** — Raw `.tsv` exports and local data JS files.

## Adding a New Content Type

1. Add an entry to `CONTENT_SOURCES` in `Code.gs` with the spreadsheet ID.
2. Add a toggle button in the controls bar HTML in `Charts.html`.
3. Add a case to `getLocalData(type)` in `Charts.html`.
4. Create a `SampleData/<Name>LocalData.js` file defining the data constant.
5. Load the new script file in the local boot sequence.

## TSV Format

Tab-separated with headers: `Rank`, `Nick`, `Score`, `Class`, `Level`, `CP`, `GuildName`, `ScoreShort`, `CP Short`. Rows with empty CP or Score are skipped. CP values may be in scientific notation (e.g. `1.90229E+15`), which `Number()` handles correctly. Both GW and GBB spreadsheets use this same column layout.

## Local Debugging

`Charts.html` chooses one of three data modes at runtime (env-detection block near the top of the script):
- `HAS_GAS` — running embedded in Apps Script (`google.script.run`). Legacy/compat path.
- `IS_LOCAL` — `file://`, `localhost`, or no `API_URL` set → inject the `SampleData/*LocalData.js` files and use them.
- `IS_REMOTE` — deployed static page with `API_URL` set → `apiCall(action, params)` does a GET `fetch` to `API_URL` and parses JSON.

`API_URL` (top of the script in `Charts.html`) is `'/api'` — the same-origin Cloudflare Function proxy (see `functions/api.js`), **not** the Apps Script URL directly (that would fail CORS). The real Apps Script `/exec` URL lives in `functions/api.js`. Response handlers tolerate both strings and parsed objects (`typeof json === 'string' ? JSON.parse(json) : json`).

When local:

1. It dynamically injects `GWLocalData.js` then `GBBLocalData.js` in sequence via `<script>` tags.
2. After both load, `populateLocalSheets(currentContentType)` populates the sheet dropdown from the active content type's data object.
3. Switching the content type toggle calls `loadContentType(type)`, which re-runs `populateLocalSheets` with the new type.
4. To add a new date to GW: add a new key to `GW_LOCAL_DATA` in `GWLocalData.js`. Same pattern for GBB.

**Requires a local HTTP server** — opening `Charts.html` directly as `file://` blocks the `<script src>` load. Use VS Code Live Server or equivalent.

## Architecture (Charts.html)

**State variables** (module-level):
- `currentContentType` — `'Guild Wars'` or `'Guild Boss Battle'`; determines which spreadsheet and which GW-specific features are active
- `colorMode` — `'guild'` or `'class'`
- `currentData` — array of player objects currently rendered
- `localFiles` — `{ contentType: { name: data[] } }` — parsed local data keyed by content type then sheet name
- `activeEl` / `isPinned` — track the clicked (pinned) dot and panel state
- `selectedGroups` — `Set` of guild/class names currently highlighted via legend clicks

**Key functions and their relationships:**
- `loadContentType(type)` — switches `currentContentType`, resets chart/tables, fetches new sheet list (deployed) or calls `populateLocalSheets` (local).
- `populateLocalSheets(type)` — reads `getLocalData(type)`, parses entries into `localFiles[type]`, and populates the sheet dropdown.
- `getLocalData(type)` — returns the appropriate local data object (`GW_LOCAL_DATA` or `GBB_LOCAL_DATA`).
- `buildChart(data)` — master render function. Gates GW Points join on `currentContentType === 'Guild Wars'`. Calls `assignGuildColors`, `powerRegression`, `buildLegend`, then builds the D3 SVG.
- `assignGuildColors(data)` — dynamically assigns colors from `GUILD_PALETTE` to all guilds except `hoes` (always pink). Called at the top of `buildChart`.
- `buildLegend(data)` — renders the legend; attaches click handlers that call `applyHighlights()`.
- `applyHighlights()` — dims non-selected dots and legend items based on `selectedGroups`.
- `updateColors()` — called on color mode toggle; clears `selectedGroups` and resets all dot colors.
- `showPanel(cx, cy, d, pin)` / `positionPanel(cx, cy)` — tooltip panel shown on hover and pinned on click.
- `closePanel()` — resets `isPinned`, hides panel, restores active dot style.
- `buildPlayerTable(data)` / `renderPlayerTable()` — player data table with filter and sort. GW Points column shown/hidden based on `currentContentType`.
- `parseTSV(text)` — parses TSV text into player objects. Both GW and GBB use the same column names.

**GW-specific features** (hidden when `currentContentType !== 'Guild Wars'`):
- GW Points join in `buildChart`
- Guild War Points pivot table (`#pivot-section`)
- GW Points column in the player table (`#player-th-gwpoints`)
- GW Points row in the info panel (`#p-gwpts-row`) — already gated on `d.gwPoints > 0`

**Color system:**
- Guild colors: `hoes` is hardcoded pink; all other guilds are assigned from `GUILD_PALETTE` alphabetically on each `buildChart` call.
- Class colors: hardcoded in `CLASS_COLORS`.
- UI accent color (`#f0a500` amber) is used for stats cards, toggle buttons, and panel rank.

## Deployment

Two independent targets:

1. **Apps Script (data API):** upload **only `Code.gs`**. Deploy as a Web App (**Execute as: me; Who has access: Anyone** — "Anyone" is required, or the proxy's server-side fetch gets a Google login page instead of JSON). Copy the `/exec` URL into `APPS_SCRIPT_URL` in `functions/api.js`. The `SampleData/*LocalData.js` files and the HTML files must **never** be uploaded to Apps Script.
2. **Cloudflare Pages (static front-end + proxy):** publish `Home.html`, `Charts.html`, `_redirects`, and the **`functions/` folder** (the Pages Function must be in the deployment, or `/api` 404s). `Charts.html`'s `API_URL` stays `'/api'`. Do **not** publish the `SampleData/` folder. If you ever create a *new* Apps Script deployment, its `/exec` URL changes — update `functions/api.js`.

Spreadsheet IDs live only in `Code.gs` (server-side). The public exposure is the read-only `/exec` API URL embedded in `Charts.html` — same read access as before.
