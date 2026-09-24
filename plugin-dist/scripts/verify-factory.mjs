#!/usr/bin/env node
// verify-factory.mjs -- Node twin of verify-factory.ps1 (cross-platform port P2, T1c).
// The factory truth-drift checks. node:path throughout, dependency-free, Node >= 18.
// 7 checks: rules-list, agents-list, skills-list, scripts-list, mirror-freshness,
// version-citations, rule-reference-integrity. --json emits the same shape as the .ps1.
//
// CROSS-OS NOTE (approved 2026-06-14): check 5 (mirror-freshness) is reimplemented
// CONTENT-BASED instead of mtime-based. mtime is non-deterministic (git does not preserve it;
// a fresh checkout stamps all files at checkout time), so the .ps1's mtime compare would flake
// on CI. The content check catches an edited-but-unmirrored rule, which mtime + presence/count
// cannot. It is PROFILE-AWARE + ENCODING-ROBUST by necessity (two facts the mtime check hid):
//   1. AGENTS.md is NOT the full mirror -- forge profile.ps1 copies the ACTIVE profile's
//      tier-filtered AGENTS-<profile>.md onto AGENTS.md (agents.md-spec filename). GEMINI.md is
//      the full all-rules mirror. So: GEMINI must carry every rule; AGENTS must equal the active
//      variant AND carry that profile's tier cascade; .cursor/<rule>.mdc is per-rule.
//   2. sync-rules-to-platforms.ps1 reads rule files with Get-Content -Raw and NO -Encoding UTF8,
//      so on PS 5.1 every non-ASCII byte (em-dash, U+00A7, smart-quote) is double-encoded into
//      the mirrors. A verbatim byte-substring would therefore never pass; we compare the
//      ASCII-folded prose skeleton (intact across the sync) -- still catches real edits, since
//      meaningful drift is in ASCII text. Both are logged factory bugs (PENDING_APPROVALS), out
//      of scope for the port; the faithful .mjs sync port fixes them in a later tranche.
//   This returns the SAME PASS verdict as the .ps1 on a synced factory -- correctly, not by
//   weakening the freshness semantic.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { findLegacyBodiesInNativeAutoload, loadContextManifest } from './forge/context-contract.mjs';
import { buildInstallPlan } from './forge/context-install.mjs';

const here = dirname(fileURLToPath(import.meta.url));
function argVal(flag) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; }
const FactoryRoot = argVal('--factory-root') || argVal('-FactoryRoot') || process.env.VIBE_ROOT || dirname(here);
const Check = argVal('--check') || argVal('-Check') || 'all';
const asJson = process.argv.includes('--json');

