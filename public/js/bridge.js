// ── Userscript bridge ────────────────────────────────────────────────────────
// Most of the chart's state lives in top-level `let`/`const` of classic scripts.
// Those land in the shared *script scope*, not on `window` — so `sheetRosters`
// resolves fine between our own files but is `undefined` to a Tampermonkey
// userscript, which runs in its own sandbox. (Plain `function` declarations DO
// land on window, which is why `refreshRosters` is reachable and `sheetRosters`
// is not.)
//
// Rather than have a userscript reach in with `unsafeWindow.eval('sheetRosters')`
// — which silently breaks the moment a variable is renamed — expose a small
// read-only surface it can depend on. Getters, so every read is live rather than
// a snapshot taken at install time.
//
// Consumer: tools/shoes-player-scores.user.js. It needs to know which guilds this
// sheet has rosters for, who sat the run out, and which of those we have no
// history for — then writes the fetched scores back in via refreshRosters().
// Keep this a *data* surface: the decision of who is worth fetching belongs to
// the script, not here. (`absentees` is data in that sense — who prediction
// projects — and lives on the page because a copy of that logic in the script
// would drift from the real one.)

window.shoesChart = {
  // What's on screen right now.
  get contentType() { return currentContentType; },
  get sheet() { return currentSheet; },

  // The sheet's embedded roster snapshot: { "<guild>": [ {nick, cp, cls, mi?}, … ] }.
  // Members already carrying an `mi` block are the ones already fetched.
  get rosters() { return sheetRosters; },

  // Every guild in this run — which is NOT the same as the roster keys. A guild
  // SwissKnife never captured has rows here but no roster, so prediction can't
  // project its absentees at all. The fetcher uses the difference to spot those
  // and build a roster from mapleidle's member list.
  get guilds() {
    return currentData ? [...new Set(currentData.map((d) => d.guild).filter(Boolean))] : [];
  },

  // Nicks that actually posted a score this run — everyone else on a roster is an
  // absentee, and absentees are the only players prediction has to project.
  get participants() { return currentData ? currentData.map((d) => d.nick) : []; },

  // The absentees prediction will actually project: { "<guild>": [nick, …] } — not
  // everyone absent, since the change log and join/leave stamps rule out members
  // who joined after this week or had left before it. Computed by prediction.js
  // (predictionAbsentees) so the fetcher's target list can't drift from what
  // prediction counts. null until a sheet with rosters is loaded.
  get absentees() { return predictionAbsentees(); },

  // The two per-player history maps prediction tunes projections with. A nick in
  // neither is one we know nothing about — exactly the gap mapleidle fills.
  get perf() { return sheetPerf; },
  get lastWeekPerf() { return lastWeekPerf; },

  // mapleidle's key for this content type, or null when they have no counterpart
  // (Global GBB). Null means there is nothing to fetch for this sheet.
  get miMode() { return PREDICTION_MI_MODE[currentContentType] || null; },

  // Re-pull the roster snapshot (picks up freshly-stored scores) and re-run the
  // projection, so a fetch can close its own loop. refreshRosters resolves once the
  // new snapshot is in — await it before runPrediction.
  refreshRosters: () => refreshRosters(),
  runPrediction: () => runPrediction(),
  buildLastWeekPerf: () => buildLastWeekPerf(),
};
