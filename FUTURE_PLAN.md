# Future Plan — automatic new-sheet detection (names-only cron)

**Status: not started — parked for later.** This is the companion to the
shipped "Reload lands on the latest sheet" change. That change makes a
newly-published date *discoverable on demand*; this would make it *discoverable
automatically*, without anyone clicking Reload.

## Background — the gap this closes

After the KV migration ([FEATURE_PLAN.md](FEATURE_PLAN.md)), the `/api` read path
never touches Google. The sheet dropdown is built from `names:<type>` in KV, and
that key is only rewritten by:

1. **Lazy first-fill** — only when the key is *missing* (never, once seeded).
2. **Reload** (`?bust=1`) — `refreshSheetNames` re-pulls the list from Apps Script.

So a newly-published date is invisible — even to a fresh page load, which reads
the stale `names:<type>` straight from KV — until *someone* hits Reload. The
reload-lands-on-latest change makes that one click do the right thing and
propagate globally (KV is account-wide), but there is still **no automatic
freshness floor**: if nobody reloads, nobody sees the new week.

This plan adds that floor.

## Design — a scheduled handler that re-syncs names only

Reuse the `syncNames` helper already in `worker.js`. Add a Cron Trigger and a
`scheduled()` export that, every ~15–30 min, re-syncs **just the names list** for
each content type:

```jsonc
// wrangler.jsonc
"triggers": { "crons": ["*/20 * * * *"] }
```

```js
// worker.js
async scheduled(event, env, ctx) {
  for (const type of CONTENT_TYPES) {
    ctx.waitUntil(syncNames(env, type)); // getSheetNames + getLastUpdated → names:<type>
  }
}
```

- **Names only, not data.** A new date's *data* still fills lazily on first view
  (or on a Reload). The cron just keeps the *list* (and the `updated` timestamp)
  current, which is what surfaces a new date in the dropdown.
- **Write-only-on-change (optimization).** `syncNames` currently always writes.
  For the cron, gate the `KV.put` on the names/timestamp actually differing from
  what's stored, so steady-state ticks cost 0 writes. New dates appear ~weekly,
  so writes stay near zero.

## Interaction with the read path

- A fresh page load keeps reading `names:<type>` from KV — but now the cron keeps
  that current, so new visitors see the new date within one cron interval without
  anyone reloading.
- To make the page *land on* the new latest automatically (not just list it), the
  client already prefers `names[0]` on load — so once the cron refreshes names,
  the next load opens the newest sheet on its own. No client change needed beyond
  what shipped with the reload-latest work.
- Reload remains the instant, on-demand override.

## Cost estimate

Per tick: `CONTENT_TYPES.length` × (`getSheetNames` + `getLastUpdated`) Apps
Script calls — ~10 calls for 5 types — and **0 KV writes** unless a list changed.
At a 20-min cadence that's ~72 ticks/day ≈ 720 Apps Script calls/day, all
off the user critical path, and KV writes only on the rare week-boundary change.
Far under any free-tier limit. No data refetch, so payload volume is negligible.

## Open questions

- **Cadence.** 15–30 min is a reasonable freshness/quota balance; tighten only if
  new dates need to appear faster.
- **Scope creep.** If you later want the cron to also warm the *latest sheet's
  data* (so the first viewer doesn't pay the lazy-fill latency), have it
  additionally `syncData(env, type, names[0])` when the names list changed —
  still cheap because it's gated on change.
- **Cron vs. Apps Script push.** An alternative is an Apps Script
  time-driven/`onChange` trigger that pings `/admin/seed` when a sheet changes —
  zero polling and exact, but needs a trigger wired into each of the 5
  spreadsheets plus the `SEED_KEY`. The cron is simpler to own; revisit push if
  polling ever feels wasteful.
