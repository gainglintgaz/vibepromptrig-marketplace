#!/usr/bin/env node
// run.mjs -- cross-OS conformance harness (cross-platform port P2, T0).
//
// PURPOSE: replay a captured hook-stdin fixture into a gate and assert that the
// gate's {exit code, stdout/stderr routing, side-effects} match the recorded
// Windows-reference expectation -- BYTE-IDENTICALLY on windows/ubuntu/macos.
// Windows is the oracle (the .ps1 gates are the current truth); every later
// tranche's Node twin must reproduce the same record on all three OS.
//
// T0 STATE: the gate registry is intentionally EMPTY -- no gate is ported yet, so
// nothing is replayed. The harness instead PROVES it loads + runs + validates the
// whole fixture corpus (parse, decode, schema) identically on all three OS cells.
// T1 fills GATES and the replay path lights up with zero harness changes.
//
// Dependency-free (Node stdlib only). Node >= 18 required.
//
// Usage:  node scripts/conformance/run.mjs [--json]
// Exit:   0 = harness OK (corpus valid, no replay failures); 1 = a failure.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const asJson = process.argv.includes('--json');
const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures');

// ---------------------------------------------------------------------------
// 0. Runtime floor: Node >= 18 (cross-platform-port.md assumption 5).
// ---------------------------------------------------------------------------
const nodeMajor = Number(String(process.versions.node).split('.')[0]);
if (!Number.isFinite(nodeMajor) || nodeMajor < 18) {
  emit({ verdict: 'FAIL', reason: `Node >= 18 required; got ${process.versions.node}` });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Gate registry. EMPTY in T0 (proof harness only). T1 adds entries like:
//      'pre-bash-destructive-sql-guard': {
//        invoke: (root) => process.platform === 'win32'
//          ? { cmd: 'powershell', args: ['-NonInteractive','-ExecutionPolicy','Bypass','-File', join(root,'scripts/hooks/pre-bash-destructive-sql-guard.ps1')] }
//          : { cmd: 'node', args: [join(root,'scripts/hooks/pre-bash-destructive-sql-guard.mjs')] },
//      }
//    The Node twin (.mjs) is what runs on macOS/Linux; the .ps1 stays the Windows
//    oracle until its twin is CI-green on all three OS (assumption 6).
// ---------------------------------------------------------------------------
// A gate runs its Node TWIN (.mjs) on EVERY platform -- the parity proof is "twin matches
// the Windows-captured `expect` on windows + ubuntu + macos". The .ps1 stays the live hook
// until hooks.json flips; its behavior is frozen in the `expect` records captured in T0.
function nodeGate(file) {
  return { invoke: (root) => ({ cmd: process.execPath, args: [join(root, 'scripts', 'hooks', file)] }) };
}
const GATES = {
  // T1a -- the 4 destructive guards (ship together, never one-by-one).
  'pre-bash-destructive-sql-guard': nodeGate('pre-bash-destructive-sql-guard.mjs'),
  'pre-bash-destructive-git-guard': nodeGate('pre-bash-destructive-git-guard.mjs'),
  'pre-migration-destructive-guard': nodeGate('pre-migration-destructive-guard.mjs'),
  'pre-write-mcp-advisor': nodeGate('pre-write-mcp-advisor.mjs'),
  // session-guard + signal-classifier wire in the next T1 pass (stateful; behavioral test port).
};

// ---------------------------------------------------------------------------
// 2. Load + validate the fixture corpus.
// ---------------------------------------------------------------------------
function loadFixtures() {
  if (!existsSync(fixturesDir)) return { fixtures: [], invalid: [['<dir>', 'fixtures/ directory missing']] };
  const files = readdirSync(fixturesDir).filter((f) => f.toLowerCase().endsWith('.json')).sort();
  const fixtures = [];
  const invalid = [];
  for (const file of files) {
    const full = join(fixturesDir, file);
    let raw, fx;
    try { raw = readFileSync(full, 'utf8'); } catch (e) { invalid.push([file, `unreadable: ${e.message}`]); continue; }
    try { fx = JSON.parse(raw); } catch (e) { invalid.push([file, `not valid JSON: ${e.message}`]); continue; }

    const problems = validateFixture(fx);
    // decode the stdin bytes (also a validation: a bad base64 / missing payload fails here)
    let bytes = null;
    if (problems.length === 0) {
      try { bytes = fixtureStdinBytes(fx); } catch (e) { problems.push(`stdin decode failed: ${e.message}`); }
    }
    if (problems.length) { invalid.push([file, problems.join('; ')]); continue; }
    fixtures.push({ file, fx, bytes });
  }
  return { fixtures, invalid };
}

function validateFixture(fx) {
  const p = [];
  if (typeof fx !== 'object' || fx === null) return ['fixture is not an object'];
  if (typeof fx.name !== 'string' || !fx.name) p.push('missing "name"');
  if (typeof fx.hook_event !== 'string' || !fx.hook_event) p.push('missing "hook_event"');
  if (!('gate' in fx)) p.push('missing "gate" (string or null)');
  const hasObj = fx.stdin !== undefined && fx.stdin !== null;
  const hasB64 = Object.prototype.hasOwnProperty.call(fx, 'stdin_b64') && fx.stdin_b64 !== null;
  if (!hasObj && !hasB64) p.push('must provide "stdin" (object) or "stdin_b64" (base64 string, may be "")');
  if (typeof fx.expect !== 'object' || fx.expect === null) p.push('missing "expect" record');
  else if (typeof fx.expect.exit_code !== 'number') p.push('"expect.exit_code" must be a number');
  return p;
}

// stdin_b64 (exact bytes -- BOM/empty/malformed cases) wins over the readable object form.
function fixtureStdinBytes(fx) {
  const hasB64 = Object.prototype.hasOwnProperty.call(fx, 'stdin_b64') && fx.stdin_b64 !== null;
  if (hasB64) return Buffer.from(String(fx.stdin_b64), 'base64');
  return Buffer.from(JSON.stringify(fx.stdin), 'utf8');
}

// ---------------------------------------------------------------------------
// 3. Replay a gate (used only when GATES is populated, i.e. T1+).
// ---------------------------------------------------------------------------
function replay(gate, bytes, extraEnv) {
  const repoRoot = join(here, '..', '..');
  const spec = GATES[gate].invoke(repoRoot);
  const env = extraEnv && typeof extraEnv === 'object' ? { ...process.env, ...extraEnv } : process.env;
  const res = spawnSync(spec.cmd, spec.args, { input: bytes, encoding: 'buffer', windowsHide: true, env });
  return {
    exit_code: res.status === null ? -1 : res.status,
    stdout: (res.stdout || Buffer.alloc(0)).toString('utf8'),
    stderr: (res.stderr || Buffer.alloc(0)).toString('utf8'),
  };
}

function assertExpectation(expect, actual) {
  const fails = [];
  if (typeof expect.exit_code === 'number' && actual.exit_code !== expect.exit_code) {
    fails.push(`exit_code ${actual.exit_code} != expected ${expect.exit_code}`);
  }
  if (typeof expect.stderr_contains === 'string' && expect.stderr_contains &&
      !actual.stderr.includes(expect.stderr_contains)) {
    fails.push(`stderr missing "${expect.stderr_contains}"`);
  }
  if (typeof expect.stdout === 'string' && expect.stdout && !actual.stdout.includes(expect.stdout)) {
    fails.push(`stdout missing "${expect.stdout}"`);
  }
  return fails;
}

// ---------------------------------------------------------------------------
// 4. Run.
// ---------------------------------------------------------------------------
const { fixtures, invalid } = loadFixtures();
let replayed = 0, skipped = 0, replayFailures = [];

for (const { file, fx, bytes } of fixtures) {
  const gate = fx.gate;
  if (gate && Object.prototype.hasOwnProperty.call(GATES, gate)) {
    const actual = replay(gate, bytes, fx.env);
    const fails = assertExpectation(fx.expect, actual);
    if (fails.length) replayFailures.push([file, fails.join('; ')]);
    replayed++;
  } else {
    skipped++; // no gate wired yet (T0) -- corpus is still validated above
  }
}

const corpusOk = invalid.length === 0;
const replayOk = replayFailures.length === 0;
const verdict = corpusOk && replayOk
  ? (replayed === 0 ? 'HARNESS-OK' : 'PASS')
  : 'FAIL';

const summary = {
  verdict,
  os: process.platform,
  node: process.versions.node,
  fixtures_loaded: fixtures.length,
  fixtures_invalid: invalid.length,
  gates_wired: Object.keys(GATES).length,
  replayed,
  skipped_no_gate: skipped,
  replay_failures: replayFailures.length,
};

if (asJson) {
  process.stdout.write(JSON.stringify({ ...summary, invalid, replayFailures }) + '\n');
} else {
  console.log(`conformance harness (node ${summary.node}, ${summary.os}):`);
  console.log(`  fixtures: ${fixtures.length} loaded + valid, ${invalid.length} invalid`);
  console.log(`  gates wired: ${summary.gates_wired}`);
  console.log(`  replayed: ${replayed}   skipped (no gate wired): ${skipped}   replay failures: ${replayFailures.length}`);
  for (const [f, why] of invalid) console.log(`    [INVALID] ${f}: ${why}`);
  for (const [f, why] of replayFailures) console.log(`    [REPLAY-FAIL] ${f}: ${why}`);
  console.log(`  VERDICT: ${verdict}`);
}

function emit(obj) {
  if (asJson) process.stdout.write(JSON.stringify(obj) + '\n');
  else console.log(`conformance harness: ${obj.verdict}${obj.reason ? ' -- ' + obj.reason : ''}`);
}

process.exit(verdict === 'FAIL' ? 1 : 0);
