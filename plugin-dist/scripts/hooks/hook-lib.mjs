// hook-lib.mjs -- shared helpers for the capture-layer hook twins (cross-platform port P2, T2).
// Every capture hook (signal-classifier, signal-batch-analyzer, session-budget-tracker,
// post-session-enforcer, log-instructions-loaded) reads BOM-tolerant stdin, NEVER throws, NEVER
// blocks (fail-open), and emits a per-invocation heartbeat. Dependency-free (Node stdlib), Node>=18.

import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import process from 'node:process';

// BOM-tolerant, never-throws synchronous stdin read. Returns '' on empty / TTY / error.
export function readStdin() {
  try {
    let s = readFileSync(0, 'utf8');
    if (s && s.charCodeAt(0) === 0xFEFF) s = s.slice(1); // strip a UTF-8 BOM
    return s || '';
  } catch { return ''; }
}

// Parse JSON without throwing. null on failure.
export function parseJsonSafe(s) { try { return JSON.parse(s); } catch { return null; } }

// Genuine UTC stamp matching the .ps1 'yyyy-MM-ddTHH:mm:ssZ' shape (the .ps1's trailing Z was a
// literal on LOCAL time; this is real UTC -- a deliberate correctness tightening, noted in the port).
export function utcStamp() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }

// Append one compact JSON line to a JSONL file. Never throws.
export function appendJsonl(path, obj) {
  try { appendFileSync(path, JSON.stringify(obj) + '\n'); } catch { /* never block a hook */ }
}

// Per-hook heartbeat -> <factoryRoot>/factory_metrics.jsonl. {ts,event:hook_invoked,os,hook,exit_code}.
export function emitHeartbeat(factoryRoot, hookName, exitCode) {
  if (!factoryRoot) return;
  appendJsonl(join(factoryRoot, 'factory_metrics.jsonl'), {
    ts: utcStamp(), event: 'hook_invoked', os: process.platform, hook: hookName, exit_code: exitCode,
  });
}

export function isPluginCopy(scriptDir) {
  return /[\\/]plugin-dist([\\/]|$)/.test(scriptDir) || /[\\/]plugins[\\/]cache[\\/]/.test(scriptDir);
}

// A VibePromptRig factory checkout: the only place an operator ledger (factory_metrics.jsonl) lives.
// The manifest must carry the VibePromptRig plugin identity; another plugin's checkout never qualifies.
function isFactoryCheckout(dir) {
  if (!dir || !existsSync(join(dir, 'scripts', 'hooks', 'hook-lib.mjs'))) return false;
  try {
    return JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'))?.name === 'vibepromptrig';
  } catch { return false; }
}

// Two separate authorizations govern what capture hooks may write.
//
// Project consent -- files inside the user's project (SESSION_DEBRIEF.md, CHANGELOG/VERSION edits,
// .claude/signal-log.jsonl, the in-project session lock). A repo-local factory copy keeps its behavior.
// An installed plugin copy needs the project's own marker, written by /setup after the user approves
// session notes: .claude/vibepromptrig.json {"session_notes": true}. Absent, false or malformed = no.
// Operator configuration (VIBE_ROOT) is NOT project consent.
export function projectWritesAllowed(scriptDir, projectDir) {
  if (!isPluginCopy(scriptDir)) return true;
  try {
    return JSON.parse(readFileSync(join(projectDir, '.claude', 'vibepromptrig.json'), 'utf8'))?.session_notes === true;
  } catch { return false; }
}

// Operator ledger -- resolve where heartbeats and session summaries go. Returns { factoryRoot, defer }:
// defer=true => a plugin distribution copy running inside a factory session must no-op (the repo-local
// copy does the work). An installed plugin copy (marketplace cache OR a local-directory install) writes
// the ledger only when the operator explicitly configured one: VIBE_ROOT naming a VibePromptRig factory
// checkout. Install location never authorizes a ledger; otherwise factoryRoot is null and every write,
// including early-exit heartbeats, is skipped. A repo-local factory copy keeps its existing resolution.
export function resolveFactoryRoot(scriptDir) {
  if (isPluginCopy(scriptDir)) {
    const cwd = process.cwd();
    if (existsSync(join(cwd, '.claude-plugin', 'plugin.json')) && existsSync(join(cwd, 'plugin-dist'))) {
      return { factoryRoot: null, defer: true };
    }
    const operatorRoot = process.env.VIBE_ROOT;
    return { factoryRoot: isFactoryCheckout(operatorRoot) ? operatorRoot : null, defer: false };
  }
  return { factoryRoot: process.env.VIBE_ROOT || dirname(dirname(scriptDir)), defer: false };
}

// Finish a hook: emit the heartbeat with the final exit code, then exit. The single exit path so
// every invocation (even an early fail-open bail) leaves exactly one heartbeat row.
export function finishHook(factoryRoot, hookName, code) {
  emitHeartbeat(factoryRoot, hookName, code);
  process.exit(code);
}
