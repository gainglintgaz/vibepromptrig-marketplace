#!/usr/bin/env node
// Guard for the staged operator identity change. Exits 1 if:
//   - identity/operator.json ships llcApproved !== false while SHIP_HOLD is on,
//   - operator.json gains any key outside ALLOWED_KEYS (no address/email/contact in this public repo),
//   - the full entity name appears in any tracked or new file while SHIP_HOLD is on,
//   - its own self-tests fail (detector and resolver are proven on synthetic input first).
// Approval day: flip llcApproved and SHIP_HOLD together in one reviewed change.
// Usage: node identity/check-operator-identity.mjs   (Node >= 18, no dependencies)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_KEYS, CONFIG_PATH, loadOperatorConfig, operatorName } from './operator.mjs';

const SHIP_HOLD = true;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Matches the base name followed by the entity suffix in common spellings (LLC, L.L.C., L L C).
const FULL_NAME = /arctave[\s\u00a0_-]*l\.?[\s\u00a0]*l\.?[\s\u00a0]*c\b/i;
const CONTACT_KEY = /address|email|e-mail|phone|street|city|zip|postal|contact|person|owner/i;

const failures = [];
const fail = (msg) => failures.push(msg);

function selfTest() {
  const base = ['Arc', 'tave'].join('');
  const hits = [`${base} LLC`, `${base.toUpperCase()} L.L.C.`, `${base}\u00a0llc`, `(c) ${base} L L C`];
  const misses = [base, `${base} Labs`, `${base}LLCX`];
  for (const s of hits) if (!FULL_NAME.test(s)) fail(`self-test: detector missed ${JSON.stringify(s)}`);
  for (const s of misses) if (FULL_NAME.test(s)) fail(`self-test: detector false positive ${JSON.stringify(s)}`);
  const cfg = { operatorBaseName: base, entitySuffix: 'LLC', llcApproved: false };
  if (operatorName(cfg) !== base) fail('self-test: flag false must resolve to the base name only');
  if (!FULL_NAME.test(operatorName({ ...cfg, llcApproved: true }))) fail('self-test: flag true must resolve to the full name');
  let threw = false;
  try { operatorName({ ...cfg, llcApproved: 'false' }); } catch { threw = true; }
  if (!threw) fail('self-test: non-boolean flag must be rejected');
}

function checkConfig() {
  let cfg;
  try { cfg = loadOperatorConfig(); } catch (e) { fail(`operator.json: cannot read or parse (${e.message})`); return null; }
  for (const key of Object.keys(cfg)) {
    if (!ALLOWED_KEYS.includes(key)) fail(`operator.json: key "${key}" is not allowed in this public repo`);
    if (key !== '$comment' && CONTACT_KEY.test(key)) fail(`operator.json: contact-like key "${key}" is not allowed`);
  }
  if (SHIP_HOLD && cfg.llcApproved !== false) fail(`operator.json: llcApproved must be false while SHIP_HOLD is on (found ${JSON.stringify(cfg.llcApproved)})`);
  let resolved;
  try { resolved = operatorName(cfg); } catch (e) { fail(`operator.json: ${e.message}`); return null; }
  if (SHIP_HOLD && FULL_NAME.test(resolved)) fail('operator.json: resolved operator name includes the entity suffix while SHIP_HOLD is on');
  return resolved;
}

function scanFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT });
  const files = out.toString('utf8').split('\0').filter(Boolean);
  const configRel = relative(ROOT, CONFIG_PATH).split('\\').join('/');
  let scanned = 0;
  for (const rel of files) {
    if (rel === configRel) continue;
    let buf;
    try { buf = readFileSync(join(ROOT, rel)); } catch { continue; } // deleted in working tree
    if (buf.includes(0)) continue; // binary
    scanned++;
    const lines = buf.toString('utf8').split(/\r?\n/);
    lines.forEach((line, i) => { if (FULL_NAME.test(line)) fail(`${rel}:${i + 1}: full entity name found outside identity/operator.json`); });
  }
  return { listed: files.length, scanned };
}

selfTest();
const resolved = checkConfig();
const counts = SHIP_HOLD ? scanFiles() : { listed: 0, scanned: 0 };
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.error(`operator-identity: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`operator-identity: OK (hold=${SHIP_HOLD}, resolved="${resolved}", files listed=${counts.listed}, text files scanned=${counts.scanned})`);
