#!/usr/bin/env node
// Verifies the compact delivery contract without writing generated mirrors into the factory.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { buildInstallPlan } from './context-install.mjs';

const here = dirname(fileURLToPath(import.meta.url));
function argValue(...flags) { for (const flag of flags) { const i = process.argv.indexOf(flag); if (i >= 0) return process.argv[i + 1]; } return null; }
const factoryRoot = resolve(argValue('--factory-root', '--root') || process.env.VIBE_ROOT || dirname(dirname(here)));
const failures = [];
// The legacy autoload tree must never come back (Context V2 Delivery 3b); its presence is a failure,
// not a precondition.
if (existsSync(join(factoryRoot, '.claude', 'rules'))) failures.push('legacy .claude/rules/ autoload tree present');
// Missing source inputs are a precondition failure (exit 1, parity with the PowerShell entrypoint).
if (!existsSync(join(factoryRoot, '.claude', 'rules-manifest.json'))) {
  process.stderr.write(`Context manifest not found: ${join(factoryRoot, '.claude', 'rules-manifest.json')}\n`);
  process.exit(1);
}
if (!existsSync(join(factoryRoot, '.forge', 'context', 'kernel.md'))) failures.push('context kernel missing');
try {
  const plan = buildInstallPlan({ factoryRoot, projectRoot: factoryRoot });
  for (const asset of plan.files) {
    if (asset.relPath.startsWith('.claude/rules/')) failures.push(`legacy autoload asset proposed: ${asset.relPath}`);
    if (asset.relPath.startsWith('.cursor/rules/') && asset.relPath !== '.cursor/rules/vf-context-core.mdc') failures.push(`full Cursor mirror proposed: ${asset.relPath}`);
    if (asset.relPath === 'AGENTS.md' && /accessibility\.md -- WCAG/i.test(asset.content)) failures.push('native packet contains a full rule body');
  }
} catch (error) { failures.push(error.message); }
if (failures.length) {
  process.stderr.write(`${failures.map((item) => `FAIL: ${item}`).join('\n')}\n`);
  process.exit(2);
}
process.stdout.write('[OK] compact context contract validates; no full native mirror is proposed.\n');
