#!/usr/bin/env node
// session-budget-tracker.mjs -- Node twin of session-budget-tracker.ps1 (cross-platform port P2, T2).
//
// VibePromptRig session token-budget tracker. Reads the transcript JSONL, sums NEW tokens (uncached
// input + cache-creation + output) from assistant turns -- EXCLUDING cache-read re-reads, which
// repeat the same cached context every turn and would otherwise balloon a normal session's total to
// millions -- compares against the active profile's session_budget_tokens, and warns the user (via
// stdout) when budget thresholds are crossed. Fires on UserPromptSubmit (incremental warning) AND
// Stop (session summary). Read-only on transcript.
//
// Port contract (P2, T2): dependency-free (Node stdlib), Node>=18, ESM. FAIL-OPEN -- never throws,
// never exits non-zero (a crash on every prompt/stop would block the user). Exactly ONE heartbeat row
// per invocation via finishHook (or zero on plugin-copy deferral). Profile + metrics paths resolve
// from the OPERATOR factoryRoot (resolveFactoryRoot), NOT the script dir. User-visible stdout strings
// are reproduced BYTE-FOR-BYTE (operator + Claude read them every turn).
//
// Faithful to the .ps1:
//   - empty/unparseable stdin -> exit 0 (no work), still heartbeat.
//   - profile resolution: <cwd>/.forge/profile.json > <factoryRoot>/.forge/default-profile.json > null.
//   - Resolve-BudgetField: inline value (strict !=null, so a DELIBERATE 0 is honored) > named preset's
//     value (only when profile is set and != "custom") > fallback (session 50000, monthly 500000).
//   - transcript token sum: input_tokens + cache_creation_input_tokens count toward budget;
//     cache_read_input_tokens tracked separately (cost only, NOT budget). tool_use blocks counted.
//   - monthly MTD: last 8000 lines of factory_metrics.jsonl, sum session_summary.tokens_total +
//     ai_call tokens/cost for the current UTC month (cost_cents guard: numeric, finite, >=0).
//   - UserPromptSubmit: emit the budget notices byte-for-byte. Stop: append the session_summary row.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { readStdin, parseJsonSafe, appendJsonl, utcStamp, resolveFactoryRoot, finishHook } from './hook-lib.mjs';

const HOOK_NAME = 'session-budget-tracker';
const scriptDir = dirname(fileURLToPath(import.meta.url));

// HEARTBEAT guard: a plugin-dist copy running inside a factory session defers to the repo-local copy.
const { factoryRoot, defer } = resolveFactoryRoot(scriptDir);
if (defer) process.exit(0); // no heartbeat on deferral, per contract

// Fallback budgets when NO profile file exists -- aligned with the resolver's indie-free fallback
// (50K session / 500K monthly) so the hook and `forge profile show` never disagree.
const FALLBACK_SESSION_BUDGET = 50000;
const FALLBACK_MONTHLY_BUDGET = 500000;

// $MetricsPath is null when this hook runs from an installed plugins cache with no VIBE_ROOT (a plugin
// consumer with no factory ledger) -- skip the telemetry write rather than pollute the cache.
const metricsPath = factoryRoot ? join(factoryRoot, 'factory_metrics.jsonl') : null;
const presetsDir = factoryRoot ? join(factoryRoot, '.forge', 'profiles') : null;

