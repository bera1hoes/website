// ── Parsed data + caches ───────────────────────────────────────────────────
// `currentData` is the array of player objects currently rendered.
// `localFiles` caches parsed sheets: contentType -> { sheetName -> data[] }.

let currentData = null;
const localFiles = {};

// ── Local data helpers ─────────────────────────────────────────────────────

function getLocalData(type) {
  if (type === 'Guild Wars')        return typeof GW_LOCAL_DATA   !== 'undefined' ? GW_LOCAL_DATA   : {};
  if (type === 'Guild Boss Battle') return typeof GBB_LOCAL_DATA  !== 'undefined' ? GBB_LOCAL_DATA  : {};
  if (type === 'Global GBB')        return typeof GGBB_LOCAL_DATA !== 'undefined' ? GGBB_LOCAL_DATA : {};
  return {};
}

// ── TSV parsing ────────────────────────────────────────────────────────────

function parseTSV(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split('\t');
  const rankIdx       = headers.indexOf('Rank');
  const nickIdx       = headers.indexOf('Nick');
  const scoreIdx      = headers.indexOf('Score');
  const clsIdx        = headers.indexOf('Class');
  const levelIdx      = headers.indexOf('Level');
  const cpIdx         = headers.indexOf('CP');
  const guildIdx      = headers.indexOf('GuildName');
  const scoreShortIdx = headers.indexOf('ScoreShort');
  const cpShortIdx    = headers.indexOf('CP Short');

  const data = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].replace(/\r$/, '').split('\t');
    if (!row[cpIdx] || !row[scoreIdx]) continue;
    data.push({
      rank:       Number(row[rankIdx]),
      nick:       row[nickIdx],
      score:      Number(row[scoreIdx]),
      cls:        row[clsIdx],
      level:      Number(row[levelIdx]),
      cp:         Number(row[cpIdx]),
      guild:      row[guildIdx],
      scoreShort: row[scoreShortIdx],
      cpShort:    row[cpShortIdx]
    });
  }
  return data;
}

function parseGWPoints(text) {
  const lines = text.trim().split('\n');
  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    const [rank, pts] = lines[i].split('\t');
    if (rank !== undefined && pts !== undefined) {
      map.set(rank.trim(), parseInt(pts.replace(/,/g, ''), 10));
    }
  }
  return map;
}
