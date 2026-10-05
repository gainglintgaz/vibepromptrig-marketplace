#!/usr/bin/env node
// doctor.mjs -- Node twin of doctor.ps1 (cross-platform port P2, T1c-3c-B). forge doctor:
// factory health check, plain-English output. Delegates every section to a ported .mjs twin so
// the same 15-section verdict is produced on Windows / macOS / Linux. Dependency-free, Node >= 18.
//
// Sections (15 results on a healthy factory):
//   1. verify-factory.mjs --check all  -> 7 truth-drift checks
//   2. profile resolver smoke          3. plan-translations valid   4. profile presets count
//   4.5 enforcement coverage   4.6 traceability+composable   4.7 foundational requirements
//   5. forge CLI dispatch smoke (node forge.mjs profile show --terse)
//   6. mirror sync dry-run (sync-verify.mjs)

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { resolveRoutinePlan, CRON_MARKER } from '../setup-scheduler.mjs'; // shared routine->task resolver
import { buildInstallPlan } from './context-install.mjs';
import { isPackagedRuntime } from './context-contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
function argVal(flag) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; }
const FactoryRoot = argVal('--factory-root') || argVal('-FactoryRoot') || process.env.VIBE_ROOT || dirname(dirname(here));
const asJson = process.argv.includes('--json');
const failFast = process.argv.includes('--fail-fast') || process.argv.includes('-FailFast');
// Packaged runtime only with the build's distribution marker (never inferred from a missing
// .claude/rules tree, which the source factory no longer has either).
const runtimeMode = isPackagedRuntime(FactoryRoot);
const sourceOnlyReason = 'Compact runtime omits the legacy authoring corpus; run this source-only check in the full factory.';

const results = [];
let failureCount = 0;
const commas = (n) => String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
function addSection(name, status, message, details = []) {
  results.push({ section: name, status, message, details });
  if (status === 'fail') failureCount++;
  if (!asJson) {
    const glyph = { pass: 'OK   ', fail: 'FAIL ', warn: 'WARN ', skip: 'SKIP ' }[status] || '?    ';
    console.log(`  [${glyph}] ${name.padEnd(32)} ${message}`);
    for (const d of details) console.log(`                                              ${d}`);
  }
}
// Run a node script and parse its single-object --json stdout. Returns parsed object or null.
function runJsonNode(scriptPath, args) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', env: { ...process.env, VIBE_ROOT: FactoryRoot } });
  try { return JSON.parse(r.stdout); } catch { return null; }
}

if (!asJson) {
  console.log('');
  console.log('VibePromptRig factory doctor (Node)');
  console.log(`  Factory root: ${FactoryRoot}`);
  console.log('');
}

// --- Section 1: 7 truth-drift checks (delegate to verify-factory.mjs) ---
const verifyScript = join(FactoryRoot, 'scripts', 'verify-factory.mjs');
if (runtimeMode) {
  // Planning is read-only and validates all shipped support assets, required cards, and
  // the packet budget. Native entrypoints omitted by the curated package are not required.
  try {
    const plan = buildInstallPlan({ factoryRoot: FactoryRoot, projectRoot: FactoryRoot });
    const nativePaths = new Set(['AGENTS.md', 'GEMINI.md', '.windsurfrules', '.claude/CLAUDE.md', '.cursor/rules/vf-context-core.mdc', '.agents/rules/vf-context-core.md']);
    const stale = plan.files.filter((file) => nativePaths.has(file.relPath) && existsSync(join(FactoryRoot, file.relPath))
      && readFileSync(join(FactoryRoot, file.relPath), 'utf8').replace(/\r/g, '') !== file.content.replace(/\r/g, '')).map((file) => file.relPath);
    addSection('compact runtime health', stale.length ? 'fail' : 'pass', stale.length ? 'Present native entries differ from canonical rendering' : `Runtime assets and present native entries validate; packet ${plan.packet_bytes}/${plan.packet_budget_bytes} bytes`, stale);
  } catch (error) { addSection('compact runtime health', 'fail', 'Runtime validation failed', [error.message]); }
  for (const check of ['rules-list', 'mirror-freshness', 'rule-reference-integrity']) addSection(`verify ${check}`, 'skip', sourceOnlyReason);
  for (const check of ['agents-list', 'skills-list', 'scripts-list', 'version-citations']) {
    const report = existsSync(verifyScript) ? runJsonNode(verifyScript, ['--factory-root', FactoryRoot, '--check', check, '--json']) : null;
    const item = report?.results?.find((result) => result.check === check);
    if (item) addSection(`verify ${check}`, item.status, item.message, (item.details || []).slice(0, 3));
    else addSection(`verify ${check}`, 'fail', 'Runtime verifier produced no parseable result');
  }
} else if (existsSync(verifyScript)) {
  const vf = runJsonNode(verifyScript, ['--factory-root', FactoryRoot, '--json']);
  if (vf && Array.isArray(vf.results)) {
    for (const r of vf.results) {
      addSection(`verify ${r.check}`, r.status, r.message, (r.details || []).slice(0, 3));
      if (failFast && r.status === 'fail') break;
    }
  } else addSection('verify-factory.mjs', 'fail', 'verify-factory produced no parseable output');
} else addSection('verify-factory.mjs', 'fail', `Missing: ${verifyScript}`);

