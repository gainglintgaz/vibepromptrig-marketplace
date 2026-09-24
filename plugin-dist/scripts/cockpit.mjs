#!/usr/bin/env node
// cockpit.mjs -- regenerate PROJECT_COCKPIT.md: a single, plain-English view of where
// a project stands (goals, milestones + % complete, what's been spent, blockers).
//
// Node twin of cockpit.ps1 (cross-platform port P2). Dependency-free (Node stdlib), Node >= 18,
// ESM, LF, UTF-8 no BOM. Read-only on real state except writing PROJECT_COCKPIT.md.
//
// HONESTY CONTRACT (this is the whole point -- never fake a number):
//   - MEASURED  = pulled from git log / factory_metrics.jsonl (hard fact, cited).
//   - ESTIMATED = derived (e.g. session wall-clock from message timestamps). Labeled.
//   - DECLARED  = human-set in .forge/cockpit.json (goals, milestone %). Labeled.
//   - UNKNOWN   = not captured yet. Shown as "not tracked" -- NEVER guessed.
//
// dashboard.mjs imports gatherCockpit() from here (sibling, via import.meta.url) so the
// RENDER layer never duplicates this aggregation -- it is the single source of status truth.

import { existsSync, readFileSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { summaryLine } from './lib/pending-summary.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// ---- FactoryRoot resolution: --factory-root | VIBE_ROOT | dirname(scriptDir) ----
// This script lives in scripts/, so the factory root is its parent dir.
function resolveFactoryRoot(argv) {
  const i = argv.findIndex((a) => a === '--factory-root' || a === '-FactoryRoot');
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  if (process.env.VIBE_ROOT) return process.env.VIBE_ROOT;
  return dirname(here);
}

function hasFlag(argv, ...names) {
  return argv.some((a) => names.includes(a));
}

// Guarded numeric coercion: returns a finite number or null (never throws, never NaN/Infinity).
// PowerShell's `-as [double]` returns $null on a bad value; this mirrors that exactly.
function asFiniteNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return null; // PS [double] would coerce, but a bool cost is not a cost
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return n;
}

// `-as [int]` analogue: floor toward zero, null on bad input.
function asInt(v) {
  const n = asFiniteNumber(v);
  if (n === null) return null;
  return Math.trunc(n);
}

// Robust UTC parse of an ISO-ish timestamp -> epoch ms, or null (mirrors the PS try/catch).
function parseUtcMs(ts) {
  if (ts === null || ts === undefined) return null;
  const ms = Date.parse(String(ts));
  return Number.isFinite(ms) ? ms : null;
}

// First day of the current month at 00:00:00 UTC, as epoch ms (mirrors the PS monthStartDt).
function monthStartUtcMs() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0);
}

// ---- git facts (spawnSync with exact args; same as cockpit.ps1) ----
function git(factoryRoot, args) {
  const r = spawnSync('git', args, { cwd: factoryRoot, encoding: 'utf8' });
  if (r.status !== 0 || r.error) return '';
  return (r.stdout || '').trim();
}

function gitLineCount(factoryRoot, extraArgs) {
  // git log --oneline <extraArgs>  |  count non-empty lines
  const out = git(factoryRoot, ['log', '--oneline', ...extraArgs]);
  if (!out) return 0;
  return out.split(/\r?\n/).filter((l) => l.length > 0).length;
}

