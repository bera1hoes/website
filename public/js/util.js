// ── DOM + formatting helpers ───────────────────────────────────────────────

function $id(id) { return document.getElementById(id); }

// Stats cards (R² / exponent / equation). Pass r2 = null to leave it as "—".
function setStats(A, B, r2) {
  $id('r2').textContent  = r2 != null ? r2.toFixed(4) : '—';
  $id('exp').textContent = B.toFixed(4);
  $id('eq').textContent  = `Score = ${A.toExponential(3)} × CP^${B.toFixed(3)}`;
}

function clearStats() {
  $id('r2').textContent  = '—';
  $id('exp').textContent = '—';
  $id('eq').textContent  = '—';
}

// "vs Fit" percentage styling: green when ≥ 0, red when < 0.
function fitDiffColor(pct) { return pct >= 0 ? '#4ade80' : '#f87171'; }
function fitDiffText(pct)  { return (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%'; }
function applyFitDiff(el, pct) {
  el.textContent = fitDiffText(pct);
  el.style.color = fitDiffColor(pct);
}

// ── Gaming notation ────────────────────────────────────────────────────────

function toGamingNotation(num) {
  num = Math.round(num);
  if (num < 1000) return String(num);
  const suffixes = [
    '', 'K', 'M', 'B', 'T',
    'AA', 'AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH', 'AI', 'AJ',
    'AK', 'AL', 'AM', 'AN', 'AO', 'AP', 'AQ', 'AR', 'AS', 'AT',
  ];
  const parts = [];
  let group = 0;
  let n = num;
  while (n > 0) {
    const remainder = n % 1000;
    n = Math.floor(n / 1000);
    if (remainder > 0) {
      const suffix = suffixes[group];
      parts.push(suffix ? `${remainder}${suffix}` : String(remainder));
    }
    group++;
  }
  parts.reverse();
  return parts.slice(0, 2).join(' ');
}
