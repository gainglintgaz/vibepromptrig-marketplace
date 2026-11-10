#!/usr/bin/env node
// rule.mjs -- Node twin of rule.ps1 (cross-platform port P2, must-port set).
// forge rule list|show|add|remove|explain -- reads tier frontmatter from docs/rules-reference/factory/*.md and
// reconciles against the current project's profile + user_overrides. `list`/`show` consult the
// effective profile via profile-resolver.mjs (the cross-OS resolver); `add`/`remove` edit
// .forge/profile.json user_overrides at the project root. Dependency-free (Node stdlib),
// node:path throughout, Node >= 18, ESM.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { loadContextManifest } from './context-contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// These files live in scripts/forge/, so the factory root is dirname(dirname(here)).
const FactoryRoot = process.env.VIBE_ROOT || dirname(dirname(here));
const ProjectRoot = process.cwd();
// Every legacy rule body lives outside native autoload since Context V2 Delivery 3b.
const RulesDir = join(FactoryRoot, 'docs', 'rules-reference', 'factory');
const RuleDirs = [RulesDir];
const rulePath = (name) => join(RulesDir, `${name}.md`);
const ProjectProfile = join(ProjectRoot, '.forge', 'profile.json');
const ResolverScript = join(here, 'profile-resolver.mjs'); // sibling -- resolve via own dir, NOT VIBE_ROOT
const ManifestPath = join(FactoryRoot, '.claude', 'rules-manifest.json');
let manifestByLegacy = new Map();
if (existsSync(ManifestPath)) {
  try {
    const loaded = loadContextManifest(ManifestPath, { factoryRoot: FactoryRoot, requireFiles: false });
    manifestByLegacy = new Map(loaded.manifest.rules.map((rule) => [rule.legacy_file, rule]));
    for (const warning of loaded.warnings) process.stderr.write(`[forge rule] WARNING: ${warning}\n`);
  } catch (error) {
    process.stderr.write(`[forge rule] Invalid rules manifest: ${error.message}\n`);
    process.exit(2);
  }
}

// rule.ps1: [Parameter(Position=0)]$SubCommand="list"; [Parameter(Position=1, ValueFromRemaining)]$RestArgs.
const argv = process.argv.slice(2);
const subCommand = argv.length > 0 ? argv[0] : 'list';
const restArgs = argv.slice(1);

