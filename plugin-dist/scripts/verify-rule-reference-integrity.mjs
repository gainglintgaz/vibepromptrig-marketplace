#!/usr/bin/env node
// verify-rule-reference-integrity.mjs -- Node twin of verify-rule-reference-integrity.ps1
// (cross-platform port P2, T1c). Detects cross-file section references across .claude/rules/**.md
// and validates each against the target file's section anchors. Dependency-free (Node stdlib),
// node:path throughout, Node >= 18. Reads UTF-8 so the U+00A7 section mark survives.
// Exit 0 = clean, 1 = broken references. --json emits the machine summary.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const argRoot = (() => { const i = process.argv.indexOf('--root'); return i >= 0 ? process.argv[i + 1] : null; })();
const FactoryRoot = argRoot || process.env.VIBE_ROOT || dirname(here);
const asJson = process.argv.includes('--json');
const SEC = '§';

// Files referenced from rules that live outside the rule corpus -- skip.
const NON_RULE = new Set([
  'claude.md', 'readme.md', 'agents.md', 'gemini.md', 'version.md', 'next_session.md',
  'current_sprint.md', 'pending_approvals.md', 'decisions.md', 'status_report.md', 'state.md',
  'changelog.md', 'session_debrief.md', 'daily_digest.md', 'weekly_insights.md', 'architecture.md',
  'data-flow.md', 'design-capability-spec.md', 'visual-qa-checklist.md', 'enforcement-first-spec.md',
  'legal-ai-review.md', 'rule-enforcement-coverage.md',
]);

