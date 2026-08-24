// ── mapleidle baselines ────────────────────────────────────────────────────
// mapleidle.gg/tools/score-analysis fits a power-law "baseline" per content
// type — Score = e^fitA · CP^fitB, fitted on every ranked character in the game
// (median, all classes pooled). Ours is fitted on one guild sheet, so showing
// theirs next to it says whether this population runs hot or cold against the
// server at large.
//
// Their page can't be fetched by us (Worker fetch and scripted fetch are both
// 429'd; a visitor's cross-origin fetch is CORS-blocked), so the numbers arrive
// via the Tampermonkey userscript in tools/mapleidle-baseline.user.js, which
// reads them inside the page and POSTs them to the Worker's /baseline. Here we
// only read them back from /api.
//
// The fits only move when mapleidle re-snapshots (weekly-ish), so the response
// is cached in localStorage and only re-read once a week. Reload busts it.

const BASELINE_CACHE_KEY = 'mi_baselines';
const BASELINE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Guild content is Lv 100+, so the 4th-job cohort is the meaningful one. Their
// `sub` (Lv 60–99) cohort is stored too, but nothing reads it yet.
const BASELINE_COHORT = 'fourth';

// { fetchedAt, source, cohorts: { fourth: { "<content type>": {fitA,fitB,snapshotDate} } } }
let miBaselines = null;
let baselineFetchInFlight = false;

function readBaselineCache() {
  try {
    const raw = localStorage.getItem(BASELINE_CACHE_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    if (!rec || typeof rec.cachedAt !== 'number') return null;
    if (Date.now() - rec.cachedAt > BASELINE_TTL_MS) return null;
    return rec.data;
  } catch (e) {
    return null;  // private mode / corrupt entry — just refetch
  }
}

function writeBaselineCache(data) {
  try {
    localStorage.setItem(BASELINE_CACHE_KEY, JSON.stringify({ cachedAt: Date.now(), data }));
  } catch (e) { /* storage full or blocked — the in-memory copy still works */ }
}

// Drop the weekly cache so the next load re-reads /api (wired to Reload, so a
// fresh push from the userscript is visible without waiting out the week).
function bustBaselineCache() {
  try { localStorage.removeItem(BASELINE_CACHE_KEY); } catch (e) { /* ignore */ }
}

// Load the baselines (cache first, then /api) and render the card. Called on
// every content-type switch; the fetch itself happens at most once a week.
function loadBaselines() {
  if (miBaselines) { renderBaselineCard(); return; }

  const cached = readBaselineCache();
  if (cached) {
    miBaselines = cached;
    renderBaselineCard();
    return;
  }

  renderBaselineCard();  // hide the card while we go looking
  if (IS_LOCAL || baselineFetchInFlight) return;

  baselineFetchInFlight = true;
  apiCall('getBaselines')
    .then(function (json) {
      const parsed = typeof json === 'string' ? JSON.parse(json) : json;
      if (parsed && parsed.cohorts) {
        miBaselines = parsed;
        writeBaselineCache(parsed);
      }
      renderBaselineCard();
    })
    .catch(function (err) {
      // Non-fatal: the chart's own fit is unaffected, so the card just stays hidden.
      console.warn('getBaselines failed:', err);
    })
    .finally(function () { baselineFetchInFlight = false; });
}

// The baseline for the current content type, or null when there isn't one
// (nothing pushed yet, or Global GBB — which mapleidle doesn't track).
function currentBaseline() {
  if (!miBaselines || !miBaselines.cohorts) return null;
  const cohort = miBaselines.cohorts[BASELINE_COHORT];
  return (cohort && cohort[currentContentType]) || null;
}

function renderBaselineCard() {
  const card = $id('baseline-card');
  if (!card) return;

  const b = currentBaseline();
  if (!b) { card.style.display = 'none'; return; }

  // Their fitA is a natural-log intercept; ours is a base-10 coefficient. Convert
  // so the two EQUATION cards read in the same units and can be compared directly.
  const A = Math.exp(b.fitA);
  $id('baseline-eq').textContent = `Score = ${A.toExponential(3)} × CP^${b.fitB.toFixed(3)}`;

  const snap = b.snapshotDate ? `snapshot ${b.snapshotDate}` : '';
  $id('baseline-sub').textContent = snap;
  card.title = 'mapleidle.gg game-wide baseline (4th job cohort, median fit over all ranked characters)'
    + (miBaselines.fetchedAt ? '\nPulled ' + new Date(miBaselines.fetchedAt).toLocaleDateString() : '');
  card.style.display = '';
}
