// ── Deep links ──────────────────────────────────────────────────────────────
// The URL hash encodes the current view so links restore it:
//   /charts#ct=Guild+Wars&sheet=06_08_2026&color=class&pin=SomeNick
// Hash (not search params) so the Worker's routing and the asset cache never
// see view state. Written with replaceState — navigating the chart must not
// pile entries onto the browser history.

// Pending restore state, consumed elsewhere once the data it needs exists:
// `pendingSheet` overrides the default newest-first sheet pick in
// applySheetNames/populateLocalSheets (io.js); `pendingPin` is picked up at the
// end of buildChart (chart.js) once the dots are rendered.
let pendingSheet = null;
let pendingPin = null;

// updateDeepLink is a no-op until restoreDeepLink has run, so the restore
// sequence's intermediate loads can't overwrite a deep link with partial state.
let deepLinkReady = false;

const DEEPLINK_CONTENT_TYPES = ['Guild Wars', 'Guild Boss Battle', 'Global GBB', 'Guild Conquest'];

// Serialize the current view into the hash. Pin falls back to pendingPin while
// a restore is still in flight so reloading mid-restore keeps the full link.
function updateDeepLink() {
  if (!deepLinkReady || !currentContentType) return;
  const p = new URLSearchParams();
  p.set('ct', currentContentType);
  if (currentSheet) p.set('sheet', currentSheet);
  if (colorMode !== 'guild') p.set('color', colorMode);
  const pinnedNick = (isPinned && activeEl) ? d3.select(activeEl).datum().nick : pendingPin;
  if (pinnedNick) p.set('pin', pinnedNick);
  history.replaceState(null, '', '#' + p.toString());
}

// Parse the hash. An unknown content type invalidates the whole link; the
// other fields are best-effort (missing sheet/pin just fall back to defaults).
function readDeepLink() {
  if (location.hash.length < 2) return null;
  const p = new URLSearchParams(location.hash.slice(1));
  const ct = p.get('ct');
  if (!DEEPLINK_CONTENT_TYPES.includes(ct)) return null;
  return { ct: ct, sheet: p.get('sheet'), color: p.get('color'), pin: p.get('pin') };
}

// Boot entry (called from main.js once data constants are available). Restores
// the view from the hash; with no/invalid hash it only arms updateDeepLink.
function restoreDeepLink() {
  const link = readDeepLink();
  deepLinkReady = true;
  if (!link) return;
  if (link.color === 'class' || link.color === 'guild') setColorMode(link.color);
  pendingSheet = link.sheet || null;
  pendingPin = link.pin || null;
  loadContentType(link.ct);
}