// Every legacy rule body lives in the relocated reference corpus (Context V2 Delivery 3b).
const rulesDir = join(FactoryRoot, 'docs', 'rules-reference', 'factory');
if (!existsSync(rulesDir)) { process.stderr.write(`Rules directory not found: ${rulesDir}\n`); process.exit(2); }
function walkMd(dir) {
  const out = [];
  for (const n of readdirSync(dir).sort()) {
    const full = join(dir, n);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkMd(full));
    else if (st.isFile() && n.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out;
}
const ruleFiles = walkMd(rulesDir);
if (ruleFiles.length === 0) { process.stderr.write(`No rule files found in ${rulesDir}\n`); process.exit(2); }

// ---- Pass 1: anchors[file.md] = Set of section numbers ----
const anchors = {};
const headerRxes = [
  new RegExp(`^#{2,}\\s*${SEC}\\s*(\\d+(?:\\.\\d+)?)\\b`, 'gm'),
  /^#{2,}\s*SS\s*(\d+(?:\.\d+)?)\b/gm,
  /^#{2,}\s+(\d+(?:\.\d+)?)\.\s+/gm,
];
for (const f of ruleFiles) {
  const key = basename(f).toLowerCase();
  if (!anchors[key]) anchors[key] = new Set();
  const txt = readFileSync(f, 'utf8');
  for (const rx of headerRxes) { rx.lastIndex = 0; let m; while ((m = rx.exec(txt))) anchors[key].add(m[1]); }
}

// ---- Pass 2: collect references ----
const refs = [];
const bodyPatterns = [
  { rx: new RegExp('`?([a-z0-9][a-z0-9_-]*\\.md)`?\\s+' + SEC + '\\s*(\\d+(?:\\.\\d+)?)', 'gi'), nameG: 1, secG: 2, kind: 'filename-then-section-unicode' },
  { rx: /`?([a-z0-9][a-z0-9_-]*\.md)`?\s+SS\s*(\d+(?:\.\d+)?)/gi, nameG: 1, secG: 2, kind: 'filename-then-section-ascii' },
  { rx: new RegExp(SEC + '\\s*(\\d+(?:\\.\\d+)?)\\s+(?:in|of|from)\\s+`?([a-z0-9][a-z0-9_-]*\\.md)`?', 'gi'), nameG: 2, secG: 1, kind: 'section-then-filename-unicode' },
  { rx: /SS\s*(\d+(?:\.\d+)?)\s+(?:in|of|from)\s+`?([a-z0-9][a-z0-9_-]*\.md)`?/gi, nameG: 2, secG: 1, kind: 'section-then-filename-ascii' },
];

for (const f of ruleFiles) {
  const selfName = basename(f).toLowerCase();
  const txt = readFileSync(f, 'utf8');
  let body = txt, fmText = '', fmLineOffset = 0;
  const fmM = txt.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (fmM) { fmText = fmM[1]; body = txt.slice(fmM[0].length); fmLineOffset = (fmM[0].match(/\n/g) || []).length; }

  // frontmatter see-also
  if (fmText) {
    const fmLines = fmText.split(/\r?\n/);
    let inSeeAlso = false;
    for (let i = 0; i < fmLines.length; i++) {
      const l = fmLines[i];
      if (/^see-also\s*:\s*$/.test(l)) { inSeeAlso = true; continue; }
      if (inSeeAlso && /^[a-zA-Z_][a-zA-Z0-9_-]*\s*:/.test(l)) inSeeAlso = false;
      if (inSeeAlso) {
        const mfm = l.match(/^\s*-\s+(?:[.\w/-]+\/)?([a-z0-9][a-z0-9_-]*\.md)\s*$/i);
        if (mfm && mfm[1]) refs.push({ source: basename(f), target: mfm[1].toLowerCase(), section: null, line_number: i + 2, raw: l.trim(), kind: 'frontmatter-see-also' });
      }
    }
  }

  // body patterns
  for (const bp of bodyPatterns) {
    bp.rx.lastIndex = 0;
    let mm;
    while ((mm = bp.rx.exec(body))) {
      const tgtRaw = mm[bp.nameG];
      if (!tgtRaw) continue;
      const tgt = tgtRaw.toLowerCase();
      if (tgt === selfName || NON_RULE.has(tgt)) continue;
      const secNum = mm[bp.secG] || null;
      const prefix = body.slice(0, Math.min(mm.index, body.length));
      const lineNum = (prefix.match(/\n/g) || []).length + 1 + fmLineOffset;
      refs.push({ source: basename(f), target: tgt, section: secNum, line_number: lineNum, raw: '', kind: bp.kind });
    }
  }
}

// ---- Pass 3: validate ----
const results = [];
for (const r of refs) {
  if (!r || !r.target) continue;
  let verdict = 'ok', detail = '';
  if (!Object.prototype.hasOwnProperty.call(anchors, r.target)) { verdict = 'missing-file'; detail = `target file not found: ${r.target}`; }
  else if (r.section) {
    if (!anchors[r.target].has(r.section)) {
      verdict = 'missing-section';
      const parent = r.section.split('.')[0];
      detail = (parent && anchors[r.target].has(parent))
        ? `section ${r.section} missing in ${r.target}; parent ${parent} present`
        : `section ${r.section} (and parent) missing in ${r.target}`;
    } else detail = 'resolved';
  } else detail = 'see-also resolved';
  results.push({ source: r.source, line_number: r.line_number, target: r.target, section: r.section, verdict, detail, kind: r.kind, raw: r.raw });
}

const passCount = results.filter((r) => r.verdict === 'ok').length;
const missingFile = results.filter((r) => r.verdict === 'missing-file').length;
const missingSection = results.filter((r) => r.verdict === 'missing-section').length;
const fails = missingFile + missingSection;
let anchorTotal = 0;
for (const k of Object.keys(anchors)) anchorTotal += anchors[k].size;

if (asJson) {
  process.stdout.write(JSON.stringify({ factory_root: FactoryRoot, rule_files: ruleFiles.length, anchors_total: anchorTotal, references: refs.length, pass: passCount, missing_file: missingFile, missing_section: missingSection, results }, null, 2) + '\n');
} else {
  console.log('\n==== rule reference integrity ====');
  console.log(`  rule files: ${ruleFiles.length}`);
  console.log(`  anchors   : ${anchorTotal} sections across all rules`);
  console.log(`  references: ${refs.length} cross-file refs found`);
  if (fails > 0) {
    console.log('BROKEN REFERENCES:');
    for (const r of results.filter((x) => x.verdict !== 'ok')) {
      console.log(`  [${r.verdict}] ${r.source}:${r.line_number}  -> ${r.target}${r.section ? ' SS' + r.section : ''}  (${r.detail})`);
    }
  }
  console.log(`  Pass: ${passCount}  Missing file: ${missingFile}  Missing section: ${missingSection}`);
}
process.exit(fails > 0 ? 1 : 0);
