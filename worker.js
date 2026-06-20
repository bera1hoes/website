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
//                            rosters:     { "<guild>": [ {nick,cp,cls,level}, … ] },
//                            perfProfile: { "<nick>": <factor> } }   (optional)
//   guildweeks:<type>   -> { "<guild>": ["MM-DD-YYYY", …] }   (PERF_TYPES only)
// `rosters` is a frozen snapshot of the sheet's guilds' rosters (from the ROSTERS
// namespace), embedded on /chart ingest and carried over on updates so Win
// Prediction reads it with no extra KV call. Legacy bare-array entries are still
// served (rows with no rosters) until refreshed. `perfProfile` is a
// recency-weighted per-player over/under-performance factor built from the PRIOR
// sheets where the current guilds appeared (buildPerfProfile), embedded here and
// carried over on update. `guildweeks` lets buildPerfProfile pick the relevant
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

// Snapshot of the given guilds' rosters from the ROSTERS namespace (per-guild keys).
// Skips guilds with no stored/empty roster. Returns { "<guild>": members[] }.
async function pullRosters(env, world, guilds) {
  if (!env.ROSTERS) return {};
  const out = {};
  await Promise.all([...new Set(guilds)].map(async (g) => {
    const r = await env.ROSTERS.get(rosterKvKey(world, g), { type: 'json' });
    if (Array.isArray(r) && r.length) out[g] = r;
  }));
  return out;
}

// Add a sheet to each of its guilds' lists in guildweeks:<type> (PERF_TYPES only).
// Idempotent set-merge, so re-runs / out-of-order calls are safe. This is the
// lookup buildPerfProfile uses to skip prior sheets that don't contain the current
// guilds.
async function mergeGuildWeeks(env, type, sheet, rows) {
  if (!PERF_TYPES.includes(type)) return;
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

// Build (and embed) the recency-weighted per-player performance profile for one
// sheet. For each PRIOR sheet where one of this sheet's guilds appeared (guildweeks
// lookup; self-heals to all prior sheets if the index is missing/incomplete), fit
// that sheet and record each player's score/fit ratio, weighted by recency. Writes
// { nick: factor } into the entry's perfProfile and returns the entry. No-op (returns
// the entry unchanged) for content types not in PERF_TYPES, or when the sheet has no
// stored entry yet.
async function buildPerfProfile(env, type, sheet) {
  // Current entry — need its rows/guilds and must preserve rows+rosters on write-back.
  const curRaw = await env.CHART_DATA.get(dataKey(type, sheet));
  if (!curRaw) return { rows: [], rosters: {}, perfProfile: {} };
  const e = JSON.parse(curRaw);
  const cur = Array.isArray(e) ? { rows: e, rosters: {} } : e;
  if (!PERF_TYPES.includes(type)) return cur;  // skipped types: no profile

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
  for (let i = 0; i < priors.length; i++) {
    const w = Math.pow(PERF_DECAY, i);
    const rows = await readRows(env, type, priors[i]);
    recordGuilds(priors[i], rows);
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

  const perfProfile = {};
  for (const nick of Object.keys(sum)) {
    if (wsum[nick] > 0) perfProfile[nick] = sum[nick] / wsum[nick];
  }

  const value = { rows: cur.rows, rosters: cur.rosters || {}, perfProfile };
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
    const rosters = await pullRosters(env, 'bera', guildsOf(rows));
    const value = { rows, rosters };
    // Preserve any embedded perfProfile — refreshing rosters must not drop it.
    if (!Array.isArray(entry) && entry.perfProfile) value.perfProfile = entry.perfProfile;
    await env.CHART_DATA.put(dataKey(type, sheet), JSON.stringify(value));
    return jsonResponse(JSON.stringify(value));
  }

  // Build + embed the recency-weighted per-player performance profile for a sheet
  // (Win Prediction's "adjust by history"). Reads only the relevant prior sheets via
  // the guildweeks lookup; writes { rows, rosters, perfProfile } back. The client
  // auto-triggers this once when a sheet has no embedded profile yet.
  if (action === 'buildPerfProfile') {
    const sheet = params.get('sheet') || '';
    const res = await buildPerfProfile(env, type, sheet);
    if (res && res.error) return res.error;
    return jsonResponse(JSON.stringify(res));
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

  // Embed rosters: carry over from an existing entry (and keep its perfProfile),
  // else pull fresh from ROSTERS for the rows' guilds — same as syncData did.
  const prevRaw = await env.CHART_DATA.get(dataKey(type, date));
  let rosters, perfProfile;
  if (prevRaw) {
    const prev = JSON.parse(prevRaw);
    const obj = (prev && !Array.isArray(prev)) ? prev : {};
    rosters = obj.rosters || {};
    perfProfile = obj.perfProfile;
  } else {
    rosters = await pullRosters(env, 'bera', guildsOf(rows));
  }

  const value = { rows, rosters };
  if (perfProfile) value.perfProfile = perfProfile;
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

// ── Guild rosters (/guild) ───────────────────────────────────────────────────
// mapleidle.gg serves guild member lists only to a challenge-cleared real browser
// (Vercel blocks datacenter IPs + scripted fetches; CORS blocks visitor fetches),
// so rosters are captured locally by the SwissKnife mitmproxy addon and POSTed
// here into KV (binding ROSTERS). The chart's Win Prediction reads them back. This
// Worker only stores + serves; it never talks to mapleidle.

// KV key for a guild roster. World + guild are lowercased so the chart's
// exact-case names and the captured-from-URL names map to one entry.
function rosterKvKey(world, name) {
  return 'roster:' + String(world).toLowerCase() + ':' + String(name).toLowerCase();
}

// Normalize an uploaded member list to [{nick, cp, cls, level}] (cp numeric > 0).
function cleanRoster(members) {
  if (!Array.isArray(members)) return [];
  return members
    .map(m => ({
      nick:  String((m && m.nick) || '').trim(),
      cp:    Number(m && m.cp) || 0,
      cls:   String((m && m.cls) || ''),
      level: Number(m && m.level) || 0,
    }))
    .filter(m => m.nick && m.cp > 0);
}

// POST /guild  (Authorization: Bearer <ROSTER_WRITE_KEY>) — SwissKnife uploads
// captured rosters here. Body: { world, guild, members:[…] } or a batch
// { world, rosters: { "<guild>": [members] } }. Stores each guild in KV.
async function handleRosterUpload(request, env) {
  if (!env.ROSTERS) return jsonError(503, 'Roster store (KV) not configured');
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!env.ROSTER_WRITE_KEY || token !== env.ROSTER_WRITE_KEY) return jsonError(401, 'Unauthorized');

  let body;
  try { body = await request.json(); } catch { return jsonError(400, 'Invalid JSON body'); }

  const world = String(body.world || 'bera').toLowerCase();
  const stored = [];
  const put = async (guild, members) => {
    const g = String(guild || '').trim();
    if (!g) return;
    const roster = cleanRoster(members);
    await env.ROSTERS.put(rosterKvKey(world, g), JSON.stringify(roster));
    stored.push({ guild: g, count: roster.length });
  };

  if (body.rosters && typeof body.rosters === 'object') {
    for (const [g, members] of Object.entries(body.rosters)) await put(g, members);
  } else {
    await put(body.guild, body.members);
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

    // /arena -> Arena.html
    if (url.pathname === '/arena') {
      return env.ASSETS.fetch(new Request(new URL('/Arena.html', url), request));
    }

    // Everything else (including /) -> static assets (index.html at root by default).
    return env.ASSETS.fetch(request);
  },
};
