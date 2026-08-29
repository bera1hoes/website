// ==UserScript==
// @name         (s)hoes — pull mapleidle player scores
// @namespace    https://hoes.fyi/
// @version      1.0.0
// @description  Fetch per-player best scores (paired with the CP they were set at) off mapleidle.gg and push them onto the (s)hoes roster store, so Win Prediction can project members we have no history for.
// @author       bera1hoes
// @match        https://mapleidle.gg/tools/score-analysis*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      hoes.fyi
// ==/UserScript==

// Win Prediction projects an absent roster member from the fit at their CP, tuned
// by a per-player factor built from our own prior sheets. A player who has never
// shown up in one gets no factor — so the roster slot we know least about is also
// the one projected most crudely.
//
// mapleidle has those players. Every character's best score per content mode is
// recorded alongside the CP they had when they set it, and that pairing is what
// makes it usable: a score judged against its own CP drops straight into the same
// score/(A·cp^B) ratio the other adjust modes use.
//
// Fetching runs here, in the page, for the same reason the baseline script does —
// those routes 429 a datacenter IP, 429 a scripted fetch from a residential one,
// and CORS-block a cross-origin read. A real browser already sitting on the site
// is the only client they answer.
//
// Two passes, cheapest first:
//   1. /api/score-analysis/guild returns EVERY member's per-mode best in one
//      request. One call per guild covers a whole roster.
//   2. anyone the guild call didn't cover (renamed, left, or not scraped yet)
//      falls back to /api/search (to resolve their worldId) + the per-character
//      route — two requests each, so this pass stays as small as possible.
//
// Both passes are staggered and sequential. Players we already hold scores for
// are skipped, and each guild is POSTed as it finishes, so a run can be stopped
// and resumed without redoing work or double-writing.

