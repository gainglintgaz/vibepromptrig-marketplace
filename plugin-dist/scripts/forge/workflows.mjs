#!/usr/bin/env node
// workflows.mjs -- Node twin of workflows.ps1 (cross-platform port P2, must-port set).
// forge workflows -- list the saved dynamic-workflow library (.claude/workflows/). Read-only.
// Reads each .claude/workflows/*.mjs, extracts its meta.name + meta.description, and prints how to
// run it. Faithful to workflows.ps1: same output strings, same JSON shape, same exit codes.
// Dependency-free (Node stdlib), node:path throughout, Node >= 18, ESM, UTF-8 no BOM.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
// These files live in scripts/forge/, so the factory root is dirname(dirname(scriptDir)).
const FactoryRoot = process.env.VIBE_ROOT || dirname(dirname(here));

const argv = process.argv.slice(2);
const jsonFlag = argv.includes('--json') || argv.includes('-Json');

// .claude/workflows (node:path join keeps this cross-OS; the .ps1 used ".claude\workflows").
const wfDir = join(FactoryRoot, '.claude', 'workflows');

if (!existsSync(wfDir)) {
  if (jsonFlag) process.stdout.write('{"workflows":[]}\n');
  else process.stdout.write('  No .claude/workflows/ directory yet.\n');
  process.exit(0);
}

// Get-ChildItem -Filter "*.mjs" -File | Sort-Object Name  -> .mjs files only, sorted by name.
// PowerShell's Sort-Object Name is case-INSENSITIVE; localeCompare with sensitivity 'accent'
// matches that (case-insensitive ordering) faithfully.
const files = readdirSync(wfDir)
  .filter((f) => {
    if (!f.toLowerCase().endsWith('.mjs')) return false;
    try { return statSync(join(wfDir, f)).isFile(); } catch { return false; }
  })
  .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'accent' }));

// PowerShell [regex]::Match (default) is CASE-SENSITIVE -- the meta keys are lowercase
// (name:/description:), so the patterns match without an 'i' flag. Preserve that exactly:
// do NOT add 'i' here (it would alter behavior vs the .ps1).
const nameRe = /name:\s*'([^']*)'/;
const descRe = /description:\s*'([^']*)'/;

const workflows = [];
for (const f of files) {
  const content = readFileSync(join(wfDir, f), 'utf8');
  let name = null;
  let description = null;
  const mName = content.match(nameRe);
  if (mName) name = mName[1];
  const mDesc = content.match(descRe);
  if (mDesc) description = mDesc[1];
  if (!name) name = basename(f, '.mjs');
  workflows.push({
    name,
    description,
    scriptPath: `.claude/workflows/${f}`,
  });
}

if (jsonFlag) {
  // ConvertTo-Json -Depth 5 on @{ workflows = $workflows }. Match the object shape; null
  // descriptions serialize as null (PowerShell renders an unset value as null too).
  process.stdout.write(JSON.stringify({ workflows }, null, 2) + '\n');
  process.exit(0);
}

process.stdout.write('\n');
process.stdout.write('Saved dynamic workflows (.claude/workflows/)\n');
process.stdout.write('\n');
if (workflows.length === 0) {
  process.stdout.write('  (none yet -- add a .mjs Workflow script to .claude/workflows/)\n');
} else {
  for (const w of workflows) {
    process.stdout.write(`  ${w.name}\n`);
    if (w.description) {
      process.stdout.write(`      ${w.description}\n`);
    }
    process.stdout.write(`      run: Workflow(name: '${w.name}')  or  Workflow(scriptPath: '${w.scriptPath}')\n`);
    process.stdout.write('\n');
  }
  process.stdout.write(`  ${workflows.length} workflow(s). Invoke from a Claude Code session with the Workflow tool.\n`);
  process.stdout.write('  Name-invocation indexes at session start; scriptPath works immediately.\n');
}
process.stdout.write('\n');
process.exit(0);
