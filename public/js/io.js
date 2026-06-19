// ── Environment detection + data fetching ──────────────────────────────────
// Chart data lives in Cloudflare Workers KV and is served by the same-origin
// Worker (worker.js) at /api. SwissKnife feeds KV via POST /chart; there is no
// Google in the loop.
const API_URL = '/api';  // same-origin Worker; see worker.js

// Local sample-data mode: file:// or a localhost dev server, with no remote API.
const IS_LOCAL = (
  !API_URL ||
  location.protocol === 'file:' ||
  location.hostname === 'localhost' ||
  location.hostname === '127.0.0.1'
);
// Remote mode: static page (Cloudflare) fetching JSON from the Worker's /api.
const IS_REMOTE = !IS_LOCAL;

// Read-only GET wrapper for the Worker's /api (remote mode).
// Aborts after a timeout so a hung request can't leave the UI stuck on "Loading…".
const API_TIMEOUT_MS = 15000;

function apiCall(action, params) {
  const qs = new URLSearchParams(Object.assign({ action: action }, params || {}));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  return fetch(API_URL + '?' + qs.toString(), { signal: ctrl.signal }).then(r => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    // The Worker stamps each names record with an `updated` time at upload and
    // attaches it as x-last-updated on every response — read it here instead of
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
      apiCall('getSheetNames', { contentType: type }).then(onNames).catch(onNamesErr);
    }

    // "Last updated" rides the x-last-updated header on the getSheetNames
    // response (noteLastUpdated in apiCall) — no separate fetch needed.
    if (lastUpdatedCache[type]) {
      applyLastUpdated(lastUpdatedCache[type]);
    } else {
      document.getElementById('updated-ctrl').style.display = 'none';
    }
  }
}

function noteLastUpdated(type, iso) {
  lastUpdatedCache[type] = iso;
  if (type === currentContentType) applyLastUpdated(iso);
}

// Re-fetch the sheet list past the cache (Reload path) and rebuild the dropdown.
// With `loadLatest` (the Reload button), it then selects and loads the newest
// sheet — so Reload lands on a freshly-published date instead of merely adding
// it as a dropdown option while leaving the stale sheet on screen. Without it,
// the current selection stays put.
function refreshSheetNames(type, loadLatest) {
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
    const target = loadLatest ? latestSheet : (names.includes(currentSheet) ? currentSheet : names[0]);
    sel.value = target;
    if (loadLatest) {
      // Drop any cached copy so the latest sheet's data is refetched (it may be
      // newly published, or the actively-edited sheet the user was already on).
      if (localFiles[type]) delete localFiles[type][target];
      loadSheet(target, true);
    } else {
      updateReloadButton(currentSheet);
    }
  };
  const onNamesErr = function(err) {
    console.warn('getSheetNames refresh failed:', err);
    // Reload still owes the user fresh data even if the list fetch fails — fall
    // back to refetching whatever sheet they're currently on.
    if (loadLatest && type === currentContentType) {
      if (localFiles[type]) delete localFiles[type][currentSheet];
      loadSheet(currentSheet, true);
    }
  };
  apiCall('getSheetNames', { contentType: type }).then(onNames).catch(onNamesErr);
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

// `bust` (Reload path) drops the in-memory cache for this sheet (done by the
// caller) and re-reads /api. KV is no-store, so the re-read is always fresh —
// the Worker needs no bust signal.
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
    loadHistory();
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
    loadHistory();
  };
  const onDataErr = function(err) {
    showLoadError('Error: ' + err.message, function() { loadSheet(name); });
  };
  apiCall('getData', { contentType: currentContentType, sheet: name }).then(onData).catch(onDataErr);
}

function updateReloadButton(name) {
  const ctrl = document.getElementById('reload-ctrl');
  if (!ctrl) return;
  ctrl.style.display = (!IS_LOCAL && latestSheet && name === latestSheet) ? '' : 'none';
}

function reloadSheet() {
  if (reloadCooldownRemaining > 0) return;
  delete lastUpdatedCache[currentContentType];
  // Names-first: refresh the sheet list, then load whatever is now the latest
  // sheet. A newly-published date is shown (not just added to the dropdown),
  // and when there's no new date this falls through to refetching the current
  // (latest) sheet — the only one Reload is offered on. The refreshed
  // getSheetNames response carries x-last-updated, refreshing the timestamp too.
  refreshSheetNames(currentContentType, true);
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
