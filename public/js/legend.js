// ── Color mode + legend + highlighting ─────────────────────────────────────

let colorMode = 'guild';
let selectedGroups = new Set();

// Whole-world sheets (Guild Conquest) carry hundreds of guilds, so those content
// types open with our guild alone lit and everyone else greyed out, instead of a
// cloud of recycled palette colours. Legend clicks change it as usual.
const HOME_GUILD = 'hoes';
const HOME_ONLY_TYPES = ['Guild Conquest'];

function homeOnlyDefault() {
  return colorMode === 'guild' && HOME_ONLY_TYPES.includes(currentContentType);
}

// Seed a freshly-cleared selection with the content type's default (a no-op
// unless homeOnlyDefault, or when the sheet has none of our guild in it).
function applyDefaultSelection(data) {
  if (homeOnlyDefault() && data.some(d => d.guild === HOME_GUILD)) selectedGroups.add(HOME_GUILD);
}

function setColorMode(mode) {
  colorMode = mode;
  document.getElementById('btn-guild').classList.toggle('active', mode === 'guild');
  document.getElementById('btn-class').classList.toggle('active', mode === 'class');
  if (currentData) {
    // Groups are per mode (guild names vs classes), so the selection starts over.
    selectedGroups.clear();
    applyDefaultSelection(currentData);
    buildLegend(currentData);
    applyHighlights();  // repaint every dot in the new mode (keeps a search dim)
  }
  updateDeepLink();
}

// Resting appearance of a dot under the current highlight/filter state. When a
// group is selected, dots outside it are dimmed to grey; otherwise each dot
// shows its real color. Dimmed dots drop their outline: thousands of opaque grey
// rims (a whole-world sheet) merge into a solid mass that hides the fit line and
// band. Shared by applyHighlights and the hover/click restore in chart.js so
// restoring a dot never undoes the active dim.
function dotResting(d) {
  const key = colorMode === 'guild' ? 'guild' : 'cls';
  const groupDimmed  = selectedGroups.size > 0 && !selectedGroups.has(d[key]);
  const searchDimmed = searchQuery && !d.nick.toLowerCase().includes(searchQuery);
  return (groupDimmed || searchDimmed)
    ? { color: '#6b7280', opacity: 0.16, strokeOpacity: 0, dim: true }
    : { color: getColor(d, colorMode), opacity: 0.75, strokeOpacity: 1, dim: false };
}

// Put a dot element in its resting look and file it into the dim or lit layer
// (chart.js), so a highlighted dot always draws above the greyed-out ones.
function restDot(el, d) {
  const rest = dotResting(d);
  d3.select(el).attr('r', 5).attr('stroke-width', 1)
    .attr('fill', rest.color).attr('stroke', rest.color)
    .attr('fill-opacity', rest.opacity).attr('stroke-opacity', rest.strokeOpacity);
  const layer = (rest.dim ? dotsDim : dotsLit).node();
  if (el.parentNode !== layer) layer.appendChild(el);
}

// Toggle one group in the legend selection and repaint. Shared by a legend
// click and a pick from the legend search.
function toggleGroup(label) {
  if (selectedGroups.has(label)) selectedGroups.delete(label);
  else selectedGroups.add(label);
  applyHighlights();
  updateDeepLink();
}

function applyHighlights() {
  // The pinned dot keeps its emphasis and its place on top (see pinDot): dots
  // re-filed into the lit layer land after it, so lift it back above them.
  d3.selectAll('.dot').each(function(d) { if (this !== activeEl) restDot(this, d); });
  if (activeEl) dotsLit.node().appendChild(activeEl);
  const has = selectedGroups.size > 0;
  document.querySelectorAll('.legend-item[data-group]').forEach(el => {
    el.classList.toggle('dimmed', has && !selectedGroups.has(el.dataset.group));
  });
}

// ── Legend ─────────────────────────────────────────────────────────────────

let _legendDelegated = false;

