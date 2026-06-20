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

// ── Data model ───────────────────────────────────────────────────────────────
// Chart data lives in Workers KV (binding CHART_DATA) and is the sole source of
// truth — there is no Google read path. SwissKnife captures guild-content
// rankings and POSTs them to /chart, which writes these two key shapes:
//   names:<type>        -> { updated: <ISO>, sheets: ["MM-DD-YYYY", …] }
//   data:<type>:<sheet> -> [ {rank, nick, score, …}, … ]   (bare rows array)
// `updated` is stamped at write time and rides getSheetNames' x-last-updated
// header (feeds the client's "Last updated" display); getData carries no
// timestamp. KV is the store, so read responses are no-store.
const namesKey = (type) => `names:${type}`;
const dataKey = (type, sheet) => `data:${type}:${sheet}`;

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

// Serve /api from KV — the sole source of truth (no upstream). A missing key
// returns an empty result rather than an error, so a not-yet-uploaded content
// type / sheet degrades gracefully. KV is no-store, so a re-read (the client's
// Reload) is always fresh; ?bust= is accepted but has no special effect.
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
    if (!stored) return jsonResponse('[]');
    // The client expects a bare rows array. Tolerate a legacy/defensive
    // { rows: [...] } wrapper too, so a value stored in either shape always
    // reads back as an array (never `data.map is not a function`).
    let rows;
    try {
      const parsed = JSON.parse(stored);
      rows = Array.isArray(parsed) ? parsed
           : (parsed && Array.isArray(parsed.rows) ? parsed.rows : []);
    } catch { rows = []; }
    return jsonResponse(JSON.stringify(rows));
  }

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
// Writes data:<type>:<date>, then upserts the date into names:<type> (sorted
// newest-first) and stamps `updated`. Guarded by the CHART_WRITE_KEY secret.

const DATE_RE = /^\d{2}-\d{2}-\d{4}$/;

// Normalize an uploaded row to the canonical getData shape, dropping rows with a
// missing/zero cp or score (same rule the old Apps Script getData applied).
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

  await env.CHART_DATA.put(dataKey(type, date), JSON.stringify(rows));

  const stored = await env.CHART_DATA.get(namesKey(type));
  const rec = stored ? JSON.parse(stored) : { updated: null, sheets: [] };
  const sheets = new Set(rec.sheets || []);
  sheets.add(date);
  rec.sheets = sortSheetsDesc([...sheets]);
  rec.updated = new Date().toISOString();
  await env.CHART_DATA.put(namesKey(type), JSON.stringify(rec));

  return new Response(JSON.stringify({ ok: true, type, date, count: rows.length }), {
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
