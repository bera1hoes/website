// ==UserScript==
// @name         MapleIdle — Performance vs. baseline
// @namespace    https://mapleidle.gg/
// @version      1.0.0
// @description  Adds "vs all classes" / "vs <class>" percentages (and the expected score) to every card in the Performance section of a MapleIdle character profile, using the same baseline fit the Score Analysis tool uses.
// @match        https://mapleidle.gg/characters/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

/*
 * How the numbers are derived (reverse-engineered from mapleidle.gg's own client bundle):
 *
 *   /tools/score-analysis server-renders an `analysis` prop into its RSC flight payload:
 *     analysis[cohort][mode] = { fitA, fitB, perClass: [{ job, residualPct, n, inBars }], snapshotDate }
 *   cohort is "fourth" (level >= 100) or "sub" (level < 100); mode is one of
 *   conquest | worldBoss | trainingGround | guildWar | guildBossBattle.
 *
 *   The pooled baseline is a log–log median fit, so:
 *     expectedField = exp(fitA + fitB * ln(cp))
 *     vsField%      = (score / expectedField - 1) * 100
 *     expectedClass = expectedField * (1 + residualPct/100)
 *     vsClass%      = ((1 + vsField/100) / (1 + residualPct/100) - 1) * 100
 *
 *   The CP that matters is the CP the score was *set* at, not the character's current CP.
 *   That pairing lives behind /api/score-analysis/character, which also returns job + level.
 */

