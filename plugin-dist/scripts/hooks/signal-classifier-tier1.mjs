#!/usr/bin/env node
// signal-classifier-tier1.mjs
//
// VibePromptRig v4.3.5 Tier-1 passive-listening signal classifier -- Node twin of
// signal-classifier-tier1.ps1 (cross-platform port P2, T2). Fires on every UserPromptSubmit.
// FAIL-OPEN: never throws, never exits non-zero -- a crash here would block every prompt.
//
// Behavior parity with the .ps1:
//   - BOM-tolerant stdin -> { prompt, session_id }
//   - load <factoryRoot>/.claude/signal-taxonomy.json
//   - per-signal tier1_patterns (case-insensitive); negative_patterns suppress
//   - CRITICAL signals honor meta_context_exclusions (unless require_incident_context===false)
//   - SECURITY requires a real token-shape OR an incident phrase
//   - strength = 3 if any strength_marker matches else 1
//   - no signals -> finish with NO log row
//   - CRITICAL alert blocks (SECURITY/REPEAT/RULE_VIOLATION) printed BYTE-FAITHFULLY
//   - PII-scrub the <=200-char excerpt (secret patterns -> discard; else redact)
//   - append {ts,session_id,project,signals,strength,needs_tier2,secret_in_prompt,prompt_excerpt}
//     to <cwd>/.claude/signal-log.jsonl
//   - probabilistic 90-day TTL prune (1/50 runs)
//   - HEARTBEAT: exactly one row per invocation via finishHook (defer => silent exit 0)
//
// Dependency-free (Node stdlib only), Node >= 18, ESM.

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import {
  readStdin,
  parseJsonSafe,
  appendJsonl,
  utcStamp,
  resolveFactoryRoot,
  finishHook,
  projectWritesAllowed,
} from './hook-lib.mjs';

const HOOK_NAME = 'signal-classifier-tier1';
const MAX_EXCERPT_LEN = 200;
const TTL_DAYS = 90;
const TTL_CLEANUP_RATE = 50; // prune on 1/50 runs to avoid overhead

const here = dirname(fileURLToPath(import.meta.url));

// ---- Heartbeat + double-fire / plugin-copy guard ----------------------------
// resolveFactoryRoot mirrors the .ps1 plugin-dist / plugins-cache defer logic.
// defer=true => a plugin DISTRIBUTION copy running inside a factory session;
// no-op silently so the repo-local copy does the work (and writes the heartbeat).
const { factoryRoot, defer } = resolveFactoryRoot(here);
if (defer) process.exit(0);
// The signal log (prompt excerpts) lives in the project; an installed plugin copy needs consent.
if (!projectWritesAllowed(here, process.cwd())) finishHook(factoryRoot, HOOK_NAME, 0);

// From here on, EVERY exit routes through finishHook(...,0) so exactly one heartbeat
// row is written per invocation -- including early fail-open bails.
function done() {
  finishHook(factoryRoot, HOOK_NAME, 0);
}

