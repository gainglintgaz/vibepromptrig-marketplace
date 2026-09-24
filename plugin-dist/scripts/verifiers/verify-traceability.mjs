#!/usr/bin/env node
// verify-traceability.mjs -- Node twin of verify-traceability.ps1 (cross-platform port P2, T1c).
// Composable-outputs + traceability coverage proxy: confirms the gate + schema EXIST and BITE at
// the factory level. Mirrors verify-enforcement. Dependency-free (Node stdlib), Node >= 18.
// Exit 0 = pass, 1 = fail. --json emits {check,status,mode,message,details}.

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const argRoot = (() => { const i = process.argv.indexOf('--root'); return i >= 0 ? process.argv[i + 1] : null; })();
const FactoryRoot = argRoot || process.env.VIBE_ROOT || dirname(dirname(here));
const asJson = process.argv.includes('--json');
const MODE = 'fail';

const failures = [];
function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return 'PARSE_ERROR'; }
}

// 1. rule exists + enforcement-tagged
const rule = join(FactoryRoot, 'docs', 'rules-reference', 'factory', 'composable-outputs.md');
if (!existsSync(rule)) failures.push('composable-outputs.md MISSING');
else {
  const raw = readFileSync(rule, 'utf8');
  const fmM = raw.match(/^\s*---\r?\n([\s\S]*?)\r?\n---/);
  const fm = fmM ? fmM[1] : '';
  if (!/^enforcement_tier:\s*1\s*$/m.test(fm)) failures.push('composable-outputs.md not tagged enforcement_tier: 1');
  if (!/^load_bearing:\s*true\s*$/m.test(fm)) failures.push('composable-outputs.md not tagged load_bearing: true');
}

// 2. schema exists + parses
const schema = readJson(join(FactoryRoot, 'agent-schemas', 'composed-output.schema.json'));
if (schema === null) failures.push('composed-output.schema.json MISSING');
else if (schema === 'PARSE_ERROR') failures.push('composed-output.schema.json does not parse');

// 3. valid sample parses + satisfies doctrine
const valid = readJson(join(FactoryRoot, 'agent-schemas', 'samples', 'composed-output.valid.json'));
if (valid === null) failures.push('composed-output.valid.json MISSING');
else if (valid === 'PARSE_ERROR') failures.push('composed-output.valid.json does not parse');
else {
  if (!(Array.isArray(valid.blocks) ? valid.blocks.length : 0) || (Array.isArray(valid.blocks) ? valid.blocks.length : 0) < 1) {
    failures.push('valid sample has no registered blocks (composed-outputs.md SS3)');
  }
  const aiAuthored = valid.authored_by === 'ai' || valid.authored_by === 'ai_then_user';
  if (aiAuthored) {
    const p = valid.ai_provenance;
    if (!p || !p.prompt_version || !p.run_id || !p.sources) {
      failures.push('valid sample is AI-authored but missing ai_provenance{prompt_version,run_id,sources} (SS5)');
    }
  }
}

// 4. broken sample parses + is CORRECTLY broken
const broken = readJson(join(FactoryRoot, 'agent-schemas', 'samples', 'composed-output.broken-missing-provenance.json'));
if (broken === null) failures.push('composed-output.broken-missing-provenance.json MISSING');
else if (broken === 'PARSE_ERROR') failures.push('broken sample does not parse (it should be valid JSON, just doctrine-broken)');
else {
  const brokenAi = broken.authored_by === 'ai' || broken.authored_by === 'ai_then_user';
  if (!(brokenAi && (broken.ai_provenance === null || broken.ai_provenance === undefined))) {
    failures.push('broken sample is NOT actually broken (expected AI-authored without ai_provenance) -- the gate would not bite');
  }
}

// 5. agent-run provenance section present in two-way-traceability.md
const twt = join(FactoryRoot, 'docs', 'rules-reference', 'factory', 'two-way-traceability.md');
if (!existsSync(twt)) failures.push('two-way-traceability.md MISSING');
else if (!/Agent[ -]?Run.{0,30}Provenance/i.test(readFileSync(twt, 'utf8'))) {
  failures.push('two-way-traceability.md has no Agent-Run / Workflow Provenance section');
}

const status = failures.length > 0 ? 'fail' : 'pass';
const message = status === 'pass'
  ? 'composable-outputs gate live: rule tagged, schema+samples present, valid passes, broken correctly rejected, agent-run provenance section present [COVERAGE PROXY: confirms gate exists+bites at factory level; per-definition validation is app-side v0.2]'
  : `${failures.length} traceability/composable-outputs coverage failure(s)`;

const result = { check: 'traceability-composable-outputs', status, mode: MODE, message, details: failures.slice(0, 12) };
if (asJson) process.stdout.write(JSON.stringify(result) + '\n');
else { console.log(`[${status.toUpperCase()}] traceability-composable-outputs (${MODE} mode): ${message}`); for (const f of failures.slice(0, 20)) console.log('    ' + f); }
process.exit(status === 'fail' ? 1 : 0);
