const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzV3Ui_OS5LJ7K49YOZ1ropYZCbyAsuBfnrB2sERlh2y40ylivWxtdsgcQ2kTTpS4VG5w/exec';

// The Sheets data only changes when a new export is published, so an edge
// cache cuts Apps Script round-trips (and cold-start latency) on repeat loads.
// Per-action TTLs: a dated sheet's data is effectively immutable once
// published, so getData caches long — the client's Reload sends `bust=1`
// (see handleApi) as the freshness escape hatch for the latest sheet.
// New dates appear ~weekly, so getSheetNames refreshes every 10 minutes.
const API_CACHE_TTLS = {
  getData: 21600,
  getSheetNames: 600,
  getLastUpdated: 60,
};
const API_CACHE_TTL_DEFAULT = 60;

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// Proxy /api to the Apps Script JSON API (server-side, no CORS issue), with an
// edge cache and validation that the upstream actually returned JSON — Apps
// Script serves an HTML login/error page on failure, which must not be passed
// through labeled as JSON.
async function handleApi(url, ctx) {
  const cache = caches.default;
  const ttl = API_CACHE_TTLS[url.searchParams.get('action')] || API_CACHE_TTL_DEFAULT;

  // `bust=1` (sent by the client's Reload) skips the cache lookup but still
  // stores the fresh response under the canonical bust-stripped key, so it
  // overwrites the normal entry and the next plain request hits fresh data.
  // Never cache under the busted key itself.
  const canonical = new URL(url);
  const bust = canonical.searchParams.has('bust');
  canonical.searchParams.delete('bust');
  const cacheKey = new Request(canonical.toString(), { method: 'GET' });

  if (!bust) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  let upstream;
  try {
    upstream = await fetch(APPS_SCRIPT_URL + canonical.search, { redirect: 'follow' });
  } catch (err) {
    return jsonError(502, 'Upstream request failed: ' + String(err.message || err));
  }

  const body = await upstream.text();
  if (!upstream.ok) return jsonError(502, 'Upstream returned HTTP ' + upstream.status);
  try {
    JSON.parse(body);
  } catch {
    return jsonError(502, 'Upstream returned a non-JSON response');
  }

  const response = new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Long TTLs go in s-maxage only — the browser max-age stays short so a
      // bust (or another user's bust) isn't masked by the local HTTP cache.
      'cache-control': `public, max-age=30, s-maxage=${ttl}`,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api') {
      return handleApi(url, ctx);
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
