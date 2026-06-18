const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzV3Ui_OS5LJ7K49YOZ1ropYZCbyAsuBfnrB2sERlh2y40ylivWxtdsgcQ2kTTpS4VG5w/exec';

// Content types — must mirror the keys of CONTENT_SOURCES in Code.gs. Used only
// by the seed/migration loop; the read path keys off whatever ?contentType= asks.
const CONTENT_TYPES = [
  'Guild Wars',
  'Guild Boss Battle',
  'Global GBB',
  'Guild Conquest',
  'Guild Training Ground',
];

// ── Data model ───────────────────────────────────────────────────────────────
// Chart data lives in Workers KV (binding CHART_DATA), so the read path never
// touches Google. Two key shapes:
//   names:<type>        -> { updated: <Drive ISO|null>, sheets: ["MM-DD-YYYY", …] }
//   data:<type>:<sheet> -> { rows: [ {rank, nick, score, …}, … ],
//                            rosters: { "<guild>": [ {nick,cp,cls,level}, … ] } }
// `rosters` is a frozen snapshot of the sheet's guilds' rosters (from the ROSTERS
// namespace), embedded when the entry is first created and carried over on updates so
// Win Prediction reads it with no extra KV call (see syncData / refreshRosters). Legacy
// bare-array entries are still served (rows with no rosters) until refreshed.
// The Drive modified timestamp is per-spreadsheet, so it lives once in `names`;
// getData carries no timestamp (the client's "Last updated" display is fed by
// getSheetNames' x-last-updated header). Apps Script is reached only on a KV
// miss (lazy first-fill) or an explicit Reload (?bust=1). KV is the cache, so
// responses are no-store.
const namesKey = (type) => `names:${type}`;
const dataKey = (type, sheet) => `data:${type}:${sheet}`;

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

// Fetch + parse one Apps Script action. Apps Script serves an HTML login/error
// page on failure and reports logic errors as a 200 {error} object — both are
// rejected here so a bad upstream never gets stored or passed through as data.
// Returns { value } (parsed JSON) or { error: Response }.
async function appsScript(action, params) {
  const qs = new URLSearchParams(Object.assign({ action }, params || {}));
  let upstream;
  try {
    upstream = await fetch(APPS_SCRIPT_URL + '?' + qs.toString(), { redirect: 'follow' });
  } catch (err) {
    return { error: jsonError(502, 'Upstream request failed: ' + String(err.message || err)) };
  }
  const text = await upstream.text();
  if (!upstream.ok) return { error: jsonError(502, 'Upstream returned HTTP ' + upstream.status) };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: jsonError(502, 'Upstream returned a non-JSON response') };
  }
  if (value && value.error) return { error: jsonError(502, 'Upstream error: ' + value.error) };
  return { value };
}

