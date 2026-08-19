// ── CP → expected score ────────────────────────────────────────────────────
// Runs the fit forward: type a CP, get the score the power law predicts for it.
// Reads `activeFit` (so it tracks the CP-filter refit) and `frozenFit.sigma`
// for the ±1σ spread, and mirrors the answer as a marker on the chart.

// The CP being estimated, and its predicted score — both null when the box is
// empty or unparseable. The score is kept so the zoom handler can reposition
// the marker without redoing the math.
let estimateCP = null;
let estimateScore = null;

// D3 <g> drawn on the plot at (estimateCP, estimateScore).
let estimateMarker = null;

// Lazily-parsed rank → GW points map (Guild Wars only).
let _estGwPts = null;

function onEstimateInput(raw) {
  const txt = String(raw).trim();
  $id('estimate-clear').hidden = !txt;
  const cp = txt ? parseGamingNotation(txt) : null;
  // Upper bound keeps the predicted score inside toGamingNotation's suffix
  // table (real CP is ~1e15, so this only rejects nonsense).
  estimateCP = (cp !== null && cp > 0 && cp < 1e30) ? cp : null;
  $id('estimate-error').textContent =
    (txt && estimateCP === null) ? 'Not a CP — try 1.9e15, 1900T, or 1AB 900T.' : '';
  renderEstimate();
}

function clearEstimate() {
  estimateCP = null;
  $id('estimate-input').value = '';
  $id('estimate-clear').hidden = true;
  $id('estimate-error').textContent = '';
  renderEstimate();
}

// Recompute the readout and the marker from the fit that's currently showing.
// Safe to call whenever the fit or the dataset changes.
function renderEstimate() {
  const out = $id('estimate-out');
  if (!out) return;

  if (estimateCP === null || activeFit.A === null) {
    estimateScore = null;
    out.hidden = true;
    drawEstimateMarker();
    return;
  }

  estimateScore = activeFit.A * Math.pow(estimateCP, activeFit.B);
  if (!(estimateScore > 0) || !isFinite(estimateScore)) {
    estimateScore = null;
    out.hidden = true;
    drawEstimateMarker();
    return;
  }
  out.hidden = false;

  $id('est-score').textContent = toGamingNotation(estimateScore);
  $id('est-exact').textContent =
    `CP ${toGamingNotation(estimateCP)} → ${Math.round(estimateScore).toLocaleString()}`;

  // ±1σ of the log-residuals, i.e. the multiplicative spread most players land
  // inside — the same band drawn around the fit line.
  const sigma = frozenFit.sigma;
  const mul = sigma ? Math.pow(10, sigma) : null;
  $id('est-range').textContent = mul
    ? `${toGamingNotation(estimateScore / mul)} – ${toGamingNotation(estimateScore * mul)}`
    : '—';

  // Where that score would land in the sheet on screen.
  const rankRow = $id('est-rank-row');
  if (currentData && currentData.length) {
    const beat = currentData.filter(d => d.score > estimateScore).length;
    $id('est-rank').textContent = `#${beat + 1} of ${currentData.length + 1}`;
    rankRow.hidden = false;
    const pts = gwPointsForRank(beat + 1);
    $id('est-gw').textContent = pts != null ? pts.toLocaleString() : '';
    $id('est-gw-row').hidden = pts == null;
  } else {
    rankRow.hidden = true;
    $id('est-gw-row').hidden = true;
  }

  // Custom fit, when one is set — the whole point of the Experiments equation
  // box is comparing it against the real fit.
  const customRow = $id('est-custom-row');
  if (custom.A !== null) {
    $id('est-custom').textContent = toGamingNotation(custom.A * Math.pow(estimateCP, custom.B));
    customRow.hidden = false;
  } else {
    customRow.hidden = true;
  }

  // A power law fit on 10^14–10^16 CP says nothing reliable about 10^12.
  const outside = cpFilter.dataMin != null &&
    (estimateCP < cpFilter.dataMin || estimateCP > cpFilter.dataMax);
  $id('est-note').textContent = outside
    ? `⚠ Extrapolated — outside this sheet's CP range (${toGamingNotation(cpFilter.dataMin)} – ${toGamingNotation(cpFilter.dataMax)}).`
    : '';

  drawEstimateMarker();
}

function gwPointsForRank(rank) {
  if (currentContentType !== 'Guild Wars') return null;
  if (!_estGwPts) _estGwPts = parseGWPoints(GW_POINTS_DATA);
  const pts = _estGwPts.get(String(rank));
  return pts === undefined ? null : pts;
}

// ── Chart marker ───────────────────────────────────────────────────────────

// (Re)create the marker at the estimated point. `renderScatter` wipes the SVG,
// so it nulls `estimateMarker` and calls back here rather than reusing a stale
// handle.
function drawEstimateMarker() {
  if (estimateMarker) { estimateMarker.remove(); estimateMarker = null; }
  if (estimateScore === null || !plot || !xScale || !yScale) return;

  estimateMarker = plot.append('g').attr('class', 'estimate-marker');
  estimateMarker.append('circle').attr('r', 6);
  estimateMarker.append('text').attr('y', -12).attr('text-anchor', 'middle')
    .text(toGamingNotation(estimateScore));
  positionEstimateMarker(xScale, yScale);
}

// Move the marker onto the given scales — the zoom handler passes its rescaled
// pair so the marker stays glued to its CP/score.
function positionEstimateMarker(x, y) {
  if (!estimateMarker || estimateScore === null) return;
  estimateMarker.attr('transform', `translate(${x(estimateCP)},${y(estimateScore)})`);
}
