#!/usr/bin/env node
// weekly-deep-sweep.mjs -- Node twin of weekly-deep-sweep.ps1 (cross-platform port P2, T3 --
// the UNIFORM OS-NATIVE scheduler tranche). LOCAL job run by the OS scheduler on the operator's
// machine (cron / launchd / Task Scheduler) -- NOT CI, NOT GitHub Actions.
//
// WHAT IT DOES (faithful to the .ps1): weekly cross-project sweep -> <factory>/WEEKLY_INSIGHTS.md.
//   - aggregates errors-fixed.json counts across factory projects/ (recursive) + ~/Projects/* (flat)
//   - notes which projects have a non-trivial golden-paths.md
//   - counts unique lessons across lessons-critical.md + reference/lessons-archive.md (^\d+. lines)
//   - flags projects needing attention (no BRIEF.md, or DISCUSSED-state BRIEF.md)
//   - rule-freshness across discovered and configured project paths vs the factory VERSION stamp
//   - operational SLA (pg-dump-offsite stamp age, DECISIONS.md staleness)
//   - signal synthesis from .claude/signal-log.jsonl (7-day window) across factory + known projects,
//     thresholds -> findings, AND a class-key-deduped proposal appended to PENDING_APPROVALS.md
//
// IDEMPOTENCY preserved exactly: WEEKLY_INSIGHTS.md is overwritten each run (no append). The
// PENDING_APPROVALS proposal block dedups per signal type via the class-key "[SYNTH-AUTO] <SIGNAL>"
// (the same in-loop + on-disk guard as the .ps1) so re-runs never duplicate an open proposal.
//
// PORT NOTES / deliberate deviations:
//   - utcStamp() for the run-summary row is GENUINE UTC (the .ps1 had no run-summary row; this is new
//     per port rule 3). All on-screen timestamps / WeekOf use LOCAL date, matching Get-Date -Format.
//   - The .ps1 set $ErrorActionPreference=SilentlyContinue (best-effort, never crash). This twin
//     mirrors that: per-file/per-dir reads are wrapped so one bad file never aborts the sweep. The
//     sweep itself never throws on missing inputs; it only fails-loud (exit 1) if WRITING the report
//     is impossible (a backup-class "must produce output" obligation).
//   - --dry-run: validates inputs + prints the report and any PENDING proposals to stdout WITHOUT
//     writing WEEKLY_INSIGHTS.md or touching PENDING_APPROVALS.md (the .ps1's only side effects).
//
// Dependency-free (Node stdlib only), node:path throughout, ESM, Node >= 18.

