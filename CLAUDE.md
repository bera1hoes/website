# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Visualizes Maplestory guild content player data as a CP vs Score scatter plot with a power-law regression fit. Supports multiple content types (Guild Wars, Guild Boss Battle, Global GBB, Guild Conquest, Guild Training Ground), selectable via a toggle in the controls bar. Players are color-coded by guild or class, with an interactive legend and tooltip panel.

**Hosting model:** the front-end is a **static site** served by a **Cloudflare Worker** (`worker.js`, deployed via `wrangler.jsonc`) whose `assets` binding points at `public/`. Chart data lives in **Workers KV** (binding `CHART_DATA`) and is the **sole source of truth — there is no Google in the loop**. The data is captured locally by the SwissKnife mitmproxy addon (`nexon_analyzer`), which reads guild-content ranking responses out of the game traffic and **`POST`s them to the Worker's `/chart` endpoint** (mirroring the roster `/guild` flow); SwissKnife also writes a per-week CSV backup. The page fetches data over GET from the same-origin `/api`. A simple `(s)hoes` landing page (`public/index.html`) links to the chart ("Charts") and the "Arena" tool.

## Files

All browser-served assets live under **`public/`**; `worker.js` and `wrangler.jsonc` are at the repo root.

- **worker.js** — Cloudflare Worker: static-asset host + KV-backed data API + ingestion + router. **`/api?action=...` reads from KV** (binding `CHART_DATA`): `getSheetNames`/`getData`/`getLastUpdated` return the stored value, or an empty result on a miss (no upstream — KV is authoritative). `getData` serves the stored `{ rows, rosters, perfProfile, guildHistory }` object **as-is** (the client's `rowsOf`/`rostersOf`/`perfOf`/`guildHistOf` read whichever shape arrives). Responses are `cache-control: no-store` (KV *is* the store; no `caches.default` layer), so a re-read (the client's Reload) is always fresh. **`POST /chart`** is the ingestion endpoint: `Authorization: Bearer <CHART_WRITE_KEY>`, body `{ type, date: "MM-DD-YYYY", rows: [...] }` — it normalizes rows (drops missing cp/score), **embeds the guilds' roster snapshot** from `ROSTERS` (pulled fresh on first create, carried over — with any `perfProfile`/`guildHistory` — on update; **skipped for `NO_ROSTER_TYPES` = Guild Conquest**, whose whole-world sheets have so many guilds that the 2-reads-per-guild pull breaks Cloudflare's 1000-KV-ops-per-invocation cap → error 1101; `refreshRosters` refuses those types and Win Prediction says rosters are off), writes `data:<type>:<date>`, merges `guildweeks:<type>`, and upserts the date into `names:<type>` (sorted newest-first) with a fresh `updated` stamp. The actions `refreshRosters` (re-pull the embedded roster) and `buildPerfProfile` run **KV-only**; the latter scans the prior sheets once and embeds **both** the recency-weighted per-player profile (`perfProfile`, PERF_TYPES only) and the per-guild rollup of prior appearances (`guildHistory`, every content type — total Score + participant count per prior sheet, behind the pivot table's history columns). Other routes: `/guild` (POST/GET roster KV, binding `ROSTERS`), `/charts` → `Charts.html`, `/arena` → `Arena.html` (**Basic-Auth gated** when the `ARENA_PASSWORD` secret is set — any username, password checked; the direct `/Arena.html`/`/Arena` asset paths are folded into the same route so the catch-all can't bypass the gate; no secret → open), `/userinfo` + `/userinfo/suggest` → a separate UserInfo Worker (**behind the same `ARENA_PASSWORD` gate** — they attach `USERINFO_READ_KEY`, so an open route would bypass the page's password), everything else → `public/` assets.
  - **`POST /baseline`** stores mapleidle.gg's per-content power-law "baseline" fits: `Authorization: Bearer <CHART_WRITE_KEY>` (same key as `/chart`), body `{ analysis: { fourth|sub: { <mapleidle mode>: { fitA, fitB, snapshotDate } } } }`. It maps their mode keys to our content types via `MAPLEIDLE_CONTENT` (their `worldBoss` has no counterpart and is dropped — reported back as `skipped`; our Global GBB has none on their side) and writes the single KV key `baselines`. Read back with `/api?action=getBaselines` (returns `null` on a miss). The route answers CORS preflights because its only client is cross-origin — see **mapleidle baselines** below.
  - **`POST /playerscores`** stores mapleidle's per-player best scores onto the roster members that Win Prediction already reads: `Authorization: Bearer <CHART_WRITE_KEY>` (same key as `/chart`/`/baseline`), body `{ world?, guilds: { "<guild>": { "<nick>": { job?, level?, modes: { <mapleidle mode>: { score, cp, snapshotDate? } } } } } }`. It reads each guild's `roster:<world>:<guild>` from `ROSTERS`, matches players by lowercased nick, and writes an `mi` block onto the member. Idempotent — a re-post overwrites the same block. Unmatched nicks come back in `stored[].unmatched` (usually a rename or a stale roster) rather than being swallowed. Only the modes in `MI_MODES` (= `MAPLEIDLE_CONTENT` keys) are kept; `worldBoss` is dropped. An optional `gone: { "<guild>": ["<nick>", …] }` stamps roster members missing from mapleidle's member list with `gone` / `gone_weeks` (Pacific "now" via `pacificWeeksNow` — an upper bound on when they left; the first sighting is kept, and a member posted in `guilds` again is cleared). Also CORS-preflighted — see **mapleidle Player Scores** below.
  - **KV key shapes:** `names:<type>` → `{ updated: <ISO>, sheets: [...] }` (`updated` is stamped at write time and rides the `getSheetNames` response as `x-last-updated`); `data:<type>:<sheet>` → `{ rows: [...], rosters: { "<guild>": [...] }, perfProfile?: { "<nick>": factor }, guildHistory?: { "<guild>": [{ sheet, total, members }, …] } }` (legacy bare-array entries are still served — the client tolerates both); `guildweeks:<type>` → `{ "<guild>": ["MM-DD-YYYY", …] }` (all content types — the lookup that lets `buildPerfProfile` skip irrelevant prior sheets); `baselines` → `{ fetchedAt: <ISO>, source, cohorts: { fourth|sub: { "<content type>": { fitA, fitB, snapshotDate } } } }` (one key for every content type and both job cohorts). A roster member in `ROSTERS` is `{ nick, cp, cls, level, joined?, joined_weeks?, gone?, gone_weeks?, mi? }`, where `mi` is `{ fetchedAt, job?, level?, modes: { <mapleidle mode>: { score, cp, snapshotDate? } } }` (written by `/playerscores`). Beside it, `changes:<world>:<guild>` is the guild's join/leave log `[{ nick, action, date, guild, weeks, cp?, cls?, level?, mi? }]`: each `/guild` capture is **merged** into it (`mergeChanges`, kept `CHANGE_LOG_DAYS` = 120 — mapleidle's card only shows 30), and a leave carries the leaver's last roster CP (`carryLeavers`), since the capture that drops them from the roster would otherwise take it with them. `CONTENT_TYPES` in `worker.js` is the ingestion allowlist and must mirror SwissKnife's mode → content-type map in `guild_wars.py`.
