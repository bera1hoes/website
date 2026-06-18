const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzV3Ui_OS5LJ7K49YOZ1ropYZCbyAsuBfnrB2sERlh2y40ylivWxtdsgcQ2kTTpS4VG5w/exec';

// Edge-cache strategy: the sheets are mutable (edits cluster around the last
// day of a content run), so getData/getSheetNames responses can't just expire
// on a timer. Instead each cached entry stores the spreadsheet's Drive
// modified timestamp (x-last-updated) and is revalidated against the current
// timestamp on every request. The timestamp itself is edge-cached for TS_TTL,
// so validation is normally a pure cache lookup — at most one getLastUpdated
// round-trip to Apps Script per content type per TS_TTL window. The same
// header rides every /api response so the client never has to request
// getLastUpdated itself.
const TS_TTL = 60;            // how long a fetched timestamp is trusted
const TS_BUST_REUSE_MS = 10000; // a bust still reuses a timestamp this fresh
const VALIDATED_TTL = 86400;  // backstop for timestamp-validated entries
const DEFAULT_TTL = 60;       // plain proxy TTL for everything else

// Guild rosters (/guild): mapleidle.gg serves guild member lists (incl. players
// absent from a content run) only to a challenge-cleared real browser, so neither
// a server fetch (datacenter IP) nor a browser fetch (CORS) can reach it. Instead
// the rosters are captured locally by the SwissKnife mitmproxy addon — which reads
// them from the operator's real browser traffic — and POSTed here into KV. The
// chart then reads them back. So this Worker only stores + serves; it never talks
// to mapleidle.
function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function jsonResponse(body, sMaxage, lastUpdated) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    // Long TTLs go in s-maxage only — the browser max-age stays short so
    // busts and timestamp invalidations aren't masked by the local HTTP cache.
    'cache-control': `public, max-age=30, s-maxage=${sMaxage}`,
    'x-cache': 'MISS',
  };
  if (lastUpdated) headers['x-last-updated'] = lastUpdated;
  return new Response(body, { status: 200, headers });
}

// Re-wrap a cached response so the x-cache debug header reflects how it was
// actually served (stored entries carry MISS from when they were created).
function asCacheHit(response) {
  const r = new Response(response.body, response);
  r.headers.set('x-cache', 'HIT');
  return r;
}

// Fetch from Apps Script and validate that it actually returned JSON — it
// serves an HTML login/error page on failure, which must not be passed
// through labeled as JSON. Returns { body } or { error: Response }.
async function fetchUpstream(search) {
  let upstream;
  try {
    upstream = await fetch(APPS_SCRIPT_URL + search, { redirect: 'follow' });
  } catch (err) {
    return { error: jsonError(502, 'Upstream request failed: ' + String(err.message || err)) };
  }
  const body = await upstream.text();
  if (!upstream.ok) return { error: jsonError(502, 'Upstream returned HTTP ' + upstream.status) };
  try {
    JSON.parse(body);
  } catch {
    return { error: jsonError(502, 'Upstream returned a non-JSON response') };
  }
  return { body };
}

// KV key for a guild roster. World + guild are lowercased so the chart's
// exact-case guild names and the captured-from-URL names map to one entry.
function rosterKvKey(world, name) {
  return 'roster:' + String(world).toLowerCase() + ':' + String(name).toLowerCase();
}

// getLastUpdated returns a bare JSON string (the spreadsheet's Drive modified
// time, ISO); Code.gs reports failures as a 200 {error} object, which yields
// null here.
function parseTimestamp(body) {
  try {
    const v = JSON.parse(body);
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

// In-flight getLastUpdated fetches by content type. A Reload busts
// getSheetNames and getData together; both validations must share one
// upstream timestamp call, not race to make their own.
const tsInflight = new Map();

// Current modified timestamp for a content type's spreadsheet, edge-cached
// for TS_TTL under the same key a client ?action=getLastUpdated request maps
// to (so both share one entry). Returns null when it can't be determined —
// callers fail open and serve what they have.
async function currentTimestamp(origin, contentType, bust) {
  const cache = caches.default;
  const tsUrl = new URL(origin + '/api');
  tsUrl.searchParams.set('action', 'getLastUpdated');
  tsUrl.searchParams.set('contentType', contentType);
  const key = new Request(tsUrl.toString(), { method: 'GET' });

  const hit = await cache.match(key);
  if (hit) {
    // A bust doesn't trust the TS_TTL window, but does reuse a timestamp
    // fetched moments ago — i.e. by the preceding request of the same Reload.
    const age = Date.now() - Number(hit.headers.get('x-fetched-at') || 0);
    if (!bust || age < TS_BUST_REUSE_MS) return parseTimestamp(await hit.text());
  }

  if (tsInflight.has(contentType)) return tsInflight.get(contentType);
  const fetching = (async () => {
    const res = await fetchUpstream('?' + tsUrl.searchParams.toString());
    if (res.error) return null;
    const ts = parseTimestamp(res.body);
    if (ts) {
      const stored = jsonResponse(res.body, TS_TTL, ts);
      stored.headers.set('x-fetched-at', String(Date.now()));
      // Awaited (not waitUntil): follow-up requests arrive within
      // milliseconds of this response — the entry must already be stored,
      // or they each trigger their own upstream timestamp fetch.
      await cache.put(key, stored);
    }
    return ts;
  })();
  tsInflight.set(contentType, fetching);
  try {
    return await fetching;
  } finally {
    tsInflight.delete(contentType);
  }
}

// Proxy /api to the Apps Script JSON API (server-side, no CORS issue).
// `bust=1` (sent by the client's Reload) forces a fresh timestamp check; the
// param is stripped from the cache key so a refetch overwrites the canonical
// entry rather than caching beside it.
async function handleApi(url, ctx) {
  const cache = caches.default;
  const canonical = new URL(url);
  const bust = canonical.searchParams.has('bust');
  canonical.searchParams.delete('bust');
  const cacheKey = new Request(canonical.toString(), { method: 'GET' });

  const action = canonical.searchParams.get('action');
  if (action === 'getData' || action === 'getSheetNames') {
    const contentType = canonical.searchParams.get('contentType') || '';
    // Kick off the timestamp lookup without awaiting it: on a cache miss the
    // upstream data fetch runs in parallel with it, so a cold load pays
    // max(timestamp, data) latency rather than the sum.
    const tsPromise = currentTimestamp(url.origin, contentType, bust);
    const hit = await cache.match(cacheKey);
    if (hit) {
      // Unchanged timestamp means unchanged data — serve the cached entry
      // even on bust. A failed timestamp lookup (ts === null) fails open,
      // except on an explicit bust, where the user asked for fresh data.
      const cachedTs = await tsPromise;
      const unchanged = cachedTs !== null && hit.headers.get('x-last-updated') === cachedTs;
      if (unchanged || (cachedTs === null && !bust)) return asCacheHit(hit);
    }
    const [res, ts] = await Promise.all([fetchUpstream(canonical.search), tsPromise]);
    if (res.error) return res.error;
    const response = jsonResponse(res.body, VALIDATED_TTL, ts);
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }

  // Everything else (getLastUpdated for older clients, unknown actions):
  // plain short-TTL proxy. getLastUpdated shares its cache entry with
  // currentTimestamp above.
  if (!bust) {
    const hit = await cache.match(cacheKey);
    if (hit) return asCacheHit(hit);
  }
  const res = await fetchUpstream(canonical.search);
  if (res.error) return res.error;
  const response = jsonResponse(res.body, DEFAULT_TTL);
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
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
      return handleApi(url, ctx);
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
