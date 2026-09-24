#!/usr/bin/env node
// verify-cross-tool-mirrors.mjs -- Node twin of verify-cross-tool-mirrors.ps1 (cross-platform
// port P2, T1c). Asserts every source rule in .claude/rules/ is represented in every mirror
// (AGENTS.md, GEMINI.md, .cursor/rules/*.mdc, .windsurfrules, PERPLEXITY). CONTENT integrity,
// not mtimes. Dependency-free (Node stdlib), Node >= 18. Read-only.
// Exit 0 if consistent, 1 if drift (or --strict + warns). --json emits the machine summary.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const argRoot = (() => { const i = process.argv.indexOf('--root'); return i >= 0 ? process.argv[i + 1] : null; })();
const FactoryRoot = argRoot || process.env.VIBE_ROOT || dirname(here);
const asJson = process.argv.includes('--json');
const strict = process.argv.includes('--strict') || process.argv.includes('-Strict');

const results = [];
const add = (check, status, detail) => results.push({ check, status, detail });
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const rulesDir = join(FactoryRoot, '.claude', 'rules');
const sourceRules = existsSync(rulesDir) ? readdirSync(rulesDir).filter((f) => f.toLowerCase().endsWith('.md')).map((f) => f.replace(/\.md$/i, '')) : [];
function compactMode() {
  if (existsSync(join(FactoryRoot, '.forge/context/kernel.md'))) return true;
  const manifestPath = join(FactoryRoot, '.claude/rules-manifest.json');
  if (!existsSync(manifestPath)) return false;
  try { return JSON.parse(readFileSync(manifestPath, 'utf8')).schema_version === 2; }
  catch { return true; } // Corrupt compact inputs must not fall back to legacy checks.
}
if (compactMode()) {
  // One strict implementation owns source coverage, required cards and canonical output
  // freshness. Pass the exact requested root, never let the child inherit another checkout.
  const child = spawnSync(process.execPath, [join(here, 'verify-factory.mjs'), '--factory-root', FactoryRoot, '--check', 'mirror-freshness', '--json'], { encoding: 'utf8', env: { ...process.env, VIBE_ROOT: FactoryRoot } });
  try {
    const report = JSON.parse(child.stdout);
    const item = report.results?.find((result) => result.check === 'mirror-freshness');
    if (!item || !['pass', 'fail'].includes(item.status)) throw new Error('No valid compact mirror result');
    const passed = child.status === 0 && report.failures === 0 && item.status === 'pass';
    add('compact mirror-freshness', passed ? 'OK' : 'FAIL', [item.message, ...(item.details || [])].join('; '));
  } catch (error) { add('compact mirror-freshness', 'FAIL', 'Compact verifier failed: ' + error.message); }
  const { failCount, warnCount } = emit();
  process.exit(failCount > 0 || (strict && warnCount > 0) ? 1 : 0);
}

if (!existsSync(rulesDir)) {
  add('source-rules', 'FAIL', `no .claude/rules directory at ${rulesDir}`);
  emit(); process.exit(1);
}
if (sourceRules.length === 0) add('source-rules', 'FAIL', `no .md files in ${rulesDir}`);
else add('source-rules', 'OK', `found ${sourceRules.length} rule files`);

function checkConcat(file, label, missingStatus = 'FAIL') {
  const p = join(FactoryRoot, file);
  if (!existsSync(p)) { add(label, missingStatus, `file missing at ${p}`); return; }
  const content = readFileSync(p, 'utf8');
  const missing = sourceRules.filter((r) => !new RegExp(escapeRe(r)).test(content));
  if (missing.length > 0) add(`${label} content`, 'FAIL', `missing: ${missing.join(', ')}`);
  else add(`${label} content`, 'OK', `all ${sourceRules.length} rules referenced`);
}
checkConcat('AGENTS.md', 'AGENTS.md', 'FAIL');
checkConcat('GEMINI.md', 'GEMINI.md', 'WARN');

// .cursor/rules
const cursorDir = join(FactoryRoot, '.cursor', 'rules');
if (existsSync(cursorDir)) {
  const mdcs = readdirSync(cursorDir).filter((f) => f.toLowerCase().endsWith('.mdc')).map((f) => f.replace(/\.mdc$/i, ''));
  const missingInCursor = sourceRules.filter((r) => !mdcs.includes(r));
  const extraInCursor = mdcs.filter((m) => !sourceRules.includes(m));
  if (missingInCursor.length > 0) add('.cursor/rules coverage', 'FAIL', `missing mdc: ${missingInCursor.join(', ')}`);
  else add('.cursor/rules coverage', 'OK', 'all rules have .mdc mirrors');
  if (extraInCursor.length > 0) add('.cursor/rules stale', 'WARN', `orphan mdcs: ${extraInCursor.join(', ')}`);
  const missingFm = [];
  for (const f of readdirSync(cursorDir).filter((x) => x.toLowerCase().endsWith('.mdc'))) {
    const head = readFileSync(join(cursorDir, f), 'utf8').split(/\r?\n/).slice(0, 10).join('\n');
    if (!/^alwaysApply:\s*true/m.test(head)) missingFm.push(f.replace(/\.mdc$/i, ''));
  }
  if (missingFm.length > 0) add('.cursor/rules frontmatter', 'WARN', `missing alwaysApply: ${missingFm.join(', ')}`);
  else add('.cursor/rules frontmatter', 'OK', 'all .mdc files have alwaysApply: true');
} else add('.cursor/rules', 'WARN', `directory missing at ${cursorDir} (Cursor users won't see rules)`);

// .windsurfrules
const wsPath = join(FactoryRoot, '.windsurfrules');
if (existsSync(wsPath)) {
  const ws = readFileSync(wsPath, 'utf8');
  const missingEssential = ['vibe-standard', 'privacy', 'secrets-handling'].filter((e) => !new RegExp(escapeRe(e)).test(ws));
  if (missingEssential.length > 0) add('.windsurfrules essentials', 'FAIL', `missing: ${missingEssential.join(', ')}`);
  else add('.windsurfrules essentials', 'OK', `size=${ws.length} bytes; essentials present`);
} else add('.windsurfrules', 'WARN', 'file missing (Windsurf users won\'t see rules)');

// PERPLEXITY
const perpPath = join(FactoryRoot, 'PERPLEXITY_SPACE_INSTRUCTIONS.md');
if (existsSync(perpPath)) {
  const perp = readFileSync(perpPath, 'utf8');
  if (perp.length < 1000) add('PERPLEXITY mirror', 'WARN', 'file is <1KB; might be empty/stub');
  else add('PERPLEXITY mirror', 'OK', `size=${perp.length} chars`);
} else add('PERPLEXITY mirror', 'WARN', 'file missing');

function emit() {
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  const warnCount = results.filter((r) => r.status === 'WARN').length;
  const okCount = results.filter((r) => r.status === 'OK').length;
  if (asJson) {
    process.stdout.write(JSON.stringify({ factory_root: FactoryRoot, source_rules: sourceRules?.length ?? 0, results, pass: okCount, warn: warnCount, fail: failCount }, null, 2) + '\n');
  } else {
    console.log('\n==== Cross-tool mirror validator ====');
    console.log(`  source rules: ${sourceRules?.length ?? 0}`);
    for (const r of results) console.log(`  [${r.status}] ${r.check}  ${r.detail}`);
    console.log(`\n  Pass: ${okCount}  Warn: ${warnCount}  Fail: ${failCount}`);
  }
  return { failCount, warnCount };
}

const { failCount, warnCount } = emit();
process.exit(failCount > 0 || (strict && warnCount > 0) ? 1 : 0);
