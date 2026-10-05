// ── Chart internals + render ───────────────────────────────────────────────
// Lifted to module scope so the filter/zoom/custom-fit code can update them.

// Live D3 render handles for the current chart.
let fitPath = null;
let fitPts = null;
let bandPath = null, bandPts = null;
let bandEdgePath = null;
let xScale = null;
let yScale = null;
let plot = null;
// Dots live in two layers: greyed-out ones below the band fill, highlighted ones
// above it (restDot in legend.js files each dot into one).
let dotsDim = null, dotsLit = null;
let zoomBehavior = null;
let zoomSvg = null;
let zoomFrame = null;  // pending requestAnimationFrame for a zoom redraw

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
// The band's upper and lower edges as one path (two subpaths). Drawn above the
// dots, so the band still reads where a dense dot cloud covers its fill.
function drawBandEdges(sel, pts, x, y) {
  const edge = key => d3.line().x(d => x(d.x)).y(d => y(d[key])).curve(d3.curveCatmullRom)(pts);
  sel.attr('d', edge('yHi') + edge('yLo'));
}

// ── Build chart ─────────────────────────────────────────────────────────────

function buildChart(data) {
  closePanel();
  clearPrediction();  // stale win-prediction must not carry across sheets/content
  selectedGroups.clear();
  assignGuildColors(data);
  assignRanks(data);   // must precede joinPoints — points are keyed off rank
  joinPoints(data);
  restoreStoredOverrides(data);  // fold in any persisted score overrides for this sheet

  const { A, B, r2, sigma } = computeFit(data);

  annotateSandbag();  // flag under-performers vs history (no-op without a profile)
  buildPivotTable(data);
  buildPlayerTable(data);
  setStats(A, B, r2);

  // Settle the legend selection before the legend and dots are drawn, so both
  // render in their final state: a deep link's selection (unknown groups are
  // dropped silently; an empty `sel=` means "every group"), else the content
  // type's default.
  if (pendingSel) {
    const key = colorMode === 'guild' ? 'guild' : 'cls';
    const seen = new Set(data.map(d => d[key]));
    pendingSel.filter(g => seen.has(g)).forEach(g => selectedGroups.add(g));
    pendingSel = null;
  } else {
    applyDefaultSelection(data);
  }
  buildLegend(data);

  // Dots render through dotResting, so the selection and a search dim (the
  // input keeps its text across sheets) apply as they're drawn.
  renderScatter(data, A, B, sigma);

  // Deep-link pin can only apply once the dots exist (unknown nicks are dropped).
  if (pendingPin) {
    pinPlayerByName(pendingPin);
    pendingPin = null;
  }
  // Sync the hash with what actually applied (stale pin/sel entries drop out).
  updateDeepLink();
}

// Rank is derived CLIENT-SIDE from score order, 1..N — whatever `rank` the
// source carried is discarded. Sources disagree: the game's own ranking is
// 0-indexed (so 1st place arrived as 0 and the table literally showed "0"),
// while a bracket export is 1-indexed. A sheet is a complete, score-sorted
// population either way, so numbering it here is the one place it can be right
// for every source at once. Ties keep the sort's order, matching the source.
function assignRanks(data) {
  [...data].sort((a, b) => b.score - a.score).forEach((d, i) => { d.rank = i + 1; });
}

// ── Per-player points ──────────────────────────────────────────────────────
// Two content types rank guilds by their members' summed points rather than raw
// Score: Guild Wars (by rank, gw-points.js) and Guild Conquest (by rank AND
// score, gc-points.js). Labels for the pivot, player column, info panel and
// estimate readout come from here; a type with no entry has no points.
const POINTS_LABELS = {
  'Guild Wars':     { name: 'Guild War Points',      short: 'GW Points', tag: 'GW PTS' },
  'Guild Conquest': { name: 'Guild Conquest Points', short: 'GC Points', tag: 'GC PTS' },
};

// What one player earns at 1-based `rank` with `score` under the current content
// type and sheet: { points, tier } (`tier` names the GC tier, null for GW), or
// null when the content has no points or that place earns none. GW's table
// depends on the sheet's date (see gw-points.js), and `gwPointsAt` owns the
// 1-based-rank → 0-indexed-table conversion.
function pointsAt(rank, score) {
  if (currentContentType === 'Guild Wars') {
    const points = gwPointsAt(currentSheet, rank);
    return points ? { points, tier: null } : null;
  }
  if (currentContentType === 'Guild Conquest') {
    const t = gcTierAt(rank, score);
    return t ? { points: t.points, tier: t.name } : null;
  }
  return null;
}

