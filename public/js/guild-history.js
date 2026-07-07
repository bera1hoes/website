// ── Guild history (per-guild rollup across prior weeks) ─────────────────────
// The pivot table shows each guild's current week. Opponents rotate week to
// week, so "have we seen this guild before?" means ANY older sheet of this
// content type — not just last week's (which the player history in history.js
// covers). When a guild has prior appearances, the pivot gains rollup columns:
// weeks seen, average total Score per appearance, and this week's total Score
// vs that average.
//
// Remote: the rollup is built server-side (worker.js buildPerfProfile scans the
// prior sheets once and embeds `guildHistory` into the sheet's KV entry) and
// rides the getData payload as sheetGuildHist (data.js). A sheet without an
// embedded rollup triggers one fire-and-forget build here — the same
// self-healing pattern as the perf profile. Local: computed directly from the
// pre-parsed sample sheets.

// Aggregate prior local sheets for the guilds on the current one. Shape mirrors
// the worker's guildHistory: { "<guild>": [ { sheet, total, members }, … ] },
// newest-first (sheet names are already ordered newest-first).
function computeLocalGuildHist() {
  const names = sheetNameList();
  const i = names.indexOf(currentSheet);
  const gh = {};
  if (i < 0) return gh;
  const curGuilds = new Set(currentData.map(d => d.guild));
  for (let j = i + 1; j < names.length; j++) {
    const rows = (localFiles[currentContentType] || {})[names[j]];
    if (!rows) continue;
    const perGuild = {};
    rows.forEach(r => {
      if (!curGuilds.has(r.guild) || !(r.score > 0)) return;
      const a = perGuild[r.guild] || (perGuild[r.guild] = { total: 0, members: 0 });
      a.total += r.score;
      a.members++;
    });
    Object.keys(perGuild).forEach(g => {
      (gh[g] || (gh[g] = [])).push({ sheet: names[j], total: perGuild[g].total, members: perGuild[g].members });
    });
  }
  return gh;
}

// Apply a freshly-built { rows, rosters, perfProfile?, guildHistory } entry to
// the current sheet's in-memory state + caches, then refresh everything it
// feeds: sandbag flags + player table (perf profile) and the pivot's history
// columns. Shared with prediction.js's ensureAdjustData — both trigger the same
// buildPerfProfile action, which embeds both.
function applyBuiltEntry(parsed) {
  sheetPerf = perfOf(parsed);
  if (!perfCache[currentContentType]) perfCache[currentContentType] = {};
  perfCache[currentContentType][currentSheet] = sheetPerf;
  sheetGuildHist = guildHistOf(parsed);
  if (!guildHistCache[currentContentType]) guildHistCache[currentContentType] = {};
  guildHistCache[currentContentType][currentSheet] = sheetGuildHist;
  annotateSandbag();
  renderPlayerTable();
  buildPivotTable(currentData);
}

// Runs fire-and-forget after buildChart (io.js), like loadHistory: fill the
// pivot's history columns without ever blocking the chart. No-op when the
// rollup is already in memory (embedded in the payload or cached).
function loadGuildHistory() {
  if (!currentData) return;
  if (IS_LOCAL) {
    sheetGuildHist = computeLocalGuildHist();
    if (!guildHistCache[currentContentType]) guildHistCache[currentContentType] = {};
    guildHistCache[currentContentType][currentSheet] = sheetGuildHist;
    buildPivotTable(currentData);
    return;
  }
  if (sheetGuildHist != null) return;  // already built ({} = built, none seen before)
  if (!prevSheetName()) return;        // oldest sheet — nothing prior to roll up
  const dataAtCall = currentData;
  apiCall('buildPerfProfile', { contentType: currentContentType, sheet: currentSheet }).then(json => {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json;
    // Bail if the user switched sheets while the build ran.
    if (currentData !== dataAtCall) return;
    applyBuiltEntry(parsed);
  }).catch(err => console.warn('guild history build failed:', err));
}

// ── Pivot cells ──────────────────────────────────────────────────────────────
// The three history cells for one guild row: weeks seen (tooltip = per-week
// breakdown), average total Score across prior appearances, and this week's
// total Score vs that average. `hist` may be empty/undefined for a first-time
// guild — those rows show em-dashes under the (visible) columns.

function guildHistCells(hist, scoreNow) {
  if (!hist || !hist.length) {
    return '<td style="color:var(--text-muted)">—</td>'.repeat(3);
  }
  const avg = hist.reduce((s, e) => s + e.total, 0) / hist.length;
  const tip = hist.map(e => `${e.sheet} · ${fmtScore(e.total)} (${e.members}p)`).join('\n');
  let delta = '<span style="color:var(--text-muted)">—</span>';
  if (avg > 0) {
    const pct = (scoreNow / avg - 1) * 100;
    const color = pct > 0 ? '#4ade80' : pct < 0 ? '#f87171' : 'var(--text-muted)';
    const sign = pct > 0 ? '+' : '';
    delta = `<span style="color:${color}">${sign}${pct.toFixed(1)}%</span>`;
  }
  return `<td title="${tip}">${hist.length}×</td>` +
         `<td title="${tip}">${fmtScore(avg)}</td>` +
         `<td>${delta}</td>`;
}