const results = [];
let failureCount = 0;
function addResult(check, status, message, details = []) {
  results.push({ check, status, message, details });
  if (status === 'fail') failureCount++;
}
const norm = (s) => s.replace(/\r/g, '');
function filesInDir(dir, ext) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.toLowerCase().endsWith(ext)).map((f) => f.slice(0, -ext.length));
}
function namesFromDocList(docPath, sectionPattern) {
  if (!existsSync(docPath)) return [];
  let content = readFileSync(docPath, 'utf8');
  if (sectionPattern) {
    const m = content.match(sectionPattern);
    if (m) {
      const rest = content.slice(m.index + m[0].length);
      const next = rest.match(/^##\s/m);
      content = next ? rest.slice(0, next.index) : rest;
    }
  }
  return [...new Set([...content.matchAll(/^\s*-\s+`?([a-z0-9-]+)\.md`?/gm)].map((x) => x[1]))];
}


// A present compact kernel or v2 manifest selects the compact contract. Corrupt manifests
// fail closed; only an explicitly legacy manifest (or no compact inputs) uses legacy checks.
function compactMode() {
  if (existsSync(join(FactoryRoot, '.forge/context/kernel.md'))) return true;
  const manifest = join(FactoryRoot, '.claude/rules-manifest.json');
  if (!existsSync(manifest)) return false;
  try { return JSON.parse(readFileSync(manifest, 'utf8')).schema_version === 2; }
  catch { return true; }
}
function compactContract() {
  const { manifest } = loadContextManifest(join(FactoryRoot, '.claude/rules-manifest.json'), { factoryRoot: FactoryRoot, requireFiles: true });
  const actual = [];
  function walk(dir, prefix) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix + '/' + entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), relative);
      else if (entry.name.endsWith('.md')) actual.push(relative);
    }
  }
  // Delivery 3b: the legacy autoload tree is gone from the source factory. Its reappearance (any
  // content) is a regression, never a second corpus to merge into the check.
  if (existsSync(join(FactoryRoot, '.claude/rules'))) throw new Error('Legacy .claude/rules/ autoload tree is present; rule bodies belong in docs/rules-reference/factory/');
  const relocated = join(FactoryRoot, 'docs/rules-reference/factory');
  if (!existsSync(relocated)) throw new Error('Relocated legacy rule corpus missing: docs/rules-reference/factory/');
  walk(relocated, 'docs/rules-reference/factory');
  const declared = new Set(manifest.rules.map((rule) => rule.source));
  const missing = actual.filter((source) => !declared.has(source));
  if (missing.length) throw new Error('Source rules absent from compact manifest: ' + missing.join(', '));
  const nativeBodies = findLegacyBodiesInNativeAutoload(FactoryRoot, manifest);
  if (nativeBodies.length) throw new Error('Legacy rule bodies in native autoload directories: ' + nativeBodies.join('; '));
  const cards = new Set(manifest.rules.flatMap((rule) => [rule.card, ...rule.replacement.card_ids.map((id) => '.forge/context/rules/' + id + '.md')]));
  for (const card of cards) {
    const content = readFileSync(join(FactoryRoot, card), 'utf8');
    // Cards have a structural safety contract; arbitrary/empty bytes are not a valid card.
    for (const field of ['Trigger', 'Required', 'Prohibited', 'Verify', 'Exception', 'References']) {
      if (!new RegExp('^' + field + ':\\s*\\S', 'm').test(content)) throw new Error('Invalid compact card ' + card + ': missing ' + field);
    }
  }
  return manifest;
}
function checkCompact(check) {
  try {
    const manifest = compactContract();
    if (check === 'rules-list') return addResult(check, 'pass', 'Compact manifest covers all ' + manifest.rules.length + ' source rules and validates required cards');
    const plan = buildInstallPlan({ factoryRoot: FactoryRoot, projectRoot: FactoryRoot });
    const stale = [];
    for (const relative of ['AGENTS.md', 'GEMINI.md', '.windsurfrules', '.claude/CLAUDE.md']) {
      const expected = plan.files.find((file) => file.relPath === relative);
      if (!expected || !existsSync(join(FactoryRoot, relative)) || norm(readFileSync(join(FactoryRoot, relative), 'utf8')) !== norm(expected.content)) stale.push(relative);
    }
    return addResult(check, stale.length ? 'fail' : 'pass', stale.length ? 'Compact native outputs differ from canonical rendering' : 'All four compact native outputs match canonical rendering', stale);
  } catch (error) { return addResult(check, 'fail', 'Compact context validation failed', [error.message]); }
}

