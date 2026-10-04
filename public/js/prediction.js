// ── Win prediction ──────────────────────────────────────────────────────────
// Rosters are captured from mapleidle.gg by the SwissKnife mitmproxy addon and
// stored per-guild in KV (ROSTERS). When a sheet's data entry is created, a
// snapshot of its guilds' rosters is embedded into the chart data and rides along
// in the getData response as `sheetRosters` (data.js) — so prediction needs NO
// extra KV/network call. We find members missing from the content run, project
// their score from the live power-law fit (Score ≈ A·CP^B), and aggregate a
// projected per-guild total. mapleidle's join/leave log rides along as
// `sheetChanges` and dates that membership — see "Dating roster membership" below.
//
// Each missing member's projection can be tuned three ways (see projectMember):
//   • a per-player performance factor from history ("adjust by" Last week / History)
//   • a class-bias factor (the global class-adjust checkbox), as a fallback
//   • a manual % override (persisted in localStorage), which stacks on top.
//
// The curve those projections run off is `predictionFit()` — normally the chart's
// own fit, optionally the Experiments custom equation (see "Fit base" below).
//
// Metric per content type (mirrors buildPivotTable): GW Points for Guild Wars
// (rank-based via GW_POINTS_DATA), total Score for everything else. The per-player
// "Projected absentees" table (#missing-players-section) always shows raw projected
// scores.
//
// `Refresh rosters` (refreshRosters) re-pulls the roster snapshot from ROSTERS, and
// `buildPerfProfile` embeds the recency-weighted performance profile (plus the
// guild-history rollup) into the sheet — both write the chart-data entry on demand.
// The build usually already ran via guild-history.js's sheet-load trigger; the
// History-mode trigger here covers sheets that predate it.

// Content types that support history adjustment (mirror PERF_TYPES in worker.js).
const PREDICTION_PERF_TYPES = ['Guild Wars', 'Guild Boss Battle', 'Guild Training Ground'];

// ── Dating roster membership ─────────────────────────────────────────────────
// A roster snapshot is "today's members", but a sheet is a past week, and people
// move in both directions in between:
//   • someone who joined after the week is on today's roster but was never in the
//     guild for the run — projecting them inflates the guild's total;
//   • someone who left after the week is off today's roster but WAS a member who sat
//     the run out — dropping them deflates it.
// mapleidle's Member Changes log (captured alongside the roster, `sheetChanges`, and
// merged across captures by the Worker) dates every join/leave, and the uploader
// pre-labels each date with the week bucket it falls in per content type
// (guild_wars.py's _MODE_SCHEDULE — the same rule that picks which week a capture
// uploads to). So a change's week compares against the sheet's week directly.
//
// Membership during the sheet's week is read off the log (membershipAt): the first
// change AFTER that week says what the player was during it — a leave means they
// were in, a join means they weren't — and no change since means they were then what
// they are now. That also gets a leave-and-rejoin right, which a single "joined"
// date can't. Where the log is silent, the member's own stamps stand in:
// `joined_weeks` (the uploader's reading of the same log) and `gone_weeks` (the
// scores userscript saw them missing from mapleidle's member list — an upper bound
// on when they left).
//
// Ex-members come from the log too. The Worker copies a leaver's last roster CP onto
// their leave entry, so one who left after the week is projected like any other
// absentee (labelled "left"); a leave with no CP (gone before we ever had them on a
// roster) can only be counted.
//
// A change DURING the sheet's week is mid-run at best. mapleidle re-crawls a guild
// about once a day, so these dates are day-accurate, not minute-accurate, and the
// mid-week case is exactly the one that resolution can't settle — so those rows stay
// in the table struck through and out of every total, rather than silently dropped.

// Content type -> the upload mode its week labels are keyed by (mirrors
// CONTENT_MODE in worker.js).
const PREDICTION_CONTENT_MODE = {
  'Guild Wars': 'GW',
  'Guild Boss Battle': 'GBB',
  'Global GBB': 'GGBB',
  'Guild Conquest': 'GC',
  'Guild Training Ground': 'GTG',
};

// Content type -> mapleidle's key for the same content in a roster member's `mi`
// block (mirrors MAPLEIDLE_CONTENT in worker.js). Global GBB has no counterpart on
// their side, so it never gets a mapleidle-sourced factor.
const PREDICTION_MI_MODE = {
  'Guild Wars': 'guildWar',
  'Guild Boss Battle': 'guildBossBattle',
  'Guild Conquest': 'conquest',
  'Guild Training Ground': 'trainingGround',
};

// Content types the Worker keeps no roster snapshot for (mirrors NO_ROSTER_TYPES in
// worker.js), so there are no absentees to project and nothing to refresh.
const PREDICTION_NO_ROSTERS = ['Guild Conquest'];

// "MM-DD-YYYY" -> "YYYY-MM-DD" so week labels compare lexically (same trick as
// sortSheetsDesc in worker.js). '' for anything that isn't a week label.
function weekKey(label) {
  return (typeof label === 'string' && /^\d{2}-\d{2}-\d{4}$/.test(label))
    ? label.slice(6) + '-' + label.slice(0, 2) + '-' + label.slice(3, 5)
    : '';
}

// The comparable week key a { GW: "MM-DD-YYYY", … } map gives for the CURRENT
// content type, or '' when there's no label for it.
function weekKeyFor(weeks) {
  const mode = PREDICTION_CONTENT_MODE[currentContentType];
  return (weeks && mode) ? weekKey(weeks[mode]) : '';
}

// Nicks compare case-insensitively everywhere membership is decided: roster nicks
// come from mapleidle, participant nicks from the game, and change-log nicks from
// link text — three sources that needn't agree on case.
const nickKey = (nick) => String(nick || '').toLowerCase();

// One guild's change log grouped by nickKey: [{ action, wk, date, c }], wk being the
// comparable week key for the current content type. Entries with no label for this
// content type can't be placed, so they're dropped.
function changesByNick(guild) {
  const out = new Map();
  ((sheetChanges && sheetChanges[guild]) || []).forEach(c => {
    const wk = (c && c.nick) ? weekKeyFor(c.weeks) : '';
    if (!wk) return;
    const k = nickKey(c.nick);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push({ action: c.action, wk, date: String(c.date || ''), c });
  });
  return out;
}

