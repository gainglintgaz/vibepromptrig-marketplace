#!/usr/bin/env node
// Onboard an existing project without recreating the historical full-rule autoload tree.
// The compact installer owns native files, inventories every target, and refuses to overwrite
// user changes. This script owns the unrelated tracking and hook-adoption concerns.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, cpSync, chmodSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { beginTransaction, commitTransaction, markApplied, readPluginVersion, resolvePathInside } from './forge/safe-write.mjs';
import { buildInstallPlan, applyInstall } from './forge/context-install.mjs';
import { buildCleanupPlan } from './forge/legacy-rules.mjs';

const here = dirname(fileURLToPath(import.meta.url));
function parseArgs(argv) {
  const out = { path: '', force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i].toLowerCase();
    if (flag === '--path' || flag === '-path') out.path = argv[++i];
    else if (flag === '--force' || flag === '-force') out.force = true;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
if (!args.path) { console.error('onboard: -Path is required'); process.exit(1); }
if (!existsSync(args.path)) { console.error(`Project path does not exist: ${args.path}`); process.exit(1); }
const projectRoot = realpathSync.native(args.path);
import { realpathSync } from 'node:fs';
const factoryRoot = realpathSync.native(dirname(here));
if (!existsSync(projectRoot)) { console.error(`Project path does not exist: ${projectRoot}`); process.exit(1); }
if (!existsSync(join(factoryRoot, '.claude', 'rules-manifest.json'))) { console.error(`Context manifest not found: ${factoryRoot}`); process.exit(1); }

const projectName = basename(projectRoot.replace(/[\\/]+$/, ''));
const nameLower = projectName.toLowerCase().replace(/\s+/g, '-');
const created = [];
const skipped = [];
console.log(`\n  VibePromptRig Onboard\n  Project: ${projectName}\n  Path: ${projectRoot}\n`);

// Compact install is intentionally never forceful. A divergent native entry proves a human
// customization, so the result is reported and preserved for explicit review/merge.
const contextResult = applyInstall(buildInstallPlan({ factoryRoot, projectRoot }));
if (!contextResult.conflicts?.length) created.push(`compact context (${contextResult.inventory.filter((item) => item.action !== 'unchanged').length} changed)`);
else skipped.push(`compact context (conflict: ${contextResult.conflicts.map((item) => item.path).join(', ')}; customized content preserved)`);

// Pre-Context-V2 onboarding copied full factory rules into .claude/rules (and adopt into
// .cursor/rules). Onboarding never deletes project files: report the zero-write inventory and name
// the reviewed, backup-first cleanup instead.
try {
  const legacy = buildCleanupPlan({ projectRoot, factoryRoot });
  if (legacy.summary.remove || legacy.summary.conflicts) {
    skipped.push(`legacy factory rule copies: ${legacy.summary.remove} proven factory-owned, ${legacy.summary.conflicts} customized (preserved). Review: forge legacy-rules plan --project-root "${projectRoot}" --out <plan.json>, then forge legacy-rules apply --project-root "${projectRoot}" --plan <plan.json>`);
  }
} catch (error) {
  skipped.push(`legacy factory rule scan failed (nothing removed): ${error.message}`);
}

const trackingFiles = {
  'CURRENT_SPRINT.md': '# Current Sprint\n\n## Active Tasks\n| Task | Status | Started | Notes |\n|------|--------|---------|-------|\n',
  'V1_FEATURE_BACKLOG.md': '# V1 Feature Backlog\n\nStatus flow: DISCUSSED -> IN PROGRESS -> DONE -> VERIFIED\n',
  'errors-fixed.json': '[]\n',
  'golden-paths.md': '# Golden Paths -- Proven Patterns\n',
};
for (const [name, body] of Object.entries(trackingFiles)) {
  const file = join(projectRoot, name);
  if (existsSync(file)) skipped.push(`${name} (already exists)`);
  else { writeFileSync(file, body); created.push(name); }
}

function copyContents(src, dst) {
  const entries = readdirSync(src, { withFileTypes: true });
  const operations = entries.map((entry) => {
    if (!entry.isFile()) throw new Error('Expected a flat tool/hook pack: ' + src);
    const relPath = join(dst, entry.name).slice(projectRoot.length).replace(/^[\\/]+/, '').replaceAll('\\', '/');
    const target = resolvePathInside(projectRoot, relPath);
    if (existsSync(target) && !args.force) { skipped.push(relPath + ' (already exists)'); return null; }
    return { relPath, action: existsSync(target) ? 'upgrade' : 'add', source: join(src, entry.name), target };
  }).filter(Boolean);
  if (!operations.length) return;
  // Snapshot every replacement before writing; additions are logged too so rollback is complete.
  const tx = beginTransaction(projectRoot, operations, { pluginVersion: readPluginVersion(factoryRoot) });
  for (const op of operations) {
    mkdirSync(dirname(op.target), { recursive: true });
    cpSync(op.source, op.target);
    markApplied(tx, op.relPath, readFileSync(op.target));
  }
  commitTransaction(tx);
  created.push('restorable backup: .forge/backups/' + tx.ts + '/');
}
function makeHooksExecutable(dir) {
  if (process.platform === 'win32' || !existsSync(dir)) return;
  for (const file of readdirSync(dir)) { try { chmodSync(join(dir, file), 0o755); } catch { /* best effort */ } }
}
// Completion evidence tooling and its CI gate remain part of onboarding.
const toolsTarget = join(projectRoot, 'tools');
if (existsSync(join(toolsTarget, 'block-unverified-claims.mjs')) && !args.force) {
  skipped.push('completion-truth tools (already exist; pass -Force to refresh)');
} else {
  copyContents(join(factoryRoot, 'scripts', 'completion'), toolsTarget);
  created.push('completion-truth tools');
}
const workflowRel = '.github/workflows/vibepromptrig-completion-truth.yml';
const workflowTarget = resolvePathInside(projectRoot, workflowRel);
if (existsSync(workflowTarget) && !args.force) {
  skipped.push('VibePromptRig completion-truth CI (already exists; pass -Force to refresh)');
} else {
  const tx = beginTransaction(projectRoot, [{ relPath: workflowRel, action: existsSync(workflowTarget) ? 'upgrade' : 'add' }], { pluginVersion: readPluginVersion(factoryRoot) });
  mkdirSync(dirname(workflowTarget), { recursive: true });
  cpSync(join(factoryRoot, 'scripts', 'templates', 'shared', workflowRel), workflowTarget);
  markApplied(tx, workflowRel, readFileSync(workflowTarget));
  commitTransaction(tx);
  created.push('VibePromptRig completion-truth CI (backup: ' + tx.ts + ')');
}
const hooksSource = join(factoryRoot, 'scripts', 'templates', 'shared', '.githooks');
if (existsSync(join(projectRoot, '.git')) && existsSync(hooksSource)) {
  const readHookPath = spawnSync('git', ['-C', projectRoot, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' });
  const hookPath = readHookPath.status === 0 ? String(readHookPath.stdout).trim() : '';
  if (hookPath && hookPath !== '.githooks') skipped.push(`git hooks (core.hooksPath already '${hookPath}')`);
  else if (existsSync(join(projectRoot, '.husky')) && !hookPath) skipped.push('git hooks (.husky/ detected)');
  else {
    const target = join(projectRoot, '.githooks');
    if (!existsSync(target)) { copyContents(hooksSource, target); created.push('.githooks/'); }
    else if (args.force) { copyContents(hooksSource, target); created.push('.githooks/ (refreshed)'); }
    else skipped.push('.githooks/ (already exists)');
    makeHooksExecutable(target);
    spawnSync('git', ['-C', projectRoot, 'config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
  }
} else if (!existsSync(join(projectRoot, '.git'))) skipped.push('git hooks (not a git repository)');

const briefDir = join(factoryRoot, 'projects', nameLower);
if (!existsSync(briefDir)) {
  mkdirSync(briefDir, { recursive: true });
  let techStack = 'Unknown -- check package.json';
  const pkg = join(projectRoot, 'package.json');
  if (existsSync(pkg)) { try { techStack = JSON.parse(readFileSync(pkg, 'utf8')).name || techStack; } catch { /* keep default */ } }
  writeFileSync(join(briefDir, 'BRIEF.md'), `# ${projectName} — Project Brief\n\n## Status: IN PROGRESS\n\n## Location\n${projectRoot}\n\n## Tech Stack\n${techStack}\n`);
  created.push(`Factory brief: projects/${nameLower}/BRIEF.md`);
} else skipped.push('Factory brief (already exists)');

console.log('  Onboard complete!\n');
if (created.length) console.log(`  Created:\n${created.map((item) => `    ${item}`).join('\n')}`);
if (skipped.length) console.log(`  Preserved/skipped:\n${skipped.map((item) => `    ${item}`).join('\n')}`);
console.log(`\n  Next: cd ${projectRoot} && claude\n`);
