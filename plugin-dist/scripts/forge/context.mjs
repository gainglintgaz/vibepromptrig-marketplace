#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import {
  explainContextSelection,
  loadContextManifest,
  renderContextPacket,
  resolveContext,
} from './context-contract.mjs';
import { main as installMain } from './context-install.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const factoryRoot = realpathSync.native(dirname(dirname(here)));
const manifestPath = join(factoryRoot, '.claude', 'rules-manifest.json');
const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith('-') ? args.shift().toLowerCase() : 'resolve';

function usage(exitCode = 0) {
  const output = [
    'Usage: forge context [resolve|explain|check|install-plan|install-review|install|rollback] [options]',
    '  --intent <name>       Task intent (ui, auth, finance, test, tooling, unknown)',
    '  --path <path>         In-scope path; repeatable',
    '  --capability <name>   Project/task capability; repeatable',
    '  --risk <W0|W1|W2|W3> Semantic risk level',
    '  --budget <bytes>      Override the packet byte ceiling',
    '  --target <kind>       Installation target: project or global',
    '  --platform <name>     Global native target: codex, claude, or gemini',
    '  --target-root <path>  Explicit project root or home root for installation',
    '  --json                Emit resolution metadata as JSON (never full references)',
  ].join('\n');
  (exitCode ? process.stderr : process.stdout).write(`${output}\n`);
  process.exit(exitCode);
}

function parseOptions(values) {
  const scenario = { intent: 'unknown', paths: [], capabilities: [], risk: 'W1' };
  let budgetBytes, json = false;
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    const take = () => {
      const value = values[++index];
      if (!value || value.startsWith('--')) usage(1);
      return value;
    };
    if (arg === '--intent') scenario.intent = take();
    else if (arg === '--path' || arg === '--paths') scenario.paths.push(take());
    else if (arg === '--capability' || arg === '--capabilities') scenario.capabilities.push(take());
    else if (arg === '--risk') scenario.risk = take();
    else if (arg === '--budget') budgetBytes = Number(take());
    else if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') usage(0);
    else usage(1);
  }
  return { scenario, budgetBytes, json };
}

try {
  const installActions = { 'install-plan': 'plan', 'install-review': 'review', install: 'apply', rollback: 'rollback' };
  if (installActions[command]) {
    installMain([installActions[command], ...args]);
    process.exit(process.exitCode || 0);
  }
  if (!existsSync(manifestPath)) throw new Error(`context manifest not found: ${manifestPath}`);
  // Installed portable bundles deliberately omit legacy sources and long references. Runtime
  // validity requires the manifest and every selectable compact card, not the old rule corpus.
  const loaded = loadContextManifest(manifestPath, { factoryRoot, requireFiles: 'runtime' });
  if (command === 'check') {
    process.stdout.write(`VF-CONTEXT-V2 manifest ${loaded.manifest.version}: valid\n`);
    process.exit(0);
  }
  if (!['resolve', 'explain'].includes(command)) usage(1);
  const { scenario, budgetBytes, json } = parseOptions(args);
  const resolution = resolveContext(loaded.manifest, scenario);
  const packet = renderContextPacket({ factoryRoot, manifest: loaded.manifest, resolution, budgetBytes });
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...resolution, source_root: factoryRoot, packet: { bytes: packet.bytes, budget_bytes: packet.budget_bytes, card_paths: packet.card_paths } }, null, 2)}\n`);
  } else if (command === 'explain') {
    process.stdout.write(explainContextSelection(loaded.manifest, resolution, packet));
  } else {
    process.stdout.write(packet.content);
  }
} catch (error) {
  const code = error.code ? ` ${error.code}` : '';
  process.stderr.write(`[forge context${code}] ${error.message}\n`);
  process.exit(2);
}
