// ── Player history (week-over-week deltas) ──────────────────────────────────
// Each sheet is a dated snapshot. After a sheet renders, we also pull the
// *previous* date's rows, join by nick, and annotate the current rows with
// dScore / dCp (with % change) so the player table and info panel show movement.
// Players absent from the previous sheet (new, or renamed) get no deltas.
//
// Runs fire-and-forget after buildChart (io.js): a history failure must never
// block the chart. `hasHistory` gates the delta columns/rows in tables.js and
// panel.js; it's false on the oldest sheet (no previous) or before the join.

let hasHistory = false;
let prevSheetLabel = null;

// Newest-first ordering: applySheetNames / populateLocalSheets put the latest
// sheet at index 0, so the "previous" sheet is the next one down the list.
function sheetNameList() {
  if (IS_LOCAL) return Object.keys(getLocalData(currentContentType));
  return sheetNamesCache[currentContentType] || [];
}

function prevSheetName() {
  const names = sheetNameList();
  const i = names.indexOf(currentSheet);
  return (i >= 0 && i + 1 < names.length) ? names[i + 1] : null;
}

// Parsed rows for a sheet, from cache or a remote fetch. Local sheets are all
// pre-parsed into localFiles up front; in legacy GAS mode we only use what's
// already cached (no prefetch). Returns a Promise resolving to rows or null.
function getSheetRows(name) {
  const cached = (localFiles[currentContentType] || {})[name];
  if (cached) return Promise.resolve(cached);
  if (IS_LOCAL || HAS_GAS) return Promise.resolve(null);
  return apiCall('getData', { contentType: currentContentType, sheet: name }).then(json => {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json;
    const rows = rowsOf(parsed);
    if (!localFiles[currentContentType]) localFiles[currentContentType] = {};
    localFiles[currentContentType][name] = rows;
    if (!rostersCache[currentContentType]) rostersCache[currentContentType] = {};
    rostersCache[currentContentType][name] = rostersOf(parsed);
    if (!perfCache[currentContentType]) perfCache[currentContentType] = {};
    perfCache[currentContentType][name] = perfOf(parsed);
    return rows;
  });
}

function clearHistory() {
  hasHistory = false;
  prevSheetLabel = null;
  if (currentData) currentData.forEach(d => {
    delete d.dScore; delete d.dCp; delete d.dScorePct; delete d.dCpPct;
  });
}

// Annotate currentData with deltas vs the previous sheet, then refresh the
// table and the pinned panel (if any). Safe to call on every sheet load.
function loadHistory() {
  clearHistory();
  const prev = prevSheetName();
  const dataAtCall = currentData;
  if (!prev) { renderPlayerTable(); refreshPanelHistory(); return Promise.resolve(); }
  return getSheetRows(prev).then(prevRows => {
    // Bail if the user switched sheets while the previous sheet was fetching.
    if (!prevRows || currentData !== dataAtCall) return;
    const prevByNick = new Map(prevRows.map(d => [d.nick, d]));
    currentData.forEach(d => {
      const p = prevByNick.get(d.nick);
      if (!p) return;             // new player → deltas stay undefined
      d.dScore = d.score - p.score;
      d.dCp    = d.cp - p.cp;
      d.dScorePct = p.score ? (d.dScore / p.score) * 100 : undefined;
      d.dCpPct    = p.cp    ? (d.dCp    / p.cp)    * 100 : undefined;
    });
    hasHistory = true;
    prevSheetLabel = prev;
    renderPlayerTable();
    refreshPanelHistory();
  }).catch(err => { console.warn('history load failed:', err); });
}

// ── Delta formatting ────────────────────────────────────────────────────────
// The Score/CP value stays its own colour; only the percentage change rides
// alongside it in green (up) / red (down). Returns an HTML fragment (empty when
// there's no history or the player is new) to append after the value.

function fmtPct(pct) {
  if (pct === undefined || !isFinite(pct)) return '';
  const color = pct > 0 ? '#4ade80' : pct < 0 ? '#f87171' : 'var(--text-muted)';
  const sign  = pct > 0 ? '+' : pct < 0 ? '−' : '±';
  return `<span style="color:${color}"> (${sign}${Math.abs(pct).toFixed(1)}%)</span>`;
}

// ── Info-panel: append the % change after the SCORE / CP values ──────────────

function setPanelHistory(d) {
  const sd = document.getElementById('p-score-delta');
  const cd = document.getElementById('p-cp-delta');
  if (sd) sd.innerHTML = hasHistory ? fmtPct(d.dScorePct) : '';
  if (cd) cd.innerHTML = hasHistory ? fmtPct(d.dCpPct) : '';
}

function refreshPanelHistory() {
  if (isPinned && activeEl) setPanelHistory(d3.select(activeEl).datum());
}
