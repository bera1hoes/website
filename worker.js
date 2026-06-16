import puppeteer from '@cloudflare/puppeteer';

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
// (including players absent from a given content run). It's a Vercel-hosted SPA
// that serves guild data only to a challenge-cleared real browser — a plain
// fetch (even from a residential IP) gets 429'd by automation fingerprinting.
// So we drive a real edge Chromium via Browser Rendering, warm up the challenge
// once per browser, then read each guild's rendered roster. Rosters move ~daily,
// so each guild is edge-cached long.
const MAPLEIDLE_BASE = 'https://mapleidle.gg';
const ROSTER_TTL = 21600;     // 6h
const REAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

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
// mapleidle renders CP in this project's own gaming notation (e.g. "1AA 642T"),
// so parse it back to a number — inverse of toGamingNotation in public/js/util.js.
// Suffix N is 1000^N: ''=0, K=1, M=2, B=3, T=4, then AA=5, AB=6, … AT=24.
const GN_SUFFIX = (() => {
  const list = ['', 'K', 'M', 'B', 'T',
    'AA', 'AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH', 'AI', 'AJ',
    'AK', 'AL', 'AM', 'AN', 'AO', 'AP', 'AQ', 'AR', 'AS', 'AT'];
  const m = {};
  list.forEach((s, i) => { m[s] = i; });
  return m;
})();

function parseGamingNotation(text) {
  let total = 0;
  for (const part of String(text).trim().split(/\s+/)) {
    const m = part.match(/^([\d.,]+)\s*([A-Z]{0,2})$/);
    if (!m) continue;
    const num = Number(m[1].replace(/,/g, ''));
    const exp = GN_SUFFIX[m[2] || ''];
    if (!Number.isFinite(num) || exp === undefined) continue;
    total += num * Math.pow(1000, exp);
  }
  return total;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Make a managed edge page look like a real browser. Vercel's challenge 429s
// obvious automation (navigator.webdriver === true is the giveaway), which is
// the tell we couldn't strip via a Chrome flag on the managed browser — so strip
// it from JS instead. Each step is best-effort: an unsupported API must not abort
// the render.
async function hardenPage(page) {
  try { await page.setUserAgent(REAL_UA); } catch { /* */ }
  try {
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Chromium";v="126", "Google Chrome";v="126", "Not.A/Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    });
  } catch { /* */ }
  try {
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      window.chrome = window.chrome || { runtime: {} };
    });
  } catch { /* */ }
}

// Render one guild page in the given (already challenge-warmed) browser and
// extract its roster. mapleidle is a client-rendered SPA: each member is a
// `[data-member-name]` element holding a /characters/<world>/<nick> link and a
// CP span in gaming notation. Class is icon-only (no text) so it's left blank —
// projected members then use the raw fit (no class bias). Returns
// [{ nick, cp, cls, level }].
async function renderRoster(browser, world, name) {
  const page = await browser.newPage();
  try {
    await hardenPage(page);
    const target = MAPLEIDLE_BASE + '/guild/' + encodeURIComponent(world) + '/' + encodeURIComponent(name);
    let resp = await page.goto(target, { waitUntil: 'networkidle0', timeout: 30000 });
    // A 429 is Vercel's challenge; it sets a clearance cookie, so wait + retry once.
    if (resp && resp.status() === 429) {
      await sleep(4000);
      resp = await page.goto(target, { waitUntil: 'networkidle0', timeout: 30000 });
    }
    if (resp && resp.status() === 429) throw new Error('mapleidle rate-limited (429)');
    // Member rows hydrate client-side; wait for them (best-effort).
    await page.waitForSelector('[data-member-name]', { timeout: 15000 }).catch(() => {});
    const raw = await page.evaluate(() => {
      const rows = [];
      document.querySelectorAll('[data-member-name]').forEach(el => {
        const a = el.querySelector('a[href*="/characters/"]');
        let nick = '';
        if (a) {
          const parts = a.getAttribute('href').split('/');
          nick = decodeURIComponent(parts[parts.length - 1] || '');
        }
        if (!nick) nick = el.getAttribute('data-member-name') || '';
        // CP is the span whose text is a gaming-notation number (e.g. "1AA 642T").
        let cpText = '';
        el.querySelectorAll('span').forEach(s => {
          if (cpText) return;
          const t = (s.textContent || '').trim();
          if (/^\d[\d.,]*\s*(K|M|B|T|A[A-Z])(\s+\d[\d.,]*\s*(K|M|B|T|A[A-Z]))?$/.test(t)) cpText = t;
        });
        rows.push({ nick, cpText });
      });
      return rows;
    });
    return raw
      .map(r => ({ nick: String(r.nick || '').trim(), cp: parseGamingNotation(r.cpText), cls: '', level: 0 }))
      .filter(r => r.nick && r.cp > 0);
  } finally {
    await page.close();
  }
}

