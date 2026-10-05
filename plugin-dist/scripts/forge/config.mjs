#!/usr/bin/env node
// config.mjs -- Node twin of config.ps1 (cross-platform port P2, must-port set).
// forge config list | get <field> | set <field> <value> | show <type> <name> | reset <type> <name>
// | reload. Reads/writes scalar fields on the project's .forge/profile.json (validated against a
// field whitelist), and drives the v5.0 override-layer subcommands. `list`/`get` delegate to the
// cross-OS profile-resolver.mjs; `show` delegates to resolve-config.mjs (the override resolver) --
// neither resolution/merge path is reimplemented here. Dependency-free (Node stdlib), node:path
// throughout, Node >= 18, ESM, UTF-8 no-BOM writes, genuine UTC timestamps.

import { existsSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
// These files live in scripts/forge/, so the factory root is dirname(dirname(scriptDir)).
const FactoryRoot = process.env.VIBE_ROOT || dirname(dirname(here));
const ProjectRoot = process.cwd();
const ProjectProfile = join(ProjectRoot, '.forge', 'profile.json');
const ResolverScript = join(here, 'profile-resolver.mjs'); // sibling -- resolve via own dir, NOT VIBE_ROOT
const TranslationsPath = join(FactoryRoot, '.forge', 'plan-translations.json');

// ----------------------------------------------------------------
// Field schema: name -> { type, validate, hint }   (mirrors config.ps1 $Schema)
// ----------------------------------------------------------------
const Schema = {
  verbosity: {
    type: 'enum',
    values: ['terse', 'standard', 'verbose'],
    hint: 'Output verbosity for forge commands.',
  },
  rule_tier: {
    type: 'enum',
    values: ['essential', 'standard', 'full'],
    hint: 'Minimum tier of rules to load.',
  },
  compaction_trigger_percent: {
    type: 'int',
    min: 50,
    max: 95,
    hint: '% of context window before triggering compaction.',
  },
  session_budget_tokens: {
    type: 'int',
    min: 10000,
    max: 100000000,
    hint: 'Tokens allowed in a single session before warning. (Max raised 1M -> 100M 2026-06-09: measured heavy factory sessions run 8-11M new tokens; the old max made honest calibration impossible.)',
  },
  monthly_budget_tokens: {
    type: 'int',
    min: 100000,
    max: 2147000000,
    hint: 'Tokens allowed per month before warning. (Max raised 100M -> ~2.147B (int32-safe) 2026-06-09: measured June month-to-date was 518M deduped new tokens in 9 days.)',
  },
  subagent_dispatch_threshold_tokens: {
    type: 'int',
    min: 1000,
    max: 100000,
    hint: 'Token threshold above which to dispatch subagents.',
  },
  tool_result_truncation_kb: {
    type: 'int',
    min: 5,
    max: 200,
    hint: 'Max KB of tool result before truncation.',
  },
  llm_cache_ttl_hours: {
    type: 'int',
    min: 1,
    max: 720,
    hint: 'TTL (hours) for cached LLM responses.',
  },
  ai_plan: {
    type: 'string',
    hint: 'AI subscription plan key (see plan-translations.json).',
  },
  byok: {
    type: 'bool',
    hint: 'Bring your own API key (true/false).',
  },
  vertical_pack: {
    type: 'string-or-null',
    hint: 'Vertical specialization pack (e.g., fintech, healthcare). null for none.',
  },
};

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
function getProjectProfileRaw() {
  if (existsSync(ProjectProfile)) {
    return JSON.parse(readFileSync(ProjectProfile, 'utf8'));
  }
  return null;
}

function saveProjectProfile(profile) {
  // genuine UTC, matching the .ps1's 'yyyy-MM-ddTHH:mm:ssZ' shape (the .ps1's literal Z was local
  // time; the twin emits real UTC, dropping milliseconds to keep the second-precision Z form).
  profile.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  // ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 -> UTF-8 no-BOM + trailing newline.
  writeFileSync(ProjectProfile, JSON.stringify(profile, null, 2) + '\n');
}

function parseValue(fieldName, rawValue) {
  const s = Schema[fieldName];
  switch (s.type) {
    case 'int': {
      if (!/^-?\d+$/.test(rawValue)) {
        throw new Error(`Field '${fieldName}' expects integer, got '${rawValue}'.`);
      }
      const n = parseInt(rawValue, 10);
      if (s.min !== undefined && s.min !== null && n < s.min) throw new Error(`Field '${fieldName}' min is ${s.min}, got ${n}.`);
      if (s.max !== undefined && s.max !== null && n > s.max) throw new Error(`Field '${fieldName}' max is ${s.max}, got ${n}.`);
      return n;
    }
    case 'enum': {
      if (!s.values.includes(rawValue)) {
        throw new Error(`Field '${fieldName}' must be one of: ${s.values.join(', ')}. Got '${rawValue}'.`);
      }
      return rawValue;
    }
    case 'bool': {
      // PowerShell switch -Regex is CASE-INSENSITIVE -> add the 'i' flag.
      if (/^(true|yes|1|on)$/i.test(rawValue)) return true;
      if (/^(false|no|0|off)$/i.test(rawValue)) return false;
      throw new Error(`Field '${fieldName}' expects bool (true/false), got '${rawValue}'.`);
    }
    case 'string-or-null': {
      if (['null', 'none', ''].includes(rawValue)) return null;
      return rawValue;
    }
    case 'string':
      return rawValue;
    default:
      return rawValue;
  }
}

// Run the cross-OS profile-resolver.mjs, inheriting stdio, and exit with its status.
function runResolver(extra) {
  const r = spawnSync(process.execPath, [ResolverScript, '--project-root', ProjectRoot, '--factory-root', FactoryRoot, ...extra], { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
}

// ----------------------------------------------------------------
// Arg parsing (mirrors config.ps1 positional params; default subcommand 'list')
// ----------------------------------------------------------------
const argv = process.argv.slice(2);
const subCommand = argv.length > 0 ? argv[0] : 'list';
const field = argv.length > 1 ? argv[1] : '';
const valueArgs = argv.slice(2); // ValueFromRemainingArguments

// ----------------------------------------------------------------
// Subcommands
// ----------------------------------------------------------------
switch (subCommand) {

  case 'list': {
    // Use resolver so we display effective (project OR factory-default) values.
    let effective = null;
    try {
      const r = spawnSync(process.execPath, [ResolverScript, '--project-root', ProjectRoot, '--factory-root', FactoryRoot, '--json'], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout) {
        effective = JSON.parse(r.stdout).effective;
      }
    } catch { /* leave effective null */ }

    const rp = getProjectProfileRaw();
    console.log('');
    console.log('Tunable config fields');
    console.log(`  Project: ${ProjectRoot}`);
    if (!rp) {
      console.log('  (No .forge/profile.json yet -- showing effective values from factory default.)');
      console.log("  Run 'forge init' to write a project-level profile.");
    }
    console.log('');
    const keys = Object.keys(Schema);
    let maxLen = keys.reduce((m, k) => Math.max(m, k.length), 0);
    if (!maxLen) maxLen = 32;
    for (const k of keys.slice().sort()) {
      let current = effective ? effective[k] : null;
      if (rp && rp[k] !== null && rp[k] !== undefined) current = rp[k];
      const display = (current === null || current === undefined) ? '(null)' : String(current);
      console.log(`  ${k.padEnd(maxLen)}  ${display}`);
      console.log(`  ${''.padEnd(maxLen)}    ${Schema[k].hint}`);
    }
    console.log('');
    console.log('Set:  forge config set <field> <value>');
    console.log('Get:  forge config get <field>');
    console.log('');
    break;
  }

  case 'get': {
    if (!field) {
      process.stderr.write('Usage: forge config get <field>\n');
      process.exit(1);
    }
    if (!Object.prototype.hasOwnProperty.call(Schema, field)) {
      console.log(`Unknown field: ${field}`);
      console.log("Run 'forge config list' to see tunable fields.");
      process.exit(1);
    }
    runResolver(['--field', field]);
    break;
  }

  case 'set': {
    if (!field) {
      process.stderr.write('Usage: forge config set <field> <value>\n');
      process.exit(1);
    }
    if (!Object.prototype.hasOwnProperty.call(Schema, field)) {
      console.log(`Unknown field: ${field}`);
      console.log("Run 'forge config list' to see tunable fields.");
      process.exit(1);
    }
    if (!valueArgs || valueArgs.length === 0) {
      process.stderr.write(`Usage: forge config set ${field} <value>\n`);
      process.exit(1);
    }
    const raw = valueArgs[0];
    let parsed;
    try {
      parsed = parseValue(field, raw);
    } catch (e) {
      console.log(e.message);
      console.log(`Hint: ${Schema[field].hint}`);
      process.exit(1);
    }

    const rp = getProjectProfileRaw();
    if (!rp) {
      console.log("No project profile yet. Run 'forge init' first.");
      process.exit(1);
    }

    // Special-case ai_plan: warn if not in translations.
    if (field === 'ai_plan' && existsSync(TranslationsPath)) {
      try {
        const t = JSON.parse(readFileSync(TranslationsPath, 'utf8'));
        if (!t.plans || t.plans[parsed] === null || t.plans[parsed] === undefined) {
          console.log(`Warning: '${parsed}' is not in plan-translations.json.`);
          console.log("  Recording anyway. Run 'forge config list' afterwards to confirm.");
        }
      } catch { /* if translations unreadable, skip the warning (matches .ps1 best-effort) */ }
    }

    const oldValue = Object.prototype.hasOwnProperty.call(rp, field) ? rp[field] : null;
    rp[field] = parsed;
    saveProjectProfile(rp);

    const oldDisplay = (oldValue === null || oldValue === undefined) ? '(null)' : String(oldValue);
    const newDisplay = (parsed === null || parsed === undefined) ? '(null)' : String(parsed);
    console.log('');
    console.log(`Set ${field}`);
    console.log(`  Was:  ${oldDisplay}`);
    console.log(`  Now:  ${newDisplay}`);
    console.log('');
    break;
  }

  case 'show': {
    // v5.0: print resolved override-layer config. field = artifact-type, valueArgs[0] = name.
    const artifactType = field;
    const name = (valueArgs && valueArgs.length > 0) ? valueArgs[0] : '';
    const valid = ['agent-config', 'routine', 'skill', 'rule-override', 'model-router', 'workflow'];
    if (!artifactType || !valid.includes(artifactType)) {
      console.log('Usage: forge config show <type> <name>');
      console.log(`  <type> one of: ${valid.join(', ')}`);
      process.exit(1);
    }
    if (!name) {
      console.log(`Usage: forge config show ${artifactType} <name>`);
      process.exit(1);
    }
    const resolver = join(here, 'resolve-config.mjs'); // sibling -- resolve via own dir, NOT VIBE_ROOT
    const r = spawnSync(process.execPath, [resolver, '--artifact-type', artifactType, '--name', name, '--project-root', ProjectRoot, '--factory-root', FactoryRoot, '--json'], { stdio: 'inherit' });
    process.exit(r.status === null ? 1 : r.status);
    break;
  }

  case 'reset': {
    // v5.0: revert an artifact to factory default. Back up the customer file first.
    const artifactType = field;
    const name = (valueArgs && valueArgs.length > 0) ? valueArgs[0] : '';
    const fileMap = {
      'agent-config': join('.forge', 'agent-configs', `${name}.json`),
      'routine': join('.forge', 'routines.json'),
      'skill': join('.forge', 'active-skills.json'),
      'rule-override': join('.forge', 'rule-overrides.json'),
      'model-router': join('.forge', 'provider-prefs.json'),
      'workflow': join('.forge', 'workflows', `${name}.json`),
    };
    if (!Object.prototype.hasOwnProperty.call(fileMap, artifactType)) {
      console.log('Usage: forge config reset <type> <name>');
      console.log(`  <type> one of: ${Object.keys(fileMap).join(', ')}`);
      process.exit(1);
    }
    const target = join(ProjectRoot, fileMap[artifactType]);
    if (!existsSync(target)) {
      console.log(`No customer override at ${target} -- already at factory default.`);
      process.exit(1);
    }
    // PowerShell 'yyyyMMdd-HHmmss' stamp -- LOCAL time (the .ps1 used Get-Date with no UTC).
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    const backup = `${target}.bak-${stamp}`;
    copyFileSync(target, backup);
    rmSync(target, { force: true });
    console.log('');
    console.log(`Reset ${artifactType} '${name}' to factory default.`);
    console.log(`  Backed up customer override to: ${backup}`);
    console.log('');
    process.exit(0);
    break;
  }

  case 'reload': {
    // v5.0 A6: clear the session config lock so the next resolution re-reads .forge/ fresh.
    const lock = join(ProjectRoot, '.forge', '.config-lock.json');
    if (existsSync(lock)) {
      rmSync(lock, { force: true });
      console.log('Config lock cleared. Next resolution will re-read .forge/ fresh.');
    } else {
      console.log('No session config lock present. Resolution already re-reads .forge/ on next access.');
    }
    process.exit(0);
    break;
  }

  default: {
    console.log('');
    console.log(`Unknown subcommand: ${subCommand}`);
    console.log('Usage:');
    console.log('  forge config list                # show all tunable fields + current values');
    console.log("  forge config get <field>         # print one field's value");
    console.log('  forge config set <field> <value> # update one field (validates type/range)');
    console.log('  forge config show <type> <name>  # print resolved override-layer config (v5.0)');
    console.log('  forge config reset <type> <name> # revert artifact to factory default (v5.0)');
    console.log('  forge config reload              # clear session config lock (v5.0)');
    console.log('');
    process.exit(1);
  }
}
