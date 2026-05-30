// Cloudflare Pages Function — same-origin proxy to the Apps Script JSON API.
// The browser calls /api?action=...&contentType=...&sheet=... (same origin, no CORS),
// and this runs the fetch server-side, where CORS does not apply. Keeps the Apps
// Script URL off the client and sidesteps Apps Script's inability to set CORS headers.
//
// Requirement: the Apps Script web app must be deployed with
//   Execute as: Me  ·  Who has access: Anyone
// Otherwise this server-side fetch receives a Google login page instead of JSON.

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzV3Ui_OS5LJ7K49YOZ1ropYZCbyAsuBfnrB2sERlh2y40ylivWxtdsgcQ2kTTpS4VG5w/exec';

export async function onRequest(context) {
  const incoming = new URL(context.request.url);
  const target = APPS_SCRIPT_URL + incoming.search; // forward the query string verbatim

  let upstream;
  try {
    upstream = await fetch(target, { method: 'GET', redirect: 'follow' });
  } catch (err) {
    return json({ error: 'Upstream fetch failed: ' + (err && err.message || err) }, 502);
  }

  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
  });
}