// Was this player in the guild for the sheet's run? `events` are their changes
// (changesByNick), `member` their roster entry — null for an ex-member known only
// from the log. Returns { at: 'in' | 'mid' | 'out', action?, date? }, where a 'mid'
// carries the change that made it so.
function membershipAt(events, sheetKey, member) {
  const onRoster = !!member;
  if (!sheetKey) return { at: onRoster ? 'in' : 'out' };

  const during = events.find(e => e.wk === sheetKey);
  if (during) return { at: 'mid', action: during.action, date: during.date };

  // The first change after the week decides. A same-day join+leave pair can't be
  // ordered by date, so it's ordered to leave the player as they are now — for a
  // current member that's a leave-and-rejoin, for an ex-member a join-and-leave.
  const rank = e => ((e.action === 'leave') === onRoster ? 0 : 1);
  const after = events.filter(e => e.wk > sheetKey)
    .sort((a, b) => a.date.localeCompare(b.date) || rank(a) - rank(b));
  if (after.length) return { at: after[0].action === 'leave' ? 'in' : 'out' };

  // The log says nothing since the week — fall back to the member's own stamps.
  if (member) {
    const jk = weekKeyFor(member.joined_weeks);
    if (jk === sheetKey) return { at: 'mid', action: 'join', date: member.joined };
    if (jk > sheetKey) return { at: 'out' };
    const gk = weekKeyFor(member.gone_weeks);
    if (gk === sheetKey) return { at: 'mid', action: 'gone', date: member.gone };
    if (gk && gk < sheetKey) return { at: 'out' };
  }
  return { at: onRoster ? 'in' : 'out' };
}

// The table fields for a membership verdict: `excluded` keeps a mid-week row out of
// every total, `tag` is its pill, `why` its hover text.
function membershipFields(s) {
  if (s.at !== 'mid') return { excluded: false, tag: '', why: '' };
  const verb = s.action === 'join' ? 'Joined ' : s.action === 'gone' ? 'Gone from the guild by ' : 'Left ';
  return {
    excluded: true,
    tag: s.action === 'join' ? 'new' : 'left',
    why: verb + (s.date || '?') + ' — mid-week, so not counted toward the projection',
  };
}

// Everyone prediction has to account for in `guild` on this sheet: roster members
// who sat the run out, plus ex-members who were still in the guild that week (see
// "Dating roster membership" above). null when the sheet holds no roster for the
// guild. `tally`, when given, counts what was left out, for the status line:
// notMember (on the roster, but not in the guild that week), departed (ex-members
// projected from their carried CP), departedNoCp (ex-members we can only count).
function absenteesFor(guild, participantsLc, sheetKey, tally) {
  const roster = sheetRosters && sheetRosters[guild];
  if (!Array.isArray(roster)) return null;
  const bump = k => { if (tally) tally[k] = (tally[k] || 0) + 1; };
  const events = changesByNick(guild);
  const onRoster = new Set();
  const out = [];
  const row = (m, fields) => ({
    nick: m.nick, cp: m.cp, cls: m.cls || '', guild,
    // mapleidle's per-mode best scores, fetched onto the roster member by
    // tools/shoes-player-scores.user.js (and carried onto a leaver's leave entry).
    // Rides along in the snapshot, so this costs no extra call — see miFactor.
    mi: m.mi || null,
    departed: false,
    ...fields,
  });

  roster.forEach(m => {
    if (!m || !m.nick) return;
    const k = nickKey(m.nick);
    onRoster.add(k);
    if (participantsLc.has(k)) return;
    const s = membershipAt(events.get(k) || [], sheetKey, m);
    if (s.at === 'out') { bump('notMember'); return; }
    out.push(row(m, membershipFields(s)));
  });

  events.forEach((evs, k) => {
    if (onRoster.has(k) || participantsLc.has(k)) return;
    const s = membershipAt(evs, sheetKey, null);
    if (s.at === 'out') return;
    const leaves = evs.filter(e => e.action === 'leave').sort((a, b) => b.date.localeCompare(a.date));
    const carried = leaves.find(e => Number(e.c.cp) > 0);
    if (!carried) { if (s.at === 'in') bump('departedNoCp'); return; }
    if (s.at === 'mid') { out.push(row(carried.c, membershipFields(s))); return; }
    bump('departed');
    out.push(row(carried.c, {
      departed: true, excluded: false, tag: 'left',
      why: 'Left ' + leaves[0].date + ' — after this week, so projected from their last roster CP',
    }));
  });
  return out;
}

// The roster members prediction projects on this sheet, as { "<guild>": [nick, …] }
// — read by the scores userscript through the bridge so its targets can't drift
// from what prediction counts. Mid-week rows are left out (they don't count), and so
// are ex-members (scores are stored onto roster members, so theirs have nowhere to
// go). null until a sheet with rosters is loaded.
function predictionAbsentees() {
  if (!currentData || !sheetRosters) return null;
  const participantsLc = new Set(currentData.map(d => nickKey(d.nick)));
  const sheetKey = weekKey(currentSheet);
  const out = {};
  Object.keys(sheetRosters).forEach(guild => {
    const list = absenteesFor(guild, participantsLc, sheetKey);
    if (list) out[guild] = list.filter(m => !m.excluded && !m.departed).map(m => m.nick);
  });
  return out;
}

// 'none' | 'lastweek' | 'history' — how missing members' projections are tuned.
// Default to last-week adjustment. `preferredAdjustMode` remembers the user's choice
// across content switches so visiting a skipped type (which forces None) doesn't lose it.
let adjustMode = 'lastweek';
let preferredAdjustMode = 'lastweek';
// Client-built { nick -> factor } for Last-week mode (from the previous sheet that
// history.js already loads); rebuilt per sheet. History mode uses sheetPerf (data.js).
let lastWeekPerf = null;
let lastWeekFor = null;   // "contentType sheet" the lastWeekPerf was built for

