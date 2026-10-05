#!/usr/bin/env node
// verify-foundational-requirements.mjs
//
// Inception-time Foundational Requirements gate (architect-first.md SS0.5 /
// discovery-protocol.md). HONEST COVERAGE PROXY (v0.1): it confirms that an
// architecture or spec document which DECLARES inception scope carries the six expensive-to-
// reverse non-functional answers -- it does NOT judge whether those answers are
// *good*. The point is to kill the retrofit class where a project is 95% done
// before anyone asks "does this even run on the target OS / is this for others?".
//
// Written in Node (.mjs) on purpose: it dogfoods the very lesson it enforces --
// the gate ships cross-platform from line 1 instead of being PowerShell-only.
//
// Scans <root>/docs/architecture/**/*.md and docs/specs/**/*.md. For each doc:
//   - reads the "Foundational scope:" marker in the header block:
//       inception | project | sprint  -> ENFORCE (must carry the 6 answers)
//       feature                        -> SKIP   (feature probes don't need it)
//       absent / unresolved            -> UNMARKED (advisory only in v0.1)
//   - an ENFORCE doc must have a "Foundational Requirements" section whose six
//     fields are each FILLED (not a <placeholder>, TBD, or blank).
//
// MODE = 'warn' on first ship (warn-first per the task) -> a finding is a WARN
// and forge doctor stays green. Flip to 'fail' after the corpus is marked, and
// a missing-section inception doc turns doctor RED.
//
// Usage:
//   node verify-foundational-requirements.mjs [--root <dir>] [--json]
//     --root   project/factory root (default: env VIBE_ROOT, else cwd).
//              the scan targets are <root>/docs/architecture and <root>/docs/specs.
//     --json   machine-readable output (the shape forge doctor parses).
//
// Exit: warn mode -> always 0 (findings are warnings). fail mode -> 1 if findings.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import process from 'node:process';

// ---- MIGRATION SWITCH: 'warn' on first ship -> 'fail' after the corpus is
// marked with explicit Foundational scope: lines (architect-first.md SS0.5).
const MODE = 'warn';

