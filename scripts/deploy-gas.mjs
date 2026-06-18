#!/usr/bin/env node
/**
 * One-command Apps Script deploy.
 *
 * `clasp push` uploads Code.gs to the script's HEAD, but the live /exec URL
 * (worker.js -> APPS_SCRIPT_URL) serves a PINNED deployment version, so a push
 * alone changes nothing the proxy can see. We therefore also run
 * `clasp deploy -i <deploymentId>` to re-point that SAME deployment at the new
 * code, keeping the /exec URL stable. A bare `clasp deploy` (no -i) would mint
 * a brand-new deployment + URL and silently break worker.js.
 *
 * The deployment id IS the token in the /exec URL, so we read it straight out
 * of worker.js — one source of truth, nothing extra to configure. Override with
 * the CLASP_DEPLOYMENT_ID env var if you ever need to target another deployment.
 *
 * Prereqs (one time): `npm install`, then `npm run gas:login`, then create
 * .clasp.json (see the Deployment section of CLAUDE.md).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function deploymentId() {
  const fromEnv = (process.env.CLASP_DEPLOYMENT_ID || '').trim();
  if (fromEnv) return fromEnv;
  const worker = readFileSync(join(root, 'worker.js'), 'utf8');
  const m = worker.match(/macros\/s\/([^/'"]+)\/exec/);
  if (!m) {
    throw new Error(
      'Could not find the Apps Script /exec URL in worker.js. ' +
      'Set CLASP_DEPLOYMENT_ID to your web-app deployment id instead.'
    );
  }
  return m[1];
}

// Run clasp by invoking its JS entry directly with the current node binary.
// This sidesteps Windows .cmd/shell quoting (the repo path has a space) and is
// resilient to where the bin lives across clasp versions.
function clasp(args) {
  let claspJs;
  try {
    const pkgPath = require.resolve('@google/clasp/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.clasp;
    claspJs = join(dirname(pkgPath), binRel);
  } catch {
    throw new Error('clasp is not installed. Run: npm install');
  }
  console.log(`\n> clasp ${args.join(' ')}`);
  execFileSync(process.execPath, [claspJs, ...args], { stdio: 'inherit', cwd: root });
}

try {
  const id = deploymentId();
  clasp(['push', '-f']);
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  clasp(['deploy', '-i', id, '-d', `auto deploy ${stamp}`]);
  console.log(`\n✓ Apps Script deployed (deployment ${id.slice(0, 12)}…). /exec URL unchanged.\n`);
} catch (err) {
  console.error(`\n✗ ${err.message || err}`);
  process.exit(typeof err.status === 'number' ? err.status : 1);
}