// --- Section 2: profile resolver smoke ---
const resolverScript = join(FactoryRoot, 'scripts', 'forge', 'profile-resolver.mjs');
if (existsSync(resolverScript)) {
  const p = runJsonNode(resolverScript, ['--factory-root', FactoryRoot, '--json']);
  if (p && p.effective && p.effective.profile) {
    addSection('profile resolver', 'pass', `resolves to '${p.effective.profile}' (session budget ${commas(p.effective.session_budget_tokens)} tokens)`);
  } else addSection('profile resolver', 'fail', "JSON output missing 'effective.profile'");
} else addSection('profile resolver', 'fail', `Missing: ${resolverScript}`);

// --- Section 3: plan-translations JSON validity ---
// --- Session 3: compact renderer and budget validator (native loading remains unverified). ---
const contextScript = join(FactoryRoot, 'scripts', 'forge', 'context.mjs');
if (existsSync(contextScript)) {
  const r = spawnSync(process.execPath, [contextScript, 'resolve', '--intent', 'unknown', '--json'], { encoding: 'utf8', env: { ...process.env, VIBE_ROOT: FactoryRoot } });
  try {
    const packet = JSON.parse(r.stdout);
    if (r.status === 0 && packet.packet && packet.packet.bytes <= packet.packet.budget_bytes) addSection('compact context packet', 'pass', `${packet.packet.bytes}/${packet.packet.budget_bytes} bytes; native loading unverified`);
    else addSection('compact context packet', 'fail', (r.stderr || 'packet exceeded budget').trim());
  } catch { addSection('compact context packet', 'fail', 'context renderer produced no parseable budget result'); }
} else addSection('compact context packet', 'fail', `Missing: ${contextScript}`);

const translationsPath = join(FactoryRoot, '.forge', 'plan-translations.json');
if (existsSync(translationsPath)) {
  try {
    const t = JSON.parse(readFileSync(translationsPath, 'utf8'));
    const planCount = t.plans ? Object.keys(t.plans).length : 0;
    addSection('plan-translations', 'pass', `${planCount} AI plans documented`);
  } catch (e) { addSection('plan-translations', 'fail', `Invalid JSON: ${e.message}`); }
} else addSection('plan-translations', 'warn', 'Missing (optional but recommended for forge profile show plain-English)');

// --- Section 4: profile preset count ---
const presetsDir = join(FactoryRoot, '.forge', 'profiles');
if (existsSync(presetsDir)) {
  const presetCount = readdirSync(presetsDir).filter((f) => f.toLowerCase().endsWith('.json')).length;
  if (presetCount >= 5) addSection('profile presets', 'pass', `${presetCount} presets available`);
  else addSection('profile presets', 'warn', `Only ${presetCount} presets (expected 5: indie-free, solo-pro, senior-dev, agency, enterprise)`);
} else addSection('profile presets', 'fail', '.forge/profiles/ directory missing');

