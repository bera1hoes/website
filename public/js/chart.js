// ── Chart internals + render ───────────────────────────────────────────────
// Lifted to module scope so the filter/zoom/custom-fit code can update them.

// Live D3 render handles for the current chart.
let fitPath = null;
let fitPts = null;
let bandPath = null, bandPts = null;
let xScale = null;
let yScale = null;
let plot = null;
let zoomBehavior = null;
let zoomSvg = null;

// The frozen baseline fit (full dataset) and the fit currently shown. They
// differ only while "recalculate on CP filter" is active; otherwise activeFit
// mirrors frozenFit. fitPts/bandPts above are the live (possibly filtered) copies.
let frozenFit = { A: null, B: null, r2: null, sigma: null, fitPts: null, bandPts: null, classBias: null };
let activeFit = { A: null, B: null };

// Class-aware "vs Fit" toggle.
let classAdjust = false;

// ── Fit-curve geometry helpers ─────────────────────────────────────────────

// Sample y = A·CP^B across [cpLo, cpHi] at 300 points evenly spaced in log space.
function samplePower(A, B, cpLo, cpHi) {
  return d3.range(300).map(i => {
    const x = Math.exp(Math.log(cpLo) + (Math.log(cpHi) - Math.log(cpLo)) * i / 299);
    return { x, y: A * Math.pow(x, B) };
  });
}

// ±1σ band envelope around a fit-point array (multiplicative — correct for
// log-normal scatter, so it's asymmetric in linear space).
function bandFromFit(pts, sigma) {
  const mul = Math.pow(10, sigma);
  return pts.map(p => ({ x: p.x, yHi: p.y * mul, yLo: p.y / mul }));
}

// Update a fit-line / band path: bind `pts` and redraw with the given scales
// (which may be zoom-rescaled). Shared by the initial render, zoom, and filters.
function drawFit(sel, pts, x, y) {
  sel.datum(pts).attr('d', d3.line().x(d => x(d.x)).y(d => y(d.y)).curve(d3.curveCatmullRom));
}
function drawBand(sel, pts, x, y) {
  sel.datum(pts).attr('d', d3.area().x(d => x(d.x)).y0(d => y(d.yLo)).y1(d => y(d.yHi)).curve(d3.curveCatmullRom));
}

// ── Build chart ─────────────────────────────────────────────────────────────

function buildChart(data) {
  closePanel();
  selectedGroups.clear();
  assignGuildColors(data);
  joinGwPoints(data);

  const { A, B, r2, sigma } = computeFit(data);

  buildPivotTable(data);
  buildPlayerTable(data);
  setStats(A, B, r2);
  buildLegend(data);

  renderScatter(data, A, B, sigma);

  // Deep-link restore: pin once the dots exist. A nick absent from this sheet
  // just doesn't pin — drop it from the hash rather than erroring.
  if (pendingPin) {
    const found = pinPlayerByName(pendingPin);
    pendingPin = null;
    if (!found) updateDeepLink();
  }
}

// Join GW points by rank — Guild Wars only; other content types get 0.
function joinGwPoints(data) {
  if (currentContentType === 'Guild Wars') {
    const gwMap = parseGWPoints(GW_POINTS_DATA);
    data.forEach(d => { d.gwPoints = gwMap.get(String(d.rank)) || 0; });
  } else {
    data.forEach(d => { d.gwPoints = 0; });
  }
}

// Run the regression over the full dataset, freeze it as the baseline, and
// annotate every row with its fit deviations. Returns the fit params.
function computeFit(data) {
  const { A, B, r2, sigma } = powerRegression(data);
  frozenFit.A = A; frozenFit.B = B; frozenFit.r2 = r2; frozenFit.sigma = sigma;
  activeFit.A  = A; activeFit.B  = B;
  cpFilter.dataMin = d3.min(data, d => d.cp);
  cpFilter.dataMax = d3.max(data, d => d.cp);
  frozenFit.classBias = computeClassBias(data, A, B);
  computeFitDiffs(data, A, B, frozenFit.classBias);
  if (custom.A !== null) computeCustomFitDiffs(data);
  return { A, B, r2, sigma };
}

