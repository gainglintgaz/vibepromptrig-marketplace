#!/usr/bin/env node
// legacy-rules.mjs -- reviewed, backup-first cleanup of factory rule copies that older VibePromptRig
// onboard/scaffold/adopt/setup runs placed in a project's native autoload directories
// (.claude/rules/** and .cursor/rules/**). Context V2 Delivery 3b; design:
// docs/architecture/context-v2-delivery-3b.md.
//
//   plan     --project-root <p> [--out <file>]     zero-write inventory + planned actions (JSON)
//   apply    --project-root <p> --plan <file>      remove exactly the reviewed factory-owned copies
//   rollback --project-root <p> --backup <ts>      restore a completed or interrupted cleanup
//   catalog  [--write] [--commit <sha>]            regenerate / check the ownership catalog (source only)
//
// A file is removed only when it is PROVEN factory-owned for its exact project-relative path: the
// project's .forge/factory-manifest.json records its current hash, or its normalized hash is a
// historical factory version of that path (.forge/context/legacy-rule-hashes.json, generated from
// git history). Known factory paths with unknown content are conflicts and stay byte-identical;
// every other file is custom and untouched. Removal reuses the safe-write transaction log.

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import {
  beginTransaction, commitTransaction, exactSha256, markApplied, readManifest, recordOwnershipPostimage,
  resolvePathInside, restore, sha256 as manifestSha256, writeManifest,
} from './safe-write.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const defaultFactoryRoot = dirname(dirname(here));
export const CATALOG_PATH = '.forge/context/legacy-rule-hashes.json';
export const SCANNED_DIRS = ['.claude/rules', '.cursor/rules'];
// Compact routing entries written by the compact installer; never legacy content.
const COMPACT_ENTRIES = new Set(['.cursor/rules/vf-context-core.mdc', '.claude/rules/vf-context-core.md']);
// Factory history path -> project path it was copied to by a historical installer.
const HISTORY_SOURCES = [
  { pattern: /^\.claude\/rules\/(.+\.md)$/, to: (m) => `.claude/rules/${m[1]}` },
  { pattern: /^docs\/rules-reference\/factory\/(.+\.md)$/, to: (m) => `.claude/rules/${m[1]}` },
  { pattern: /^scripts\/templates\/packs\/[^/]+\/rules\/(.+\.md)$/, to: (m) => `.claude/rules/${m[1]}` },
  { pattern: /^\.cursor\/rules\/([^/]+\.mdc)$/, to: (m) => `.cursor/rules/${m[1]}` },
];
const HISTORY_PATHS = ['.claude/rules', 'docs/rules-reference/factory', 'scripts/templates/packs', '.cursor/rules'];
// The current Cursor distribution (forge adopt --target cursor) ships these lean templates; a
// project copy of any version of them is kept, never removed.
const LEAN_TEMPLATE_DIR = 'scripts/templates/cursor/rules';

