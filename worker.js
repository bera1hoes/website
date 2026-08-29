// Allowed content types — the write path (POST /chart) rejects anything not in
// this list; the read path keys off whatever ?contentType= asks. Must mirror the
// modes SwissKnife uploads (see guild_wars.py mode→content-type map).
const CONTENT_TYPES = [
  'Guild Wars',
  'Guild Boss Battle',
  'Global GBB',
  'Guild Conquest',
  'Guild Training Ground',
];

// mapleidle.gg's score-analysis content keys → our content types. Their page
// fits one power-law "baseline" per content per job cohort; the userscript
// (tools/mapleidle-baseline.user.js) scrapes the coefficients and POSTs them to
// /baseline. Keys absent here (their `worldBoss`) are dropped; our Global GBB has
// no counterpart on their side, so it simply never gets a baseline.
const MAPLEIDLE_CONTENT = {
  guildWar: 'Guild Wars',
  guildBossBattle: 'Guild Boss Battle',
  conquest: 'Guild Conquest',
  trainingGround: 'Guild Training Ground',
};

// Their two job cohorts. Guild content is Lv 100+, so the chart reads `fourth`.
const MAPLEIDLE_COHORTS = ['fourth', 'sub'];

// Content types that get a week-over-week per-player performance profile (Win
// Prediction's "adjust by history/last week"). Global GBB / Guild Conquest are
// excluded — they have no comparable week-over-week per-player performance.
const PERF_TYPES = ['Guild Wars', 'Guild Boss Battle', 'Guild Training Ground'];

// Recency weight for the multi-week performance profile: the most-recent prior
// week counts 1, the next DECAY, then DECAY², … (an exponential decay).
const PERF_DECAY = 0.6;

// ── Data model ───────────────────────────────────────────────────────────────
// Chart data lives in Workers KV (binding CHART_DATA) and is the sole source of
// truth — there is no Google read path. SwissKnife captures guild-content
// rankings and POSTs them to /chart, which writes these key shapes:
//   names:<type>        -> { updated: <ISO>, sheets: ["MM-DD-YYYY", …] }
//   data:<type>:<sheet> -> { rows: [ {rank, nick, score, …}, … ],
//                            rosters:      { "<guild>": [ {nick,cp,cls,level,joined?,joined_weeks?}, … ] },
//                            rosterChanges:{ "<guild>": [ {nick,action,date,guild,weeks}, … ] }, (optional)
//                            perfProfile:  { "<nick>": <factor> },            (optional)
//                            guildHistory: { "<guild>": [ {sheet,total,members}, … ] } }  (optional)
//   guildweeks:<type>   -> { "<guild>": ["MM-DD-YYYY", …] }   (all content types)
// `rosters` is a frozen snapshot of the sheet's guilds' rosters (from the ROSTERS
// namespace), embedded on /chart ingest and carried over on updates so Win
// Prediction reads it with no extra KV call. Legacy bare-array entries are still
// served (rows with no rosters) until refreshed. `rosterChanges` rides along with
// it — mapleidle's 30-day join/leave log per guild, each entry pre-labeled with
// the week bucket it falls in for every content type, so prediction can tell a
// member who wasn't in the guild yet from one who simply skipped the run.
// `perfProfile` is a
// recency-weighted per-player over/under-performance factor built from the PRIOR
// sheets where the current guilds appeared (buildPerfProfile), embedded here and
// carried over on update. `guildHistory` (same build, every content type) is the
// per-guild rollup of those prior appearances — total Score + participant count
// per prior sheet, newest-first — behind the pivot table's "seen them before"
// columns. `guildweeks` lets the build pick the relevant
// prior sheets without scanning every one. `updated` is stamped at ingest and
// rides getSheetNames' x-last-updated header (feeds the client's "Last updated"
// display). KV is the store, so read responses are no-store.
const namesKey = (type) => `names:${type}`;
const dataKey = (type, sheet) => `data:${type}:${sheet}`;
const guildWeeksKey = (type) => `guildweeks:${type}`;

// Sort MM-DD-YYYY date labels newest-first (YYYY-MM-DD compares lexically).
function sortSheetsDesc(sheets) {
  const toKey = (s) => `${s.slice(6)}-${s.slice(0, 2)}-${s.slice(3, 5)}`;
  return [...sheets].sort((a, b) => toKey(b).localeCompare(toKey(a)));
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function jsonResponse(body, lastUpdated) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  };
  if (lastUpdated) headers['x-last-updated'] = lastUpdated;
  return new Response(body, { status: 200, headers });
}

// Unique guild names present in a sheet's rows.
function guildsOf(rows) {
  return [...new Set((rows || []).map((r) => r && r.guild).filter(Boolean))];
}