// Draw the whole SVG: scales, grid, axes, fit line + band, dots, and zoom.
function renderScatter(data, A, B, sigma) {
  const margin = { top: 16, right: 28, bottom: 52, left: 70 };
  const totalW  = Math.min(900, window.innerWidth - 60);
  const W = totalW - margin.left - margin.right;
  const H = 420 - margin.top - margin.bottom;

  d3.select('#chart').selectAll('*').remove();
  $id('zoom-indicator').style.display = 'none';

  const svg = d3.select('#chart').append('svg')
    .attr('width',  W + margin.left + margin.right)
    .attr('height', H + margin.top  + margin.bottom);

  svg.append('defs').append('clipPath').attr('id', 'chart-clip')
    .append('rect').attr('width', W).attr('height', H);

  const g    = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
  plot = g.append('g').attr('clip-path', 'url(#chart-clip)');

  xScale = d3.scaleLog()
    .domain([cpFilter.dataMin * 0.7, cpFilter.dataMax * 1.4])
    .range([0, W]);

  yScale = d3.scaleLog()
    .domain([d3.min(data, d => d.score) * 0.7, d3.max(data, d => d.score) * 1.5])
    .range([H, 0]);

  const fmt = toGamingNotation;

  const logTicks = domain => {
    const ticks = [];
    const start = Math.ceil(Math.log10(domain[0]));
    const end   = Math.floor(Math.log10(domain[1]));
    for (let e = start; e <= end; e++) ticks.push(Math.pow(10, e));
    return ticks;
  };

  // Grid (clipped)
  const yGridG = plot.append('g').attr('class','grid')
    .call(d3.axisLeft(yScale).tickValues(logTicks(yScale.domain())).tickSize(-W).tickFormat(''));
  const xGridG = plot.append('g').attr('class','grid').attr('transform',`translate(0,${H})`)
    .call(d3.axisBottom(xScale).tickValues(logTicks(xScale.domain())).tickSize(-H).tickFormat(''));

  // Axes (unclipped so labels aren't cut off)
  const xAxisG = g.append('g').attr('transform',`translate(0,${H})`)
    .call(d3.axisBottom(xScale).tickValues(logTicks(xScale.domain())).tickFormat(fmt));
  const yAxisG = g.append('g')
    .call(d3.axisLeft(yScale).tickValues(logTicks(yScale.domain())).tickFormat(fmt));

  // Axis labels
  g.append('text')
    .attr('x', W/2).attr('y', H+46)
    .attr('text-anchor','middle').attr('fill','#6b7280')
    .attr('font-size',11).attr('font-family','Space Mono, monospace')
    .text('CP (log scale)');
  g.append('text')
    .attr('transform','rotate(-90)').attr('x',-H/2).attr('y',-58)
    .attr('text-anchor','middle').attr('fill','#6b7280')
    .attr('font-size',11).attr('font-family','Space Mono, monospace')
    .text('Score (log scale)');

  // Fit line + ±1σ band. Band appended first so it sits beneath line and dots.
  fitPts  = samplePower(A, B, cpFilter.dataMin * 0.7, cpFilter.dataMax * 1.4);
  bandPts = bandFromFit(fitPts, sigma);
  bandPath = plot.append('path').attr('class','fit-band');
  drawBand(bandPath, bandPts, xScale, yScale);
  frozenFit.bandPts = bandPts;
  fitPath = plot.append('path').attr('class','fit-line');
  drawFit(fitPath, fitPts, xScale, yScale);
  frozenFit.fitPts = fitPts;
  custom.path = null;
  custom.pts  = null;
  if (custom.A !== null) renderCustomFitLine(xScale, yScale, plot);
  cpFilter.low  = null;
  cpFilter.high = null;
  resetCpSlider();

  renderDots(data);

  plot.insert('rect', ':first-child')
    .attr('width', W).attr('height', H)
    .attr('fill', 'none').attr('pointer-events', 'all')
    .on('click', closePanel);

  zoomBehavior = d3.zoom()
    .scaleExtent([1, 50])
    .extent([[0, 0], [W, H]])
    .on('zoom', function(event) {
      const t  = event.transform;
      const zx = t.rescaleX(xScale);
      const zy = t.rescaleY(yScale);

      xAxisG.call(d3.axisBottom(zx).tickValues(logTicks(zx.domain())).tickFormat(fmt));
      yAxisG.call(d3.axisLeft(zy).tickValues(logTicks(zy.domain())).tickFormat(fmt));
      xGridG.call(d3.axisBottom(zx).tickValues(logTicks(zx.domain())).tickSize(-H).tickFormat(''));
      yGridG.call(d3.axisLeft(zy).tickValues(logTicks(zy.domain())).tickSize(-W).tickFormat(''));

      plot.selectAll('.dot')
        .attr('cx', d => zx(d.cp))
        .attr('cy', d => zy(d.score));

      drawFit(fitPath, fitPts, zx, zy);
      if (bandPath && bandPts) drawBand(bandPath, bandPts, zx, zy);
      if (custom.path && custom.pts) drawFit(custom.path, custom.pts, zx, zy);

      const isZoomed = t.k !== 1 || t.x !== 0 || t.y !== 0;
      $id('zoom-indicator').style.display = isZoomed ? 'flex' : 'none';
    });

  zoomSvg = svg;
  svg.call(zoomBehavior);
}