// The last computed prediction inputs, kept so overrides / mode / toggle changes
// can re-render without recomputing the missing-member diff.
let lastPrediction = null;       // { guilds, missingByGuild, isGW }
let missingFlat = [];            // flattened missing rows backing the override inputs
let missingSortCol = 'final';    // absentees-table sort (like the player table)
let missingSortDir = 'desc';
let projAbsentGwPoints = {};     // nick -> projected GW points for absent members (GW only)

// A participant flagged as a likely sandbagger when this week's performance is at
// least this fraction below their historical norm (see annotateSandbag).
const SANDBAG_THRESHOLD = 0.20;  // 20% below history

// ── Manual per-player overrides (persisted) ──────────────────────────────────
// { "<nick>": <pct> } in localStorage, keyed by nick globally (a player's tendency
// is intrinsic, so it carries across sheets/content types). A +20 means "expect 20%
// above the projection"; it stacks on whatever base/factor is in effect.
const WP_OVERRIDE_KEY = 'wp_overrides';
let overrides = loadOverrides();

function loadOverrides() {
  try { return JSON.parse(localStorage.getItem(WP_OVERRIDE_KEY)) || {}; }
  catch { return {}; }
}
function getOverride(nick) {
  const v = overrides[nick];
  return (typeof v === 'number' && isFinite(v)) ? v : null;
}
function setOverride(nick, pct) {
  if (pct === null || pct === undefined || pct === '' || isNaN(pct)) delete overrides[nick];
  else overrides[nick] = Number(pct);
  try { localStorage.setItem(WP_OVERRIDE_KEY, JSON.stringify(overrides)); } catch {}
}

// ── Show/hide prediction tables (persisted) ──────────────────────────────────
let showPredictionTables = loadShowTables();
function loadShowTables() {
  try { const v = localStorage.getItem('wp_show_tables'); return v === null ? true : v === '1'; }
  catch { return true; }
}

// ── Fit base ─────────────────────────────────────────────────────────────────
// Projections run off the chart's own fit (activeFit) by default. The Experiments
// custom equation can take over as the base instead, so a what-if curve — a
// hand-written one, mapleidle's game-wide baseline, an older week's fit — projects
// the absentees without disturbing the chart's regression. The two stay separate
// on purpose: the custom fit line, the "vs Custom" column and this base are the
// same equation used three ways.
let useCustomFitBase = false;

// The { A, B } every projection runs through. Falls back to activeFit whenever the
// custom fit is off or unset, so clearing the equation can never strand the tables
// on a curve that's no longer on screen.
function predictionFit() {
  if (useCustomFitBase && custom.A != null && isFinite(custom.B)) {
    return { A: custom.A, B: custom.B, isCustom: true };
  }
  return { A: activeFit.A, B: activeFit.B, isCustom: false };
}

// ── Projection ───────────────────────────────────────────────────────────────

// The per-player performance factor for the active adjust mode, as
// { factor, source }, or null when the mode is off / we know nothing about them
// (→ caller falls back to mapleidle, then class, then raw).
//
// Last-week mode falls back to the multi-week profile when the player is missing
// from last week's sheet. Someone who sat last week out has no last-week signal,
// but that is no reason to discard the history we do have: the alternative is a
// mapleidle best-score proxy or a raw projection, and real history beats both.
// Rotating opponents make this common — a guild that skipped one week has every
// member fall through at once. The row is labelled with whichever profile was
// used, so the substitution stays visible rather than silently changing meaning.
function perfFactor(nick) {
  const hist = (sheetPerf && typeof sheetPerf[nick] === 'number') ? sheetPerf[nick] : null;
  if (adjustMode === 'history') {
    return hist == null ? null : { factor: hist, source: 'History' };
  }
  if (adjustMode === 'lastweek') {
    const wk = (lastWeekPerf && typeof lastWeekPerf[nick] === 'number') ? lastWeekPerf[nick] : null;
    if (wk != null) return { factor: wk, source: 'Last wk' };
    return hist == null ? null : { factor: hist, source: 'History' };
  }
  return null;
}

// mapleidle's own record for this player, as the same score/(A·cp^B) ratio the
// other modes produce — so it needs no rescaling to slot in. Their score is paired
// with the CP it was SET at, which is what makes the ratio comparable: running it
// through our current fit asks "what would our fit have predicted for them at that
// CP?", exactly as lastWeekPerf does with the previous sheet.
//
// It divides by whichever fit the projection multiplies back (predictionFit), so a
// swapped base cancels out of the ratio instead of doubling into it.
//
// Caveat worth knowing when reading the table: this is their BEST recorded score,
// not a typical week, so it reads optimistic against a history factor averaged
// over every week. It's a floor-raiser for players we'd otherwise project raw, not
// a like-for-like swap for real history — hence it only fills in where history is
// absent, and the row is labelled so you can see which is which.
function miFactor(member) {
  if (adjustMode === 'none') return null;   // the user asked for no adjustment
  const key = PREDICTION_MI_MODE[currentContentType];
  const rec = key && member.mi && member.mi.modes && member.mi.modes[key];
  const fit = predictionFit();
  if (!rec || !(rec.cp > 0) || !(rec.score > 0) || fit.A == null) return null;
  const pred = fit.A * Math.pow(rec.cp, fit.B);
  return pred > 0 ? rec.score / pred : null;
}

// Project a missing member, returning the breakdown the table shows. base is the raw
// fit at the member's CP (predictionFit — the chart's fit or the custom equation);
// factor is the chosen multiplier (history > mapleidle > class > 1); the manual %
// override stacks on top.
function projectMember(member) {
  const fit = predictionFit();
  const base = fit.A * Math.pow(member.cp, fit.B);
  let factor = 1, source = '—';
  const pf = perfFactor(member.nick);
  const mf = pf == null ? miFactor(member) : null;
  if (pf != null) {
    factor = pf.factor;
    source = pf.source;
  } else if (mf != null) {
    factor = mf;
    source = 'mapleidle';
  } else if (classAdjust && frozenFit.classBias) {
    factor = Math.pow(10, frozenFit.classBias[member.cls] || 0);
    if (factor !== 1) source = 'Class';
  }
  const ovr = getOverride(member.nick);
  const mult = ovr != null ? (1 + ovr / 100) : 1;
  return { base, factor, source, overridePct: ovr, final: base * factor * mult };
}