// Snapshot of the given guilds' rosters + join/leave logs from the ROSTERS
// namespace (per-guild keys). Skips guilds with no stored/empty roster; a guild
// with a roster but no recorded changes is simply absent from `changes`.
// Returns { rosters: { "<guild>": members[] }, changes: { "<guild>": entries[] } }.
async function pullRosters(env, world, guilds) {
  if (!env.ROSTERS) return { rosters: {}, changes: {} };
  const rosters = {}, changes = {};
  await Promise.all([...new Set(guilds)].map(async (g) => {
    const [r, c] = await Promise.all([
      env.ROSTERS.get(rosterKvKey(world, g), { type: 'json' }),
      env.ROSTERS.get(changesKvKey(world, g), { type: 'json' }),
    ]);
    if (Array.isArray(r) && r.length) rosters[g] = r;
    if (Array.isArray(c) && c.length) changes[g] = c;
  }));
  return { rosters, changes };
}

// Add a sheet to each of its guilds' lists in guildweeks:<type>.
// Idempotent set-merge, so re-runs / out-of-order calls are safe. This is the
// lookup buildPerfProfile uses to skip prior sheets that don't contain the current
// guilds.
async function mergeGuildWeeks(env, type, sheet, rows) {
  const raw = await env.CHART_DATA.get(guildWeeksKey(type));
  const idx = raw ? JSON.parse(raw) : {};
  let changed = false;
  for (const g of guildsOf(rows)) {
    const arr = idx[g] || (idx[g] = []);
    if (!arr.includes(sheet)) { arr.push(sheet); changed = true; }
  }
  if (changed) await env.CHART_DATA.put(guildWeeksKey(type), JSON.stringify(idx));
}

// Raw power-law fit Score ≈ A·CP^B over a sheet's rows (log-log least squares).
// Ported from regression.js (client) so the profile build can run server-side.
// Returns {A,B}; A=1,B=1 when there aren't enough usable points.
function powerRegression(rows) {
  const pts = (rows || []).filter((d) => d && d.cp > 0 && d.score > 0);
  const n = pts.length;
  if (n < 2) return { A: 1, B: 1 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const d of pts) {
    const lx = Math.log10(d.cp), ly = Math.log10(d.score);
    sx += lx; sy += ly; sxx += lx * lx; sxy += lx * ly;
  }
  const denom = n * sxx - sx * sx;
  if (!denom) return { A: 1, B: 1 };
  const B = (n * sxy - sx * sy) / denom;
  const A = Math.pow(10, (sy - B * sx) / n);
  return { A, B };
}

// A sheet's rows from KV (.rows). KV is authoritative — a missing entry just
// yields no rows (buildPerfProfile can call this for prior sheets harmlessly).
async function readRows(env, type, sheet) {
  const stored = await env.CHART_DATA.get(dataKey(type, sheet));
  if (!stored) return [];
  const e = JSON.parse(stored);
  return Array.isArray(e) ? e : (e.rows || []);
}

// Build (and embed) a sheet's history extras from the PRIOR sheets where one of
// its guilds appeared (guildweeks lookup; self-heals to all prior sheets if the
// index is missing/incomplete):
//   • guildHistory (every content type): per-guild rollup of prior appearances —
//     total Score + participant count per prior sheet, newest-first. Opponents
//     rotate weekly, so this is the "have we seen this guild before?" lookup
//     behind the pivot table's history columns.
//   • perfProfile (PERF_TYPES only): fit each prior sheet and record each player's
//     score/fit ratio, weighted by recency → { nick: factor }.
// Writes both into the entry and returns it. No-op when the sheet has no stored
// entry yet.
async function buildPerfProfile(env, type, sheet) {
  // Current entry — need its rows/guilds and must preserve rows+rosters on write-back.
  const curRaw = await env.CHART_DATA.get(dataKey(type, sheet));
  if (!curRaw) return { rows: [], rosters: {}, perfProfile: {}, guildHistory: {} };
  const e = JSON.parse(curRaw);
  const cur = Array.isArray(e) ? { rows: e, rosters: {} } : e;
  const wantPerf = PERF_TYPES.includes(type);  // skipped types: rollup only, no profile

  const curGuilds = new Set(guildsOf(cur.rows));

  // Sheet order (newest-first) → priors are the sheets after this one (older dates).
  let names = [];
  const nraw = await env.CHART_DATA.get(namesKey(type));
  if (nraw) names = JSON.parse(nraw).sheets || [];
  const ci = names.indexOf(sheet);
  let priors = ci >= 0 ? names.slice(ci + 1) : [];

  // Guild→weeks lookup. Skip a prior only if the index KNOWS that sheet and none of
  // the current guilds appeared in it; sheets the index hasn't seen yet are read (and
  // then recorded below), so the index self-heals and later builds prune properly.
  const gw = (await env.CHART_DATA.get(guildWeeksKey(type), { type: 'json' })) || {};
  const known = new Set();
  Object.values(gw).forEach((list) => (list || []).forEach((s) => known.add(s)));
  const relevant = new Set();
  for (const g of curGuilds) (gw[g] || []).forEach((s) => relevant.add(s));
  priors = priors.filter((s) => relevant.has(s) || !known.has(s));

  // Record a sheet's guilds back into the in-memory lookup (one write at the end).
  let gwChanged = false;
  const recordGuilds = (sheetName, rows) => {
    for (const g of guildsOf(rows)) {
      const arr = gw[g] || (gw[g] = []);
      if (!arr.includes(sheetName)) { arr.push(sheetName); gwChanged = true; }
    }
  };
  recordGuilds(sheet, cur.rows);

  // Recency-weighted accumulation: newest prior weight 1, then PERF_DECAY^i.
  const sum = {}, wsum = {};
  const guildHistory = {};
  for (let i = 0; i < priors.length; i++) {
    const rows = await readRows(env, type, priors[i]);
    recordGuilds(priors[i], rows);

    // Guild rollup: total Score + participant count per current guild, one entry
    // per prior sheet the guild appeared in (loop order keeps them newest-first).
    const perGuild = {};
    for (const r of rows) {
      if (!r || !curGuilds.has(r.guild) || !(r.score > 0)) continue;
      const a = perGuild[r.guild] || (perGuild[r.guild] = { total: 0, members: 0 });
      a.total += r.score;
      a.members += 1;
    }
    for (const g of Object.keys(perGuild)) {
      (guildHistory[g] || (guildHistory[g] = [])).push({ sheet: priors[i], ...perGuild[g] });
    }

    if (!wantPerf) continue;
    const w = Math.pow(PERF_DECAY, i);
    const { A, B } = powerRegression(rows);
    if (!(A > 0) || !isFinite(B)) continue;
    for (const r of rows) {
      if (!r || !curGuilds.has(r.guild) || !(r.cp > 0) || !(r.score > 0)) continue;
      const pred = A * Math.pow(r.cp, B);
      if (!(pred > 0)) continue;
      sum[r.nick]  = (sum[r.nick]  || 0) + w * (r.score / pred);
      wsum[r.nick] = (wsum[r.nick] || 0) + w;
    }
  }
  if (gwChanged) await env.CHART_DATA.put(guildWeeksKey(type), JSON.stringify(gw));

  const value = { rows: cur.rows, rosters: cur.rosters || {}, guildHistory };
  if (cur.rosterChanges) value.rosterChanges = cur.rosterChanges;
  if (wantPerf) {
    const perfProfile = {};
    for (const nick of Object.keys(sum)) {
      if (wsum[nick] > 0) perfProfile[nick] = sum[nick] / wsum[nick];
    }
    value.perfProfile = perfProfile;
  }
  await env.CHART_DATA.put(dataKey(type, sheet), JSON.stringify(value));
  return value;
}

