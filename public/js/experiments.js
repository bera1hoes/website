// ── Experiments panel ──────────────────────────────────────────────────────

// Custom fit (coefficients + its rendered D3 path/points).
let custom = { A: null, B: null, path: null, pts: null };

// CP filter: dataMin/dataMax are the dataset bounds; low/high are the active
// slider bounds (null when the slider is at its extreme = no filtering).
let cpFilter = { dataMin: null, dataMax: null, low: null, high: null };

// Regression checkbox
let regressOnFilter = false;

// ── Experiments: slider helpers ────────────────────────────────────────────

function sliderToCP(val) {
  if (cpFilter.dataMin === null) return null;
  const t = val / 1000;
  return Math.pow(10, Math.log10(cpFilter.dataMin) + t * (Math.log10(cpFilter.dataMax) - Math.log10(cpFilter.dataMin)));
}

function resetCpSlider() {
  const lo = document.getElementById('cp-slider-low');
  const hi = document.getElementById('cp-slider-high');
  if (!lo || !hi) return;
  lo.value = 0;
  hi.value = 1000;
  updateSliderLabels();
  updateSliderFill();
  cpFilter.low  = null;
  cpFilter.high = null;
}

function updateSliderLabels() {
  const low  = sliderToCP(+document.getElementById('cp-slider-low').value);
  const high = sliderToCP(+document.getElementById('cp-slider-high').value);
  document.getElementById('cp-val-low').textContent  = low  ? toGamingNotation(low)  : '—';
  document.getElementById('cp-val-high').textContent = high ? toGamingNotation(high) : '—';
}

function updateSliderFill() {
  const lo   = +document.getElementById('cp-slider-low').value;
  const hi   = +document.getElementById('cp-slider-high').value;
  const fill = document.getElementById('cp-slider-fill');
  fill.style.left  = (lo / 10) + '%';
  fill.style.width = ((hi - lo) / 10) + '%';
}

function onCpSlider() {
  let lo = +document.getElementById('cp-slider-low').value;
  let hi = +document.getElementById('cp-slider-high').value;
  if (lo > hi) { [lo, hi] = [hi, lo]; }
  document.getElementById('cp-slider-low').value  = lo;
  document.getElementById('cp-slider-high').value = hi;
  updateSliderLabels();
  updateSliderFill();
  cpFilter.low  = lo === 0    ? null : sliderToCP(lo);
  cpFilter.high = hi === 1000 ? null : sliderToCP(hi);
  applyFilters();
}

// ── Experiments: CP filter ─────────────────────────────────────────────────

function applyFilters() {
  if (!currentData) return;

  const low  = cpFilter.low  ?? cpFilter.dataMin;
  const high = cpFilter.high ?? cpFilter.dataMax;

  d3.selectAll('.dot').style('display', d => (d.cp >= low && d.cp <= high) ? null : 'none');

  const filtered = currentData.filter(d => d.cp >= low && d.cp <= high);

  if (regressOnFilter && filtered.length > 1) {
    const { A, B, r2, sigma } = powerRegression(filtered);
    activeFit.A = A; activeFit.B = B;
    setStats(A, B, r2);
    const bias = computeClassBias(filtered, A, B);
    computeFitDiffs(currentData, A, B, bias);
    fitPts  = samplePower(A, B, cpFilter.dataMin * 0.7, cpFilter.dataMax * 1.4);
    if (fitPath) drawFit(fitPath, fitPts, xScale, yScale);
    bandPts = bandFromFit(fitPts, sigma);
    if (bandPath) drawBand(bandPath, bandPts, xScale, yScale);
  } else if (!regressOnFilter && (activeFit.A !== frozenFit.A || activeFit.B !== frozenFit.B)) {
    activeFit.A = frozenFit.A; activeFit.B = frozenFit.B;
    setStats(frozenFit.A, frozenFit.B, frozenFit.r2);
    fitPts = frozenFit.fitPts;
    if (fitPath) drawFit(fitPath, fitPts, xScale, yScale);
    bandPts = frozenFit.bandPts;
    if (bandPath && bandPts) drawBand(bandPath, bandPts, xScale, yScale);
    computeFitDiffs(currentData, frozenFit.A, frozenFit.B, frozenFit.classBias);
  }

  buildPivotTable(filtered);
  playerTableData = filtered;
  renderPlayerTable();
}

// ── Experiments: custom fit equation ──────────────────────────────────────

function applyCustomFit() {
  const raw = document.getElementById('custom-eq-input').value.trim();
  const m = raw.match(/Score\s*=\s*([\d.e+\-]+)\s*[×*]\s*CP\s*\^\s*([\d.]+)/i);
  const status = document.getElementById('custom-eq-status');
  if (!m) {
    status.style.color = '#f87171';
    status.textContent = 'Could not parse — paste from the EQUATION card.';
    return;
  }
  custom.A = parseFloat(m[1]);
  custom.B = parseFloat(m[2]);
  status.style.color = '#4ade80';
  status.textContent = `A=${custom.A.toExponential(3)}, B=${custom.B.toFixed(3)}`;
  if (currentData) {
    computeCustomFitDiffs(currentData);
    renderCustomFitLine(xScale, yScale, plot);
    renderPlayerTable();
  }
}

// Annotate each row with its % deviation from the custom fit.
function computeCustomFitDiffs(rows) {
  rows.forEach(d => {
    const pred = custom.A * Math.pow(d.cp, custom.B);
    d.customFitDiff = (d.score - pred) / pred * 100;
  });
}

function clearCustomFit() {
  custom.A = null; custom.B = null;
  if (custom.path) { custom.path.remove(); custom.path = null; }
  custom.pts = null;
  document.getElementById('custom-eq-input').value = '';
  document.getElementById('custom-eq-status').textContent = '';
  if (currentData) {
    currentData.forEach(d => { delete d.customFitDiff; });
    renderPlayerTable();
  }
}

function renderCustomFitLine(xs, ys, plotG) {
  if (custom.path) { custom.path.remove(); custom.path = null; }
  if (!xs || !ys || !plotG) return;
  custom.pts = samplePower(custom.A, custom.B, cpFilter.dataMin * 0.7, cpFilter.dataMax * 1.4);
  custom.path = plotG.append('path').attr('class', 'custom-fit-line');
  drawFit(custom.path, custom.pts, xs, ys);
}

// ── Experiments: regression checkbox ──────────────────────────────────────

function onRegressCheckbox(checked) {
  regressOnFilter = checked;
  applyFilters();
}

// ── Experiments: class-adjusted vs Fit ─────────────────────────────────────

function onClassAdjust(checked) {
  classAdjust = checked;
  if (currentData) currentData.forEach(d => {
    d.fitDiff = checked ? d.fitDiffClass : d.fitDiffRaw;
  });
  renderPlayerTable();
  // Refresh the pinned panel's "vs Fit" value in place (without repositioning it).
  if (isPinned && activeEl) {
    const d = d3.select(activeEl).datum();
    applyFitDiff(document.getElementById('p-fitdiff'), d.fitDiff);
  }
}

function toggleExperiments() {
  document.getElementById('experiments-panel').classList.toggle('open');
}
