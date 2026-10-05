#!/usr/bin/env node
// signal-batch-analyzer.mjs
//
// Stop-hook signal batch analyzer -- Node twin of signal-batch-analyzer.ps1
// (cross-platform port P2, T2). Runs at session end. Reads .claude/signal-log.jsonl
// from the CURRENT PROJECT (cwd), summarizes the signals fired this session, appends
// a summary section to SESSION_DEBRIEF.md, and proposes PENDING_APPROVALS.md entries
// for critical patterns (REPEAT, SECURITY, RULE_VIOLATION, 3+ REWORK, 3+ APPROVAL).
//
// No API calls. Pure signal aggregation + pattern detection. Runs AFTER
// post-session-enforcer so SESSION_DEBRIEF.md usually already exists.
//
// FAIL-OPEN: never throws, never exits non-zero. Every exit routes through finishHook
// so exactly ONE heartbeat row lands per invocation (unless this is a deferred plugin copy).
// Dependency-free (Node stdlib only), Node >= 18, ESM.

import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { resolveFactoryRoot, finishHook, projectWritesAllowed } from './hook-lib.mjs';

const HOOK_NAME = 'signal-batch-analyzer';
const here = dirname(fileURLToPath(import.meta.url));

// --- Double-fire / plugin-copy guard (mirrors hook-lib resolveFactoryRoot) -----
// When THIS copy is the plugin DISTRIBUTION copy running inside the factory session,
// defer to the repo-local copy -- exit WITHOUT a heartbeat.
const { factoryRoot, defer } = resolveFactoryRoot(here);
if (defer) process.exit(0);
if (!projectWritesAllowed(here, process.cwd())) finishHook(factoryRoot, HOOK_NAME, 0);

// Single fail-open exit path. Everything below is wrapped; on ANY error we still
// emit exactly one heartbeat and exit 0.
try {
  main();
  finishHook(factoryRoot, HOOK_NAME, 0);
} catch {
  finishHook(factoryRoot, HOOK_NAME, 0);
}