// ---- Check 1: rules-list ----
function checkRulesList() {
  if (compactMode()) return checkCompact('rules-list');
  const claudeMd = join(FactoryRoot, '.claude', 'CLAUDE.md');
  const rulesDir = join(FactoryRoot, '.claude', 'rules');
  if (!existsSync(claudeMd)) return addResult('rules-list', 'fail', `CLAUDE.md not found at ${claudeMd}`);
  if (!existsSync(rulesDir)) return addResult('rules-list', 'fail', '.claude/rules/ directory not found');
  const declared = namesFromDocList(claudeMd, /##\s+§15\s+/);
  const actual = filesInDir(rulesDir, '.md');
  const missingFiles = declared.filter((d) => !actual.includes(d));
  const missingFromDoc = actual.filter((a) => !declared.includes(a));
  if (missingFiles.length === 0 && missingFromDoc.length === 0) {
    return addResult('rules-list', 'pass', `CLAUDE.md §15 (${declared.length} entries) matches .claude/rules/ (${actual.length} files)`);
  }
  const details = [];
  if (missingFiles.length) details.push(`Listed in §15 but file missing: ${missingFiles.join(', ')}`);
  if (missingFromDoc.length) details.push(`File exists but not in §15: ${missingFromDoc.join(', ')}`);
  addResult('rules-list', 'fail', `§15 drift: ${declared.length} listed vs ${actual.length} files`, details);
}

// ---- Check 2: agents-list ----
function canonicalNames(path) {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8').split(/\r?\n/).map((l) => { const m = l.match(/^\s*-\s+`([a-z0-9-]+)`/); return m ? m[1] : null; }).filter(Boolean).sort();
}
function checkAgentsList() {
  const agentsDir = join(FactoryRoot, '.claude', 'agents');
  const actual = filesInDir(agentsDir, '.md');
  const canonical = canonicalNames(join(FactoryRoot, '.claude', 'INSTALLED-AGENTS.md'));
  if (canonical === null) return addResult('agents-list', 'warn', `No .claude/INSTALLED-AGENTS.md canonical registry; actual: ${actual.length} agents in .claude/agents/`);
  const missing = canonical.filter((c) => !actual.includes(c));
  const extra = actual.filter((a) => !canonical.includes(a));
  if (missing.length === 0 && extra.length === 0) addResult('agents-list', 'pass', `INSTALLED-AGENTS.md (${canonical.length}) matches .claude/agents/ (${actual.length})`);
  else {
    const details = [];
    if (missing.length) details.push(`Listed in INSTALLED-AGENTS.md but file missing: ${missing.join(', ')}`);
    if (extra.length) details.push(`File exists but not in INSTALLED-AGENTS.md: ${extra.join(', ')}`);
    addResult('agents-list', 'fail', `agents drift: canonical=${canonical.length} vs files=${actual.length}`, details);
  }
}

// ---- Check 3: skills-list ----
function checkSkillsList() {
  const skillsDir = join(FactoryRoot, '.claude', 'skills');
  if (!existsSync(skillsDir)) return addResult('skills-list', 'warn', '.claude/skills/ does not exist');
  const actualSkills = readdirSync(skillsDir).filter((n) => { const p = join(skillsDir, n); return statSync(p).isDirectory() && existsSync(join(p, 'SKILL.md')); }).sort();
  const canonical = canonicalNames(join(FactoryRoot, '.claude', 'INSTALLED-SKILLS.md'));
  if (canonical === null) return addResult('skills-list', 'warn', `No .claude/INSTALLED-SKILLS.md canonical registry; actual: ${actualSkills.length} factory skills`);
  const missing = canonical.filter((c) => !actualSkills.includes(c));
  const extra = actualSkills.filter((a) => !canonical.includes(a));
  if (missing.length === 0 && extra.length === 0) addResult('skills-list', 'pass', `INSTALLED-SKILLS.md (${canonical.length}) matches .claude/skills/ (${actualSkills.length})`);
  else {
    const details = [];
    if (missing.length) details.push(`Listed in INSTALLED-SKILLS.md but dir missing: ${missing.join(', ')}`);
    if (extra.length) details.push(`Dir exists but not in INSTALLED-SKILLS.md: ${extra.join(', ')}`);
    addResult('skills-list', 'fail', `skills drift: canonical=${canonical.length} vs dirs=${actualSkills.length}`, details);
  }
}

// ---- Check 4: scripts-list ----
function checkScriptsList() {
  const scriptsDir = join(FactoryRoot, 'scripts');
  const actual = filesInDir(scriptsDir, '.ps1');
  const docFiles = [];
  for (const f of ['CLAUDE.md', 'VERSION.md', 'NEXT_SESSION.md', 'POST_MERGE_ACTIONS.md', 'CURRENT_SPRINT.md']) {
    let p = join(FactoryRoot, f);
    if (!existsSync(p)) p = join(FactoryRoot, '.claude', 'CLAUDE.md');
    if (existsSync(p)) docFiles.push(p);
  }
  // Rule bodies that cite scripts live in the relocated corpus since Context V2 Delivery 3.
  const rulesDir = join(FactoryRoot, 'docs', 'rules-reference', 'factory');
  if (existsSync(rulesDir)) for (const f of readdirSync(rulesDir).filter((x) => x.endsWith('.md'))) docFiles.push(join(rulesDir, f));
  const referenced = new Set();
  for (const df of docFiles) {
    if (!existsSync(df)) continue;
    for (const m of readFileSync(df, 'utf8').matchAll(/(?:scripts[/\\])([a-z0-9-]+)\.ps1/g)) referenced.add(m[1]);
  }
  const refArr = [...referenced];
  const missing = refArr.filter((r) => !actual.includes(r));
  if (missing.length === 0) addResult('scripts-list', 'pass', `${refArr.length} script(s) referenced in docs, all present in scripts/`);
  else addResult('scripts-list', 'fail', `${missing.length} script(s) referenced in docs but file missing`, [`Missing: ${missing.join(', ')}`]);
}

// ---- Check 5: mirror-freshness (CONTENT-BASED, profile-aware, Unicode-faithful) ----
// Normalize line endings only. Removing non-ASCII characters would let mojibake pass as a
// fresh mirror even though it changes the source's meaning and bytes.
const fold = (s) => s.replace(/\r/g, '');
const TIER_CASCADE = { essential: ['essential'], standard: ['essential', 'standard'], full: ['essential', 'standard', 'full'] };
function ruleMetaOf(content) {
  let raw = content;
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  const frontmatter = raw.match(/^---\s*\r?\n([\s\S]+?)\r?\n---/);
  const fields = frontmatter ? frontmatter[1] : '';
  const field = (name) => {
    const match = fields.match(new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, 'm'));
    return match ? match[1].trim() : null;
  };
  const profilesRaw = field('profiles');
  const profiles = profilesRaw && /^\[.*\]$/.test(profilesRaw)
    ? profilesRaw.slice(1, -1).split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    : null;
  const tier = field('tier') || 'standard';
  return {
    tier,
    required: /^true$/i.test(field('required') || ''),
    loadBearing: tier === 'load-bearing' || /^true$/i.test(field('load_bearing') || ''),
    profiles,
  };
}
function readActiveProfile() {
  for (const p of [join(FactoryRoot, '.forge', 'profile.json'), join(FactoryRoot, '.forge', 'default-profile.json')]) {
    if (existsSync(p)) { try { const j = JSON.parse(readFileSync(p, 'utf8')); if (j.profile) return j.profile; } catch { /* ignore */ } }
  }
  return null;
}
function profileRuleTier(profileName) {
  const p = join(FactoryRoot, '.forge', 'profiles', `${profileName}.json`);
  if (existsSync(p)) { try { return JSON.parse(readFileSync(p, 'utf8')).rule_tier || 'standard'; } catch { /* ignore */ } }
  return 'standard';
}
function checkMirrorFreshness() {
  if (compactMode()) return checkCompact('mirror-freshness');
  const rulesDir = join(FactoryRoot, '.claude', 'rules');
  if (!existsSync(rulesDir)) return addResult('mirror-freshness', 'skip', '.claude/rules/ does not exist');
  const ruleNames = filesInDir(rulesDir, '.md');
  if (ruleNames.length === 0) return addResult('mirror-freshness', 'skip', 'No rule files found');
  const rules = ruleNames.map((n) => {
    const content = readFileSync(join(rulesDir, `${n}.md`), 'utf8');
    return { name: n, folded: fold(content), ...ruleMetaOf(content) };
  });
  const stale = [];

  // (a) GEMINI.md is the FULL mirror: every rule's folded body must be present.
  const geminiP = join(FactoryRoot, 'GEMINI.md');
  if (!existsSync(geminiP)) stale.push('GEMINI.md (missing)');
  else { const g = fold(readFileSync(geminiP, 'utf8')); for (const r of rules) if (!g.includes(r.folded)) stale.push(`GEMINI.md stale: '${r.name}' content not mirrored (edited but not re-synced?)`); }

  // (b) AGENTS.md is the ACTIVE profile's tier-filtered variant (forge profile.ps1 copies
  //     AGENTS-<profile>.md -> AGENTS.md). It must (i) equal that variant and (ii) carry every
  //     applicable rule in the active profile's tier cascade plus every applicable required or
  //     load-bearing rule. Inactive variants are not content-checked -- AGENTS.md is served.
  const agentsP = join(FactoryRoot, 'AGENTS.md');
  const active = readActiveProfile();
  if (!existsSync(agentsP)) stale.push('AGENTS.md (missing)');
  else if (active) {
    const variantP = join(FactoryRoot, `AGENTS-${active}.md`);
    if (!existsSync(variantP)) stale.push(`AGENTS-${active}.md (active variant missing)`);
    else if (norm(readFileSync(agentsP, 'utf8')) !== norm(readFileSync(variantP, 'utf8'))) stale.push(`AGENTS.md != AGENTS-${active}.md (active profile not re-activated after sync?)`);
    const allowed = TIER_CASCADE[profileRuleTier(active)] || TIER_CASCADE.full;
    const aFold = fold(readFileSync(agentsP, 'utf8'));
    for (const r of rules) {
      const applicable = !r.profiles || r.profiles.includes(active);
      const requiredInProfile = r.required || r.loadBearing || allowed.includes(r.tier);
      if (applicable && requiredInProfile && !aFold.includes(r.folded)) {
        stale.push(`AGENTS.md stale: '${r.name}' (tier ${r.tier}) not mirrored for active profile '${active}'`);
      }
    }
  }

  // (c) .cursor/rules/<rule>.mdc: per-rule folded body + count.
  const cursorDir = join(FactoryRoot, '.cursor', 'rules');
  if (existsSync(cursorDir)) {
    const mdcCount = readdirSync(cursorDir).filter((f) => f.toLowerCase().endsWith('.mdc')).length;
    if (mdcCount !== rules.length) stale.push(`.cursor/rules (${mdcCount} .mdc files vs ${rules.length} source rules)`);
    for (const r of rules) {
      const mdc = join(cursorDir, `${r.name}.mdc`);
      if (!existsSync(mdc)) stale.push(`.cursor/rules missing ${r.name}.mdc`);
      else if (!fold(readFileSync(mdc, 'utf8')).includes(r.folded)) stale.push(`.cursor/rules/${r.name}.mdc stale (content)`);
    }
  } else stale.push('.cursor/rules (missing)');

  // (d) condensed mirrors are summaries (no per-rule body to verify): presence only.
  for (const mirror of ['.windsurfrules', 'PERPLEXITY_SPACE_INSTRUCTIONS.md']) {
    if (!existsSync(join(FactoryRoot, mirror))) stale.push(`${mirror} (missing)`);
  }

  if (stale.length === 0) addResult('mirror-freshness', 'pass', 'All mirror sets reflect current rule content (profile-aware content-equivalence)');
  else addResult('mirror-freshness', 'fail', `${stale.length} stale mirror(s)`, stale.slice(0, 12));
}

