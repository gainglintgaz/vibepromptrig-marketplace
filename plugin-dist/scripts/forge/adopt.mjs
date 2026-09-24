#!/usr/bin/env node
// adopt.mjs -- `forge adopt` (Phase 2 mechanical review + Phase 4 basic apply).
// Targets: claude (.claude/*), cursor (.cursor/* + AGENTS.md), auto, both.
// ESM, LF, UTF-8 no BOM. Node >= 18.

import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import {
  beginTransaction, commitTransaction, readManifest, readPluginVersion, writeManifest, safeWrite, forgeDir,
} from './safe-write.mjs';
import { VERDICT_ORDER } from './adopt-shared.mjs';
import * as targetClaude from './target-claude.mjs';
import * as targetCursor from './target-cursor.mjs';
import {
  runDeepPass, mergeDeepIntoPlan, renderDeepSection, writeDeepQueue, DEFAULT_BUDGET_TOKENS,
} from './adopt-deep.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TARGETS = { claude: targetClaude, cursor: targetCursor };

function nowTs() { return new Date().toISOString().replace(/[:.]/g, '-'); }

function resolveTargets(projectRoot, requested) {
  const r = (requested || 'auto').toLowerCase();
  if (r === 'claude' || r === 'cursor') return [r];
  if (r === 'both') return ['claude', 'cursor'];
  const hasClaude = targetClaude.isPresent(projectRoot);
  const hasCursor = targetCursor.isPresent(projectRoot);
  if (hasClaude && hasCursor) return ['claude', 'cursor'];
  if (hasCursor) return ['cursor'];
  if (hasClaude) return ['claude'];
  return ['cursor']; // greenfield: default to cursor when neither tree exists
}

export function reviewProject({ projectRoot, factoryRoot, targets = ['claude'] }) {
  const items = [];
  let counter = 0;
  const active = targets.map((t) => TARGETS[t]).filter(Boolean);
  for (const mod of active) {
    const r = mod.reviewTarget({ projectRoot, factoryRoot, idStart: counter });
    items.push(...r.items);
    counter = r.nextId;
  }
  const summary = {};
  for (const v of VERDICT_ORDER) summary[v] = items.filter((i) => i.verdict === v).length;
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    project_root: projectRoot,
    factory_root: factoryRoot,
    targets,
    plugin_version: readPluginVersion(factoryRoot),
    manifest_present: existsSync(join(forgeDir(projectRoot), 'factory-manifest.json')),
    summary,
    items,
  };
}

export function renderReport(plan) {
  const L = [];
  const hasDeep = plan.deep && !plan.deep_refused;
  L.push(`# forge adopt -- ${hasDeep ? 'mechanical + qualitative' : 'mechanical'} review (read-only)`);
  L.push('');
  L.push(`> Generated: ${plan.generated_at} · Project: ${plan.project_root}`);
  L.push(`> Targets: ${(plan.targets || ['claude']).join(', ')} · Factory: ${plan.plugin_version || '(unknown)'}`);
  L.push('>');
  if (hasDeep) {
    L.push('> Includes **MECHANICAL** + **QUALITATIVE(opinion)** sections (--deep).');
  } else {
    L.push('> **MECHANICAL** verdicts only. Add `--deep` for qualitative pass.');
  }
  L.push('');
  const s = plan.summary;
  L.push(`**Summary:** ADD ${s.ADD} · UPGRADE ${s.UPGRADE} · DIVERGED ${s.DIVERGED} · MISWIRED ${s.MISWIRED} · KEEP ${s.KEEP}`);
  L.push('');
  const desc = {
    ADD: 'Factory has it, project lacks it -- `--apply` adds it (safe).',
    UPGRADE: 'Untouched factory copy behind -- `--apply` upgrades **backup-first**.',
    DIVERGED: 'Customized -- **never auto-overwrite**. Sidecar + diff on opt-in.',
    MISWIRED: 'Wiring/recovery issue -- advisory.',
    KEEP: 'Present and current (shown for honesty).',
  };
  for (const v of VERDICT_ORDER) {
    const rows = plan.items.filter((i) => i.verdict === v && i.kind === 'MECHANICAL');
    if (rows.length === 0) continue;
    L.push(`## ${v} (${rows.length}) -- ${desc[v]}`);
    for (const r of rows) {
      const tag = r.target ? `[${r.target}] ` : '';
      L.push(`- \`[${r.id}]\` ${tag}\`${r.relPath}\`${r.note ? ` -- ${r.note}` : ''}`);
    }
    L.push('');
  }
  L.push('---');
  if (plan.deep) L.push(renderDeepSection(plan.deep));
  L.push('Next: `forge adopt --apply --target <cursor|claude>` applies ADD+UPGRADE backup-first.');
  L.push('Lean seed: `forge adopt --apply --target cursor --essential`');
  L.push('');
  return L.join('\n');
}

