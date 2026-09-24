#!/usr/bin/env node
// daily-status-check.mjs -- dependency-free Node twin of daily-status-check.ps1
// (cross-platform port P2, T3 -- the UNIFORM OS-NATIVE scheduler tranche, approved 2026-06-14).
//
// Daily status report generator. Scans all VibePromptRig projects, reads local factory state
// (git log, tracking files) and writes <factory-root>/STATUS_REPORT.md. Runs headless via the
// OS scheduler (Windows Task Scheduler / launchd / cron) at 8am daily on the OPERATOR'S machine.
//
// Faithful port of the .ps1: same git commands, same report content/shape, same file write
// (UTF-8, no BOM). status:'ok' on a successful write.
//
// Dependency-free: Node stdlib only, node:path throughout, Node >= 18, ESM. Reuses hook-lib.mjs
// helpers (appendJsonl/utcStamp/resolveFactoryRoot). The .ps1 had $ErrorActionPreference =
// 'SilentlyContinue'; the equivalent here is per-operation try/catch that swallows the SAME classes
// of error the .ps1 silently ignored (missing dirs, unreadable files, git not on PATH, bad JSON),
// so the report still generates from whatever state IS readable -- never a silent no-op of the write
// itself (rule 4: the report write is the job; only it being missing is a fail).

import {
  readFileSync, writeFileSync, readdirSync, statSync, existsSync, realpathSync,
} from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { appendJsonl, utcStamp, resolveFactoryRoot } from './hooks/hook-lib.mjs';
import { summaryLine } from './lib/pending-summary.mjs';

const JOB = 'daily-status-check';
const scriptDir = dirname(fileURLToPath(import.meta.url)); // <factory>/scripts
// resolveFactoryRoot() assumes the caller lives in scripts/hooks/ (it does dirname(dirname(arg))).
// This job lives one level higher, in scripts/, so we pass the hooks/ subdir as the anchor: its
// grandparent is the factory root -- matching the .ps1's Split-Path $PSScriptRoot -Parent. (The
// helper's plugin-dist/defer guard still works because it pattern-matches the path for plugin markers.)
const factoryAnchorDir = join(scriptDir, 'hooks'); // <factory>/scripts/hooks

// --- run-summary helper (rule 3): EXACTLY ONE row per run -------------------------------------
function runSummary(factoryRoot, status, detail) {
  if (!factoryRoot) return; // no factory ledger to write to (plugin-cache w/o VIBE_ROOT)
  appendJsonl(join(factoryRoot, 'factory_metrics.jsonl'), {
    ts: utcStamp(), event: 'scheduled_run', job: JOB, status, detail,
  });
}

// --- date helpers: replicate ((Get-Date) - $date).Days (whole-day diff, local midnight) -------
// The .ps1 parses a date string to LOCAL midnight ([DateTime]::Parse on a 'yyyy-MM-dd' substring)
// and subtracts from Get-Date (local now), taking .Days (truncates toward zero). We mirror that:
// floor of (localMidnightNow - localMidnightThen) in whole days, but the .ps1 keeps the time-of-day
// on the "now" side -- so we subtract a midnight-anchored 'then' from the full 'now' and floor.
function daysSinceLocalDateString(ymd) {
  // ymd is 'yyyy-MM-dd'. Parse as LOCAL date at midnight (matches [DateTime]::Parse('2026-06-01')).
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const then = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  if (Number.isNaN(then.getTime())) return null;
  const diffMs = Date.now() - then.getTime();
  return Math.trunc(diffMs / 86_400_000); // .Days truncates toward zero
}

function daysSinceMtime(filePath) {
  // ((Get-Date) - (Get-Item path).LastWriteTime).Days
  try {
    const mt = statSync(filePath).mtime.getTime();
    return Math.trunc((Date.now() - mt) / 86_400_000);
  } catch { return null; }
}

function mtimeYmd(filePath) {
  // (Get-Item path).LastWriteTime.ToString('yyyy-MM-dd') -- local date.
  const d = statSync(filePath).mtime;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayYmd() {
  // Get-Date -Format 'yyyy-MM-dd' -- local date.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function nowHHmm() {
  // Get-Date -Format 'HH:mm' -- local 24h time.
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// --- small fs helpers (silent like $ErrorActionPreference=SilentlyContinue) --------------------
function readTextRaw(p) {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

function listDirs(dirPath) {
  // Get-ChildItem -Directory : returns {name, fullPath} for sub-directories only.
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, fullPath: join(dirPath, e.name) }));
  } catch { return []; }
}

