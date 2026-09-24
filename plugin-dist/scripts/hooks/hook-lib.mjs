// hook-lib.mjs -- shared helpers for the capture-layer hook twins (cross-platform port P2, T2).
// Every capture hook (signal-classifier, signal-batch-analyzer, session-budget-tracker,
// post-session-enforcer, log-instructions-loaded) reads BOM-tolerant stdin, NEVER throws, NEVER
// blocks (fail-open), and emits a per-invocation heartbeat. Dependency-free (Node stdlib), Node>=18.

import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
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

// Resolve the OPERATOR factory root, mirroring the .ps1 double-fire + plugin-copy guards.
// Returns { factoryRoot, defer }: defer=true => this is a plugin distribution copy running inside a
// factory session, so the hook must no-op (the repo-local copy does the work). factoryRoot may be
// null when running from an installed plugins cache with no VIBE_ROOT (no factory ledger to write).
export function resolveFactoryRoot(scriptDir) {
  const isPluginCopy = /[\\/]plugin-dist([\\/]|$)/.test(scriptDir) || /[\\/]plugins[\\/]cache[\\/]/.test(scriptDir);
  if (isPluginCopy) {
    const cwd = process.cwd();
    if (existsSync(join(cwd, '.claude-plugin', 'plugin.json')) && existsSync(join(cwd, 'plugin-dist'))) {
      return { factoryRoot: null, defer: true };
    }
  }
  let root = process.env.VIBE_ROOT || dirname(dirname(scriptDir));
  if (basename(root) === 'plugin-dist') root = dirname(root);
  else if (/[\\/]plugins[\\/]cache[\\/]/.test(root)) root = process.env.VIBE_ROOT || null;
  return { factoryRoot: root, defer: false };
}

// Finish a hook: emit the heartbeat with the final exit code, then exit. The single exit path so
// every invocation (even an early fail-open bail) leaves exactly one heartbeat row.
export function finishHook(factoryRoot, hookName, code) {
  emitHeartbeat(factoryRoot, hookName, code);
  process.exit(code);
}
