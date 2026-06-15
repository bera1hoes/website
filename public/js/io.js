// ── Environment detection + data fetching ──────────────────────────────────
// Chart data comes from Google Sheets via the Apps Script JSON API (Code.gs),
// reached through a same-origin Cloudflare Worker proxy (worker.js) to avoid
// CORS. The real Apps Script /exec URL lives in worker.js, not here.
const API_URL = '/api';  // same-origin proxy; see worker.js

const HAS_GAS = typeof google !== 'undefined' && !!google.script;
// Local sample-data mode: file:// or a localhost dev server, with no remote API.
const IS_LOCAL = !HAS_GAS && (
  !API_URL ||
  location.protocol === 'file:' ||
  location.hostname === 'localhost' ||
  location.hostname === '127.0.0.1'
);
// Remote mode: static page (Cloudflare) fetching JSON from the Apps Script API.
const IS_REMOTE = !HAS_GAS && !IS_LOCAL;

// Read-only GET wrapper for the Apps Script JSON API (remote mode).
// Aborts after a timeout so a hung request can't leave the UI stuck on "Loading…".
const API_TIMEOUT_MS = 15000;

function apiCall(action, params) {
  const qs = new URLSearchParams(Object.assign({ action: action }, params || {}));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  return fetch(API_URL + '?' + qs.toString(), { signal: ctrl.signal }).then(r => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    // The Worker fetches the spreadsheet's modified timestamp to validate its
    // edge cache and attaches it to every response — read it here instead of
    // making a separate getLastUpdated call.
    const ts = r.headers.get('x-last-updated');
    if (ts && params && params.contentType) noteLastUpdated(params.contentType, ts);
    return r.json();
  }).then(json => {
    if (json && json.error) throw new Error(json.error);
    return json;
  }).catch(err => {
    throw err.name === 'AbortError' ? new Error('Request timed out') : err;
  }).finally(() => clearTimeout(timer));
}

// Render an error in the loading area with a Retry button wired to `retryFn`.
function showLoadError(message, retryFn) {
  const el = document.getElementById('loading');
  if (!el) return;
  el.style.display = 'block';
  el.textContent = message + ' ';
  if (retryFn) {
    const btn = document.createElement('button');
    btn.className = 'file-btn';
    btn.textContent = '↻ Retry';
    btn.style.marginLeft = '8px';
    btn.addEventListener('click', retryFn);
    el.appendChild(btn);
  }
}

// ── Sheet / content-type state ─────────────────────────────────────────────

let currentSheet = null;
const sheetNamesCache = {};  // contentType -> string[]
const lastUpdatedCache = {}; // contentType -> ISO string
let currentContentType = null;
let latestSheet = null;
let reloadCooldownRemaining = 0;
let reloadTimerInterval = null;
let pendingNamesRefresh = false;

function populateLocalSheets(type) {
  const dataObj = getLocalData(type);
  const names = Object.keys(dataObj);
  const sel = document.getElementById('sheet-select');
  sel.innerHTML = '';
  if (!localFiles[type]) localFiles[type] = {};
  const initial = pickInitialSheet(names);
  names.forEach(n => {
    localFiles[type][n] = parseTSV(dataObj[n]);
    const opt = document.createElement('option');
    opt.value = n;
    opt.textContent = n;
    opt.selected = n === initial;
    sel.appendChild(opt);
  });
  latestSheet = names.length ? names[0] : null;
  if (initial) {
    loadSheet(initial);
  } else {
    document.getElementById('loading').textContent = 'No data for this content type.';
  }
}

// Default to the newest sheet (names arrive newest-first), unless a deep-link
// restore requested a specific one that actually exists. A stale link's sheet
// silently falls back to the newest.
function pickInitialSheet(names) {
  const pending = pendingSheet;
  pendingSheet = null;
  if (pending && names.includes(pending)) return pending;
  return names.length ? names[0] : null;
}

// ── Content type toggle ────────────────────────────────────────────────────

