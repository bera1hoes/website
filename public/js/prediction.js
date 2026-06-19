// ── Win prediction ──────────────────────────────────────────────────────────
// Rosters are captured from mapleidle.gg by the SwissKnife mitmproxy addon and
// stored per-guild in KV (ROSTERS). When a sheet's data entry is created, a
// snapshot of its guilds' rosters is embedded into the chart data and rides along
// in the getData response as `sheetRosters` (data.js) — so prediction needs NO
// extra KV/network call. We find members missing from the content run, project
// their score from the live power-law fit (Score ≈ A·CP^B), and aggregate a
// projected per-guild total.
//
// Each missing member's projection can be tuned three ways (see projectMember):
//   • a per-player performance factor from history ("adjust by" Last week / History)
//   • a class-bias factor (the global class-adjust checkbox), as a fallback
//   • a manual % override (persisted in localStorage), which stacks on top.
//
// Metric per content type (mirrors buildPivotTable): GW Points for Guild Wars
// (rank-based via GW_POINTS_DATA), total Score for everything else. The per-player
// "Projected absentees" table (#missing-players-section) always shows raw projected
// scores.
//
// `Refresh rosters` (refreshRosters) re-pulls the roster snapshot from ROSTERS, and
// `buildPerfProfile` (auto-triggered for History mode) embeds the recency-weighted
// performance profile into the sheet — both write the chart-data entry on demand.

// Content types that support history adjustment (mirror PERF_TYPES in worker.js).
const PREDICTION_PERF_TYPES = ['Guild Wars', 'Guild Boss Battle', 'Guild Training Ground'];

// 'none' | 'lastweek' | 'history' — how missing members' projections are tuned.
let adjustMode = 'none';
// Client-built { nick -> factor } for Last-week mode (from the previous sheet that
// history.js already loads); rebuilt per sheet. History mode uses sheetPerf (data.js).
let lastWeekPerf = null;
let lastWeekFor = null;   // "contentType sheet" the lastWeekPerf was built for

// The last computed prediction inputs, kept so overrides / mode / toggle changes
// can re-render without recomputing the missing-member diff.
let lastPrediction = null;       // { guilds, missingByGuild, isGW }
let missingFlat = [];            // flattened missing rows backing the override inputs
let missingSortCol = 'final';    // absentees-table sort (like the player table)
let missingSortDir = 'desc';
let projAbsentGwPoints = {};     // nick -> projected GW points for absent members (GW only)

// A participant flagged as a likely sandbagger when this week's performance is at
// least this fraction below their historical norm (see annotateSandbag).
const SANDBAG_THRESHOLD = 0.20;  // 20% below history

// ── Manual per-player overrides (persisted) ──────────────────────────────────
// { "<nick>": <pct> } in localStorage, keyed by nick globally (a player's tendency
// is intrinsic, so it carries across sheets/content types). A +20 means "expect 20%
// above the projection"; it stacks on whatever base/factor is in effect.
const WP_OVERRIDE_KEY = 'wp_overrides';
let overrides = loadOverrides();

function loadOverrides() {
  try { return JSON.parse(localStorage.getItem(WP_OVERRIDE_KEY)) || {}; }
  catch { return {}; }
}
function getOverride(nick) {
  const v = overrides[nick];
  return (typeof v === 'number' && isFinite(v)) ? v : null;
}
function setOverride(nick, pct) {
  if (pct === null || pct === undefined || pct === '' || isNaN(pct)) delete overrides[nick];
  else overrides[nick] = Number(pct);
  try { localStorage.setItem(WP_OVERRIDE_KEY, JSON.stringify(overrides)); } catch {}
}

// ── Show/hide prediction tables (persisted) ──────────────────────────────────
let showPredictionTables = loadShowTables();
function loadShowTables() {
  try { const v = localStorage.getItem('wp_show_tables'); return v === null ? true : v === '1'; }
  catch { return true; }
}

// ── Projection ───────────────────────────────────────────────────────────────

