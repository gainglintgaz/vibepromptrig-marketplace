#!/usr/bin/env node
// resolve-config.mjs -- the v5.0 override-layer config resolver. CODE, zero LLM tokens (A1).
// Node twin of resolve-config.ps1 (cross-platform port P2, T1c). Resolves the EFFECTIVE config
// for one artifact by merging the customer's .forge/ override onto the factory default, per the
// per-artifact-type merge semantics in config-lib.mjs (A2). NEVER mutates shared core.
//
// Fail-loud (A4): on any violation it writes "RESOLVER ERROR: ..." to stderr and exits non-zero.
// Honors A1/A3/A4/A5/A7/A10 with the same error-message substrings the parity test greps.
// Dependency-free (Node stdlib), Node >= 18.
//
// Usage: node resolve-config.mjs --artifact-type <t> --name <n> [--project-root <p>]
//          [--factory-root <f>] [--json] [--skip-tier-check]
// (also accepts the PowerShell-style -ArtifactType / -Name / -ProjectRoot / -FactoryRoot /
//  -Json / -SkipTierCheck flags)

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import {
  getMergeSemantics, testConfigArtifact, getTierAgents, getAgentFactoryDefault, invokeDeepMerge,
} from './config-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const o = { artifactType: '', name: '', projectRoot: process.cwd(), factoryRoot: process.env.VIBE_ROOT || '', json: false, skipTier: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i].toLowerCase();
    if (a === '-artifacttype' || a === '--artifact-type') o.artifactType = argv[++i];
    else if (a === '-name' || a === '--name') o.name = argv[++i];
    else if (a === '-projectroot' || a === '--project-root') o.projectRoot = argv[++i];
    else if (a === '-factoryroot' || a === '--factory-root') o.factoryRoot = argv[++i];
    else if (a === '-json' || a === '--json') o.json = true;
    else if (a === '-skiptiercheck' || a === '--skip-tier-check') o.skipTier = true;
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
const ArtifactType = args.artifactType;
const Name = args.name;
const ProjectRoot = args.projectRoot;
const FactoryRoot = args.factoryRoot || dirname(dirname(here));
const schemaDir = join(FactoryRoot, 'agent-schemas');

function readJsonFileOrThrow(path, label) {
  if (!existsSync(path)) return null;
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch (e) { throw new Error(`RESOLVER ERROR: ${label} at ${path} is not valid JSON: ${e.message} (A4)`); }
  try { return JSON.parse(raw); }
  catch (e) { throw new Error(`RESOLVER ERROR: ${label} at ${path} is not valid JSON: ${e.message} (A4)`); }
}

function assertCustomerConfigValid(data, schemaName, sourcePath) {
  const schemaPath = join(schemaDir, `${schemaName}.schema.json`);
  if (!existsSync(schemaPath)) throw new Error(`RESOLVER ERROR: schema '${schemaName}' not found at ${schemaPath}`);
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const errs = testConfigArtifact(data, schema, ProjectRoot);
  if (errs.length > 0) throw new Error(`RESOLVER ERROR: invalid config in ${sourcePath}: ${errs.join(' | ')}`);
}

try {
  if (!ArtifactType) throw new Error("RESOLVER ERROR: -ArtifactType is required");
  if (!Name) throw new Error("RESOLVER ERROR: -Name is required");

  const semantics = getMergeSemantics(ArtifactType); // throws on unknown type
  const meta = {
    artifact_type: ArtifactType, name: Name, merge: semantics,
    project_root: ProjectRoot, factory_root: FactoryRoot, customer_layer_present: false,
  };
  let resolved = null;

  if (ArtifactType === 'agent-config') {
    // A7 tier entitlement
    if (!args.skipTier) {
      const tierAgents = getTierAgents(ProjectRoot, FactoryRoot);
      if (tierAgents !== null && !tierAgents.includes(Name)) {
        let tierName = '(unknown)';
        const pp = join(ProjectRoot, '.forge', 'profile.json');
        if (existsSync(pp)) { try { tierName = JSON.parse(readFileSync(pp, 'utf8')).profile; } catch { /* keep */ } }
        else {
          const dp = join(FactoryRoot, '.forge', 'default-profile.json');
          if (existsSync(dp)) { try { tierName = JSON.parse(readFileSync(dp, 'utf8')).profile; } catch { /* keep */ } }
        }
        throw new Error(`RESOLVER ERROR: agent '${Name}' is not included in your tier '${tierName}'. Upgrade your tier or enable it in your profile's agents_enabled. (A7)`);
      }
    }
    const factoryDefault = getAgentFactoryDefault(join(FactoryRoot, '.claude', 'agents', `${Name}.md`));
    const custPath = join(ProjectRoot, '.forge', 'agent-configs', `${Name}.json`);
    let custConfig = null;
    if (existsSync(custPath)) {
      const custObj = readJsonFileOrThrow(custPath, 'customer agent-config');
      assertCustomerConfigValid(custObj, 'customer-config', custPath);
      custConfig = custObj.config;
      meta.customer_layer_present = true;
    }
    resolved = invokeDeepMerge(factoryDefault, custConfig);

  } else if (ArtifactType === 'model-router') {
    const router = readJsonFileOrThrow(join(FactoryRoot, '.claude', 'model-router.json'), 'factory model-router');
    const base = router.task_categories;
    const prefsPath = join(ProjectRoot, '.forge', 'provider-prefs.json');
    const merged = {};
    for (const k of Object.keys(base)) merged[k] = base[k];
    if (existsSync(prefsPath)) {
      const prefs = readJsonFileOrThrow(prefsPath, 'customer provider-prefs');
      assertCustomerConfigValid(prefs, 'provider-prefs', prefsPath);
      for (const k of Object.keys(prefs.task_categories)) merged[k] = prefs.task_categories[k];
      meta.customer_layer_present = true;
    }
    resolved = merged;

  } else {
    // routine | skill | rule-override | workflow -> replace / boolean-replace / enable-disable
    const relMap = {
      'routine': ['.forge', 'routines.json'],
      'skill': ['.forge', 'active-skills.json'],
      'rule-override': ['.forge', 'rule-overrides.json'],
      'workflow': ['.forge', 'workflows', `${Name}.json`],
    };
    const schemaMap = { 'routine': 'routines', 'skill': 'active-skills', 'rule-override': 'rule-overrides', 'workflow': null };
    const custPath = join(ProjectRoot, ...relMap[ArtifactType]);
    if (existsSync(custPath)) {
      const custObj = readJsonFileOrThrow(custPath, `customer ${ArtifactType}`);
      if (schemaMap[ArtifactType]) assertCustomerConfigValid(custObj, schemaMap[ArtifactType], custPath);
      meta.customer_layer_present = true;
      resolved = custObj;
    } else {
      resolved = null;
    }
  }

  process.stdout.write(JSON.stringify({ resolved, _meta: meta }, null, 2) + '\n');
  process.exit(0);
} catch (e) {
  process.stderr.write((e && e.message ? e.message : String(e)) + '\n');
  process.exit(1);
}
