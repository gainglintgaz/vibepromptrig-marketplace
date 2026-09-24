#!/usr/bin/env node
// log-instructions-loaded.mjs -- Node twin of log-instructions-loaded.ps1 (cross-platform port P2, T2).
//
// InstructionsLoaded hook: append every rule-load event to factory_metrics.jsonl. Observability-only;
// cannot block loading. Reads BOM-tolerant stdin, NEVER throws, NEVER exits non-zero (fail-open), and
// emits exactly one per-invocation heartbeat via finishHook.
//
// Faithful to the .ps1:
//   - empty/unparseable stdin -> exit 0 (no metrics row), still heartbeat.
//   - metrics root resolves from payload.cwd when it is a valid dir (mirrors the .ps1's $payload.cwd
//     preference); otherwise falls back to the resolved factoryRoot. The heartbeat ALWAYS goes to the
//     resolved factoryRoot (port contract rule 4/6).
//   - one ordered row appended to <root>/factory_metrics.jsonl.

import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { readStdin, parseJsonSafe, appendJsonl, utcStamp, resolveFactoryRoot, finishHook } from './hook-lib.mjs';

const HOOK_NAME = 'log-instructions-loaded';
const scriptDir = dirname(fileURLToPath(import.meta.url));

// HEARTBEAT guard: a plugin-dist copy running inside a factory session defers to the repo-local copy.
const { factoryRoot, defer } = resolveFactoryRoot(scriptDir);
if (defer) process.exit(0); // no heartbeat on deferral, per contract

try {
  const raw = readStdin();
  // .ps1: `if (-not $stdinRaw) { exit 0 }` -- empty stdin bails with no metrics row.
  if (!raw) finishHook(factoryRoot, HOOK_NAME, 0);

  const payload = parseJsonSafe(raw);
  // .ps1: `if (-not $payload) { exit 0 }` -- ConvertFrom-Json failure OR a falsy payload bails.
  // parseJsonSafe returns null on parse failure; also treat any falsy/non-object parse as a bail
  // to match PowerShell's `-not $payload` (0, "", null, false all bail there).
  if (!payload || typeof payload !== 'object') finishHook(factoryRoot, HOOK_NAME, 0);

  // .ps1: $factoryRoot = if ($payload.cwd) { $payload.cwd } else { Split-Path -Parent $PSScriptRoot }
  // We prefer the resolved factoryRoot (handles VIBE_ROOT + plugin guards), but stay faithful to the
  // .ps1 by using payload.cwd for the metrics path when it is a present, valid directory.
  let metricsRoot = factoryRoot;
  const cwd = payload.cwd;
  if (cwd && typeof cwd === 'string') {
    try {
      if (existsSync(cwd) && statSync(cwd).isDirectory()) metricsRoot = cwd;
    } catch { /* fall back to factoryRoot */ }
  }
  if (!metricsRoot) metricsRoot = factoryRoot; // never write to a null path

  // Build the row in the .ps1's ordered shape. ConvertTo-Json renders an absent PS property as null;
  // JSON.stringify omits an `undefined` value. To match the .ps1's null-for-missing output, coerce any
  // undefined field to null. (PS would also drop nothing -- every key is present, value null if absent.)
  const v = (x) => (x === undefined ? null : x);
  const entry = {
    ts: utcStamp(),
    event: 'instruction_loaded',
    session_id: v(payload.session_id),
    cwd: v(payload.cwd),
    file_path: v(payload.file_path),
    memory_type: v(payload.memory_type),
    load_reason: v(payload.load_reason),
    globs: v(payload.globs),
    trigger_file_path: v(payload.trigger_file_path),
    parent_file_path: v(payload.parent_file_path),
  };

  if (metricsRoot) appendJsonl(join(metricsRoot, 'factory_metrics.jsonl'), entry);
} catch {
  // Swallow errors silently per hook contract; never block loading. Fall through to the single heartbeat.
}

finishHook(factoryRoot, HOOK_NAME, 0);