export function writeReviewOutputs(projectRoot, plan, reportMd, ts = nowTs()) {
  const dir = forgeDir(projectRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const reportPath = join(dir, `adopt-report-${ts}.md`);
  const planPath = join(dir, `adopt-plan-${ts}.json`);
  writeFileSync(reportPath, reportMd, 'utf8');
  writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n', 'utf8');
  return { reportPath, planPath, ts };
}

export function applyPlan({ projectRoot, factoryRoot, plan, itemIds = null, essentialOnly = false }) {
  const manifest = readManifest(projectRoot);
  const pluginVersion = readPluginVersion(factoryRoot);
  let candidates = plan.items.filter((i) => (i.verdict === 'ADD' || i.verdict === 'UPGRADE') && i.kind === 'MECHANICAL');
  if (essentialOnly) candidates = targetCursor.filterEssentialItems(candidates);
  if (itemIds && itemIds.size > 0) candidates = candidates.filter((i) => itemIds.has(i.id));

  const targets = [...new Set(candidates.map((i) => i.target).filter(Boolean))];
  const maps = {};
  for (const t of targets) {
    if (TARGETS[t]) maps[t] = TARGETS[t].artifactMap(factoryRoot);
  }

  const ops = candidates.map((i) => ({ relPath: i.relPath, action: i.verdict === 'ADD' ? 'add' : 'upgrade' }));
  if (ops.length === 0) return { applied: 0, skipped: plan.items.length, results: [], backup_ts: null };

  const tx = beginTransaction(projectRoot, ops, { pluginVersion });
  const results = [];
  for (const item of candidates) {
    // Cursor rule artifacts are already the lean templates (target-cursor.mjs); no full mirror exists.
    const content = maps[item.target]?.get(item.relPath);
    if (content == null) {
      results.push({ relPath: item.relPath, action: 'skip', reason: 'no factory template' });
      continue;
    }
    const r = safeWrite({ projectRoot, relPath: item.relPath, content, templateVersion: pluginVersion, manifest, tx });
    results.push({ relPath: item.relPath, ...r });
  }
  commitTransaction(tx);
  writeManifest(projectRoot, manifest, pluginVersion);
  return { applied: results.filter((r) => r.written).length, results, backup_ts: tx.ts };
}

function parseArgs(argv) {
  const o = { mode: 'review', path: '', json: false, help: false, target: 'auto', planPath: '', items: null, essential: false, consent: false };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]).toLowerCase();
    if (a === '--review' || a === '-review') o.mode = 'review';
    else if (a === '--apply' || a === '-apply') o.mode = 'apply';
    else if (a === '--deep' || a === '-deep') o.deep = true;
    else if (a === '--consent' || a === '-consent') o.consent = true;
    else if (a === '--json' || a === '-json') o.json = true;
    else if (a === '--essential' || a === '-essential') o.essential = true;
    else if (a === '--path' || a === '-path') o.path = argv[++i];
    else if (a === '--target' || a === '-target') o.target = argv[++i];
    else if (a === '--plan' || a === '-plan') o.planPath = argv[++i];
    else if (a === '--items' || a === '-items') {
      o.items = new Set(String(argv[++i]).split(',').map((x) => Number(x.trim())).filter((n) => n > 0));
    } else if (a === '--help' || a === '-help' || a === '-h' || a === '/?') o.help = true;
  }
  return o;
}

