// ── Win prediction ──────────────────────────────────────────────────────────
// Rosters are captured from mapleidle.gg by the SwissKnife mitmproxy addon and
// stored per-guild in KV (ROSTERS). When a sheet's data entry is created, a
// snapshot of its guilds' rosters is embedded into the chart data and rides along
// in the getData response as `sheetRosters` (data.js) — so prediction needs NO
// extra KV/network call. We find members missing from the content run, project
// their score from the live power-law fit (Score ≈ A·CP^B, optionally
// class-adjusted), and aggregate a projected per-guild total.
//
// Metric per content type (mirrors buildPivotTable): GW Points for Guild Wars
// (rank-based via GW_POINTS_DATA), total Score for everything else.
//
// `Refresh rosters` (refreshRosters) re-pulls the snapshot from ROSTERS into the
// current sheet — the only path that touches the roster store, and only on demand.

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

// Experiments button handler. Uses the in-memory sheetRosters embedded in the
// sheet's chart data (no fetch) → zero extra KV reads.
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

  const isGW = currentContentType === 'Guild Wars';
  const guilds = [...new Set(currentData.map(d => d.guild))];
  const participants = new Set(currentData.map(d => d.nick));

  // Collect missing members per guild from the embedded snapshot.
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

  const rows = isGW
    ? aggregateGwPoints(guilds, missingByGuild)
    : aggregateScore(guilds, missingByGuild);

  renderPredictionTable(rows, isGW);
  const without = guilds.length - withRoster;
  const note = without ? '  ·  ' + without + ' guild(s) have no roster (try Refresh rosters)' : '';
  setPredictionStatus('Projected ' + rows.reduce((s, r) => s + r.missingCount, 0) +
    ' missing members across ' + withRoster + ' guild(s)' + note,
    without ? '#facc15' : '#4ade80');
}

// "Refresh rosters" button: re-pull the roster snapshot from the ROSTERS store
// into the current sheet's chart data (the only on-demand call to the store), then
// update the in-memory sheetRosters so the next Predict uses the fresh snapshot.
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
    // Keep the per-sheet cache in sync so a later cache-hit restores the refresh.
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

// Refresh rosters hits the roster store via the Worker — disable it off-remote.
// (Predict stays enabled; it just reports "needs live data" when there's no
// embedded snapshot, which is always the case in local sample mode.)
if (typeof IS_REMOTE !== 'undefined' && !IS_REMOTE) {
  const btn = document.getElementById('refresh-rosters-btn');
  if (btn) { btn.disabled = true; btn.title = 'Available on the deployed site'; }
  setPredictionStatus('Needs live data (remote mode).');
}