// Past this many groups the legend lists only the biggest (same order as the
// pivot table) plus anything selected, behind a "+N more" toggle — a whole-world
// sheet's full guild list pushed the chart a screen down.
const LEGEND_MAX = 15;
let legendExpanded = false;

function toggleLegend() {
  legendExpanded = !legendExpanded;
  if (currentData) buildLegend(currentData);
}

function buildLegend(data) {
  const palette = colorMode === 'guild' ? GUILD_COLORS : CLASS_COLORS;
  const key = colorMode === 'guild' ? 'guild' : 'cls';
  let seen = [...new Set(data.map(d => d[key]))].sort();
  const groupCount = seen.length;
  const many = groupCount > LEGEND_MAX;
  legendIndex = [];
  if (many) {
    const pts = !!POINTS_LABELS[currentContentType];
    const total = {}, count = {};
    data.forEach(d => {
      const g = d[key];
      total[g] = (total[g] || 0) + ((pts ? d.points : d.score) || 0);
      count[g] = (count[g] || 0) + 1;
    });
    seen.sort((a, b) => total[b] - total[a]);
    legendIndex = seen.map((label, i) => ({ label, rank: i + 1, count: count[label] }));
    if (!legendExpanded) {
      const top = seen.slice(0, LEGEND_MAX);
      selectedGroups.forEach(g => { if (g in total && !top.includes(g)) top.push(g); });
      seen = top;
    }
  }
  const has = selectedGroups.size > 0;

  const lg = document.getElementById('legend');
  lg.innerHTML = '';

  // One delegated click handler for the whole legend — survives rebuilds, so we
  // don't attach a fresh listener per item on every render.
  if (!_legendDelegated) {
    lg.addEventListener('click', e => {
      const item = e.target.closest('.legend-item[data-group]');
      if (item) toggleGroup(item.dataset.group);
    });
    _legendDelegated = true;
  }

  const fitItem = document.createElement('div');
  fitItem.className = 'legend-item';
  fitItem.innerHTML = '<div class="legend-line"></div><span>Power fit</span>';
  lg.appendChild(fitItem);

  const bandItem = document.createElement('div');
  bandItem.className = 'legend-item';
  bandItem.innerHTML = '<div class="legend-band"></div><span>±1σ band (~68%)</span>';
  lg.appendChild(bandItem);

  seen.forEach(label => {
    const color = palette[label] || palette['default'];
    const item = document.createElement('div');
    item.className = 'legend-item clickable' + (has && !selectedGroups.has(label) ? ' dimmed' : '');
    item.dataset.group = label;
    item.innerHTML = `<div class="legend-dot" style="background:${color};border:1.5px solid ${color}"></div><span style="color:var(--text-dim)">${label}</span>`;
    lg.appendChild(item);
  });

  if (many) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'legend-more';
    more.setAttribute('aria-expanded', String(legendExpanded));
    more.textContent = legendExpanded ? 'Show fewer' : `+${groupCount - seen.length} more`;
    more.addEventListener('click', toggleLegend);
    lg.appendChild(more);
  }

  // The search box only earns its place on a collapsible legend; whatever it
  // was showing belongs to the previous data, so it closes either way.
  const input = $id('legend-search-input');
  $id('legend-search').hidden = !many;
  input.placeholder = colorMode === 'guild' ? 'Find guild…' : 'Find class…';
  if (!many) input.value = '';
  closeLegendSearch();
}

// ── Legend search ──────────────────────────────────────────────────────────
// A collapsed legend hides most groups, so a "Find guild…" box beside it finds
// any of them by name. Typing lists matches (prefix matches first, then
// substrings, each in legend order, with rank and player count). ↑/↓ moves,
// Enter or a click toggles the group exactly like a legend click, and the box
// clears for the next search. A group picked from beyond the collapsed list
// joins it, since selected groups always show. The box sits outside #legend
// (Charts.html) so legend rebuilds never take its focus or text.