// Refetch a content type's sheet list + Drive timestamp from Apps Script and
// store names:<type>. getLastUpdated failing is non-fatal — the names list is
// what matters, so it's stored with updated=null. Returns { record } or { error }.
async function syncNames(env, type) {
  const namesRes = await appsScript('getSheetNames', { contentType: type });
  if (namesRes.error) return namesRes;
  const tsRes = await appsScript('getLastUpdated', { contentType: type });
  const updated = (!tsRes.error && typeof tsRes.value === 'string') ? tsRes.value : null;
  const record = { updated, sheets: namesRes.value };
  await env.CHART_DATA.put(namesKey(type), JSON.stringify(record));
  return { record };
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

// Refetch one sheet's rows from Apps Script and store data:<type>:<sheet> as
// { rows, rosters }. The roster snapshot is carried over from the previous entry on
// an update (Reload/reseed); on initial creation it's pulled fresh from ROSTERS for
// the guilds in rows. Returns the stored { rows, rosters } object or { error }.
async function syncData(env, type, sheet) {
  const dataRes = await appsScript('getData', { contentType: type, sheet });
  if (dataRes.error) return dataRes;
  const rows = dataRes.value;

  const prevRaw = await env.CHART_DATA.get(dataKey(type, sheet));
  let rosters;
  if (prevRaw) {
    const prev = JSON.parse(prevRaw);          // update: carry over (don't re-pull)
    rosters = (prev && !Array.isArray(prev) && prev.rosters) ? prev.rosters : {};
  } else {
    rosters = await pullRosters(env, 'bera', guildsOf(rows)); // initial create: embed
  }

  const value = { rows, rosters };
  await env.CHART_DATA.put(dataKey(type, sheet), JSON.stringify(value));
  return value;
}

// Serve /api from KV. ?bust=1 (the client's Reload) bypasses KV, refetches from
// Apps Script, overwrites the key, and returns fresh — Reload's getData and
// getSheetNames each refetch their own key, so there is no KV read-after-write
// dependency between them. The 60s client cooldown rate-limits this path.
async function handleApi(url, env) {
  const params = url.searchParams;
  const action = params.get('action');
  const type = params.get('contentType') || '';
  const bust = params.has('bust');

  if (action === 'getSheetNames') {
    if (!bust) {
      const stored = await env.CHART_DATA.get(namesKey(type));
      if (stored) {
        const rec = JSON.parse(stored);
        return jsonResponse(JSON.stringify(rec.sheets), rec.updated);
      }
    }
    const res = await syncNames(env, type); // bust, or lazy first-fill
    if (res.error) return res.error;
    return jsonResponse(JSON.stringify(res.record.sheets), res.record.updated);
  }

  if (action === 'getData') {
    const sheet = params.get('sheet') || '';
    if (!bust) {
      const stored = await env.CHART_DATA.get(dataKey(type, sheet));
      if (stored) return jsonResponse(stored); // { rows, rosters } (or legacy bare array)
    }
    const res = await syncData(env, type, sheet); // bust, or lazy first-fill
    if (res.error) return res.error;
    return jsonResponse(JSON.stringify(res));
  }

  // Re-pull the roster snapshot for a sheet from the ROSTERS namespace into its
  // data:<type>:<sheet> entry (the chart's "Refresh rosters" button). The data
  // rows are left as-is; only `rosters` is refreshed. Same UI-writes-KV posture as
  // the Reload/bust path above.
  if (action === 'refreshRosters') {
    const sheet = params.get('sheet') || '';
    const stored = await env.CHART_DATA.get(dataKey(type, sheet));
    if (!stored) return jsonError(404, 'No data for that sheet yet — load it first');
    const entry = JSON.parse(stored);
    const rows = Array.isArray(entry) ? entry : (entry.rows || []);
    const rosters = await pullRosters(env, 'bera', guildsOf(rows));
    const value = { rows, rosters };
    await env.CHART_DATA.put(dataKey(type, sheet), JSON.stringify(value));
    return jsonResponse(JSON.stringify(value));
  }

  // Legacy/compat: HAS_GAS clients call getLastUpdated directly. Serve it from
  // the names record (lazy-fill or bust refreshes it).
  if (action === 'getLastUpdated') {
    let rec = null;
    if (!bust) {
      const stored = await env.CHART_DATA.get(namesKey(type));
      if (stored) rec = JSON.parse(stored);
    }
    if (!rec) {
      const res = await syncNames(env, type);
      if (res.error) return res.error;
      rec = res.record;
    }
    return jsonResponse(JSON.stringify(rec.updated), rec.updated);
  }

  return jsonError(400, 'Unknown or missing action: ' + action);
}

// One-time / on-demand seed: GET /admin/seed?key=<SEED_KEY>[&type=<contentType>].
// Populates KV from Apps Script for one content type (?type=) or all of them.
// Guarded by the SEED_KEY Wrangler secret. Scope with ?type= to stay under the
// per-invocation subrequest limit on large spreadsheets.
async function handleSeed(url, env) {
  const provided = (url.searchParams.get('key') || '').trim();
  const expected = (env.SEED_KEY || '').trim();
  if (!expected || provided !== expected) {
    return jsonError(403, 'Forbidden');
  }
  const only = url.searchParams.get('type');
  const types = only ? [only] : CONTENT_TYPES;
  const summary = {};
  for (const type of types) {
    const namesRes = await syncNames(env, type);
    if (namesRes.error) { summary[type] = { error: 'getSheetNames/getLastUpdated failed' }; continue; }
    const sheets = namesRes.record.sheets || [];
    let written = 0, failed = 0;
    for (const sheet of sheets) {
      const dr = await syncData(env, type, sheet);
      if (dr.error) failed++; else written++;
    }
    summary[type] = { updated: namesRes.record.updated, sheets: sheets.length, dataWritten: written, dataFailed: failed };
  }
  return jsonResponse(JSON.stringify(summary, null, 2));
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

    if (url.pathname === '/admin/seed') {
      return handleSeed(url, env);
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