function main() {
  // ---- Config (mirrors the .ps1) ----
  const SESSION_WINDOW_HRS = 6; // look back N hours to find this session's signals
  const REWORK_THRESHOLD = 3;   // suggest /audit-gate if REWORK fires >= N times

  // ---- Resolve paths (project-relative = cwd, exactly like the .ps1) ----
  const cwd = process.cwd();
  let projectId = basename(cwd);
  // FactoryRoot equivalence test: the .ps1 uses $env:VIBE_ROOT else parent-of-scriptroot.
  // Here factoryRoot is already resolved by hook-lib; compare case-insensitively like -ieq.
  if (factoryRoot && cwd.toLowerCase() === String(factoryRoot).toLowerCase()) {
    projectId = 'factory';
  }

  const logPath = join(cwd, '.claude', 'signal-log.jsonl');
  const debriefPath = join(cwd, 'SESSION_DEBRIEF.md');
  const pendingPath = join(cwd, 'PENDING_APPROVALS.md');

  // ---- Nothing to analyze ----
  if (!existsSync(logPath)) return;

  // ---- Read signals from this session window ----
  // .ps1: $cutoffTime = (Get-Date).AddHours(-6)  -- a LOCAL DateTime (Kind=Local).
  // Entry ts is parsed RoundtripKind (Z -> Kind=Utc). .NET DateTime comparison compares
  // raw .Ticks WITHOUT timezone normalization. We reproduce that exactly: both sides are
  // expressed as face-value wall-clock milliseconds.
  //   cutoffWallMs = local-wall-clock(now) - 6h, re-expressed as UTC-of-the-same-digits.
  //   entryWallMs  = the literal Y-M-D-H-M-S digits of the ts (matches RoundtripKind ticks
  //                  for Z timestamps; for offset timestamps it uses the written digits,
  //                  matching .NET RoundtripKind's local-ticks behavior).
  const nowEpochMs = Date.now();
  const localWallNowMs = nowEpochMs - new Date(nowEpochMs).getTimezoneOffset() * 60000;
  const cutoffWallMs = localWallNowMs - SESSION_WINDOW_HRS * 3600 * 1000;

  let raw;
  try {
    raw = readFileSync(logPath, 'utf8');
  } catch {
    return; // Get-Content -ErrorAction SilentlyContinue -> treated as empty
  }
  if (raw && raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // BOM-tolerant (UTF8 read)
  if (!raw) return; // -not $allLines

  const allLines = raw.split(/\r?\n/);
  // PowerShell Get-Content returns no trailing empty element for a final newline; an
  // entirely-empty file yields $null (handled above). Our split may add a trailing ''
  // for a final newline, but the per-line blank/parse guards below drop it harmlessly.
  if (allLines.length === 0) return;

  const sessionSignals = [];
  for (const line of allLines) {
    if (!line || line.trim().length === 0) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry === null || typeof entry !== 'object') continue;
    if (!entry.ts) continue;

    const entryWallMs = parseTsWallMs(entry.ts);
    if (entryWallMs === null) continue; // unparseable ts -> skipped (.ps1 catch -> continue)
    // .ps1: if ($entryTime -ge $cutoffTime)
    if (entryWallMs >= cutoffWallMs) {
      sessionSignals.push(entry);
    }
  }

  if (sessionSignals.length === 0) return;

  // ---- Aggregate by signal type ----
  const signalCounts = new Map();
  const signalStrengths = new Map();

  for (const entry of sessionSignals) {
    if (!entry.signals) continue;
    // The .ps1 iterates `foreach ($sig in $entry.signals)`. If signals were a scalar,
    // PowerShell would iterate the single value; mirror that by coercing to an array.
    const sigs = Array.isArray(entry.signals) ? entry.signals : [entry.signals];
    for (const sig of sigs) {
      if (!signalCounts.has(sig)) {
        signalCounts.set(sig, 0);
        signalStrengths.set(sig, 0);
      }
      signalCounts.set(sig, signalCounts.get(sig) + 1);
      // [int]$entry.strength : null -> 0, numeric/numeric-string -> truncated int.
      signalStrengths.set(sig, signalStrengths.get(sig) + psInt(entry.strength));
    }
  }

  if (signalCounts.size === 0) return;

  // ---- Build signal summary section ----
  const ts = formatLocal(new Date(), 'yyyy-MM-dd HH:mm');
  let totalFired = 0;
  for (const v of signalCounts.values()) totalFired += v;

  const summaryLines = [];
  summaryLines.push('');
  summaryLines.push('---');
  summaryLines.push('');
  summaryLines.push(`## Passive-Listening Signal Summary -- ${ts}`);
  summaryLines.push('');
  summaryLines.push(`Total signal events this session: ${totalFired}`);
  summaryLines.push('');
  summaryLines.push('| Signal | Count | Total Strength | Priority |');
  summaryLines.push('|--------|-------|---------------|----------|');

  const priorityMap = {
    REPEAT: 'CRITICAL',
    SECURITY: 'CRITICAL',
    RULE_VIOLATION: 'CRITICAL',
    REWORK: 'HIGH',
    CORRECTION: 'HIGH',
    BUG: 'HIGH',
    PIVOT_STRATEGIC: 'HIGH',
    CLARIFY_NEEDED: 'MEDIUM',
    FRUSTRATION: 'MEDIUM',
    MISSING: 'MEDIUM',
    CONFUSION: 'LOW',
    APPROVAL: 'LOW',
  };

  const priorityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

  // Sort by priority then -count (CRITICAL first; within a priority, higher count first).
  // Mirrors PowerShell Sort-Object { priority }, { -count }. PowerShell Sort-Object is a
  // STABLE sort; we preserve insertion order (Map iteration order) for ties on both keys.
  const sortedSignals = [...signalCounts.keys()].map((sig, idx) => ({ sig, idx })).sort((a, b) => {
    const pa = priorityOrder[priorityMap[a.sig] ?? 'LOW'];
    const pb = priorityOrder[priorityMap[b.sig] ?? 'LOW'];
    if (pa !== pb) return pa - pb;
    const ca = -signalCounts.get(a.sig);
    const cb = -signalCounts.get(b.sig);
    if (ca !== cb) return ca - cb;
    return a.idx - b.idx; // stable tie-break
  }).map((x) => x.sig);

  for (const sig of sortedSignals) {
    const count = signalCounts.get(sig);
    const strength = signalStrengths.get(sig);
    // NOTE: the summary-table priority falls back to 'MEDIUM' for unknown signals,
    // while the SORT falls back to 'LOW'. This asymmetry is in the .ps1 and is preserved.
    const priority = Object.prototype.hasOwnProperty.call(priorityMap, sig) ? priorityMap[sig] : 'MEDIUM';
    summaryLines.push(`| ${sig} | ${count} | ${strength} | ${priority} |`);
  }

  // ---- Generate PENDING_APPROVALS proposals ----
  let proposals = [];
  const todayDate = formatLocal(new Date(), 'yyyy-MM-dd');

  const cnt = (k) => (signalCounts.has(k) ? signalCounts.get(k) : 0);

  // REPEAT >= 1: rule promotion candidate
  if (signalCounts.has('REPEAT') && cnt('REPEAT') >= 1) {
    proposals.push(
      `### [SIGNAL-AUTO] REPEAT fired ${cnt('REPEAT')}x -- DRAFT rule/lesson strengthening (${todayDate})\n` +
      `- **Project:** ${projectId}  |  **Priority:** HIGH\n` +
      `- **What repeated (evidence, this session):**\n${excerptsFor(sessionSignals, 'REPEAT')}\n` +
      `- **Draft:** the operator had to repeat themselves -- a rule or lesson isn't landing. Proposed action: strengthen the rule these excerpts touch, or promote a matching lesson to a factory rule in docs/rules-reference/factory/ (plus its rules-manifest entry). The synthesizer (weekly, LLM) turns this evidence into the exact rule-file diff.\n` +
      `- **Your call:** approve the direction (synthesizer drafts the patch) / reject to dismiss. The thinking is done -- evidence + direction are above.`
    );
  }

  // SECURITY >= 1: rotation reminder -- but ONLY escalate to CRITICAL when a secret was
  // actually detected (secret_in_prompt:true). The SECURITY keyword classifier also fires
  // on trigger words ("approve", gate language) with no real leak; those must NOT escalate
  // to a CRITICAL "the project owner action required" (false-positive hardening, 2026-06-17).
  if (signalCounts.has('SECURITY') && cnt('SECURITY') >= 1) {
    const secretLeaks = sessionSignals.filter((e) => e && e.secret_in_prompt === true).length;
    if (secretLeaks > 0) {
      proposals.push(
        `### [SIGNAL-AUTO] SECURITY -- ${secretLeaks} prompt(s) with a DETECTED secret (${todayDate})\n` +
        `- **Project:** ${projectId}\n` +
        `- **Signal count:** ${cnt('SECURITY')} SECURITY events; ${secretLeaks} with secret_in_prompt:true\n` +
        `- **Action:** A secret was detected in a prompt. Rotate the affected token immediately per secrets-handling.md SS3.\n` +
        `- **File:** .claude/signal-log.jsonl\n` +
        `- **Priority:** CRITICAL -- the project owner action required`
      );
    } else {
      proposals.push(
        `### [SIGNAL-AUTO] SECURITY keyword tag fired ${cnt('SECURITY')}x -- no secret detected (${todayDate})\n` +
        `- **Project:** ${projectId}\n` +
        `- **Signal count:** ${cnt('SECURITY')} SECURITY events; 0 with secret_in_prompt:true (no leak detected)\n` +
        `- **Action:** Likely a false positive -- the SECURITY keyword classifier matched trigger words (e.g. "approve", gate language), not an actual secret. Review only; no rotation needed.\n` +
        `- **File:** .claude/signal-log.jsonl\n` +
        `- **Priority:** LOW`
      );
    }
  }

  // RULE_VIOLATION >= 1: rule audit
  if (signalCounts.has('RULE_VIOLATION') && cnt('RULE_VIOLATION') >= 1) {
    proposals.push(
      `### [SIGNAL-AUTO] RULE_VIOLATION fired ${cnt('RULE_VIOLATION')}x -- DRAFT rule audit (${todayDate})\n` +
      `- **Project:** ${projectId}  |  **Priority:** CRITICAL\n` +
      `- **What was flagged (evidence):**\n${excerptsFor(sessionSignals, 'RULE_VIOLATION')}\n` +
      `- **Draft:** a rule was cited as violated. Proposed action: strengthen that rule's trigger/enforcement per self-reflection.md Rule Gap Scanner. The synthesizer drafts the exact diff from these excerpts.\n` +
      `- **Your call:** approve the direction (synthesizer drafts the patch) / reject.`
    );
  }

  // REWORK >= threshold: architectural review
  if (signalCounts.has('REWORK') && cnt('REWORK') >= REWORK_THRESHOLD) {
    proposals.push(
      `### [SIGNAL-AUTO] REWORK fired ${cnt('REWORK')}x -- architectural review suggested (${todayDate})\n` +
      `- **Project:** ${projectId}  |  **Priority:** HIGH\n` +
      `- **What was reworked (evidence):**\n${excerptsFor(sessionSignals, 'REWORK')}\n` +
      `- **Draft:** ${cnt('REWORK')} rework signals (threshold ${REWORK_THRESHOLD}) -- likely under-specified requirements. Proposed action: run /audit-gate or a Hostile Architect pass before the next build on this surface.\n` +
      `- **Your call:** approve (schedule the review) / reject.`
    );
  }

  // APPROVAL >= 3: golden path candidate
  if (signalCounts.has('APPROVAL') && cnt('APPROVAL') >= 3) {
    proposals.push(
      `### [SIGNAL-AUTO] APPROVAL fired ${cnt('APPROVAL')}x -- ready-to-paste golden-path entry (${todayDate})\n` +
      `- **Project:** ${projectId}  |  **Priority:** LOW\n` +
      `- **What earned approval (evidence):**\n${excerptsFor(sessionSignals, 'APPROVAL')}\n` +
      `- **Draft (paste into golden-paths.md if the pattern is real):**\n` +
      '  ```\n' +
      `  ### GP-XXX: ${excerptFirst(sessionSignals, 'APPROVAL')} (${todayDate})\n` +
      `  **Pattern:** <the approach that repeatedly earned approval, one line>.\n` +
      `  **Evidence:** ${projectId} session ${todayDate} -- ${cnt('APPROVAL')} approvals.\n` +
      `  **Reuse when:** <the situation this applies to>.\n` +
      '  ```\n' +
      `- **Your call:** paste it (approve) or reject.`
    );
  }

  // ---- Append to SESSION_DEBRIEF.md ----
  const summaryText = summaryLines.join('\n');
  if (existsSync(debriefPath)) {
    // Add-Content appends with a trailing newline. Set-Content (below) also writes a
    // trailing newline. We append "\n" to both to match PowerShell's terminating newline.
    try {
      appendFileSync(debriefPath, summaryText + '\n');
    } catch { /* swallow, like the .ps1 try/catch {} */ }
  } else {
    // Create minimal debrief if enforcer didn't run.
    try {
      writeFileSync(debriefPath, summaryText + '\n');
    } catch { /* swallow */ }
  }

  // ---- Dedup: drop proposal classes already open in PENDING_APPROVALS ----
  // Class key = the proposal's first line truncated at the fire-count, so one open entry
  // per class is signal enough (self-improvement wiring audit R2, 2026-06-04).
  if (proposals.length > 0 && existsSync(pendingPath)) {
    try {
      const pendingRaw = readFileSync(pendingPath, 'utf8');
      const pendingClean = pendingRaw && pendingRaw.charCodeAt(0) === 0xfeff ? pendingRaw.slice(1) : pendingRaw;
      if (pendingClean) {
        const kept = [];
        for (const p of proposals) {
          const firstLine = p.split(/\r?\n/)[0];
          // .ps1: $firstLine -replace '(fired) \d+x.*$', '$1'  (CASE-INSENSITIVE default).
          // 'g' is harmless (single occurrence); 'i' preserves PowerShell case-insensitivity.
          const classKey = firstLine.replace(/(fired) \d+x.*$/i, '$1');
          // .ps1: if ($pendingRaw -notmatch [regex]::Escape($classKey)) { keep }
          // -notmatch is CASE-INSENSITIVE; reproduce with the 'i' flag on the escaped pattern.
          const escaped = escapeRegExp(classKey);
          if (!new RegExp(escaped, 'i').test(pendingClean)) kept.push(p);
        }
        proposals = kept;
      }
    } catch { /* swallow, like the .ps1 try/catch {} */ }
  }

  // ---- Append proposals to PENDING_APPROVALS.md ----
  if (proposals.length > 0) {
    try {
      // The .ps1 here-string for $header begins with a newline (the line after @") and the
      // content is "\n\n---\n\n## Signal-Auto Proposals (...)\n\n". Add-Content then appends
      // a terminating newline, making the effective header end with "\n\n\n". Reproduce the
      // header body exactly, then add the Add-Content terminating "\n".
      const header =
        '\n' +
        '\n' +
        '---\n' +
        '\n' +
        `## Signal-Auto Proposals (${todayDate}, project: ${projectId})\n` +
        '\n';
      if (existsSync(pendingPath)) {
        appendFileSync(pendingPath, header + '\n');
      } else {
        // Set-Content -Value ("# PENDING_APPROVALS`n" + $header) -> one terminating newline.
        writeFileSync(pendingPath, '# PENDING_APPROVALS\n' + header + '\n');
      }
      for (const p of proposals) {
        // Add-Content -Value ($p + "`n") -> proposal + literal "\n" + Add-Content's "\n".
        appendFileSync(pendingPath, p + '\n' + '\n');
      }
    } catch { /* swallow */ }
  }

  // Stop-hook stdout stays empty. Human-facing signal proposals remain in
  // PENDING_APPROVALS.md and malformed input still fails open via the outer guard.
}

