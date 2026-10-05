#!/usr/bin/env node
// profile.mjs -- Node twin of profile.ps1 (cross-platform port P2, T1c-3c-B).
// forge profile show / set <name> / get <field> / list. Manages .forge/profile.json at the
// project root; `show`/`get` delegate to profile-resolver.mjs (the cross-OS resolver), `set`
// copies a preset + activates the tier-filtered AGENTS-<name>.md -> AGENTS.md, `list` enumerates
// presets. Dependency-free (Node stdlib), node:path throughout, Node >= 18.

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const FactoryRoot = process.env.VIBE_ROOT || dirname(dirname(here));
const ProjectRoot = process.cwd();
const PresetsDir = join(FactoryRoot, '.forge', 'profiles');
const ProjectProfile = join(ProjectRoot, '.forge', 'profile.json');
const ResolverScript = join(FactoryRoot, 'scripts', 'forge', 'profile-resolver.mjs');
const ContextScript = join(FactoryRoot, 'scripts', 'forge', 'context.mjs');

const argv = process.argv.slice(2);
// Position-0 is the subcommand (default 'show' when absent), matching profile.ps1's
// [Parameter(Position=0)]$SubCommand='show'. A leading flag (e.g. `profile --json`) therefore
// binds as the subcommand -> falls through to the default branch (Unknown subcommand, exit 1),
// exactly as the .ps1 does -- NOT silently rerouted to `show`.
const subCommand = argv.length > 0 ? argv[0] : 'show';
const rest = argv.slice(1);
let arg = '';
let verboseFlag = false, jsonFlag = false, terseFlag = false;
for (const a of rest) {
  if (a === '--verbose') verboseFlag = true;
  else if (a === '--json') jsonFlag = true;
  else if (a === '--terse') terseFlag = true;
  else if (!arg && !a.startsWith('--')) arg = a;
}

function runResolver(extra) {
  const r = spawnSync(process.execPath, [ResolverScript, '--project-root', ProjectRoot, '--factory-root', FactoryRoot, ...extra], { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
}
function presetFiles() {
  if (!existsSync(PresetsDir)) return [];
  return readdirSync(PresetsDir).filter((f) => f.toLowerCase().endsWith('.json')).sort();
}
function commas(n) { return String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

switch (subCommand) {
  case 'show': {
    if (!existsSync(ResolverScript)) { process.stderr.write(`Profile resolver missing: ${ResolverScript}\n`); process.exit(1); }
    if (verboseFlag) runResolver(['--verbose-output']);
    else if (jsonFlag) runResolver(['--json']);
    else if (terseFlag) runResolver(['--terse']);
    else runResolver(['--pretty']);
    break;
  }
  case 'set': {
    if (!arg) { process.stderr.write('Usage: forge profile set <name>  (presets: indie-free, solo-pro, senior-dev, agency, enterprise)\n'); process.exit(1); }
    const presetPath = join(PresetsDir, `${arg}.json`);
    if (!existsSync(presetPath)) {
      process.stdout.write(`\nUnknown preset: ${arg}\nAvailable presets:\n`);
      for (const f of presetFiles()) process.stdout.write(`  ${f.slice(0, -5)}\n`);
      process.stdout.write('\n');
      process.exit(1);
    }
    const forgeDirInProject = join(ProjectRoot, '.forge');
    if (!existsSync(forgeDirInProject)) mkdirSync(forgeDirInProject, { recursive: true });
    const preset = JSON.parse(readFileSync(presetPath, 'utf8'));
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    preset.created_at = now;
    preset.updated_at = now;
    writeFileSync(ProjectProfile, JSON.stringify(preset, null, 2) + '\n');
    // Profile settings are consumed by the resolver; they do not authorize an editor to load
    // a full aggregate. Refresh only the compact, hash-checked project entrypoint.
    const install = existsSync(ContextScript)
      ? spawnSync(process.execPath, [ContextScript, 'install', '--project-root', ProjectRoot], { encoding: 'utf8', env: { ...process.env, VIBE_ROOT: FactoryRoot } })
      : null;
    process.stdout.write(`\nProfile set: ${arg}\n  Written to: ${ProjectProfile}\n`);
    if (!install) process.stdout.write('  Advisory:    compact entrypoint not installed (context command unavailable)\n');
    else if (install.status === 0) process.stdout.write('  Installed:   compact project entrypoint (native loading remains host-dependent)\n');
    else process.stdout.write(`  Advisory:    compact entrypoint needs review (${(install.stderr || install.stdout || '').trim().slice(0, 160)})\n`);
    process.stdout.write("\nRun 'forge profile show' to see effective config.\n\n");
    break;
  }
  case 'get': {
    if (!arg) { process.stderr.write('Usage: forge profile get <field>\n'); process.exit(1); }
    if (!existsSync(ResolverScript)) { process.stderr.write(`Profile resolver missing: ${ResolverScript}\n`); process.exit(1); }
    runResolver(['--field', arg]);
    break;
  }
  case 'list': {
    process.stdout.write('\nAvailable profile presets:\n\n');
    for (const f of presetFiles()) {
      const p = JSON.parse(readFileSync(join(PresetsDir, f), 'utf8'));
      const agents = (p.agents_enabled || []).length, skills = (p.skills_enabled || []).length, hooks = (p.hooks_enabled || []).length;
      process.stdout.write(`  ${f.slice(0, -5).padEnd(14)}  session_budget=${commas(p.session_budget_tokens).padStart(9)}  agents=${String(agents).padStart(2)}  skills=${String(skills).padStart(2)}  hooks=${String(hooks).padStart(2)}\n`);
    }
    process.stdout.write('\nTo set: forge profile set <name>\n\n');
    break;
  }
  default:
    process.stdout.write(`\nUnknown subcommand: ${subCommand}\nUsage:\n  forge profile show\n  forge profile set <name>\n  forge profile get <field>\n  forge profile list\n\n`);
    process.exit(1);
}