const identityKey = (value) => value.trim().toLocaleLowerCase();
const displayCell = (value) => String(value || 'UNKNOWN').replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
function pathKey(path) {
  if (!path) return null;
  let absolute;
  try { absolute = realpathSync.native(path); } catch { absolute = resolve(path); }
  return process.platform === 'win32' ? absolute.toLocaleLowerCase() : absolute;
}

function registryField(brief, field) {
  return new RegExp(`^Registry ${field}:[ \\t]*(.*)$`, 'im').exec(brief)?.[1]?.trim() || '';
}

function registeredProjects(projectsDir) {
  const records = [];
  for (const proj of listDirs(projectsDir)) {
    const brief = readTextRaw(join(proj.fullPath, 'BRIEF.md'));
    if (brief == null) continue;
    const location = /^## Location[ \t]*\r?\n([^\r\n]+)/im.exec(brief)?.[1]?.trim() || '';
    const canonical = registryField(brief, 'Canonical') || proj.name;
    const aliases = registryField(brief, 'Aliases').split(',').map((s) => s.trim()).filter(Boolean);
    const status = /^## Status:[ \t]*(.+)/im.exec(brief)?.[1]?.trim() || 'Unknown';
    records.push({
      dirName: proj.name, brief, location, canonical, aliases, status,
      owner: registryField(brief, 'Owner'), task: registryField(brief, 'Task'),
      checkpoint: registryField(brief, 'Checkpoint'), checkpointDate: registryField(brief, 'Checkpoint Date'),
      mode: registryField(brief, 'Delivery Mode').toLowerCase(), conflict: false, duplicate: false,
    });
  }
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const a = records[i]; const b = records[j];
      const aNames = new Set([a.canonical, a.dirName, ...a.aliases].map(identityKey));
      const bNames = new Set([b.canonical, b.dirName, ...b.aliases].map(identityKey));
      const samePath = a.location && b.location && pathKey(a.location) === pathKey(b.location);
      const overlap = [...aNames].some((name) => bNames.has(name));
      if (!samePath && !overlap) continue;
      const declaredAlias = a.aliases.map(identityKey).includes(identityKey(b.canonical))
        || b.aliases.map(identityKey).includes(identityKey(a.canonical));
      const sameIdentity = samePath && (identityKey(a.canonical) === identityKey(b.canonical) || declaredAlias);
      const known = (value) => value && value !== 'UNKNOWN';
      const incompatible = ['owner', 'task', 'checkpoint', 'checkpointDate', 'mode']
        .some((field) => known(a[field]) && known(b[field]) && a[field] !== b[field]);
      if (!sameIdentity || incompatible) { a.conflict = true; b.conflict = true; continue; }
      const aScore = Number(identityKey(a.dirName) === identityKey(a.canonical)) + Number(Boolean(a.owner)) + Number(Boolean(a.mode));
      const bScore = Number(identityKey(b.dirName) === identityKey(b.canonical)) + Number(Boolean(b.owner)) + Number(Boolean(b.mode));
      (aScore >= bScore ? b : a).duplicate = true;
    }
  }
  return records.filter((record) => !record.duplicate || record.conflict);
}