// Plot the dots and wire their hover / pin interactions.
function renderDots(data) {
  activeEl = null;
  plot.selectAll('.dot').data(data).enter().append('circle')
    .attr('class','dot')
    .attr('cx', d => xScale(d.cp))
    .attr('cy', d => yScale(d.score))
    .attr('r', 5)
    .attr('fill',   d => getColor(d, colorMode))
    .attr('stroke', d => getColor(d, colorMode))
    .attr('stroke-width', 1)
    .attr('fill-opacity', 0.75)
    .style('cursor','pointer')
    .on('mouseenter', function(e, d) {
      if (activeEl !== this) {
        d3.select(this).attr('r', 7.5).attr('fill-opacity', 1).attr('stroke','white').attr('stroke-width', 1.5);
      }
      if (!isPinned) showPanel(e.clientX, e.clientY, d, false);
    })
    .on('mousemove', function(e, d) {
      if (!isPinned) positionPanel(e.clientX, e.clientY);
    })
    .on('mouseleave', function(e, d) {
      if (activeEl !== this) {
        const rest = dotResting(d);
        d3.select(this).attr('r', 5).attr('fill-opacity', rest.opacity).attr('fill', rest.color).attr('stroke', rest.color).attr('stroke-width', 1);
      }
      if (!isPinned) document.getElementById('panel').style.display = 'none';
    })
    .on('click', function(e, d) {
      if (activeEl === this && isPinned) {
        closePanel();
        e.stopPropagation();
        return;
      }
      pinDot(this, d, e.clientX, e.clientY);
      e.stopPropagation();
    });
}

// Pin the panel on a dot element. Shared by the dot click handler and
// pinPlayerByName; cx/cy are viewport coords for positioning the panel.
function pinDot(el, d, cx, cy) {
  if (activeEl && activeEl !== el) {
    const prev = d3.select(activeEl);
    const pd = prev.datum();
    const rest = dotResting(pd);
    prev.attr('r',5).attr('fill-opacity',rest.opacity).attr('fill',rest.color).attr('stroke', rest.color).attr('stroke-width',1);
  }
  activeEl = el;
  d3.select(el).attr('r',8).attr('fill-opacity',1).attr('stroke','white').attr('stroke-width',2);
  showPanel(cx, cy, d, true);
  updateDeepLink();
}

// Find a player's dot by exact nick and pin the panel on it (deep-link
// restore; also reusable by player search). Returns false if no dot matches.
function pinPlayerByName(nick) {
  let el = null, datum = null;
  d3.selectAll('.dot').each(function(d) {
    if (!el && d.nick === nick) { el = this; datum = d; }
  });
  if (!el) return false;
  const r = el.getBoundingClientRect();
  pinDot(el, datum, r.left + r.width / 2, r.top + r.height / 2);
  return true;
}

function resetZoom() {
  if (zoomSvg && zoomBehavior) {
    zoomSvg.transition().duration(300).call(zoomBehavior.transform, d3.zoomIdentity);
  }
}