// --- helpers ---------------------------------------------------------------

// Parse a timestamp string to face-value wall-clock milliseconds (UTC-of-the-written-digits).
// Matches .NET DateTime.Parse(..., RoundtripKind).Ticks for Z timestamps and uses the written
// digits for offset/naive timestamps. Returns null on a shape it can't parse.
function parseTsWallMs(ts) {
  if (typeof ts !== 'string') {
    // PowerShell would .Parse() a non-string by coercion; our data is always strings.
    ts = String(ts);
  }
  // Capture Y-M-D[ T]H:M:S[.fraction]; ignore any trailing zone designator for the tick basis.
  const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  if (!m) {
    // Fall back to JS Date.parse so we degrade rather than over-drop; null if truly invalid.
    const t = Date.parse(ts);
    return Number.isNaN(t) ? null : t;
  }
  const year = +m[1];
  const month = +m[2] - 1;
  const day = +m[3];
  const hour = +m[4];
  const min = +m[5];
  const sec = +m[6];
  let ms = 0;
  if (m[7]) ms = Math.round(parseFloat('0.' + m[7]) * 1000);
  const v = Date.UTC(year, month, day, hour, min, sec, ms);
  return Number.isNaN(v) ? null : v;
}

// [int]$x semantics: null/empty -> 0; numeric (or numeric string) -> truncated toward zero.
function psInt(x) {
  if (x === null || x === undefined || x === '') return 0;
  const n = typeof x === 'number' ? x : parseFloat(x);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}

