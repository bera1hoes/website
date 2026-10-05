// ── Pivot table + player table ─────────────────────────────────────────────

let playerTableData = [];
let playerSortCol = 'rank';
let playerSortDir = 'asc';
let playerFilter = '';
// The table renders at most `playerRowLimit` rows, PLAYER_PAGE more per "Show
// more". Sort and filter still run over the whole sheet; only the DOM is capped
// — a whole-world sheet is thousands of players, and rebuilding every row on each
// keystroke or sort froze the page. 200 covers a full Guild Wars, GTG or Global
// GBB sheet, so in practice only Guild Conquest pages. `playerRowsSorted` is the
// last render's full sorted + filtered list (rows carry their index into it).
const PLAYER_PAGE = 200;
let playerRowLimit = PLAYER_PAGE;
let playerRowsSorted = [];
const NUMERIC_COLS = new Set(['rank', 'level', 'cp', 'score', 'fitDiff', 'histDelta', 'customFitDiff', 'points', 'projGwPoints']);

// ── Column visibility ───────────────────────────────────────────────────────
// Columns the user can hide via the "Columns" menu (Rank/Nick/Score stay on as
// the identity columns). `hiddenCols` persists across sheet switches.
const TOGGLEABLE_COLS = ['guild', 'cls', 'level', 'cp', 'fitDiff', 'histDelta', 'customFitDiff', 'points', 'projGwPoints'];
let hiddenCols = new Set();

// Whether a column is structurally present right now (independent of the user's
// hide choice): custom fit, points (GW/GC), history, and projected GW points only
// exist in some states.
function colApplicable(col) {
  if (col === 'customFitDiff') return custom.A !== null;
  if (col === 'points')        return !!POINTS_LABELS[currentContentType];
  if (col === 'histDelta')     return !!(currentData && currentData.some(d => d.histDelta != null));
  if (col === 'projGwPoints')  return currentContentType === 'Guild Wars' && !!(currentData && currentData.some(d => d.projGwPoints != null));
  return true;
}

function colLabel(col) {
  const th = document.querySelector(`#player-table thead th[data-col="${col}"]`);
  return th ? th.textContent.replace(/[↕↑↓]/g, '').trim() : col;
}

function buildColMenu() {
  const menu = document.getElementById('col-menu');
  if (!menu) return;
  menu.innerHTML = '';
  TOGGLEABLE_COLS.filter(colApplicable).forEach(col => {
    const label = document.createElement('label');
    label.className = 'col-menu-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !hiddenCols.has(col);
    cb.addEventListener('change', () => {
      if (cb.checked) hiddenCols.delete(col); else hiddenCols.add(col);
      renderPlayerTable();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + colLabel(col)));
    menu.appendChild(label);
  });
}

function toggleColMenu() {
  const menu = document.getElementById('col-menu');
  const btn = document.getElementById('col-menu-btn');
  const show = menu.hidden;
  if (show) buildColMenu();
  menu.hidden = !show;
  if (btn) btn.setAttribute('aria-expanded', String(show));
}

// Close the menu when clicking outside it (wired once).
let _colMenuInit = false;
function initColMenu() {
  if (_colMenuInit) return;
  _colMenuInit = true;
  document.addEventListener('click', e => {
    const menu = document.getElementById('col-menu');
    if (!menu || menu.hidden) return;
    if (!e.target.closest('.col-menu-wrap')) {
      menu.hidden = true;
      const btn = document.getElementById('col-menu-btn');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }
  });
}

// The pivot lists the top PIVOT_TOP guilds until "Show all" — a whole-world
// sheet has hundreds. The choice sticks across rebuilds and sheet switches.
// `pivotData` is what the table was last built from (the CP filter passes a
// subset), so the toggle can rebuild the same view.
const PIVOT_TOP = 20;
let pivotExpanded = false;
let pivotData = null;

// The guild-history columns (guild-history.js), keyed as in their `pivot-th-*`
// header ids. Guild Conquest shows only Hist Avg Score.
const PIVOT_HIST_COLS = ['seen', 'histavg', 'histdelta'];
const PIVOT_HIST_COLS_GC = ['histavg'];

