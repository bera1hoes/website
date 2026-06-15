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
let pendingSel = null;
let pendingPin = null;

// updateDeepLink is a no-op until restoreDeepLink has run, so the restore
// sequence's intermediate loads can't overwrite a deep link with partial state.
let deepLinkReady = false;

const DEEPLINK_CONTENT_TYPES = ['Guild Wars', 'Guild Boss Battle', 'Global GBB', 'Guild Conquest', 'Guild Training Ground'];

// Serialize the current view into the hash. Pin falls back to pendingPin while
// a restore is still in flight so reloading mid-restore keeps the full link.
function updateDeepLink() {
  if (!deepLinkReady || !currentContentType) return;
  const p = new URLSearchParams();
  p.set('ct', currentContentType);
  if (currentSheet) p.set('sheet', currentSheet);
  if (colorMode !== 'guild') p.set('color', colorMode);
  selectedGroups.forEach(g => p.append('sel', g));
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
  return { ct: ct, sheet: p.get('sheet'), color: p.get('color'), sel: p.getAll('sel'), pin: p.get('pin') };
}

// Boot entry (called from main.js once data constants are available). Restores
// the view from the hash; with no/invalid hash it only arms updateDeepLink.
function restoreDeepLink() {
  const link = readDeepLink();
  deepLinkReady = true;
  if (!link) return;
  if (link.color === 'class' || link.color === 'guild') setColorMode(link.color);
  pendingSheet = link.sheet || null;
  pendingSel = link.sel.length ? link.sel : null;
  pendingPin = link.pin || null;
  loadContentType(link.ct);
}

// ── Share button ────────────────────────────────────────────────────────────

function copyShareLink() {
  updateDeepLink();
  const ok = () => showShareToast('Link copied to clipboard');
  const fail = () => showShareToast('Couldn’t copy — grab it from the address bar');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(location.href).then(ok, fail);
  } else {
    fail();
  }
}

let _shareToastTimer = null;

function showShareToast(msg) {
  let el = document.getElementById('share-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'share-toast';
    el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);' +
      'background:#161a22;color:#e8eaf0;border:1px solid rgba(255,255,255,0.15);' +
      'border-radius:8px;padding:9px 16px;font-size:12px;z-index:1000;' +
      'opacity:0;transition:opacity .25s;pointer-events:none';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  requestAnimationFrame(() => { el.style.opacity = '1'; });
  clearTimeout(_shareToastTimer);
  _shareToastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2200);
}