// Per-guild edge-cache key (world+name), independent of which sheet/content type
// asked — rosters are shared. Normalized so a batch request reuses single-guild
// entries and vice-versa.
function rosterCacheKey(origin, world, name) {
  const u = new URL(origin + '/guild');
  u.searchParams.set('world', world);
  u.searchParams.set('name', name);
  return new Request(u.toString(), { method: 'GET' });
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

// GET /guild?world=bera&names=hoes,rivals,…  → { "<guild>": [{nick,cp,cls,level}] | {error} }
// Drives one edge Chromium (Browser Rendering) for the whole batch: cached
// guilds are served from the edge cache, and only the misses are rendered — in a
// single browser that's warmed against Vercel's challenge once up front. Batching
// matters because each browser launch is slow and Browser Rendering caps
// concurrent browsers per account. `bust=1` re-renders past the cache.
async function handleGuild(url, env, ctx) {
  const cache = caches.default;
  const canonical = new URL(url);
  const bust = canonical.searchParams.has('bust');
  const world = (canonical.searchParams.get('world') || 'bera').toLowerCase();
  // Accept ?names=a,b,c (batch) or ?name=a (single).
  const rawNames = canonical.searchParams.get('names') || canonical.searchParams.get('name') || '';
  const names = [...new Set(rawNames.split(',').map(s => s.trim()).filter(Boolean))];
  if (!names.length) return jsonError(400, 'Missing guild name(s)');

  const result = {};
  const misses = [];
  for (const name of names) {
    if (!bust) {
      const hit = await cache.match(rosterCacheKey(url.origin, world, name));
      if (hit) { result[name] = await hit.json(); continue; }
    }
    misses.push(name);
  }

  if (misses.length) {
    if (!env.BROWSER) return jsonError(503, 'Browser Rendering is not configured for this environment');
    let browser;
    try {
      browser = await puppeteer.launch(env.BROWSER);
    } catch (err) {
      return jsonError(502, 'Could not start Browser Rendering: ' + String(err.message || err));
    }
    try {
      // Warm up once: the first hit clears Vercel's challenge and sets a cookie
      // the whole browser then reuses for the guild pages. Pause after load so the
      // challenge JS has time to run and set that cookie.
      try {
        const warm = await browser.newPage();
        await hardenPage(warm);
        await warm.goto(MAPLEIDLE_BASE + '/', { waitUntil: 'networkidle0', timeout: 30000 });
        await sleep(4000);
        await warm.close();
      } catch { /* non-fatal: the per-guild loads still try on their own */ }

      for (const name of misses) {
        try {
          const roster = await renderRoster(browser, world, name);
          if (!roster.length) throw new Error('empty roster (guild not found or page shape changed)');
          result[name] = roster;
          ctx.waitUntil(cache.put(
            rosterCacheKey(url.origin, world, name),
            jsonResponse(JSON.stringify(roster), ROSTER_TTL)
          ));
        } catch (err) {
          result[name] = { error: String(err.message || err) };
        }
      }
    } finally {
      await browser.close();
    }
  }

  // Short browser-cache; the per-guild edge entries carry the long TTL.
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=30' },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api') {
      return handleApi(url, ctx);
    }

    if (url.pathname === '/guild') {
      return handleGuild(url, env, ctx);
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
