#!/usr/bin/env node
// verify-crlf.mjs
//
// Cross-platform port (P2, T0) -- CRLF hygiene gate for executable Node scripts.
//
// A CRLF that sneaks into a .mjs is the same class of bug that already bit the
// .githooks bash pack ("/usr/bin/env bash\r" -> "bad interpreter"). For Node a
// CRLF does not break execution, but it breaks the LF assumption shared tooling +
// any future `#!/usr/bin/env node` shebang rely on, and it is a silent drift that
// only shows up on one OS. `.gitattributes` (`*.mjs text eol=lf`) is the enforcer;
// THIS is the backstop that PROVES, per-OS, that every .mjs Node will execute is LF.
//
// Dependency-free (Node stdlib only). Runs identically on Windows/macOS/Linux.
// FAILS HARD (exit 1) on any CRLF -- this is a hygiene defect, not a warning.
//
// Doctor-ready: with --json it emits the {check,status,message,details} shape the
// other forge-doctor verifiers use, so a later tranche can wire it into doctor.ps1
// with a one-liner (T0 must not touch any .ps1, so it is enforced via the CI matrix).
//
// Usage:
//   node verify-crlf.mjs [--root <dir>] [--json]
//     --root   repo/scan root (default: env VIBE_ROOT, else cwd). Scans <root>/scripts
//              and <root>/.claude for *.mjs.
//     --json   machine-readable output.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import process from 'node:process';

const MODE = 'fail'; // CRLF in an executable script is a defect -> hard fail, not warn.

const argv = process.argv.slice(2);
function argValue(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
const asJson = argv.includes('--json');
const root = argValue('--root') || process.env.VIBE_ROOT || process.cwd();

// Directories that hold executable Node scripts. Generated mirrors (plugin-dist),
// dependencies, and build output are intentionally NOT scanned -- the source is what
// matters; plugin-dist is a byte-copy of already-checked source.
const SCAN_DIRS = ['scripts', '.claude'];
const PRUNE = new Set([
  'node_modules', '.git', 'worktrees', 'projects', 'plugin-dist',
  'dist', '.open-next', '.next', 'scratch', '.gemini',
]);

function walkMjs(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (PRUNE.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) out.push(...walkMjs(full));
    else if (st.isFile() && name.toLowerCase().endsWith('.mjs')) out.push(full);
  }
  return out;
}

function hasCRLF(buf) {
  // a CR (0x0D) immediately followed by LF (0x0A) anywhere in the file
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return true;
  }
  return false;
}

const files = [];
for (const d of SCAN_DIRS) {
  const abs = join(root, d);
  if (existsSync(abs)) files.push(...walkMjs(abs));
}

const offenders = [];
for (const f of files) {
  let buf;
  try { buf = readFileSync(f); } catch { continue; }
  if (hasCRLF(buf)) offenders.push(relative(root, f).split(sep).join('/'));
}

const findings = offenders.length;
const status = findings > 0 ? (MODE === 'fail' ? 'fail' : 'warn') : 'pass';
const message = `${files.length} executable .mjs scanned under ${SCAN_DIRS.join(' + ')}; ${findings} with CRLF`;

const result = {
  check: 'crlf-hygiene',
  status,
  mode: MODE,
  message,
  scanned: files.length,
  findings,
  details: offenders.slice(0, 20).map((p) => `${p}: contains CRLF (must be LF -- see .gitattributes "*.mjs text eol=lf")`),
};

if (asJson) {
  process.stdout.write(JSON.stringify(result) + '\n');
} else {
  console.log(`[${status.toUpperCase()}] crlf-hygiene (${MODE} mode): ${message}`);
  for (const d of result.details) console.log('    ' + d);
}

process.exit(status === 'fail' ? 1 : 0);
