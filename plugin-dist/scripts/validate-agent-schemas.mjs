#!/usr/bin/env node
// validate-agent-schemas.mjs -- Node twin of validate-agent-schemas.ps1 (cross-platform port P2, T1c).
// Validates every sample under agent-schemas/samples/ against its schema: <prefix>.valid.json MUST
// validate clean; <prefix>.broken-<why>.json MUST be rejected. Reuses config-lib.mjs's testConfigArtifact
// (A3 path-jail + A4 + A5 + A10). Exit 0 only if every valid passes AND every broken is rejected.
// Dependency-free (Node stdlib), Node >= 18.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { testConfigArtifact } from './forge/config-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const asJson = process.argv.includes('--json') || process.argv.includes('-Json');
const factoryRoot = process.env.VIBE_ROOT || dirname(here);
const schemaDir = join(factoryRoot, 'agent-schemas');
const sampleDir = join(schemaDir, 'samples');

if (!existsSync(sampleDir)) { process.stderr.write(`Sample directory not found: ${sampleDir}\n`); process.exit(2); }
const samples = readdirSync(sampleDir).filter((f) => f.toLowerCase().endsWith('.json')).sort();
if (samples.length === 0) { process.stderr.write(`No samples found in ${sampleDir}\n`); process.exit(2); }

const results = [];
for (const name of samples) {
  const prefix = name.split('.')[0];
  const expectValid = /\.valid\./.test(name);
  const expectLabel = expectValid ? 'valid' : 'reject';
  const schemaPath = join(schemaDir, `${prefix}.schema.json`);
  let verdict = 'PASS', detail = '';

  if (!existsSync(schemaPath)) {
    results.push({ Sample: name, Expect: expectLabel, Verdict: 'FAIL', Detail: `no schema for prefix '${prefix}' (${schemaPath})` });
    continue;
  }
  let schema;
  try { schema = JSON.parse(readFileSync(schemaPath, 'utf8')); }
  catch (e) { results.push({ Sample: name, Expect: 'valid', Verdict: 'FAIL', Detail: `schema is not valid JSON: ${e.message}` }); continue; }

  let data, parseErr = null;
  try { data = JSON.parse(readFileSync(join(sampleDir, name), 'utf8')); } catch (e) { parseErr = e.message; }

  if (parseErr !== null) {
    if (expectValid) { verdict = 'FAIL'; detail = `valid sample is not parseable JSON: ${parseErr}`; }
    else { verdict = 'PASS'; detail = `rejected (unparseable JSON) -- ${parseErr}`; }
    results.push({ Sample: name, Expect: expectLabel, Verdict: verdict, Detail: detail });
    continue;
  }

  const errs = testConfigArtifact(data, schema, factoryRoot);
  if (expectValid) {
    if (errs.length === 0) { verdict = 'PASS'; detail = 'valid sample accepted'; }
    else { verdict = 'FAIL'; detail = `valid sample REJECTED: ${errs.join(' | ')}`; }
  } else {
    if (errs.length > 0) { verdict = 'PASS'; detail = `rejected as expected: ${errs[0]}`; }
    else { verdict = 'FAIL'; detail = 'broken sample was ACCEPTED (negative test failed)'; }
  }
  results.push({ Sample: name, Expect: expectLabel, Verdict: verdict, Detail: detail });
}

const passCount = results.filter((r) => r.Verdict === 'PASS').length;
const failCount = results.filter((r) => r.Verdict === 'FAIL').length;

if (asJson) {
  process.stdout.write(JSON.stringify({ samples: results.length, pass: passCount, fail: failCount, results }, null, 2) + '\n');
} else {
  console.log('\n==== validate-agent-schemas ====');
  console.log(`  samples    : ${results.length}`);
  for (const r of results) console.log(`  ${r.Verdict === 'PASS' ? '[OK  ]' : '[FAIL]'} ${r.Sample} (${r.Expect}) ${r.Detail}`);
  console.log(`\n  Result: ${passCount} pass / ${failCount} fail`);
}
process.exit(failCount > 0 ? 1 : 0);
