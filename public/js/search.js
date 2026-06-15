// ── Player search (chart highlight) ─────────────────────────────────────────
// Typing in the controls-bar search box dims every dot whose nick doesn't match
// the query. The dim is implemented in dotResting (legend.js), the single
// source of truth shared by applyHighlights and the hover/pin restore in
// chart.js — so hovering or pinning a dot can never undo a search dim. Search
// is transient (not encoded in the deep link); it composes with legend
// selection (a dot must pass both tests to stay lit).

let searchQuery = '';

function onPlayerSearch(value) {
  searchQuery = value.trim().toLowerCase();
  const clr = document.getElementById('player-search-clear');
  if (clr) clr.hidden = !value;
  if (!currentData) return;
  applyHighlights();
  renderPlayerTable();   // re-tag matching rows (.search-hit) in the table
  // Pin only when the query is an exact, unique nick match — never on every
  // keystroke. Enter (onPlayerSearchEnter) handles partial-but-unique matches.
  if (searchQuery) {
    const exact = currentData.filter(d => d.nick.toLowerCase() === searchQuery);
    if (exact.length === 1) pinPlayerByName(exact[0].nick);
  }
}

// Enter pins the match when the query resolves to a single player (an exact
// nick wins; otherwise a lone substring match).
function onPlayerSearchEnter() {
  if (!searchQuery || !currentData) return;
  const matches = currentData.filter(d => d.nick.toLowerCase().includes(searchQuery));
  const exact = matches.find(d => d.nick.toLowerCase() === searchQuery);
  const target = exact || (matches.length === 1 ? matches[0] : null);
  if (target) pinPlayerByName(target.nick);
  // Bring the first highlighted row into view so a match far down the table
  // isn't missed (only on Enter — never while typing, which would be jarring).
  const hit = document.querySelector('#player-body tr.search-hit');
  if (hit) hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function clearPlayerSearch() {
  const input = document.getElementById('player-search');
  if (input) input.value = '';
  searchQuery = '';
  const clr = document.getElementById('player-search-clear');
  if (clr) clr.hidden = true;
  if (currentData) { applyHighlights(); renderPlayerTable(); }
  if (input) input.focus();
}
