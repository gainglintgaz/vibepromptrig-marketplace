#!/usr/bin/env node
// profile-resolver.mjs -- Node twin of profile-resolver.ps1 (cross-platform port P2, T1c).
// Resolves the effective VibePromptRig profile (project > factory default > built-in fallback),
// merges the named preset underneath, applies user_overrides, and emits the effective config.
// Consumed by forge doctor, test-factory, and the budget hooks (-Json / -Field / -Terse).
// Dependency-free (Node stdlib), node:path throughout, Node >= 18.
//
// Usage: node profile-resolver.mjs [--project-root <p>] [--factory-root <f>]
//          [--json] [--terse] [--verbose-output] [--pretty] [--field <name>]
// (also accepts the PowerShell-style -ProjectRoot / -FactoryRoot / -Json / -Terse /
//  -Verbose_Output / -Pretty / -Field flags)

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const o = { projectRoot: process.cwd(), factoryRoot: process.env.VIBE_ROOT || '', pretty: false, verbose: false, json: false, terse: false, field: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i].toLowerCase();
    if (a === '-projectroot' || a === '--project-root') o.projectRoot = argv[++i];
    else if (a === '-factoryroot' || a === '--factory-root') o.factoryRoot = argv[++i];
    else if (a === '-pretty' || a === '--pretty') o.pretty = true;
    else if (a === '-verbose_output' || a === '--verbose-output') o.verbose = true;
    else if (a === '-json' || a === '--json') o.json = true;
    else if (a === '-terse' || a === '--terse') o.terse = true;
    else if (a === '-field' || a === '--field') o.field = argv[++i];
  }
  return o;
}
const args = parseArgs(process.argv.slice(2));
const ProjectRoot = args.projectRoot;
const FactoryRoot = args.factoryRoot || dirname(dirname(here));

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// --- Step 2: load active profile (project > factory default > built-in fallback) ---
const projectProfilePath = join(ProjectRoot, '.forge', 'profile.json');
const factoryDefaultPath = join(FactoryRoot, '.forge', 'default-profile.json');
const presetsDir = join(FactoryRoot, '.forge', 'profiles');

let active, activeSource;
if (existsSync(projectProfilePath)) { active = readJson(projectProfilePath); activeSource = `project (${projectProfilePath})`; }
else if (existsSync(factoryDefaultPath)) { active = readJson(factoryDefaultPath); activeSource = `factory (${factoryDefaultPath})`; }
else {
  active = {
    profile: 'indie-free', ai_plan: 'claude-free', byok: false, monthly_budget_tokens: 500000,
    session_budget_tokens: 50000, verbosity: 'terse', rule_tier: 'essential', agents_enabled: [],
    skills_enabled: ['catchup', 'today', 'ship-status'], hooks_enabled: ['destructive-sql-blocker'],
    subagent_dispatch_threshold_tokens: 0, compaction_trigger_percent: 50, tool_result_truncation_kb: 10,
    llm_cache_ttl_hours: 168, vertical_pack: null, compliance_overlay: [],
    user_overrides: { rules_added: [], rules_removed: [], agents_added: [], agents_removed: [], skills_added: [], skills_removed: [], hooks_added: [], hooks_removed: [] },
    factory_version_at_init: 'v4.4',
  };
  activeSource = 'built-in fallback (no profile files found)';
}

// --- Step 3: merge named preset underneath (preset fills missing/null keys, except vertical_pack) ---
if (active.profile && active.profile !== 'custom') {
  const presetPath = join(presetsDir, `${active.profile}.json`);
  if (existsSync(presetPath)) {
    const preset = readJson(presetPath);
    for (const k of Object.keys(preset)) {
      const missing = !Object.prototype.hasOwnProperty.call(active, k);
      const nullExceptPack = (active[k] === null || active[k] === undefined) && k !== 'vertical_pack';
      if (missing || nullExceptPack) active[k] = preset[k];
    }
  }
}

// --- Step 4: apply user_overrides ---
function applyOverrides(base, added, removed) {
  base = base || []; added = added || []; removed = removed || [];
  return [...new Set([...base, ...added])].filter((x) => !removed.includes(x));
}
const ov = active.user_overrides || {};
const effectiveAgents = applyOverrides(active.agents_enabled, ov.agents_added, ov.agents_removed);
const effectiveSkills = applyOverrides(active.skills_enabled, ov.skills_added, ov.skills_removed);
const effectiveHooks = applyOverrides(active.hooks_enabled, ov.hooks_added, ov.hooks_removed);