// ---- Compile a taxonomy regex case-insensitively (load-bearing parity, port rule 5) ----
// PowerShell -match / -notmatch / -replace are case-insensitive by default AND use .NET regex,
// which accepts inline flag groups like `(?i)` / `(?m)` / `(?s)` (the taxonomy patterns all begin
// with `(?i)`). JavaScript RegExp does NOT support inline `(?flags)` groups -- `new RegExp("(?i)x")`
// THROWS "Invalid group". So we:
//   1. strip leading/embedded inline flag groups `(?<flags>)` (no `:` -> a flag group, not a
//      non-capturing group), translating i/m/s into real JS flags;
//   2. always force 'i' (PS case-insensitive default), and 'm'/'s' when the inline group asked.
// Returns null on a genuinely bad pattern so one malformed regex can never crash the classifier.
function ci(pattern) {
  let src = String(pattern);
  let m = false;
  let s = false;
  // Strip inline flag groups: (?i) (?im) (?is) (?ims) etc. -- letters only, no ':' (that would be a
  // non-capturing/scoped group we must preserve). Collect m/s; i is forced anyway.
  src = src.replace(/\(\?([a-zA-Z]+)\)/g, (whole, flags) => {
    // Only treat as an inline flag group if every char is a known regex flag letter.
    if (/^[imsxu]+$/.test(flags)) {
      if (flags.includes('m')) m = true;
      if (flags.includes('s')) s = true;
      return ''; // remove the inline group; flags are applied on the JS RegExp instead
    }
    return whole; // not a flag group (shouldn't happen) -- leave untouched
  });
  let flags = 'i';
  if (m) flags += 'm';
  if (s) flags += 's';
  try {
    return new RegExp(src, flags);
  } catch {
    // Fall back to the raw source with just 'i' in case stripping changed something unexpectedly.
    try {
      return new RegExp(String(pattern).replace(/\(\?i\)/g, ''), 'i');
    } catch {
      return null;
    }
  }
}

// Test a string against a pattern string, case-insensitively. Bad regex => no match (the
// .ps1 `try { -match } catch { continue }` semantics: a throwing pattern is skipped).
function matches(text, pattern) {
  const re = ci(pattern);
  if (!re) return false;
  try {
    return re.test(text);
  } catch {
    return false;
  }
}

// ---- PII scrubber (port of Invoke-PIIScrub) ---------------------------------
// Returns null when a raw secret is present (caller discards the excerpt), else the
// redacted text. Secret patterns checked first (highest priority).
function invokePIIScrub(text) {
  const secretPatterns = [
    'sbp_[a-zA-Z0-9]{10,}',
    'sk-ant-[a-zA-Z0-9\\-_]{20,}',
    'sk-proj-[a-zA-Z0-9\\-_]{20,}',
    'AKIA[A-Z0-9]{16}',
    'eyJhbGci[a-zA-Z0-9\\-_.]{20,}',
    'gh[pousr]_[a-zA-Z0-9]{36,}',
    'xoxb-[a-zA-Z0-9\\-]{20,}',
    'xoxp-[a-zA-Z0-9\\-]{20,}',
  ];
  for (const sp of secretPatterns) {
    if (matches(text, sp)) return null; // signal caller to discard
  }

  // Redact PII patterns (case-insensitive + global, matching PS -replace which replaces all).
  let out = text;
  out = out.replace(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/gi, '[EMAIL]');
  out = out.replace(/\b(\+1[-.\s]?)?(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})\b/gi, '[PHONE]');
  out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/gi, '[SSN]');
  out = out.replace(/\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/gi, '[CC]');
  out = out.replace(/(password|passwd|secret|token)\s*[:=]\s*\S+/gi, '$1=[REDACTED]');

  return out;
}

