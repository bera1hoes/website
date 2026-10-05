// ── Guild Conquest Points (rank + score → points) ─────────────────────────
// Guild Conquest is the game's "GuildBoss" content. Each player lands in a tier
// and earns that tier's points; a guild's in-game rank is the sum over its
// members ("Points are earned based on the individual rank, and the guild rank
// is calculated based on the total points of guild members" —
// UI_GUILD_RANKING_GUILDBOSS_TEXT_DESCRIPTION).
//
// Unlike Guild Wars, the tier depends on rank AND score. Transcribed from the
// datamine's GuildBossRankTierTable (GuildBossIndex 1, client 1.16.0), highest
// tier first. The rule is the client's
// GuildBossRankTierTableExtension.GetGuildBossRankTierDataFromCurrentScoreExt:
// walk the tiers from the top and take the first one whose MinScore the score
// reaches and whose MaxVisualRank, when it has one, the rank is within. From
// Master 5 down there's no rank cap, so the tier is set by score alone; every
// tier from Challenger 5 up needs the same 50M, so up there it's set by rank.
// The table's MaxScore and MinVisualRank are display-only; the client never
// reads them here.
//
// Ranks are 1-based, like the rest of the app. The client tests
// `rank0 + 1 <= MaxVisualRank` on the game's 0-indexed rank, which is the same
// check. A GC sheet is one world's whole ladder (GC ranks per world — see
// guild_crawl.py in SwissKnife), and that per-world place is the rank the client
// passes in, so the sheet's own 1..N numbering is the right input.

const GC_TIERS = [
  // tier                    MinScore            MaxVisualRank (0 = no cap)  TierPoint
  { name: 'Champion 1',    minScore: 50000000, maxRank: 1,    points: 1000000 },
  { name: 'Champion 2',    minScore: 50000000, maxRank: 2,    points:  800000 },
  { name: 'Champion 3',    minScore: 50000000, maxRank: 3,    points:  600000 },
  { name: 'Challenger 1',  minScore: 50000000, maxRank: 10,   points:  500000 },
  { name: 'Challenger 2',  minScore: 50000000, maxRank: 30,   points:  450000 },
  { name: 'Challenger 3',  minScore: 50000000, maxRank: 50,   points:  400000 },
  { name: 'Challenger 4',  minScore: 50000000, maxRank: 70,   points:  350000 },
  { name: 'Challenger 5',  minScore: 50000000, maxRank: 100,  points:  300000 },
  { name: 'Grandmaster 1', minScore: 45000000, maxRank: 150,  points:  250000 },
  { name: 'Grandmaster 2', minScore: 40000000, maxRank: 200,  points:  225000 },
  { name: 'Grandmaster 3', minScore: 35000000, maxRank: 250,  points:  200000 },
  { name: 'Grandmaster 4', minScore: 30000000, maxRank: 350,  points:  175000 },
  { name: 'Grandmaster 5', minScore: 25000000, maxRank: 500,  points:  150000 },
  { name: 'Master 1',      minScore: 20000000, maxRank: 1000, points:  125000 },
  { name: 'Master 2',      minScore: 17500000, maxRank: 2000, points:  110000 },
  { name: 'Master 3',      minScore: 15000000, maxRank: 3000, points:   95000 },
  { name: 'Master 4',      minScore: 12500000, maxRank: 5000, points:   80000 },
  { name: 'Master 5',      minScore: 10000000, maxRank: 0,    points:   65000 },
  { name: 'Diamond 1',     minScore:  3000000, maxRank: 0,    points:   50000 },
  { name: 'Platinum 1',    minScore:  1500000, maxRank: 0,    points:   40000 },
  { name: 'Gold 1',        minScore:   500000, maxRank: 0,    points:   30000 },
  { name: 'Silver 1',      minScore:   200000, maxRank: 0,    points:   20000 },
  { name: 'Bronze 1',      minScore:        1, maxRank: 0,    points:   10000 },
];

// A guild's title, from the datamine's GuildBossGuildRankTierTable — same shape,
// but scored on the guild's total points (the sum above) and its place among the
// world's guilds. It carries no points of its own (its reward is a Noblesse skill
// tier). The client's GetGuildBossGuildRankTierDataFromCurrentScoreExt is the same
// walk as the player one.
const GC_GUILD_TIERS = [
  // tier                    MinScore           MaxVisualRank (0 = no cap)
  { name: 'Champion 1',    minScore: 3000000, maxRank: 1 },
  { name: 'Champion 2',    minScore: 3000000, maxRank: 2 },
  { name: 'Champion 3',    minScore: 3000000, maxRank: 3 },
  { name: 'Challenger 1',  minScore: 3000000, maxRank: 4 },
  { name: 'Challenger 2',  minScore: 3000000, maxRank: 5 },
  { name: 'Challenger 3',  minScore: 3000000, maxRank: 7 },
  { name: 'Challenger 4',  minScore: 3000000, maxRank: 9 },
  { name: 'Challenger 5',  minScore: 3000000, maxRank: 11 },
  { name: 'Grandmaster 1', minScore: 3000000, maxRank: 13 },
  { name: 'Grandmaster 2', minScore: 2800000, maxRank: 15 },
  { name: 'Grandmaster 3', minScore: 2600000, maxRank: 17 },
  { name: 'Grandmaster 4', minScore: 2400000, maxRank: 20 },
  { name: 'Grandmaster 5', minScore: 2200000, maxRank: 25 },
  { name: 'Master 1',      minScore: 2000000, maxRank: 30 },
  { name: 'Master 2',      minScore: 1800000, maxRank: 35 },
  { name: 'Master 3',      minScore: 1600000, maxRank: 40 },
  { name: 'Master 4',      minScore: 1400000, maxRank: 50 },
  { name: 'Master 5',      minScore: 1200000, maxRank: 75 },
  { name: 'Diamond 1',     minScore: 1000000, maxRank: 100 },
  { name: 'Platinum 1',    minScore:  500000, maxRank: 300 },
  { name: 'Gold 1',        minScore:  300000, maxRank: 500 },
  { name: 'Silver 1',      minScore:  100000, maxRank: 0 },
  { name: 'Bronze 1',      minScore:       1, maxRank: 0 },
];

// The client's walk over either table: the first tier (highest first) whose
// minimum the score reaches and whose rank cap, if any, the 1-based rank is
// within. Undefined below Bronze's 1 — no tier, same as the client's null.
function gcTierWalk(tiers, rank, score) {
  return tiers.find(t => score >= t.minScore && (!t.maxRank || rank <= t.maxRank));
}

// A player's tier at `rank` with `score`.
function gcTierAt(rank, score) {
  return gcTierWalk(GC_TIERS, rank, score);
}

// A guild's title at `rank` among the world's guilds with `points` in total.
function gcGuildTierAt(rank, points) {
  return gcTierWalk(GC_GUILD_TIERS, rank, points);
}