// The per-player performance factor for the active adjust mode, or null when the
// mode is off / the player has no history (→ caller falls back to class/raw).
function perfFactor(nick) {
  if (adjustMode === 'history')  return (sheetPerf   && typeof sheetPerf[nick]   === 'number') ? sheetPerf[nick]   : null;
  if (adjustMode === 'lastweek') return (lastWeekPerf && typeof lastWeekPerf[nick] === 'number') ? lastWeekPerf[nick] : null;
  return null;
}

// Project a missing member, returning the breakdown the table shows. base is the raw
// fit at the member's CP; factor is the chosen multiplier (history > class > 1); the
// manual % override stacks on top.
function projectMember(member) {
  const base = activeFit.A * Math.pow(member.cp, activeFit.B);
  let factor = 1, source = '—';
  const pf = perfFactor(member.nick);
  if (pf != null) {
    factor = pf;
    source = adjustMode === 'history' ? 'History' : 'Last wk';
  } else if (classAdjust && frozenFit.classBias) {
    factor = Math.pow(10, frozenFit.classBias[member.cls] || 0);
    if (factor !== 1) source = 'Class';
  }
  const ovr = getOverride(member.nick);
  const mult = ovr != null ? (1 + ovr / 100) : 1;
  return { base, factor, source, overridePct: ovr, final: base * factor * mult };
}

// Just the projected score (used by the aggregators).
function projectMemberScore(member) {
  return projectMember(member).final;
}

