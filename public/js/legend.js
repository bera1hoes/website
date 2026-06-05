// ── Color mode + legend + highlighting ─────────────────────────────────────

let colorMode = 'guild';
let selectedGroups = new Set();

function setColorMode(mode) {
  colorMode = mode;
  document.getElementById('btn-guild').classList.toggle('active', mode === 'guild');
  document.getElementById('btn-class').classList.toggle('active', mode === 'class');
  if (currentData) {
    updateColors();
    buildLegend(currentData);
  }
}

function updateColors() {
  selectedGroups.clear();
  d3.selectAll('.dot')
    .attr('fill',         d => getColor(d, colorMode))
    .attr('stroke',       d => getColor(d, colorMode))
    .attr('fill-opacity', 0.75);
}

function applyHighlights() {
  const key = colorMode === 'guild' ? 'guild' : 'cls';
  const has = selectedGroups.size > 0;
  d3.selectAll('.dot')
    .attr('fill', d => (has && !selectedGroups.has(d[key])) ? '#374151' : getColor(d, colorMode))
    .attr('stroke', d => (has && !selectedGroups.has(d[key])) ? '#374151' : getColor(d, colorMode))
    .attr('fill-opacity', d => (has && !selectedGroups.has(d[key])) ? 0.12 : 0.75);
  document.querySelectorAll('.legend-item[data-group]').forEach(el => {
    el.classList.toggle('dimmed', has && !selectedGroups.has(el.dataset.group));
  });
}

// ── Legend ─────────────────────────────────────────────────────────────────

let _legendDelegated = false;

function buildLegend(data) {
  const palette = colorMode === 'guild' ? GUILD_COLORS : CLASS_COLORS;
  const key = colorMode === 'guild' ? 'guild' : 'cls';
  const seen = [...new Set(data.map(d => d[key]))].sort();

  const lg = document.getElementById('legend');
  lg.innerHTML = '';

  // One delegated click handler for the whole legend — survives rebuilds, so we
  // don't attach a fresh listener per item on every render.
  if (!_legendDelegated) {
    lg.addEventListener('click', e => {
      const item = e.target.closest('.legend-item[data-group]');
      if (!item) return;
      const label = item.dataset.group;
      if (selectedGroups.has(label)) selectedGroups.delete(label);
      else selectedGroups.add(label);
      applyHighlights();
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
    item.className = 'legend-item clickable';
    item.dataset.group = label;
    item.innerHTML = `<div class="legend-dot" style="background:${color};border:1.5px solid ${color}"></div><span style="color:var(--text-dim)">${label}</span>`;
    lg.appendChild(item);
  });
}