// Serve /api from KV — the sole source of truth (no upstream). A missing key
// returns an empty result rather than an error, so a not-yet-uploaded content
// type / sheet degrades gracefully. getData serves the stored
// { rows, rosters, perfProfile } object as-is (the client's rowsOf/rostersOf/perfOf
// read whichever shape arrives). KV is no-store, so a re-read (the client's Reload)
// is always fresh; ?bust= is accepted but has no special effect.
async function handleApi(url, env) {
  const params = url.searchParams;
  const action = params.get('action');
  const type = params.get('contentType') || '';

  if (action === 'getSheetNames') {
    const stored = await env.CHART_DATA.get(namesKey(type));
    if (!stored) return jsonResponse(JSON.stringify([]));
    const rec = JSON.parse(stored);
    return jsonResponse(JSON.stringify(rec.sheets || []), rec.updated);
  }

  if (action === 'getData') {
    const sheet = params.get('sheet') || '';
    const stored = await env.CHART_DATA.get(dataKey(type, sheet));
    return jsonResponse(stored || '[]'); // { rows, rosters, perfProfile } (or legacy bare array)
  }

  // Re-pull the roster snapshot for a sheet from the ROSTERS namespace into its
  // data:<type>:<sheet> entry (the chart's "Refresh rosters" button). The data
  // rows are left as-is; only `rosters` is refreshed.
  if (action === 'refreshRosters') {
    const sheet = params.get('sheet') || '';
    const stored = await env.CHART_DATA.get(dataKey(type, sheet));
    if (!stored) return jsonError(404, 'No data for that sheet yet — load it first');
    const entry = JSON.parse(stored);
    const rows = Array.isArray(entry) ? entry : (entry.rows || []);
    const { rosters, changes } = await pullRosters(env, 'bera', guildsOf(rows));
    const value = { rows, rosters };
    if (Object.keys(changes).length) value.rosterChanges = changes;
    // Preserve any embedded perfProfile/guildHistory — refreshing rosters must not drop them.
    if (!Array.isArray(entry) && entry.perfProfile) value.perfProfile = entry.perfProfile;
    if (!Array.isArray(entry) && entry.guildHistory) value.guildHistory = entry.guildHistory;
    await env.CHART_DATA.put(dataKey(type, sheet), JSON.stringify(value));
    return jsonResponse(JSON.stringify(value));
  }

  // Build + embed the sheet's history extras: the per-guild rollup of prior
  // appearances (guildHistory — pivot table's history columns, every content type)
  // and the recency-weighted per-player performance profile (perfProfile — Win
  // Prediction's "adjust by history", PERF_TYPES only). Reads only the relevant
  // prior sheets via the guildweeks lookup; writes the entry back. The client
  // auto-triggers this once when a sheet has no embedded rollup/profile yet.
  if (action === 'buildPerfProfile') {
    const sheet = params.get('sheet') || '';
    const res = await buildPerfProfile(env, type, sheet);
    if (res && res.error) return res.error;
    return jsonResponse(JSON.stringify(res));
  }

  // mapleidle's per-content baseline fits (one small KV key, all content types
  // and both cohorts at once — the client picks the one it needs and caches it
  // for a week). A miss returns null rather than an error: no baseline has been
  // pushed yet, and the card just stays hidden.
  if (action === 'getBaselines') {
    const stored = await env.CHART_DATA.get(BASELINE_KEY);
    return jsonResponse(stored || 'null');
  }

  // Last-updated timestamp, served from the names record.
  if (action === 'getLastUpdated') {
    const stored = await env.CHART_DATA.get(namesKey(type));
    const updated = stored ? (JSON.parse(stored).updated || null) : null;
    return jsonResponse(JSON.stringify(updated), updated);
  }

  return jsonError(400, 'Unknown or missing action: ' + action);
}