import {
  existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync,
} from 'node:fs';
import { join, dirname, basename, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import process from 'node:process';
import { resolveFactoryRoot, utcStamp, appendJsonl } from './hooks/hook-lib.mjs';
import { summaryLine, summarizePending } from './lib/pending-summary.mjs';
import { findArchivable } from './archive-resolved-approvals.mjs';

const JOB = 'weekly-deep-sweep';
const here = dirname(fileURLToPath(import.meta.url)); // .../scripts
const DRY_RUN = process.argv.includes('--dry-run');

// ---- resolve the operator factory root ----
// hook-lib's resolveFactoryRoot() assumes the caller lives in scripts/hooks/ (it does
// dirname(dirname(scriptDir)) = two-up). THIS file lives in scripts/ (one-up from the factory root),
// matching the .ps1's `Split-Path $PSScriptRoot -Parent`. So we reuse resolveFactoryRoot ONLY for its
// plugin-copy `defer` guard, but compute factoryRoot ourselves with the correct one-up arithmetic +
// the same VIBE_ROOT override the .ps1 honors. Pass `join(here,'hooks')` to the helper so its two-up
// math + plugin-dist/cache regex evaluate against a scripts/hooks-shaped path (the shape it expects).
const { defer } = resolveFactoryRoot(join(here, 'hooks'));
if (defer) process.exit(0); // plugin-dist copy inside a factory session -> repo-local copy does the work
const factoryRoot = process.env.VIBE_ROOT || dirname(here); // dirname(scripts/) = factory root

// ---- run-summary: exactly one row per run (ok | fail | skipped). Written via hook-lib appendJsonl ----
let summaryWritten = false;
function writeSummary(status, detail) {
  if (summaryWritten) return;
  summaryWritten = true;
  if (!factoryRoot) return; // no ledger to write to (installed-plugins cache w/o VIBE_ROOT)
  appendJsonl(join(factoryRoot, 'factory_metrics.jsonl'), {
    ts: utcStamp(), event: 'scheduled_run', job: JOB, status, detail: String(detail || '').slice(0, 200),
  });
}

function failLoud(detail, code = 1) {
  process.stderr.write(`[${JOB}] ERROR: ${detail}\n`);
  writeSummary('fail', detail);
  process.exit(code);
}

if (!factoryRoot) {
  // No resolvable factory root means no projects dir, no output path -- a backup-class job must not
  // silently no-op. Fail loud (cannot even write the run-summary row in this case).
  process.stderr.write(`[${JOB}] ERROR: could not resolve factory root (set VIBE_ROOT)\n`);
  process.exit(1);
}

// ---- small fs helpers (never throw; mirror SilentlyContinue) ----
function readTextSafe(p) { try { return readFileSync(p, 'utf8'); } catch { return null; } }
function isDir(p) { try { return statSync(p).isDirectory(); } catch { return false; } }
function listDirs(p) {
  try { return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { return []; }
}
function listEntries(p) {
  try { return readdirSync(p, { withFileTypes: true }); } catch { return []; }
}
// Recursively find files named exactly `target` under `root`. Returns absolute paths. Never throws.
function findFilesRecursive(root, target, acc = []) {
  for (const ent of listEntries(root)) {
    const full = join(root, ent.name);
    if (ent.isDirectory()) { findFilesRecursive(full, target, acc); }
    else if (ent.isFile() && ent.name === target) { acc.push(full); }
  }
  return acc;
}
function parseJsonSafe(s) { try { return JSON.parse(s); } catch { return null; } }
// LastWriteTime-equivalent (mtime) age helpers.
function mtime(p) { try { return statSync(p).mtimeMs; } catch { return null; } }
function hoursSince(ms) { return (Date.now() - ms) / 36e5; }
function daysSince(ms) { return (Date.now() - ms) / 864e5; }
function round1(n) { return Math.round(n * 10) / 10; }

try {
  const ProjectsDir = join(factoryRoot, 'projects');
  const OutputPath = join(factoryRoot, 'WEEKLY_INSIGHTS.md');
  // WeekOf / on-screen stamps use LOCAL date (Get-Date -Format "yyyy-MM-dd").
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const WeekOf = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  const userProfile = process.env.USERPROFILE || process.env.HOME || homedir();
  const projectDir = join(userProfile, 'Projects'); // ~/Projects (the operator's active projects)

  // ---- Collect all errors across projects ----
  const errorSources = [];
  let totalErrors = 0;

  // Scan factory projects dir (recursive errors-fixed.json) -- projName = the file's parent dir name.
  for (const efPath of findFilesRecursive(ProjectsDir, 'errors-fixed.json')) {
    const projName = basename(dirname(efPath));
    const content = readTextSafe(efPath);
    if (content && content.trim() !== '[]') {
      const errors = parseJsonSafe(content);
      if (Array.isArray(errors) && errors.length > 0) {
        totalErrors += errors.length;
        errorSources.push(`${projName} (${errors.length} entries)`);
      } else if (errors && !Array.isArray(errors)) {
        // PS ConvertFrom-Json on a single object => truthy, .Count == 1. Match that arity.
        totalErrors += 1;
        errorSources.push(`${projName} (1 entries)`);
      }
    }
  }

  // Scan active projects (~/Projects/*/errors-fixed.json, one level deep).
  if (isDir(projectDir)) {
    for (const name of listDirs(projectDir)) {
      const efPath = join(projectDir, name, 'errors-fixed.json');
      if (existsSync(efPath)) {
        const content = readTextSafe(efPath);
        if (content && content.trim() !== '[]') {
          const errors = parseJsonSafe(content);
          if (Array.isArray(errors) && errors.length > 0) {
            totalErrors += errors.length;
            errorSources.push(`${name} (${errors.length} entries)`);
          } else if (errors && !Array.isArray(errors)) {
            totalErrors += 1;
            errorSources.push(`${name} (1 entries)`);
          }
        }
      }
    }
  }

  // ---- Collect golden paths ----
  const allPaths = [];
  const pathSources = [ProjectsDir];
  if (isDir(projectDir)) pathSources.push(projectDir);

  for (const searchDir of pathSources) {
    for (const gpPath of findFilesRecursive(searchDir, 'golden-paths.md')) {
      const content = readTextSafe(gpPath);
      if (content && content.length > 100) {
        const parentName = basename(dirname(gpPath));
        allPaths.push(`- **${parentName}**: has documented patterns`);
      }
    }
  }

  // ---- lessons growth (count unique ^\d+. lesson numbers across the split files) ----
  // lessons.md was split into lessons-critical.md (always-on subset) +
  // reference/lessons-archive.md (full archive). The critical file re-lists archive
  // entries by the same number, so dedupe by lesson number to avoid double-counting.
  const lessonPaths = [
    join(factoryRoot, 'docs', 'rules-reference', 'factory', 'lessons-critical.md'),
    join(factoryRoot, 'docs', 'rules-reference', 'factory', 'reference', 'lessons-archive.md'),
  ];
  const lessonNumbers = new Set();
  for (const lessonsPath of lessonPaths) {
    const content = readTextSafe(lessonsPath);
    if (content !== null) {
      for (const line of content.split(/\r?\n/)) {
        const m = /^(\d+)\./.exec(line);
        if (m) lessonNumbers.add(m[1]);
      }
    }
  }
  const lessonCount = lessonNumbers.size;

  // ---- Projects needing attention ----
  const needsAttention = [];
  for (const projName of listDirs(ProjectsDir)) {
    const briefPath = join(ProjectsDir, projName, 'BRIEF.md');
    if (!existsSync(briefPath)) {
      needsAttention.push(`| ${projName} | No BRIEF.md | Create project brief or remove from projects/ |`);
      continue;
    }
    const briefContent = readTextSafe(briefPath) || '';
    if (/DISCUSSED/.test(briefContent) && /\[.+\]/.test(briefContent)) {
      needsAttention.push(`| ${projName} | Still in DISCUSSED state | Decide: build, park with reason, or remove |`);
    }
  }

  // ---- Rule freshness check (factory version stamp comparison) ----
  let currentFactoryVersion = 'v4.0';
  {
    const vFile = readTextSafe(join(factoryRoot, 'VERSION.md'));
    if (vFile) {
      const m = vFile.match(/##\s+v(\d+\.\d+(?:\.\d+)?)/);
      if (m) currentFactoryVersion = `v${m[1]}`;
    }
  }

  // Discover local projects and optional configured external roots; no operator paths ship.
  const configPath = join(factoryRoot, '.forge', 'agent-configs', 'synthesizer.json');
  const config = parseJsonSafe(readTextSafe(configPath) || '') || {};
  const configured = Array.isArray(config?.config?.projects) ? config.config.projects.filter((path) => typeof path === 'string' && isAbsolute(path)) : [];
  const candidates = [
    ...listDirs(ProjectsDir).map((name) => join(ProjectsDir, name)),
    ...listDirs(projectDir).map((name) => join(projectDir, name)),
    ...configured,
  ];
  const knownProjects = [...new Set(candidates.map((path) => resolve(path)))].filter((path) => path !== resolve(factoryRoot))
    .map((path) => ({ name: basename(path), path }));

  const staleRules = [];
  for (const p of knownProjects) {
    if (!existsSync(p.path)) {
      staleRules.push(`| ${p.name} | MISSING | Path does not exist: ${p.path} |`);
      continue;
    }
    // Context V2: onboarding installs the compact kernel, never a .claude/rules copy (Delivery 3b).
    if (!existsSync(join(p.path, '.forge', 'context', 'kernel.md'))) {
      staleRules.push(`| ${p.name} | NOT ONBOARDED (no compact context) | Run: .\\scripts\\onboard-existing-project.ps1 -Path "${p.path}" |`);
      continue;
    }
    const rulesDir = join(p.path, '.claude', 'rules');
    const legacyCopies = isDir(rulesDir) ? listEntries(rulesDir).filter((e) => e.isFile() && e.name.endsWith('.md')).length : 0;
    if (legacyCopies > 0) {
      staleRules.push(`| ${p.name} | ${legacyCopies} file(s) in .claude/rules (may be legacy factory copies) | Review: forge legacy-rules plan --project-root "${p.path}" --out <plan.json> |`);
    }
    const claudeMd = join(p.path, '.claude', 'CLAUDE.md');
    if (existsSync(claudeMd)) {
      const claudeMdContent = readTextSafe(claudeMd) || '';
      const vm = claudeMdContent.match(/VibePromptRig factory (v\d+\.\d+(?:\.\d+)?)/);
      if (vm) {
        const projectVersion = vm[1];
        if (projectVersion !== currentFactoryVersion) {
          staleRules.push(`| ${p.name} | ${projectVersion} (factory is ${currentFactoryVersion}) | Re-run onboard to refresh |`);
        }
      } else {
        staleRules.push(`| ${p.name} | No version stamp | Re-run onboard to add stamp |`);
      }
    }
  }

  let ruleSection = `All known projects are at factory ${currentFactoryVersion}.`;
  if (staleRules.length > 0) {
    ruleSection = `| Project | Status | Action |\n|---------|--------|--------|\n${staleRules.join('\n')}`;
  }

  // ---- Operational SLA checks ----
  const slaItems = [];
  const backupStamp = join(factoryRoot, 'logs', 'pg-dump-offsite.last-run.stamp');
  {
    const ms = existsSync(backupStamp) ? mtime(backupStamp) : null;
    if (ms !== null) {
      const age = hoursSince(ms);
      if (age > 30) {
        slaItems.push(`- [WARN] pg-dump-offsite last ran ${round1(age)}h ago (SLA: <24h)`);
      } else {
        slaItems.push(`- [OK] pg-dump-offsite ran ${round1(age)}h ago`);
      }
    } else {
      slaItems.push('- [WARN] pg-dump-offsite has never run -- see scripts\\backup-targets.json');
    }
  }

  const decisionsPath = join(factoryRoot, 'DECISIONS.md');
  {
    const ms = existsSync(decisionsPath) ? mtime(decisionsPath) : null;
    if (ms !== null) {
      const age = daysSince(ms);
      if (age > 14) {
        slaItems.push(`- [WARN] DECISIONS.md is ${round1(age)}d stale (log recent decisions)`);
      } else {
        slaItems.push(`- [OK] DECISIONS.md is ${round1(age)}d old`);
      }
    }
  }

  const slaSection = slaItems.join('\n');

  // ---- Signal synthesis (P1a: synthesizer cadence, pure stdlib, $0) ----
  // reads .claude/signal-log.jsonl from factory + known projects (past 7 days), aggregates,
  // flags: REPEAT in 2+ projects, REWORK >=3 per project, SECURITY anywhere, FRUSTRATION >5 per
  // project, APPROVAL in 3+ projects.
  const signalWindowDays = 7;
  const signalCutoff = Date.now() - signalWindowDays * 864e5;
  const signalPaths = [{ name: 'factory', path: factoryRoot }, ...knownProjects];
  const sigByProject = new Map(); // name -> Map(signal -> count)
  const sigTotals = new Map();    // signal -> count
  const sigProjects = new Map();  // signal -> Set(projectName)

  for (const sp of signalPaths) {
    const slPath = join(sp.path, '.claude', 'signal-log.jsonl');
    if (!existsSync(slPath)) continue;
    const raw = readTextSafe(slPath);
    if (raw === null) continue;
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.trim().length === 0) continue;
      const e = parseJsonSafe(line);
      if (!e || !e.ts || !e.signals) continue;
      // RoundtripKind-equivalent: Date.parse tolerates ISO 8601 incl. the pre/post-fix Z stamps
      // (max 4h skew, immaterial against a 7-day window).
      const t = Date.parse(e.ts);
      if (Number.isNaN(t) || t < signalCutoff) continue;
      const signals = Array.isArray(e.signals) ? e.signals : [e.signals];
      for (const s of signals) {
        if (!sigByProject.has(sp.name)) sigByProject.set(sp.name, new Map());
        const m = sigByProject.get(sp.name);
        m.set(s, (m.get(s) || 0) + 1);
        sigTotals.set(s, (sigTotals.get(s) || 0) + 1);
        if (!sigProjects.has(s)) sigProjects.set(s, new Set());
        sigProjects.get(s).add(sp.name);
      }
    }
  }

  const sortedNames = (set) => [...set].sort();
  const signalFindings = [];
  if (sigProjects.has('REPEAT') && sigProjects.get('REPEAT').size >= 2) {
    const projs = sortedNames(sigProjects.get('REPEAT'));
    signalFindings.push(`- [SYNTH] REPEAT fired in ${projs.length} projects (${projs.join(', ')}) -- cross-project rule promotion candidate`);
  }
  for (const [proj, m] of sigByProject) {
    if ((m.get('REWORK') || 0) >= 3) {
      signalFindings.push(`- [SYNTH] REWORK x${m.get('REWORK')} in ${proj} -- architectural review suggested`);
    }
    if ((m.get('FRUSTRATION') || 0) > 5) {
      signalFindings.push(`- [SYNTH] FRUSTRATION x${m.get('FRUSTRATION')} in ${proj} -- run /half-baked-scan`);
    }
  }
  if (sigTotals.has('SECURITY')) {
    signalFindings.push(`- [SYNTH] SECURITY fired ${sigTotals.get('SECURITY')}x this week -- check signal-log for secret_in_prompt:true; rotate per secrets-handling.md SS3`);
  }
  if (sigProjects.has('APPROVAL') && sigProjects.get('APPROVAL').size >= 3) {
    signalFindings.push(`- [SYNTH] APPROVAL fired in ${sigProjects.get('APPROVAL').size} projects -- golden-path generalization candidate`);
  }

  // Signal table rows sorted by count desc (PS Sort-Object -Descending on the count selector).
  const sigTableRows = [];
  const signalsByCountDesc = [...sigTotals.keys()].sort((a, b) => sigTotals.get(b) - sigTotals.get(a));
  for (const s of signalsByCountDesc) {
    sigTableRows.push(`| ${s} | ${sigTotals.get(s)} | ${sortedNames(sigProjects.get(s)).join(', ')} |`);
  }
  let signalSection = `No signals captured in the past ${signalWindowDays} days.`;
  if (sigTableRows.length > 0) {
    signalSection = `| Signal | Count (7d) | Projects |\n|---|---|---|\n${sigTableRows.join('\n')}`;
    if (signalFindings.length > 0) {
      signalSection += '\n\n**Patterns detected:**\n' + signalFindings.join('\n');
    } else {
      signalSection += '\n\nNo cross-project patterns crossed thresholds this week.';
    }
  }

  // ---- Propose detected patterns to PENDING_APPROVALS -- ONE open entry per signal type ----
  // class-key dedup ("[SYNTH-AUTO] <SIGNAL>"), same discipline as the .ps1.
  let pendingProposalBlock = null; // captured for --dry-run display
  if (signalFindings.length > 0) {
    const pendingPath = join(factoryRoot, 'PENDING_APPROVALS.md');
    let pendingRaw = existsSync(pendingPath) ? (readTextSafe(pendingPath) || '') : '';
    const newProposals = [];
    for (const f of signalFindings) {
      const body = f.replace(/^- \[SYNTH\] /, '');
      const sigName = body.split(' ')[0];
      const classKey = `[SYNTH-AUTO] ${sigName}`;
      if (!pendingRaw.includes(classKey)) {
        newProposals.push(`### ${classKey} -- ${body} (${WeekOf})`);
        pendingRaw += ` ${classKey}`; // in-loop guard: one entry per type per run
      }
    }
    if (newProposals.length > 0) {
      const header = `\n\n---\n\n## Synthesizer Proposals (week of ${WeekOf})\n`;
      pendingProposalBlock = header + newProposals.map((np) => np + '\n').join('');
      if (!DRY_RUN) {
        // .ps1 wrapped these Add-Content calls in try/catch (best-effort). Mirror: never abort the
        // sweep if PENDING_APPROVALS is unwritable -- the WEEKLY_INSIGHTS report is the primary output.
        try {
          appendFileSync(pendingPath, header);
          for (const np of newProposals) appendFileSync(pendingPath, np + '\n');
        } catch { /* best-effort, matches .ps1 */ }
      }
    }
  }

  // ---- Build sections ----
  let errorSection = 'No errors logged in any project. Consider: are bugs being tracked?';
  if (errorSources.length > 0) {
    errorSection = errorSources.map((e) => `- ${e}`).join('\n');
  }

  let pathSection = 'No golden paths documented yet. After each successful pattern, add to golden-paths.md.';
  if (allPaths.length > 0) {
    pathSection = allPaths.join('\n');
  }

  let attentionSection = 'All projects have proper briefs and active statuses.';
  if (needsAttention.length > 0) {
    attentionSection = `| Project | Issue | Suggested Action |\n|---------|-------|-----------------|\n${needsAttention.join('\n')}`;
  }

  // ---- Approvals queue (audit 3.4): summary + archive candidates (report-only; --apply is manual) ----
  const pendingPath = join(factoryRoot, 'PENDING_APPROVALS.md');
  let approvalsSection = '_PENDING_APPROVALS.md not found._';
  if (existsSync(pendingPath)) {
    const nowApprovals = Date.now();
    const arch = findArchivable(readTextSafe(pendingPath) || '', nowApprovals, 30);
    const s = summarizePending(pendingPath, nowApprovals);
    const aging = s.openItems.filter((i) => i.ageDays >= 30).sort((a, b) => b.ageDays - a.ageDays);
    approvalsSection = `- ${summaryLine(pendingPath, nowApprovals)}\n`
      + (aging.length
        ? `- **${aging.length} OPEN approval(s) aging past 30 days** (oldest first): ${aging.map((i) => `${i.tag} (${i.ageDays}d, ${i.pri})`).join(', ')}\n`
        : '- No open approvals aging past 30 days.\n')
      + (arch.archive.length
        ? `- ${arch.archive.length} resolved entr${arch.archive.length === 1 ? 'y' : 'ies'} >30d ready to archive (${arch.archive.map((a) => a.c.tag).join(', ')}). Run \`node scripts/archive-resolved-approvals.mjs --apply\` to move them.`
        : '- No resolved entries >30d awaiting archive.');
  }

  // ---- Write report (em-dash bytes preserved verbatim from the .ps1 here-string) ----
  const report = `# VibePromptRig Weekly Insights — Week of ${WeekOf}
Generated automatically. All suggestions require the project owner's approval.

## Cross-Project Error Sources
${errorSection}

## Total Errors Across All Projects: ${totalErrors}

## Golden Paths Documented
${pathSection}

## Learning Velocity
- lessons (lessons-critical.md + reference/lessons-archive.md, unique): ${lessonCount} rules
- Target: Add at least 1 lesson per week from real project work

## Projects Needing Attention
${attentionSection}

## Rule Freshness (factory ${currentFactoryVersion} vs project stamps)
${ruleSection}

## Approvals Queue
${approvalsSection}

## Operational SLA
${slaSection}

## Signal Synthesis (past ${signalWindowDays} days, all projects)
${signalSection}

## Suggested Lesson Additions
Review the errors and patterns above. If any pattern appeared in 2+ projects, it should become a lesson in lessons-critical.md (or reference/lessons-archive.md for the full archive).

## Suggested VIBE Rule Updates
If any bug pattern recurred across sessions (Bug twice = VIBE Rule, per Post-Mortem Protocol), draft the new rule here.
`;

  if (DRY_RUN) {
    process.stdout.write(`[${JOB}] --dry-run: would write ${OutputPath}\n`);
    process.stdout.write('----- WEEKLY_INSIGHTS.md (preview) -----\n');
    process.stdout.write(report);
    process.stdout.write('----- end preview -----\n');
    if (pendingProposalBlock) {
      process.stdout.write(`[${JOB}] --dry-run: would append to PENDING_APPROVALS.md:\n`);
      process.stdout.write(pendingProposalBlock);
    }
    writeSummary('skipped', 'dry-run');
    process.exit(0);
  }

  // Writing the report is the backup-class obligation -- a failure here is a real (fail-loud) failure.
  try {
    writeFileSync(OutputPath, report);
  } catch (e) {
    failLoud(`failed to write ${OutputPath}: ${e && e.message ? e.message : e}`);
  }

  process.stdout.write(`Weekly insights generated: ${OutputPath}\n`);
  writeSummary('ok', `${errorSources.length} error sources, ${signalFindings.length} signal findings`);
  process.exit(0);
} catch (e) {
  // Any unexpected error during the sweep -> fail loud (never a silent no-op), record + non-zero exit.
  failLoud(`unhandled: ${e && e.stack ? e.stack.split('\n')[0] : e}`);
}
