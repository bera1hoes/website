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

// Guild-roster proxy (/guild): mapleidle.gg holds each guild's full member list
// (including players absent from a given content run). It's a Next.js site behind
// Vercel that blocks non-browser/CORS access, so we fetch it server-side here and
// hand back a normalized roster. Rosters move ~daily, so cache long.
const MAPLEIDLE_BASE = 'https://mapleidle.gg';
const ROSTER_TTL = 21600;     // 6h

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

// ── Guild-roster parsing ────────────────────────────────────────────────────
// mapleidle's exact JSON field names couldn't be confirmed at build time (the
// site IP-rate-limits dev probes), so members are matched by candidate field
// names case-insensitively rather than against a fixed schema. If the live shape
// turns out to differ, widen these lists — nothing downstream hard-codes a key.
const NAME_KEYS  = ['nick', 'name', 'charactername', 'charname', 'ign', 'character', 'characImgName'];
const CP_KEYS    = ['combatpower', 'cp', 'battlepower', 'power', 'totalcombatpower', 'combat_power'];
const CLASS_KEYS = ['class', 'job', 'classname', 'jobname', 'jobid'];
const LEVEL_KEYS = ['level', 'lvl'];

function pickKey(obj, keys) {
  for (const k of Object.keys(obj)) {
    if (keys.includes(k.toLowerCase())) return obj[k];
  }
  return undefined;
}

function rosterNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.eE+-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function looksLikeMember(o) {
  return o && typeof o === 'object' && !Array.isArray(o)
    && pickKey(o, NAME_KEYS) !== undefined && pickKey(o, CP_KEYS) !== undefined;
}

// Walk the parsed __NEXT_DATA__ tree and return the largest array whose elements
// look like roster members (most are a name + a CP). The member list is the
// biggest such array on a guild page.
function findMemberArray(node, best) {
  best = best || { len: 0, arr: null };
  if (Array.isArray(node)) {
    if (node.length >= 3 && node.filter(looksLikeMember).length >= node.length * 0.6 && node.length > best.len) {
      best = { len: node.length, arr: node };
    }
    for (const el of node) best = findMemberArray(el, best);
  } else if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) best = findMemberArray(node[k], best);
  }
  return best;
}

function normalizeMember(o) {
  const cls = pickKey(o, CLASS_KEYS);
  const lvl = pickKey(o, LEVEL_KEYS);
  return {
    nick:  String(pickKey(o, NAME_KEYS) ?? '').trim(),
    cp:    rosterNumber(pickKey(o, CP_KEYS)),
    cls:   cls != null ? String(cls) : '',
    level: lvl != null ? rosterNumber(lvl) : 0,
  };
}

// Extract + normalize the roster from a guild page's HTML. Returns an array of
// { nick, cp, cls, level } or null if the embedded JSON can't be located/parsed.
function parseRoster(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let data;
  try { data = JSON.parse(m[1]); } catch { return null; }
  const found = findMemberArray(data);
  if (!found.arr) return null;
  return found.arr.map(normalizeMember).filter(x => x.nick && x.cp > 0);
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

// Proxy /guild to mapleidle.gg's guild page, scrape + normalize the roster, and
// return it as JSON. Server-side so the browser never hits mapleidle directly
// (CORS + bot-gating). `bust=1` skips the edge cache. A browser-like User-Agent
// is used because mapleidle 429s obvious bots.
async function handleGuild(url, ctx) {
  const cache = caches.default;
  const canonical = new URL(url);
  const bust = canonical.searchParams.has('bust');
  canonical.searchParams.delete('bust');
  const world = (canonical.searchParams.get('world') || 'bera').toLowerCase();
  const name = canonical.searchParams.get('name') || '';
  if (!name) return jsonError(400, 'Missing guild name');
  const cacheKey = new Request(canonical.toString(), { method: 'GET' });

  if (!bust) {
    const hit = await cache.match(cacheKey);
    if (hit) return asCacheHit(hit);
  }

  const target = MAPLEIDLE_BASE + '/guild/' + encodeURIComponent(world) + '/' + encodeURIComponent(name);
  let upstream;
  try {
    upstream = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
  } catch (err) {
    return jsonError(502, 'Roster request failed: ' + String(err.message || err));
  }
  if (upstream.status === 429) return jsonError(429, 'mapleidle rate-limited the roster request — try again shortly');
  if (!upstream.ok) return jsonError(502, 'mapleidle returned HTTP ' + upstream.status);

  const html = await upstream.text();
  const roster = parseRoster(html);
  if (!roster || !roster.length) {
    return jsonError(502, 'Could not parse a roster for "' + name + '" (guild empty or page shape changed)');
  }

  const response = jsonResponse(JSON.stringify(roster), ROSTER_TTL);
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api') {
      return handleApi(url, ctx);
    }

    if (url.pathname === '/guild') {
      return handleGuild(url, ctx);
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
