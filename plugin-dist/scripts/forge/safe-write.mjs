// safe-write.mjs -- Phase 1 of `forge adopt` (docs/architecture/forge-adopt.md §2 Layer 1, §9.1).
//
// The safe-write FOUNDATION: hash manifest + drift detection + backup-first + additive-by-default.
// It kills the two failure modes of the old onboarding (skip-existing -> silent staleness; -Force ->
// blind clobber, no backup) on its own. Everything in Phases 2-4 (review/apply) calls THIS.
//
// DESIGN (resolves forge-adopt.md §13.1/§13.2/§13.4):
//   * Leaf module: imports only Node built-ins. `forge adopt`, `/setup`, and onboard's -Force path
//     all import IT -> one engine, no circular dependency (same shape as config-lib.mjs).
//   * Manifest `.forge/factory-manifest.json` records the SHA256 + template_version of the *factory
//     bytes we wrote*, per file -> the anchor drift detection compares against.
//   * Drift is CONTENT-based: hashing normalizes CRLF->LF so a cross-platform line-ending flip never
//     reads as a user customization. (Erring here is safe anyway: a false "diverged" refuses to
//     write; only a false "unchanged" could clobber, and content-hashing prevents that.)
//   * Backup-first is a TRANSACTION LOG: rollback-manifest.json is written BEFORE the first write,
//     status "in-progress", every op applied:false; each write flips its op applied:true and
//     re-flushes; commit -> "complete". An interrupted apply is therefore always recoverable to a
//     consistent state via restore() (all-or-nothing rollback -- the safe default).
//
// LOAD-BEARING INVARIANTS (the founder independently verifies these):
//   1. A DIVERGED file is NEVER overwritten by the default path -- it gets a `.factory-new` sidecar
//      and the original stays byte-identical.
//   2. Backups actually restore -- restore(ts) returns every touched file to its exact pre-apply
//      state (upgrades reverted byte-for-byte, adds removed), even from a partial/interrupted run.
//
// ESM, LF, UTF-8 no BOM. Node >= 18. No dependencies.

import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, realpathSync,
} from 'node:fs';
import { join, dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';

// ---- paths ----
export function forgeDir(projectRoot) { return join(projectRoot, '.forge'); }
export function manifestPath(projectRoot) { return resolvePathInside(projectRoot, '.forge/factory-manifest.json'); }
export function backupsRoot(projectRoot) { return resolvePathInside(projectRoot, '.forge/backups'); }

// relPath is ALWAYS stored forward-slash (cross-OS stable); convert to an OS path on disk.
function isOutside(root, target) {
  const rel = relative(root, target);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

// Resolve lexically, then resolve the deepest existing ancestor physically. This catches
// traversal plus symlink/junction escapes before a caller creates or changes anything.
export function resolvePathInside(projectRoot, relPath) {
  const root = resolve(projectRoot);
  if (!existsSync(root)) throw new Error(`Project root does not exist: ${root}`);
  const value = String(relPath || '');
  if (!value || isAbsolute(value)) throw new Error(`Path must be relative to the project root: ${value}`);
  const target = resolve(root, normalize(value.replaceAll('/', sep)));
  if (isOutside(root, target)) throw new Error(`Path escapes project root: ${value}`);
  const physicalRoot = realpathSync.native(root);
  let ancestor = target;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`Cannot resolve path inside project root: ${value}`);
    ancestor = parent;
  }
  const physicalAncestor = realpathSync.native(ancestor);
  if (isOutside(physicalRoot, physicalAncestor)) throw new Error(`Path escapes project root through a symlink or junction: ${value}`);
  return target;
}
function toDiskPath(projectRoot, relPath) { return resolvePathInside(projectRoot, relPath); }
function nowIso() { return new Date().toISOString(); }
function ensureDir(p) { if (!existsSync(p)) mkdirSync(p, { recursive: true }); }

// ---- hashing (content identity; CRLF-insensitive) ----
export function sha256(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  // Normalize CRLF->LF for content identity so line-ending flips don't read as user edits.
  const norm = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  return createHash('sha256').update(norm).digest('hex');
}