// ---- args -------------------------------------------------------------
const argv = process.argv.slice(2);
function argValue(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
const asJson = argv.includes('--json');
const root = argValue('--root') || process.env.VIBE_ROOT || process.cwd();
const scanDirs = [join(root, 'docs', 'architecture'), join(root, 'docs', 'specs')];

// ---- the six expensive-to-reverse non-functionals --------------------
// key   = human label for messages
// label = regex that finds the field's line inside the section
const REQUIRED_FIELDS = [
  { key: 'Target OS / platforms', label: /target\s*os|target\s*platform|\bplatforms?\b/i },
  { key: 'Runtime / language', label: /\bruntime\b|\blanguage\b/i },
  { key: 'Audience (me-only vs others)', label: /\baudience\b/i },
  { key: 'Tenancy (single vs multi)', label: /\btenancy\b/i },
  { key: 'Distribution model', label: /\bdistribution\b/i },
  { key: 'Data + privacy boundary', label: /data\s*\+?\s*privacy|privacy\s*boundary/i },
];

// ---- helpers ----------------------------------------------------------
function walkMarkdown(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) out.push(...walkMarkdown(full));
    else if (st.isFile() && name.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out;
}

// Resolve the declared scope. Placeholder text inside <...> means "not set yet"
// (so the raw template, which shows "<inception | feature>", is UNMARKED and is
// never falsely enforced). A real doc picks a single bare word.
function resolveScope(raw) {
  const m = raw.match(/Foundational\s+scope:\s*\**\s*([^\n]*)/i);
  if (!m) return 'unmarked';
  let v = m[1];
  v = v.split(/\s--\s|—/)[0];        // drop trailing " -- guidance" / em-dash guidance
  v = v.replace(/<[^>]*>/g, '');           // strip <placeholder> spans
  v = v.replace(/[*`_>#]/g, '').trim().toLowerCase();
  if (!v) return 'unmarked';
  if (/\b(inception|project|sprint|new\s+project)\b/.test(v)) return 'inception';
  if (/\bfeature\b/.test(v)) return 'feature';
  return 'unmarked';
}

// Pull the "Foundational Requirements" section body (heading line through the
// next same-or-higher heading or horizontal rule).
function extractSection(raw) {
  const lines = raw.split(/\r?\n/);
  let start = -1, level = 2;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^(#{1,6})\s+.*Foundational\s+Requirements/i);
    if (h) { start = i; level = h[1].length; break; }
    if (/^\s*\*\*[^*]*Foundational\s+Requirements[^*]*\*\*\s*$/i.test(lines[i])) { start = i; level = 2; break; }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const hh = lines[i].match(/^(#{1,6})\s+/);
    if (hh && hh[1].length <= level) { end = i; break; }
    if (/^---\s*$/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

// A field is FILLED when its line has real content after the label colon --
// not an empty value, a <placeholder>, or a TBD/TODO/??? stub.
function fieldFilled(section, label) {
  for (const ln of section.split(/\r?\n/)) {
    if (!label.test(ln)) continue;
    const idx = ln.indexOf(':');
    let v = idx >= 0 ? ln.slice(idx + 1) : '';
    v = v.replace(/<[^>]*>/g, '').replace(/[*`_>#]/g, ' ').trim();
    if (/\b(tbd|todo)\b|\?\?\?/i.test(v)) return false;
    const alnum = (v.match(/[a-z0-9]/gi) || []).length;
    return alnum >= 2;
  }
  return false; // label not present at all
}

// ---- scan -------------------------------------------------------------
const details = [];
let enforced = 0, enforcedClean = 0, skipped = 0, unmarked = 0;
const docs = scanDirs.flatMap((dir) => existsSync(dir) ? walkMarkdown(dir) : []);

for (const file of docs) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch { continue; }
  const rel = relative(root, file).split(sep).join('/');
  const scope = resolveScope(raw);

  if (scope === 'feature') { skipped++; continue; }
  if (scope === 'unmarked') { unmarked++; continue; }

  // inception -> enforce
  enforced++;
  const section = extractSection(raw);
  if (!section) {
    details.push(`${rel}: declares inception scope but has NO "Foundational Requirements" section (must answer all 6: ${REQUIRED_FIELDS.map(f => f.key).join(', ')})`);
    continue;
  }
  const missing = REQUIRED_FIELDS.filter(f => !fieldFilled(section, f.label)).map(f => f.key);
  if (missing.length) {
    details.push(`${rel}: Foundational Requirements section is missing/blank field(s): ${missing.join(', ')}`);
  } else {
    enforcedClean++;
  }
}

// ---- verdict ----------------------------------------------------------
const findings = details.length;
let status;
if (findings > 0) status = MODE === 'fail' ? 'fail' : 'warn';
else status = 'pass';

let message;
if (!scanDirs.some((dir) => existsSync(dir))) {
  message = `no docs/architecture/ or docs/specs/ under ${root} -- nothing to enforce (inception foundational-requirements gate)`;
} else {
  message = `${docs.length} architecture/spec doc(s): ${enforced} inception-scoped (${enforcedClean} complete), ${skipped} feature-scoped, ${unmarked} unmarked; ${findings} finding(s)`;
}
const proxyNote = '[COVERAGE PROXY: confirms the 6 foundational answers are PRESENT in inception-scoped docs, not that they are correct -- v0.2 hardens this]';

const result = {
  check: 'foundational-requirements',
  status,
  mode: MODE,
  message: `${message} ${proxyNote}`,
  enforced,
  enforcedClean,
  skipped,
  unmarked,
  findings,
  details: details.slice(0, 12),
};

if (asJson) {
  process.stdout.write(JSON.stringify(result) + '\n');
} else {
  console.log(`[${status.toUpperCase()}] foundational-requirements (${MODE} mode): ${result.message}`);
  for (const d of result.details) console.log('    ' + d);
}

process.exit(status === 'fail' ? 1 : 0);
