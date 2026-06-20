#!/usr/bin/env node
/**
 * Fork-and-deploy wizard — stand up your own copy of this site on YOUR OWN
 * Cloudflare account. Run: `npm run setup` (add `--dry-run` to preview every
 * action without creating/changing anything).
 *
 * What it does (the Cloudflare half — see README "Run your own copy"):
 *   1. Preflight: confirm wrangler is logged into YOUR account.
 *   2. Collect config + GENERATE the CHART_WRITE_KEY / ROSTER_WRITE_KEY once, so
 *      the same value lands on both the Worker (secret) and SwissKnife (config).
 *   3. Create your own KV namespaces (CHART_DATA + ROSTERS) and render a
 *      `wrangler.fork.jsonc` from `wrangler.template.jsonc`.
 *   4. `wrangler deploy -c wrangler.fork.jsonc`, then set the secrets, then a
 *      smoke test.
 *   5. Wire SwissKnife (write its nexon_config.json, or print the values).
 *
 * Safety (see SETUP_PLAN.md "Safety"):
 *   - Generates, never mutates: writes only `guild.config.json` + `wrangler.fork.jsonc`
 *     (both git-ignored). The owner's committed `wrangler.jsonc` is never touched.
 *   - Fails closed: refuses to deploy if the worker name or a KV id matches the
 *     owner's (read live from the committed `wrangler.jsonc`).
 *   - Account isolation does the heavy lifting: every wrangler call acts only on
 *     the account you logged into — it cannot reach the owner's Worker/KV/secrets.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const argv = new Set(process.argv.slice(2));
const DRY_RUN = argv.has('--dry-run') || argv.has('-n');
const ASSUME_YES = argv.has('--yes') || argv.has('-y');

const CONFIG_PATH = join(root, 'guild.config.json');
const TEMPLATE_PATH = join(root, 'wrangler.template.jsonc');
const FORK_WRANGLER_REL = 'wrangler.fork.jsonc';
const FORK_WRANGLER_PATH = join(root, FORK_WRANGLER_REL);

// A real-browser UA: a workers.dev/zone behind Cloudflare Bot Fight Mode 403s the
// default Node fetch agent (same reason SwissKnife sets one for /chart).
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const C = { dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`, warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m` };
const log = (s = '') => output.write(s + '\n');
const step = (n, s) => log('\n' + C.b(`[${n}] ${s}`));

function printHelp() {
  log(`Fork-and-deploy wizard\n
Usage: npm run setup [-- <flags>]
  --dry-run, -n   Preview every action; create/change nothing.
  --yes, -y       Skip confirmation prompts (non-interactive where possible).
  --help, -h      This help.`);
}
if (argv.has('--help') || argv.has('-h')) { printHelp(); process.exit(0); }

// ── wrangler runner ──────────────────────────────────────────────────────────
// Invoke wrangler's JS entry with the current node binary (sidesteps Windows
// .cmd quoting when the repo path has a space).
function wranglerBin() {
  let pkgPath;
  try {
    pkgPath = require.resolve('wrangler/package.json');
  } catch {
    throw new Error('wrangler is not installed. Run: npm install');
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.wrangler;
  return join(dirname(pkgPath), binRel);
}

// stdin: feed a value (e.g. a secret) on the child's stdin.
// capture: return stdout as a string (stderr still streams to the terminal).
function wrangler(wargs, { stdin, capture } = {}) {
  if (DRY_RUN) { log(C.dim(`  [dry-run] wrangler ${wargs.join(' ')}`)); return ''; }
  const stdio = capture ? ['pipe', 'pipe', 'inherit']
    : (stdin !== undefined ? ['pipe', 'inherit', 'inherit'] : 'inherit');
  return execFileSync(process.execPath, [wranglerBin(), ...wargs],
    { cwd: root, stdio, input: stdin, encoding: 'utf8' });
}

// ── owner guard ──────────────────────────────────────────────────────────────
// Read the owner's worker name + KV ids from the committed wrangler.jsonc so the
// fail-closed checks stay correct even if those values change later.
function ownerGuard() {
  try {
    const txt = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');
    const nameM = txt.match(/"name"\s*:\s*"([^"]+)"/);
    const ids = new Set([...txt.matchAll(/"(?:preview_)?id"\s*:\s*"([0-9a-fA-F]{32})"/g)].map((m) => m[1]));
    return { name: nameM ? nameM[1] : 'website', ids };
  } catch {
    return { name: 'website', ids: new Set() };
  }
}

function assertNotOwner(cfg, owner) {
  if (cfg.workerName && cfg.workerName === owner.name) {
    throw new Error(`Refusing to proceed: worker name "${cfg.workerName}" is the owner's. Pick a different name for your fork.`);
  }
  for (const id of [cfg.kv?.chartDataId, cfg.kv?.chartDataPreviewId, cfg.kv?.rostersId].filter(Boolean)) {
    if (owner.ids.has(id)) {
      throw new Error(`Refusing to proceed: KV id ${id} belongs to the owner's account. The wizard must create your own namespaces.`);
    }
  }
}

// ── config ───────────────────────────────────────────────────────────────────
function loadConfig() {
  if (existsSync(CONFIG_PATH)) {
    try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { /* start fresh */ }
  }
  return {};
}
function saveConfig(cfg) {
  if (DRY_RUN) { log(C.dim(`  [dry-run] would write ${CONFIG_PATH}`)); return; }
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}
const genKey = () => randomBytes(24).toString('base64url');