// Ownership identity: UTF-8 bytes with one leading BOM removed and CRLF folded to LF, so a Windows
// checkout or a PowerShell re-save of an unedited factory file still proves ownership.
export function contentHash(bytes) {
  let text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function git(factoryRoot, args, input) {
  const result = spawnSync('git', ['-C', factoryRoot, ...args], { encoding: 'buffer', input, maxBuffer: 512 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${String(result.stderr || '').trim()}`);
  return result.stdout;
}

// Deterministic: every blob ever committed at a historical source path, reachable from `commit`.
export function generateCatalog(factoryRoot, commit) {
  if (String(git(factoryRoot, ['rev-parse', '--is-shallow-repository'])).trim() === 'true') {
    throw new Error('catalog generation needs full git history (this clone is shallow; run git fetch --unshallow)');
  }
  const log = String(git(factoryRoot, ['log', commit, '--full-history', '--format=', '--raw', '--no-abbrev', '--no-renames', '--', ...HISTORY_PATHS]));
  const blobs = new Map(); // blob -> Set(projectPath)
  const lean = new Set();
  for (const line of log.split('\n')) {
    const match = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) [AMT]\t(.+)$/.exec(line);
    if (!match) continue;
    const [, blob, path] = match;
    for (const source of HISTORY_SOURCES) {
      const m = source.pattern.exec(path);
      if (!m) continue;
      if (!blobs.has(blob)) blobs.set(blob, new Set());
      blobs.get(blob).add(source.to(m));
    }
  }
  const leanLog = String(git(factoryRoot, ['log', commit, '--full-history', '--format=', '--raw', '--no-abbrev', '--no-renames', '--', LEAN_TEMPLATE_DIR]));
  const leanBlobs = new Map();
  for (const line of leanLog.split('\n')) {
    const match = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) [AMT]\t(.+)$/.exec(line);
    const name = match && /^scripts\/templates\/cursor\/rules\/([^/]+\.mdc)$/.exec(match[2]);
    if (name) leanBlobs.set(match[1], `.cursor/rules/${name[1]}`);
  }
  const hashOf = (blob) => contentHash(git(factoryRoot, ['cat-file', 'blob', blob]));
  const factoryOwned = {};
  for (const [blob, paths] of blobs) {
    const digest = hashOf(blob);
    for (const path of paths) (factoryOwned[path] ||= new Set()).add(digest);
  }
  for (const [blob, path] of leanBlobs) lean.add(`${path}\u0000${hashOf(blob)}`);
  const sortObject = (map) => Object.fromEntries(Object.keys(map).sort().map((key) => [key, [...map[key]].sort()]));
  const leanByPath = {};
  for (const entry of lean) { const [path, digest] = entry.split('\u0000'); (leanByPath[path] ||= new Set()).add(digest); }
  const resolvedCommit = String(git(factoryRoot, ['rev-parse', `${commit}^{commit}`])).trim();
  return {
    schema_version: 1,
    kind: 'legacy-rule-ownership-catalog',
    source_commit: resolvedCommit,
    hash: 'sha256 of UTF-8 content after removing one leading BOM and folding CRLF to LF',
    history_sources: ['.claude/rules/**', 'docs/rules-reference/factory/** -> .claude/rules/**', 'scripts/templates/packs/*/rules/** -> .claude/rules/**', '.cursor/rules/*.mdc'],
    factory_owned: sortObject(factoryOwned),
    current_distribution: sortObject(leanByPath),
  };
}

export function loadCatalog(factoryRoot) {
  const path = join(factoryRoot, ...CATALOG_PATH.split('/'));
  if (!existsSync(path)) throw new Error(`ownership catalog missing: ${CATALOG_PATH}`);
  const bytes = readFileSync(path);
  const catalog = JSON.parse(bytes.toString('utf8'));
  if (catalog.kind !== 'legacy-rule-ownership-catalog' || catalog.schema_version !== 1 || !catalog.factory_owned) throw new Error(`invalid ownership catalog: ${CATALOG_PATH}`);
  return { catalog, sha256: exactSha256(bytes) };
}

function walk(root, relDir) {
  const out = [];
  const dir = resolvePathInside(root, relDir);
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = `${relDir}/${entry.name}`;
    if (entry.isSymbolicLink()) { out.push({ rel, symlink: true }); continue; }
    if (entry.isDirectory()) out.push(...walk(root, rel));
    else if (entry.isFile()) out.push({ rel });
  }
  return out;
}

function classify(rel, bytes, catalog, ownership) {
  if (COMPACT_ENTRIES.has(rel)) return { classification: 'compact_entry', evidence: 'compact installer routing entry', action: 'keep' };
  if (rel.endsWith('.factory-new')) return { classification: 'custom', evidence: 'safe-write review sidecar', action: 'keep' };
  const digest = contentHash(bytes);
  if (catalog.current_distribution?.[rel]?.includes(digest)) return { classification: 'current_distribution', evidence: `lean Cursor template:${rel}`, action: 'keep' };
  const recorded = ownership.files?.[rel]?.sha256;
  if (recorded && recorded === manifestSha256(bytes)) return { classification: 'factory_owned', evidence: 'ownership_manifest_hash', action: 'remove' };
  if (catalog.factory_owned[rel]?.includes(digest)) return { classification: 'factory_owned', evidence: `factory_history:${rel}@${catalog.source_commit.slice(0, 12)}`, action: 'remove' };
  if (catalog.factory_owned[rel] || catalog.current_distribution?.[rel]) return { classification: 'divergent', evidence: 'known factory path with unrecognized content', action: 'preserve_conflict' };
  return { classification: 'custom', evidence: 'not a factory path', action: 'keep' };
}

export function buildCleanupPlan({ projectRoot, factoryRoot = defaultFactoryRoot }) {
  if (!projectRoot) throw new Error('an explicit --project-root is required');
  const root = realpathSync.native(resolve(projectRoot));
  const { catalog, sha256: catalogSha } = loadCatalog(factoryRoot);
  const ownership = readManifest(root);
  const items = [];
  for (const dir of SCANNED_DIRS) for (const entry of walk(root, dir)) {
    if (entry.symlink) { items.push({ path: entry.rel, sha256: null, classification: 'custom', evidence: 'symlink (never followed)', action: 'keep' }); continue; }
    const bytes = readFileSync(resolvePathInside(root, entry.rel));
    items.push({ path: entry.rel, sha256: exactSha256(bytes), ...classify(entry.rel, bytes, catalog, ownership) });
  }
  items.sort((a, b) => a.path.localeCompare(b.path));
  const count = (action) => items.filter((item) => item.action === action).length;
  return {
    schema_version: 1, kind: 'legacy-rules-cleanup-plan', project_root: root,
    catalog_sha256: catalogSha, catalog_source_commit: catalog.source_commit,
    items,
    summary: { remove: count('remove'), conflicts: count('preserve_conflict'), keep: count('keep') },
  };
}

// Applies exactly the reviewed plan. Any difference between the reviewed and the current inventory
// (a new, changed or missing file; another catalog; another root) refuses before the first write.
export function applyCleanupPlan({ reviewedPlan, factoryRoot = defaultFactoryRoot, failAfterRemovals = null }) {
  if (reviewedPlan?.kind !== 'legacy-rules-cleanup-plan' || reviewedPlan.schema_version !== 1) throw new Error('not a legacy-rules cleanup plan');
  const current = buildCleanupPlan({ projectRoot: reviewedPlan.project_root, factoryRoot });
  for (const key of ['project_root', 'catalog_sha256', 'catalog_source_commit', 'items']) {
    if (!isDeepStrictEqual(current[key], reviewedPlan[key])) throw new Error(`Cleanup refused: the project differs from the reviewed plan (${key}). Nothing was changed; re-run plan and review again.`);
  }
  const removals = current.items.filter((item) => item.action === 'remove');
  const conflicts = current.items.filter((item) => item.action === 'preserve_conflict');
  if (!removals.length) return { applied: false, noop: true, removed: [], conflicts, summary: current.summary };
  const root = current.project_root;
  const ownership = readManifest(root);
  const tx = beginTransaction(root, removals.map((item) => ({ relPath: item.path, action: 'remove' })), { pluginVersion: ownership.plugin_version ?? null });
  let count = 0;
  try {
    for (const item of removals) {
      const disk = resolvePathInside(root, item.path);
      if (exactSha256(readFileSync(disk)) !== item.sha256) throw new Error(`Cleanup aborted: '${item.path}' changed during apply.`);
      rmSync(disk, { force: true });
      delete ownership.files[item.path];
      markApplied(tx, item.path, null);
      if (failAfterRemovals !== null && ++count >= failAfterRemovals) throw new Error('Injected cleanup failure');
    }
    writeManifest(root, ownership, ownership.plugin_version ?? null);
    recordOwnershipPostimage(tx);
    commitTransaction(tx);
  } catch (error) {
    try { restore(root, tx.ts); } catch (restoreError) { throw new AggregateError([error, restoreError], `Cleanup failed and automatic recovery failed for backup ${tx.ts}`); }
    throw error;
  }
  return { applied: true, backup: tx.ts, removed: removals.map((item) => item.path), conflicts, summary: current.summary };
}

// Resolve aliases even when the final output file (or some parent directories) does not exist.
function physicalOutputPath(path) {
  const target = resolve(path);
  let ancestor = target;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error('Cannot resolve output path: ' + target);
    ancestor = parent;
  }
  return resolve(realpathSync.native(ancestor), relative(ancestor, target));
}

function usage(code) {
  process.stderr.write('Usage: forge legacy-rules plan --project-root <path> [--out <file>]\n'
    + '       forge legacy-rules apply --project-root <path> --plan <reviewed-plan.json>\n'
    + '       forge legacy-rules rollback --project-root <path> --backup <id>\n'
    + '       forge legacy-rules catalog [--write] [--commit <sha>]   (factory source checkout only)\n');
  process.exit(code);
}

export function main(argv = process.argv.slice(2)) {
  const action = argv.shift();
  const opts = { factoryRoot: process.env.VIBE_ROOT || defaultFactoryRoot };
  for (let i = 0; i < argv.length; i += 1) {
    const take = () => { const value = argv[++i]; if (!value) usage(1); return value; };
    const flag = argv[i];
    if (flag === '--project-root') opts.projectRoot = take();
    else if (flag === '--out') opts.out = take();
    else if (flag === '--plan') opts.plan = take();
    else if (flag === '--backup') opts.backup = take();
    else if (flag === '--commit') opts.commit = take();
    else if (flag === '--factory-root') opts.factoryRoot = take();
    else if (flag === '--write') opts.write = true;
    else usage(1);
  }
  const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  if (action === 'catalog') {
    const existing = existsSync(join(opts.factoryRoot, ...CATALOG_PATH.split('/'))) ? loadCatalog(opts.factoryRoot).catalog : null;
    const commit = opts.commit || existing?.source_commit;
    if (!commit) throw new Error('catalog needs --commit <sha> the first time');
    const generated = generateCatalog(opts.factoryRoot, commit);
    const text = `${JSON.stringify(generated, null, 2)}\n`;
    if (opts.write) { writeFileSync(join(opts.factoryRoot, ...CATALOG_PATH.split('/')), text); print({ written: CATALOG_PATH, source_commit: generated.source_commit, paths: Object.keys(generated.factory_owned).length }); return; }
    const same = existing && isDeepStrictEqual(existing, generated);
    print({ matches_committed_catalog: Boolean(same), source_commit: generated.source_commit });
    if (!same) process.exitCode = 1;
    return;
  }
  if (!opts.projectRoot) usage(1);
  if (action === 'plan') {
    const plan = buildCleanupPlan(opts);
    if (opts.out) {
      const out = resolve(opts.out);
      const physicalOut = physicalOutputPath(out);
      // Resolve both sides: the project root, output ancestors, or native directory
      // itself can be an alias. Check before creating any output parents.
      if (SCANNED_DIRS.some((dir) => {
        const rel = relative(physicalOutputPath(join(plan.project_root, dir)), physicalOut);
        return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
      })) {
        throw new Error('--out must not be inside .claude/rules or .cursor/rules');
      }
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(plan, null, 2)}\n`);
    }
    print(plan);
    return;
  }
  if (action === 'apply') {
    if (!opts.plan) usage(1);
    const reviewedPlan = JSON.parse(readFileSync(opts.plan, 'utf8'));
    if (realpathSync.native(resolve(opts.projectRoot)) !== reviewedPlan.project_root) throw new Error('Cleanup refused: --project-root differs from the reviewed plan.');
    const result = applyCleanupPlan({ reviewedPlan, factoryRoot: opts.factoryRoot });
    print(result);
    if (result.conflicts.length) process.exitCode = 3;
    return;
  }
  if (action === 'rollback') {
    if (!opts.backup) usage(1);
    print({ rollback: restore(realpathSync.native(resolve(opts.projectRoot)), opts.backup) });
    return;
  }
  usage(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { process.stderr.write(`[forge legacy-rules] ${error.message}\n`); process.exitCode = 2; }
}
