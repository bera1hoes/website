# hoes.fyi

Maplestory guild content visualizer — CP vs Score scatter plot with a power-law regression fit. Supports Guild Wars, Guild Boss Battle, and Global GBB data pulled live from private Google Sheets.

## Architecture

```
hoes.fyi (Cloudflare Pages)          functions/api.js (Pages Function)      Code.gs (Apps Script)
  Home.html  — landing page     ──►  same-origin proxy at /api          ──►  JSON API over Google Sheets
  Charts.html — chart app             (avoids CORS on Apps Script)            (spreadsheet IDs stay server-side)
  _redirects  — /charts routing
```

The chart page is fully static. It fetches data through the `/api` proxy on every load — no build step, no bundler.

## Local development

Requires a local HTTP server (e.g. VS Code Live Server) — `file://` blocks the sample-data `<script>` loads.

1. Open `Charts.html` via Live Server (`http://localhost:...`).
2. The app detects `localhost` and uses the sample data files in `SampleData/` automatically — no API calls, no credentials needed.
3. To add new sample data, add a key to `GW_LOCAL_DATA` in `SampleData/GWLocalData.js` (or the equivalent for GBB/GlobalGBB).

## Deployment

Two independent targets:

**Apps Script (data API)**
1. Upload only `Code.gs` to Apps Script.
2. Deploy as a Web App: *Execute as: Me* · *Who has access: **Anyone*** (must be unauthenticated public, or the proxy gets a login page).
3. Paste the `/exec` URL into `APPS_SCRIPT_URL` in `functions/api.js` if it ever changes.

**Cloudflare Pages (static front-end)**
1. Push to `main` — Pages auto-deploys on push.
2. Build settings: framework = *None*, build command = *(empty)*, output directory = `/`.
3. The `functions/` folder must be included in the deployment for `/api` to work.

## Smoke test

After deploying, hit these in order:

```
https://hoes.fyi/api?action=getLastUpdated&contentType=Guild+Boss+Battle
```
Should return a raw JSON ISO date. If it returns HTML, the Apps Script access setting is wrong.

```
https://hoes.fyi/charts
```
Should load the chart with Guild Wars data automatically.