// ── KV provisioning ──────────────────────────────────────────────────────────
function parseKvId(out, preview) {
  const pats = preview
    ? [/preview_id\s*=\s*"([0-9a-fA-F]{32})"/, /"preview_id"\s*:\s*"([0-9a-fA-F]{32})"/,
       /\bid\s*=\s*"([0-9a-fA-F]{32})"/, /"id"\s*:\s*"([0-9a-fA-F]{32})"/]
    : [/\bid\s*=\s*"([0-9a-fA-F]{32})"/, /"id"\s*:\s*"([0-9a-fA-F]{32})"/];
  for (const p of pats) { const m = out.match(p); if (m) return m[1]; }
  return null;
}

function createKv(binding, preview) {
  const wargs = ['kv', 'namespace', 'create', binding];
  if (preview) wargs.push('--preview');
  if (DRY_RUN) { wrangler(wargs); return preview ? `dryrun-preview-${binding}` : `dryrun-${binding}`; }
  const out = wrangler(wargs, { capture: true }) || '';
  process.stdout.write(out);
  const id = parseKvId(out, preview);
  if (!id) {
    throw new Error(`Could not parse the ${preview ? 'preview_id' : 'id'} from "wrangler kv namespace create ${binding}` +
      `${preview ? ' --preview' : ''}". Copy it from the output above into ${FORK_WRANGLER_REL} and re-run.`);
  }
  return id;
}

// ── template render ──────────────────────────────────────────────────────────
function renderForkWrangler(cfg) {
  let t = readFileSync(TEMPLATE_PATH, 'utf8');
  t = t.replaceAll('__WORKER_NAME__', cfg.workerName)
    .replaceAll('__CHART_DATA_ID__', cfg.kv.chartDataId)
    .replaceAll('__CHART_DATA_PREVIEW_ID__', cfg.kv.chartDataPreviewId)
    .replaceAll('__ROSTERS_ID__', cfg.kv.rostersId);
  if (DRY_RUN) { log(C.dim(`  [dry-run] would write ${FORK_WRANGLER_PATH}`)); return; }
  writeFileSync(FORK_WRANGLER_PATH, t);
  log(C.ok(`  Wrote ${FORK_WRANGLER_REL}`));
}