// ---- Check 6: version-citations ----
function checkVersionCitations() {
  const versionMd = join(FactoryRoot, 'VERSION.md');
  if (!existsSync(versionMd)) return addResult('version-citations', 'skip', 'VERSION.md not found');
  const content = readFileSync(versionMd, 'utf8');
  const actionLines = [...content.matchAll(/^\s*[-*]\s+\*?\*?(Updated|Added|Fixed|Changed)\s+`?[^`\n]+`?[^`\n]*$/gm)];
  const missing = [];
  for (const m of actionLines) {
    const line = m[0];
    const hasHash = /\(commit\s+[a-f0-9]{6,40}\)/.test(line) || /\[commit\s+[a-f0-9]{6,40}\]/.test(line);
    const hasHistorical = /\((historical|pre-v[0-9.]+)\)/.test(line);
    if (!hasHash && !hasHistorical) missing.push(line.trim());
  }
  if (missing.length === 0) addResult('version-citations', 'pass', `All ${actionLines.length} 'Updated/Added/Fixed/Changed' entries have commit hash citations`);
  else addResult('version-citations', 'warn', `${missing.length} entries lack commit hash citation`, missing.slice(0, 5));
}

// ---- Check 7: rule-reference-integrity (delegates to the .mjs twin) ----
function checkRuleReferenceIntegrity() {
  const verifier = join(FactoryRoot, 'scripts', 'verify-rule-reference-integrity.mjs');
  if (!existsSync(verifier)) return addResult('rule-reference-integrity', 'skip', `Verifier script not found at ${verifier}`);
  const r = spawnSync(process.execPath, [verifier, '--root', FactoryRoot, '--json'], { encoding: 'utf8' });
  let j = null; try { j = JSON.parse(r.stdout); } catch { /* null */ }
  if (!j) return addResult('rule-reference-integrity', 'fail', 'rule-reference verifier produced no parseable output', [(r.stderr || '').trim()]);
  const broken = (j.missing_file || 0) + (j.missing_section || 0);
  if (broken === 0) addResult('rule-reference-integrity', 'pass', 'All cross-file rule references resolve');
  else addResult('rule-reference-integrity', 'fail', `${broken} broken cross-references`, j.results.filter((x) => x.verdict !== 'ok').slice(0, 12).map((x) => `[${x.verdict}] ${x.source} -> ${x.target}${x.section ? ' SS' + x.section : ''}`));
}

