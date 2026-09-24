#!/usr/bin/env node
// log-gear-reco.mjs -- append one {event:"gear_reco"} line to factory_metrics.jsonl so the /gear
// skill's recommendations stop being fire-and-forget (audit 3.5). Paired with the gear_actual
// samples the statusline (statusline-gear.mjs) writes on model/effort change: the outcome-tracker
// joins gear_reco (what was RECOMMENDED) against gear_actual (what actually ran) monthly to compute
// follow-rate + cost delta, then tune gear-shift.md's lane defaults from evidence, not intuition.
//
// Usage (the /gear skill runs this as its final step):
//   node scripts/log-gear-reco.mjs --lane=build --model=sonnet --effort=medium \
//     [--category=code_build] [--fast] [--task="one-line task"]

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { appendJsonl, utcStamp } from './hooks/hook-lib.mjs';

function opt(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

const here = dirname(fileURLToPath(import.meta.url));
const factoryRoot = process.env.VIBE_ROOT || join(here, '..');

const rec = {
  ts: utcStamp(),
  event: 'gear_reco',
  session_id: process.env.CLAUDE_CODE_SESSION_ID || opt('session-id') || null,
  lane: opt('lane') || null,
  model: opt('model') || null,
  effort: opt('effort') || null,
  router_category: opt('category') || null,
  fast: process.argv.includes('--fast'),
};
const task = opt('task');
if (task) rec.task = task.slice(0, 120); // truncate -- telemetry, not a transcript

appendJsonl(join(factoryRoot, 'factory_metrics.jsonl'), rec);
process.stdout.write(`[gear] logged reco: ${rec.lane || '?'} / ${rec.model || '?'} / ${rec.effort || '?'}\n`);