// Stamp `points` (0 when none) and `tier` on every row from its rank and score.
function joinPoints(data) {
  data.forEach(d => {
    const p = pointsAt(d.rank, d.score);
    d.points = p ? p.points : 0;
    d.tier = p ? p.tier : null;
  });
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
  const margin = { top: 16, right: 28, bottom: 52, left: 46 };
  // Measure the actual container so the SVG never overflows its padded card —
  // the old `innerWidth - 60` guess was too wide on phones and forced h-scroll.
  const totalW  = Math.min(900, $id('chart').clientWidth || (window.innerWidth - 60));
  const W = totalW - margin.left - margin.right;
  // On phones, cap the chart height so there's always page left to scroll past.
  const totalH = window.innerWidth < 640 ? Math.min(420, Math.round(window.innerHeight * 0.62)) : 420;
  const H = totalH - margin.top - margin.bottom;

  d3.select('#chart').selectAll('*').remove();
  $id('zoom-indicator').style.display = 'none';
  // A zoom redraw still queued from the old chart would apply its transform to
  // the new fit line.
  if (zoomFrame) { cancelAnimationFrame(zoomFrame); zoomFrame = null; }

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

  // Axis labels. The y-axis title is a compact top-left caption rather than a
  // rotated label — a rotated title's footprint is the font *height*, which
  // forced a wide left margin that ate horizontal space (worst on mobile).
  g.append('text')
    .attr('x', W/2).attr('y', H+46)
    .attr('text-anchor','middle').attr('fill','#6b7280')
    .attr('font-size',11).attr('font-family','Space Mono, monospace')
    .text('CP (log scale)');
  g.append('text')
    .attr('x', -margin.left).attr('y', -5)
    .attr('text-anchor','start').attr('fill','#6b7280')
    .attr('font-size',10).attr('font-family','Space Mono, monospace')
    .attr('letter-spacing','.04em')
    .text('Score ↑');

  // Layers, bottom to top: greyed-out dots, the ±1σ band fill, highlighted dots,
  // then the band edges and fit line over every dot — a whole-world sheet's dot
  // cloud is dense enough to bury anything drawn beneath it. The custom fit line
  // and the estimate marker are appended later, so they land on top.
  fitPts  = samplePower(A, B, cpFilter.dataMin * 0.7, cpFilter.dataMax * 1.4);
  bandPts = bandFromFit(fitPts, sigma);
  dotsDim  = plot.append('g');
  bandPath = plot.append('path').attr('class','fit-band');
  drawBand(bandPath, bandPts, xScale, yScale);
  frozenFit.bandPts = bandPts;
  dotsLit  = plot.append('g');
  bandEdgePath = plot.append('path').attr('class','fit-band-edge');
  drawBandEdges(bandEdgePath, bandPts, xScale, yScale);
  fitPath = plot.append('path').attr('class','fit-line');
  drawFit(fitPath, fitPts, xScale, yScale);
  frozenFit.fitPts = fitPts;
  custom.path = null;
  custom.pts  = null;
  if (custom.A !== null) renderCustomFitLine(xScale, yScale, plot);
  cpFilter.low  = null;
  cpFilter.high = null;
  resetCpSlider();

  const dots = renderDots(data);

  // Appended after the dots so the CP→score marker reads on top of them.
  estimateMarker = null;  // the old handle died with the cleared SVG
  renderEstimate();

  plot.insert('rect', ':first-child')
    .attr('width', W).attr('height', H)
    .attr('fill', 'none').attr('pointer-events', 'all')
    .on('click', closePanel);

  let zoomT = null;  // latest transform, drawn by drawZoom on the next frame
  zoomBehavior = d3.zoom()
    .scaleExtent([1, 50])
    .extent([[0, 0], [W, H]])
    .filter(function(event) {
      // On touch, require two fingers so a one-finger drag scrolls the page
      // instead of being captured as a chart pan (the page felt "stuck").
      if (event.type === 'touchstart') return event.touches.length >= 2;
      // Desktop: d3 default (wheel zoom + drag pan), but ignore right-click.
      return (!event.ctrlKey || event.type === 'wheel') && !event.button;
    })
    .on('zoom', function(event) {
      // Wheel and drag can fire several zoom events per frame; with thousands of
      // dots, only each frame's last transform is worth drawing.
      zoomT = event.transform;
      if (!zoomFrame) zoomFrame = requestAnimationFrame(drawZoom);
    });

  function drawZoom() {
    zoomFrame = null;
    const t  = zoomT;
    const zx = t.rescaleX(xScale);
    const zy = t.rescaleY(yScale);

    xAxisG.call(d3.axisBottom(zx).tickValues(logTicks(zx.domain())).tickFormat(fmt));
    yAxisG.call(d3.axisLeft(zy).tickValues(logTicks(zy.domain())).tickFormat(fmt));
    xGridG.call(d3.axisBottom(zx).tickValues(logTicks(zx.domain())).tickSize(-H).tickFormat(''));
    yGridG.call(d3.axisLeft(zy).tickValues(logTicks(zy.domain())).tickSize(-W).tickFormat(''));

    dots
      .attr('cx', d => zx(d.cp))
      .attr('cy', d => zy(d.score));

    drawFit(fitPath, fitPts, zx, zy);
    if (bandPath && bandPts) {
      drawBand(bandPath, bandPts, zx, zy);
      drawBandEdges(bandEdgePath, bandPts, zx, zy);
    }
    if (custom.path && custom.pts) drawFit(custom.path, custom.pts, zx, zy);
    positionEstimateMarker(zx, zy);

    const isZoomed = t.k !== 1 || t.x !== 0 || t.y !== 0;
    $id('zoom-indicator').style.display = isZoomed ? 'flex' : 'none';
  }

  zoomSvg = svg;
  svg.call(zoomBehavior);
}