const LEGEND_SEARCH_MAX = 8;
let legendIndex = [];    // every group in legend order: { label, rank, count } (set by buildLegend)
let legendMatches = [];  // the options on show
let legendActive = 0;    // keyboard-highlighted option

function onLegendSearch(value) {
  const q = value.trim().toLowerCase();
  if (!q) { closeLegendSearch(); return; }
  const prefix = [], inner = [];
  legendIndex.forEach(g => {
    const at = g.label.toLowerCase().indexOf(q);
    if (at === 0) prefix.push(g);
    else if (at > 0) inner.push(g);
  });
  legendMatches = prefix.concat(inner).slice(0, LEGEND_SEARCH_MAX);
  legendActive = 0;
  renderLegendSearch(q);
}

function renderLegendSearch(q) {
  const list = $id('legend-search-list');
  const input = $id('legend-search-input');
  const palette = colorMode === 'guild' ? GUILD_COLORS : CLASS_COLORS;
  list.innerHTML = '';
  if (!legendMatches.length) {
    const li = document.createElement('li');
    li.className = 'legend-search-empty';
    li.textContent = 'No match';
    list.appendChild(li);
  }
  legendMatches.forEach((g, i) => {
    const on = selectedGroups.has(g.label);
    const li = document.createElement('li');
    li.id = 'legend-opt-' + i;
    li.className = 'legend-search-opt' + (i === legendActive ? ' active' : '') + (on ? ' on' : '');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(on));
    const dot = document.createElement('span');
    dot.className = 'legend-dot';
    dot.style.background = palette[g.label] || palette['default'];
    // Built from text nodes, not HTML, with the matched part marked.
    const name = document.createElement('span');
    name.className = 'legend-search-name';
    const at = g.label.toLowerCase().indexOf(q);
    const mark = document.createElement('mark');
    mark.textContent = g.label.slice(at, at + q.length);
    name.append(g.label.slice(0, at), mark, g.label.slice(at + q.length));
    const meta = document.createElement('span');
    meta.className = 'legend-search-meta';
    meta.textContent = `#${g.rank} · ${g.count}p`;
    li.append(dot, name, meta);
    // mousedown + preventDefault keeps focus in the input (no blur → no close).
    li.addEventListener('mousedown', e => { e.preventDefault(); pickLegendMatch(i); });
    li.addEventListener('mousemove', () => { if (legendActive !== i) setLegendActive(i); });
    list.appendChild(li);
  });
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  if (legendMatches.length) input.setAttribute('aria-activedescendant', 'legend-opt-' + legendActive);
  else input.removeAttribute('aria-activedescendant');
}

function setLegendActive(i) {
  legendActive = i;
  document.querySelectorAll('#legend-search-list .legend-search-opt').forEach((li, j) => {
    li.classList.toggle('active', j === i);
  });
  $id('legend-search-input').setAttribute('aria-activedescendant', 'legend-opt-' + i);
}

function pickLegendMatch(i) {
  const g = legendMatches[i];
  if (!g) return;
  toggleGroup(g.label);
  buildLegend(currentData);  // surface a group picked from beyond the collapsed list (also closes)
  $id('legend-search-input').value = '';
}

function onLegendSearchKey(e) {
  const open = !$id('legend-search-list').hidden && legendMatches.length > 0;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!open) return;
    e.preventDefault();
    const n = legendMatches.length;
    setLegendActive((legendActive + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
  } else if (e.key === 'Enter') {
    if (!open) return;
    e.preventDefault();
    pickLegendMatch(legendActive);
  } else if (e.key === 'Escape') {
    // First Esc clears the query; a second leaves the box.
    if (e.target.value) { e.target.value = ''; closeLegendSearch(); }
    else e.target.blur();
  }
}

function closeLegendSearch() {
  legendMatches = [];
  const list = $id('legend-search-list');
  list.hidden = true;
  list.innerHTML = '';
  const input = $id('legend-search-input');
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
}