// ── Chart-data ingestion (/chart) ────────────────────────────────────────────
// SwissKnife captures guild-content rankings locally and POSTs them here (same
// pattern as /guild rosters). Body: { type, date: "MM-DD-YYYY", rows: [...] }.
// Stores data:<type>:<date> as { rows, rosters, perfProfile? } — embedding the
// guilds' roster snapshot from ROSTERS on first create and carrying it (and any
// perfProfile) over on update — then upserts the date into names:<type> (sorted
// newest-first, fresh `updated`) and merges guildweeks. Guarded by CHART_WRITE_KEY.

const DATE_RE = /^\d{2}-\d{2}-\d{4}$/;

// Normalize an uploaded row to the canonical getData row shape, dropping rows with
// a missing/zero cp or score (same rule the old Apps Script getData applied).
function cleanChartRows(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    if (!r) continue;
    const cp = Number(r.cp);
    const score = Number(r.score);
    if (!cp || !score) continue;
    out.push({
      rank:       Number(r.rank) || 0,
      nick:       String(r.nick || ''),
      score,
      cls:        String(r.cls || ''),
      level:      Number(r.level) || 0,
      cp,
      guild:      String(r.guild || ''),
      scoreShort: String(r.scoreShort || ''),
      cpShort:    String(r.cpShort || ''),
    });
  }
  return out;
}