(function () {
  'use strict';

  const ANALYSIS_URL = '/tools/score-analysis';
  const CACHE_KEY = 'mi_vs_analysis_v1';

  // The baseline fits move on mapleidle's snapshot cadence (roughly weekly), so
  // a day is plenty fresh. This cache is on disk (GM storage) and spans sessions.
  // The character cache below is deliberately un-TTL'd — it's in-memory, so it
  // already dies with the tab.
  const ANALYSIS_TTL_MS = 24 * 60 * 60 * 1000;

  // Card link path -> key inside the analysis / character payloads.
  const MODES = [
    ['/guild-conquest', 'conquest'],
    ['/world-boss', 'worldBoss'],
    ['/guild-training-ground', 'trainingGround'],
    ['/guild-war', 'guildWar'],
    ['/guild-boss-battle', 'guildBossBattle'],
  ];

  // ---------------------------------------------------------------- formatting

  // Port of mapleidle's formatCp(): two most-significant units, floored.
  const UNITS = [
    { label: 'AC', value: 1e21 },
    { label: 'AB', value: 1e18 },
    { label: 'AA', value: 1e15 },
    { label: 'T', value: 1e12 },
    { label: 'B', value: 1e9 },
    { label: 'M', value: 1e6 },
    { label: 'K', value: 1e3 },
    { label: '', value: 1 },
  ];

  function formatCp(n) {
    const v = Math.floor(Number(n));
    if (!Number.isFinite(v) || v < 0) return '-';
    const i = UNITS.findIndex((u) => v >= u.value);
    if (i === -1) return '0';
    const unit = UNITS[i];
    const head = Math.floor(v / unit.value);
    const next = UNITS[i + 1];
    if (!next) return `${head}${unit.label}`;
    const tail = Math.floor((v - head * unit.value) / next.value);
    return tail > 0 ? `${head}${unit.label} ${tail}${next.label}` : `${head}${unit.label}`;
  }

  // Port of mapleidle's formatCpShort(): single unit, one decimal below 10.
  // This is what the Score Analysis card uses for "CP at score" ("3.9AA").
  function formatCpShort(n) {
    const v = Math.floor(Number(n));
    if (!Number.isFinite(v) || v < 0) return '-';
    for (const unit of UNITS.slice(0, -1)) {
      if (v < unit.value) continue;
      const r = v / unit.value;
      return r >= 10 ? `${Math.round(r)}${unit.label}` : `${+r.toFixed(1)}${unit.label}`;
    }
    return String(v);
  }

  function pct(x) {
    return `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`;
  }

  function pluralizeJob(job) {
    if (job === 'Hero') return 'Heroes';
    if (job.endsWith('man')) return `${job.slice(0, -3)}men`;
    return `${job}s`;
  }

  // ------------------------------------------------------------------ storage

  const store = {
    get(key) {
      try {
        if (typeof GM_getValue === 'function') return GM_getValue(key, null);
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    },
    set(key, value) {
      try {
        if (typeof GM_setValue === 'function') GM_setValue(key, value);
        else localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        /* quota / disabled storage — just skip caching */
      }
    },
  };

  // ------------------------------------------------------- analysis extraction

  // The page ships its RSC payload as a series of self.__next_f.push([1,"<escaped>"])
  // calls; concatenating them in order rebuilds the flight text.
  function flightText(html) {
    const re = /self\.__next_f\.push\(\[\s*1\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\)/g;
    let out = '';
    let m;
    while ((m = re.exec(html))) {
      try {
        out += JSON.parse(m[1]);
      } catch (e) {
        /* not a plain string chunk — skip */
      }
    }
    return out;
  }

  function sliceObject(s, start) {
    let depth = 0;
    let inStr = false;
    let esc = false;
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

  async function fetchAnalysis() {
    const res = await fetch(ANALYSIS_URL, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`score-analysis ${res.status}`);
    const text = flightText(await res.text());
    const at = text.indexOf('"analysis":{');
    if (at === -1) throw new Error('analysis payload not found');
    const raw = sliceObject(text, text.indexOf('{', at + 11));
    if (!raw) throw new Error('analysis payload truncated');
    const analysis = JSON.parse(raw);

    // Drop the scatter samples — they are ~300 KB and we never use them.
    for (const cohort of Object.values(analysis)) {
      for (const mode of Object.values(cohort)) delete mode.sampledPoints;
    }
    return analysis;
  }

  async function getAnalysis() {
    const cached = store.get(CACHE_KEY);
    if (cached && Date.now() - cached.at < ANALYSIS_TTL_MS && cached.data) return cached.data;
    const data = await fetchAnalysis();
    store.set(CACHE_KEY, { at: Date.now(), data });
    return data;
  }

  // ------------------------------------------------------------ character data

  const charCache = new Map();

  // No TTL: this Map lives and dies with the tab, and a character's snapshot
  // can't change underneath a single session. The promise (not the result) is
  // cached so two cards resolving at once share one request. A *rejected*
  // promise is therefore sticky for the session too — handled by halting and
  // telling the user, rather than silently replaying the failure (see run()).
  function getCharacter({ region, world, name }) {
    const key = `${region}:${world}:${name}`;
    if (!charCache.has(key)) {
      const url =
        `/api/score-analysis/character?region=${encodeURIComponent(region)}` +
        `&world=${encodeURIComponent(world)}&name=${encodeURIComponent(name)}`;
      charCache.set(
        key,
        fetch(url, { credentials: 'same-origin' }).then((r) => {
          if (!r.ok) throw new Error(`character ${r.status}`);
          return r.json();
        })
      );
    }
    return charCache.get(key);
  }

  // ------------------------------------------------------------------- the math

  function compare(fit, cp, score, job) {
    if (!(cp > 0) || !(score > 0)) return null;
    const logExpected = fit.fitA + fit.fitB * Math.log(cp);
    const expectedField = Math.exp(logExpected);
    const vsField = (Math.exp(Math.log(score) - logExpected) - 1) * 100;
    const cls = fit.perClass.find((c) => c.job === job);
    return {
      vsField,
      expectedField,
      vsClass: cls ? ((1 + vsField / 100) / (1 + cls.residualPct / 100) - 1) * 100 : null,
      expectedClass: cls ? expectedField * (1 + cls.residualPct / 100) : null,
      cls: cls || null,
    };
  }

  // ------------------------------------------------------------------- the DOM

  function injectStyle() {
    if (document.getElementById('mi-vs-style')) return;
    const style = document.createElement('style');
    style.id = 'mi-vs-style';
    style.textContent = `
      .mi-vs {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 0.5rem 0.75rem;
        margin-top: 0.85rem;
        padding-top: 0.75rem;
        border-top: 1px solid currentColor;
        border-top-color: color-mix(in srgb, currentColor 14%, transparent);
      }
      .mi-vs-label {
        display: block;
        font-size: 10px;
        font-weight: 500;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        opacity: 0.62;
      }
      /* Full-width row above the two vs columns. */
      .mi-vs-cp {
        grid-column: 1 / -1;
        display: flex;
        align-items: baseline;
        gap: 0.45rem;
      }
      .mi-vs-cp-val {
        font-size: 0.8rem;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: var(--stat-cp, currentColor);
      }
      .mi-vs-pct {
        display: block;
        margin-top: 0.1rem;
        font-size: 0.95rem;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      .mi-vs-exp {
        display: block;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        opacity: 0.62;
      }
      .mi-vs-pos { color: #059669; }
      .mi-vs-neg { color: #e11d48; }
      html.dark .mi-vs-pos { color: #34d399; }
      html.dark .mi-vs-neg { color: #fb7185; }
      .mi-vs-error {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        max-width: 320px;
        padding: 12px 34px 12px 14px;
        border-radius: 10px;
        border: 1px solid #e11d48;
        background: #fff1f2;
        color: #881337;
        font: 12px/1.5 ui-sans-serif, system-ui, sans-serif;
        box-shadow: 0 8px 24px rgba(0,0,0,0.18);
      }
      html.dark .mi-vs-error { background: #1f1114; color: #fecdd3; border-color: #9f1239; }
      .mi-vs-error b { display: block; margin-bottom: 3px; }
      .mi-vs-error code { font-family: ui-monospace, monospace; opacity: 0.8; overflow-wrap: anywhere; }
      .mi-vs-error button {
        position: absolute;
        top: 6px;
        right: 8px;
        border: 0;
        background: none;
        color: inherit;
        font-size: 15px;
        line-height: 1;
        cursor: pointer;
        opacity: 0.7;
      }
      .mi-vs-error button:hover { opacity: 1; }
    `;
    document.head.appendChild(style);
  }

  // Surface a failure instead of dying quietly in the console. Idempotent — the
  // MutationObserver fires constantly, and only one notice should ever exist.
  function notify(reason) {
    injectStyle();
    if (document.getElementById('mi-vs-error')) return;

    const box = document.createElement('div');
    box.className = 'mi-vs-error';
    box.id = 'mi-vs-error';

    const head = document.createElement('b');
    head.textContent = 'Performance vs. baseline — stopped';

    const msg = document.createElement('span');
    msg.textContent =
      "Couldn't load the comparison data, so the vs-baseline figures are missing " +
      'from this page. Reload to try again; if it keeps happening, disable the ' +
      '"MapleIdle — Performance vs. baseline" userscript in Tampermonkey — the ' +
      'site itself works fine without it. ';

    const code = document.createElement('code');
    code.textContent = '(' + reason + ')';

    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss');
    close.addEventListener('click', () => box.remove());

    box.append(close, head, msg, code);
    document.body.appendChild(box);
  }

  function column(label, value, expected) {
    const col = document.createElement('div');

    const l = document.createElement('span');
    l.className = 'mi-vs-label';
    l.textContent = label;

    const p = document.createElement('span');
    p.className = `mi-vs-pct ${value >= 0 ? 'mi-vs-pos' : 'mi-vs-neg'}`;
    p.textContent = pct(value);

    const e = document.createElement('span');
    e.className = 'mi-vs-exp';
    e.textContent = `expected ${formatCp(expected)}`;

    col.append(l, p, e);
    return col;
  }

  function render(contentEl, cmp, char, mode, fit) {
    const block = document.createElement('div');
    block.className = 'mi-vs';
    block.dataset.miVs = mode;

    const modeData = char[mode];
    block.title =
      `CP at score ${formatCp(modeData.cp)} · snapshot ${modeData.snapshotDate}\n` +
      `baseline = e^${fit.fitA.toFixed(2)} · CP^${fit.fitB.toFixed(2)}` +
      (cmp.cls
        ? `\n${char.job} median gap ${pct(cmp.cls.residualPct)} (n=${cmp.cls.n}` +
          `${cmp.cls.inBars === false ? ', low sample' : ''})`
        : '');

    const cpRow = document.createElement('div');
    cpRow.className = 'mi-vs-cp';
    const cpLabel = document.createElement('span');
    cpLabel.className = 'mi-vs-label';
    cpLabel.textContent = 'CP at score';
    const cpValue = document.createElement('span');
    cpValue.className = 'mi-vs-cp-val';
    cpValue.textContent = formatCpShort(modeData.cp);
    cpRow.append(cpLabel, cpValue);
    block.appendChild(cpRow);

    block.appendChild(column('vs all classes', cmp.vsField, cmp.expectedField));
    if (cmp.vsClass != null) {
      block.appendChild(column(`vs ${pluralizeJob(char.job)}`, cmp.vsClass, cmp.expectedClass));
    }

    contentEl.appendChild(block);
  }

  // ----------------------------------------------------------------- the driver

  const MODE_BY_PATH = new Map(MODES);

  function findCards() {
    const found = [];
    for (const link of document.querySelectorAll('a[href*="?server="]')) {
      const mode = MODE_BY_PATH.get(new URL(link.getAttribute('href'), location.origin).pathname);
      if (!mode) continue;
      const content = link.querySelector('[data-slot="card-content"]');
      if (content && !content.querySelector('[data-mi-vs]')) found.push({ mode, content, link });
    }
    return found;
  }

  function identity(link) {
    const url = new URL(link.getAttribute('href'), location.origin);
    const server = url.searchParams.get('server') || '';
    const name = url.searchParams.get('search');
    const dash = server.lastIndexOf('-');
    if (dash === -1 || !name) return null;
    return { region: server.slice(0, dash), world: server.slice(dash + 1), name };
  }

  let running = false;
  // Set once a fetch has failed. Both caches hold the rejected promise for the
  // rest of the session, so retrying would replay the same failure on every DOM
  // mutation — thousands of times as you browse. Stand down instead, and let
  // notify() tell the user (a reload is the only real retry).
  let halted = false;

  async function run() {
    if (running || halted) return;
    if (!/^\/characters\/[^/]+\/[^/]+/.test(location.pathname)) return;

    const cards = findCards();
    if (!cards.length) return;

    const who = identity(cards[0].link);
    if (!who) return;

    running = true;
    try {
      const [analysis, char] = await Promise.all([getAnalysis(), getCharacter(who)]);
      const cohort = char.level >= 100 ? 'fourth' : 'sub';
      injectStyle();

      for (const { mode, content } of findCards()) {
        const fit = analysis[cohort] && analysis[cohort][mode];
        const best = char[mode];
        if (!fit || !best) continue;
        const cmp = compare(fit, best.cp, best.score, char.job);
        if (cmp) render(content, cmp, char, mode, fit);
      }
    } catch (err) {
      console.warn('[mapleidle-vs]', err);
      halted = true;
      notify(String((err && err.message) || err));
    } finally {
      running = false;
    }
  }

  // The profile is a Next.js app-router page: cards arrive after hydration and
  // are re-rendered on client-side navigation, so watch instead of running once.
  let queued = null;
  const schedule = () => {
    clearTimeout(queued);
    queued = setTimeout(run, 120);
  };

  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  schedule();
})();