function loadContentType(type) {
  currentContentType = type;
  document.getElementById('btn-gw').classList.toggle('active',   type === 'Guild Wars');
  document.getElementById('btn-gbb').classList.toggle('active',  type === 'Guild Boss Battle');
  document.getElementById('btn-ggbb').classList.toggle('active', type === 'Global GBB');
  document.getElementById('btn-gc').classList.toggle('active',   type === 'Guild Conquest');
  document.getElementById('btn-gtt').classList.toggle('active',  type === 'Guild Training Ground');
  if (reloadTimerInterval) { clearInterval(reloadTimerInterval); reloadTimerInterval = null; }
  reloadCooldownRemaining = 0;
  latestSheet = null;
  pendingNamesRefresh = false;
  const reloadBtn = document.getElementById('reload-btn');
  if (reloadBtn) { reloadBtn.disabled = false; reloadBtn.textContent = '↺ Reload'; }
  document.getElementById('reload-ctrl').style.display = 'none';
  closePanel();
  document.getElementById('chart').innerHTML = '';
  clearStats();
  document.getElementById('sheet-ctrl-group').style.display = '';
  document.getElementById('loading').textContent = 'Loading…';
  document.getElementById('loading').style.display = 'block';
  document.getElementById('pivot-section').style.display = 'none';
  document.getElementById('player-table-section').style.display = 'none';
  document.getElementById('zoom-indicator').style.display = 'none';

  if (IS_LOCAL) {
    populateLocalSheets(type);
  } else {
    if (sheetNamesCache[type]) {
      applySheetNames(sheetNamesCache[type]);
    } else {
      document.getElementById('sheet-select').innerHTML = '<option>Loading…</option>';
      const onNames = function(json) {
        const names = typeof json === 'string' ? JSON.parse(json) : json;
        sheetNamesCache[type] = names;
        applySheetNames(names);
      };
      const onNamesErr = function(err) {
        showLoadError('Error: ' + err.message, function() { loadContentType(type); });
      };
      if (HAS_GAS) {
        google.script.run.withSuccessHandler(onNames).withFailureHandler(onNamesErr).getSheetNames(type);
      } else {
        apiCall('getSheetNames', { contentType: type }).then(onNames).catch(onNamesErr);
      }
    }

    if (lastUpdatedCache[type]) {
      applyLastUpdated(lastUpdatedCache[type]);
    } else {
      document.getElementById('updated-ctrl').style.display = 'none';
      fetchLastUpdated(type);
    }
  }
}

function noteLastUpdated(type, iso) {
  lastUpdatedCache[type] = iso;
  if (type === currentContentType) applyLastUpdated(iso);
}

// HAS_GAS only — in remote mode the Worker attaches x-last-updated to every
// /api response (it fetches the timestamp anyway to validate its cache; see
// apiCall), so the client never requests getLastUpdated itself.
function fetchLastUpdated(type) {
  if (!HAS_GAS) return;
  const onUpdated = function(iso) { noteLastUpdated(type, iso); };
  // "Last updated" is non-critical metadata: on failure, log it and leave
  // the control as-is rather than blocking the chart.
  const onUpdatedErr = function(err) { console.warn('getLastUpdated failed:', err); };
  google.script.run.withSuccessHandler(onUpdated).withFailureHandler(onUpdatedErr).getLastUpdated(type);
}

// Re-fetch the sheet list past the edge cache (Reload path) and refresh the
// dropdown in place — no auto-load, the current selection stays put. A newly
// published date shows up as a new option and becomes `latestSheet`.
function refreshSheetNames(type) {
  const onNames = function(json) {
    const names = typeof json === 'string' ? JSON.parse(json) : json;
    sheetNamesCache[type] = names;
    if (type !== currentContentType || !names.length) return;
    const sel = document.getElementById('sheet-select');
    sel.innerHTML = '';
    names.forEach(n => {
      const opt = document.createElement('option');
      opt.value = n;
      opt.textContent = n;
      sel.appendChild(opt);
    });
    latestSheet = names[0];
    sel.value = names.includes(currentSheet) ? currentSheet : names[0];
    updateReloadButton(currentSheet);
  };
  // Non-critical: the reload of the current sheet's data proceeds regardless.
  const onNamesErr = function(err) { console.warn('getSheetNames refresh failed:', err); };
  if (HAS_GAS) {
    google.script.run.withSuccessHandler(onNames).withFailureHandler(onNamesErr).getSheetNames(type);
  } else {
    apiCall('getSheetNames', { contentType: type, bust: 1 }).then(onNames).catch(onNamesErr);
  }
}

function applySheetNames(names) {
  const sel = document.getElementById('sheet-select');
  sel.innerHTML = '';
  const initial = pickInitialSheet(names);
  names.forEach(n => {
    const opt = document.createElement('option');
    opt.value = n;
    opt.textContent = n;
    opt.selected = n === initial;
    sel.appendChild(opt);
  });
  latestSheet = names.length ? names[0] : null;
  if (initial) loadSheet(initial);
}