async function handleChartUpload(request, env) {
  if (!env.CHART_DATA) return jsonError(503, 'Chart store (KV) not configured');
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!env.CHART_WRITE_KEY || token !== env.CHART_WRITE_KEY) return jsonError(401, 'Unauthorized');

  let body;
  try { body = await request.json(); } catch { return jsonError(400, 'Invalid JSON body'); }

  const type = String(body.type || '');
  const date = String(body.date || '');
  if (!CONTENT_TYPES.includes(type)) return jsonError(400, 'Unknown content type: ' + type);
  if (!DATE_RE.test(date)) return jsonError(400, 'Invalid date (expected MM-DD-YYYY): ' + date);

  const rows = cleanChartRows(body.rows);
  if (!rows.length) return jsonError(400, 'No valid rows (each needs nonzero cp and score)');

  // Embed rosters: carry over from an existing entry (and keep its perfProfile +
  // guildHistory — both summarize PRIOR sheets, which an update to this one can't
  // change), else pull fresh from ROSTERS for the rows' guilds — same as syncData did.
  const prevRaw = await env.CHART_DATA.get(dataKey(type, date));
  let rosters, rosterChanges, perfProfile, guildHistory;
  if (prevRaw) {
    const prev = JSON.parse(prevRaw);
    const obj = (prev && !Array.isArray(prev)) ? prev : {};
    rosters = obj.rosters || {};
    rosterChanges = obj.rosterChanges;
    perfProfile = obj.perfProfile;
    guildHistory = obj.guildHistory;
  } else {
    const pulled = await pullRosters(env, 'bera', guildsOf(rows));
    rosters = pulled.rosters;
    if (Object.keys(pulled.changes).length) rosterChanges = pulled.changes;
  }

  const value = { rows, rosters };
  if (rosterChanges) value.rosterChanges = rosterChanges;
  if (perfProfile) value.perfProfile = perfProfile;
  if (guildHistory) value.guildHistory = guildHistory;
  await env.CHART_DATA.put(dataKey(type, date), JSON.stringify(value));
  await mergeGuildWeeks(env, type, date, rows);

  // Upsert the date into names:<type> (newest-first) and stamp `updated`.
  const namesRaw = await env.CHART_DATA.get(namesKey(type));
  const rec = namesRaw ? JSON.parse(namesRaw) : { updated: null, sheets: [] };
  const sheets = new Set(rec.sheets || []);
  sheets.add(date);
  rec.sheets = sortSheetsDesc([...sheets]);
  rec.updated = new Date().toISOString();
  await env.CHART_DATA.put(namesKey(type), JSON.stringify(rec));

  return new Response(JSON.stringify({
    ok: true, type, date, count: rows.length, rosters: Object.keys(rosters).length,
  }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// ── mapleidle baselines (/baseline) ──────────────────────────────────────────
// mapleidle.gg/tools/score-analysis fits a power-law "baseline" (Score = e^fitA
// · CP^fitB) per content type per job cohort. That page can't be read by anything
// but a real browser sitting on it — a Worker fetch is 429'd (datacenter IP), a
// scripted fetch is 429'd even from a residential IP (automation fingerprint),
// and a visitor's cross-origin fetch is CORS-blocked (the route sends no
// Access-Control-Allow-Origin; `mode:'no-cors'` yields an unreadable opaque
// response). So the capture runs *inside* the page as a Tampermonkey userscript
// (tools/mapleidle-baseline.user.js), which reads the coefficients out of Next's
// flight payload and POSTs them here. This Worker only stores + serves; like
// /guild, it never talks to mapleidle itself.

const BASELINE_KEY = 'baselines';

// The userscripts are cross-origin (mapleidle.gg → here). GM_xmlhttpRequest is
// exempt from CORS, but a plain fetch() fallback isn't, so these routes answer
// preflights and echo the CORS headers. Safe here: auth is a bearer token, not
// a cookie, so a browser-driven request can't borrow anyone's credentials.
const USERSCRIPT_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
};

// Pull { fitA, fitB, snapshotDate } out of one uploaded cohort block, mapping
// mapleidle's content keys to ours and dropping anything malformed or unmapped.
function cleanBaselineCohort(block) {
  const out = {};
  if (!block || typeof block !== 'object') return out;
  for (const [miKey, ours] of Object.entries(MAPLEIDLE_CONTENT)) {
    const e = block[miKey];
    if (!e || typeof e !== 'object') continue;
    const fitA = Number(e.fitA);
    const fitB = Number(e.fitB);
    if (!isFinite(fitA) || !isFinite(fitB)) continue;
    const entry = { fitA, fitB };
    if (typeof e.snapshotDate === 'string' && e.snapshotDate) entry.snapshotDate = e.snapshotDate;
    out[ours] = entry;
  }
  return out;
}

async function handleBaselineUpload(request, env) {
  if (!env.CHART_DATA) return jsonError(503, 'Chart store (KV) not configured');
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!env.CHART_WRITE_KEY || token !== env.CHART_WRITE_KEY) return jsonError(401, 'Unauthorized');

  let body;
  try { body = await request.json(); } catch { return jsonError(400, 'Invalid JSON body'); }

  const analysis = body && body.analysis;
  if (!analysis || typeof analysis !== 'object') return jsonError(400, 'Missing `analysis` object');

  const cohorts = {};
  let total = 0;
  for (const c of MAPLEIDLE_COHORTS) {
    const cleaned = cleanBaselineCohort(analysis[c]);
    const n = Object.keys(cleaned).length;
    if (n) { cohorts[c] = cleaned; total += n; }
  }
  if (!total) return jsonError(400, 'No usable fits (each needs numeric fitA and fitB)');

  const value = { fetchedAt: new Date().toISOString(), source: 'mapleidle.gg/tools/score-analysis', cohorts };
  await env.CHART_DATA.put(BASELINE_KEY, JSON.stringify(value));

  return new Response(JSON.stringify({
    ok: true,
    fetchedAt: value.fetchedAt,
    fits: total,
    // Surfaced so a mapleidle rename shows up as "skipped" instead of silently
    // shrinking the set the next time someone pushes.
    skipped: Object.keys(analysis.fourth || {}).filter(k => !MAPLEIDLE_CONTENT[k]),
  }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...USERSCRIPT_CORS },
  });
}

// ── mapleidle player scores (/playerscores) ──────────────────────────────────
// Win Prediction projects an absent member from the fit at their CP, tuned by a
// per-player factor built from OUR prior sheets. A player who has never appeared
// in one gets no factor at all — the projection falls back to raw/class, which is
// exactly the roster slot we know least about.
//
// mapleidle already has those players: it records each character's best score per
// content mode paired with the CP they set it at. That pairing is the whole point
// — a score judged against the CP it was actually achieved at is comparable to
// our fit directly, so it drops into the same score/(A·cp^B) ratio the other
// adjust modes use (see miFactor in prediction.js).
//
// tools/mapleidle-player-scores.user.js does the fetching (same reason as the
// baseline script: only a real browser on the site can read those routes) and
// POSTs here. We store the block on the ROSTER MEMBER rather than in a table of
// its own, so prediction reads it from the roster snapshot it already holds —
// no second lookup. carryMi keeps it alive across roster re-captures.

// Their per-mode keys we keep. worldBoss is dropped: we have no such content, and
// every stored byte rides along in each embedded roster snapshot.
const MI_MODES = Object.keys(MAPLEIDLE_CONTENT);