// Just the projected score (used by the aggregators).
function projectMemberScore(member) {
  return projectMember(member).final;
}

function setPredictionStatus(msg, color) {
  const el = document.getElementById('prediction-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = color || '#6b7280';
}

// ── Adjust-mode controls + data loading ──────────────────────────────────────

function adjustAllowed() { return PREDICTION_PERF_TYPES.includes(currentContentType); }

// Reflect the current content type in the selector: history/last-week are only
// offered for PERF content types; otherwise force None. Called on every sheet load
// (via clearPrediction) and at init.
function syncAdjustControls() {
  const sel = document.getElementById('adjust-mode');
  if (!sel) return;
  const allowed = adjustAllowed();
  Array.from(sel.options).forEach(o => { if (o.value !== 'none') o.disabled = !allowed; });

  // Last-week only means something when the previous sheet IS last week. These
  // content types run with breaks (GTG has had a 56-day one), and on such a sheet
  // "last week" would silently be a two-month-old run, so the option is disabled
  // and History — which weights every prior appearance by recency — takes over.
  const weekly = allowed && prevSheetIsLastWeek();
  const wkOpt = Array.from(sel.options).find(o => o.value === 'lastweek');
  const gap = (allowed && prevSheetName()) ? sheetGapDays(currentSheet, prevSheetName()) : null;
  if (wkOpt) {
    wkOpt.disabled = !weekly;
    wkOpt.title = weekly ? ''
      : (gap != null ? `Previous ${currentContentType} run was ${gap} days ago — not last week`
                     : 'No previous run to compare against');
  }

  // Allowed content types use the remembered preference (default "last week");
  // skipped types (Global GBB / Guild Conquest) force None. A remembered
  // "last week" degrades to History on a sheet where it doesn't apply, without
  // overwriting the preference — switch to a weekly sheet and it comes back.
  adjustMode = allowed ? preferredAdjustMode : 'none';
  if (adjustMode === 'lastweek' && !weekly) adjustMode = 'history';
  sel.value = adjustMode;
  sel.title = allowed ? '' : 'History adjustment isn’t available for this content type';
}

function onAdjustModeChange(val) {
  adjustMode = val;
  if (adjustAllowed()) preferredAdjustMode = val;  // remember across content switches
  if (lastPrediction) runPrediction();   // re-run with the new mode
}

// ── Fit-base control ─────────────────────────────────────────────────────────

// Checkbox handler. Re-runs rather than just re-rendering (like onAdjustModeChange)
// so the status line's base note is rewritten too; the adjust data is already
// cached, so the re-run costs no fetch.
function onPredictFitBase(checked) {
  useCustomFitBase = checked;
  syncFitBaseControl();
  if (lastPrediction) runPrediction();
}

// Keep the checkbox live only while a custom equation exists, and show which one.
// Called at init, on every sheet switch (clearPrediction) and whenever the custom
// fit changes.
function syncFitBaseControl() {
  const cb = document.getElementById('predict-custom-fit');
  if (!cb) return;
  const has = custom.A != null && isFinite(custom.B);
  if (!has) useCustomFitBase = false;   // nothing to project from → back to activeFit
  cb.disabled = !has;
  cb.checked = useCustomFitBase;
  const row = document.getElementById('predict-fit-base-row');
  if (row) {
    row.style.opacity = has ? '' : '0.55';
    row.title = has
      ? 'Project absentees from the custom equation instead of this sheet’s fit'
      : 'Set a Custom Fit Equation above to use it as the projection base';
  }
  const note = document.getElementById('predict-fit-note');
  if (note) {
    // The equation lives five sections up the panel, so echo it here — otherwise
    // "custom fit" is a base you can't see while you're reading the tables.
    note.textContent = (has && useCustomFitBase)
      ? `Score = ${custom.A.toExponential(3)} × CP^${custom.B.toFixed(3)}` : '';
  }
}

// Called from experiments.js when the custom equation is applied or cleared. A
// change to the base re-projects the cached diff; a clear falls back to activeFit
// (syncFitBaseControl has already flipped useCustomFitBase off by then, hence the
// `was` check).
function onCustomFitChanged() {
  const was = useCustomFitBase;
  syncFitBaseControl();
  if ((was || useCustomFitBase) && lastPrediction) runPrediction();
}

// Build the Last-week { nick -> factor } map from the previous sheet (which
// history.js already fetches), caching it per sheet. Resolves to the map or null.
//
// Returns null when the previous sheet isn't actually the preceding week. The
// control already degrades to History for those sheets, but this is the guard
// that matters: a deep link, a stale `preferredAdjustMode`, or the bridge calling
// in can all reach here with mode still 'lastweek', and building the map anyway
// would label a two-month-old run "Last wk".
function buildLastWeekPerf() {
  const key = currentContentType + ' ' + currentSheet;
  if (lastWeekFor === key && lastWeekPerf) return Promise.resolve(lastWeekPerf);
  const prev = (typeof prevSheetName === 'function') ? prevSheetName() : null;
  if (!prev) { lastWeekPerf = null; lastWeekFor = key; return Promise.resolve(null); }
  if (typeof prevSheetIsLastWeek === 'function' && !prevSheetIsLastWeek()) {
    lastWeekPerf = null; lastWeekFor = key; return Promise.resolve(null);
  }
  return getSheetRows(prev).then(rows => {
    let map = null;
    if (rows && rows.length) {
      const { A, B } = powerRegression(rows);
      if (A > 0 && isFinite(B)) {
        map = {};
        rows.forEach(r => {
          if (r && r.cp > 0 && r.score > 0) {
            const pred = A * Math.pow(r.cp, B);
            if (pred > 0) map[r.nick] = r.score / pred;
          }
        });
      }
    }
    lastWeekPerf = map; lastWeekFor = key;
    return map;
  });
}

// Make sure the active adjust mode's per-player data is loaded before computing.
function ensureAdjustData() {
  if (adjustMode === 'history') {
    if (sheetPerf) return Promise.resolve();
    if (!IS_REMOTE) return Promise.resolve();  // can't build off-remote → falls back
    setPredictionStatus('Building history profile…');
    return apiCall('buildPerfProfile', { contentType: currentContentType, sheet: currentSheet }).then(json => {
      const data = typeof json === 'string' ? JSON.parse(json) : json;
      // The build embeds the perf profile AND the guild-history rollup — apply
      // both (sandbag flags, player table, pivot history columns) in one place.
      applyBuiltEntry(data);
    });
  }
  if (adjustMode === 'lastweek') {
    setPredictionStatus('Loading last week…');
    return buildLastWeekPerf();
  }
  return Promise.resolve();
}

// ── Run ───────────────────────────────────────────────────────────────────────

// Experiments button handler. Uses the in-memory sheetRosters embedded in the
// sheet's chart data (no fetch) → zero extra KV reads, except a one-time
// buildPerfProfile when History mode has no embedded profile yet.
function runPrediction() {
  if (!currentData || predictionFit().A == null) {
    setPredictionStatus('Load a chart first.', '#f87171');
    return;
  }
  if (PREDICTION_NO_ROSTERS.includes(currentContentType)) {
    setPredictionStatus('Rosters are off for ' + currentContentType + ' — nothing to predict from.', '#facc15');
    return;
  }
  if (!sheetRosters || !Object.keys(sheetRosters).length) {
    setPredictionStatus(IS_REMOTE
      ? 'No rosters in this sheet yet — click “Refresh rosters”.'
      : 'Needs live data (remote mode).', '#facc15');
    return;
  }

  const btn = document.getElementById('predict-btn');
  if (btn) btn.disabled = true;

  ensureAdjustData()
    .then(() => computeAndRender())
    .catch(err => setPredictionStatus('Prediction failed: ' + err.message, '#f87171'))
    .finally(() => { if (btn) btn.disabled = false; });
}

function computeAndRender() {
  const isGW = currentContentType === 'Guild Wars';
  const guilds = [...new Set(currentData.map(d => d.guild))];
  const participantsLc = new Set(currentData.map(d => nickKey(d.nick)));

  // Collect everyone each guild has to account for — absent roster members and
  // ex-members still in the guild that week — dated against this sheet's week (see
  // "Dating roster membership" at the top).
  const sheetKey = weekKey(currentSheet);
  const missingByGuild = {};
  const tally = {};
  let withRoster = 0;
  guilds.forEach(guild => {
    const list = absenteesFor(guild, participantsLc, sheetKey, tally);
    missingByGuild[guild] = list || [];   // null: no roster snapshot for this guild
    if (list) withRoster++;
  });

  lastPrediction = { guilds, missingByGuild, isGW };
  renderAll();

  const flat = guilds.reduce((a, g) => a.concat(missingByGuild[g]), []);
  const totalMissing = flat.filter(m => !m.excluded).length;
  const midWeek = flat.length - totalMissing;
  const without = guilds.length - withRoster;
  const rosterNote = without ? '  ·  ' + without + ' guild(s) have no roster (try Refresh rosters)' : '';
  const joinNote = tally.notMember
    ? '  ·  skipped ' + tally.notMember + ' not in the guild that week (joined after / left before)' : '';
  const midNote = midWeek ? '  ·  ' + midWeek + ' joined or left mid-week (struck through, not counted)' : '';
  const leftNote =
    (tally.departed ? '  ·  ' + tally.departed + ' who left since projected from their last CP' : '') +
    (tally.departedNoCp ? '  ·  ' + tally.departedNoCp + ' left since (no CP to project)' : '');
  // Say so when Last-week wasn't an option: this content type had a break, so the
  // "previous" sheet is a different era of the guild and History took over.
  const prevGap = prevSheetName() ? sheetGapDays(currentSheet, prevSheetName()) : null;
  const gapNote = (adjustAllowed() && prevGap != null && !prevSheetIsLastWeek())
    ? '  ·  no run last week (previous was ' + prevGap + 'd ago) — using history' : '';

  let modeNote = '';
  if (adjustMode !== 'none') {
    const data = adjustMode === 'history' ? sheetPerf : lastWeekPerf;
    modeNote = (data && Object.keys(data).length)
      ? '  ·  ' + (adjustMode === 'history' ? 'history' : 'last-week') + '-adjusted'
      : '  ·  no history found (using class/raw)';
  }
  // How many rows the mapleidle fallback covered — i.e. players we'd otherwise
  // have projected raw. Counted off missingFlat, which renderAll just rebuilt.
  const miUsed = missingFlat.filter(r => r.source === 'mapleidle').length;
  const miNote = miUsed ? '  ·  ' + miUsed + ' from mapleidle (no history)' : '';
  const baseNote = predictionFit().isCustom ? '  ·  custom-fit base' : '';
  setPredictionStatus('Projected ' + totalMissing + ' missing members across ' + withRoster +
    ' guild(s)' + baseNote + modeNote + gapNote + miNote + joinNote + midNote + leftNote + rosterNote,
    without ? '#facc15' : '#4ade80');
}

// Recompute aggregates from the cached missing-member diff and re-render both tables
// (used after an override edit, mode change, or toggle). For Guild Wars it also
// re-ranks the combined population once to give each participant + absentee their
// projected GW points (shown in the player table and the absentees table).
function renderAll() {
  if (!lastPrediction) { applyTableVisibility(); return; }
  const { guilds, missingByGuild, isGW } = lastPrediction;

  let rows, proj = null;
  if (isGW) {
    proj = computeGwProjection(guilds, missingByGuild);
    projAbsentGwPoints = proj.absentByNick;
    currentData.forEach(d => { d.projGwPoints = proj.partByNick[d.nick]; });
    rows = aggregateGwPoints(guilds, missingByGuild, proj);
    if (typeof renderPlayerTable === 'function') renderPlayerTable();  // show Proj GW Pts
  } else {
    projAbsentGwPoints = {};
    currentData.forEach(d => { delete d.projGwPoints; });
    rows = aggregateScore(guilds, missingByGuild);
  }

  renderPredictionTable(rows, isGW);
  buildMissingFlat(missingByGuild, isGW);
  renderMissingRows();
  applyTableVisibility();
}

// ── Refresh rosters ───────────────────────────────────────────────────────────

// "Refresh rosters" button: re-pull the roster snapshot from the ROSTERS store
// into the current sheet's chart data, then update the in-memory sheetRosters.
// Returns the request's promise so a caller (the scores userscript, via the bridge)
// can wait for the new snapshot before re-running the prediction — without it the
// re-run projects from the old one.
function refreshRosters() {
  if (!IS_REMOTE) {
    setPredictionStatus('Needs live data (remote mode).', '#f87171');
    return;
  }
  if (!currentSheet || !currentContentType) {
    setPredictionStatus('Load a sheet first.', '#f87171');
    return;
  }
  if (PREDICTION_NO_ROSTERS.includes(currentContentType)) {
    setPredictionStatus('Rosters are off for ' + currentContentType + '.', '#facc15');
    return;
  }
  const btn = document.getElementById('refresh-rosters-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
  setPredictionStatus('Refreshing rosters from store…');

  return apiCall('refreshRosters', { contentType: currentContentType, sheet: currentSheet }).then(json => {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    sheetRosters = rostersOf(data);
    sheetChanges = rosterChangesOf(data);
    if (!rostersCache[currentContentType]) rostersCache[currentContentType] = {};
    rostersCache[currentContentType][currentSheet] = sheetRosters;
    if (!changesCache[currentContentType]) changesCache[currentContentType] = {};
    changesCache[currentContentType][currentSheet] = sheetChanges;
    const n = sheetRosters ? Object.keys(sheetRosters).length : 0;
    setPredictionStatus(n
      ? 'Rosters refreshed (' + n + ' guild(s)). Click “Predict winner”.'
      : 'No rosters in the store yet — capture them in SwissKnife first.',
      n ? '#4ade80' : '#facc15');
  }).catch(err => {
    setPredictionStatus('Refresh failed: ' + err.message, '#f87171');
  }).finally(() => {
    if (btn) { btn.disabled = false; btn.textContent = 'Refresh rosters'; }
  });
}

// ── Aggregation ────────────────────────────────────────────────────────────────

// The members a guild's projection actually counts: everyone in the missing list
// except those excluded for joining mid-week (see computeAndRender). They stay in
// missingByGuild so the table can show them struck through, so every aggregate has
// to filter here rather than assume the list is all-contributing.
function contributing(missing) {
  return missing.filter(m => !m.excluded);
}

// Total-score aggregation (non-GW content). projectedTotal = actual participant
// scores + projected scores of missing members.
function aggregateScore(guilds, missingByGuild) {
  const actual = {};
  currentData.forEach(d => { actual[d.guild] = (actual[d.guild] || 0) + (d.score || 0); });

  const rows = guilds.map(guild => {
    const missing = contributing(missingByGuild[guild]);
    const added = missing.reduce((s, m) => s + projectMemberScore(m), 0);
    const cur = actual[guild] || 0;
    return { guild, current: cur, missingCount: missing.length, added, total: cur + added };
  });
  return rankRows(rows, r => r.current, r => r.total);
}

// Re-rank the combined population (participants with real scores + missing members
// with projected scores), assign ranks 1..N, map rank→points via the sheet's points
// table (gw-points.js — the schedule changed on 09-03-2026), and
// return per-guild totals plus per-player points (split into participants vs absentees).
// Approximation: real GW ranking spans the whole league including guilds we have no
// roster for — this re-ranks only the guilds present in the sheet.
function computeGwProjection(guilds, missingByGuild) {
  const pointsFor = rank => gwPointsAt(currentSheet, rank) || 0;

  const pop = [];
  currentData.forEach(d => pop.push({ nick: d.nick, guild: d.guild, score: d.score || 0, absent: false }));
  // Excluded members are left out of the ranked population entirely — including them
  // would consume rank slots and push everyone else's points down.
  guilds.forEach(guild => contributing(missingByGuild[guild]).forEach(
    m => pop.push({ nick: m.nick, guild, score: projectMemberScore(m), absent: true })));
  pop.sort((a, b) => b.score - a.score);

  // `pop` is sorted by score, so index i is 1-based place i + 1 — the same
  // numbering joinGwPoints uses, so a projected #1 gets the real 1st-place value.
  const guildPoints = {}, partByNick = {}, absentByNick = {};
  pop.forEach((p, i) => {
    const pts = pointsFor(i + 1);
    guildPoints[p.guild] = (guildPoints[p.guild] || 0) + pts;
    if (p.absent) absentByNick[p.nick] = pts; else partByNick[p.nick] = pts;
  });
  return { guildPoints, partByNick, absentByNick };
}

// GW-points aggregation: per-guild current vs projected GW points. `proj` is the
// computeGwProjection result (computed once in renderAll); recomputed if omitted.
function aggregateGwPoints(guilds, missingByGuild, proj) {
  const current = {};
  currentData.forEach(d => { current[d.guild] = (current[d.guild] || 0) + (d.gwPoints || 0); });
  const guildPoints = (proj || computeGwProjection(guilds, missingByGuild)).guildPoints;

  const rows = guilds.map(guild => {
    const cur = current[guild] || 0;
    const tot = guildPoints[guild] || 0;
    return { guild, current: cur, missingCount: contributing(missingByGuild[guild]).length,
             added: tot - cur, total: tot };
  });
  return rankRows(rows, r => r.current, r => r.total);
}

// Flag participants whose THIS-week performance is notably below their historical
// norm (likely sandbaggers). Compares each player's current ratio score/(A·cp^B)
// against their recency-weighted history factor (sheetPerf, built from prior weeks).
// Annotates currentData with d.histDelta (% vs their norm) and d.sandbag. No-op
// until a history profile exists for the sheet (sheetPerf, via History mode).
function annotateSandbag() {
  if (!currentData) return;
  currentData.forEach(d => { delete d.histDelta; delete d.sandbag; });
  if (!sheetPerf || activeFit.A == null) return;
  currentData.forEach(d => {
    const hist = sheetPerf[d.nick];
    if (typeof hist !== 'number' || !(hist > 0) || !(d.cp > 0) || !(d.score > 0)) return;
    const cur = d.score / (activeFit.A * Math.pow(d.cp, activeFit.B));
    d.histDelta = (cur / hist - 1) * 100;
    d.sandbag = d.histDelta <= -SANDBAG_THRESHOLD * 100;
  });
}

// Sort by projected total desc and annotate each row with Δ rank (current rank
// by `curKey` minus projected rank) — positive means the guild climbs.
function rankRows(rows, curKey, totKey) {
  const curRank = new Map();
  [...rows].sort((a, b) => curKey(b) - curKey(a)).forEach((r, i) => curRank.set(r.guild, i + 1));
  rows.sort((a, b) => totKey(b) - totKey(a));
  rows.forEach((r, i) => { r.dRank = curRank.get(r.guild) - (i + 1); });
  return rows;
}

// ── Number formatting (shared by both tables) ───────────────────────────────────

function fmtScore(v) {
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  return Math.round(v).toLocaleString();
}

// ── Per-guild projected-totals table ────────────────────────────────────────────

function renderPredictionTable(rows, isGW) {
  const section = document.getElementById('prediction-section');
  if (!section) return;

  document.getElementById('prediction-th-metric').textContent = isGW ? 'GW Points' : 'Score';
  // Say so in the heading when the totals aren't coming off the chart's own fit.
  const fitNote = document.getElementById('prediction-fit-note');
  if (fitNote) fitNote.textContent = predictionFit().isCustom ? ' · custom fit' : '';
  const fmt = isGW ? v => Math.round(v).toLocaleString() : fmtScore;
  const fmtSigned = v => (v >= 0 ? '+' : '') + fmt(v);
  const dRankText = d => d > 0 ? '↑' + d : d < 0 ? '↓' + (-d) : '—';
  const dRankColor = d => d > 0 ? '#4ade80' : d < 0 ? '#f87171' : '#6b7280';

  const tbody = document.getElementById('prediction-body');
  tbody.innerHTML = '';
  rows.forEach((r, i) => {
    const color = GUILD_COLORS[r.guild] || GUILD_COLORS['default'];
    const tr = document.createElement('tr');
    if (i === 0) tr.className = 'pivot-total-row';  // highlight projected winner
    tr.innerHTML =
      `<td><span class="p-swatch" style="background:${color}"></span>` +
        `<a class="tlink" href="https://mapleidle.gg/guild/bera/${encodeURIComponent(r.guild)}" target="_blank" rel="noopener">${r.guild}</a>` +
        (i === 0 ? ' 👑' : '') + `</td>` +
      `<td>${fmt(r.current)}</td>` +
      `<td>${r.missingCount}</td>` +
      `<td style="color:${r.added >= 0 ? '#4ade80' : '#f87171'}">${fmtSigned(r.added)}</td>` +
      `<td><strong>${fmt(r.total)}</strong></td>` +
      `<td style="color:${dRankColor(r.dRank)}">${dRankText(r.dRank)}</td>`;
    tbody.appendChild(tr);
  });
}

// ── Per-player "Projected absentees" table ──────────────────────────────────────

// The adjustment cell: a small source pill + the factor as a signed %.
function factorText(factor, source) {
  if (source === '—' || !isFinite(factor)) return '<span style="color:#6b7280">—</span>';
  const pct = (factor - 1) * 100;
  const color = pct > 0 ? '#4ade80' : pct < 0 ? '#f87171' : '#6b7280';
  const sign = pct > 0 ? '+' : '';
  return `<span class="wp-pill">${source}</span> <span style="color:${color}">${sign}${pct.toFixed(0)}%</span>`;
}

// Flatten the missing-member diff into missingFlat (the rows backing the table +
// the override inputs, addressed by a stable _idx so sorting can't desync them).
function buildMissingFlat(missingByGuild, isGW) {
  missingFlat = [];
  Object.keys(missingByGuild).forEach(guild => {
    missingByGuild[guild].forEach(m => {
      const p = projectMember(m);
      // Excluded members aren't in the ranked population, so they have no projected
      // GW points — null renders as "—" rather than a misleading 0.
      const projGw = (isGW && !m.excluded) ? (projAbsentGwPoints[m.nick] || 0) : null;
      missingFlat.push({
        _idx: missingFlat.length, nick: m.nick, cp: m.cp, cls: m.cls, guild, projGw,
        excluded: m.excluded, tag: m.tag, why: m.why, ...p,
      });
    });
  });
}

const MISSING_NUMERIC = new Set(['cp', 'base', 'factor', 'overridePct', 'final', 'projGw']);

// Sortable headers (onclick in the markup), mirroring the player table's behavior.
function sortMissingBy(col) {
  if (missingSortCol === col) missingSortDir = missingSortDir === 'asc' ? 'desc' : 'asc';
  else { missingSortCol = col; missingSortDir = MISSING_NUMERIC.has(col) ? 'desc' : 'asc'; }
  renderMissingRows();
}

function renderMissingRows() {
  const tbody = document.getElementById('missing-body');
  if (!tbody) return;
  const isGW = !!(lastPrediction && lastPrediction.isGW);

  // GW-points column shows only for Guild Wars.
  const gwTh = document.getElementById('missing-th-gwpoints');
  if (gwTh) gwTh.style.display = isGW ? '' : 'none';

  // Which curve the Fit base column came from.
  const baseLbl = document.getElementById('missing-base-label');
  if (baseLbl) baseLbl.textContent = predictionFit().isCustom ? 'Fit base (custom)' : 'Fit base';

  // Sort-icon + aria state on the headers.
  document.querySelectorAll('#missing-table thead th.sortable').forEach(th => {
    const icon = th.querySelector('.sort-icon'); if (!icon) return;
    const active = th.dataset.col === missingSortCol;
    icon.textContent = active ? (missingSortDir === 'asc' ? '↑' : '↓') : '↕';
    icon.className = 'sort-icon' + (active ? ' active' : '');
    th.setAttribute('aria-sort', active ? (missingSortDir === 'asc' ? 'ascending' : 'descending') : 'none');
  });

  const cols = 7 + (isGW ? 1 : 0);
  if (!missingFlat.length) {
    tbody.innerHTML = '<tr><td colspan="' + cols + '" style="text-align:center;color:#6b7280">' +
      'No absent members — everyone in the rosters participated (or no rosters loaded).</td></tr>';
    return;
  }

  const col = missingSortCol, dir = missingSortDir, num = MISSING_NUMERIC.has(col);
  const val = r => num ? (Number(r[col]) || 0) : String(r[col] == null ? '' : r[col]);
  const sorted = [...missingFlat].sort((a, b) => {
    const cmp = num ? (val(a) - val(b)) : String(val(a)).localeCompare(String(val(b)));
    return dir === 'asc' ? cmp : -cmp;
  });

  tbody.innerHTML = '';
  sorted.forEach(row => {
    const color = GUILD_COLORS[row.guild] || GUILD_COLORS['default'];
    const nickHref = 'https://mapleidle.gg/characters/bera/' + encodeURIComponent(row.nick);
    const ovrVal = row.overridePct == null ? '' : row.overridePct;
    // Joined or left during this very week: struck through and left out of every
    // total — shown anyway so it's visible why they aren't counted. The pill ("new"
    // / "left") says WHY, so it opts out of the strike itself to stay legible. An
    // ex-member projected for a week they were still in gets the "left" pill unstruck.
    const tr = document.createElement('tr');
    const newPill = row.tag
      ? ` <span class="wp-pill" style="text-decoration:none">${row.tag}</span>` : '';
    if (row.excluded) {
      tr.style.textDecoration = 'line-through';
      tr.style.opacity = '0.55';
    }
    if (row.why) tr.title = row.why;
    let html =
      `<td><span class="p-swatch" style="background:${color}"></span>` +
        `<a class="tlink" href="https://mapleidle.gg/guild/bera/${encodeURIComponent(row.guild)}" target="_blank" rel="noopener">${row.guild}</a></td>` +
      `<td><a class="tlink" href="${nickHref}" target="_blank" rel="noopener">${row.nick}</a>${newPill}</td>` +
      `<td style="text-align:right">${toGamingNotation(row.cp)}</td>` +
      `<td style="text-align:right">${fmtScore(row.base)}</td>` +
      `<td style="text-align:right">${factorText(row.factor, row.source)}</td>` +
      `<td style="text-align:center"><input class="wp-ovr" type="number" step="5" value="${ovrVal}" placeholder="0" data-idx="${row._idx}" onchange="onOverrideInput(this)" aria-label="Override % for ${row.nick}"${row.excluded ? ` disabled title="Not counted — ${row.tag === 'new' ? 'joined' : 'left'} mid-week"` : ''}></td>`;
    if (isGW) html += `<td style="text-align:right">${row.projGw != null ? Math.round(row.projGw).toLocaleString() : '—'}</td>`;
    html += `<td style="text-align:right"><strong>${fmtScore(row.final)}</strong></td>`;
    tr.innerHTML = html;
    tbody.appendChild(tr);
  });
}

// Override input handler (onchange — fires on blur/Enter so re-rendering doesn't
// steal focus mid-edit). Persists, then re-aggregates + re-renders both tables.
function onOverrideInput(el) {
  const row = missingFlat[+el.dataset.idx];
  if (!row) return;
  const raw = (el.value || '').trim();
  setOverride(row.nick, raw === '' ? null : Number(raw));
  renderAll();
}

// ── Visibility / reset ──────────────────────────────────────────────────────────

function applyTableVisibility() {
  const has = !!lastPrediction;
  const predSec = document.getElementById('prediction-section');
  const missSec = document.getElementById('missing-players-section');
  const show = has && showPredictionTables ? 'block' : 'none';
  if (predSec) predSec.style.display = show;
  if (missSec) missSec.style.display = show;
}

function onShowTablesToggle(checked) {
  showPredictionTables = checked;
  try { localStorage.setItem('wp_show_tables', checked ? '1' : '0'); } catch {}
  applyTableVisibility();
}

// Hide + reset the prediction tables (called from buildChart on sheet/content
// switch so stale predictions don't carry across).
function clearPrediction() {
  lastPrediction = null;
  missingFlat = [];
  lastWeekPerf = null;
  lastWeekFor = null;
  projAbsentGwPoints = {};
  if (currentData) currentData.forEach(d => { delete d.projGwPoints; });
  applyTableVisibility();
  const tbody = document.getElementById('prediction-body');
  if (tbody) tbody.innerHTML = '';
  const mbody = document.getElementById('missing-body');
  if (mbody) mbody.innerHTML = '';
  syncAdjustControls();
  // The custom fit survives a sheet switch (chart.js re-draws it), so the base
  // choice does too — just re-sync the control against it.
  syncFitBaseControl();
  // Keep the gate note visible in non-remote modes (buildChart calls this on
  // every sheet switch, which would otherwise blank the explanation).
  setPredictionStatus(IS_REMOTE ? '' : 'Needs live data (remote mode).');
}

// ── Init ──────────────────────────────────────────────────────────────────────

(function initPrediction() {
  const tablesCb = document.getElementById('show-tables');
  if (tablesCb) tablesCb.checked = showPredictionTables;
  const sel = document.getElementById('adjust-mode');
  if (sel) sel.value = adjustMode;
  syncFitBaseControl();   // starts disabled — no custom equation at boot

  // Refresh rosters hits the roster store via the Worker — disable it off-remote.
  // (Predict stays enabled; it reports "needs live data" when there's no embedded
  // snapshot, which is always the case in local sample mode.)
  if (typeof IS_REMOTE !== 'undefined' && !IS_REMOTE) {
    const btn = document.getElementById('refresh-rosters-btn');
    if (btn) { btn.disabled = true; btn.title = 'Available on the deployed site'; }
    setPredictionStatus('Needs live data (remote mode).');
  }
})();
