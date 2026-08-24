// ==UserScript==
// @name         (s)hoes — push mapleidle baselines
// @namespace    https://hoes.fyi/
// @version      1.0.0
// @description  Scrape the per-content power-law baseline fits off mapleidle.gg's Score Analysis page and push them to the (s)hoes chart site.
// @author       bera1hoes
// @match        https://mapleidle.gg/tools/score-analysis*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      hoes.fyi
// ==/UserScript==

// Why a userscript: mapleidle's score-analysis route can't be read by anything
// except a browser already sitting on the page. A Cloudflare Worker fetch gets
// 429 (datacenter IP), a scripted fetch gets 429 even from a residential IP
// (automation fingerprint), and a cross-origin fetch from our own site is
// CORS-blocked — the route sends no Access-Control-Allow-Origin, and `no-cors`
// hands back an opaque, empty response. Running *in* the page sidesteps all of
// it: same-origin data, a real cleared browser, no scraping infrastructure.
//
// The numbers are not in the DOM in full precision (the page prints a rounded
// "e^5.08·CP^0.59"), but every content type and both job cohorts sit in Next's
// flight payload at full precision, so that's what we read.

(function () {
  'use strict';

  const DEFAULT_SITE = 'https://hoes.fyi';
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  // ── Extraction ────────────────────────────────────────────────────────────
  // Same approach as the sibling mapleidle-performance-vs userscript: rebuild
  // Next's flight text, then slice the `analysis` object out by brace matching
  // and JSON.parse it. Parsing beats regex-scraping here — the payload is real
  // JSON, so we get exact numbers and notice immediately if the shape changes.
  //   analysis[cohort][mode] = { fitA, fitB, perClass: [...], snapshotDate }

  // The payload ships as self.__next_f.push([1,"<escaped chunk>"]) calls. On a
  // live page the global already holds the decoded chunks; the DOM fallback
  // re-decodes them from the script tags.
  function flightText(html) {
    const re = /self\.__next_f\.push\(\[\s*1\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\)/g;
    let out = '';
    let m;
    while ((m = re.exec(html))) {
      try { out += JSON.parse(m[1]); } catch (e) { /* not a plain string chunk */ }
    }
    return out;
  }

  function payloadText() {
    try {
      const f = self.__next_f;
      if (Array.isArray(f)) {
        const joined = f.map(p => (Array.isArray(p) && typeof p[1] === 'string') ? p[1] : '').join('');
        if (joined.includes('fitA')) return joined;
      }
    } catch (e) { /* fall through to the DOM */ }
    return flightText(document.documentElement.innerHTML);
  }

  // Return the complete `{...}` starting at `start`, respecting strings/escapes.
  function sliceObject(s, start) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return s.slice(start, i + 1);
    }
    return null;
  }

  function extract() {
    const text = payloadText();
    const at = text.indexOf('"analysis":{');
    if (at === -1) return { error: 'No analysis payload on the page — has the layout changed?' };
    const raw = sliceObject(text, text.indexOf('{', at + 11));
    if (!raw) return { error: 'Analysis payload looks truncated.' };

    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return { error: 'Could not parse the analysis payload.' }; }

    // Keep only the coefficients. perClass and sampledPoints are the bulk of the
    // payload (~300 KB of scatter samples) and nothing downstream reads them.
    const analysis = {};
    let total = 0;
    for (const [cohort, modes] of Object.entries(parsed)) {
      if (!modes || typeof modes !== 'object') continue;
      const block = {};
      for (const [mode, fit] of Object.entries(modes)) {
        if (!fit || typeof fit !== 'object') continue;
        const fitA = Number(fit.fitA);
        const fitB = Number(fit.fitB);
        if (!isFinite(fitA) || !isFinite(fitB)) continue;
        block[mode] = { fitA, fitB, snapshotDate: fit.snapshotDate };
        total++;
      }
      if (Object.keys(block).length) analysis[cohort] = block;
    }
    if (!total) return { error: 'Analysis payload had no usable fits.' };
    return { analysis, total };
  }

  // ── Transport ─────────────────────────────────────────────────────────────
  // GM_xmlhttpRequest rather than fetch: it's exempt from CORS, so this works
  // even if the Worker's headers ever change. @connect pins it to hoes.fyi.

  function request(method, url, { token, body } = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: Object.assign(
          { 'Accept': 'application/json' },
          token ? { 'Authorization': 'Bearer ' + token } : {},
          body ? { 'Content-Type': 'application/json' } : {}
        ),
        data: body ? JSON.stringify(body) : undefined,
        timeout: 20000,
        onload: (res) => {
          let parsed = null;
          try { parsed = JSON.parse(res.responseText); } catch (e) { /* non-JSON body */ }
          if (res.status >= 200 && res.status < 300) resolve(parsed);
          else reject(new Error((parsed && parsed.error) || `HTTP ${res.status}`));
        },
        onerror: () => reject(new Error('Network error — is the site reachable?')),
        ontimeout: () => reject(new Error('Timed out')),
      });
    });
  }

  const siteUrl = () => String(GM_getValue('siteUrl', DEFAULT_SITE)).replace(/\/+$/, '');

  // The write key is kept in Tampermonkey's storage rather than inline in this
  // file, so the script stays shareable and the key isn't in the page context.
  function writeKey({ force } = {}) {
    let key = GM_getValue('writeKey', '');
    if (!key || force) {
      key = (window.prompt('CHART_WRITE_KEY for ' + siteUrl(), key || '') || '').trim();
      if (key) GM_setValue('writeKey', key);
    }
    return key;
  }

  // ── UI ────────────────────────────────────────────────────────────────────

  const ui = {};

  function buildUI() {
    const box = document.createElement('div');
    box.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'background:#12151c', 'color:#e8eaf0', 'border:1px solid rgba(240,165,0,0.45)',
      'border-radius:12px', 'padding:12px 14px', 'width:260px',
      'font:12px/1.5 ui-sans-serif,system-ui,sans-serif', 'box-shadow:0 8px 24px rgba(0,0,0,0.5)',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = '(s)hoes · baselines';
    title.style.cssText = 'font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#f0a500;margin-bottom:8px';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Push baselines to site';
    btn.style.cssText = 'width:100%;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:#1a1f2e;color:#e8eaf0;font:inherit;cursor:pointer';
    btn.addEventListener('click', () => push({ force: false }));

    const status = document.createElement('div');
    status.style.cssText = 'margin-top:8px;min-height:16px;color:#8b919e;font-family:ui-monospace,monospace;font-size:11px';

    const cfg = document.createElement('a');
    cfg.href = '#';
    cfg.textContent = 'set key / site';
    cfg.style.cssText = 'display:inline-block;margin-top:6px;color:#6b7280;font-size:10px;text-decoration:underline;cursor:pointer';
    cfg.addEventListener('click', (e) => {
      e.preventDefault();
      const url = (window.prompt('Site URL', siteUrl()) || '').trim();
      if (url) GM_setValue('siteUrl', url.replace(/\/+$/, ''));
      writeKey({ force: true });
      say('saved.', '#4ade80');
    });

    box.append(title, btn, status, cfg);
    document.body.appendChild(box);
    ui.btn = btn;
    ui.status = status;
  }

  function say(msg, color) {
    ui.status.textContent = msg;
    ui.status.style.color = color || '#8b919e';
  }

  function daysSince(iso) {
    const t = Date.parse(iso);
    return isFinite(t) ? (Date.now() - t) / (24 * 60 * 60 * 1000) : Infinity;
  }

  // ── Push ──────────────────────────────────────────────────────────────────

  async function push({ force }) {
    ui.btn.disabled = true;
    try {
      const key = writeKey();
      if (!key) { say('no write key set.', '#f87171'); return; }

      // Weekly guard: the fits only move when mapleidle re-snapshots, so a push
      // inside the same week is almost always redundant. Confirm rather than
      // refuse — re-pushing is harmless if you know the snapshot changed.
      say('checking what the site has…');
      let current = null;
      try { current = await request('GET', siteUrl() + '/api?action=getBaselines'); } catch (e) { /* treat as empty */ }
      if (!force && current && current.fetchedAt) {
        const age = daysSince(current.fetchedAt);
        if (age < 7) {
          const ok = window.confirm(
            `The site's baselines are ${age.toFixed(1)} days old (refreshed weekly).\n\nPush anyway?`
          );
          if (!ok) { say(`kept — ${age.toFixed(1)}d old.`); return; }
        }
      }

      say('reading the page…');
      const found = extract();
      if (found.error) { say(found.error, '#f87171'); return; }

      say(`uploading ${found.total} fits…`);
      const res = await request('POST', siteUrl() + '/baseline', {
        token: key,
        body: { analysis: found.analysis },
      });
      const skipped = (res && res.skipped && res.skipped.length) ? ` (skipped ${res.skipped.join(', ')})` : '';
      say(`pushed ${res ? res.fits : found.total} fits.${skipped}`, '#4ade80');
    } catch (err) {
      const msg = String(err && err.message || err);
      say(msg === 'HTTP 401' ? 'unauthorized — check the write key.' : msg, '#f87171');
    } finally {
      ui.btn.disabled = false;
    }
  }

  // The page is client-rendered; wait for the payload to carry fits before
  // offering the button so a click can't land on a half-hydrated page.
  function boot() {
    buildUI();
    const started = Date.now();
    const tick = setInterval(() => {
      if (payloadText().includes('fitA')) {
        clearInterval(tick);
        say('ready.');
      } else if (Date.now() - started > 30000) {
        clearInterval(tick);
        say('no fit data found on this page.', '#f87171');
      }
    }, 500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
