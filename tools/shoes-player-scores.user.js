// ==UserScript==
// @name         (s)hoes — pull mapleidle player scores
// @namespace    https://hoes.fyi/
// @version      2.3.0
// @description  From the (s)hoes charts page: find the absentees Win Prediction has no history for, fetch their best scores off mapleidle, store them, and re-run the projection.
// @author       bera1hoes
// Cloudflare's asset binding 307s /charts to the canonical asset path /Charts, so
// the browser always ends up on the CAPITALISED url. Match patterns are
// case-sensitive on the path, so the lowercase one alone never fires — both are
// listed because the lowercase link on the landing page is what people click.
// @match        https://hoes.fyi/Charts*
// @match        https://hoes.fyi/charts*
// @match        https://website.bera1hoes.workers.dev/Charts*
// @match        https://website.bera1hoes.workers.dev/charts*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      mapleidle.gg
// ==/UserScript==

// v2 runs on OUR page instead of mapleidle's. The point isn't convenience — it's
// that the page already knows the answer to "who needs fetching?". It has the
// sheet's roster snapshot, who actually posted a score, and both per-player
// history maps. So instead of a hand-maintained guild list and a blanket "anyone
// without scores", the target set is computed: absentees, in this sheet's guilds,
// that prediction would otherwise project raw. That is usually a handful of
// players rather than a whole roster.
//
// It also closes its own loop — after storing, it calls the page's refreshRosters()
// and runPrediction(), so the numbers update in front of you.
//
// Why this still has to be a userscript: mapleidle's API sends no CORS headers, so
// a plain fetch from hoes.fyi is blocked. The *server* answers fine — verified: the
// same request with CORS enforcement off returns 200 with the full member list —
// it's purely a missing response header. GM_xmlhttpRequest is exempt from CORS
// (@connect mapleidle.gg), which is the one capability a page can't have on its own.
//
// Our own endpoints are same-origin now, so they use a plain fetch.