// --- Section 4.5 / 4.6 / 4.7: doctor's three .mjs verifiers ---
const verifierSections = [
  { name: 'enforcement coverage', file: 'verify-enforcement.mjs', missingMsg: 'enforcement-first.md not active yet' },
  { name: 'traceability + composable-outputs', file: 'verify-traceability.mjs', missingMsg: 'composable-outputs.md not active yet' },
  { name: 'foundational requirements', file: 'verify-foundational-requirements.mjs', missingMsg: 'architect-first.md SS0.5 not active yet' },
];
for (const v of verifierSections) {
  if (runtimeMode && ['enforcement coverage', 'traceability + composable-outputs'].includes(v.name)) {
    addSection(v.name, 'skip', sourceOnlyReason);
    continue;
  }
  const sp = join(FactoryRoot, 'scripts', 'verifiers', v.file);
  if (!existsSync(sp)) { addSection(v.name, 'warn', `Missing: ${sp} (${v.missingMsg})`); continue; }
  const j = runJsonNode(sp, ['--root', FactoryRoot, '--json']);
  if (j && j.status) addSection(v.name, j.status, j.message, (j.details || []).slice(0, 3));
  else addSection(v.name, 'fail', `verifier error: no parseable output from ${v.file}`);
}

// --- Section 5: forge CLI dispatch smoke (node forge.mjs profile show --terse) ---
const forgeScript = join(FactoryRoot, 'scripts', 'forge.mjs');
if (existsSync(forgeScript)) {
  const r = spawnSync(process.execPath, [forgeScript, 'profile', 'show', '--terse'], { encoding: 'utf8', env: { ...process.env, VIBE_ROOT: FactoryRoot } });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (/forge:\s+\w+/.test(out)) addSection('forge CLI dispatch', 'pass', 'smoke test passes (forge profile show --terse)');
  else addSection('forge CLI dispatch', 'warn', `Unexpected smoke test output: ${out.slice(0, 60)}`);
} else addSection('forge CLI dispatch', 'fail', `Missing: ${forgeScript}`);

// --- Section 6: mirror sync dry-run (sync-verify.mjs verdict helper) ---
const syncVerify = join(FactoryRoot, 'scripts', 'forge', 'sync-verify.mjs');
if (runtimeMode) addSection('mirror sync dry-run', 'skip', sourceOnlyReason);
else if (existsSync(syncVerify)) {
  const r = spawnSync(process.execPath, [syncVerify, '--factory-root', FactoryRoot, '--quiet'], { encoding: 'utf8' });
  if (r.status === 0) addSection('mirror sync dry-run', 'pass', 'ready to regenerate mirrors');
  else if (r.status === 2) addSection('mirror sync dry-run', 'fail', 'Verification failures (run scripts/forge/sync-verify.mjs for detail)');
  else addSection('mirror sync dry-run', 'warn', `Unexpected exit code: ${r.status}`);
} else addSection('mirror sync dry-run', 'warn', 'Missing scripts/forge/sync-verify.mjs');