// Normalize one uploaded player block to { fetchedAt, job?, level?, modes: {…} }.
// Returns null when no mode survived — a player with nothing usable shouldn't get
// an `mi` key at all, so the fetcher keeps seeing them as "not yet fetched".
function cleanMiEntry(entry, fetchedAt) {
  if (!entry || typeof entry !== 'object') return null;
  const modes = {};
  let any = false;
  for (const key of MI_MODES) {
    const m = entry.modes && entry.modes[key];
    if (!m || typeof m !== 'object') continue;
    const score = Number(m.score);
    const cp = Number(m.cp);
    if (!(score > 0) || !(cp > 0)) continue;
    const rec = { score, cp };
    if (typeof m.snapshotDate === 'string' && ISO_DATE_RE.test(m.snapshotDate)) rec.snapshotDate = m.snapshotDate;
    modes[key] = rec;
    any = true;
  }
  if (!any) return null;

  const out = { fetchedAt, modes };
  const job = String(entry.job || '').trim();
  const level = Number(entry.level) || 0;
  if (job) out.job = job;
  if (level > 0) out.level = level;
  return out;
}

// POST /playerscores  (Authorization: Bearer <CHART_WRITE_KEY>)
// Body: { world?, guilds: { "<guild>": { "<nick>": { job?, level?, modes: {…} } } } }
// Merges each player's block onto the matching roster member. Idempotent: a
// re-post of the same players just overwrites their block, so the fetcher can be
// re-run or resumed without creating duplicates.
async function handlePlayerScoresUpload(request, env) {
  if (!env.ROSTERS) return jsonError(503, 'Roster store (KV) not configured');
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!env.CHART_WRITE_KEY || token !== env.CHART_WRITE_KEY) return jsonError(401, 'Unauthorized');

  let body;
  try { body = await request.json(); } catch { return jsonError(400, 'Invalid JSON body'); }

  const guilds = body && body.guilds;
  if (!guilds || typeof guilds !== 'object') return jsonError(400, 'Missing `guilds` object');

  const world = String((body && body.world) || 'bera').toLowerCase();
  const fetchedAt = new Date().toISOString();
  const stored = [];

  for (const [guild, players] of Object.entries(guilds)) {
    const g = String(guild || '').trim();
    if (!g || !players || typeof players !== 'object') continue;

    const roster = await env.ROSTERS.get(rosterKvKey(world, g), { type: 'json' });
    if (!Array.isArray(roster) || !roster.length) {
      stored.push({ guild: g, error: 'no roster captured yet' });
      continue;
    }

    const idx = byNick(roster);
    let matched = 0;
    const unmatched = [];
    for (const [nick, entry] of Object.entries(players)) {
      const member = idx.get(String(nick).toLowerCase());
      if (!member) { unmatched.push(nick); continue; }
      const mi = cleanMiEntry(entry, fetchedAt);
      if (!mi) continue;
      member.mi = mi;
      matched++;
    }

    if (matched) await env.ROSTERS.put(rosterKvKey(world, g), JSON.stringify(roster));
    const rec = { guild: g, matched, members: roster.length };
    // Surfaced rather than swallowed: a nick that never matches is usually a
    // rename or a guild the roster is stale for, and it would otherwise look
    // like the fetch simply did nothing.
    if (unmatched.length) rec.unmatched = unmatched;
    stored.push(rec);
  }

  return new Response(JSON.stringify({ ok: true, fetchedAt, stored }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...USERSCRIPT_CORS },
  });
}

// ── Guild rosters (/guild) ───────────────────────────────────────────────────
// mapleidle.gg serves guild member lists only to a challenge-cleared real browser
// (Vercel blocks datacenter IPs + scripted fetches; CORS blocks visitor fetches),
// so rosters are captured locally by the SwissKnife mitmproxy addon and POSTed
// here into KV (binding ROSTERS). The chart's Win Prediction reads them back. This
// Worker only stores + serves; it never talks to mapleidle.

// The upload modes SwissKnife labels each change's week bucket with (guild_wars.py
// _MODE_SCHEDULE), keyed by our content-type names. `weeks`/`joined_weeks` carry one
// label per mode, so a roster serves every content type from one stored copy.
const CONTENT_MODE = {
  'Guild Wars': 'GW',
  'Guild Boss Battle': 'GBB',
  'Global GBB': 'GGBB',
  'Guild Conquest': 'GC',
  'Guild Training Ground': 'GTG',
};

const WEEK_RE = /^\d{2}-\d{2}-\d{4}$/;

// KV key for a guild roster. World + guild are lowercased so the chart's
// exact-case names and the captured-from-URL names map to one entry.
function rosterKvKey(world, name) {
  return 'roster:' + String(world).toLowerCase() + ':' + String(name).toLowerCase();
}

// Its join/leave log, kept in a sibling key rather than inside the roster value so
// the stored roster stays a plain member array — everything that reads it (GET
// /guild, the embedded snapshots, the chart client) keeps working untouched.
function changesKvKey(world, name) {
  return 'changes:' + String(world).toLowerCase() + ':' + String(name).toLowerCase();
}