const CHECKS = {
  'rules-list': checkRulesList, 'agents-list': checkAgentsList, 'skills-list': checkSkillsList,
  'scripts-list': checkScriptsList, 'mirror-freshness': checkMirrorFreshness,
  'version-citations': checkVersionCitations, 'rule-reference-integrity': checkRuleReferenceIntegrity,
};

const toRun = Check === 'all' ? Object.keys(CHECKS).sort() : [Check];
for (const c of toRun) { if (CHECKS[c]) CHECKS[c](); }

const passes = results.filter((r) => r.status === 'pass').length;
const warnings = results.filter((r) => r.status === 'warn').length;
const skips = results.filter((r) => r.status === 'skip').length;

if (asJson) {
  process.stdout.write(JSON.stringify({ factory_root: FactoryRoot, check_arg: Check, passes, warnings, failures: failureCount, skips, results }, null, 2) + '\n');
} else {
  console.log('\nVibePromptRig factory verification (Node)');
  for (const r of results) console.log(`  [${r.status.toUpperCase()}] ${r.check}  ${r.message}`);
  console.log(`\n  Summary: ${passes} pass / ${warnings} warn / ${skips} skip / ${failureCount} fail`);
}
// Preserve complete machine-readable failure reports when stdout is a pipe.
process.exitCode = failureCount;