// --- Section 7: scheduler routines (routines.json -> OS tasks; last-run freshness) ---
// Reuses setup-scheduler.mjs's resolver so the "expected task" set can never drift from what
// setup-scheduler registers. WARNs (never fails) on: an OS-schedulable routine with no matching
// task; a task whose last run is older than 2x its cadence; and every enabled AGENT routine that
// has no local runner (belongs on cloud Routines -- see docs/architecture/agent-routines-cloud-routines.md).
{
  const plan = resolveRoutinePlan(FactoryRoot);
  if (!plan.ok) {
    addSection('scheduler routines', 'skip', '.forge/routines.json missing or invalid -- cannot check schedulers');
  } else {
    const details = [];
    let worst = 'pass';
    const bump = (s) => { if (s === 'warn' && worst !== 'fail') worst = 'warn'; };
    for (const e of plan.schedulable) {
      if (!taskIsRegistered(e.taskName)) { details.push(`${e.name}: no OS task '${e.taskName}' -- run node scripts/setup-scheduler.mjs`); bump('warn'); continue; }
      const lastRun = lastRunOf(FactoryRoot, e.name, e.taskName);
      if (lastRun && e.cadenceHours) {
        const ageH = (Date.now() - lastRun.getTime()) / 3.6e6;
        if (ageH > 2 * e.cadenceHours) { details.push(`${e.name}: last run ${lastRun.toISOString().slice(0, 16)}Z -- older than 2x cadence (${e.cadenceHours}h)`); bump('warn'); }
      } else {
        details.push(`${e.name}: registered; no run recorded yet (scheduled_run heartbeat pending)`);
      }
    }
    for (const a of plan.agentsNoRunner) {
      details.push(`${a.name}: enabled agent routine, no local runner -- belongs on cloud Routines (probe: docs/architecture/agent-routines-cloud-routines.md)`);
      bump('warn');
    }
    for (const ev of plan.eventRoutines) details.push(`${ev.name}: event routine (stop-hook) -- not OS-scheduled by design`);
    const msg = `${plan.schedulable.length} schedulable, ${plan.agentsNoRunner.length} agent(no-runner), ${plan.eventRoutines.length} event`;
    addSection('scheduler routines', worst, msg, details.slice(0, 10));
  }
}

// Is a scheduled task registered with the OS? schtasks on Windows, crontab marker on macOS/Linux.
function taskIsRegistered(taskName) {
  if (process.platform === 'win32') {
    return spawnSync('schtasks', ['/query', '/tn', taskName], { encoding: 'utf8' }).status === 0;
  }
  const r = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  return r.status === 0 && (r.stdout || '').includes(`${CRON_MARKER}:${taskName}`);
}

// Most recent run of a routine, CROSS-PLATFORM: the newest {event:'scheduled_run', job:<name>} row in
// factory_metrics.jsonl -- the heartbeat every scheduled job writes (T3 spec AC#4). Falls back to the
// Windows schtasks "Last Run Time" when no heartbeat row exists yet. Returns a Date or null.
function lastRunOf(factoryRoot, routineName, taskName) {
  const fm = join(factoryRoot, 'factory_metrics.jsonl');
  let latest = null;
  if (existsSync(fm)) {
    for (const line of readFileSync(fm, 'utf8').split('\n')) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o && o.event === 'scheduled_run' && o.job === routineName && o.ts) {
        const d = new Date(o.ts);
        if (!isNaN(d.getTime()) && (!latest || d > latest)) latest = d;
      }
    }
  }
  if (latest) return latest;
  if (process.platform === 'win32') {
    const r = spawnSync('schtasks', ['/query', '/tn', taskName, '/v', '/fo', 'LIST'], { encoding: 'utf8' });
    if (r.status === 0) {
      const m = /Last Run Time:\s*(.+)/i.exec(r.stdout || '');
      if (m) { const raw = m[1].trim(); if (!/N\/A|11\/30\/1999/i.test(raw)) { const d = new Date(raw); if (!isNaN(d.getTime())) return d; } }
    }
  }
  return null;
}

// --- Output ---
const passes = results.filter((r) => r.status === 'pass').length;
const warnings = results.filter((r) => r.status === 'warn').length;
const skips = results.filter((r) => r.status === 'skip').length;
if (asJson) {
  process.stdout.write(JSON.stringify({ factory_root: FactoryRoot, mode: runtimeMode ? 'compact-runtime' : 'source-factory', timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), passes, warnings, failures: failureCount, skips, results }, null, 2) + '\n');
} else {
  console.log('');
  console.log(`  Doctor verdict: ${passes} pass / ${warnings} warn / ${skips} skip / ${failureCount} fail`);
  console.log('');
  if (failureCount > 0) { console.log("  Run 'forge doctor --json' for machine-readable output, or review individual failures above."); console.log(''); }
}
// Allow piped JSON diagnostics to flush before exiting (notably on macOS).
process.exitCode = failureCount;