// ---- forge doctor verdict (cross-OS) ----
// cockpit.ps1 runs scripts\forge.ps1 doctor and scrapes "Doctor verdict: ...".
// The Node twin prefers scripts/forge.mjs (every OS); falls back to scripts/forge.ps1 on Windows.
// forge is a FACTORY sibling: located relative to THIS script's dir, not FactoryRoot (the data root).
function getDoctorVerdict(factoryRoot) {
  const forgeMjs = join(here, 'forge.mjs');
  const forgePs1 = join(here, 'forge.ps1');
  const childEnv = { ...process.env, VIBE_ROOT: factoryRoot };
  let out = '';
  try {
    if (existsSync(forgeMjs)) {
      const r = spawnSync(process.execPath, [forgeMjs, 'doctor'], { cwd: factoryRoot, env: childEnv, encoding: 'utf8' });
      out = (r.stdout || '') + (r.stderr || '');
    } else if (existsSync(forgePs1)) {
      const pwsh = process.platform === 'win32' ? 'powershell' : 'pwsh';
      const r = spawnSync(pwsh, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', forgePs1, 'doctor'], { cwd: factoryRoot, env: childEnv, encoding: 'utf8' });
      out = (r.stdout || '') + (r.stderr || '');
    } else {
      return 'unknown';
    }
  } catch (e) {
    return `doctor run failed: ${e && e.message ? e.message : String(e)}`;
  }
  const m = out.match(/Doctor verdict:\s*(.+)/i);
  if (m) return m[1].trim();
  return 'unknown';
}

// ---- factory_metrics.jsonl: single streaming pass (O(1) memory, BOM-safe) ----
// Mirrors cockpit.ps1's StreamReader loop EXACTLY, including the guarded ai_call cost arithmetic:
//   * bad/string/missing cost uses asFiniteNumber (null, never a throw) -> one bad row never crashes;
//   * negative / NaN / Infinity costs are rejected (counted as anomalies), never summed;
//   * ai_measured requires >=1 event with a REAL finite non-negative cost -- a cost-less event renders
//     PARTIAL, never a fabricated "$0.00 MEASURED";
//   * month-to-date uses a robust UTC datetime parse, not a lexical string compare.
function readMetrics(factoryRoot) {
  const metricsPath = join(factoryRoot, 'factory_metrics.jsonl');
  const out = {
    probeCount: 0,
    gateCount: 0,
    overrideCount: 0,
    lastContextTokens: null,
    aiCalls: 0,
    aiCostCents: 0.0,
    aiTokens: 0,
    aiMeasured: false,
    aiPartial: false,
    aiAnomalies: 0,
  };
  if (!existsSync(metricsPath)) return out;

  const monthStart = monthStartUtcMs();
  let aiCostKnown = false;

  // Stream line-by-line over a fixed-size buffer; never loads the whole (unbounded) file into RAM.
  const fd = openSync(metricsPath, 'r');
  try {
    const CHUNK = 1 << 16; // 64 KiB
    const buf = Buffer.allocUnsafe(CHUNK);
    let carry = '';
    let firstChunk = true;
    let bytes;
    while ((bytes = readSync(fd, buf, 0, CHUNK, null)) > 0) {
      let text = buf.toString('utf8', 0, bytes);
      if (firstChunk) {
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip a UTF-8 BOM
        firstChunk = false;
      }
      carry += text;
      let nl;
      while ((nl = carry.indexOf('\n')) !== -1) {
        const line = carry.slice(0, nl).replace(/\r$/, '');
        carry = carry.slice(nl + 1);
        processLine(line);
      }
    }
    if (carry.length > 0) processLine(carry.replace(/\r$/, ''));
  } finally {
    closeSync(fd);
  }

  out.aiMeasured = out.aiCalls > 0 && aiCostKnown;
  out.aiPartial = out.aiCalls > 0 && !aiCostKnown; // events logged but no real cost captured
  out.aiCostCents = Math.round(out.aiCostCents * 100) / 100;
  return out;

  function processLine(ln) {
    if (ln.length === 0) return;

    // counters (regex, case-insensitive to match PS -match) -- same precedence as the PS:
    // probe is its own `if`; override is checked before gate (elseif) so an override line
    // increments override but NOT gate.
    if (/"event":"architect_probe"/i.test(ln)) out.probeCount++;
    if (/"event":"arch_gate_override"/i.test(ln)) out.overrideCount++;
    else if (/"event":"arch_gate"/i.test(ln)) out.gateCount++;

    const gt = ln.match(/"grand_tokens":(\d+)/i);
    if (gt) out.lastContextTokens = parseInt(gt[1], 10);

    if (!/"event":"ai_call"/i.test(ln)) return;

    let ev;
    try { ev = JSON.parse(ln); } catch { return; }
    if (!ev || ev.event !== 'ai_call') return;

    if (ev.ts !== undefined && ev.ts !== null) {
      const tsMs = parseUtcMs(ev.ts);
      if (tsMs !== null && tsMs < monthStart) return; // older than this month -> skip
    }

    out.aiCalls++;

    if (ev.cost_cents === null || ev.cost_cents === undefined) {
      // cost not present -> unknown (PARTIAL), NOT an anomaly, NOT a real $0
    } else {
      const cc = asFiniteNumber(ev.cost_cents); // null on a bad value (no throw)
      if (cc === null || cc < 0) {
        out.aiAnomalies++; // present but invalid (string / negative / NaN / Infinity) -> excluded
      } else {
        out.aiCostCents += cc;
        aiCostKnown = true;
      }
    }

    const ti = asInt(ev.tokens_in) ?? 0;
    const to = asInt(ev.tokens_out) ?? 0;
    out.aiTokens += ti + to;
  }
}

// ---- The single source of status truth (what dashboard.mjs imports) ----
// Returns the SAME object shape cockpit.ps1's -Json emits (measured / declared / generated_at_note).
export function gatherCockpit(opts = {}) {
  const factoryRoot = opts.factoryRoot || resolveFactoryRoot([]);

  // DECLARED layer
  const cockpitJsonPath = join(factoryRoot, '.forge', 'cockpit.json');
  let declared = null;
  if (existsSync(cockpitJsonPath)) {
    try { declared = JSON.parse(readFileSync(cockpitJsonPath, 'utf8')); } catch { declared = null; }
  }

  // MEASURED: git facts
  const totalCommits = gitLineCount(factoryRoot, ['HEAD']);
  const last7Commits = gitLineCount(factoryRoot, ['--since=7 days ago']);
  const lastCommitSha = git(factoryRoot, ['rev-parse', '--short', 'HEAD']);
  const lastCommitSubj = git(factoryRoot, ['log', '-1', '--format=%s']);
  const lastCommitDate = git(factoryRoot, ['log', '-1', '--format=%cI']);
  const branch = git(factoryRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);

  // MEASURED: factory_metrics facts
  const m = readMetrics(factoryRoot);

  // MEASURED: forge doctor health
  const doctorVerdict = getDoctorVerdict(factoryRoot);

  return {
    measured: {
      total_commits: totalCommits,
      last7_commits: last7Commits,
      head: lastCommitSha,
      head_subject: lastCommitSubj,
      head_date: lastCommitDate,
      branch: branch,
      architect_probes: m.probeCount,
      arch_gates: m.gateCount,
      gate_overrides: m.overrideCount,
      last_context_tokens: m.lastContextTokens,
      doctor: doctorVerdict,
      ai_calls_mtd: m.aiCalls,
      ai_cost_cents_mtd: m.aiCostCents,
      ai_tokens_mtd: m.aiTokens,
      ai_measured: m.aiMeasured,
      ai_partial: m.aiPartial,
      ai_anomalies: m.aiAnomalies,
    },
    declared: declared,
    generated_at_note: 'timestamp intentionally omitted -- pass via cron/caller to keep deterministic',
  };
}

// ---- PROJECT_COCKPIT.md render (markdown) ----
function renderMarkdown(snapshot, approvalsLine) {
  const md = snapshot.measured;
  const declared = snapshot.declared;
  const lines = [];
  const L = (s) => lines.push(s);

  L('# PROJECT COCKPIT');
  L('');
  L('> Regenerate: `node scripts/cockpit.mjs`. One plain-English view of where things stand.');
  L('> **Honesty contract:** [MEASURED] = hard fact from git/metrics. [ESTIMATED] = derived, approximate.');
  L('> [DECLARED] = human-set in .forge/cockpit.json. [NOT TRACKED] = not captured yet (never guessed).');
  L('');
  L('---');
  L('');
  L('## Where things stand (MEASURED)');
  L('');
  L('| Metric | Value | Source |');
  L('|---|---|---|');
  L(`| Current branch | ${md.branch} | git |`);
  L(`| Total commits | ${md.total_commits} | git log |`);
  L(`| Commits last 7 days | ${md.last7_commits} | git log |`);
  L(`| Latest commit | \`${md.head}\` ${md.head_subject} | git |`);
  L(`| Factory health | ${md.doctor} | forge doctor |`);
  L(`| Architect-probes run | ${md.architect_probes} | factory_metrics |`);
  L(`| Arch gates fired | ${md.arch_gates} (${md.gate_overrides} overrides) | factory_metrics |`);
  if (md.last_context_tokens) L(`| Last context-load measure | ~${md.last_context_tokens} tokens/msg | factory_metrics (sporadic) |`);
  L('');
  L('## Goals + milestones (DECLARED)');
  L('');
  if (declared && declared.goals) {
    for (const g of declared.goals) {
      L(`### ${g.title}  -- ${g.percent_complete}% [DECLARED]`);
      if (g.note) L(`${g.note}`);
      if (g.milestones) {
        L('');
        L('| Milestone | Status |');
        L('|---|---|');
        for (const ms of g.milestones) L(`| ${ms.name} | ${ms.status} |`);
      }
      L('');
    }
  } else {
    L('_No .forge/cockpit.json yet._ Create it to declare goals + milestone %. Starter:');
    L('');
    L('```json');
    L('{');
    L('  "goals": [{');
    L('    "title": "v5.0 commercial launch",');
    L('    "percent_complete": 0,');
    L('    "note": "Customer-configurable factory plugin.",');
    L('    "milestones": [');
    L('      {"name": "v4.4.5 token-burn sprint", "status": "done"},');
    L('      {"name": "v5.0 Sprint 1 override layer", "status": "in progress"},');
    L('      {"name": "Phase D fan-out", "status": "not started"},');
    L('      {"name": "1 stranger journey cold", "status": "not started"},');
    L('      {"name": "landing + attorney review", "status": "not started"}');
    L('    ]');
    L('  }]');
    L('}');
    L('```');
  }
  L('');
  L('## Spend (HONEST LIMITS)');
  L('');
  L('| What | Status |');
  L('|---|---|');
  if (md.ai_measured) {
    const anom = md.ai_anomalies > 0 ? ` (${md.ai_anomalies} event(s) had invalid cost and were excluded)` : '';
    L(`| Dollar cost (AI, month-to-date) | [MEASURED] $${fmt2(md.ai_cost_cents_mtd / 100)} -- ${md.ai_calls_mtd} ai_call events via the router's provenance (A8)${anom}. Anthropic Console remains the billing source of truth. |`);
  } else if (md.ai_partial) {
    L(`| Dollar cost | [PARTIAL] -- ${md.ai_calls_mtd} ai_call event(s) logged this month, but none carried a valid cost, so the dollar figure is not measurable yet. NOT shown as $0.00 (that would be a fabricated number). Anthropic Console -> Usage is the billing source of truth. |`);
  } else {
    L("| Dollar cost | [NOT TRACKED] -- the vibepromptrig-cost MCP is now wired to the router's ai_call provenance (get_ai_call_cost), but no ai_call events have been logged yet. Lights up to [MEASURED] once agents dispatch through the router. Anthropic Console -> Usage is the billing source of truth. |");
  }
  L('| Tokens (per session) | [PARTIAL] -- only sporadic context-load measurements exist, not per-session totals. |');
  L('| Your time (prompting/reviewing/reading) | [NOT TRACKED] -- never captured; can only be ESTIMATED forward from message timestamps, not measured backward. |');
  L('| AI work time | [ESTIMATED] -- derivable from commit timestamps; not yet aggregated. |');
  L('');
  L('> The wired version (real token+cost+time capture into the 3 vibepromptrig MCPs) is a');
  L('> queued v5.x feature (architect-probe pending). This MVP shows what is honestly');
  L('> knowable today and refuses to fabricate the rest.');
  L('');
  L('## Blockers + next (DECLARED)');
  L('');
  if (approvalsLine) { L(`- ${approvalsLine} -- see PENDING_APPROVALS.md`); L(''); }
  if (declared && declared.blockers) {
    for (const b of declared.blockers) L(`- ${b}`);
  } else {
    L('_Add a `blockers` array to .forge/cockpit.json to track these._');
  }
  L('');
  L('---');
  L('_Generated by scripts/cockpit.mjs. Re-run after milestones change. Edit goals/milestones/blockers in .forge/cockpit.json._');

  return lines.join('\n') + '\n';
}

// N2-style formatter (e.g. 12.5 -> "12.50"; matches PowerShell "{0:N2}" sans thousands sep parity
// concerns -- dollar figures here are small and the .ps1 used N2 the same way).
function fmt2(n) {
  return Number(n).toFixed(2);
}

// ---- CLI (faithful to cockpit.ps1: -Json | -FactoryRoot, else write PROJECT_COCKPIT.md) ----
function main() {
  const argv = process.argv.slice(2);
  const factoryRoot = resolveFactoryRoot(argv);
  const asJson = hasFlag(argv, '-Json', '--json');

  const snapshot = gatherCockpit({ factoryRoot });

  if (asJson) {
    // No process.exit(): main() returns and the process ends naturally, so Node drains stdout fully.
    // (process.exit() right after a large write to a non-blocking PIPE truncates the tail -- 8KB on
    // macOS; the spawnSync parent then captures partial JSON. Natural exit avoids that.)
    process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
    return;
  }

  const outPath = join(factoryRoot, 'PROJECT_COCKPIT.md');
  writeFileSync(outPath, renderMarkdown(snapshot, summaryLine(join(factoryRoot, 'PENDING_APPROVALS.md'))), { encoding: 'utf8' });
  process.stdout.write(`[OK] Wrote PROJECT_COCKPIT.md (${snapshot.measured.total_commits} commits, doctor: ${snapshot.measured.doctor})\n`);
}

// Only run the CLI when invoked directly, never when imported by dashboard.mjs.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main();