function repositoryIdentity(repoPath) {
  if (!repoPath || !existsSync(repoPath)) return { ok: false, reason: 'UNKNOWN: registered checkout missing' };
  if (!isAbsolute(repoPath)) return { ok: false, reason: 'UNKNOWN: registered checkout path is not absolute' };
  try {
    if (!statSync(repoPath).isDirectory()) return { ok: false, reason: 'UNKNOWN: registered checkout is not a directory' };
    const r = spawnSync('git', ['-C', repoPath, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    if (r.error || r.status !== 0 || !r.stdout.trim()) return { ok: false, reason: 'UNKNOWN: registered checkout is not a repository' };
    if (pathKey(repoPath) !== pathKey(r.stdout.trim())) return { ok: false, reason: 'UNKNOWN: repository identity mismatch' };
    return { ok: true };
  } catch { return { ok: false, reason: 'UNKNOWN: repository identity unavailable' }; }
}

// git log -1 --format="%ci" in a given cwd -- returns the line, or null. Matches the .ps1 exactly
// (it shelled out to git with the same args; 2>$null suppressed git's own stderr). spawnSync with
// the args array (NOT a shell string) is the cross-platform equivalent; no PATH-quoting surprises.
function gitLastCommitCi(repoPath) {
  try {
    const r = spawnSync('git', ['log', '-1', '--format=%ci'], {
      cwd: repoPath, encoding: 'utf8', windowsHide: true,
    });
    if (r.error || r.status !== 0) return null; // git missing / not a repo / no commits
    const out = (r.stdout || '').trim();
    return out || null;
  } catch { return null; }
}

// Local Git evidence only: no fetch, network, credentials or file contents.
// A synced branch is not evidence of a merged PR, deployment or live acceptance.
function deliveryState(repoPath, mode) {
  const unknown = { label: 'UNKNOWN: repository/upstream unavailable', action: 'locate the checkout and verify its branch/upstream before starting more work' };
  if (mode !== 'remote' && mode !== 'local-only') {
    return { label: 'UNKNOWN: delivery mode missing or invalid', action: 'declare remote or local-only delivery mode in the project registration' };
  }
  try {
    const r = spawnSync('git', ['status', '--porcelain=v1', '--branch', '--untracked-files=normal'], {
      cwd: repoPath, encoding: 'utf8', windowsHide: true, timeout: 10000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    if (r.error || r.status !== 0) return unknown;
    const [header, ...files] = r.stdout.trimEnd().split(/\r?\n/);
    if (!header.startsWith('## ')) return unknown;
    if (mode === 'local-only') {
      const dirty = files.filter(Boolean).length;
      return { label: `LOCAL ONLY: uncommitted entries ${dirty}; upstream N/A`,
        action: dirty ? 'review uncommitted local work and its checkpoint' : null };
    }
    if (!header.includes('...') || header.includes('[gone]')) {
      return { label: 'UNKNOWN: upstream unavailable', action: 'verify the intended upstream or declare this checkout local-only' };
    }
    const ahead = Number(/ahead (\d+)/.exec(header)?.[1] || 0);
    const behind = Number(/behind (\d+)/.exec(header)?.[1] || 0);
    const dirty = files.filter(Boolean).length;
    const action = ahead && behind ? 'reconcile diverged work without resetting or overwriting either side'
      : ahead ? 'review unpublished commits and advance the approved release, or explicitly park this work'
        : behind ? 'review upstream changes before continuing local work'
          : dirty ? 'review uncommitted work and finish or explicitly park the current change'
            : null;
    return { label: `Ahead ${ahead}; behind ${behind}; uncommitted entries ${dirty}`, action };
  } catch { return unknown; }
}

// =================================================================================================
function main() {
  // Resolve OPERATOR factory root (VIBE_ROOT, else grandparent of the hooks/ anchor == <factory>).
  // defer only matters for plugin-dist copies -- a scheduled job never runs from there, but we
  // honor the helper's guard for safety.
  const { factoryRoot, defer } = resolveFactoryRoot(factoryAnchorDir);

  if (defer) {
    // Running as a plugin-distribution copy inside a factory session: the repo-local twin owns this.
    process.stdout.write('Skipped: plugin-distribution copy defers to repo-local twin.\n');
    runSummary(factoryRoot, 'skipped', 'plugin-dist copy defers to repo-local twin');
    process.exit(0);
  }

  if (!factoryRoot) {
    // No factory root resolvable -> cannot locate projects/ or write STATUS_REPORT.md. Fail loud.
    process.stderr.write('ERROR: could not resolve factory root (set VIBE_ROOT). No status report written.\n');
    // factoryRoot is null so runSummary no-ops; nothing else we can write to.
    process.exit(1);
  }

  const dryRun = process.argv.includes('--dry-run');

  const projectsDir = join(factoryRoot, 'projects');
  const outputPath = join(factoryRoot, 'STATUS_REPORT.md');
  const today = todayYmd();

  // ---- Scan projects -------------------------------------------------------------------------
  const projectRows = [];
  const forgottenIdeas = [];
  const staleFiles = [];
  const deliveryActions = [];

  for (const registration of registeredProjects(projectsDir)) {
    const { brief: briefContent, status, canonical: projName, location: projPath, mode } = registration;
    const issues = [];
    if (registration.conflict) issues.push('UNKNOWN: conflicting registration or alias');
    if (!registration.owner || registration.owner === 'UNKNOWN') issues.push('UNKNOWN: accountable owner missing');
    if (!registration.task || registration.task === 'UNKNOWN') issues.push('UNKNOWN: active task missing');
    if (!registration.checkpoint || !existsSync(registration.checkpoint)) issues.push('UNKNOWN: checkpoint missing');
    const checkpointAge = daysSinceLocalDateString(registration.checkpointDate);
    if (checkpointAge == null) issues.push('UNKNOWN: checkpoint date missing');
    else if (checkpointAge > 7) issues.push(`STALE: checkpoint ${checkpointAge} days old`);
    if (issues.length) deliveryActions.push(`**${projName}**: ${issues.join('; ')}`);

    let lastCommit = 'N/A';
    let daysSince = 'N/A';
    const identity = registration.conflict ? { ok: false, reason: 'UNKNOWN: conflicting registration or alias' }
      : repositoryIdentity(projPath);
    const delivery = identity.ok ? deliveryState(projPath, mode)
      : { label: identity.reason, action: 'correct the registered checkout before using its Git activity' };
    const blockers = delivery.label;
    if (delivery.action) deliveryActions.push(`**${projName}**: ${delivery.action}`);

    if (identity.ok) {
      const lastLog = gitLastCommitCi(projPath); // Push-Location/git log -1/Pop-Location
      if (lastLog) {
        const datePart = lastLog.substring(0, 10); // 'yyyy-MM-dd'
        const ds = daysSinceLocalDateString(datePart);
        if (ds != null) {
          daysSince = ds;
          lastCommit = datePart;
        }
      }

      // Check tracking file staleness.
      for (const tf of ['CURRENT_SPRINT.md', 'errors-fixed.json', 'golden-paths.md']) {
        const tfPath = join(projPath, tf);
        if (existsSync(tfPath)) {
          const tfDays = daysSinceMtime(tfPath);
          if (tfDays != null && tfDays > 7) {
            staleFiles.push({
              File: tf,
              Project: projName,
              LastModified: mtimeYmd(tfPath),
              DaysStale: tfDays,
            });
          }
        }
      }
    }

    // Check for forgotten DISCUSSED ideas. .ps1: status -match "DISCUSSED", then "\((\d{4}-\d{2}-\d{2})\)".
    if (/DISCUSSED/i.test(status)) {
      const dateM = /\((\d{4}-\d{2}-\d{2})\)/.exec(briefContent);
      if (dateM) {
        const daysSinceDiscussed = daysSinceLocalDateString(dateM[1]);
        if (daysSinceDiscussed != null && daysSinceDiscussed > 7) {
          forgottenIdeas.push(`- **${projName}**: discussed on ${dateM[1]}, ${daysSinceDiscussed} days ago`);
        }
      }
    }

    projectRows.push(`| ${displayCell(projName)} | ${displayCell(registration.owner)} | ${displayCell(registration.task)} | ${displayCell(registration.checkpoint)} | ${displayCell(mode)} | ${displayCell(status)} | ${lastCommit} | ${daysSince} | ${blockers} |`);
  }

  // ---- Count learning metrics ----------------------------------------------------------------
  // lessons.md was split into lessons-critical.md + reference/lessons-archive.md; count UNIQUE
  // lesson numbers across both (critical re-lists archive entries by number -> dedupe).
  const lessonNums = new Set();
  for (const lp of [
    join(factoryRoot, 'docs', 'rules-reference', 'factory', 'lessons-critical.md'),
    join(factoryRoot, 'docs', 'rules-reference', 'factory', 'reference', 'lessons-archive.md'),
  ]) {
    if (!existsSync(lp)) continue;
    const raw = readTextRaw(lp);
    if (raw == null) continue;
    for (const mm of raw.matchAll(/^(\d+)\./gm)) lessonNums.add(mm[1]);
  }
  const totalLessons = lessonNums.size;
  const approvalsLine = summaryLine(join(factoryRoot, 'PENDING_APPROVALS.md'));

  let totalErrors = 0;
  const totalPaths = 0; // declared in .ps1, never populated -- kept for parity (unused).

  // Helper to count entries in an errors-fixed.json (skips '[]'); .ps1 uses ConvertFrom-Json + .Count.
  function addErrorsFromFile(efPath) {
    const content = readTextRaw(efPath);
    if (content && content.trim() !== '[]') {
      let parsed = null;
      try { parsed = JSON.parse(content); } catch { parsed = null; } // ConvertFrom-Json failure -> skip
      if (parsed) {
        // .Count: arrays -> length; a single object -> 1 (PowerShell scalar .Count).
        if (Array.isArray(parsed)) totalErrors += parsed.length;
        else totalErrors += 1;
      }
    }
  }

  // Recurse projects/ for every errors-fixed.json (Get-ChildItem -Recurse -Filter "errors-fixed.json").
  function walkForErrorsFixed(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walkForErrorsFixed(full);
      else if (e.isFile() && e.name === 'errors-fixed.json') addErrorsFromFile(full);
    }
  }
  if (existsSync(projectsDir)) walkForErrorsFixed(projectsDir);

  // Scan active project directories under %USERPROFILE%\Projects (top-level only, like the .ps1).
  const userProjectDir = join(homedir(), 'Projects');
  if (existsSync(userProjectDir)) {
    for (const proj of listDirs(userProjectDir)) {
      const efPath = join(proj.fullPath, 'errors-fixed.json');
      if (existsSync(efPath)) addErrorsFromFile(efPath);
    }
  }

  // ---- Generate suggestions ------------------------------------------------------------------
  const suggestions = [...deliveryActions];
  if (forgottenIdeas.length > 0) {
    suggestions.push('Review forgotten ideas below -- decide: build, park, or delete');
  }
  if (staleFiles.length > 0) {
    suggestions.push('Update stale tracking files (see table below)');
  }
  if (totalErrors === 0) {
    suggestions.push('No errors logged anywhere -- are bugs being tracked? Check errors-fixed.json discipline');
  }

  // ---- Build stale files section -------------------------------------------------------------
  let staleSection = 'All tracking files are current.';
  if (staleFiles.length > 0) {
    const staleRows = staleFiles.map(
      (s) => `| ${s.File} | ${s.Project} | ${s.LastModified} | ${s.DaysStale} |`,
    );
    staleSection = `| File | Project | Last Modified | Days Stale |\n|------|---------|---------------|-----------|\n${staleRows.join('\n')}`;
  }

  // ---- Build suggestions section -------------------------------------------------------------
  let suggestSection = 'No local Git or tracking alerts detected. Deployment and live acceptance were not checked.';
  if (suggestions.length > 0) {
    suggestSection = suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n');
  }

  // ---- Build forgotten ideas section ---------------------------------------------------------
  let forgottenSection = 'None -- all ideas are being actioned.';
  if (forgottenIdeas.length > 0) {
    forgottenSection = forgottenIdeas.join('\n');
  }

  // ---- Write report (byte-faithful to the .ps1 here-string; em-dash U+2014 in the title) ------
  const report = `# VibePromptRig Status Report — ${today}
Generated automatically at ${nowHHmm()}. Review and act on suggestions.

**${approvalsLine}** (see PENDING_APPROVALS.md)

## Project Health
Git counts compare with the locally recorded upstream; remote freshness is unchecked because no server check or fetch is performed. Status is declared in BRIEF.md. Deployment and live acceptance were not checked. Only registered project checkouts are scanned, not every worktree.

| Project | Owner | Active Task | Checkpoint | Delivery Mode | Declared Status | Last Commit | Days Since Activity | Local Git Delivery State |
|---------|-------|-------------|------------|---------------|-----------------|-------------|--------------------:|--------------------------|
${projectRows.join('\n')}

## Forgotten Ideas (DISCUSSED > 7 days)
${forgottenSection}

## Stale Tracking Files
${staleSection}

## Learning Velocity
- Total lessons (lessons-critical.md + reference/lessons-archive.md, unique): ${totalLessons}
- errors-fixed.json entries across all projects: ${totalErrors}

## Suggested Actions
${suggestSection}
`;

  if (dryRun) {
    // --dry-run: validate inputs + print the planned write WITHOUT touching STATUS_REPORT.md.
    process.stdout.write(`[dry-run] Would write status report (${report.length} chars, UTF-8 no BOM) to: ${outputPath}\n`);
    process.stdout.write(`[dry-run] Projects scanned: ${projectRows.length} | stale files: ${staleFiles.length} | forgotten ideas: ${forgottenIdeas.length} | errors logged: ${totalErrors}\n`);
    runSummary(factoryRoot, 'skipped', `dry-run; would write ${projectRows.length} project rows`);
    process.exit(0);
  }

  // writeFileSync utf8 == UTF-8 with NO BOM (Node default). This is the rule-required encoding and
  // also fixes the PS 5.1 Set-Content ANSI default -- a deliberate correctness tightening for the
  // em-dash in the title (noted in the port).
  try {
    writeFileSync(outputPath, report, { encoding: 'utf8' });
  } catch (err) {
    process.stderr.write(`ERROR: failed to write status report to ${outputPath}: ${err && err.message ? err.message : err}\n`);
    runSummary(factoryRoot, 'fail', `write failed: ${err && err.code ? err.code : 'unknown'}`);
    process.exit(1);
  }

  // Match the .ps1's user-visible stdout line (lands in scheduler logs the operator reads).
  process.stdout.write(`Status report generated: ${outputPath}\n`);
  runSummary(factoryRoot, 'ok', `${projectRows.length} projects, ${staleFiles.length} stale, ${forgottenIdeas.length} forgotten`);
  process.exit(0);
}

main();