// Exact byte identity for reviewed replacements and rollback edit detection. Drift classification
// remains CRLF-insensitive for cross-platform ownership, but a review/backup binds physical bytes.
export function exactSha256(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  return createHash('sha256').update(buf).digest('hex');
}

// ---- manifest ----
export function readManifest(projectRoot) {
  const p = toDiskPath(projectRoot, '.forge/factory-manifest.json');
  if (!existsSync(p)) return { version: 1, plugin_version: null, updated_at: null, files: {} };
  try {
    let raw = readFileSync(p, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const m = JSON.parse(raw);
    if (!m.files || typeof m.files !== 'object') m.files = {};
    if (!m.version) m.version = 1;
    return m;
  } catch {
    // A corrupt manifest must NEVER cause a clobber: treat as "no record" -> everything reads as
    // diverged/absent (the safe side), never as unchanged.
    return { version: 1, plugin_version: null, updated_at: null, files: {}, _unreadable: true };
  }
}

// Record (idempotently) that we wrote `content` for `relPath` at `templateVersion`.
// Returns true iff the recorded hash/version actually changed (preserves written_at otherwise).
export function recordFile(manifest, relPath, content, templateVersion) {
  const h = sha256(content);
  const prev = manifest.files[relPath];
  if (prev && prev.sha256 === h && prev.template_version === templateVersion) return false;
  manifest.files[relPath] = { sha256: h, template_version: templateVersion, written_at: nowIso() };
  return true;
}

// Persist the manifest, but ONLY if its files-map actually changed (keeps no-op re-runs byte-stable
// -> idempotency, forge-adopt.md §11). Returns true iff it wrote.
export function writeManifest(projectRoot, manifest, pluginVersion) {
  const p = toDiskPath(projectRoot, '.forge/factory-manifest.json');
  let existingFiles = null;
  if (existsSync(p)) {
    try { existingFiles = JSON.parse(readFileSync(p, 'utf8')).files || null; } catch { existingFiles = null; }
  }
  const same = existingFiles && JSON.stringify(existingFiles) === JSON.stringify(manifest.files);
  if (same) return false;
  ensureDir(forgeDir(projectRoot));
  const out = {
    version: manifest.version || 1,
    plugin_version: pluginVersion ?? manifest.plugin_version ?? null,
    updated_at: nowIso(),
    files: manifest.files,
  };
  writeFileSync(p, JSON.stringify(out, null, 2) + '\n', 'utf8');
  return true;
}

// ---- drift detection ----
// states: 'absent' | 'unchanged' | 'upgrade' | 'diverged'
export function classifyDrift({ projectRoot, relPath, factoryContent, manifest }) {
  const disk = toDiskPath(projectRoot, relPath);
  const factoryHash = sha256(factoryContent);
  const rec = manifest && manifest.files ? manifest.files[relPath] : null;
  const recordedHash = rec ? rec.sha256 : null;
  if (!existsSync(disk)) return { state: 'absent', projectHash: null, factoryHash, recordedHash };
  const projectHash = sha256(readFileSync(disk, 'utf8'));
  if (projectHash === factoryHash) return { state: 'unchanged', projectHash, factoryHash, recordedHash };
  if (recordedHash && projectHash === recordedHash) return { state: 'upgrade', projectHash, factoryHash, recordedHash };
  // matches neither current factory nor what we last wrote -> user-customized -> never auto-touch.
  return { state: 'diverged', projectHash, factoryHash, recordedHash };
}

// ---- transaction (backup-first + rollback log) ----
function backupRel(ts, ...parts) { return ['.forge', 'backups', String(ts), ...parts].join('/'); }
function rollbackManifestPath(projectRoot, ts) { return toDiskPath(projectRoot, backupRel(ts, 'rollback-manifest.json')); }
function tsForFilename() { return nowIso().replace(/[:.]/g, '-'); }

// ops: [{ relPath, action: 'add' | 'upgrade' | 'remove' }]  -- action describes the intended change.
// Snapshots every pre-image (upgrades and removals) THEN writes the in-progress log, BEFORE any
// caller write. A 'remove' is the backup-first deletion used by legacy cleanup (forge legacy-rules):
// its preimage restores byte-for-byte, and rollback refuses if the path was re-created afterwards.
export function beginTransaction(projectRoot, ops, { pluginVersion = null, ts = null } = {}) {
  const stamp = ts || tsForFilename();
  const dir = toDiskPath(projectRoot, backupRel(stamp));
  // Complete preflight: no backup or destination path is touched until every path passes the jail.
  toDiskPath(projectRoot, '.forge/factory-manifest.json');
  for (const op of ops) {
    toDiskPath(projectRoot, op.relPath);
    if (op.action === 'upgrade' || op.action === 'remove') toDiskPath(projectRoot, backupRel(stamp, 'files', ...String(op.relPath).split('/')));
  }
  ensureDir(dir);
  const ownershipManifest = toDiskPath(projectRoot, '.forge/factory-manifest.json');
  const ownershipHadPreimage = existsSync(ownershipManifest);
  const ownershipPreimage = ownershipHadPreimage ? readFileSync(ownershipManifest) : null;
  if (ownershipHadPreimage) writeFileSync(toDiskPath(projectRoot, backupRel(stamp, 'factory-manifest.preimage')), ownershipPreimage);
  const operations = [];
  for (const op of ops) {
    const disk = toDiskPath(projectRoot, op.relPath);
    const hadPreimage = existsSync(disk);
    if ((op.action === 'upgrade' || op.action === 'remove') && hadPreimage) {
      const dest = toDiskPath(projectRoot, backupRel(stamp, 'files', ...String(op.relPath).split('/')));
      ensureDir(dirname(dest));
      writeFileSync(dest, readFileSync(disk)); // raw bytes -> exact restore
    }
    operations.push({
      relPath: op.relPath,
      action: op.action,
      had_preimage: hadPreimage,
      preimage_sha256: hadPreimage ? exactSha256(readFileSync(disk)) : null,
      expected_post_sha256: null,
      applied: false,
    });
  }
  const manifest = {
    version: 1, backup_ts: stamp, started_at: nowIso(), status: 'in-progress',
    plugin_version: pluginVersion, ownership_manifest_had_preimage: ownershipHadPreimage,
    ownership_manifest_preimage_sha256: ownershipPreimage ? exactSha256(ownershipPreimage) : null,
    operations,
  };
  ensureDir(dir);
  writeFileSync(rollbackManifestPath(projectRoot, stamp), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { ts: stamp, dir, projectRoot, manifest };
}

// Flip an op to applied:true and RE-FLUSH the log immediately (so an interruption is truthful).
export function markApplied(tx, relPath, postimage = null) {
  const op = tx.manifest.operations.find((o) => o.relPath === relPath);
  if (op) {
    op.applied = true;
    if (postimage !== null) op.expected_post_sha256 = exactSha256(postimage);
  }
  writeFileSync(rollbackManifestPath(tx.projectRoot, tx.ts), JSON.stringify(tx.manifest, null, 2) + '\n', 'utf8');
}

export function recordOwnershipPostimage(tx) {
  const ownershipManifest = toDiskPath(tx.projectRoot, '.forge/factory-manifest.json');
  tx.manifest.ownership_manifest_post_sha256 = existsSync(ownershipManifest)
    ? exactSha256(readFileSync(ownershipManifest))
    : null;
  writeFileSync(rollbackManifestPath(tx.projectRoot, tx.ts), JSON.stringify(tx.manifest, null, 2) + '\n', 'utf8');
}

export function commitTransaction(tx) {
  tx.manifest.status = 'complete';
  tx.manifest.completed_at = nowIso();
  writeFileSync(rollbackManifestPath(tx.projectRoot, tx.ts), JSON.stringify(tx.manifest, null, 2) + '\n', 'utf8');
}

// Any backup whose log is still 'in-progress' = an interrupted apply that needs resolve (restore).
export function findIncompleteTransactions(projectRoot) {
  const root = backupsRoot(projectRoot);
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    const rmp = rollbackManifestPath(projectRoot, name);
    if (!existsSync(rmp)) continue;
    try {
      const m = JSON.parse(readFileSync(rmp, 'utf8'));
      if (m.status === 'in-progress') out.push({ ts: name, manifest: m });
    } catch { /* unreadable log: skip (do not crash recovery) */ }
  }
  return out;
}

// Restore the project to its EXACT pre-apply state for backup `ts` (all-or-nothing rollback).
//   upgrade w/ preimage -> copy preimage back (whether or not it was applied -- preimage IS pre-state)
//   remove w/ preimage  -> restore deleted paths; preserve existing, unapplied paths
//                         (including newer edits made before an interrupted apply reaches them)
//   add that WAS applied -> delete the added file
//   add not applied     -> nothing (the add never happened)
// Returns a per-file summary. Consistent regardless of where an interruption occurred.
export function restore(projectRoot, ts) {
  const rmp = rollbackManifestPath(projectRoot, ts);
  if (!existsSync(rmp)) throw new Error(`No rollback manifest for backup '${ts}'`);
  const m = JSON.parse(readFileSync(rmp, 'utf8'));
  // Validate the complete rollback set before the first mutation.
  for (const op of m.operations || []) {
    toDiskPath(projectRoot, op.relPath);
    if ((op.action === 'upgrade' || op.action === 'remove') && op.had_preimage) {
      const preimage = toDiskPath(projectRoot, backupRel(ts, 'files', ...String(op.relPath).split('/')));
      if (!existsSync(preimage)) throw new Error(`Missing file preimage for '${op.relPath}' in backup '${ts}'`);
      if (op.preimage_sha256 && exactSha256(readFileSync(preimage)) !== op.preimage_sha256) {
        throw new Error(`Corrupt file preimage for '${op.relPath}' in backup '${ts}'`);
      }
    }
  }
  const ownershipManifest = toDiskPath(projectRoot, '.forge/factory-manifest.json');
  const ownershipPreimage = toDiskPath(projectRoot, backupRel(ts, 'factory-manifest.preimage'));
  if (m.ownership_manifest_had_preimage && !existsSync(ownershipPreimage)) {
    throw new Error(`Missing ownership manifest preimage for backup '${ts}'`);
  }
  if (m.ownership_manifest_had_preimage && m.ownership_manifest_preimage_sha256
      && exactSha256(readFileSync(ownershipPreimage)) !== m.ownership_manifest_preimage_sha256) {
    throw new Error(`Corrupt ownership manifest preimage for backup '${ts}'`);
  }
  // Re-created removal targets are user data even during interrupted recovery.
  for (const op of m.operations || []) {
    if (op.applied && op.action === 'remove' && existsSync(toDiskPath(projectRoot, op.relPath))) {
      throw new Error(`Rollback refused: '${op.relPath}' was re-created after it was removed.`);
    }
  }
  // A completed transaction may be rolled back only while its installed postimage is intact.
  // This prevents rollback from silently erasing edits made after installation.
  if (m.status !== 'in-progress') {
    for (const op of m.operations || []) {
      if (!op.applied || !op.expected_post_sha256) continue;
      const disk = toDiskPath(projectRoot, op.relPath);
      const current = existsSync(disk) ? exactSha256(readFileSync(disk)) : null;
      if (current !== op.expected_post_sha256) throw new Error(`Rollback refused: '${op.relPath}' changed after apply.`);
    }
    if (Object.hasOwn(m, 'ownership_manifest_post_sha256')) {
      const currentOwnership = existsSync(ownershipManifest) ? exactSha256(readFileSync(ownershipManifest)) : null;
      if (currentOwnership !== m.ownership_manifest_post_sha256) throw new Error('Rollback refused: ownership metadata changed after apply.');
    }
  }
  const results = [];
  for (const op of m.operations) {
    const disk = toDiskPath(projectRoot, op.relPath);
    if (op.action === 'remove' && !op.applied && existsSync(disk)) {
      results.push({ relPath: op.relPath, restored: 'noop' });
      continue;
    }
    // An absent, unapplied removal can be a crash between unlink and log flush.
    // Restore that preimage too; an existing unapplied path above is never overwritten.
    if ((op.action === 'upgrade' || op.action === 'remove') && op.had_preimage) {
      const src = toDiskPath(projectRoot, backupRel(ts, 'files', ...String(op.relPath).split('/')));
      ensureDir(dirname(disk));
      writeFileSync(disk, readFileSync(src));
      results.push({ relPath: op.relPath, restored: `${op.action}->preimage` });
    } else if (op.action === 'add' && op.applied) {
      if (existsSync(disk)) rmSync(disk, { force: true });
      results.push({ relPath: op.relPath, restored: 'add->removed' });
    } else {
      results.push({ relPath: op.relPath, restored: 'noop' });
    }
  }
  if (m.ownership_manifest_had_preimage) {
    ensureDir(dirname(ownershipManifest));
    writeFileSync(ownershipManifest, readFileSync(ownershipPreimage));
  } else if (existsSync(ownershipManifest)) rmSync(ownershipManifest, { force: true });
  m.status = 'rolled-back';
  m.rolled_back_at = nowIso();
  writeFileSync(rmp, JSON.stringify(m, null, 2) + '\n', 'utf8');
  return results;
}

// ---- the safe write (additive default; backup-first for overwrites; NEVER clobbers diverged) ----
// opts: { projectRoot, relPath, content, templateVersion, manifest, tx=null, allowDiverged=false }
//   manifest is mutated (caller persists once via writeManifest). tx is required for any overwrite.
// Returns { action, written, drift, sidecar? }.
export function safeWrite({ projectRoot, relPath, content, templateVersion, manifest, tx = null, allowDiverged = false }) {
  const drift = classifyDrift({ projectRoot, relPath, factoryContent: content, manifest });
  const disk = toDiskPath(projectRoot, relPath);

  if (drift.state === 'absent') {
    ensureDir(dirname(disk));
    writeFileSync(disk, content, 'utf8');
    recordFile(manifest, relPath, content, templateVersion);
    if (tx) markApplied(tx, relPath, content);
    return { action: 'add', written: true, drift };
  }

  if (drift.state === 'unchanged') {
    // idempotent: file already IS current factory. Record the (possibly newer) template_version,
    // never rewrite the file -> no churn.
    recordFile(manifest, relPath, content, templateVersion);
    return { action: 'keep', written: false, drift };
  }

  if (drift.state === 'upgrade') {
    if (!tx) throw new Error(`safeWrite upgrade of '${relPath}' requires a transaction (backup-first)`);
    writeFileSync(disk, content, 'utf8');
    recordFile(manifest, relPath, content, templateVersion);
    markApplied(tx, relPath, content);
    return { action: 'upgrade', written: true, drift };
  }

  // drift.state === 'diverged'
  if (!allowDiverged) {
    // INVARIANT 1: never overwrite. Emit a sidecar next to the original; original untouched.
    const sidecarRel = `${relPath}.factory-new`;
    const sidecarDisk = toDiskPath(projectRoot, sidecarRel);
    ensureDir(dirname(sidecarDisk));
    writeFileSync(sidecarDisk, content, 'utf8');
    return { action: 'diverged', written: false, drift, sidecar: sidecarRel };
  }
  // explicit per-item opt-in (Phase 4 --interactive): still backup-first.
  if (!tx) throw new Error(`safeWrite diverged-overwrite of '${relPath}' requires a transaction (backup-first)`);
  writeFileSync(disk, content, 'utf8');
  recordFile(manifest, relPath, content, templateVersion);
  markApplied(tx, relPath, content);
  return { action: 'diverged-overwritten', written: true, drift };
}

// Convenience: read the plugin template_version stamp (best-effort; null if unavailable).
export function readPluginVersion(factoryRoot) {
  try {
    const p = join(factoryRoot, '.claude-plugin', 'plugin.json');
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')).version ?? null;
  } catch { /* fall through */ }
  return null;
}

export const _internal = { toDiskPath, tsForFilename, rollbackManifestPath };