- **public/Charts.html** — Chart front-end **markup only** (~210 lines). Loads `/css/*.css` and, at the bottom, the ordered `/js/*.js` files (see Architecture). Served at `/charts`.
- **public/js/** — The chart's JavaScript, split into plain (non-module) `<script src>` files that share one global scope (so the inline `onclick=` handlers keep working). Load order matters; see Architecture.
- **public/css/** — `shared.css` (theme tokens), `charts.css`, `home.css`, `arena.css`. Charts.html links `shared.css` + `charts.css`.
- **public/index.html** — `(s)hoes` landing page. Buttons: Charts → `/charts`, Arena → `/arena`.
- **public/Arena.html** — the Arena tool page (served at `/arena`). Its inline script is a hand port of SwissKnife's `calc_stats.py` (keep in sync): the eight stat cards (Critical Damage sits under Critical Resistance), each with an amber `+ (x)` / `− (x)` for what the player's **conditional** class and artifact skills can add or remove, a red **Debuffs you** row (what their skills do to *your* stats), and a collapsed **Class skills & masteries** breakdown naming every effect. The totals follow the game's own two-layer pipeline, transcribed from the decompiled client (see `calc_stats.py` for the details): a **base layer** — the hero's base stats from `TextAsset/CreatureStatTable.txt` (30% crit damage and 10 defense for every class) plus the equipped weapon, the gear, and each buff, every source truncated to whole raw units, then `× (1000 + R) / 1000` — and a **skill layer** of permanent skill effects applied to that finished base (a skill `DefenceR` multiplies it; a flat skill stat lands after every multiplier). Toughness and DefPen chain instead of summing, ignore their R parts, and cap at 95% / 99.9%. Critical Damage also converts crit rate where an artifact says so (Book of Ancient: "Critical Damage by 42% of Critical Rate", taken at the hero's final crit rate). Artifact chips draw each artifact's in-game icon from `public/icons/Artifact/<code>.png` (the table's `IconPath` `Artifact:<code>`, resolved by `iconUrl`) — copied from SwissKnife's `nexon_overlay/icons/Artifact/` (`tools/extract_icons.py`); copy the new PNG over when a patch adds an artifact (until then its chip shows the name alone). A **Skills** grid below them lays out the equipped skill bar the way SwissKnife's overlay does — the in-game icons three wide, read left to right (a full twelve-slot bar is four rows): `extractSkills` (port of `calc_stats.extract_skills`) lists `ActiveSkillLearnedInfosInSlot` in slot order (empty slots skipped), each tile the skill's icon from `public/icons/SkillIcon/` (the record's `SkillIconPath`, else the client's `SkillIcon:<SkillIndex>` fallback — `skillIcon`; a missing PNG leaves a "?" tile) naming the skill in a tip on hover, tap or keyboard focus, and a skill that stuns in an arena fight with this hero's masteries (`heroStuns`) gets the overlay's red undertone, its tip adding the note ("Stuns 1s (Covering Fire - Stun)"). The skill icons are copied from SwissKnife's `nexon_overlay/icons/SkillIcon/` the same way.
- **public/js/skill-effects.js** — line-by-line port of SwissKnife's `skill_effects.py` (`heroSkillEffects`, `pvpTruth`, `skillName`, and for the skill bar `heroStuns` / `skillIcon`); Arena.html loads it before its inline script. Walks a hero's slotted actives, passives, masteries, guild skills and worn artifacts' equip skills (the `Artifact` buff's `PassiveSkillLevels` — its `_stats` hold only the owned-collection stats) through `TextAsset/SkillEffectTable.json`.
- **public/TextAsset/SkillEffectTable.json** — **generated, don't edit**: the class- and artifact-skill subset of SkillTable (with each record's `SkillIconPath`, for the skill bar) plus projectile landings, state stack caps and skill names (artifact equip skills go by their artifact's name), written by SwissKnife's `python tools/export_arena_skills.py` (which refuses to write if the trimmed table would change any effect). Re-export after SwissKnife refreshes its tables. The rest of `public/TextAsset/` is copied from SwissKnife's bundle; fresh dumps **omit zero-valued fields**, so the JS reads optional numerics with `|| 0`.
- **public/SampleData/GWLocalData.js** — Local debug data for Guild Wars. Defines `GW_LOCAL_DATA` (`{ 'MM_DD_YYYY': '<tsv string>' }`).
- **public/SampleData/GBBLocalData.js** / **GlobalGBBLocalData.js** / **GuildConquestLocalData.js** / **GTTLocalData.js** — same format for Guild Boss Battle (`GBB_LOCAL_DATA`), Global GBB (`GGBB_LOCAL_DATA`), Guild Conquest (`GC_LOCAL_DATA`), and Guild Training Ground (`GTT_LOCAL_DATA`).
- **public/SampleData/** — Raw `.tsv` exports and the local-data JS files.
- **tools/mapleidle-baseline.user.js** — Tampermonkey userscript that scrapes mapleidle's per-content baseline fits and pushes them to `POST /baseline`. Not served by the site; install it into Tampermonkey. See **mapleidle Baselines**.
- **tools/shoes-player-scores.user.js** — Tampermonkey userscript that runs on **our charts page**, works out which absentees Win Prediction has no history for, fetches their best scores off mapleidle (via `GM_xmlhttpRequest`, the one CORS-exempt path), pushes them to `POST /playerscores`, and re-runs the projection. Not served by the site. See **mapleidle Player Scores**.
- **public/js/bridge.js** — `window.shoesChart`, the read-only surface the userscript above reads the chart's state through (see **mapleidle Player Scores** for why it's needed). Served, but nothing in the page itself uses it.

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

## mapleidle Player Scores

Win Prediction projects an absent roster member from the fit at their CP, tuned by
a per-player factor built from **our own** prior sheets. A player who has never
appeared in one gets no factor at all — so the roster slot we know least about is
also the one projected most crudely (raw fit, or class bias at best).

mapleidle has those players. It records each character's **best score per content
mode paired with the CP they held when they set it**, and that pairing is what makes
it usable: a score judged against its own CP runs straight through the same
`score / (A·cp^B)` ratio the other adjust modes produce, with no rescaling. That is
`miFactor` in `prediction.js`, and it slots in **below** real history — only filling
rows that would otherwise be raw.

**Caveat, deliberately visible in the UI:** it's a *best* score, not a typical week,
so it reads optimistic next to a history factor averaged over every week. Rows using
it are labelled `mapleidle` in the absentees table's adjustment column, and the
status line counts them ("N from mapleidle (no history)").

**Fetching** is `tools/shoes-player-scores.user.js`, and it runs on **our** charts
page (`@match https://hoes.fyi/charts*`), not on mapleidle. That's the important
design choice: the page already knows who needs fetching. It has the sheet's roster
snapshot, who actually posted a score, and both per-player history maps — so the
target set is *computed* (absentees, in this sheet's guilds, that prediction would
otherwise project raw) rather than configured. That is usually a handful of players
instead of a whole roster, and on a well-covered sheet it is correctly zero. After
storing, the script calls the page's `refreshRosters()` and `runPrediction()`, so a
fetch closes its own loop.

It reaches the page's state through `public/js/bridge.js` (`window.shoesChart`).
That bridge exists because the chart's state lives in top-level `let`/`const` of
classic scripts, which land in the shared script scope but **never on `window`** —
so a sandboxed userscript sees `undefined` for `sheetRosters` while `refreshRosters`
(a plain `function`) resolves fine. Reaching in with `unsafeWindow.eval` would work
but breaks silently on a rename, so the page exposes a small read-only surface
instead.

**Why it's still a userscript.** mapleidle's API sends no `Access-Control-Allow-Origin`,
so a plain fetch from hoes.fyi is CORS-blocked. The *server* answers fine — verified
by re-running the same request with CORS enforcement off: 200 with the full member
list. It is purely a missing response header, and `GM_xmlhttpRequest` (`@connect
mapleidle.gg`) is exempt from CORS. That exemption is the one capability an ordinary
page cannot have, which is the whole reason this can't just be a button on the site.
Our own `/playerscores` is same-origin from there, so it uses a plain fetch.

Two passes, cheapest first:

1. **`/api/score-analysis/guild?region=&name=`** returns *every* member's per-mode
   best in one request — one call covers a whole roster.
2. anyone pass 1 missed (renamed, left, not scraped yet) falls back to
   **`/api/search?q=`** to resolve their `worldId`, then
   **`/api/score-analysis/character?region=&world=&name=`**. Two requests each, so
   this pass is kept as small as possible. (The character route 404s without a
   `world`, which is why the search hop exists.)

Every mapleidle request is staggered (`DELAY_MS` 3s + up to 2s jitter) and
sequential, and a 429 halts the run rather than letting the per-player pass hammer
the same limiter. A member is skipped when we already hold a block newer than
`STALE_DAYS` (14). Each guild is POSTed as it finishes, so a stopped or failed run
keeps what it already fetched and the next run picks up where it left off.

**Storage reuses the roster.** The `mi` block hangs off the roster member rather than
living in a table of its own, so prediction reads it out of the roster snapshot it
already holds — no second lookup. `carryMi` in `worker.js` preserves it across
SwissKnife roster re-captures (`cleanRoster` rebuilds member objects from the
uploaded fields, so without that merge every capture would silently wipe the lot).
Getting it into a sheet is the existing **Refresh rosters** button, which returns its
promise so the script re-runs the prediction on the *new* snapshot.

**Targets and membership come from the page.** The target list is
`window.shoesChart.absentees` — prediction's own list of who it projects (see **Win
Prediction Membership** below) — so the script never fetches a joiner-after or a
leaver-before. The guild response is also the authoritative *current* member list:
roster members missing from it are posted as `gone` (only when at least half the
roster is still listed, so an empty or wrong response can't mark everyone gone), and
prediction stops projecting them from that week on. The script still never *adds*
members — the response has no join dates — so joiners, and join dates for a roster
built from mapleidle's list, come from a guild-page capture (the SwissKnife roster
userscript or proxy addon).

## Win Prediction Membership

A roster snapshot is today's members; a sheet is a past week. `absenteesFor` /
`membershipAt` (`prediction.js`) decide who was in each guild *that* week, nick-matched
case-insensitively (`nickKey`):

- **From the change log first.** A change *during* the sheet's week → `mid` (struck
  through, pill `new`/`left`, out of every total). Otherwise the **first change after**
  the week decides: a leave → they were in, a join → they weren't. That handles a
  leave-and-rejoin, which a single `joined` date can't.
- **Stamps when the log is silent:** `joined_weeks` (after → out, same week → mid) and
  `gone_weeks` (before → out, same week → mid).
- **Ex-members:** anyone in the log, off the roster, and still in the guild that week is
  projected from the CP carried on their leave (pill `left`); a leave with no CP is only
  counted ("left since, no CP to project").

## Win Prediction Fit Base

Absentee projections run through `predictionFit()` (`prediction.js`): the chart's own
fit (`activeFit`) by default, or the **Experiments custom equation** when "Project from
the custom fit equation" is ticked in the Win Prediction block. That makes the same
equation usable three ways — the custom line on the chart, the "vs Custom" column, and
the projection base — so a what-if curve (a hand-written one, mapleidle's game-wide
baseline, an older week's fit) can drive the guild totals without disturbing the
chart's regression.

The checkbox is inert until a custom equation exists; `applyCustomFit`/`clearCustomFit`
call `onCustomFitChanged` to enable/disable it and re-run the prediction, and clearing
the equation always drops the base back to `activeFit`. `miFactor` divides by the same
fit the projection multiplies back, so a swapped base cancels out of that ratio instead
of doubling into it. Where the base is custom is stated in three places: the Win
Prediction heading (` · custom fit`), the absentees table's `Fit base (custom)` header,
and the status line (`· custom-fit base`).

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

`util` → `colors` → `gw-points` → `regression` → `data` → `io` → `legend` → `panel` → `chart` → `tables` → `experiments` → `estimate` → `baselines` → `deeplink` → `history` → `guild-history` → `search` → `prediction` → `bridge` → `main`

| File | Responsibility |
|---|---|
| `util.js` | `$id`, `setStats`/`clearStats` (R²/exp/eq cards), `applyFitDiff`/`fitDiffColor`/`fitDiffText`, `toGamingNotation`/`parseGamingNotation` |
| `colors.js` | `GUILD_PALETTE`/`GUILD_COLORS`/`CLASS_COLORS`, `assignGuildColors`, `getColor` |
| `gw-points.js` | rank→points TSV literals + the sheet-dated picker: `GW_POINTS_DATA` (pre-09-03-2026), `GW_POINTS_DATA_V2` (09-03-2026 onwards — raised 1st–29th, splices the unchanged 30th+ tail off the old table), `gwPointsDataFor`/`gwPointsMap(sheet)` |
| `regression.js` | `powerRegression`, `computeClassBias`, `computeFitDiffs` |
| `data.js` | `currentData`, `localFiles`, `parseTSV`, `parseGWPoints`, `getLocalData`, embedded-payload readers (`rowsOf`/`rostersOf`/`rosterChangesOf`/`perfOf`/`guildHistOf`) + caches |
| `io.js` | env detection (`API_URL`/`IS_LOCAL`/`IS_REMOTE`), `apiCall`, `loadContentType`, `loadSheet`, reload + sheet/content state, `loadLocalFiles` |
| `legend.js` | `colorMode`, `selectedGroups`, `setColorMode`, `updateColors`, `applyHighlights`, `buildLegend` |
| `panel.js` | `activeEl`, `isPinned`, `showPanel`, `positionPanel`, `closePanel` |
| `chart.js` | chart render handles + fit state, `buildChart` and its helpers, `resetZoom` |
| `tables.js` | player-table state, `buildPivotTable`, `buildPlayerTable`, `renderPlayerTable`, manual score overrides |
| `experiments.js` | custom-fit / CP-filter / regress / class-adjust state + handlers; the custom fit notifies Win Prediction (`onCustomFitChanged`) since it can serve as its projection base |
| `estimate.js` | CP → expected score (runs `activeFit` forward): readout + chart marker (`renderEstimate`, `positionEstimateMarker`) |
| `baselines.js` | mapleidle's game-wide baseline fit for the current content type: weekly-cached read of `getBaselines` + the MAPLEIDLE BASELINE stats card (`loadBaselines`, `renderBaselineCard`, `bustBaselineCache`) |
| `deeplink.js` | URL-hash state (`updateDeepLink`, `restoreDeepLink`, `copyShareLink`) |
| `history.js` | week-over-week **player** deltas vs the previous sheet (`loadHistory`, `fmtPct`) |
| `guild-history.js` | per-**guild** rollup across prior weeks (`loadGuildHistory`, `applyBuiltEntry`, pivot history cells) |
| `search.js` | find-player box (`onPlayerSearch`, highlight/dim + pin on Enter) |
| `prediction.js` | Win Prediction (rosters, projections, adjust modes, `annotateSandbag`, roster-membership dating via `absenteesFor`/`membershipAt` (see **Win Prediction Membership**), `predictionAbsentees` for the bridge, mapleidle fallback via `miFactor`, fit base via `predictionFit`) |
| `bridge.js` | `window.shoesChart` — read-only view of chart state for the player-scores userscript (script-scope `let`s never reach `window`); no in-page consumer |
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
- GW Points join in `joinGwPoints` (chart.js) — points come from `gwPointsMap(currentSheet)`, since the rank→points schedule changed on 09-03-2026; ranks are 0-indexed (rank 0 = 1st place) everywhere that touches it
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

**Secrets** (one-time, `wrangler secret put`): `CHART_WRITE_KEY` (guards `POST /chart` — must match SwissKnife's `chart_write_key`), `ROSTER_WRITE_KEY` (guards `POST /guild`), `USERINFO_READ_KEY` (Arena proxy), `ARENA_PASSWORD` (optional — Basic-Auth password for the `/arena` page and its `/userinfo` data routes; unset = both are open).

**Data ingestion:** chart data is written by SwissKnife's `_upload_to_kv()` (`guild_wars.py`) via `POST /chart`. There is no migration/seed step — KV is fed directly. A missing key just returns an empty result until the next upload fills it. SwissKnife also keeps an optional **direct Google Sheets** upload (`_upload_to_sheets()`, its own OAuth creds) and a **per-week CSV backup** (`backups/<mode>_<MM-DD-YYYY>.csv`) as independent safety copies the site never reads.
