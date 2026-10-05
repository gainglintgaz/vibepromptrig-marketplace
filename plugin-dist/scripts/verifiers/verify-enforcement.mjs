#!/usr/bin/env node
// verify-enforcement.mjs -- Node twin of verify-enforcement.ps1 (cross-platform port P2, T1c).
// Enforcement-coverage proxy: every rule must be tagged; every load_bearing tier-1/2 rule must
// have a non-empty enforcement_ref (path-like refs exist on disk) + a gate/tripwire section;
// load_bearing+tier3 is the ghost-rule signature. Dependency-free (Node stdlib), Node >= 18.
// Exit 0 = pass/warn, 1 = fail. --json emits {check,status,mode,message,details}.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const argRoot = (() => { const i = process.argv.indexOf('--root'); return i >= 0 ? process.argv[i + 1] : null; })();
const FactoryRoot = argRoot || process.env.VIBE_ROOT || dirname(dirname(here));
const asJson = process.argv.includes('--json');
const MODE = 'fail';

// Every legacy rule body lives in the relocated reference corpus (Context V2 Delivery 3b).
const rulesDir = join(FactoryRoot, 'docs', 'rules-reference', 'factory');
function walkMd(dir) {
  const out = [];
  let entries; try { entries = readdirSync(dir); } catch { return out; }
  for (const n of entries.sort()) {
    const full = join(dir, n);
    let st; try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) out.push(...walkMd(full));
    else if (st.isFile() && n.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out;
}
const ruleFiles = walkMd(rulesDir).sort();

const untagged = [], failures = [], ghosts = [];
let tier12 = 0, tier3 = 0;
const gateSection = /(tripwire|audit gate|pre-commit|interlock|verifier|hook|mechanical gate|hard gate|blocking gate|veto|sign-off gate|checklist)/i;

for (const f of ruleFiles) {
  const raw = readFileSync(f, 'utf8');
  const rel = relative(rulesDir, f).split(sep).join('/');
  const fmM = raw.match(/^\s*---\r?\n([\s\S]*?)\r?\n---/);
  const fm = fmM ? fmM[1] : '';

  const tierM = fm.match(/^enforcement_tier:\s*([123])\s*$/m);
  const lbM = fm.match(/^load_bearing:\s*(true|false)\s*$/m);
  const refM = fm.match(/^enforcement_ref:\s*"?([^"\r\n]+)"?\s*$/m);
  const tier = tierM ? parseInt(tierM[1], 10) : null;
  const lb = lbM ? (lbM[1] === 'true') : null;
  const ref = refM ? refM[1].trim() : null;

  if (tier === null || lb === null) { untagged.push(rel); continue; }
  if (lb && tier === 3) { ghosts.push(`${rel} : load_bearing:true with enforcement_tier:3 -- a load-bearing rule with no gate (the ghost-rule signature)`); continue; }
  if (!lb || tier === 3) { tier3++; continue; }

  tier12++;
  if (!ref) { failures.push(`${rel} : tier ${tier} load-bearing rule with EMPTY enforcement_ref`); continue; }
  const pathTokens = ref.match(/[\w./\\-]+\.(ps1|sh|json|js|ts|mjs)/g) || [];
  for (const pt of pathTokens) {
    const cand = join(FactoryRoot, pt.replace(/\//g, sep).replace(/\\/g, sep));
    if (!existsSync(cand)) failures.push(`${rel} : enforcement_ref points at missing file '${pt}'`);
  }
  if (!gateSection.test(raw)) failures.push(`${rel} : tier ${tier} rule body has no tripwire/gate section`);
}

let status = 'pass';
const details = [];
// An empty or missing corpus is not coverage: never report a vacuous pass.
if (ruleFiles.length === 0) { status = 'fail'; details.push(`no rule files found in ${rulesDir}`); }
if (ghosts.length) { status = 'fail'; details.push(...ghosts); }
if (failures.length) { status = 'fail'; details.push(...failures); }
if (untagged.length) {
  details.push(...untagged.map((u) => `UNTAGGED: ${u}`));
  if (MODE === 'fail') status = 'fail'; else if (status === 'pass') status = 'warn';
}

const message = `${ruleFiles.length} rules: ${tier12} load-bearing gated (tier 1/2), ${tier3} advisory (tier 3), ${untagged.length} untagged, ${ghosts.length} ghost, ${failures.length} coverage failures [COVERAGE PROXY: confirms gates are DECLARED+REFERENCED, not that they catch violations -- v0.2 registry hardens this]`;
const result = { check: 'enforcement-coverage', status, mode: MODE, message, details: details.slice(0, 12) };
if (asJson) process.stdout.write(JSON.stringify(result) + '\n');
else { console.log(`[${status.toUpperCase()}] enforcement-coverage (${MODE} mode): ${message}`); for (const d of details.slice(0, 20)) console.log('    ' + d); }
process.exit(status === 'fail' ? 1 : 0);
