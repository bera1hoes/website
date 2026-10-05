// ── Info panel ─────────────────────────────────────────────────────────────
// `activeEl` is the clicked (pinned) dot element; `isPinned` tracks panel state.

let activeEl = null;
let isPinned = false;

function showPanel(cx, cy, d, pin) {
  isPinned = pin;
  const color = getColor(d, colorMode);
  document.getElementById('p-rank').textContent  = `RANK #${d.rank}`;
  document.getElementById('p-name').textContent  = d.nick;
  document.getElementById('p-cls').textContent   = d.cls;
  document.getElementById('p-score').innerHTML = d.scoreShort + (d.scoreOverride ? '<span class="ovr-badge">✎</span>' : '');
  document.getElementById('p-cp').textContent    = d.cpShort;
  document.getElementById('p-guild').innerHTML   = `<span class="p-swatch" style="background:${GUILD_COLORS[d.guild] || GUILD_COLORS['default']}"></span>${d.guild}`;
  applyFitDiff(document.getElementById('p-fitdiff'), d.fitDiff);
  const customRow = document.getElementById('p-customfit-row');
  if (custom.A !== null && d.customFitDiff !== undefined) {
    applyFitDiff(document.getElementById('p-customfitdiff'), d.customFitDiff);
    customRow.style.display = '';
  } else {
    customRow.style.display = 'none';
  }
  const ptsRow = document.getElementById('p-pts-row');
  if (d.points) {
    document.getElementById('p-pts-key').textContent = POINTS_LABELS[currentContentType].tag;
    document.getElementById('p-pts').textContent = d.points.toLocaleString() + (d.tier ? ` · ${d.tier}` : '');
    ptsRow.style.display = '';
  } else {
    ptsRow.style.display = 'none';
  }
  setPanelHistory(d);
  const panel = document.getElementById('panel');
  panel.style.display = 'block';
  panel.classList.toggle('pinned', pin);
  positionPanel(cx, cy);
}

function positionPanel(cx, cy) {
  const panel = document.getElementById('panel');
  const pw = panel.offsetWidth || 230;
  const ph = panel.offsetHeight || 180;
  const offset = 14;
  let x = cx + offset;
  let y = cy - ph / 2;
  if (x + pw > window.innerWidth - 8) x = cx - pw - offset;
  y = Math.max(8, Math.min(y, window.innerHeight - ph - 8));
  panel.style.left = x + 'px';
  panel.style.top  = y + 'px';
}

function closePanel() {
  isPinned = false;
  const panel = document.getElementById('panel');
  panel.style.display = 'none';
  panel.classList.remove('pinned');
  if (activeEl && currentData) {
    // Back to its resting look and layer (dimmed, if a selection/search dims it).
    const el = activeEl;
    activeEl = null;
    restDot(el, d3.select(el).datum());
  }
  updateDeepLink();
}