function loadPlan(path) {
  let raw = readFileSync(path, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  return JSON.parse(raw);
}

function findLatestPlan(projectRoot) {
  const dir = forgeDir(projectRoot);
  if (!existsSync(dir)) return null;
  const plans = readdirSync(dir).filter((f) => f.startsWith('adopt-plan-')).sort();
  return plans.length ? join(dir, plans[plans.length - 1]) : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('\nforge adopt -- review/update factory setup without clobbering customizations.\n\n'
      + '  forge adopt [--review] [--target auto|cursor|claude|both]   read-only review (DEFAULT)\n'
      + '  forge adopt --apply [--target cursor] [--plan <path>] [--items 1,2,3] [--essential]\n'
      + '  forge adopt --review --deep [--consent]   qualitative heuristic pass (Phase 3)\n'
      + '  --path <dir>                  project to review/apply\n\n');
    return;
  }

  const factoryRoot = process.env.VIBE_ROOT || dirname(dirname(here));
  const projectRoot = args.path || process.cwd();
  const targets = resolveTargets(projectRoot, args.target);

  const consent = args.consent || process.env.ADOPT_DEEP_CONSENT === '1';
  const budgetTokens = Number(process.env.ADOPT_DEEP_BUDGET_TOKENS) || DEFAULT_BUDGET_TOKENS;

  if (args.mode === 'apply') {
    const planFile = args.planPath || findLatestPlan(projectRoot);
    if (!planFile || !existsSync(planFile)) {
      process.stderr.write('\nforge adopt --apply: no adopt-plan found. Run `forge adopt --review` first.\n\n');
      process.exitCode = 2;
      return;
    }
    const plan = loadPlan(planFile);
    const result = applyPlan({
      projectRoot, factoryRoot, plan,
      itemIds: args.items, essentialOnly: args.essential,
    });
    process.stdout.write(`\n  forge adopt --apply\n\n`
      + `  Applied: ${result.applied} file(s)\n`
      + `  Backup:  .forge/backups/${result.backup_ts}/\n`
      + `  Undo:    restore from backup snapshot above\n\n`);
    for (const r of result.results) {
      if (r.written) process.stdout.write(`    ${r.action}: ${r.relPath}\n`);
    }
    process.stdout.write('\n');
    return;
  }

  let plan = reviewProject({ projectRoot, factoryRoot, targets });
  let deepQueuePath = null;

  if (args.deep) {
    const deepResult = runDeepPass({
      projectRoot,
      mechanicalItems: plan.items.filter((i) => i.kind === 'MECHANICAL'),
      budgetTokens,
      consent,
    });
    if (deepResult.over_budget) {
      process.stderr.write(`\nforge adopt --deep REFUSED: ~${deepResult.estimated_tokens} tokens exceeds cap ${budgetTokens}.\n`
        + 'Raise ADOPT_DEEP_BUDGET_TOKENS or reduce scope.\n\n');
      plan = mergeDeepIntoPlan(plan, deepResult);
    } else {
      plan = mergeDeepIntoPlan(plan, deepResult);
      const ts = nowTs();
      deepQueuePath = writeDeepQueue(projectRoot, deepResult, ts);
    }
  }

  const reportMd = renderReport(plan);
  const { reportPath, planPath } = writeReviewOutputs(projectRoot, plan, reportMd);

  if (args.json) {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    return;
  }
  const s = plan.summary;
  process.stdout.write('\n  forge adopt -- mechanical review (read-only)\n\n'
    + `  Project:  ${projectRoot}\n`
    + `  Targets:  ${targets.join(', ')}\n`
    + `  Verdicts: ADD ${s.ADD} · UPGRADE ${s.UPGRADE} · DIVERGED ${s.DIVERGED} · MISWIRED ${s.MISWIRED} · KEEP ${s.KEEP}\n\n`
    + `  Report: ${reportPath}\n`
    + `  Plan:   ${planPath}\n`
    + (deepQueuePath ? `  Deep:   ${deepQueuePath}\n` : '')
    + '\n'
    + '  Next: forge adopt --apply --target cursor --essential  (lean seed)\n\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