// PowerShell [int] cast: round-half-to-even at the .5 boundary, truncates non-integers via rounding.
// For our inputs (transcript token integers, JSON-declared budget integers) this is a plain
// integer coercion. Mirror [int] with Math.round on a finite numeric, NaN-safe.
function toInt(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

// Read + parse a JSON file without throwing. Returns the parsed object or null (mirrors the .ps1's
// `try { Get-Content -Raw | ConvertFrom-Json } catch { continue }`).
function readJsonFile(p) {
  try {
    let s = readFileSync(p, 'utf8');
    if (s && s.charCodeAt(0) === 0xFEFF) s = s.slice(1); // BOM-tolerant, like Get-Content -Encoding UTF8
    return parseJsonSafe(s);
  } catch {
    return null;
  }
}

// ---- Read hook input ----
const raw = readStdin();
// .ps1: empty/whitespace stdin -> exit 0. (Heartbeat still fires through finishHook.)
if (!raw || raw.trim().length === 0) finishHook(factoryRoot, HOOK_NAME, 0);

const hook = parseJsonSafe(raw);
// .ps1: ConvertFrom-Json failure OR falsy payload -> exit 0.
if (!hook || typeof hook !== 'object') finishHook(factoryRoot, HOOK_NAME, 0);

try {
  let sessionId = hook.session_id != null ? String(hook.session_id) : '';
  const transcript = hook.transcript_path != null ? String(hook.transcript_path) : '';
  let event = hook.hook_event_name != null ? String(hook.hook_event_name) : '';
  if (!sessionId) sessionId = 'unknown';
  if (!event) event = 'unknown';

  // ---- Resolve active profile ----
  // Mirror Get-ActiveProfile: <cwd>/.forge/profile.json > <factoryRoot>/.forge/default-profile.json > null.
  function getActiveProfile() {
    const cwd = process.cwd();
    const candidates = [join(cwd, '.forge', 'profile.json')];
    if (factoryRoot) candidates.push(join(factoryRoot, '.forge', 'default-profile.json'));
    for (const p of candidates) {
      if (existsSync(p)) {
        const cfg = readJsonFile(p);
        if (cfg !== null) return cfg; // .ps1 returns on first parse success; parse failure -> continue
      }
    }
    return null;
  }

  // Resolve a budget field: inline value wins (strict !=null so a DELIBERATE 0 is honored -- never
  // replaced by the fallback); else the named preset's value (only when profile set and != "custom");
  // else the fallback. Coerces with [int]-equivalent toInt.
  function resolveBudgetField(cfg, field, fallback) {
    if (cfg && cfg[field] != null) return toInt(cfg[field]);
    if (cfg && cfg.profile && cfg.profile !== 'custom' && presetsDir) {
      const presetPath = join(presetsDir, `${cfg.profile}.json`);
      if (existsSync(presetPath)) {
        const preset = readJsonFile(presetPath);
        if (preset && preset[field] != null) return toInt(preset[field]);
      }
    }
    return fallback;
  }

  const activeProfile = getActiveProfile();
  const profileName = activeProfile && activeProfile.profile ? String(activeProfile.profile) : 'indie-free';
  const budgetTokens = resolveBudgetField(activeProfile, 'session_budget_tokens', FALLBACK_SESSION_BUDGET);
  const monthlyBudget = resolveBudgetField(activeProfile, 'monthly_budget_tokens', FALLBACK_MONTHLY_BUDGET);

  // ---- Sum tokens from transcript ----
  let tokensIn = 0;
  let tokensOut = 0;
  let tokensCacheRead = 0; // cache re-reads -- tracked for the cost line, EXCLUDED from the budget total
  let toolCalls = 0;
  let model = null;
  let turnCount = 0;

  if (transcript && existsSync(transcript)) {
    try {
      let content = readFileSync(transcript, 'utf8');
      if (content && content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
      // StreamReader.ReadLine() splits on CR, LF, or CRLF and drops the trailing empty. Match it.
      const lines = content.split(/\r\n|\r|\n/);
      for (const line of lines) {
        if (!line) continue; // .ps1: `if (-not $line) { continue }` -- skips empty lines
        const msg = parseJsonSafe(line);
        if (!msg || typeof msg !== 'object') continue; // ConvertFrom-Json failure -> continue

        turnCount++;

        // Anthropic transcript format: usage on assistant messages.
        let usage = null;
        if (msg.message && msg.message.usage) usage = msg.message.usage;
        else if (msg.usage) usage = msg.usage;

        if (usage) {
          if (usage.input_tokens) tokensIn += toInt(usage.input_tokens);
          if (usage.output_tokens) tokensOut += toInt(usage.output_tokens);
          if (usage.cache_creation_input_tokens) tokensIn += toInt(usage.cache_creation_input_tokens);
          // cache_read = the SAME cached context re-read every turn. NOT new consumption -> excluded
          // from the budget. Tracked separately for the (cheap, ~0.1x) cost line only.
          if (usage.cache_read_input_tokens) tokensCacheRead += toInt(usage.cache_read_input_tokens);
        }

        if (msg.message && msg.message.model && !model) {
          model = String(msg.message.model);
        } else if (msg.model && !model) {
          model = String(msg.model);
        }

        // Count tool_use blocks.
        let c = null;
        if (msg.message && msg.message.content) c = msg.message.content;
        else if (msg.content) c = msg.content;
        if (Array.isArray(c)) {
          for (const block of c) {
            if (block && block.type === 'tool_use') toolCalls++;
          }
        }
      }
    } catch {
      // Silently skip parse failures (mirrors the .ps1 try/catch around the read loop).
    }
  }

  const total = tokensIn + tokensOut;
  const pctUsed = budgetTokens > 0 ? round1((total / budgetTokens) * 100) : 0;

  // ---- Monthly token spend month-to-date (G1 -- monthly_budget_tokens guard) ----
  // Sum per-session token totals (session_summary.tokens_total) for the current UTC month -- the
  // spend THIS hook writes on Stop. ALSO read router ai_call rows in the same single pass for the A9
  // cost/tokens line. Token-budget comparison uses session_summary; ai_call cents are the router's
  // separate A9 cents-cap (already hard-stopped).
  let mtdTokens = 0;
  let mtdAiTokens = 0;
  let mtdAiCostCents = 0.0;
  if (metricsPath && existsSync(metricsPath)) {
    const nowU = new Date();
    // Month start at 00:00:00 UTC of the current UTC month.
    const monStart = Date.UTC(nowU.getUTCFullYear(), nowU.getUTCMonth(), 1, 0, 0, 0);
    // BOUNDED read (directive SS2): only the last 8000 lines are scanned, so this stays fast on EVERY
    // prompt no matter how large factory_metrics.jsonl grows. Can only under-count (under-warn), never
    // falsely block -- acceptable for a non-blocking ADVISORY.
    const METRICS_TAIL = 8000;
    let tailLines = null;
    try {
      let mc = readFileSync(metricsPath, 'utf8');
      if (mc && mc.charCodeAt(0) === 0xFEFF) mc = mc.slice(1);
      const all = mc.split(/\r\n|\r|\n/);
      // Drop a trailing empty element (file ends with a newline) so the tail count matches Get-Content -Tail.
      if (all.length > 0 && all[all.length - 1] === '') all.pop();
      tailLines = all.slice(-METRICS_TAIL);
    } catch {
      tailLines = null;
    }
    if (tailLines) {
      // PS -notmatch is CASE-INSENSITIVE -> the JS RegExp carries the 'i' flag (port rule 5).
      const eventRe = /"event":"(session_summary|ai_call)"/i;
      // B-4 FIX (2026-07-24): session_summary rows are CUMULATIVE per-session snapshots -- this hook
      // rewrites one on EVERY Stop, so a session that stops 10 times leaves 10 rows each carrying the
      // full running total. Summing every row multiplied each session by its stop count: July 2026 had
      // 706 rows across 65 distinct sessions -> a measured 10.0x inflation (reported 6,257,793,376 /
      // 312.9% vs the true 628,109,769 / 31.4%). Keep the MAX per session_id, then sum once per session.
      // ai_call rows are per-call (NOT cumulative) and are still summed directly -- do not dedupe those.
      const mtdBySession = new Map();
      let anonSeq = 0;
      for (const l of tailLines) {
        if (!l) continue;
        if (!eventRe.test(l)) continue;
        const e = parseJsonSafe(l);
        if (!e || !e.ts) continue;
        // [datetimeoffset]::Parse(...).UtcDateTime -- parse the ts and compare in UTC ms.
        const td = Date.parse(String(e.ts));
        if (Number.isNaN(td)) continue;
        if (td < monStart) continue;
        if (e.event === 'session_summary') {
          const tt = asIntOrNull(e.tokens_total);
          if (tt) {
            // A row with no session_id cannot be deduped -- give it a unique key so it still counts
            // once (under-counting is acceptable per the bounded-read contract; double-counting is not).
            const sid = e.session_id != null && String(e.session_id) !== ''
              ? String(e.session_id)
              : `(anon-${anonSeq++})`;
            const prev = mtdBySession.get(sid);
            if (prev == null || tt > prev) mtdBySession.set(sid, tt);
          }
        } else if (e.event === 'ai_call') {
          let ti = asIntOrNull(e.tokens_in);
          if (ti == null) ti = 0;
          let to = asIntOrNull(e.tokens_out);
          if (to == null) to = 0;
          mtdAiTokens += ti + to;
          if (e.cost_cents != null) {
            const cc = Number(e.cost_cents);
            if (!Number.isNaN(cc) && Number.isFinite(cc) && cc >= 0) mtdAiCostCents += cc;
          }
        }
      }
      // One contribution per session (see B-4 note above), not one per Stop-written snapshot.
      for (const v of mtdBySession.values()) mtdTokens += v;
    }
  }
  mtdAiCostCents = round2(mtdAiCostCents);
  const monthlyPct = monthlyBudget > 0 ? round1((mtdTokens / monthlyBudget) * 100) : 0;

  // ---- Cost estimate (rough, in cents -- aligns with Claude API pricing) ----
  // $3/M input + $15/M output for sonnet/opus rough avg; haiku $0.8/M, $4/M. Default to sonnet rates.
  let costPerMIn = 300; // cents per million input tokens
  let costPerMOut = 1500; // cents per million output tokens
  // PS -match is CASE-INSENSITIVE; the patterns already pin case with (?i). Carry 'i' to be safe.
  if (model && /haiku/i.test(model)) {
    costPerMIn = 80;
    costPerMOut = 400;
  }
  if (model && /opus/i.test(model)) {
    costPerMIn = 1500;
    costPerMOut = 7500;
  }
  // cache reads bill at ~0.1x the input rate; included here so the cost line stays honest even though
  // they are (correctly) EXCLUDED from the token-budget total above.
  const costCents = round2(
    (tokensIn / 1000000.0) * costPerMIn +
      (tokensOut / 1000000.0) * costPerMOut +
      (tokensCacheRead / 1000000.0) * (costPerMIn * 0.1)
  );

  // ---- Budget guard (G1): warn at 80%, LOUD at 100%+, for SESSION and MONTHLY. UserPromptSubmit only.
  // NEVER hard-blocks (a blocking UserPromptSubmit hook would stop the user mid-thought). The router's
  // assertWithinBudget hard-stop is the right place for a true STOP (automated dispatch).
  if (event === 'UserPromptSubmit') {
    const notes = [];
    if (pctUsed >= 100) {
      notes.push(`[BUDGET CEILING] This SESSION has used ${total} tokens -- ${fmtNum(pctUsed)}% of the '${profileName}' session budget (${budgetTokens}). You're past the ceiling. Options: /clear to start fresh, 'forge config set session_budget_tokens <n>' to raise it, or /mode max for a bigger budget. Nothing is blocked -- your call.`);
    } else if (pctUsed >= 80) {
      notes.push(`[BUDGET 80%] This session is at ${fmtNum(pctUsed)}% of the '${profileName}' session budget (${budgetTokens} tokens). Consider /clear, or /mode lean to burn less, if you want to keep going without hitting limits.`);
    }
    if (monthlyBudget > 0) {
      if (monthlyPct >= 100) {
        notes.push(`[MONTHLY CEILING] Month-to-date ${mtdTokens} tokens -- ${fmtNum(monthlyPct)}% of '${profileName}' monthly_budget_tokens (${monthlyBudget}). Raise with 'forge config set monthly_budget_tokens <n>', switch /mode max, or stop here. Your call -- not blocked.`);
      } else if (monthlyPct >= 80) {
        notes.push(`[MONTHLY 80%] Month-to-date at ${fmtNum(monthlyPct)}% of the '${profileName}' monthly budget (${monthlyBudget} tokens).`);
      }
    }
    if (notes.length > 0) {
      // Write-Output "" then each note: PowerShell Write-Output emits one line per call (a newline per
      // item). Reproduce with one process.stdout.write that newline-terminates each emitted line.
      let out = '\n';
      for (const n of notes) out += n + '\n';
      if (mtdAiCostCents > 0) {
        out += `              (router AI spend month-to-date: $${money2(mtdAiCostCents / 100)} over ${mtdAiTokens} ai_call tokens -- A9 provenance.)\n`;
      }
      process.stdout.write(out);
    }
  }

  // ---- Write factory_metrics.jsonl entry on Stop event ----
  // metricsPath is null when this hook runs from an installed plugins cache with no VIBE_ROOT -- skip.
  if (event === 'Stop' && metricsPath) {
    const entry = {
      ts: utcStamp(),
      event: 'session_summary',
      session_id: sessionId,
      project: basenameOf(process.cwd()),
      profile: profileName,
      model: model, // null when no assistant turn carried a model -- matches ConvertTo-Json null
      msg_count: turnCount,
      tool_calls: toolCalls,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      tokens_cache_read: tokensCacheRead,
      tokens_total: total,
      budget_tokens: budgetTokens,
      pct_used: pctUsed,
      cost_cents: costCents,
    };
    appendJsonl(metricsPath, entry); // appendJsonl never throws (fail-open)
  }
} catch {
  // Swallow everything per the fail-open contract; fall through to the single heartbeat exit.
}

finishHook(factoryRoot, HOOK_NAME, 0);

// ---- Helpers ----

// e.tokens_total -as [int] / -as [double] yield $null on non-numeric; mirror with null-on-NaN.
function asIntOrNull(x) {
  if (x == null) return null;
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

// [Math]::Round(x, 1) / (,2) use banker's rounding (round-half-to-even). At our magnitudes this only
// matters on an exact .x5 boundary; emulate it to keep the displayed/stored values identical to the .ps1.
function bankersRound(x, decimals) {
  if (!Number.isFinite(x)) return 0;
  const factor = Math.pow(10, decimals);
  const scaled = x * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let r;
  const EPS = 1e-9;
  if (Math.abs(diff - 0.5) < EPS) {
    // halfway: round to even
    r = floor % 2 === 0 ? floor : floor + 1;
  } else {
    r = Math.round(scaled);
  }
  return r / factor;
}
function round1(x) { return bankersRound(x, 1); }
function round2(x) { return bankersRound(x, 2); }

// Render a number for stdout the way PowerShell string-interpolates a [double] from [Math]::Round(_,1):
// integers print without a decimal (e.g. 100), fractional values print with their natural decimals
// (e.g. 2.7, 83.5). Number.prototype.toString already matches this (100 -> "100", 2.7 -> "2.7").
function fmtNum(n) { return String(n); }

// PowerShell '{0:N2}' -f x -> two decimals with thousands separators (e.g. 1,234.50). The cost line
// uses ($mtdAiCostCents / 100) which is small; reproduce N2 exactly (grouping + 2 decimals).
function money2(x) {
  const neg = x < 0;
  const v = Math.abs(bankersRound(x, 2));
  const fixed = v.toFixed(2); // "1234.50"
  const [intPart, decPart] = fixed.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + grouped + '.' + decPart;
}

// Split-Path -Leaf of a path. process.cwd() returns an absolute path with the OS separator; take the
// last non-empty segment across either separator (Windows '\' or POSIX '/').
function basenameOf(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/).filter((s) => s.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : String(p);
}
