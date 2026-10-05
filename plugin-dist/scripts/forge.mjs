#!/usr/bin/env node
// forge.mjs -- single command surface for the VibePromptRig factory.
// Node twin of forge.ps1 (cross-platform port P2, T1c). Dispatches subcommands to
// scripts/forge/<cmd>.{mjs|ps1}: a ported .mjs twin runs on `node` (every OS); an
// un-ported .ps1 runs on `powershell` (Windows) and degrades to a loud, honest advisory
// on macOS/Linux until its twin lands. As each subcommand is ported, it just gains a
// <cmd>.mjs and flips automatically -- no change here.
//
// Dependency-free (Node stdlib), Node >= 18.

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
import { realpathSync } from 'node:fs';
const FactoryRoot = realpathSync.native(dirname(here));
const ForgeDir = join(here, 'forge');

// node>=18 preflight (loud advisory; the lib uses 18+ APIs). node-ABSENT is handled by the
// POSIX `forge` shim before this ever runs (macOS GUI-launch PATH).
const nodeMajor = Number(String(process.versions.node).split('.')[0]);
if (!Number.isFinite(nodeMajor) || nodeMajor < 18) {
  process.stderr.write(`[forge] WARNING: Node ${process.versions.node} detected; forge needs Node >= 18. Update Node, or the factory automation may misbehave.\n`);
}

// command -> subcommand file base (mirrors forge.ps1 KnownCommands).
const KNOWN = {
  init: 'init', profile: 'profile', rule: 'rule', config: 'config', doctor: 'doctor',
  context: 'context',
  cost: 'cost', workflows: 'workflows', scaffold: 'scaffold', onboard: 'onboard', sync: 'sync',
  sanitize: 'sanitize', audit: 'audit', release: 'release', plan: 'plan', ship: 'ship',
  harvest: 'harvest', mcp: 'mcp', adopt: 'adopt', 'legacy-rules': 'legacy-rules',
};

const argv = process.argv.slice(2);
const command = (argv[0] || '').toLowerCase();
const rest = argv.slice(1);

function showHelp() {
  process.stdout.write([
    '',
    'forge -- VibePromptRig factory CLI',
    '',
    'USAGE:',
    '  forge <command> [args...]',
    '',
    'COMMANDS:',
    '  init                 Interactive profile wizard for current project.',
    '  profile show|set|get|list   Manage the current project profile.',
    '  rule list|add|remove        Manage active rules.',
    '  context resolve|explain|check|install-plan|install-review|install|rollback',
    '                           Resolve packets or explicitly install/restore a compact bundle.',
    '  legacy-rules plan|apply|rollback --project-root <path>',
    '                           Reviewed, backup-first removal of old factory rule copies in a project.',
    '  config list|get|set         Manage tunable config fields.',
    '  doctor               Factory health check.',
    '  cost                 [Planned v0.2] Cross-project token burn report.',
    '  workflows            List saved dynamic workflows.',
    '  mcp list|inspect|setup codex  Inspect local metadata or preview Codex MCP setup (read-only).',
    '  scaffold <name>      Windows PowerShell wrapper; Node-native handler is planned.',
    '  onboard <path>       Windows PowerShell wrapper; Node-native handler is planned.',
    '  adopt [--review] [--target auto|cursor|claude|both]  Review setup for drift (read-only).',
    '  adopt --apply [--target cursor] [--essential]       Apply ADD+UPGRADE backup-first.',
    '  sync                 Windows PowerShell wrapper; Node-native handler is planned.',
    '  version              Print factory version.',
    '',
    `ENVIRONMENT:  Factory root: ${FactoryRoot}`,
    '',
  ].join('\n') + '\n');
}

function printVersion() {
  const vf = join(FactoryRoot, 'VERSION.md');
  let v = 'unknown';
  if (existsSync(vf)) {
    const m = readFileSync(vf, 'utf8').match(/Current version:\**\s*([0-9][^\s<]*)/i);
    if (m) v = m[1];
  }
  process.stdout.write(`forge: VibePromptRig factory ${v}\n`);
}

if (!command || command === 'help' || command === '-h' || command === '--help' || command === '/?') {
  showHelp();
  process.exit(0);
}
if (command === 'version') { printVersion(); process.exit(0); }

if (!Object.prototype.hasOwnProperty.call(KNOWN, command)) {
  process.stderr.write(`\nUnknown command: ${command}\nRun 'forge help' to see available commands.\n\n`);
  process.exit(1);
}

const base = KNOWN[command];
const mjsPath = join(ForgeDir, `${base}.mjs`);
const ps1Path = join(ForgeDir, `${base}.ps1`);
const childEnv = { ...process.env, VIBE_ROOT: FactoryRoot };

if (existsSync(mjsPath)) {
  const r = spawnSync(process.execPath, [mjsPath, ...rest], { stdio: 'inherit', env: childEnv });
  process.exit(r.status === null ? 1 : r.status);
}

if (existsSync(ps1Path)) {
  // un-ported subcommand: needs PowerShell. Available on Windows; on macOS/Linux only if
  // pwsh was installed -- otherwise a loud, honest advisory (degraded, never a silent crash).
  const pwsh = (spawnSync(process.platform === 'win32' ? 'powershell' : 'pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { stdio: 'ignore' }).status === 0)
    ? (process.platform === 'win32' ? 'powershell' : 'pwsh') : null;
  if (!pwsh) {
    process.stderr.write(`\n[forge] '${command}' is not ported to Node yet -- it runs on PowerShell (Windows). ` +
      `Install PowerShell 7 (pwsh) to run it on this OS, or wait for its Node twin.\n\n`);
    process.exit(3);
  }
  const r = spawnSync(pwsh, ['-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1Path, ...rest], { stdio: 'inherit', env: childEnv });
  process.exit(r.status === null ? 1 : r.status);
}

process.stderr.write(`\nforge: '${command}' is not implemented yet (expected ${base}.mjs or ${base}.ps1 in ${ForgeDir}).\n\n`);
process.exit(2);