// A { GW: "MM-DD-YYYY", … } week-bucket map, keeping only the modes we know and
// only well-formed labels. Returns null when there's nothing usable, so callers
// can leave the field off entirely.
function cleanWeeks(weeks) {
  if (!weeks || typeof weeks !== 'object') return null;
  const out = {};
  let any = false;
  for (const mode of Object.values(CONTENT_MODE)) {
    const v = weeks[mode];
    if (typeof v === 'string' && WEEK_RE.test(v)) { out[mode] = v; any = true; }
  }
  return any ? out : null;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Normalize mapleidle's join/leave log to [{nick, action, date, guild, weeks}].
// Entries missing a nick, a valid ISO date, or a usable week map are dropped —
// a change we can't place in a week is no use to prediction. Newest first.
function cleanChanges(changes) {
  if (!Array.isArray(changes)) return [];
  return changes
    .map(c => {
      const weeks = cleanWeeks(c && c.weeks);
      const date = String((c && c.date) || '');
      if (!weeks || !ISO_DATE_RE.test(date)) return null;
      return {
        nick:   String((c && c.nick) || '').trim(),
        action: c && c.action === 'join' ? 'join' : 'leave',
        date,
        guild:  String((c && c.guild) || ''),
        weeks,
      };
    })
    .filter(c => c && c.nick)
    .sort((a, b) => b.date.localeCompare(a.date));
}

// Normalize an uploaded member list to [{nick, cp, cls, level}] (cp numeric > 0),
// plus the optional `joined` / `joined_weeks` pair when the uploader saw the
// member's join in mapleidle's 30-day change log.
function cleanRoster(members) {
  if (!Array.isArray(members)) return [];
  return members
    .map(m => {
      const out = {
        nick:  String((m && m.nick) || '').trim(),
        cp:    Number(m && m.cp) || 0,
        cls:   String((m && m.cls) || ''),
        level: Number(m && m.level) || 0,
      };
      const weeks = cleanWeeks(m && m.joined_weeks);
      const joined = String((m && m.joined) || '');
      if (weeks && ISO_DATE_RE.test(joined)) { out.joined = joined; out.joined_weeks = weeks; }
      return out;
    })
    .filter(m => m.nick && m.cp > 0);
}

// Index a stored roster by lowercased nick. Used to carry per-member data across
// a re-upload and to match uploaded score entries onto members.
function byNick(roster) {
  const idx = new Map();
  if (Array.isArray(roster)) {
    for (const m of roster) {
      if (m && m.nick) idx.set(String(m.nick).toLowerCase(), m);
    }
  }
  return idx;
}

// Carry each member's `mi` block (see /playerscores) across a roster re-upload.
// cleanRoster builds fresh objects from the uploaded fields, so without this a
// SwissKnife roster capture would silently wipe every score we've fetched.
function carryMi(roster, prevRoster) {
  const prev = byNick(prevRoster);
  if (!prev.size) return roster;
  for (const m of roster) {
    const was = prev.get(m.nick.toLowerCase());
    if (was && was.mi) m.mi = was.mi;
  }
  return roster;
}

// POST /guild  (Authorization: Bearer <ROSTER_WRITE_KEY>) — SwissKnife uploads
// captured rosters here. Body: { world, guild, members:[…], changes:[…] } or a
// batch { world, rosters: { "<guild>": [members] }, changes: { "<guild>": [entries] } }.
// Stores each guild's roster in KV, and its join/leave log beside it. An upload
// that carries no `changes` for a guild leaves that guild's stored log untouched
// (an older uploader shouldn't wipe data a newer one wrote).
async function handleRosterUpload(request, env) {
  if (!env.ROSTERS) return jsonError(503, 'Roster store (KV) not configured');
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!env.ROSTER_WRITE_KEY || token !== env.ROSTER_WRITE_KEY) return jsonError(401, 'Unauthorized');

  let body;
  try { body = await request.json(); } catch { return jsonError(400, 'Invalid JSON body'); }

  const world = String(body.world || 'bera').toLowerCase();
  const stored = [];
  const put = async (guild, members, changes) => {
    const g = String(guild || '').trim();
    if (!g) return;
    // Read-then-merge so fetched mapleidle scores survive the capture that
    // overwrites the roster (see carryMi).
    const prev = await env.ROSTERS.get(rosterKvKey(world, g), { type: 'json' });
    const roster = carryMi(cleanRoster(members), prev);
    await env.ROSTERS.put(rosterKvKey(world, g), JSON.stringify(roster));
    const entry = { guild: g, count: roster.length };
    if (changes !== undefined) {
      const log = cleanChanges(changes);
      await env.ROSTERS.put(changesKvKey(world, g), JSON.stringify(log));
      entry.changes = log.length;
    }
    stored.push(entry);
  };

  if (body.rosters && typeof body.rosters === 'object') {
    // Batch: `changes` is the same guild-keyed map as `rosters`.
    const byGuild = (body.changes && typeof body.changes === 'object' && !Array.isArray(body.changes))
      ? body.changes : null;
    for (const [g, members] of Object.entries(body.rosters)) {
      await put(g, members, byGuild ? (byGuild[g] || []) : undefined);
    }
  } else {
    await put(body.guild, body.members, body.changes);
  }

  return new Response(JSON.stringify({ ok: true, stored }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// GET /guild?world=bera&names=hoes,rivals,…  → { "<guild>": [{nick,cp,cls,level}] | {error} }
// Reads each guild's roster from KV (stored by the SwissKnife uploader). A guild
// with no stored roster comes back as { error } so the client can flag it.
async function handleGuild(request, url, env, ctx) {
  if (request.method === 'POST') return handleRosterUpload(request, env);
  if (request.method !== 'GET') return jsonError(405, 'Method not allowed');
  if (!env.ROSTERS) return jsonError(503, 'Roster store (KV) not configured');

  const world = (url.searchParams.get('world') || 'bera').toLowerCase();
  // Accept ?names=a,b,c (batch) or ?name=a (single).
  const rawNames = url.searchParams.get('names') || url.searchParams.get('name') || '';
  const names = [...new Set(rawNames.split(',').map(s => s.trim()).filter(Boolean))];
  if (!names.length) return jsonError(400, 'Missing guild name(s)');

  const result = {};
  await Promise.all(names.map(async name => {
    const roster = await env.ROSTERS.get(rosterKvKey(world, name), { type: 'json' });
    result[name] = Array.isArray(roster) ? roster : { error: 'no roster captured yet — sync it in SwissKnife' };
  }));

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' },
  });
}

// ── Arena password gate ──────────────────────────────────────────────────────
// The /arena page requires HTTP Basic Auth when the ARENA_PASSWORD secret is set
// (`wrangler secret put ARENA_PASSWORD`). Only the password half of the
// credentials is checked — any username works. Without the secret the page stays
// open (forks / wrangler dev without secrets keep working). Returns the 401
// challenge Response to send, or null when the request is allowed through.
function arenaAuthDenied(request, env) {
  if (!env.ARENA_PASSWORD) return null;
  const auth = request.headers.get('authorization') || '';
  if (auth.startsWith('Basic ')) {
    try {
      const decoded = atob(auth.slice(6)); // "user:pass"
      const pass = decoded.slice(decoded.indexOf(':') + 1);
      if (pass === env.ARENA_PASSWORD) return null;
    } catch { /* malformed base64 → fall through to the challenge */ }
  }
  return new Response('Arena requires a password.', {
    status: 401,
    headers: { 'www-authenticate': 'Basic realm="Arena", charset="UTF-8"' },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api') {
      return handleApi(url, env);
    }

    if (url.pathname === '/chart') {
      if (request.method === 'POST') return handleChartUpload(request, env);
      return jsonError(405, 'Method not allowed');
    }

    if (url.pathname === '/baseline') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: USERSCRIPT_CORS });
      if (request.method === 'POST') return handleBaselineUpload(request, env);
      return jsonError(405, 'Method not allowed');
    }

    if (url.pathname === '/playerscores') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: USERSCRIPT_CORS });
      if (request.method === 'POST') return handlePlayerScoresUpload(request, env);
      return jsonError(405, 'Method not allowed');
    }

    if (url.pathname === '/guild') {
      return handleGuild(request, url, env, ctx);
    }

    // /charts -> Charts.html
    if (url.pathname === '/charts') {
      return env.ASSETS.fetch(new Request(new URL('/Charts.html', url), request));
    }

    // Proxy /userinfo and /userinfo/suggest to the separate UserInfo Worker
    // (READ_KEY stored as Wrangler secret; forward the pathname so both routes work).
    if (url.pathname === '/userinfo' || url.pathname === '/userinfo/suggest') {
      // Arena is owner-only. A fork omits the USERINFO_WORKER service binding, so
      // the route simply doesn't exist there (404) rather than throwing when the
      // binding is undefined. No effect on the owner's deploy (binding present).
      if (!env.USERINFO_WORKER) return jsonError(404, 'Not found');
      if (!env.USERINFO_READ_KEY) {
        return new Response(JSON.stringify({ error: 'USERINFO_READ_KEY not configured' }), {
          status: 500,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      try {
        const upstream = await env.USERINFO_WORKER.fetch(
          new Request('https://userinfo-worker.bera1hoes.workers.dev' + url.pathname + url.search, {
            headers: { Authorization: `Bearer ${env.USERINFO_READ_KEY}` },
            redirect: 'follow',
          })
        );
        const body = await upstream.text();
        return new Response(body, {
          status: upstream.status,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err.message || err) }), {
          status: 502,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
    }

    // /arena -> Arena.html, password-gated. The direct asset paths (/Arena.html,
    // /Arena, any casing) are folded in here — combined with run_worker_first in
    // wrangler.jsonc — so the asset layer can't serve the page around the gate.
    // Fetch the extensionless path: html_handling 307s "/Arena.html" to "/Arena",
    // and bouncing an authed request through a redirect just re-challenges it.
    if (['/arena', '/arena.html', '/arena/'].includes(url.pathname.toLowerCase())) {
      const denied = arenaAuthDenied(request, env);
      if (denied) return denied;
      return env.ASSETS.fetch(new Request(new URL('/Arena', url), request));
    }

    // Everything else (including /) -> static assets (index.html at root by default).
    return env.ASSETS.fetch(request);
  },
};
