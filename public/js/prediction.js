// ── Win prediction ──────────────────────────────────────────────────────────
// Read each guild's full roster from the /guild Worker route (backed by KV; the
// rosters are captured from mapleidle.gg by the SwissKnife mitmproxy addon and
// uploaded there), find members missing from the current content run, project
// their score from the live power-law fit (Score ≈ A·CP^B, optionally
// class-adjusted), and aggregate a projected per-guild total to predict who would
// win if everyone showed up.
//
// Metric per content type (mirrors buildPivotTable): GW Points for Guild Wars
// (rank-based via GW_POINTS_DATA), total Score for everything else.
//
// Needs the Worker, so it only runs in IS_REMOTE (and `wrangler dev`).

// Session cache: guild name -> normalized roster [{nick, cp, cls, level}].
const rosterCache = {};

const ROSTER_TIMEOUT_MS = 15000;  // KV reads are fast

// One batched GET to the Worker's /guild route for all guilds at once. Returns a
// map { guild: roster[] | { error } }. Tolerates string-or-object JSON like
// apiCall (io.js). Caches successful rosters per guild for the session and only
// requests guilds not already cached.
function fetchRosters(guilds) {
  const need = guilds.filter(g => !rosterCache[g]);
  if (!need.length) {
    const out = {};
    guilds.forEach(g => { out[g] = rosterCache[g]; });
    return Promise.resolve(out);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ROSTER_TIMEOUT_MS);
  const qs = new URLSearchParams({ world: 'bera', names: need.join(',') });
  return fetch('/guild?' + qs.toString(), { signal: ctrl.signal }).then(r => {
    if (!r.ok) return r.json().then(j => { throw new Error((j && j.error) || ('HTTP ' + r.status)); },
                                         () => { throw new Error('HTTP ' + r.status); });
    return r.json();
  }).then(json => {
    const map = typeof json === 'string' ? JSON.parse(json) : json;
    if (map && map.error) throw new Error(map.error);
    // Cache only successful rosters (arrays); error entries stay uncached so a
    // later run retries them.
    Object.keys(map).forEach(g => { if (Array.isArray(map[g])) rosterCache[g] = map[g]; });
    const out = {};
    guilds.forEach(g => { out[g] = rosterCache[g] || map[g]; });
    return out;
  }).catch(err => {
    throw err.name === 'AbortError' ? new Error('Request timed out') : err;
  }).finally(() => clearTimeout(timer));
}

// Project a missing member's score from the live fit. Honors the classAdjust
// flag the same way computeFitDiffs picks raw vs class-adjusted (regression.js):
// when on, shift by the member's class bias (0 if the class is unknown/unmatched).
function projectMemberScore(member) {
  let proj = activeFit.A * Math.pow(member.cp, activeFit.B);
  if (classAdjust && frozenFit.classBias) {
    proj *= Math.pow(10, frozenFit.classBias[member.cls] || 0);
  }
  return proj;
}

function setPredictionStatus(msg, color) {
  const el = document.getElementById('prediction-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = color || '#6b7280';
}

// Experiments button handler.
function runPrediction() {
  if (!IS_REMOTE) {
    setPredictionStatus('Needs live data — open the deployed site (remote mode).', '#f87171');
    return;
  }
  if (!currentData || activeFit.A == null) {
    setPredictionStatus('Load a chart first.', '#f87171');
    return;
  }

  const isGW = currentContentType === 'Guild Wars';
  const guilds = [...new Set(currentData.map(d => d.guild))];
  const participants = new Set(currentData.map(d => d.nick));
  const btn = document.getElementById('predict-btn');
  if (btn) btn.disabled = true;
  setPredictionStatus('Loading rosters…');

  fetchRosters(guilds).then(map => {
    if (btn) btn.disabled = false;

    // Collect missing members per guild + count failures.
    const missingByGuild = {};
    let failed = 0;
    guilds.forEach(guild => {
      missingByGuild[guild] = [];
      const roster = map[guild];
      if (!Array.isArray(roster)) { failed++; return; }
      roster.forEach(m => {
        if (!participants.has(m.nick)) {
          missingByGuild[guild].push({ nick: m.nick, cp: m.cp, cls: m.cls, guild });
        }
      });
    });

    const rows = isGW
      ? aggregateGwPoints(guilds, missingByGuild)
      : aggregateScore(guilds, missingByGuild);

    renderPredictionTable(rows, isGW);
    const note = failed ? '  ·  ' + failed + ' guild(s) failed to load' : '';
    setPredictionStatus('Done — projected ' + rows.reduce((s, r) => s + r.missingCount, 0) +
      ' missing members across ' + (guilds.length - failed) + ' guild(s)' + note,
      failed ? '#facc15' : '#4ade80');
  }).catch(err => {
    if (btn) btn.disabled = false;
    setPredictionStatus('Prediction failed: ' + err.message, '#f87171');
  });
}

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

// GW-points aggregation: rebuild the ranking over the combined population
// (participants with real scores + missing members with projected scores),
// assign ranks 1..N, map rank→points via GW_POINTS_DATA, and sum per guild.
// Approximation: real GW ranking spans the whole league including guilds we
// have no roster for — this re-ranks only the guilds present in the sheet.
function aggregateGwPoints(guilds, missingByGuild) {
  const gwMap = parseGWPoints(GW_POINTS_DATA);
  const pointsFor = rank => gwMap.get(String(rank)) || 0;

  const current = {};
  currentData.forEach(d => { current[d.guild] = (current[d.guild] || 0) + (d.gwPoints || 0); });

  // Combined population sorted by score; missing members get a projected score.
  const pop = [];
  currentData.forEach(d => pop.push({ guild: d.guild, score: d.score || 0 }));
  guilds.forEach(guild => missingByGuild[guild].forEach(
    m => pop.push({ guild, score: projectMemberScore(m) })));
  pop.sort((a, b) => b.score - a.score);

  const projected = {};
  pop.forEach((p, i) => { projected[p.guild] = (projected[p.guild] || 0) + pointsFor(i + 1); });

  const rows = guilds.map(guild => {
    const cur = current[guild] || 0;
    const tot = projected[guild] || 0;
    return { guild, current: cur, missingCount: missingByGuild[guild].length, added: tot - cur, total: tot };
  });
  return rankRows(rows, r => r.current, r => r.total);
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

function renderPredictionTable(rows, isGW) {
  const section = document.getElementById('prediction-section');
  if (!section) return;

  document.getElementById('prediction-th-metric').textContent = isGW ? 'GW Points' : 'Score';
  const fmt = isGW
    ? v => Math.round(v).toLocaleString()
    : v => {
        if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
        if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
        return Math.round(v).toLocaleString();
      };
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

  section.style.display = 'block';
}

// Hide + reset the prediction table (called from buildChart on sheet/content
// switch so stale predictions don't carry across).
function clearPrediction() {
  const section = document.getElementById('prediction-section');
  if (section) section.style.display = 'none';
  const tbody = document.getElementById('prediction-body');
  if (tbody) tbody.innerHTML = '';
  // Keep the gate note visible in non-remote modes (buildChart calls this on
  // every sheet switch, which would otherwise blank the explanation).
  setPredictionStatus(IS_REMOTE ? '' : 'Needs live data (remote mode).');
}

// Gate the button when there's no Worker proxy to reach mapleidle through.
if (typeof IS_REMOTE !== 'undefined' && !IS_REMOTE) {
  const btn = document.getElementById('predict-btn');
  if (btn) {
    btn.disabled = true;
    setPredictionStatus('Needs live data (remote mode).');
  }
}