// Extract flags from RestArgs (faithful to rule.ps1's switch -Regex loop).
// --available / --all => Available; first non-flag token => NameArg.
let available = false;
let nameArg = '';
for (const a of restArgs) {
  if (/^--available$/i.test(a)) available = true;
  else if (/^--all$/i.test(a)) available = true;
  else if (!nameArg) nameArg = a;
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function normalizeRuleName(name) {
  // PowerShell -replace '\.md$' is case-insensitive -> add 'i' flag.
  return String(name).replace(/\.md$/i, '').trim();
}

function getRuleMeta(rulePath) {
  let content = readFileSync(rulePath, 'utf8');
  const meta = {
    name: basename(rulePath).replace(/\.md$/i, ''),
    tier: 'standard',
    required: false,
    profiles: [],
    title: '',
    summary: '',
    context: null,
  };
  meta.context = manifestByLegacy.get(`${meta.name}.md`) || null;
  // Strip optional BOM.
  if (content.length > 0 && content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }
  let front = '';
  let body = content;
  // (?s)^---\r?\n(.+?)\r?\n---\r?\n(.*)  -- frontmatter block + body.
  const fm = content.match(/^---\s*\r?\n([\s\S]+?)\r?\n---\s*\r?\n([\s\S]*)/);
  if (fm) {
    front = fm[1];
    body = fm[2];
  }
  if (front) {
    for (const line of front.split(/\r?\n/)) {
      let m;
      if ((m = line.match(/^\s*tier:\s*(\S+)/))) meta.tier = m[1];
      else if ((m = line.match(/^\s*required:\s*(true|false)/i))) meta.required = m[1].toLowerCase() === 'true';
      else if ((m = line.match(/^\s*profiles:\s*\[(.+)\]/))) {
        meta.profiles = m[1].split(',').map((s) => s.trim());
      }
    }
    // First H1 = title (multiline match).
    const h1 = body.match(/^#\s+(.+?)\s*$/m);
    if (h1) meta.title = h1[1];
    // First non-blank paragraph after frontmatter that isn't the H1 or a quote.
    const paragraphs = body.split(/(?:\r?\n){2,}/);
    for (let p of paragraphs) {
      p = p.trim();
      if (!p) continue;
      if (/^#/.test(p)) continue;
      if (/^>/.test(p)) continue;
      meta.summary = p.split(/\r?\n/)[0];
      break;
    }
  }
  return meta;
}

function getAllRules() {
  return RuleDirs.filter((dir) => existsSync(dir)).flatMap((dir) => readdirSync(dir)
    .filter((f) => /\.md$/i.test(f))
    .map((f) => getRuleMeta(join(dir, f))));
}

function getEffectiveProfile() {
  if (existsSync(ResolverScript)) {
    const r = spawnSync(
      process.execPath,
      [ResolverScript, '--project-root', ProjectRoot, '--factory-root', FactoryRoot, '--json'],
      { encoding: 'utf8' }
    );
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    try {
      return JSON.parse(out).effective;
    } catch {
      return null;
    }
  }
  return null;
}

function getProjectProfileRaw() {
  if (existsSync(ProjectProfile)) {
    try {
      return JSON.parse(readFileSync(ProjectProfile, 'utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

function saveProjectProfile(profile) {
  // Genuine UTC (the .ps1's literal-Z 'yyyy-MM-ddTHH:mm:ssZ' was local-time-with-a-Z; this is true UTC).
  profile.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  // UTF-8, no BOM; 2-space indent matching the forge profile.mjs ecosystem; trailing newline.
  writeFileSync(ProjectProfile, JSON.stringify(profile, null, 2) + '\n');
}

function emptyOverrides() {
  return {
    rules_added: [],
    rules_removed: [],
    agents_added: [],
    agents_removed: [],
    skills_added: [],
    skills_removed: [],
    hooks_added: [],
    hooks_removed: [],
  };
}

function testRuleActive(ruleMeta, effectiveProfile) {
  if (!effectiveProfile) return ruleMeta.required;

  const profName = effectiveProfile.profile;
  let active;
  // required rules always active.
  if (ruleMeta.required) active = true;
  else if (ruleMeta.profiles && ruleMeta.profiles.includes(profName)) active = true;
  else active = false;

  // user_overrides.
  const rp = getProjectProfileRaw();
  if (rp && rp.user_overrides) {
    const added = rp.user_overrides.rules_added || [];
    const removed = rp.user_overrides.rules_removed || [];
    if (added.includes(ruleMeta.name)) active = true;
    if (removed.includes(ruleMeta.name) && !ruleMeta.required) active = false;
  }
  return active;
}

// String formatting helpers (PowerShell -f "{0,-32}" => left-justify; "{2,-7}" => left-justify).
function padRight(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

const out = (s) => process.stdout.write(s + '\n');

// ----------------------------------------------------------------
// Subcommands
// ----------------------------------------------------------------
switch (subCommand) {
  case 'list': {
    const effective = getEffectiveProfile();
    const rules = getAllRules().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    out('');
    if (available) {
      out(`All rules (${rules.length} total)`);
      const profName = effective ? effective.profile : '(no profile)';
      out(`  Current profile: ${profName}`);
      out('');
      out('  ' + padRight('RULE', 32) + ' ' + padRight('TIER', 10) + ' ' + padRight('ACTIVE', 7) + ' ' + 'PROFILES');
      for (const r of rules) {
        const act = testRuleActive(r, effective);
        const glyph = act ? 'yes' : 'no';
        const profs = r.profiles && r.profiles.length ? r.profiles.join(',') : '-';
        out('  ' + padRight(r.name, 32) + ' ' + padRight(r.tier, 10) + ' ' + padRight(glyph, 7) + ' ' + profs);
      }
    } else {
      const activeRules = rules.filter((r) => testRuleActive(r, effective));
      const profName = effective ? effective.profile : '(no profile)';
      out(`Active rules for profile: ${profName}`);
      out(`  ${activeRules.length} of ${rules.length} rule files loaded`);
      out('');
      for (const r of activeRules) {
        const tierLabel = r.required ? `${r.tier} (required)` : r.tier;
        out('  ' + padRight(r.name, 32) + ' ' + tierLabel);
      }
      out('');
      out("Run 'forge rule list --available' for all rules + which profiles load them.");
    }
    out('');
    break;
  }

  case 'show': {
    if (!nameArg) {
      process.stderr.write('Usage: forge rule show <name>\n');
      process.exit(1);
    }
    const name = normalizeRuleName(nameArg);
    const path = rulePath(name);
    if (!existsSync(path)) {
      out(`No rule named '${name}'. Run 'forge rule list --available' to see options.`);
      process.exit(1);
    }
    const r = getRuleMeta(path);
    const effective = getEffectiveProfile();
    const act = testRuleActive(r, effective);

    out('');
    out(r.name);
    if (r.title) out(`  ${r.title}`);
    out('');
    out(`  Tier:      ${r.tier}`);
    out(`  Required:  ${r.required ? 'yes' : 'no'}`);
    out(`  Profiles:  ${r.profiles && r.profiles.length ? r.profiles.join(', ') : '-'}`);
    out(`  Active:    ${act ? 'yes (in current profile)' : 'no (not loaded for current profile)'}`);
    if (r.context) {
      out(`  Stable ID: ${r.context.id}`);
      out(`  Card:      ${r.context.card} (v${r.context.card_version})`);
      out(`  Reference: ${r.context.reference} (v${r.context.reference_version})`);
      out(`  Gate:      tier ${r.context.enforcement.tier} ${r.context.enforcement.kind}`);
    }
    if (r.summary) {
      out('');
      let summary = r.summary;
      if (summary.length > 300) summary = summary.substring(0, 300) + '...';
      out(`  ${summary}`);
    }
    out('');
    out(`  Full text: ${path}`);
    out('');
    break;
  }

  case 'add': {
    if (!nameArg) {
      process.stderr.write('Usage: forge rule add <name>\n');
      process.exit(1);
    }
    const name = normalizeRuleName(nameArg);
    const path = rulePath(name);
    if (!existsSync(path)) {
      out(`No rule named '${name}'. Run 'forge rule list --available' to see options.`);
      process.exit(1);
    }
    const rp = getProjectProfileRaw();
    if (!rp) {
      out("No project profile yet. Run 'forge init' first.");
      process.exit(1);
    }
    if (!rp.user_overrides) rp.user_overrides = emptyOverrides();
    const added = rp.user_overrides.rules_added || [];
    let removed = rp.user_overrides.rules_removed || [];
    if (added.includes(name)) {
      out(`Rule '${name}' already in user_overrides.rules_added.`);
      process.exit(0);
    }
    added.push(name);
    removed = removed.filter((x) => x !== name);
    rp.user_overrides.rules_added = added;
    rp.user_overrides.rules_removed = removed;
    saveProjectProfile(rp);
    out(`Added '${name}' to user_overrides.rules_added.`);
    out("  Run 'forge rule list' to confirm.");
    break;
  }

  case 'remove': {
    if (!nameArg) {
      process.stderr.write('Usage: forge rule remove <name>\n');
      process.exit(1);
    }
    const name = normalizeRuleName(nameArg);
    const path = rulePath(name);
    if (!existsSync(path)) {
      out(`No rule named '${name}'.`);
      process.exit(1);
    }
    const r = getRuleMeta(path);
    if (r.required) {
      out(`Cannot remove '${name}': it is marked 'required: true' in frontmatter.`);
      out('  Required rules ship with every profile and cannot be opted out of.');
      process.exit(1);
    }
    const rp = getProjectProfileRaw();
    if (!rp) {
      out("No project profile yet. Run 'forge init' first.");
      process.exit(1);
    }
    if (!rp.user_overrides) rp.user_overrides = emptyOverrides();
    let added = rp.user_overrides.rules_added || [];
    const removed = rp.user_overrides.rules_removed || [];
    if (removed.includes(name)) {
      out(`Rule '${name}' already in user_overrides.rules_removed.`);
      process.exit(0);
    }
    removed.push(name);
    added = added.filter((x) => x !== name);
    rp.user_overrides.rules_added = added;
    rp.user_overrides.rules_removed = removed;
    saveProjectProfile(rp);
    out(`Added '${name}' to user_overrides.rules_removed.`);
    out("  Run 'forge rule list' to confirm.");
    break;
  }

  case 'explain': {
    out('');
    out('Rule tier system');
    out('');
    out('  Every rule file in docs/rules-reference/factory/ declares a tier in its frontmatter:');
    out('');
    out('    essential  Safety + correctness. Loads in EVERY profile, every time.');
    out('               Examples: privacy, data-protection, execution, vibe-standard.');
    out('');
    out('    standard   Useful for most production work. Loads in solo-pro and up.');
    out('               Examples: hostile-architect, data-integrity, secrets-handling.');
    out('');
    out('    full       Specialist guidance (agency, consulting, AI architecture).');
    out('               Loads in senior-dev, agency, enterprise.');
    out('');
    out('  How activation actually works:');
    out("    1. If a rule is 'required: true', it loads regardless of profile.");
    out("    2. Otherwise, it loads if the profile is listed in its 'profiles:' field.");
    out('    3. Then user_overrides.rules_added / rules_removed apply on top.');
    out('');
    out('  Tweak rules per project:');
    out('    forge rule add <name>     Force a rule on (e.g., add consulting to a solo project).');
    out('    forge rule remove <name>  Opt out of a non-required rule.');
    out('');
    break;
  }

  default: {
    out('');
    out(`Unknown subcommand: ${subCommand}`);
    out('Usage:');
    out('  forge rule list              # active rules in current profile');
    out('  forge rule list --available  # all rules + tier + profiles');
    out('  forge rule show <name>       # display one rule\'s frontmatter');
    out('  forge rule add <name>        # force-add to user_overrides');
    out('  forge rule remove <name>     # opt out (if not required)');
    out('  forge rule explain           # plain-English tier explainer');
    out('');
    process.exit(1);
  }
}
