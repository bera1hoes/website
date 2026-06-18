# hoes.fyi

Maplestory guild content visualizer — CP vs Score scatter plot with a power-law
regression fit. Supports Guild Wars, Guild Boss Battle, Global GBB, and Guild
Conquest data synced from private Google Sheets into Cloudflare Workers KV, plus
an **Arena** player lookup tool.

## Architecture

```
Cloudflare Worker (worker.js)               Workers KV (CHART_DATA)        Apps Script (Code.gs)
  public/index.html  — (s)hoes landing  ─┐
  public/Charts.html — chart app (/charts)│   /api reads chart data   ◄── fills/refreshes on a KV
  public/Arena.html  — arena tool (/arena)├─►  from Workers KV             miss or Reload, from the
  public/js/, css/, SampleData/  (assets) │                                GET-only JSON API
                                          ┘                                (spreadsheet IDs stay server-side)
```

The front-end is a **fully static site** (`public/`) served by a Cloudflare
Worker whose `assets` binding publishes the whole `public/` tree. The Worker also
routes a few same-origin paths:

- `/api?action=...` → **Workers KV** (binding `CHART_DATA`). Chart data is served
  from KV, not Google. A missing key lazily fills from Apps Script `/exec`
  (server-side, so no browser CORS), and `?bust=1` (Reload) refetches from Apps
  Script and overwrites the key. KV *is* the cache — there's no edge-cache layer
  in front of it, and responses are `no-store`.
- `/charts` → `Charts.html`, `/arena` → `Arena.html`
- `/userinfo` + `/userinfo/suggest` → a separate UserInfo Worker (Arena lookups)
- `/admin/seed?key=<SEED_KEY>` → one-time KV seed / on-demand resync from Apps Script
- everything else → `public/` assets (`/` serves `index.html`)

`Code.gs` is a thin **read-only, GET-only JSON API** over the private Sheets —
it no longer serves any HTML. No build step, no bundler.

The chart JavaScript lives in `public/js/` as plain (non-module) `<script src>`
files that share one global scope, loaded in a fixed order (d3 → … → `main.js`
last). See `CLAUDE.md` for the per-file responsibilities, and `API.md` for the
`/api` action surface.

## Local development

Requires a local HTTP server (e.g. VS Code Live Server or `python -m http.server`
from `public/`) — opening files as `file://` blocks the `js/*.js` and sample-data
`<script>` loads.

1. Serve `public/` and open `Charts.html` over `http://localhost:...`.
2. The app detects `localhost` and uses the sample-data files in
   `public/SampleData/` automatically — no API calls or credentials needed.
3. Pick a content type from the toggle to render it (the page no longer
   auto-loads Guild Wars on open).
4. To add new sample data, add a key to `GW_LOCAL_DATA` in
   `SampleData/GWLocalData.js` (or the equivalent for GBB / Global GBB / Guild
   Conquest). Never upload the `SampleData/*` files to Apps Script.

## Run your own copy

To host this against your own data, you need your own Google Sheet(s), your own
Apps Script deployment, and your own Cloudflare Worker. Nothing in the repo is
tied to `hoes.fyi` except the values below, which you replace.

**1. Set up your Sheets.** Create one spreadsheet per content type you want. In
each, add one tab **per export, named `MM-DD-YYYY`** (e.g. `05-18-2026`) — the
API only lists tabs matching that pattern, newest first. Each tab is
tab-separated with this header row:

```
Rank   Nick   Score   Class   Level   CP   GuildName   ScoreShort   CP Short
```

Rows with an empty `CP` or `Score` are skipped. CP may be in scientific notation
(`1.90229E+15`) — that's handled. The GW Points pivot/column only appear for the
content type literally named `Guild Wars`.

**2. Point `Code.gs` at your sheets.** Edit `CONTENT_SOURCES` at the top of
`Code.gs`, replacing each `SpreadsheetApp.openById('…')` with your own
spreadsheet ID. Add or remove entries to match the content types you want. These
IDs stay server-side and are never exposed to the browser.

**3. Add/remove a content type** (if you want different ones than the defaults) —
follow the checklist in `CLAUDE.md` → *Adding a New Content Type*: an entry in
`CONTENT_SOURCES`, a toggle button in `public/Charts.html`, a case in
`getLocalData()` in `public/js/data.js`, a `SampleData/<Name>LocalData.js` file,
and a line in the local boot sequence in `public/js/main.js`.

**4. Configure the Worker.** Set `APPS_SCRIPT_URL` in `worker.js` to your own
Apps Script `/exec` URL, and rename `name` in `wrangler.jsonc` to your Worker's
name. Create a KV namespace — `wrangler kv namespace create CHART_DATA` (plus
`--preview` for local dev) — and put the returned IDs under `kv_namespaces` in
`wrangler.jsonc`. Then deploy as below. KV self-fills from Apps Script on first
request; to pre-warm it, set the `SEED_KEY` secret (`wrangler secret put SEED_KEY`)
and hit `/admin/seed?key=<SEED_KEY>`.

**Arena is optional.** The `/arena` page depends on a *separate* UserInfo Worker
(the `/userinfo` proxy route, the `USERINFO_WORKER` service binding in
`wrangler.jsonc`, and the `USERINFO_READ_KEY` secret). That Worker is not in this
repo. If you don't have one, the chart still works fully — just drop the
`/userinfo` route and the `services` binding, and don't link to `/arena`.

## Deployment

Two independent targets:

**Apps Script (data API)**
1. Upload only `Code.gs` to Apps Script (never the HTML or `SampleData/*` files).
2. Deploy as a Web App: *Execute as: Me* · *Who has access: **Anyone*** (must be
   unauthenticated public, or the Worker's server-side fetch gets a Google login
   page instead of JSON).
3. Paste the `/exec` URL into `APPS_SCRIPT_URL` in `worker.js` if it ever changes
   (a new deployment gets a new URL).

**Cloudflare Worker (static front-end + KV data API)**
1. Deploy with `wrangler` — `wrangler.jsonc` binds `main: worker.js`,
   `assets.directory: ./public` (publishing the whole `public/` tree), and the
   `CHART_DATA` KV namespace.
2. Seed/pre-warm KV with `/admin/seed?key=<SEED_KEY>` (or rely on lazy first-fill).
3. The `/userinfo` route needs the `USERINFO_READ_KEY` secret and the
   `USERINFO_WORKER` service binding configured for the Arena tool to work.

Spreadsheet IDs live only in `Code.gs` (server-side). The only public exposure is
the read-only `/exec` URL embedded in `worker.js`.

## Smoke test

After deploying, hit these in order:

```
https://hoes.fyi/api?action=getLastUpdated&contentType=Guild+Boss+Battle
```
Should return a raw JSON ISO date. If it returns HTML, the Apps Script access
setting is wrong.

```
https://hoes.fyi/charts
```
Should load the chart UI; pick a content type from the toggle to render data.

```
https://hoes.fyi/arena
```
Should load the Arena lookup tool.