function togglePivotRows() {
  pivotExpanded = !pivotExpanded;
  if (pivotData) buildPivotTable(pivotData);
  // Collapsing from far down a long list would strand the viewer below it.
  if (!pivotExpanded) document.getElementById('pivot-more').scrollIntoView({ block: 'nearest' });
}

function buildPivotTable(data) {
  pivotData = data;
  const section = document.getElementById('pivot-section');
  const pts = POINTS_LABELS[currentContentType];  // GW / GC: guilds rank by summed points
  // GC rows also get the guild's place and its in-game title (gc-points.js).
  const isGC = currentContentType === 'Guild Conquest';

  if (pts) {
    const hasPoints = data.some(d => d.points > 0);
    if (!hasPoints) { section.style.display = 'none'; return; }
    document.getElementById('pivot-eyebrow').textContent = pts.name;
    document.getElementById('pivot-th-total').textContent = 'Total ' + pts.short;
    document.getElementById('pivot-th-avg').textContent = 'Avg ' + pts.short;
  } else {
    document.getElementById('pivot-eyebrow').textContent = currentContentType + ' Score';
    document.getElementById('pivot-th-total').textContent = 'Total Score';
    document.getElementById('pivot-th-avg').textContent = 'Avg Score';
  }

  const guilds = {};
  data.forEach(d => {
    if (!guilds[d.guild]) guilds[d.guild] = { count: 0, total: 0, score: 0 };
    guilds[d.guild].count++;
    guilds[d.guild].total += pts ? (d.points || 0) : (d.score || 0);
    guilds[d.guild].score += d.score || 0;  // history columns compare Score even on GW/GC
  });

  const rows = Object.entries(guilds).sort((a, b) => b[1].total - a[1].total);
  const grandTotal = rows.reduce((s, [, g]) => s + g.total, 0);

  // Guild-history rollup (guild-history.js): the "seen them before" columns show
  // only when at least one of this sheet's guilds appeared in a prior sheet.
  const gh = sheetGuildHist || {};
  const hasGuildHist = rows.some(([g]) => (gh[g] || []).length);
  const histCols = hasGuildHist ? (isGC ? PIVOT_HIST_COLS_GC : PIVOT_HIST_COLS) : [];
  PIVOT_HIST_COLS.forEach(c => {
    const th = document.getElementById('pivot-th-' + c);
    if (th) th.style.display = histCols.includes(c) ? '' : 'none';
  });
  document.getElementById('pivot-th-tier').style.display = isGC ? '' : 'none';

  const fmt = pts
    ? v => Math.round(v).toLocaleString()
    : v => {
        if (v >= 1e9) return (v / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
        if (v >= 1e6) return (v / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
        return Math.round(v).toLocaleString();
      };

  const tbody = document.getElementById('pivot-body');
  tbody.innerHTML = '';
  // `rows` is in total-points order, so a row's index + 1 is the guild's place.
  rows.slice(0, pivotExpanded ? rows.length : PIVOT_TOP).forEach(([guild, { count, total, score }], i) => {
    const color = GUILD_COLORS[guild] || GUILD_COLORS['default'];
    const avg = total / count;
    const tier = isGC ? gcGuildTierAt(i + 1, total) : null;
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${isGC ? `<span class="pivot-rank">${i + 1}</span>` : ''}<span class="p-swatch" style="background:${color}"></span><a class="tlink" href="https://mapleidle.gg/guild/bera/${encodeURIComponent(guild)}" target="_blank" rel="noopener">${guild}</a></td>` +
      (isGC ? `<td>${tier ? tier.name : '—'}</td>` : '') +
      `<td>${count}</td>` +
      `<td>${fmt(total)}</td>` +
      `<td>${fmt(avg)}</td>` +
      guildHistCells(gh[guild], score, histCols);
    tbody.appendChild(tr);
  });

  const totalTr = document.createElement('tr');
  totalTr.className = 'pivot-total-row';
  totalTr.innerHTML =
    `<td>All guilds</td>` +
    (isGC ? '<td></td>' : '') +
    `<td>${data.length}</td>` +
    `<td>${fmt(grandTotal)}</td>` +
    `<td>${fmt(grandTotal / data.length)}</td>` +
    '<td></td>'.repeat(histCols.length);
  tbody.appendChild(totalTr);

  const more = document.getElementById('pivot-more');
  more.hidden = rows.length <= PIVOT_TOP;
  more.textContent = pivotExpanded ? `Show top ${PIVOT_TOP} ▴` : `Show all ${rows.length} guilds ▾`;
  more.setAttribute('aria-expanded', String(pivotExpanded));

  section.style.display = 'block';
}

let _playerBodyDelegated = false;

function buildPlayerTable(data) {
  playerTableData = data;
  playerSortCol = 'rank';
  playerSortDir = 'asc';
  playerFilter = '';
  playerRowLimit = PLAYER_PAGE;
  // Click a Score cell to set a predicted value — one delegated listener on the
  // body (survives re-renders) instead of one per row.
  if (!_playerBodyDelegated) {
    document.getElementById('player-body').addEventListener('click', e => {
      const td = e.target.closest('td[data-col="score"]');
      const d = td && playerRowsSorted[+td.parentNode.dataset.i];
      if (d) beginScoreEdit(td, d);
    });
    _playerBodyDelegated = true;
  }
  const filterInput = document.getElementById('player-filter');
  if (filterInput) filterInput.value = '';
  const clr = document.getElementById('player-filter-clear');
  if (clr) clr.hidden = true;

  document.querySelectorAll('#player-table thead th.sortable').forEach(th => {
    th.onclick = () => sortPlayerTableBy(th.dataset.col);
    th.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortPlayerTableBy(th.dataset.col); }
    };
  });
  // The points header's leading text node ("GW Points " / "GC Points "); the sort
  // icon span after it is left alone.
  const pts = POINTS_LABELS[currentContentType];
  if (pts) document.getElementById('player-th-points').firstChild.textContent = pts.short + ' ';

  initColMenu();
  document.getElementById('player-table-section').style.display = 'block';
  renderPlayerTable();
}

function sortPlayerTableBy(col) {
  if (playerSortCol === col) {
    playerSortDir = playerSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    playerSortCol = col;
    playerSortDir = NUMERIC_COLS.has(col) ? 'desc' : 'asc';
  }
  renderPlayerTable();
}

function filterPlayerTable(val) {
  playerFilter = val.toLowerCase();
  const clr = document.getElementById('player-filter-clear');
  if (clr) clr.hidden = !val;
  renderPlayerTable();
}

function clearPlayerFilter() {
  const input = document.getElementById('player-filter');
  if (input) input.value = '';
  playerFilter = '';
  const clr = document.getElementById('player-filter-clear');
  if (clr) clr.hidden = true;
  renderPlayerTable();
  if (input) input.focus();
}

function renderPlayerTable() {
  // Header visibility: a column shows when it's structurally present and the
  // user hasn't hidden it. Drives the matching cells via data-col below.
  document.querySelectorAll('#player-table thead th[data-col]').forEach(th => {
    const col = th.dataset.col;
    th.style.display = (colApplicable(col) && !hiddenCols.has(col)) ? '' : 'none';
  });
  let rows = playerTableData;

  if (playerFilter) {
    rows = rows.filter(d =>
      d.nick.toLowerCase().includes(playerFilter) ||
      d.guild.toLowerCase().includes(playerFilter) ||
      d.cls.toLowerCase().includes(playerFilter)
    );
  }

  rows = [...rows].sort((a, b) => {
    const av = a[playerSortCol];
    const bv = b[playerSortCol];
    if (NUMERIC_COLS.has(playerSortCol)) {
      const an = Number(av), bn = Number(bv);
      // Undefined deltas (new players) are NaN — keep them at the bottom in
      // both sort directions rather than letting NaN scramble the order.
      const aNan = Number.isNaN(an), bNan = Number.isNaN(bn);
      if (aNan || bNan) return aNan === bNan ? 0 : aNan ? 1 : -1;
      return playerSortDir === 'asc' ? an - bn : bn - an;
    }
    const cmp = String(av).localeCompare(String(bv));
    return playerSortDir === 'asc' ? cmp : -cmp;
  });

  document.querySelectorAll('#player-table thead th.sortable').forEach(th => {
    const icon = th.querySelector('.sort-icon');
    if (!icon) return;
    const isActive = th.dataset.col === playerSortCol;
    icon.textContent = isActive ? (playerSortDir === 'asc' ? '↑' : '↓') : '↕';
    icon.className = 'sort-icon' + (isActive ? ' active' : '');
    th.setAttribute('aria-sort', isActive ? (playerSortDir === 'asc' ? 'ascending' : 'descending') : 'none');
  });

  playerRowsSorted = rows;
  // data-col on every cell keeps it aligned with its header for hide/show; the
  // inline display:none mirrors a user-hidden column without a second DOM pass.
  const td = (col, extra, content) =>
    `<td data-col="${col}" style="${hiddenCols.has(col) ? 'display:none;' : ''}${extra}">${content}</td>`;
  const histApplies = colApplicable('histDelta');
  const pointsApply = colApplicable('points');
  const projGwApplies = colApplicable('projGwPoints');
  // One innerHTML assignment for the whole body (not a parse per row).
  const out = [];
  rows.slice(0, playerRowLimit).forEach((d, i) => {
    const color = getColor(d, 'guild');
    // Mirror the chart's player-search dim; flag likely sandbaggers with a row tint.
    const cls = [];
    if (searchQuery && d.nick.toLowerCase().includes(searchQuery)) cls.push('search-hit');
    if (d.sandbag) cls.push('sandbag-row');
    const nickHref = `https://mapleidle.gg/characters/bera/${encodeURIComponent(d.nick)}`;
    const guildHref = `https://mapleidle.gg/guild/bera/${encodeURIComponent(d.guild)}`;
    let html =
      td('rank', 'text-align:right', d.rank) +
      td('nick', '', `<a class="tlink" href="${nickHref}" target="_blank" rel="noopener">${d.nick}</a>`) +
      td('guild', '', `<span class="p-swatch" style="background:${color}"></span><a class="tlink" href="${guildHref}" target="_blank" rel="noopener">${d.guild}</a>`) +
      td('cls', '', d.cls) +
      td('level', 'text-align:right', d.level) +
      // Score/CP keep their own colour; the % change (when there's history)
      // rides alongside in green/red.
      td('cp', 'text-align:right', d.cpShort + (hasHistory ? fmtPct(d.dCpPct) : '')) +
      scoreCellHtml(d) +
      td('fitDiff', `text-align:right;color:${fitDiffColor(d.fitDiff)}`, fitDiffText(d.fitDiff));
    if (histApplies)
      html += td('histDelta', `text-align:right;color:${histDeltaColor(d)}`, histDeltaText(d));
    if (custom.A !== null)
      html += td('customFitDiff', `text-align:right;color:${fitDiffColor(d.customFitDiff ?? 0)}`, d.customFitDiff !== undefined ? fitDiffText(d.customFitDiff) : '—');
    if (pointsApply)
      html += td('points', 'text-align:right', d.points ? d.points.toLocaleString() : '—');
    if (projGwApplies)
      html += td('projGwPoints', 'text-align:right', projGwText(d));
    // data-i ties the row back to playerRowsSorted for the Score-cell click, so
    // no nick-escaping into attributes is needed.
    out.push(`<tr data-i="${i}"${cls.length ? ` class="${cls.join(' ')}"` : ''}>${html}</tr>`);
  });
  document.getElementById('player-body').innerHTML = out.join('');
  renderPlayerMore(rows.length);
}

// "Showing N of M" + Show more / Show all (or Show first N once expanded) under
// the player table; hidden when the whole list fits in one page.
function renderPlayerMore(total) {
  const el = document.getElementById('player-more');
  if (total <= PLAYER_PAGE) { el.hidden = true; return; }
  const shown = Math.min(total, playerRowLimit);
  el.hidden = false;
  el.innerHTML = `<span>Showing ${shown.toLocaleString()} of ${total.toLocaleString()} players</span>` +
    (shown < total
      ? `<button class="file-btn" type="button" onclick="setPlayerRowLimit(${playerRowLimit + PLAYER_PAGE})">Show ${Math.min(PLAYER_PAGE, total - shown)} more</button>` +
        `<button class="file-btn" type="button" onclick="setPlayerRowLimit(Infinity)">Show all</button>`
      : `<button class="file-btn" type="button" onclick="setPlayerRowLimit(PLAYER_PAGE)">Show first ${PLAYER_PAGE}</button>`);
}

function setPlayerRowLimit(n) {
  const collapsing = n < playerRowLimit;
  playerRowLimit = n;
  renderPlayerTable();
  // Collapsing from far down the list would strand the viewer below the table.
  if (collapsing) document.getElementById('player-more').scrollIntoView({ block: 'nearest' });
}

// Raise the row cap until the first row matching `pred` (in the current sort and
// filter order) is rendered, so player search can scroll to it on Enter.
function revealPlayerRow(pred) {
  const i = playerRowsSorted.findIndex(pred);
  if (i < playerRowLimit) return;
  playerRowLimit = Math.ceil((i + 1) / PLAYER_PAGE) * PLAYER_PAGE;
  renderPlayerTable();
}

// "vs History" cell: how this week's performance compares to the player's recency-
// weighted norm. Sandbaggers (notably below) get a ⚠ and red; absent history → —.
function histDeltaColor(d) {
  if (d.histDelta == null) return 'var(--text-dim)';
  if (d.sandbag) return '#f87171';
  return d.histDelta >= 0 ? '#4ade80' : '#facc15';
}
function histDeltaText(d) {
  if (d.histDelta == null) return '—';
  return (d.sandbag ? '⚠ ' : '') + (d.histDelta > 0 ? '+' : '') + d.histDelta.toFixed(1) + '%';
}

// "Proj GW Pts" cell: projected GW points after absentees are inserted, with the
// signed change vs the player's actual points alongside.
function projGwText(d) {
  if (d.projGwPoints == null) return '—';
  const delta = d.projGwPoints - (d.points || 0);
  const tag = delta ? ` <span style="color:${delta > 0 ? '#4ade80' : '#f87171'}">(${delta > 0 ? '+' : ''}${delta.toLocaleString()})</span>` : '';
  return d.projGwPoints.toLocaleString() + tag;
}

// ── Manual score overrides ("predict the final score") ──────────────────────
// Some players intentionally submit low scores to hide their true total until
// the last minute. Overriding a Score in the player table re-ranks the whole
// dataset, re-points the GW/GC Points, and refits the regression so the fit
// line / stats / "vs Fit" reflect the predicted standings. Overrides are scoped
// to the current sheet and persisted in localStorage, so a page refresh keeps
// them — but an override is retired once that player's real score actually
// updates (see restoreStoredOverrides). See [[win-prediction-mapleidle]] for the
// related projection.

let scoreOverrides = {};      // nick -> overridden score (number)
let overridesActive = false;  // true once a snapshot is taken (drives Clear button)

// Build the Score cell — editable, and badged when overridden.
function scoreCellHtml(d) {
  const hidden = hiddenCols.has('score') ? 'display:none;' : '';
  if (d.scoreOverride) {
    const orig = d.scoreShortOrig != null ? d.scoreShortOrig : '?';
    return `<td data-col="score" class="score-cell score-overridden" style="${hidden}text-align:right"` +
           ` title="Manually set — original ${orig}. Click to change.">` +
           `${d.scoreShort}<span class="ovr-badge">✎</span></td>`;
  }
  return `<td data-col="score" class="score-cell" style="${hidden}text-align:right"` +
         ` title="Click to set a predicted score">` +
         `${d.scoreShort}${hasHistory ? fmtPct(d.dScorePct) : ''}</td>`;
}

// Accepts a raw number ("1900000000"), scientific notation ("1.9e15"), or gaming
// notation ("950B", "1.2T"). Returns NaN on anything unparseable.
function parseScoreInput(str) {
  str = String(str).trim().replace(/,/g, '');
  if (!str) return NaN;
  const m = str.match(/^([\d.]+(?:e[+-]?\d+)?)\s*(k|m|b|t)?$/i);
  if (!m) return NaN;
  const v = parseFloat(m[1]);
  if (!isFinite(v)) return NaN;
  const mult = { '': 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[(m[2] || '').toLowerCase()];
  return v * mult;
}

// Turn a Score cell into an inline input. Enter / blur commits, Esc cancels.
function beginScoreEdit(td, d) {
  if (td.querySelector('input')) return;  // already editing this cell
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'score-input';
  input.value = String(d.score);
  input.setAttribute('aria-label', `Predicted score for ${d.nick}`);
  input.placeholder = 'e.g. 1.9e15 or 950B';
  td.textContent = '';
  td.appendChild(input);
  input.focus();
  input.select();

  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const v = parseScoreInput(input.value);
    if (isFinite(v) && v > 0) setScoreOverride(d, v);
    else renderPlayerTable();  // invalid → restore the cell as-is
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')       { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); done = true; renderPlayerTable(); }
  });
  input.addEventListener('blur', commit);
}

// Snapshot the pristine score/rank for every row once, so Clear can restore the
// exact original ranking (ties and all) rather than re-deriving it.
function ensureOverrideSnapshot() {
  if (overridesActive) return;
  overridesActive = true;
  currentData.forEach(d => {
    d.scoreOrig = d.score;
    d.rankOrig = d.rank;
    d.scoreShortOrig = d.scoreShort;
  });
  updateOverrideUI();
}

// Re-derive rank from score (descending) after a score override. Ranks are
// client-assigned 1..N (see assignRanks in chart.js), so an override simply
// renumbers the population in its new order — the set of places is unchanged,
// which keeps the rank→GW-points lookup aligned and conserves total GW points.
// (GC totals can move: a GC tier also hangs on the overridden score itself.)
function recomputeRanks(data) {
  [...data].sort((a, b) => b.score - a.score).forEach((d, i) => { d.rank = i + 1; });
}

// Apply the override map onto the pristine snapshot, then re-rank + re-point.
function applyScoreOverrides() {
  currentData.forEach(d => {
    if (scoreOverrides[d.nick] != null) {
      d.score = scoreOverrides[d.nick];
      d.scoreShort = toGamingNotation(d.score);
      d.scoreOverride = true;
    } else {
      d.score = d.scoreOrig;
      d.scoreShort = d.scoreShortOrig;
      d.scoreOverride = false;
    }
  });
  recomputeRanks(currentData);
  joinPoints(currentData);     // points follow the new ranking (and, for GC, the new score)
}

function setScoreOverride(d, value) {
  ensureOverrideSnapshot();
  if (value === d.scoreOrig) delete scoreOverrides[d.nick];
  else                       scoreOverrides[d.nick] = value;
  if (!Object.keys(scoreOverrides).length) { clearScoreOverrides(); return; }
  applyScoreOverrides();
  rerenderAfterOverride();
  saveOverridesToStorage();
}

// Restore the snapshotted originals on `data` and drop the override markers.
function restoreOriginals(data) {
  data.forEach(d => {
    if (d.scoreOrig !== undefined)      { d.score = d.scoreOrig;           delete d.scoreOrig; }
    if (d.rankOrig !== undefined)       { d.rank = d.rankOrig;             delete d.rankOrig; }
    if (d.scoreShortOrig !== undefined) { d.scoreShort = d.scoreShortOrig; delete d.scoreShortOrig; }
    delete d.scoreOverride;
  });
}

function clearScoreOverrides() {
  if (!overridesActive) return;
  restoreOriginals(currentData);
  scoreOverrides = {};
  overridesActive = false;
  joinPoints(currentData);     // ranks + scores restored → points back to originals
  rerenderAfterOverride();
  updateOverrideUI();
  saveOverridesToStorage();    // empty map → removes the stored entry for this sheet
}

// Shared post-override refresh: refit the regression on the overridden scores so
// the fit line, stats cards, and "vs Fit" follow the predicted standings; refresh
// sandbag flags; move the dots; and rebuild the pivot + player tables without
// disturbing the table's sort/filter. Clearing overrides runs this on the
// restored scores, so the fit returns to its original baseline.
function rerenderAfterOverride() {
  // computeFit re-derives frozenFit/activeFit, the CP bounds, the class bias, and
  // every row's fit (and custom-fit) deviation from the now-current scores.
  const { A, B, r2, sigma } = computeFit(currentData);
  setStats(A, B, r2);
  annotateSandbag();
  clearPrediction();           // a win-prediction built on the old scores is stale
  closePanel();                // do this while the old dots still exist
  renderScatter(currentData, A, B, sigma);
  if (selectedGroups.size || searchQuery) applyHighlights();
  buildPivotTable(currentData);
  playerTableData = currentData;
  renderPlayerTable();
}

// Restore pristine data on the outgoing sheet and clear override state. Called
// from io.js before a new sheet/content/file is loaded so overrides never bleed
// across sheets or linger in the cached rows.
function resetScoreOverrides() {
  if (currentData && overridesActive) restoreOriginals(currentData);
  scoreOverrides = {};
  overridesActive = false;
  updateOverrideUI();
}

function updateOverrideUI() {
  const btn = document.getElementById('clear-overrides-btn');
  if (btn) btn.hidden = !overridesActive;
}

// ── Override persistence (localStorage, per content-type + sheet) ────────────
// Overrides survive a page refresh so a prediction isn't lost. Each entry stores
// the override value alongside the *source* score it was set against; on reload
// an override is re-applied only if that player's source score is unchanged. If
// the real score has since moved (the player revealed it / the sheet refreshed),
// the override is retired and the real value stands.

const OVR_STORAGE_PREFIX = 'shoes:overrides:';

function ovrStorageKey() {
  return OVR_STORAGE_PREFIX + currentContentType + '|' + currentSheet;
}

function saveOverridesToStorage() {
  if (!currentContentType || !currentSheet) return;
  try {
    const key = ovrStorageKey();
    const nicks = Object.keys(scoreOverrides);
    if (!nicks.length) { localStorage.removeItem(key); return; }
    const payload = {};
    currentData.forEach(d => {
      if (scoreOverrides[d.nick] != null) {
        payload[d.nick] = { score: scoreOverrides[d.nick], base: d.scoreOrig };
      }
    });
    localStorage.setItem(key, JSON.stringify(payload));
  } catch (e) { /* storage disabled/full — overrides just won't persist */ }
}

// Re-apply persisted overrides for the current sheet onto `data` (called from
// buildChart after joinPoints, before the fit/render, so a single pass reflects
// them). Resets in-memory override state first, then prunes stale entries.
function restoreStoredOverrides(data) {
  scoreOverrides = {};
  overridesActive = false;
  if (!currentContentType || !currentSheet) { updateOverrideUI(); return; }

  let stored;
  try {
    const raw = localStorage.getItem(ovrStorageKey());
    stored = raw ? JSON.parse(raw) : null;
  } catch (e) { stored = null; }
  if (!stored || typeof stored !== 'object') { updateOverrideUI(); return; }

  const byNick = new Map(data.map(d => [d.nick, d]));
  const valid = {};
  let pruned = false;
  Object.keys(stored).forEach(nick => {
    const e = stored[nick];
    const d = byNick.get(nick);
    // Keep only if the player is still present and their source score matches the
    // value the override was set against (i.e. the real score hasn't updated).
    if (d && e && typeof e.score === 'number' && d.score === e.base) valid[nick] = e.score;
    else pruned = true;
  });

  const nicks = Object.keys(valid);
  if (nicks.length) {
    ensureOverrideSnapshot();   // snapshots scoreOrig/rankOrig on currentData (=== data)
    nicks.forEach(n => { scoreOverrides[n] = valid[n]; });
    applyScoreOverrides();      // sets scores/marks, re-ranks, re-points
  }
  updateOverrideUI();
  if (pruned) saveOverridesToStorage();  // persist the pruned set so storage self-heals
}