function setPredictionStatus(msg, color) {
  const el = document.getElementById('prediction-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = color || '#6b7280';
}

// ── Adjust-mode controls + data loading ──────────────────────────────────────

function adjustAllowed() { return PREDICTION_PERF_TYPES.includes(currentContentType); }

// Reflect the current content type in the selector: history/last-week are only
// offered for PERF content types; otherwise force None. Called on every sheet load
// (via clearPrediction) and at init.
function syncAdjustControls() {
  const sel = document.getElementById('adjust-mode');
  if (!sel) return;
  const allowed = adjustAllowed();
  Array.from(sel.options).forEach(o => { if (o.value !== 'none') o.disabled = !allowed; });
  if (!allowed && adjustMode !== 'none') adjustMode = 'none';
  sel.value = adjustMode;
  sel.title = allowed ? '' : 'History adjustment isn’t available for this content type';
}

function onAdjustModeChange(val) {
  adjustMode = val;
  if (lastPrediction) runPrediction();   // re-run with the new mode
}

// Build the Last-week { nick -> factor } map from the previous sheet (which
// history.js already fetches), caching it per sheet. Resolves to the map or null.
function buildLastWeekPerf() {
  const key = currentContentType + ' ' + currentSheet;
  if (lastWeekFor === key && lastWeekPerf) return Promise.resolve(lastWeekPerf);
  const prev = (typeof prevSheetName === 'function') ? prevSheetName() : null;
  if (!prev) { lastWeekPerf = null; lastWeekFor = key; return Promise.resolve(null); }
  return getSheetRows(prev).then(rows => {
    let map = null;
    if (rows && rows.length) {
      const { A, B } = powerRegression(rows);
      if (A > 0 && isFinite(B)) {
        map = {};
        rows.forEach(r => {
          if (r && r.cp > 0 && r.score > 0) {
            const pred = A * Math.pow(r.cp, B);
            if (pred > 0) map[r.nick] = r.score / pred;
          }
        });
      }
    }
    lastWeekPerf = map; lastWeekFor = key;
    return map;
  });
}

// Make sure the active adjust mode's per-player data is loaded before computing.
function ensureAdjustData() {
  if (adjustMode === 'history') {
    if (sheetPerf) return Promise.resolve();
    if (!IS_REMOTE) return Promise.resolve();  // can't build off-remote → falls back
    setPredictionStatus('Building history profile…');
    return apiCall('buildPerfProfile', { contentType: currentContentType, sheet: currentSheet }).then(json => {
      const data = typeof json === 'string' ? JSON.parse(json) : json;
      sheetPerf = perfOf(data);
      if (!perfCache[currentContentType]) perfCache[currentContentType] = {};
      perfCache[currentContentType][currentSheet] = sheetPerf;
      // Now that we have history, flag sandbaggers in the player table.
      annotateSandbag();
      if (typeof renderPlayerTable === 'function') renderPlayerTable();
    });
  }
  if (adjustMode === 'lastweek') {
    setPredictionStatus('Loading last week…');
    return buildLastWeekPerf();
  }
  return Promise.resolve();
}

// ── Run ───────────────────────────────────────────────────────────────────────

// Experiments button handler. Uses the in-memory sheetRosters embedded in the
// sheet's chart data (no fetch) → zero extra KV reads, except a one-time
// buildPerfProfile when History mode has no embedded profile yet.
function runPrediction() {
  if (!currentData || activeFit.A == null) {
    setPredictionStatus('Load a chart first.', '#f87171');
    return;
  }
  if (!sheetRosters || !Object.keys(sheetRosters).length) {
    setPredictionStatus(IS_REMOTE
      ? 'No rosters in this sheet yet — click “Refresh rosters”.'
      : 'Needs live data (remote mode).', '#facc15');
    return;
  }

  const btn = document.getElementById('predict-btn');
  if (btn) btn.disabled = true;

  ensureAdjustData()
    .then(() => computeAndRender())
    .catch(err => setPredictionStatus('Prediction failed: ' + err.message, '#f87171'))
    .finally(() => { if (btn) btn.disabled = false; });
}

function computeAndRender() {
  const isGW = currentContentType === 'Guild Wars';
  const guilds = [...new Set(currentData.map(d => d.guild))];
  const participants = new Set(currentData.map(d => d.nick));

  // Collect missing members per guild from the embedded roster snapshot.
  const missingByGuild = {};
  let withRoster = 0;
  guilds.forEach(guild => {
    missingByGuild[guild] = [];
    const roster = sheetRosters[guild];
    if (!Array.isArray(roster)) return;  // no roster snapshot for this guild
    withRoster++;
    roster.forEach(m => {
      if (!participants.has(m.nick)) {
        missingByGuild[guild].push({ nick: m.nick, cp: m.cp, cls: m.cls, guild });
      }
    });
  });

  lastPrediction = { guilds, missingByGuild, isGW };
  renderAll();

  const totalMissing = guilds.reduce((s, g) => s + missingByGuild[g].length, 0);
  const without = guilds.length - withRoster;
  const rosterNote = without ? '  ·  ' + without + ' guild(s) have no roster (try Refresh rosters)' : '';
  let modeNote = '';
  if (adjustMode !== 'none') {
    const data = adjustMode === 'history' ? sheetPerf : lastWeekPerf;
    modeNote = (data && Object.keys(data).length)
      ? '  ·  ' + (adjustMode === 'history' ? 'history' : 'last-week') + '-adjusted'
      : '  ·  no history found (using class/raw)';
  }
  setPredictionStatus('Projected ' + totalMissing + ' missing members across ' + withRoster +
    ' guild(s)' + modeNote + rosterNote, without ? '#facc15' : '#4ade80');
}

// Recompute aggregates from the cached missing-member diff and re-render both tables
// (used after an override edit, mode change, or toggle). For Guild Wars it also
// re-ranks the combined population once to give each participant + absentee their
// projected GW points (shown in the player table and the absentees table).
function renderAll() {
  if (!lastPrediction) { applyTableVisibility(); return; }
  const { guilds, missingByGuild, isGW } = lastPrediction;

  let rows, proj = null;
  if (isGW) {
    proj = computeGwProjection(guilds, missingByGuild);
    projAbsentGwPoints = proj.absentByNick;
    currentData.forEach(d => { d.projGwPoints = proj.partByNick[d.nick]; });
    rows = aggregateGwPoints(guilds, missingByGuild, proj);
    if (typeof renderPlayerTable === 'function') renderPlayerTable();  // show Proj GW Pts
  } else {
    projAbsentGwPoints = {};
    currentData.forEach(d => { delete d.projGwPoints; });
    rows = aggregateScore(guilds, missingByGuild);
  }

  renderPredictionTable(rows, isGW);
  buildMissingFlat(missingByGuild, isGW);
  renderMissingRows();
  applyTableVisibility();
}

// ── Refresh rosters ───────────────────────────────────────────────────────────

// "Refresh rosters" button: re-pull the roster snapshot from the ROSTERS store
// into the current sheet's chart data, then update the in-memory sheetRosters.
function refreshRosters() {
  if (!IS_REMOTE) {
    setPredictionStatus('Needs live data (remote mode).', '#f87171');
    return;
  }
  if (!currentSheet || !currentContentType) {
    setPredictionStatus('Load a sheet first.', '#f87171');
    return;
  }
  const btn = document.getElementById('refresh-rosters-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
  setPredictionStatus('Refreshing rosters from store…');

  apiCall('refreshRosters', { contentType: currentContentType, sheet: currentSheet }).then(json => {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    sheetRosters = rostersOf(data);
    if (!rostersCache[currentContentType]) rostersCache[currentContentType] = {};
    rostersCache[currentContentType][currentSheet] = sheetRosters;
    const n = sheetRosters ? Object.keys(sheetRosters).length : 0;
    setPredictionStatus(n
      ? 'Rosters refreshed (' + n + ' guild(s)). Click “Predict winner”.'
      : 'No rosters in the store yet — capture them in SwissKnife first.',
      n ? '#4ade80' : '#facc15');
  }).catch(err => {
    setPredictionStatus('Refresh failed: ' + err.message, '#f87171');
  }).finally(() => {
    if (btn) { btn.disabled = false; btn.textContent = 'Refresh rosters'; }
  });
}

// ── Aggregation ────────────────────────────────────────────────────────────────

// Total-score aggregation (non-GW content). projectedTotal = actual participant
// scores + projected scores of missing members.
function aggregateScore(guilds, missingByGuild) {
  const actual = {};
  currentData.forEach(d => { actual[d.guild] = (actual[d.guild] || 0) + (d.score || 0); });

  const rows = guilds.map(guild => {
    const missing = missingByGuild[guild];
    const added = missing.reduce((s, m) => s + projectMemberScore(m), 0);
    const cur = actual[guild] || 0;
    return { guild, current: cur, missingCount: missing.length, added, total: cur + added };
  });
  return rankRows(rows, r => r.current, r => r.total);
}

// Re-rank the combined population (participants with real scores + missing members
// with projected scores), assign ranks 1..N, map rank→points via GW_POINTS_DATA, and
// return per-guild totals plus per-player points (split into participants vs absentees).
// Approximation: real GW ranking spans the whole league including guilds we have no
// roster for — this re-ranks only the guilds present in the sheet.
function computeGwProjection(guilds, missingByGuild) {
  const gwMap = parseGWPoints(GW_POINTS_DATA);
  const pointsFor = rank => gwMap.get(String(rank)) || 0;

  const pop = [];
  currentData.forEach(d => pop.push({ nick: d.nick, guild: d.guild, score: d.score || 0, absent: false }));
  guilds.forEach(guild => missingByGuild[guild].forEach(
    m => pop.push({ nick: m.nick, guild, score: projectMemberScore(m), absent: true })));
  pop.sort((a, b) => b.score - a.score);

  // GW_POINTS_DATA + joinGwPoints are 0-indexed (rank 0 = 1st place = 1,000,000),
  // so award the top scorer pointsFor(0), not pointsFor(1) — otherwise everyone is
  // shifted down a place and nobody gets the rank-0 value.
  const guildPoints = {}, partByNick = {}, absentByNick = {};
  pop.forEach((p, i) => {
    const pts = pointsFor(i);
    guildPoints[p.guild] = (guildPoints[p.guild] || 0) + pts;
    if (p.absent) absentByNick[p.nick] = pts; else partByNick[p.nick] = pts;
  });
  return { guildPoints, partByNick, absentByNick };
}

// GW-points aggregation: per-guild current vs projected GW points. `proj` is the
// computeGwProjection result (computed once in renderAll); recomputed if omitted.
function aggregateGwPoints(guilds, missingByGuild, proj) {
  const current = {};
  currentData.forEach(d => { current[d.guild] = (current[d.guild] || 0) + (d.gwPoints || 0); });
  const guildPoints = (proj || computeGwProjection(guilds, missingByGuild)).guildPoints;

  const rows = guilds.map(guild => {
    const cur = current[guild] || 0;
    const tot = guildPoints[guild] || 0;
    return { guild, current: cur, missingCount: missingByGuild[guild].length, added: tot - cur, total: tot };
  });
  return rankRows(rows, r => r.current, r => r.total);
}

// Flag participants whose THIS-week performance is notably below their historical
// norm (likely sandbaggers). Compares each player's current ratio score/(A·cp^B)
// against their recency-weighted history factor (sheetPerf, built from prior weeks).
// Annotates currentData with d.histDelta (% vs their norm) and d.sandbag. No-op
// until a history profile exists for the sheet (sheetPerf, via History mode).
function annotateSandbag() {
  if (!currentData) return;
  currentData.forEach(d => { delete d.histDelta; delete d.sandbag; });
  if (!sheetPerf || activeFit.A == null) return;
  currentData.forEach(d => {
    const hist = sheetPerf[d.nick];
    if (typeof hist !== 'number' || !(hist > 0) || !(d.cp > 0) || !(d.score > 0)) return;
    const cur = d.score / (activeFit.A * Math.pow(d.cp, activeFit.B));
    d.histDelta = (cur / hist - 1) * 100;
    d.sandbag = d.histDelta <= -SANDBAG_THRESHOLD * 100;
  });
}

// Sort by projected total desc and annotate each row with Δ rank (current rank
// by `curKey` minus projected rank) — positive means the guild climbs.
function rankRows(rows, curKey, totKey) {
  const curRank = new Map();
  [...rows].sort((a, b) => curKey(b) - curKey(a)).forEach((r, i) => curRank.set(r.guild, i + 1));
  rows.sort((a, b) => totKey(b) - totKey(a));
  rows.forEach((r, i) => { r.dRank = curRank.get(r.guild) - (i + 1); });
  return rows;
}

// ── Number formatting (shared by both tables) ───────────────────────────────────

function fmtScore(v) {
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  return Math.round(v).toLocaleString();
}

// ── Per-guild projected-totals table ────────────────────────────────────────────

function renderPredictionTable(rows, isGW) {
  const section = document.getElementById('prediction-section');
  if (!section) return;

  document.getElementById('prediction-th-metric').textContent = isGW ? 'GW Points' : 'Score';
  const fmt = isGW ? v => Math.round(v).toLocaleString() : fmtScore;
  const fmtSigned = v => (v >= 0 ? '+' : '') + fmt(v);
  const dRankText = d => d > 0 ? '↑' + d : d < 0 ? '↓' + (-d) : '—';
  const dRankColor = d => d > 0 ? '#4ade80' : d < 0 ? '#f87171' : '#6b7280';

  const tbody = document.getElementById('prediction-body');
  tbody.innerHTML = '';
  rows.forEach((r, i) => {
    const color = GUILD_COLORS[r.guild] || GUILD_COLORS['default'];
    const tr = document.createElement('tr');
    if (i === 0) tr.className = 'pivot-total-row';  // highlight projected winner
    tr.innerHTML =
      `<td><span class="p-swatch" style="background:${color}"></span>` +
        `<a class="tlink" href="https://mapleidle.gg/guild/bera/${encodeURIComponent(r.guild)}" target="_blank" rel="noopener">${r.guild}</a>` +
        (i === 0 ? ' 👑' : '') + `</td>` +
      `<td>${fmt(r.current)}</td>` +
      `<td>${r.missingCount}</td>` +
      `<td style="color:${r.added >= 0 ? '#4ade80' : '#f87171'}">${fmtSigned(r.added)}</td>` +
      `<td><strong>${fmt(r.total)}</strong></td>` +
      `<td style="color:${dRankColor(r.dRank)}">${dRankText(r.dRank)}</td>`;
    tbody.appendChild(tr);
  });
}

// ── Per-player "Projected absentees" table ──────────────────────────────────────

// The adjustment cell: a small source pill + the factor as a signed %.
function factorText(factor, source) {
  if (source === '—' || !isFinite(factor)) return '<span style="color:#6b7280">—</span>';
  const pct = (factor - 1) * 100;
  const color = pct > 0 ? '#4ade80' : pct < 0 ? '#f87171' : '#6b7280';
  const sign = pct > 0 ? '+' : '';
  return `<span class="wp-pill">${source}</span> <span style="color:${color}">${sign}${pct.toFixed(0)}%</span>`;
}

// Flatten the missing-member diff into missingFlat (the rows backing the table +
// the override inputs, addressed by a stable _idx so sorting can't desync them).
function buildMissingFlat(missingByGuild, isGW) {
  missingFlat = [];
  Object.keys(missingByGuild).forEach(guild => {
    missingByGuild[guild].forEach(m => {
      const p = projectMember(m);
      const projGw = isGW ? (projAbsentGwPoints[m.nick] || 0) : null;
      missingFlat.push({ _idx: missingFlat.length, nick: m.nick, cp: m.cp, cls: m.cls, guild, projGw, ...p });
    });
  });
}

const MISSING_NUMERIC = new Set(['cp', 'base', 'factor', 'overridePct', 'final', 'projGw']);

// Sortable headers (onclick in the markup), mirroring the player table's behavior.
function sortMissingBy(col) {
  if (missingSortCol === col) missingSortDir = missingSortDir === 'asc' ? 'desc' : 'asc';
  else { missingSortCol = col; missingSortDir = MISSING_NUMERIC.has(col) ? 'desc' : 'asc'; }
  renderMissingRows();
}

function renderMissingRows() {
  const tbody = document.getElementById('missing-body');
  if (!tbody) return;
  const isGW = !!(lastPrediction && lastPrediction.isGW);

  // GW-points column shows only for Guild Wars.
  const gwTh = document.getElementById('missing-th-gwpoints');
  if (gwTh) gwTh.style.display = isGW ? '' : 'none';

  // Sort-icon + aria state on the headers.
  document.querySelectorAll('#missing-table thead th.sortable').forEach(th => {
    const icon = th.querySelector('.sort-icon'); if (!icon) return;
    const active = th.dataset.col === missingSortCol;
    icon.textContent = active ? (missingSortDir === 'asc' ? '↑' : '↓') : '↕';
    icon.className = 'sort-icon' + (active ? ' active' : '');
    th.setAttribute('aria-sort', active ? (missingSortDir === 'asc' ? 'ascending' : 'descending') : 'none');
  });

  const cols = 7 + (isGW ? 1 : 0);
  if (!missingFlat.length) {
    tbody.innerHTML = '<tr><td colspan="' + cols + '" style="text-align:center;color:#6b7280">' +
      'No absent members — everyone in the rosters participated (or no rosters loaded).</td></tr>';
    return;
  }

  const col = missingSortCol, dir = missingSortDir, num = MISSING_NUMERIC.has(col);
  const val = r => num ? (Number(r[col]) || 0) : String(r[col] == null ? '' : r[col]);
  const sorted = [...missingFlat].sort((a, b) => {
    const cmp = num ? (val(a) - val(b)) : String(val(a)).localeCompare(String(val(b)));
    return dir === 'asc' ? cmp : -cmp;
  });

  tbody.innerHTML = '';
  sorted.forEach(row => {
    const color = GUILD_COLORS[row.guild] || GUILD_COLORS['default'];
    const nickHref = 'https://mapleidle.gg/characters/bera/' + encodeURIComponent(row.nick);
    const ovrVal = row.overridePct == null ? '' : row.overridePct;
    const tr = document.createElement('tr');
    let html =
      `<td><span class="p-swatch" style="background:${color}"></span>` +
        `<a class="tlink" href="https://mapleidle.gg/guild/bera/${encodeURIComponent(row.guild)}" target="_blank" rel="noopener">${row.guild}</a></td>` +
      `<td><a class="tlink" href="${nickHref}" target="_blank" rel="noopener">${row.nick}</a></td>` +
      `<td style="text-align:right">${toGamingNotation(row.cp)}</td>` +
      `<td style="text-align:right">${fmtScore(row.base)}</td>` +
      `<td style="text-align:right">${factorText(row.factor, row.source)}</td>` +
      `<td style="text-align:center"><input class="wp-ovr" type="number" step="5" value="${ovrVal}" placeholder="0" data-idx="${row._idx}" onchange="onOverrideInput(this)" aria-label="Override % for ${row.nick}"></td>`;
    if (isGW) html += `<td style="text-align:right">${row.projGw != null ? Math.round(row.projGw).toLocaleString() : '—'}</td>`;
    html += `<td style="text-align:right"><strong>${fmtScore(row.final)}</strong></td>`;
    tr.innerHTML = html;
    tbody.appendChild(tr);
  });
}

// Override input handler (onchange — fires on blur/Enter so re-rendering doesn't
// steal focus mid-edit). Persists, then re-aggregates + re-renders both tables.
function onOverrideInput(el) {
  const row = missingFlat[+el.dataset.idx];
  if (!row) return;
  const raw = (el.value || '').trim();
  setOverride(row.nick, raw === '' ? null : Number(raw));
  renderAll();
}

// ── Visibility / reset ──────────────────────────────────────────────────────────

function applyTableVisibility() {
  const has = !!lastPrediction;
  const predSec = document.getElementById('prediction-section');
  const missSec = document.getElementById('missing-players-section');
  const show = has && showPredictionTables ? 'block' : 'none';
  if (predSec) predSec.style.display = show;
  if (missSec) missSec.style.display = show;
}

function onShowTablesToggle(checked) {
  showPredictionTables = checked;
  try { localStorage.setItem('wp_show_tables', checked ? '1' : '0'); } catch {}
  applyTableVisibility();
}

// Hide + reset the prediction tables (called from buildChart on sheet/content
// switch so stale predictions don't carry across).
function clearPrediction() {
  lastPrediction = null;
  missingFlat = [];
  lastWeekPerf = null;
  lastWeekFor = null;
  projAbsentGwPoints = {};
  if (currentData) currentData.forEach(d => { delete d.projGwPoints; });
  applyTableVisibility();
  const tbody = document.getElementById('prediction-body');
  if (tbody) tbody.innerHTML = '';
  const mbody = document.getElementById('missing-body');
  if (mbody) mbody.innerHTML = '';
  syncAdjustControls();
  // Keep the gate note visible in non-remote modes (buildChart calls this on
  // every sheet switch, which would otherwise blank the explanation).
  setPredictionStatus(IS_REMOTE ? '' : 'Needs live data (remote mode).');
}

// ── Init ──────────────────────────────────────────────────────────────────────

(function initPrediction() {
  const tablesCb = document.getElementById('show-tables');
  if (tablesCb) tablesCb.checked = showPredictionTables;
  const sel = document.getElementById('adjust-mode');
  if (sel) sel.value = adjustMode;

  // Refresh rosters hits the roster store via the Worker — disable it off-remote.
  // (Predict stays enabled; it reports "needs live data" when there's no embedded
  // snapshot, which is always the case in local sample mode.)
  if (typeof IS_REMOTE !== 'undefined' && !IS_REMOTE) {
    const btn = document.getElementById('refresh-rosters-btn');
    if (btn) { btn.disabled = true; btn.title = 'Available on the deployed site'; }
    setPredictionStatus('Needs live data (remote mode).');
  }
})();