(function () {
  'use strict';

  const DEFAULT_REGION = 'bera';
  const DELAY_MS = 3000;      // stagger between mapleidle requests
  const JITTER_MS = 2000;
  const STALE_DAYS = 14;      // refetch a stored block older than this

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stagger = () => sleep(DELAY_MS + Math.random() * JITTER_MS);
  const lc = (s) => String(s || '').toLowerCase();

  let stopping = false;
  let running = false;
  let collapsed = GM_getValue('collapsed', false) === true;

  // ── Page bridge ───────────────────────────────────────────────────────────
  // window.shoesChart is the read-only surface public/js/bridge.js exposes. The
  // chart's state is in script-scope `let`s that never reach `window`, so this
  // is the supported way in.
  const chart = () => (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).shoesChart;

  // ── Transport ─────────────────────────────────────────────────────────────

  // mapleidle: CORS-exempt, so it must go through the extension.
  function mapleidle(path) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: 'https://mapleidle.gg' + path,
        headers: { Accept: 'application/json' },
        timeout: 30000,
        onload: (res) => {
          // A 429 is the exact thing the stagger exists to avoid. Halt rather
          // than press on — the per-player pass would otherwise hammer the same
          // limiter twice per member. Whatever was already pushed stays stored.
          if (res.status === 429) {
            stopping = true;
            reject(new Error('rate-limited (429) — stopped; wait a while before resuming'));
            return;
          }
          if (res.status < 200 || res.status >= 300) { reject(new Error(`mapleidle ${res.status}`)); return; }
          try { resolve(JSON.parse(res.responseText)); }
          catch (e) { reject(new Error('mapleidle sent non-JSON')); }
        },
        onerror: () => reject(new Error('network error reaching mapleidle')),
        ontimeout: () => reject(new Error('mapleidle timed out')),
      });
    });
  }

  // Our own site — same origin from here, so no GM needed.
  async function push(body, key) {
    const res = await fetch('/playerscores', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error((json && json.error) || `HTTP ${res.status}`);
    return json;
  }

  const region = () => lc(GM_getValue('region', DEFAULT_REGION)) || DEFAULT_REGION;

  function writeKey({ force } = {}) {
    let key = GM_getValue('writeKey', '');
    if (!key || force) {
      key = (window.prompt('CHART_WRITE_KEY', key || '') || '').trim();
      if (key) GM_setValue('writeKey', key);
    }
    return key;
  }

  // ── Target selection ──────────────────────────────────────────────────────

  const MODES = ['guildWar', 'guildBossBattle', 'conquest', 'trainingGround'];

  function daysSince(iso) {
    const t = Date.parse(iso);
    return isFinite(t) ? (Date.now() - t) / (24 * 60 * 60 * 1000) : Infinity;
  }

  // The whole reason for running here: everyone prediction would project RAW.
  // A member qualifies when prediction projects them (absent from the run AND in
  // the guild that week — `absentees` from the page, which knows who joined after
  // or had left before), we hold no history factor for them under either adjust
  // mode, and we have no fresh mapleidle block either.
  function findTargets() {
    const c = chart();
    if (!c) return { error: 'page bridge missing — is the site up to date?' };
    if (!c.miMode) return { error: `${c.contentType} has no mapleidle counterpart.` };
    // No rosters at all is not a dead end any more — every guild in the run is
    // then a "no roster" guild, and each one can be built from mapleidle.
    const rosters = c.rosters || {};
    if (!Object.keys(rosters).length && !(c.guilds || []).length) {
      return { error: 'no sheet loaded yet.' };
    }

    const played = new Set(c.participants.map(lc));
    // Who prediction projects, per guild. An older page without it falls back to
    // "everyone absent", which also fetches joiners-after and leavers-before.
    const counted = c.absentees ? new Set(Object.entries(c.absentees)
      .flatMap(([g, nicks]) => nicks.map((n) => g + '\n' + lc(n)))) : null;
    const perf = c.perf || {};
    const lastWk = c.lastWeekPerf || {};
    const byGuild = {};
    const guilds = [];
    let members = 0, absent = 0, notMember = 0, haveHistory = 0, haveScores = 0;

    for (const [guild, roster] of Object.entries(rosters)) {
      if (!Array.isArray(roster) || !roster.length) continue;
      guilds.push(guild);
      members += roster.length;
      for (const m of roster) {
        if (!m || !m.nick || played.has(lc(m.nick))) continue;
        if (counted && !counted.has(guild + '\n' + lc(m.nick))) { notMember++; continue; }
        absent++;
        if (perf[m.nick] != null || lastWk[m.nick] != null) { haveHistory++; continue; }
        if (m.mi && m.mi.modes && daysSince(m.mi.fetchedAt) <= STALE_DAYS) { haveScores++; continue; }
        (byGuild[guild] = byGuild[guild] || []).push(m.nick);
      }
    }

    // Guilds in the run that we hold no roster for. Prediction can't project a
    // single absentee for them today, so they're worth a call even though we
    // can't say in advance who's on them — mapleidle's member list becomes the
    // roster (see `missing` handling in run()).
    const missing = (c.guilds || []).filter((g) => !rosters[g]);

    const total = Object.values(byGuild).reduce((s, a) => s + a.length, 0);
    // `guilds` drives the run, not `byGuild`: every guild gets its one call so
    // CP is refreshed even where no scores are needed.
    return { guilds, missing, byGuild, total, members, absent, notMember, haveHistory, haveScores };
  }

  // Whether we already know how a player performs, so their scores aren't worth
  // fetching. Used for guilds we have no roster for, where the target list can't
  // be worked out until mapleidle tells us who is on them.
  function knowsPlayer(nick) {
    const c = chart();
    const perf = c.perf || {};
    const lastWk = c.lastWeekPerf || {};
    return perf[nick] != null || lastWk[nick] != null;
  }

  // ── Shaping ───────────────────────────────────────────────────────────────
  // The guild route nests the per-mode records under `best`; the character route
  // hangs them off the top level. Same records either way.
  function entryFrom(src, modeSrc) {
    const modes = {};
    let any = false;
    for (const key of MODES) {
      const m = modeSrc && modeSrc[key];
      if (!m || typeof m !== 'object') continue;
      const score = Number(m.score), cp = Number(m.cp);
      if (!(score > 0) || !(cp > 0)) continue;
      modes[key] = { score, cp, snapshotDate: m.snapshotDate };
      any = true;
    }
    if (!any) return null;
    return { job: src.job || '', level: Number(src.level) || 0, modes };
  }

  // ── Passes ────────────────────────────────────────────────────────────────

  // One request covers a whole guild — and it returns each member's CURRENT cp,
  // not just their best scores. Roster CP otherwise only moves when SwissKnife
  // re-captures a guild, so a guild nobody has captured lately drifts badly (we
  // found one 5-8x low, which under-projects every absentee in it). So: scores for
  // the members that need them, CP for *everyone* the response covers. Same one
  // request either way, so the extra freshness is free.
  // `wants(nick)` rather than a Set: for a guild we hold no roster for we can't
  // name the targets until this response tells us who is on it. `known` is our
  // roster's nicks (null when we're building the roster from this response, so
  // everyone counts as known).
  //
  // Returns `live`, the guild's CURRENT membership. That set is the authoritative
  // answer to who is still in the guild, and the caller uses it to tell an absentee
  // apart from an ex-member.
  async function fetchGuild(guild, wants, out, known) {
    const data = await mapleidle(
      `/api/score-analysis/guild?region=${encodeURIComponent(region())}&name=${encodeURIComponent(guild)}`);
    const covered = new Set();
    const live = new Set();
    const joined = [];
    for (const m of (data && data.members) || []) {
      const nick = String((m && m.name) || '').trim();
      if (!nick) continue;
      live.add(lc(nick));

      // On mapleidle but not on our roster: they joined since the last capture.
      // Nothing to attach them to, and inventing a member would skip the join
      // dating prediction relies on — so report, don't write.
      if (known && !known.has(lc(nick))) { joined.push(nick); continue; }

      const cp = Number(m.cp) || 0;
      const entry = wants(nick) ? entryFrom(m, m.best) : null;
      if (entry) {
        entry.cp = cp;
        out[nick] = entry;
        covered.add(lc(nick));
      } else if (cp > 0) {
        // No scores wanted (or none usable) — still worth their current CP.
        out[nick] = { cp, level: Number(m.level) || 0, job: m.job || '' };
      }
    }
    return { covered, live, joined };
  }

  // Two requests per player: search resolves the worldId (the character route
  // 404s without it), then the character route itself.
  async function fetchPlayer(nick) {
    const found = await mapleidle(`/api/search?q=${encodeURIComponent(nick)}`);
    const cands = (found && found.characters) || [];
    const hit = cands.find((c) => lc(c.name) === lc(nick) && lc(c.region) === region())
             || cands.find((c) => lc(c.name) === lc(nick));
    if (!hit) return null;

    await stagger();
    if (stopping) return null;

    const data = await mapleidle(
      `/api/score-analysis/character?region=${encodeURIComponent(hit.region)}` +
      `&world=${encodeURIComponent(hit.worldId)}&name=${encodeURIComponent(hit.name)}`);
    if (!data || data.error) return null;
    return entryFrom(data, data);
  }

  // ── UI ────────────────────────────────────────────────────────────────────

  const ui = {};

  function buildUI() {
    if (document.getElementById('shoes-ps')) return false;
    const box = document.createElement('div');
    box.id = 'shoes-ps';
    box.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'background:#12151c', 'color:#e8eaf0', 'border:1px solid rgba(240,165,0,0.45)',
      'border-radius:12px', 'padding:10px 12px',
      'font:12px/1.5 ui-sans-serif,system-ui,sans-serif', 'box-shadow:0 8px 24px rgba(0,0,0,0.5)',
    ].join(';');

    // Header doubles as the collapse control — the panel sits over the bottom-right
    // of the tables, so it needs to get out of the way.
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none';
    header.title = 'Click to minimize / restore';

    const title = document.createElement('div');
    title.textContent = '(s)hoes · player scores';
    title.style.cssText = 'font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#f0a500;flex:1;white-space:nowrap';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.style.cssText = 'border:0;background:none;color:#f0a500;font:inherit;font-size:14px;line-height:1;cursor:pointer;padding:0 2px';
    header.append(title, toggle);
    header.addEventListener('click', () => setCollapsed(!collapsed));

    // Everything below the header collapses as one unit.
    const body = document.createElement('div');
    body.style.cssText = 'margin-top:8px;width:290px';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Refresh CP + fetch scores';
    btn.style.cssText = 'width:100%;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:#1a1f2e;color:#e8eaf0;font:inherit;cursor:pointer';
    btn.addEventListener('click', () => run());

    const stop = document.createElement('button');
    stop.type = 'button';
    stop.textContent = 'Stop';
    stop.disabled = true;
    stop.style.cssText = 'width:100%;margin-top:6px;padding:6px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.10);background:#1a1f2e;color:#8b919e;font:inherit;cursor:pointer';
    stop.addEventListener('click', () => { stopping = true; say('stopping after this request…'); });

    const status = document.createElement('div');
    status.id = 'shoes-ps-status';
    status.style.cssText = 'margin-top:8px;min-height:16px;color:#8b919e;font-family:ui-monospace,monospace;font-size:11px;white-space:pre-wrap';

    const cfg = document.createElement('a');
    cfg.href = '#';
    cfg.textContent = 'set key / region';
    cfg.style.cssText = 'display:inline-block;margin-top:6px;color:#6b7280;font-size:10px;text-decoration:underline;cursor:pointer';
    cfg.addEventListener('click', (e) => {
      e.preventDefault();
      const reg = (window.prompt('Region', region()) || '').trim();
      if (reg) GM_setValue('region', lc(reg));
      writeKey({ force: true });
      say('saved.', '#4ade80');
    });

    const rescan = document.createElement('a');
    rescan.href = '#';
    rescan.textContent = 'rescan';
    rescan.style.cssText = 'display:inline-block;margin:6px 0 0 10px;color:#6b7280;font-size:10px;text-decoration:underline;cursor:pointer';
    rescan.addEventListener('click', (e) => { e.preventDefault(); summarize(); });

    body.append(btn, stop, status, cfg, rescan);
    box.append(header, body);
    document.body.appendChild(box);
    ui.box = box; ui.body = body; ui.title = title; ui.toggle = toggle;
    ui.btn = btn; ui.stop = stop; ui.status = status;
    applyCollapsed();
    return true;
  }

  // ── Collapse ──────────────────────────────────────────────────────────────
  // Persisted, so it stays out of the way across reloads.

  function applyCollapsed() {
    ui.body.style.display = collapsed ? 'none' : '';
    ui.toggle.textContent = collapsed ? '+' : '−';
    ui.toggle.title = collapsed ? 'Restore' : 'Minimize';
    // While minimized the status line is hidden, so the title carries the fact
    // that something is still running — otherwise a long fetch looks stalled.
    ui.title.textContent = '(s)hoes · player scores' + (collapsed && running ? ' · running…' : '');
  }

  function setCollapsed(next) {
    collapsed = next;
    try { GM_setValue('collapsed', collapsed); } catch (e) { /* storage disabled */ }
    applyCollapsed();
  }

  function say(msg, color) {
    ui.status.textContent = msg;
    ui.status.style.color = color || '#8b919e';
  }

  function summarize() {
    const t = findTargets();
    if (t.error) { say(t.error, '#facc15'); return null; }
    const miss = t.missing.length ? `  +${t.missing.length} with no roster: ${t.missing.join(', ')}` : '';
    const notIn = t.notMember ? `, ${t.notMember} absent but not in the guild that week` : '';
    say(`${t.guilds.length} guild(s), ${t.members} members — CP refresh for all, ` +
        `scores for ${t.total} (${t.absent} projected absentees${notIn}, ${t.haveHistory} have history, ` +
        `${t.haveScores} stored).${miss}`);
    return t;
  }

  // ── Run ───────────────────────────────────────────────────────────────────

  async function run() {
    ui.btn.disabled = true;
    ui.stop.disabled = false;
    stopping = false;
    running = true;
    applyCollapsed();   // surface "running…" if the panel is minimized
    try {
      const key = writeKey();
      if (!key) { say('no write key set.', '#f87171'); return; }

      // Last-week factors are only built once a prediction has run; build them
      // first so we don't fetch players we can already tune from our own data.
      try { await chart().buildLastWeekPerf(); } catch (e) { /* optional */ }

      const t = summarize();
      if (!t || (!t.guilds.length && !t.missing.length)) return;

      let pushed = 0, refreshed = 0, marked = 0;
      const problems = [];
      const createdGuilds = [];
      const leftGuild = [];    // on our roster, gone from mapleidle
      const newMembers = [];   // on mapleidle, not on our roster
      const rosters = chart().rosters || {};

      // Every guild gets its one call — the response carries current CP for the
      // whole roster, which is worth having even when no scores are missing. The
      // roster-less ones come last, and their payload is flagged `complete` so the
      // worker may build a roster from it.
      const order = [...t.guilds, ...t.missing];
      for (const guild of order) {
        if (stopping) break;
        const isNew = t.missing.includes(guild);
        const nicks = t.byGuild[guild] || [];
        const wanted = new Set(nicks.map(lc));
        // Known guild: exactly the members we picked out. New guild: we don't know
        // who's on it, so take scores for anyone we have no history for.
        const wants = isNew ? (n) => !knowsPlayer(n) : (n) => wanted.has(lc(n));
        const out = {};

        say(isNew ? `${guild}: no roster — building one…`
                  : `${guild}: CP refresh${nicks.length ? ` + ${nicks.length} score(s)` : ''}…`);
        let covered = new Set();
        let live = null;        // null = the guild call failed, so we know nothing
        let joinedNicks = [];
        try {
          const known = isNew ? null : new Set((rosters[guild] || []).map((m) => lc(m.nick)));
          ({ covered, live, joined: joinedNicks } = await fetchGuild(guild, wants, out, known));
        } catch (err) {
          problems.push(`${guild}: ${String(err.message || err)}`);
        }
        if (!stopping) await stagger();

        // A successful guild call is the authoritative current membership, so a
        // wanted nick it didn't return has LEFT the guild. Chasing them per-player
        // costs two requests to fetch scores for someone who isn't in the guild —
        // and the character route holds the same records the guild route already
        // gave us, so it could not add anything even for a member who IS present.
        // Per-player is therefore only a fallback for when the guild call failed.
        let leftovers = [];
        let goneNicks = [];
        if (live) {
          // Against the WHOLE roster, not just the score-targets: someone who left
          // is on our roster whether or not we wanted their scores, and prediction
          // projects them either way — until they're marked gone (see push below).
          const roster = rosters[guild] || [];
          const gone = roster.map((m) => m.nick).filter((n) => !live.has(lc(n)));
          // Only trust the list as a departure signal when it plausibly IS this
          // guild's — an empty or mostly-disjoint response (a renamed guild, an API
          // hiccup) would otherwise mark the whole roster gone.
          const kept = roster.length - gone.length;
          if (gone.length && kept * 2 >= roster.length) {
            goneNicks = gone;
            leftGuild.push(`${guild}: ${gone.join(', ')}`);
          } else if (gone.length) {
            problems.push(`${guild}: mapleidle lists only ${kept}/${roster.length} of our roster — ` +
                          `skipped marking departures`);
          }
          if (joinedNicks && joinedNicks.length) newMembers.push(`${guild}: ${joinedNicks.join(', ')}`);
        } else {
          leftovers = nicks.filter((n) => !covered.has(lc(n)));
        }

        for (let i = 0; i < leftovers.length; i++) {
          if (stopping) break;
          say(`${guild}: ${leftovers[i]} (${i + 1}/${leftovers.length})…`);
          try {
            const entry = await fetchPlayer(leftovers[i]);
            if (entry) out[leftovers[i]] = entry;
          } catch (err) {
            problems.push(`${leftovers[i]}: ${String(err.message || err)}`);
          }
          if (!stopping) await stagger();
        }

        const n = Object.keys(out).length;
        if (!n && !goneNicks.length) continue;
        // Push per guild so a stopped run keeps what it already fetched. `complete`
        // is only set for a guild whose whole member list came back in one call —
        // never for a per-player top-up, which would invent a tiny roster. `gone`
        // stamps the departures with today's week, so prediction stops projecting
        // them for this week on (it can't say when they left — only that they had).
        say(`${guild}: storing ${n}${goneNicks.length ? `, ${goneNicks.length} departed` : ''}…`);
        const body = { world: region(), guilds: { [guild]: out } };
        if (isNew && covered.size + Object.keys(out).length > 0) body.complete = [guild];
        if (goneNicks.length) body.gone = { [guild]: goneNicks };
        const res = await push(body, key);
        const rec = (res && res.stored && res.stored[0]) || {};
        if (rec.created) createdGuilds.push(`${guild} (${rec.members})`);
        pushed += rec.matched || 0;
        refreshed += rec.refreshed || 0;
        marked += rec.gone || 0;
        if (rec.error) problems.push(`${guild}: ${rec.error}`);
        if (rec.unmatched && rec.unmatched.length) {
          problems.push(`${guild}: ${rec.unmatched.length} nick(s) not on the stored roster`);
        }
      }

      if (!pushed && !refreshed && !marked && !createdGuilds.length) {
        say(problems.length ? problems.join('\n') : 'nothing changed — already up to date.',
            problems.length ? '#facc15' : '#4ade80');
        return;
      }

      // Close the loop: pull the fresh CP + scores into this sheet's snapshot and
      // re-project, so the numbers move in front of you. refreshRosters resolves
      // once the new snapshot is in (older pages returned nothing, so the re-run
      // there still projects from the old snapshot until you predict again).
      say('storing — refreshing…');
      await chart().refreshRosters();
      chart().runPrediction();
      const parts = [];
      if (pushed) parts.push(`${pushed} score(s)${t.total ? ` of ${t.total}` : ''}`);
      if (refreshed) parts.push(`${refreshed} CP updated`);
      if (marked) parts.push(`${marked} marked gone`);
      if (createdGuilds.length) parts.push(`built rosters for ${createdGuilds.join(', ')}`);
      const head = `${stopping ? 'stopped' : 'done'} — ${parts.join(', ')}, projection refreshed.`;

      // Roster drift is worth saying out loud. Departures are handled here — they're
      // stamped `gone`, so prediction stops projecting them from this week on — but
      // this script never ADDS members: mapleidle's guild response carries no join
      // dates, and prediction needs those to tell "was in the guild that week" from
      // "joined since". Joiners, and join dates for a roster built here, only come
      // from a capture of the guild page (the roster userscript or SwissKnife),
      // whose Member Changes card dates every join and leave.
      const drift = [];
      if (leftGuild.length) drift.push('left the guild (marked gone) — ' + leftGuild.join(' · '));
      if (newMembers.length) drift.push('joined since our capture — ' + newMembers.join(' · '));
      if (newMembers.length || createdGuilds.length) {
        drift.push('capture the guild page (roster userscript / SwissKnife) to add joiners with join dates.');
      }

      const tail = [...problems, ...drift];
      say(tail.length ? `${head}\n${tail.join('\n')}` : head,
          problems.length ? '#facc15' : (drift.length ? '#facc15' : '#4ade80'));
    } catch (err) {
      const msg = String((err && err.message) || err);
      say(msg === 'HTTP 401' ? 'unauthorized — check the write key.' : msg, '#f87171');
    } finally {
      ui.btn.disabled = false;
      ui.stop.disabled = true;
      stopping = false;
      running = false;
      applyCollapsed();
    }
  }

  // The chart boots asynchronously, so wait for a sheet before scanning.
  function boot() {
    if (!buildUI()) return;
    say('waiting for the chart…');
    const started = Date.now();
    const tick = setInterval(() => {
      const c = chart();
      if (c && c.rosters) { clearInterval(tick); summarize(); }
      else if (Date.now() - started > 30000) { clearInterval(tick); say('no sheet loaded yet — hit rescan.'); }
    }, 500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

