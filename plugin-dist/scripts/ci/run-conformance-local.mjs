#!/usr/bin/env node
// Local replacement for the per-PR hosted Windows conformance job (A0, 2026-11-09).
// Runs every `run:` step of the `conformance` job in .github/workflows/cross-platform.yml on this
// machine, one at a time, honoring each step's `shell:` (bash / pwsh / powershell), its `env:` and
// `runner.os` conditions. Event-only steps (push / pull_request claim checks) are skipped and listed.
// VIBE_ROOT is removed from the child environment.
//
// Usage: node scripts/ci/run-conformance-local.mjs [--json <out.json>] [--only <substring>]
// Exit code: 0 only for a full unfiltered run on Windows where every executed step passed
// (summary ends 'WINDOWS PROOF'); 1 when a step failed; 2 when all passed but the run is not a
// Windows proof (--only filter or non-Windows OS). Record the summary line with the commit SHA
// in the ship log before requesting merge of a scripts/plugin-dist change.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const outJson = flag('--json');
const only = flag('--only');

export function parseConformanceSteps(workflowText) {
  const wf = workflowText.replace(/\r\n/g, '\n');
  const job = wf.split('\n  conformance:\n')[1]?.split('\n  conformance-gate:\n')[0];
  if (!job) throw new Error('conformance job not found in cross-platform.yml');
  const lines = job.split('\n');
  const steps = [];
  let cur = null;
  let node = null; // Node major pinned by the most recent actions/setup-node step
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = l.match(/^      - name: (.*)$/))) { cur = { name: m[1], if: null, shell: 'bash', run: null, env: {}, node }; steps.push(cur); continue; }
    if (!cur) continue;
    if ((m = l.match(/^          node-version: '?(\d+)/))) { node = m[1]; cur.setsNode = node; }
    else if ((m = l.match(/^        if: (.*)$/))) cur.if = m[1];
    else if ((m = l.match(/^        shell: (\S+)/))) cur.shell = m[1];
    else if (/^        run: [|>]-?\s*$/.test(l)) {
      const body = [];
      while (i + 1 < lines.length && (lines[i + 1].startsWith('          ') || lines[i + 1].trim() === '')) {
        i++; body.push(lines[i].replace(/^          /, ''));
      }
      cur.run = body.join('\n').trimEnd();
    } else if ((m = l.match(/^        run: (.+)$/))) cur.run = m[1];
    else if (l === '        env:') {
      while (i + 1 < lines.length && /^          \w+: /.test(lines[i + 1])) {
        i++; const [, k, v] = lines[i].match(/^          (\w+): (.*)$/);
        cur.env[k] = v.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
      }
    }
  }
  return steps;
}

// Returns a skip reason, or null when the step applies to a local run on this OS.
export function skipReason(step, os = process.platform) {
  if (!step.run) return 'no run: (action step)';
  const cond = step.if ?? '';
  if (/github\.event_name/.test(cond)) return `event-only: ${cond}`;
  const runnerOs = os === 'win32' ? 'Windows' : os === 'darwin' ? 'macOS' : 'Linux';
  let m;
  if ((m = cond.match(/runner\.os == '(\w+)'/)) && m[1] !== runnerOs) return `other OS: ${cond}`;
  if ((m = cond.match(/runner\.os != '(\w+)'/)) && m[1] === runnerOs) return `other OS: ${cond}`;
  if (cond && !/runner\.os/.test(cond)) return `unsupported condition: ${cond}`;
  return null;
}

function command(step) {
  if (step.shell === 'pwsh') return ['pwsh', ['-NoProfile', '-NonInteractive', '-Command', step.run]];
  if (step.shell === 'powershell') return ['powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', step.run]];
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  return [bash, ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run]];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const steps = parseConformanceSteps(readFileSync(join(repo, '.github/workflows/cross-platform.yml'), 'utf8'));
  const env = { ...process.env, CI: 'true' };
  delete env.VIBE_ROOT;
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const results = [];
  for (const step of steps) {
    if (only && !step.name.includes(only)) continue;
    const reason = skipReason(step);
    if (reason) { results.push({ name: step.name, skipped: reason }); console.log(`SKIP        ${step.name} (${reason})`); continue; }
    const [exe, argv] = command(step);
    const t0 = Date.now();
    const r = spawnSync(exe, argv, { cwd: repo, env: { ...env, ...step.env }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const sec = Math.round((Date.now() - t0) / 1000);
    const status = r.error ? -1 : r.status;
    const tail = (((r.stdout || '') + (r.stderr || '')) || String(r.error || '')).trim().split('\n').slice(-6).join(' | ').slice(0, 600);
    results.push({ name: step.name, shell: step.shell, status, sec, tail, workflowNode: step.node });
    console.log(`${status === 0 ? 'PASS' : 'FAIL'} ${String(sec).padStart(5)}s ${step.name}${status === 0 ? '' : `\n            ${tail}`}`);
    if (outJson) writeFileSync(outJson, JSON.stringify({ sha, platform: process.platform, node: process.version, results }, null, 1));
  }
  const ran = results.filter((r) => 'status' in r);
  const passed = ran.filter((r) => r.status === 0).length;
  const allPassed = passed === ran.length && ran.length > 0;
  // Only a full, unfiltered run on Windows replaces the hosted Windows job. Anything else is
  // labeled and exits non-zero so it can never be recorded as the Windows proof.
  const proofGaps = [];
  if (only) proofGaps.push(`filtered with --only "${only}" (${steps.length - results.length} steps not run)`);
  if (process.platform !== 'win32') proofGaps.push(`platform ${process.platform}, Windows-only steps skipped`);
  // The workflow pins Node per step via actions/setup-node; a local run uses the installed Node.
  // Mismatches are disclosed in the summary, never hidden; exact pinned-version coverage comes from
  // the per-release-candidate workflow_dispatch run on hosted runners.
  const localMajor = process.versions.node.split('.')[0];
  const nodeMismatch = {};
  for (const r of ran) if (r.workflowNode && r.workflowNode !== localMajor) nodeMismatch[r.workflowNode] = (nodeMismatch[r.workflowNode] ?? 0) + 1;
  const nodeNote = Object.keys(nodeMismatch).length
    ? ` [node: ran on v${localMajor}; workflow pins ${Object.entries(nodeMismatch).map(([v, n]) => `v${v} for ${n} steps`).join(', ')}; pinned-version coverage = per-RC hosted dispatch]`
    : ` [node: v${localMajor} matches every workflow pin]`;
  const label = proofGaps.length ? `NOT A WINDOWS PROOF (${proofGaps.join('; ')})` : 'WINDOWS PROOF';
  console.log(`\nLOCAL CONFORMANCE ${sha.slice(0, 8)} ${process.platform} node ${process.version}: ${passed}/${ran.length} steps pass, ${results.length - ran.length} skipped, ${ran.reduce((a, r) => a + r.sec, 0)}s -- ${allPassed ? label : 'FAILED'}${nodeNote}`);
  if (outJson) writeFileSync(outJson, JSON.stringify({ sha, platform: process.platform, node: process.version, windowsProof: allPassed && !proofGaps.length, proofGaps, nodeMismatch, results }, null, 1));
  process.exit(!allPassed ? 1 : proofGaps.length ? 2 : 0);
}
