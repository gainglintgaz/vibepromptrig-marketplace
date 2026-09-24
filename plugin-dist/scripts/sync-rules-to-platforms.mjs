#!/usr/bin/env node
// Historical sync once regenerated global full-rule mirrors.  It is now deliberately
// validation-only unless an explicit project target is supplied.  Compact installation is
// delegated to the canonical Node installer, never to a second renderer.

import { dirname, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { buildInstallPlan, applyInstall } from './forge/context-install.mjs';

const here = dirname(fileURLToPath(import.meta.url));
function option(...flags) {
  for (const flag of flags) {
    const index = process.argv.indexOf(flag);
    if (index >= 0) {
      const value = process.argv[index + 1];
      if (!value || value.startsWith('-')) throw new Error(`Missing value for ${flag}`);
      return value;
    }
  }
  return null;
}
const factoryRoot = realpathSync.native(resolve(option('--factory-root', '-FactoryRoot') || dirname(here)));
const targetRoot = option('--target-root', '--project-root');
const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-DryRun');

// Building a plan validates manifest, dependency closure, deterministic compact rendering, and
// packet budget even when sync has no target.  It cannot touch a global home path implicitly.
if (!targetRoot) {
  const plan = buildInstallPlan({ factoryRoot, projectRoot: factoryRoot });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: 'validation-only',
    writes: 0,
    source_root: plan.source_root,
    source_identity_sha256: plan.source_identity_sha256,
    packet: plan.packet,
    message: 'Ordinary sync validates compact context only. Use --target-root for an explicit installation target.',
  }, null, 2)}\n`);
  process.exit(0);
}

const plan = buildInstallPlan({ factoryRoot, projectRoot: resolve(targetRoot) });
if (dryRun) {
  process.stdout.write(`${JSON.stringify({ ok: true, mode: 'dry-run', writes: 0, source_root: plan.source_root, source_identity_sha256: plan.source_identity_sha256, inventory: plan.inventory, packet: plan.packet }, null, 2)}\n`);
  process.exit(0);
}
const result = applyInstall(plan);
process.stdout.write(`${JSON.stringify({ ...result, source_root: plan.source_root, source_identity_sha256: plan.source_identity_sha256 }, null, 2)}\n`);
process.exit(result.conflicts?.length ? 2 : 0);
