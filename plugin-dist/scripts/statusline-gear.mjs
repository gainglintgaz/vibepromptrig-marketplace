#!/usr/bin/env node
// statusline-gear.mjs -- advisory Claude Code statusline: current model + effort + live
// price tier + budget-awareness (context/rate-limit usage), per gear-shift.md's vocabulary.
//
// Reads the statusLine JSON Claude Code pipes on stdin (model, effort, context_window,
// rate_limits -- see Claude Code docs). Shows only what is ACTUALLY true for this session
// (VIBE Rule 11, honest strings) -- it does NOT invent a "recommended gear for your current
// task" because the statusline hook is never given the task text, only session metadata.
// For a real task-aware recommendation, use the /gear skill instead (it takes a task
// description as input). This script is advisory-only and must never throw, block, or run
// slow -- keep it well under the ~100ms budget the docs call out.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendJsonl, utcStamp } from './hooks/hook-lib.mjs';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));

const EFFORT_WORD = { low: 'plain', medium: 'think', high: 'think hard', xhigh: 'think harder', max: 'ultrathink' };

function readStdinSync() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function loadRouter(factoryRoot) {
  try {
    return JSON.parse(readFileSync(join(factoryRoot, '.claude', 'model-router.json'), 'utf8'));
  } catch {
    return null;
  }
}

function priceFor(router, modelId, displayName) {
  if (!router || !router.models) return null;
  if (modelId && router.models[modelId]) return router.models[modelId];
  // Fallback: fuzzy-match by tier keyword in display_name (model ids drift; never crash on a miss).
  const dn = (displayName || '').toLowerCase();
  const guess = ['fable', 'opus', 'sonnet', 'haiku'].find((k) => dn.includes(k));
  if (!guess) return null;
  const hit = Object.entries(router.models).find(([id]) => id.toLowerCase().includes(guess));
  return hit ? hit[1] : null;
}

function pct(n) {
  return typeof n === 'number' ? `${Math.round(n)}%` : null;
}

function main() {
  const raw = readStdinSync();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    process.stdout.write('[gear] (unreadable statusline input)');
    return;
  }

  const modelId = data?.model?.id || null;
  const modelName = data?.model?.display_name || modelId || 'model?';
  const effortLevel = data?.effort?.level || null;
  const effortWord = effortLevel ? (EFFORT_WORD[effortLevel] || effortLevel) : null;

  // Portable by construction: derived from this script's own location (scripts/<file> -> factory
  // root is one level up), never a hardcoded operator path. VIBE_ROOT still wins if explicitly set.
  const factoryRoot = process.env.VIBE_ROOT || join(here, '..');
  const router = loadRouter(factoryRoot);
  const price = priceFor(router, modelId, modelName);

  const parts = [`[${modelName}]`];
  if (effortWord) parts.push(`gear: ${effortWord}`);
  if (price) parts.push(`$${price.in_usd_mtok}/$${price.out_usd_mtok} per Mtok`);

  const ctxPct = pct(data?.context_window?.used_percentage);
  if (ctxPct) parts.push(`ctx ${ctxPct}`);

  const fiveHour = pct(data?.rate_limits?.five_hour?.used_percentage);
  if (fiveHour) parts.push(`5h ${fiveHour}`);

  const branch = data?.worktree?.branch || data?.workspace?.git_worktree || null;
  if (branch) parts.push(branch);

  process.stdout.write(parts.join(' | '));

  // Telemetry (audit 3.5): sample the ACTUAL model/effort, but ONLY when it changes -- never one
  // line per render. The outcome-tracker joins these gear_actual points against /gear's gear_reco
  // lines (follow-rate + cost delta). Fully guarded + runs AFTER the write: telemetry must never
  // break or slow the statusline.
  try {
    const sessionId = process.env.CLAUDE_CODE_SESSION_ID || data.session_id || null;
    // Hash identifiers before using them as filenames; missing IDs cannot be correlated.
    const stateFile = sessionId ? join(factoryRoot, '.forge', 'gear-sessions', createHash('sha256').update(String(sessionId)).digest('hex') + '.json') : null;
    let last = null;
    try { if (stateFile) last = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* first run / unreadable */ }
    if (!last || last.model !== modelId || last.effort !== effortLevel) {
      appendJsonl(join(factoryRoot, 'factory_metrics.jsonl'), {
        ts: utcStamp(), event: 'gear_actual', session_id: sessionId, model: modelId, model_name: modelName, effort: effortLevel,
      });
      try { if (stateFile) { mkdirSync(dirname(stateFile), { recursive: true }); writeFileSync(stateFile, JSON.stringify({ model: modelId, effort: effortLevel })); } } catch { /* best-effort */ }
    }
  } catch { /* never break the statusline */ }
}

main();