// Plot the dots (restDot paints each and files it into the dim or lit layer)
// and wire their hover / pin interactions. The handlers are delegated to the
// plot, one listener per event rather than four per dot, which adds up on a
// whole-world sheet. Over leaf circles, mouseover/mouseout behave exactly like
// mouseenter/mouseleave. Returns the dots selection (the zoom redraw moves it).
function renderDots(data) {
  activeEl = null;
  const dots = dotsLit.selectAll('.dot').data(data).enter().append('circle')
    .attr('class','dot')
    .attr('cx', d => xScale(d.cp))
    .attr('cy', d => yScale(d.score))
    .each(function(d) { restDot(this, d); });

  const dotOf = e => (e.target.classList && e.target.classList.contains('dot')) ? e.target : null;
  plot
    .on('mouseover', function(e) {
      const el = dotOf(e);
      if (!el) return;
      if (activeEl !== el) {
        d3.select(el).attr('r', 7.5).attr('fill-opacity', 1).attr('stroke','white').attr('stroke-opacity', 1).attr('stroke-width', 1.5);
      }
      if (!isPinned) showPanel(e.clientX, e.clientY, d3.select(el).datum(), false);
    })
    .on('mousemove', function(e) {
      if (dotOf(e) && !isPinned) positionPanel(e.clientX, e.clientY);
    })
    .on('mouseout', function(e) {
      const el = dotOf(e);
      if (!el) return;
      if (activeEl !== el) restDot(el, d3.select(el).datum());
      if (!isPinned) document.getElementById('panel').style.display = 'none';
    })
    .on('click', function(e) {
      const el = dotOf(e);
      if (!el) return;
      e.stopPropagation();
      if (activeEl === el && isPinned) {
        closePanel();
        return;
      }
      pinDot(el, d3.select(el).datum(), e.clientX, e.clientY);
    });
  return dots;
}

// Pin the panel on a dot element. Shared by the dot click handler and
// pinPlayerByName; cx/cy are viewport coords for positioning the panel.
function pinDot(el, d, cx, cy) {
  if (activeEl && activeEl !== el) {
    const prev = activeEl;
    activeEl = null;
    restDot(prev, d3.select(prev).datum());
  }
  activeEl = el;
  // Lift the pinned dot to the top of the lit layer so nothing draws over it,
  // even when it's one of the greyed-out ones.
  dotsLit.node().appendChild(el);
  d3.select(el).attr('r',8).attr('fill-opacity',1).attr('stroke','white').attr('stroke-opacity',1).attr('stroke-width',2);
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
