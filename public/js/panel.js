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
  document.getElementById('p-score').textContent = d.scoreShort;
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
  const gwRow = document.getElementById('p-gwpts-row');
  if (d.gwPoints) {
    document.getElementById('p-gwpts').textContent = d.gwPoints.toLocaleString();
    gwRow.style.display = '';
  } else {
    gwRow.style.display = 'none';
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
    const pd = d3.select(activeEl).datum();
    d3.select(activeEl).attr('r',5).attr('fill-opacity',0.75)
      .attr('stroke', getColor(pd, colorMode)).attr('stroke-width',1);
    activeEl = null;
  }
  updateDeepLink();
}