(function () {
  'use strict';

  const DEFAULT_SITE = 'https://hoes.fyi';
  const DEFAULT_REGION = 'bera';

  // Stagger between every mapleidle request. Jitter so a long run doesn't settle
  // into a machine-perfect cadence.
  const DELAY_MS = 3000;
  const JITTER_MS = 2000;

  // Re-fetch a player whose stored block is older than this. Their best score
  // only moves when they beat it, so this is about catching new bests, not
  // correcting drift.
  const STALE_DAYS = 14;

  // mapleidle's per-mode keys we keep — mirrors MI_MODES / MAPLEIDLE_CONTENT in
  // worker.js. worldBoss is deliberately absent: we have no such content type.
  const MODES = ['guildWar', 'guildBossBattle', 'conquest', 'trainingGround'];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stagger = () => sleep(DELAY_MS + Math.random() * JITTER_MS);
  const lc = (s) => String(s || '').toLowerCase();

  let stopping = false;

  // ── Transport ─────────────────────────────────────────────────────────────

  // Our site is cross-origin from here, so it goes through GM_xmlhttpRequest
  // (CORS-exempt, pinned by @connect). mapleidle is same-origin — a plain fetch
  // is right there, and keeps the browser's own session/headers.
  function siteRequest(method, url, { token, body } = {}) {
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
        timeout: 30000,
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

  async function mapleidle(path) {
    const res = await fetch(path, { credentials: 'same-origin' });
    // A 429 is the exact thing the stagger exists to avoid, so treat it as fatal
    // rather than pressing on: without this, a rate-limited guild call would fall
    // straight through to the per-player pass and hammer the same limiter with two
    // requests per member. Halting also leaves the run resumable — whatever was
    // already pushed is stored, and the next run skips it.
    if (res.status === 429) {
      stopping = true;
      throw new Error('rate-limited (429) — stopped; wait a while before resuming');
    }
    if (!res.ok) throw new Error(`mapleidle ${res.status}`);
    return res.json();
  }

  const siteUrl = () => String(GM_getValue('siteUrl', DEFAULT_SITE)).replace(/\/+$/, '');
  const region = () => lc(GM_getValue('region', DEFAULT_REGION)) || DEFAULT_REGION;
  const guildList = () =>
    String(GM_getValue('guilds', '')).split(',').map((s) => s.trim()).filter(Boolean);

  // Kept in Tampermonkey storage rather than inline, so the file stays shareable.
  function writeKey({ force } = {}) {
    let key = GM_getValue('writeKey', '');
    if (!key || force) {
      key = (window.prompt('CHART_WRITE_KEY for ' + siteUrl(), key || '') || '').trim();
      if (key) GM_setValue('writeKey', key);
    }
    return key;
  }

  // ── Shaping ───────────────────────────────────────────────────────────────

  // Both mapleidle shapes carry the same per-mode records, just nested
  // differently: the guild route puts them under `best`, the character route
  // hangs them off the top level.
  function modesFrom(src) {
    const modes = {};
    let any = false;
    for (const key of MODES) {
      const m = src && src[key];
      if (!m || typeof m !== 'object') continue;
      const score = Number(m.score);
      const cp = Number(m.cp);
      if (!(score > 0) || !(cp > 0)) continue;
      modes[key] = { score, cp, snapshotDate: m.snapshotDate };
      any = true;
    }
    return any ? modes : null;
  }

  function entryFrom(src, modeSrc) {
    const modes = modesFrom(modeSrc);
    if (!modes) return null;
    return { job: src.job || '', level: Number(src.level) || 0, modes };
  }

  function daysSince(iso) {
    const t = Date.parse(iso);
    return isFinite(t) ? (Date.now() - t) / (24 * 60 * 60 * 1000) : Infinity;
  }

  // A member needs fetching when we hold nothing for them, or what we hold has
  // gone stale. This is the whole skip rule — everything else is idempotent
  // because a re-post just overwrites the same block.
  function needsFetch(member) {
    if (!member || !member.mi || !member.mi.modes) return true;
    return daysSince(member.mi.fetchedAt) > STALE_DAYS;
  }

  // ── UI ────────────────────────────────────────────────────────────────────

  const ui = {};

  function buildUI() {
    if (document.getElementById('shoes-player-scores')) return false;
    const box = document.createElement('div');
    box.id = 'shoes-player-scores';
    // Bottom-LEFT: the sibling baseline script owns the bottom-right corner of
    // this same page.
    box.style.cssText = [
      'position:fixed', 'left:16px', 'bottom:16px', 'z-index:2147483647',
      'background:#12151c', 'color:#e8eaf0', 'border:1px solid rgba(240,165,0,0.45)',
      'border-radius:12px', 'padding:12px 14px', 'width:280px',
      'font:12px/1.5 ui-sans-serif,system-ui,sans-serif', 'box-shadow:0 8px 24px rgba(0,0,0,0.5)',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = '(s)hoes · player scores';
    title.style.cssText = 'font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#f0a500;margin-bottom:8px';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Fetch missing players';
    btn.style.cssText = 'width:100%;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:#1a1f2e;color:#e8eaf0;font:inherit;cursor:pointer';
    btn.addEventListener('click', () => run());

    const stop = document.createElement('button');
    stop.type = 'button';
    stop.textContent = 'Stop';
    stop.disabled = true;
    stop.style.cssText = 'width:100%;margin-top:6px;padding:6px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.10);background:#1a1f2e;color:#8b919e;font:inherit;cursor:pointer';
    stop.addEventListener('click', () => { stopping = true; say('stopping after this request…'); });

    const status = document.createElement('div');
    status.id = 'shoes-player-scores-status';
    status.style.cssText = 'margin-top:8px;min-height:16px;color:#8b919e;font-family:ui-monospace,monospace;font-size:11px;white-space:pre-wrap';

    const cfg = document.createElement('a');
    cfg.href = '#';
    cfg.textContent = 'set guilds / key / site';
    cfg.style.cssText = 'display:inline-block;margin-top:6px;color:#6b7280;font-size:10px;text-decoration:underline;cursor:pointer';
    cfg.addEventListener('click', (e) => {
      e.preventDefault();
      const guilds = window.prompt('Guilds to fetch (comma-separated)', guildList().join(', '));
      if (guilds !== null) GM_setValue('guilds', guilds);
      const reg = (window.prompt('Region', region()) || '').trim();
      if (reg) GM_setValue('region', lc(reg));
      const url = (window.prompt('Site URL', siteUrl()) || '').trim();
      if (url) GM_setValue('siteUrl', url.replace(/\/+$/, ''));
      writeKey({ force: true });
      say('saved.', '#4ade80');
    });

    box.append(title, btn, stop, status, cfg);
    document.body.appendChild(box);
    ui.btn = btn;
    ui.stop = stop;
    ui.status = status;
  }

  function say(msg, color) {
    ui.status.textContent = msg;
    ui.status.style.color = color || '#8b919e';
  }

  // ── Passes ────────────────────────────────────────────────────────────────

  // Pass 1: one request per guild, covering every member it knows.
  async function fetchGuild(guild, wanted, out) {
    const url = `/api/score-analysis/guild?region=${encodeURIComponent(region())}&name=${encodeURIComponent(guild)}`;
    let data;
    try {
      data = await mapleidle(url);
    } catch (err) {
      return { error: String(err.message || err) };
    }

    const members = Array.isArray(data && data.members) ? data.members : [];
    const seen = new Set();
    for (const m of members) {
      const nick = String(m && m.name || '').trim();
      if (!nick || !wanted.has(lc(nick))) continue;
      const entry = entryFrom(m, m.best);
      if (!entry) continue;
      out[nick] = entry;
      seen.add(lc(nick));
    }
    return { covered: seen };
  }

  // Pass 2: per-player, for anyone pass 1 missed. Two requests each — /api/search
  // to resolve the worldId (the character route 404s without it), then the
  // character route itself.
  async function fetchPlayer(nick) {
    const found = await mapleidle(`/api/search?q=${encodeURIComponent(nick)}`);
    const cands = (found && found.characters) || [];
    const hit = cands.find((c) => lc(c.name) === lc(nick) && lc(c.region) === region())
             || cands.find((c) => lc(c.name) === lc(nick));
    if (!hit) return null;

    await stagger();
    if (stopping) return null;

    const url = `/api/score-analysis/character?region=${encodeURIComponent(hit.region)}` +
                `&world=${encodeURIComponent(hit.worldId)}&name=${encodeURIComponent(hit.name)}`;
    const data = await mapleidle(url);
    if (!data || data.error) return null;
    return entryFrom(data, data);
  }

  // ── Run ───────────────────────────────────────────────────────────────────

  async function run() {
    ui.btn.disabled = true;
    ui.stop.disabled = false;
    stopping = false;

    try {
      const key = writeKey();
      if (!key) { say('no write key set.', '#f87171'); return; }

      const guilds = guildList();
      if (!guilds.length) { say('no guilds configured — use “set guilds”.', '#f87171'); return; }

      // One read of our roster store tells us both who exists and who we already
      // hold scores for, so the skip decision costs nothing extra.
      say('reading rosters from the site…');
      const rosters = await siteRequest(
        'GET',
        `${siteUrl()}/guild?world=${encodeURIComponent(region())}&names=${encodeURIComponent(guilds.join(','))}`
      );

      let totalWanted = 0, totalPushed = 0, totalSkipped = 0;
      const problems = [];

      for (const guild of guilds) {
        if (stopping) break;

        const roster = rosters && rosters[guild];
        if (!Array.isArray(roster)) {
          problems.push(`${guild}: no roster stored`);
          continue;
        }

        const missing = roster.filter(needsFetch);
        totalSkipped += roster.length - missing.length;
        if (!missing.length) continue;

        const wanted = new Set(missing.map((m) => lc(m.nick)));
        totalWanted += missing.length;

        say(`${guild}: ${missing.length} to fetch (${roster.length - missing.length} already stored)…`);

        const out = {};
        const res = await fetchGuild(guild, wanted, out);
        if (res.error) problems.push(`${guild}: ${res.error}`);
        if (!stopping) await stagger();

        // Pass 2 for whoever the guild call didn't return. A failed guild call
        // (no `covered`) means nobody was covered, so everyone falls through —
        // unless we're stopping, in which case the loop below exits immediately.
        const leftovers = res.covered ? missing.filter((m) => !res.covered.has(lc(m.nick))) : missing;
        for (let i = 0; i < leftovers.length; i++) {
          if (stopping) break;
          const nick = leftovers[i].nick;
          say(`${guild}: looking up ${nick} (${i + 1}/${leftovers.length})…`);
          try {
            const entry = await fetchPlayer(nick);
            if (entry) out[nick] = entry;
          } catch (err) {
            problems.push(`${nick}: ${String(err.message || err)}`);
          }
          if (!stopping) await stagger();
        }

        const count = Object.keys(out).length;
        if (!count) continue;

        // Push per guild rather than once at the end: a stopped or failed run
        // keeps everything it already fetched, and the next run skips it.
        say(`${guild}: pushing ${count}…`);
        const posted = await siteRequest('POST', `${siteUrl()}/playerscores`, {
          token: key,
          body: { world: region(), guilds: { [guild]: out } },
        });
        const rec = (posted && posted.stored && posted.stored[0]) || {};
        totalPushed += rec.matched || 0;
        if (rec.error) problems.push(`${guild}: ${rec.error}`);
        if (rec.unmatched && rec.unmatched.length) {
          problems.push(`${guild}: ${rec.unmatched.length} nick(s) not on the roster`);
        }
      }

      const head = stopping
        ? `stopped — stored ${totalPushed} of ${totalWanted}.`
        : `done — stored ${totalPushed} of ${totalWanted} (${totalSkipped} already had scores).`;
      say(problems.length ? `${head}\n${problems.join('\n')}` : head,
          problems.length ? '#facc15' : '#4ade80');
    } catch (err) {
      const msg = String(err && err.message || err);
      say(msg === 'HTTP 401' ? 'unauthorized — check the write key.' : msg, '#f87171');
    } finally {
      ui.btn.disabled = false;
      ui.stop.disabled = true;
      stopping = false;
    }
  }

  function boot() {
    if (buildUI() === false) return;
    const guilds = guildList();
    say(guilds.length ? `ready — ${guilds.length} guild(s) configured.` : 'set guilds to begin.');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