try {
  // ---- Read stdin -----------------------------------------------------------
  const stdinRaw = readStdin();
  if (!stdinRaw || stdinRaw.trim().length === 0) done();

  const hookInput = parseJsonSafe(stdinRaw);
  if (!hookInput) done();

  const prompt = hookInput.prompt;
  const sessionId = hookInput.session_id
    ? hookInput.session_id
    : 'sess-' + Math.random().toString(16).slice(2, 10).padEnd(8, '0').slice(0, 8);

  if (!prompt || String(prompt).trim().length === 0) done();
  const promptStr = String(prompt);

  // ---- Load taxonomy from <factoryRoot>/.claude/signal-taxonomy.json ---------
  if (!factoryRoot) done(); // no ledger root => nothing to classify against
  const taxonomyPath = join(factoryRoot, '.claude', 'signal-taxonomy.json');
  if (!existsSync(taxonomyPath)) done();

  let taxonomy = null;
  try {
    taxonomy = parseJsonSafe(readFileSync(taxonomyPath, 'utf8'));
  } catch {
    taxonomy = null;
  }
  if (!taxonomy || !Array.isArray(taxonomy.signals)) done();

  // ---- Project ID -----------------------------------------------------------
  const cwd = process.cwd();
  let projectId = basename(cwd);
  // PS used -ieq (case-insensitive) against FactoryRoot.
  if (cwd.toLowerCase() === String(factoryRoot).toLowerCase()) projectId = 'factory';

  // ---- Meta-context exclusion (CRITICAL signals only) -----------------------
  let isMetaContext = false;
  if (taxonomy.meta_context_exclusions) {
    isMetaContext = matches(promptStr, taxonomy.meta_context_exclusions);
  }

  // ---- SECURITY hardening helpers (exact ports) -----------------------------
  const hasRealTokenShape =
    matches(promptStr, 'sbp_[a-zA-Z0-9]{10,}') ||
    matches(promptStr, 'sk-ant-[a-zA-Z0-9\\-_]{20,}') ||
    matches(promptStr, 'sk-proj-[a-zA-Z0-9\\-_]{20,}') ||
    matches(promptStr, 'AKIA[A-Z0-9]{16}') ||
    matches(promptStr, 'eyJhbGci[a-zA-Z0-9\\-_.]{20,}') ||
    matches(promptStr, 'gh[pousr]_[a-zA-Z0-9]{36,}');
  const hasIncidentPhrase = matches(
    promptStr,
    '\\b(exposed|leaked|leaking|breach|compromised|in the (transcript|log|output|repo|commit)|just (committed|pushed|pasted)|accidentally (committed|pushed|pasted))\\b'
  );

  // ---- Tier-1 classification ------------------------------------------------
  const matchedSignals = []; // { type, priority, strength }
  const criticalFired = []; // type strings

  for (const signal of taxonomy.signals) {
    let tier1Hit = false;
    const tier1Patterns = Array.isArray(signal.tier1_patterns) ? signal.tier1_patterns : [];
    for (const pattern of tier1Patterns) {
      if (matches(promptStr, pattern)) {
        tier1Hit = true;
        break;
      }
    }
    if (!tier1Hit) continue;

    // Negative-pattern exclusion: any negative match suppresses this signal.
    let negHit = false;
    const negativePatterns = Array.isArray(signal.negative_patterns) ? signal.negative_patterns : null;
    if (negativePatterns) {
      for (const neg of negativePatterns) {
        if (matches(promptStr, neg)) {
          negHit = true;
          break;
        }
      }
    }
    if (negHit) continue;

    // Meta-context suppression for CRITICAL signals (unless opted out).
    if (isMetaContext && signal.priority === 'CRITICAL') {
      let requiresIncident = true;
      if (Object.prototype.hasOwnProperty.call(signal, 'require_incident_context')) {
        requiresIncident = Boolean(signal.require_incident_context);
      }
      if (requiresIncident) continue;
    }

    // SECURITY hardening: require actual token-shaped string OR incident phrasing.
    if (signal.type === 'SECURITY') {
      if (!(hasRealTokenShape || hasIncidentPhrase)) continue;
    }

    // Strength scoring.
    let strength = 1;
    const strengthMarkers = Array.isArray(signal.strength_markers) ? signal.strength_markers : [];
    for (const marker of strengthMarkers) {
      if (matches(promptStr, marker)) {
        strength = 3;
        break;
      }
    }

    matchedSignals.push({ type: signal.type, priority: signal.priority, strength });
    if (signal.priority === 'CRITICAL') criticalFired.push(signal.type);
  }

  // ---- Nothing matched: finish silently (no log entry) ----------------------
  if (matchedSignals.length === 0) done();

  // ---- Print real-time alerts for CRITICAL signals (byte-faithful) ----------
  const out = [];
  for (const critType of criticalFired) {
    if (critType === 'SECURITY') {
      out.push('');
      out.push('[SIGNAL:SECURITY] Possible secret or credential exposure detected in this prompt.');
      out.push('  Action: Review prompt before proceeding. Check secrets-handling.md SS9 incident response.');
      out.push('  If a token value appeared: rotate immediately per SS3.1.');
    } else if (critType === 'REPEAT') {
      out.push('');
      out.push('[SIGNAL:REPEAT] This pattern has been flagged before. Check signal-log.jsonl for prior occurrences.');
      out.push('  High-priority: if a prior lesson covers this, promote it to a factory rule.');
    } else if (critType === 'RULE_VIOLATION') {
      out.push('');
      out.push('[SIGNAL:RULE_VIOLATION] Possible VibePromptRig rule violation detected.');
      out.push('  Action: identify which rule, log to PENDING_APPROVALS.md for rule-strengthening review.');
    }
  }
  if (out.length > 0) {
    try {
      process.stdout.write(out.join('\n') + '\n');
    } catch {
      /* never block a hook */
    }
  }

  // ---- Build log entry ------------------------------------------------------
  const signalTypes = matchedSignals.map((s) => s.type);
  const totalStrength = matchedSignals.reduce((acc, s) => acc + s.strength, 0);

  // tier2_trigger like ">=2 signals match in single prompt" -> int 2.
  let tier2Threshold = 2;
  if (typeof taxonomy.tier2_trigger === 'string') {
    const parsed = parseInt(taxonomy.tier2_trigger.replace('>=', '').trim(), 10);
    if (Number.isFinite(parsed)) tier2Threshold = parsed;
  }
  const needsTier2 = matchedSignals.length >= tier2Threshold;

  // Scrub excerpt -- null return => a raw secret was in the prompt.
  const rawExcerpt = promptStr.substring(0, Math.min(promptStr.length, MAX_EXCERPT_LEN));
  const scrubbedExcerpt = invokePIIScrub(rawExcerpt);
  const secretInPrompt = scrubbedExcerpt === null;

  const logEntry = {
    ts: utcStamp(),
    session_id: sessionId,
    project: projectId,
    signals: signalTypes,
    strength: totalStrength,
    needs_tier2: needsTier2,
    secret_in_prompt: secretInPrompt,
    prompt_excerpt: secretInPrompt ? '[DISCARDED: secret detected -- not stored]' : scrubbedExcerpt,
  };

  // ---- Write to <cwd>/.claude/signal-log.jsonl ------------------------------
  const logDir = join(cwd, '.claude');
  const logPath = join(logDir, 'signal-log.jsonl');

  if (!existsSync(logDir)) {
    try {
      mkdirSync(logDir, { recursive: true });
    } catch {
      done(); // can't create dir -> fail-open
    }
  }

  appendJsonl(logPath, logEntry);

  // ---- TTL cleanup (probabilistic -- 1/50 runs) -----------------------------
  if (Math.floor(Math.random() * TTL_CLEANUP_RATE) === 0) {
    try {
      if (existsSync(logPath)) {
        const cutoffDate = new Date(Date.now() - TTL_DAYS * 24 * 60 * 60 * 1000);
        const cutoff = cutoffDate.toISOString().slice(0, 10); // yyyy-MM-dd
        const raw = readFileSync(logPath, 'utf8');
        const lines = raw.split(/\r?\n/);
        const tsRe = /"ts"\s*:\s*"(\d{4}-\d{2}-\d{2})/;
        const kept = lines.filter((line) => {
          const m = tsRe.exec(line);
          return m && m[1] >= cutoff;
        });
        if (kept.length > 0) {
          writeFileSync(logPath, kept.join('\n') + '\n');
        }
      }
    } catch {
      // TTL failure is non-fatal
    }
  }

  done();
} catch {
  // Absolute fail-open backstop: never throw, never block, one heartbeat row.
  try {
    finishHook(factoryRoot, HOOK_NAME, 0);
  } catch {
    process.exit(0);
  }
}