// ── main ─────────────────────────────────────────────────────────────────────
const rl = createInterface({ input, output });
const ask = async (q, def) => ((await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim() || def || '');
const confirm = async (q) => ASSUME_YES || ['y', 'yes'].includes((await rl.question(`${q} (y/N): `)).trim().toLowerCase());

async function main() {
  const owner = ownerGuard();
  const cfg = loadConfig();
  cfg.kv = cfg.kv || {};

  log(C.b('\n=== Fork-and-deploy wizard ===') + (DRY_RUN ? C.warn('  (dry run — nothing will be created)') : ''));
  log(C.dim('Deploys this site to YOUR Cloudflare account. Run `wrangler login` against that account first.'));

  // [1] Preflight
  step(1, 'Preflight — Cloudflare login');
  try {
    const who = wrangler(['whoami'], { capture: true });
    if (who) process.stdout.write(who);
  } catch {
    log('  Not logged in. Launching `wrangler login`…');
    wrangler(['login']);
  }

  // [2] Config + key generation
  step(2, 'Configuration');
  cfg.workerName = await ask('Worker name (your *.workers.dev subdomain prefix)', cfg.workerName);
  if (!cfg.workerName) throw new Error('A worker name is required.');
  if (cfg.workerName === owner.name) throw new Error(`"${owner.name}" is the owner's worker name — choose another.`);
  cfg.guildName = await ask('Your guild name (optional, for branding)', cfg.guildName);
  cfg.chartWriteKey = cfg.chartWriteKey || genKey();
  cfg.rosterWriteKey = cfg.rosterWriteKey || genKey();
  cfg.swissknifeDataDir = await ask('SwissKnife data dir to auto-write nexon_config.json (optional, blank = print values)', cfg.swissknifeDataDir);
  saveConfig(cfg);
  log(C.ok(`  Saved ${CONFIG_PATH} (git-ignored; holds your generated write keys).`));

  // [3] KV + fork wrangler config
  step(3, 'Provision KV namespaces + render fork config');
  if (!cfg.kv.chartDataId) cfg.kv.chartDataId = createKv('CHART_DATA', false);
  if (!cfg.kv.chartDataPreviewId) cfg.kv.chartDataPreviewId = createKv('CHART_DATA', true);
  if (!cfg.kv.rostersId) cfg.kv.rostersId = createKv('ROSTERS', false);
  saveConfig(cfg);
  assertNotOwner(cfg, owner); // fail-closed before anything deploys
  renderForkWrangler(cfg);

  // [4] Deploy + secrets + smoke test
  step(4, 'Deploy');
  if (!(await confirm(`Deploy worker "${cfg.workerName}" to your Cloudflare account now?`))) {
    log(C.warn('  Skipped deploy. Re-run when ready; config is saved.'));
    return;
  }
  const deployOut = wrangler(['deploy', '-c', FORK_WRANGLER_REL], { capture: true }) || '';
  process.stdout.write(deployOut);
  const siteUrl = (deployOut.match(/https:\/\/[^\s]+\.workers\.dev/) || [])[0]
    || `https://${cfg.workerName}.<your-subdomain>.workers.dev`;

  log('\n  Setting secrets (worker now exists)…');
  wrangler(['secret', 'put', 'CHART_WRITE_KEY', '-c', FORK_WRANGLER_REL], { stdin: cfg.chartWriteKey + '\n' });
  wrangler(['secret', 'put', 'ROSTER_WRITE_KEY', '-c', FORK_WRANGLER_REL], { stdin: cfg.rosterWriteKey + '\n' });

  log('\n  Smoke test…');
  if (!DRY_RUN && siteUrl.startsWith('https://') && !siteUrl.includes('<')) {
    try {
      const r1 = await fetch(`${siteUrl}/api?action=getSheetNames&contentType=${encodeURIComponent('Guild Wars')}`, { headers: { 'user-agent': BROWSER_UA } });
      log(`    GET /api getSheetNames -> ${r1.status} ${(await r1.text()).slice(0, 40)} ` + C.dim('(expect 200 [])'));
      const r2 = await fetch(`${siteUrl}/chart`, { method: 'POST', headers: { 'user-agent': BROWSER_UA } });
      log(`    POST /chart (no auth) -> ${r2.status} ` + C.dim('(expect 401)'));
    } catch (e) { log(C.warn(`    Smoke test could not reach the site: ${e.message}`)); }
  } else {
    log(C.dim('    (skipped — dry run or URL not parsed)'));
  }

  // [5] SwissKnife wiring
  step(5, 'Wire SwissKnife (capture side)');
  const fields = { roster_worker_url: siteUrl, chart_write_key: cfg.chartWriteKey, roster_write_key: cfg.rosterWriteKey };
  if (cfg.swissknifeDataDir) {
    const p = join(cfg.swissknifeDataDir, 'nexon_config.json');
    let data = {};
    if (existsSync(p)) { try { data = JSON.parse(readFileSync(p, 'utf8')); } catch { /* overwrite */ } }
    Object.assign(data, fields);
    if (DRY_RUN) { log(C.dim(`  [dry-run] would write ${p}`)); }
    else { writeFileSync(p, JSON.stringify(data, null, 2)); log(C.ok(`  Wrote ${p}`)); }
  } else {
    log('  No SwissKnife data dir given. In SwissKnife → Settings (Win Prediction), set:');
    log(`    Site URL:         ${C.b(siteUrl)}`);
    log(`    Chart Write Key:  ${C.b(cfg.chartWriteKey)}`);
    log(`    Roster Write Key: ${C.b(cfg.rosterWriteKey)}`);
  }

  log(C.ok('\n✓ Done.') + ` Open ${siteUrl}/charts (it stays empty until SwissKnife captures + pushes data).`);
  log(C.dim('  Capture setup (mitmproxy install, cert trust, routing the game) is manual — see README.'));
}

main()
  .catch((e) => { log('\n' + C.err(`✗ ${e.message || e}`)); process.exitCode = 1; })
  .finally(() => rl.close());
