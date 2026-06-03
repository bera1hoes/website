// ── Regression ─────────────────────────────────────────────────────────────

function powerRegression(data) {
  const n = data.length;
  const lx = data.map(d => Math.log10(d.cp));
  const ly = data.map(d => Math.log10(d.score));
  let sx=0,sy=0,sxx=0,sxy=0;
  for(let i=0;i<n;i++){sx+=lx[i];sy+=ly[i];sxx+=lx[i]*lx[i];sxy+=lx[i]*ly[i];}
  const B = (n*sxy - sx*sy) / (n*sxx - sx*sx);
  const Alog = (sy - B*sx) / n;
  const A = Math.pow(10, Alog);
  const yMean = sy / n;
  let ssTot=0, ssRes=0;
  for(let i=0;i<n;i++){const p=Alog+B*lx[i];ssTot+=(ly[i]-yMean)**2;ssRes+=(ly[i]-p)**2;}
  const sigma = Math.sqrt(ssRes / Math.max(1, n - 2)); // residual SD in dex (log10 units)
  return { A, B, r2: 1 - ssRes/ssTot, Alog, sigma };
}

// Mean log-residual per class (dex): how far each class sits above/below the CP-implied
// fit. Classes with fewer than MIN_CLASS samples get 0 (no adjustment).
function computeClassBias(data, A, B) {
  const MIN_CLASS = 5;
  const byClass = {};
  data.forEach(d => {
    const r = Math.log10(d.score) - Math.log10(A * Math.pow(d.cp, B));
    (byClass[d.cls] ||= []).push(r);
  });
  const bias = {};
  Object.entries(byClass).forEach(([c, a]) =>
    bias[c] = a.length >= MIN_CLASS ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  return bias;
}

// Annotate each row with its % deviation from the fit — both raw and
// class-adjusted — then point d.fitDiff at whichever the `classAdjust` flag
// (declared in chart.js) currently selects.
function computeFitDiffs(rows, A, B, classBias) {
  rows.forEach(d => {
    const predicted = A * Math.pow(d.cp, B);
    const predClass = predicted * Math.pow(10, (classBias && classBias[d.cls]) || 0);
    d.fitDiffRaw   = (d.score - predicted) / predicted * 100;
    d.fitDiffClass = (d.score - predClass) / predClass * 100;
    d.fitDiff      = classAdjust ? d.fitDiffClass : d.fitDiffRaw;
  });
}
