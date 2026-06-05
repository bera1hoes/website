// ── Pivot table + player table ─────────────────────────────────────────────

let playerTableData = [];
let playerSortCol = 'rank';
let playerSortDir = 'asc';
let playerFilter = '';
const NUMERIC_COLS = new Set(['rank', 'level', 'cp', 'score', 'fitDiff', 'customFitDiff', 'gwPoints']);

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

  document.querySelectorAll('#player-table thead th.sortable').forEach(th => {
    th.onclick = () => sortPlayerTableBy(th.dataset.col);
    th.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortPlayerTableBy(th.dataset.col); }
    };
  });

  const gwCol = document.getElementById('player-th-gwpoints');
  if (gwCol) gwCol.style.display = currentContentType === 'Guild Wars' ? '' : 'none';

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
  renderPlayerTable();
}

function renderPlayerTable() {
  const customCol = document.getElementById('player-th-customfit');
  if (customCol) customCol.style.display = custom.A !== null ? '' : 'none';
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
    const cmp = NUMERIC_COLS.has(playerSortCol)
      ? Number(av) - Number(bv)
      : String(av).localeCompare(String(bv));
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
  rows.forEach(d => {
    const color = getColor(d, 'guild');
    const tr = document.createElement('tr');
    const nickHref = `https://mapleidle.gg/characters/bera/${encodeURIComponent(d.nick)}`;
    const guildHref = `https://mapleidle.gg/guild/bera/${encodeURIComponent(d.guild)}`;
    tr.innerHTML =
      `<td style="text-align:right">${d.rank}</td>` +
      `<td><a class="tlink" href="${nickHref}" target="_blank" rel="noopener">${d.nick}</a></td>` +
      `<td><span class="p-swatch" style="background:${color}"></span><a class="tlink" href="${guildHref}" target="_blank" rel="noopener">${d.guild}</a></td>` +
      `<td>${d.cls}</td>` +
      `<td style="text-align:right">${d.level}</td>` +
      `<td style="text-align:right">${d.cpShort}</td>` +
      `<td style="text-align:right">${d.scoreShort}</td>` +
      `<td style="text-align:right;color:${fitDiffColor(d.fitDiff)}">${fitDiffText(d.fitDiff)}</td>` +
      (custom.A !== null ? `<td style="text-align:right;color:${fitDiffColor(d.customFitDiff ?? 0)}">${d.customFitDiff !== undefined ? fitDiffText(d.customFitDiff) : '—'}</td>` : '') +
      (currentContentType === 'Guild Wars' ? `<td style="text-align:right">${d.gwPoints ? d.gwPoints.toLocaleString() : '—'}</td>` : '');
    tbody.appendChild(tr);
  });
}
