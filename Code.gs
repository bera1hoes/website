const CONTENT_SOURCES = {
  'Guild Wars':        SpreadsheetApp.openById('1005020gHdlxoDemUK-r15yTWJAUuNqwm_lftxL61z54'),
  'Guild Boss Battle': SpreadsheetApp.openById('1GmBiAr6EK4w2AbNs-ardaglvjgI5hhhVUTdPUatmRT8'),
  'Global GBB':        SpreadsheetApp.openById('1kls0PfpClKkId86fpVEL62NN8kmTcERpU9__T4VVC5Q'),
  'Guild Conquest':    SpreadsheetApp.openById('1WFj_mrh1X88fk-A3pM5sqMknNo5pYUNtWO4aryiQE98'),
};

// JSON API. The front-end (Charts.html) is hosted statically (e.g. Cloudflare Pages)
// and calls this web app over GET:
//   ?action=getSheetNames&contentType=Guild%20Wars
//   ?action=getData&contentType=Guild%20Wars&sheet=05-18-2026
//   ?action=getLastUpdated&contentType=Guild%20Wars
// Spreadsheet IDs stay here, server-side, and are never exposed to the browser.
// GET-only on purpose: simple requests skip the CORS preflight that Apps Script can't answer.
function doGet(e) {
  const params = (e && e.parameter) || {};
  const action = params.action || '';
  let result;
  try {
    if (action === 'getSheetNames') {
      result = getSheetNames(params.contentType);
    } else if (action === 'getData') {
      result = getData(params.contentType, params.sheet);
    } else if (action === 'getLastUpdated') {
      result = getLastUpdated(params.contentType);
    } else {
      result = { error: 'Unknown or missing action: ' + action };
    }
  } catch (err) {
    result = { error: String((err && err.message) || err) };
  }
  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// Returns list of sheet names matching MM-DD-YYYY format, sorted descending.
function getSheetNames(contentType) {
  const ss = CONTENT_SOURCES[contentType] || SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ss.getSheets();
  const datePattern = /^\d{2}-\d{2}-\d{4}$/;
  return sheets
    .map(s => s.getName())
    .filter(name => datePattern.test(name))
    .sort((a, b) => {
      const toDate = s => `${s.slice(6)}-${s.slice(0,2)}-${s.slice(3,5)}`;
      return toDate(b).localeCompare(toDate(a));
    });
}

function getLastUpdated(contentType) {
  const ss = CONTENT_SOURCES[contentType] || SpreadsheetApp.getActiveSpreadsheet();
  return DriveApp.getFileById(ss.getId()).getLastUpdated().toISOString();
}

function getData(contentType, sheetName) {
  const ss = CONTENT_SOURCES[contentType] || SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet "' + sheetName + '" not found.');
  const rows = sheet.getDataRange().getValues();

  const headers = rows[0];
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
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row[cpIdx] || !row[scoreIdx]) continue;
    data.push({
      rank:       row[rankIdx],
      nick:       row[nickIdx],
      score:      Number(row[scoreIdx]),
      cls:        row[clsIdx],
      level:      row[levelIdx],
      cp:         Number(row[cpIdx]),
      guild:      row[guildIdx],
      scoreShort: row[scoreShortIdx],
      cpShort:    row[cpShortIdx]
    });
  }
  return data;
}