function applyLastUpdated(iso) {
  const dt = new Date(iso);
  const date = dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const time = dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  document.getElementById('last-updated').textContent = date + ' · ' + time;
  document.getElementById('updated-ctrl').style.display = 'flex';
}

// ── Load a sheet ───────────────────────────────────────────────────────────

// `bust` (Reload path) is forwarded to the Worker so it skips its edge cache
// — getData caches for hours there, since dated sheets rarely change.
function loadSheet(name, bust) {
  currentSheet = name;
  updateDeepLink();
  updateReloadButton(name);

  const cached = (localFiles[currentContentType] || {})[name];
  if (cached) {
    closePanel();
    currentData = cached;
    document.getElementById('loading').style.display = 'none';
    buildChart(cached);
    return;
  }

  if (IS_LOCAL) {
    document.getElementById('loading').textContent = 'No data for this sheet.';
    return;
  }

  closePanel();
  document.getElementById('loading').style.display = 'block';
  document.getElementById('chart').innerHTML = '';
  clearStats();

  const onData = function(json) {
    document.getElementById('loading').style.display = 'none';
    currentData = typeof json === 'string' ? JSON.parse(json) : json;
    if (!localFiles[currentContentType]) localFiles[currentContentType] = {};
    localFiles[currentContentType][name] = currentData;
    buildChart(currentData);
    // Reload path: refresh the sheet list only after the data round-trip, so
    // the Worker can reuse the timestamp it just fetched instead of both
    // requests racing to fetch their own.
    if (pendingNamesRefresh) {
      pendingNamesRefresh = false;
      refreshSheetNames(currentContentType);
    }
  };
  const onDataErr = function(err) {
    showLoadError('Error: ' + err.message, function() { loadSheet(name); });
  };
  if (HAS_GAS) {
    google.script.run.withSuccessHandler(onData).withFailureHandler(onDataErr).getData(currentContentType, name);
  } else {
    const params = { contentType: currentContentType, sheet: name };
    if (bust) params.bust = 1;
    apiCall('getData', params).then(onData).catch(onDataErr);
  }
}

function updateReloadButton(name) {
  const ctrl = document.getElementById('reload-ctrl');
  if (!ctrl) return;
  ctrl.style.display = (!IS_LOCAL && latestSheet && name === latestSheet) ? '' : 'none';
}

function reloadSheet() {
  if (reloadCooldownRemaining > 0) return;
  if (localFiles[currentContentType]) delete localFiles[currentContentType][currentSheet];
  delete lastUpdatedCache[currentContentType];
  pendingNamesRefresh = true;
  loadSheet(currentSheet, true);
  fetchLastUpdated(currentContentType);
  startReloadCooldown();
}

function startReloadCooldown() {
  reloadCooldownRemaining = 60;
  const btn = document.getElementById('reload-btn');
  btn.disabled = true;
  btn.textContent = '↺ Reload (60s)';
  reloadTimerInterval = setInterval(function() {
    reloadCooldownRemaining--;
    if (reloadCooldownRemaining <= 0) {
      clearInterval(reloadTimerInterval);
      reloadTimerInterval = null;
      btn.disabled = false;
      btn.textContent = '↺ Reload';
    } else {
      btn.textContent = `↺ Reload (${reloadCooldownRemaining}s)`;
    }
  }, 1000);
}

// ── Local TSV file loading (file input) ────────────────────────────────────

function loadLocalFiles(files) {
  Array.from(files).forEach(file => {
    const reader = new FileReader();
    reader.onload = e => {
      const name = file.name.replace(/\.[^.]+$/, '');
      const data = parseTSV(e.target.result);
      if (!localFiles[currentContentType]) localFiles[currentContentType] = {};
      localFiles[currentContentType][name] = data;

      const sel = document.getElementById('sheet-select');
      if (!sel.querySelector(`option[value="${CSS.escape(name)}"]`)) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
      }
      sel.value = name;
      closePanel();
      currentData = data;
      document.getElementById('loading').style.display = 'none';
      clearStats();
      document.getElementById('chart').innerHTML = '';
      buildChart(data);
    };
    reader.onerror = function() {
      showLoadError('Could not read file: ' + file.name);
    };
    reader.readAsText(file);
  });
}