// --- Step 5: effective config ---
const effective = {
  profile: active.profile, ai_plan: active.ai_plan, byok: active.byok,
  monthly_budget_tokens: active.monthly_budget_tokens, session_budget_tokens: active.session_budget_tokens,
  verbosity: active.verbosity, rule_tier: active.rule_tier,
  agents_effective: effectiveAgents, skills_effective: effectiveSkills, hooks_effective: effectiveHooks,
  subagent_dispatch_threshold_tokens: active.subagent_dispatch_threshold_tokens,
  compaction_trigger_percent: active.compaction_trigger_percent,
  tool_result_truncation_kb: active.tool_result_truncation_kb,
  llm_cache_ttl_hours: active.llm_cache_ttl_hours, vertical_pack: active.vertical_pack,
  compliance_overlay: active.compliance_overlay, factory_version_at_init: active.factory_version_at_init,
  _meta: { project_root: ProjectRoot, factory_root: FactoryRoot, source: activeSource, resolved_at: new Date().toISOString() },
};

// --- Step 6: -Field ---
if (args.field) {
  if (Object.prototype.hasOwnProperty.call(effective, args.field)) { process.stdout.write(String(effective[args.field]) + '\n'); process.exit(0); }
  process.stderr.write(`Field not found: ${args.field}\n`); process.exit(1);
}

// --- Step 7: plan info ---
let planInfo = null;
const translationsPath = join(FactoryRoot, '.forge', 'plan-translations.json');
if (existsSync(translationsPath)) {
  try { planInfo = readJson(translationsPath).plans?.[effective.ai_plan] ?? null; } catch { planInfo = null; }
}

function fmtTokens(t) {
  t = Number(t) || 0;
  if (t >= 1000000) return `${(t / 1000000).toFixed(1)}M`;
  if (t >= 1000) return `${Math.round(t / 1000)}K`;
  return String(t);
}

// --- Step 8: usage (factory_metrics.jsonl) ---
const usage = { today: 0, week: 0, month: 0, has_data: false };
const metricsPath = join(FactoryRoot, 'factory_metrics.jsonl');
if (existsSync(metricsPath)) {
  const now = Date.now();
  const dayMs = 86400000;
  const todayStart = new Date(new Date().toDateString()).getTime();
  const weekStart = todayStart - 7 * dayMs;
  const monthStart = todayStart - 30 * dayMs;
  for (const line of readFileSync(metricsPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      const ts = Date.parse(e.ts);
      if (Number.isNaN(ts)) continue;
      const used = (parseInt(e.tokens_in, 10) || 0) + (parseInt(e.tokens_out, 10) || 0);
      if (ts >= todayStart) usage.today += used;
      if (ts >= weekStart) usage.week += used;
      if (ts >= monthStart) usage.month += used;
      usage.has_data = true;
    } catch { /* skip */ }
  }
  void now;
}

// --- Step 9: output ---
if (args.json) {
  process.stdout.write(JSON.stringify({ effective, plan_info: planInfo, usage }, null, 2) + '\n');
  process.exit(0);
}
if (args.terse) {
  const planName = planInfo ? planInfo.display_name : effective.ai_plan;
  console.log(`forge: ${effective.profile} | plan ${planName} | session ${fmtTokens(effective.session_budget_tokens)} (${effective.agents_effective.length} agents, ${effective.skills_effective.length} skills, ${effective.hooks_effective.length} hooks)`);
  process.exit(0);
}
if (args.verbose || args.pretty) {
  // Human display (forge profile show). Not parity-asserted (no machine consumer); a faithful summary.
  console.log('');
  console.log('VibePromptRig profile (effective)');
  console.log(`  Source            : ${effective._meta.source}`);
  console.log(`  Profile           : ${effective.profile}`);
  console.log(`  AI plan           : ${planInfo ? `${planInfo.display_name} (${planInfo.cost})` : effective.ai_plan}`);
  console.log(`  Session budget    : ${fmtTokens(effective.session_budget_tokens)} tokens`);
  console.log(`  Monthly budget    : ${fmtTokens(effective.monthly_budget_tokens)} tokens`);
  console.log(`  Rule tier         : ${effective.rule_tier}`);
  console.log(`  Active agents     : ${effective.agents_effective.length}`);
  console.log(`  Active skills     : ${effective.skills_effective.length}`);
  console.log(`  Active hooks      : ${effective.hooks_effective.length}`);
  if (effective.vertical_pack) console.log(`  Vertical pack     : ${effective.vertical_pack}`);
  if (usage.has_data) console.log(`  Usage (30d)       : ${fmtTokens(usage.month)} tokens`);
  console.log('');
  process.exit(0);
}

// No flags -- default to JSON (the effective object, matching profile-resolver.ps1 default).
process.stdout.write(JSON.stringify(effective, null, 2) + '\n');
process.exit(0);
