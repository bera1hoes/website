// ── Pivot table + player table ─────────────────────────────────────────────

let playerTableData = [];
let playerSortCol = 'rank';
let playerSortDir = 'asc';
let playerFilter = '';
const NUMERIC_COLS = new Set(['rank', 'level', 'cp', 'score', 'fitDiff', 'customFitDiff', 'gwPoints']);

// ── Column visibility ───────────────────────────────────────────────────────
// Columns the user can hide via the "Columns" menu (Rank/Nick/Score stay on as
// the identity columns). `hiddenCols` persists across sheet switches.
const TOGGLEABLE_COLS = ['guild', 'cls', 'level', 'cp', 'fitDiff', 'customFitDiff', 'gwPoints'];
let hiddenCols = new Set();

// Whether a column is structurally present right now (independent of the user's
// hide choice): custom fit and GW points only exist in some states.
function colApplicable(col) {
  if (col === 'customFitDiff') return custom.A !== null;
  if (col === 'gwPoints')      return currentContentType === 'Guild Wars';
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

function buildPivotTable(data) {
  const section = document.getElementById('pivot-section');
  const isGW = currentContentType === 'Guild Wars';

  if (isGW) {
    const hasPoints = data.some(d => d.gwPoints > 0);
    if (!hasPoints) { section.style.display = 'none'; return; }
    document.getElementById('pivot-eyebrow').textContent = 'Guild War Points';
    document.getElementById('pivot-th-total').textContent = 'Total GW Points';
    document.getElementById('pivot-th-avg').textContent = 'Avg GW Points';
  } else {
    document.getElementById('pivot-eyebrow').textContent = currentContentType + ' Score';
    document.getElementById('pivot-th-total').textContent = 'Total Score';
    document.getElementById('pivot-th-avg').textContent = 'Avg Score';
  }

  const guilds = {};
  data.forEach(d => {
    if (!guilds[d.guild]) guilds[d.guild] = { count: 0, total: 0 };
    guilds[d.guild].count++;
    guilds[d.guild].total += isGW ? (d.gwPoints || 0) : (d.score || 0);
  });

  const rows = Object.entries(guilds).sort((a, b) => b[1].total - a[1].total);
  const grandTotal = rows.reduce((s, [, g]) => s + g.total, 0);

  const fmt = isGW
    ? v => Math.round(v).toLocaleString()
    : v => {
        if (v >= 1e9) return (v / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
        if (v >= 1e6) return (v / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
        return Math.round(v).toLocaleString();
      };

  const tbody = document.getElementById('pivot-body');
  tbody.innerHTML = '';
  rows.forEach(([guild, { count, total }]) => {
    const color = GUILD_COLORS[guild] || GUILD_COLORS['default'];
    const avg = total / count;
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td><span class="p-swatch" style="background:${color}"></span><a class="tlink" href="https://mapleidle.gg/guild/bera/${encodeURIComponent(guild)}" target="_blank" rel="noopener">${guild}</a></td>` +
      `<td>${count}</td>` +
      `<td>${fmt(total)}</td>` +
      `<td>${fmt(avg)}</td>`;
    tbody.appendChild(tr);
  });

  const totalTr = document.createElement('tr');
  totalTr.className = 'pivot-total-row';
  totalTr.innerHTML =
    `<td>All guilds</td>` +
    `<td>${data.length}</td>` +
    `<td>${fmt(grandTotal)}</td>` +
    `<td>${fmt(grandTotal / data.length)}</td>`;
  tbody.appendChild(totalTr);

  section.style.display = 'block';
}

function buildPlayerTable(data) {
  playerTableData = data;
  playerSortCol = 'rank';
  playerSortDir = 'asc';
  playerFilter = '';
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

  const tbody = document.getElementById('player-body');
  tbody.innerHTML = '';
  // data-col on every cell keeps it aligned with its header for hide/show; the
  // inline display:none mirrors a user-hidden column without a second DOM pass.
  const td = (col, extra, content) =>
    `<td data-col="${col}" style="${hiddenCols.has(col) ? 'display:none;' : ''}${extra}">${content}</td>`;
  rows.forEach(d => {
    const color = getColor(d, 'guild');
    const tr = document.createElement('tr');
    // Mirror the chart's player-search dim: emphasise matching rows here.
    if (searchQuery && d.nick.toLowerCase().includes(searchQuery)) tr.className = 'search-hit';
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
      td('score', 'text-align:right', d.scoreShort + (hasHistory ? fmtPct(d.dScorePct) : '')) +
      td('fitDiff', `text-align:right;color:${fitDiffColor(d.fitDiff)}`, fitDiffText(d.fitDiff));
    if (custom.A !== null)
      html += td('customFitDiff', `text-align:right;color:${fitDiffColor(d.customFitDiff ?? 0)}`, d.customFitDiff !== undefined ? fitDiffText(d.customFitDiff) : '—');
    if (currentContentType === 'Guild Wars')
      html += td('gwPoints', 'text-align:right', d.gwPoints ? d.gwPoints.toLocaleString() : '—');
    tr.innerHTML = html;
    tbody.appendChild(tr);
  });
}