// Local-time formatter for the two .ps1 Get-Date -Format strings used here.
function formatLocal(d, fmt) {
  const p2 = (n) => String(n).padStart(2, '0');
  const Y = d.getFullYear();
  const Mo = p2(d.getMonth() + 1);
  const D = p2(d.getDate());
  const H = p2(d.getHours());
  const Mi = p2(d.getMinutes());
  if (fmt === 'yyyy-MM-dd HH:mm') return `${Y}-${Mo}-${D} ${H}:${Mi}`;
  // 'yyyy-MM-dd'
  return `${Y}-${Mo}-${D}`;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Evidence helpers (audit 3.2): pull real prompt_excerpts for a fired signal so proposals carry
// the WHY, not a "go look it up" to-do. Never surfaces a secret-flagged excerpt.
function excerptsFor(sessionSignals, sigType, max = 3) {
  const out = [];
  for (const e of sessionSignals) {
    if (!e || e.secret_in_prompt === true || !e.prompt_excerpt) continue;
    const sigs = Array.isArray(e.signals) ? e.signals : [e.signals];
    if (!sigs.includes(sigType)) continue;
    out.push('  > "' + String(e.prompt_excerpt).replace(/\s+/g, ' ').trim().slice(0, 160) + '"');
    if (out.length >= max) break;
  }
  return out.length ? out.join('\n') : '  > (no prompt excerpts captured this session)';
}

function excerptFirst(sessionSignals, sigType) {
  for (const e of sessionSignals) {
    if (!e || e.secret_in_prompt === true || !e.prompt_excerpt) continue;
    const sigs = Array.isArray(e.signals) ? e.signals : [e.signals];
    if (sigs.includes(sigType)) return String(e.prompt_excerpt).replace(/\s+/g, ' ').trim().slice(0, 48);
  }
  return '<short title>';
}
