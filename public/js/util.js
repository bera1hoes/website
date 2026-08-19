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

// Index = power of 1000 (so K = 1000^1, T = 1000^4, AA = 1000^5).
const GAMING_SUFFIXES = [
  '', 'K', 'M', 'B', 'T',
  'AA', 'AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH', 'AI', 'AJ',
  'AK', 'AL', 'AM', 'AN', 'AO', 'AP', 'AQ', 'AR', 'AS', 'AT',
];

function toGamingNotation(num) {
  num = Math.round(num);
  if (num < 1000) return String(num);
  const suffixes = GAMING_SUFFIXES;
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

// Inverse of toGamingNotation, loosened for hand-typed input: accepts a plain
// or scientific-notation number ("1900000000000000", "1.9e15", "1,900,000") or
// one/more gaming-notation groups ("1.5T", "1AB 900T"). Returns null if the
// whole string doesn't parse — callers treat that as "nothing entered yet".
function parseGamingNotation(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim().replace(/,/g, '');
  if (!s) return null;
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) {
    const n = Number(s);
    return isFinite(n) ? n : null;
  }
  let total = 0;
  for (const part of s.split(/\s+/)) {
    const m = part.match(/^(\d+\.?\d*|\.\d+)([a-z]{1,2})$/i);
    if (!m) return null;
    const pow = GAMING_SUFFIXES.indexOf(m[2].toUpperCase());
    if (pow < 1) return null;  // index 0 is the empty (bare number) suffix
    total += parseFloat(m[1]) * Math.pow(1000, pow);
  }
  return isFinite(total) ? total : null;
}
