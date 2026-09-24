// custody-storage.mjs -- encrypted, opaque Supabase Storage-byte custody primitives.
//
// The detailed object map (bucket + original path + per-byte checksum) is encrypted before it
// reaches disk. Provider-visible object names are SHA-256-derived opaque keys only. This module
// deliberately has no scheduler or provider configuration side effects.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function sha256Buffer(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256File(path) {
  return sha256Buffer(readFileSync(path));
}

export function opaqueStorageKey() {
  // Per-snapshot randomness prevents provider-visible correlation of the same logical object.
  return randomUUID().replace(/-/g, '');
}

function storageHeaders(key, extra = {}) {
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

export function validateSupabaseProjectUrl(url, expectedProjectRef, label) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`${label} Storage URL is invalid`); }
  const expected = String(expectedProjectRef || '').trim().toLowerCase();
  if (!expected || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
    || !['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash
    || parsed.hostname.toLowerCase() !== `${expected}.supabase.co`) {
    throw new Error(`${label} Storage URL does not match its configured Supabase project`);
  }
  return `https://${expected}.supabase.co`;
}

async function storageRequest(base, key, path, operation, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    redirect: 'error',
    headers: storageHeaders(key, init.headers || {}),
  });
  if (!response.ok) throw new Error(`Storage ${operation} failed (${response.status})`);
  return response;
}

export function normalizeStorageObjectMetadata(metadata = {}) {
  // Only portability-relevant fields are retained; volatile ETags/timestamps are excluded.
  const source = metadata && typeof metadata === 'object' ? metadata : {};
  return {
    mimetype: typeof source.mimetype === 'string' ? source.mimetype : (typeof source.contentType === 'string' ? source.contentType : null),
    cache_control: typeof source.cacheControl === 'string' ? source.cacheControl : (typeof source.cache_control === 'string' ? source.cache_control : null),
    size: Number.isFinite(Number(source.size)) ? Number(source.size) : null,
  };
}

export function normalizeStorageBucketMetadata(bucket = {}) {
  return {
    id: String(bucket.id || ''),
    name: String(bucket.name || bucket.id || ''),
    public: bucket.public === true,
    file_size_limit: bucket.file_size_limit ?? null,
    allowed_mime_types: Array.isArray(bucket.allowed_mime_types) ? [...bucket.allowed_mime_types].sort() : null,
  };
}

export async function listStorageObjects(base, key, bucket, prefix = '') {
  const results = [];
  let offset = 0;
  for (;;) {
    const response = await storageRequest(base, key, `/storage/v1/object/list/${encodeURIComponent(bucket)}`, 'inventory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }),
    });
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error('Storage list returned a non-array');
    for (const item of page) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.metadata === null) results.push(...await listStorageObjects(base, key, bucket, path));
      else results.push({ bucket, path, metadata: normalizeStorageObjectMetadata(item.metadata) });
    }
    if (page.length < 1000) return results;
    offset += page.length;
  }
}

function modeForObject(object, modePrefixes = {}) {
  const matches = [];
  for (const mode of ['personal', 'business']) {
    const prefix = typeof modePrefixes[mode] === 'string' ? modePrefixes[mode] : '';
    if (prefix && object.path.startsWith(prefix)) matches.push(mode);
  }
  if (matches.length !== 1) return matches.length === 0 ? 'unclassified' : 'ambiguous';
  return matches[0];
}

export function aggregateModes(objects) {
  const groups = {
    personal: { object_count: 0, total_bytes: 0, entries: [] },
    business: { object_count: 0, total_bytes: 0, entries: [] },
    unclassified: { object_count: 0, total_bytes: 0, entries: [] },
    ambiguous: { object_count: 0, total_bytes: 0, entries: [] },
  };
  for (const object of objects) {
    const group = groups[object.mode] || { object_count: 0, total_bytes: 0, entries: [] };
    group.object_count += 1;
    group.total_bytes += object.bytes;
    group.entries.push(`${object.key}\0${object.bytes}\0${object.sha256}`);
    groups[object.mode] = group;
  }
  return Object.fromEntries(Object.entries(groups).map(([mode, group]) => [mode, {
    object_count: group.object_count,
    total_bytes: group.total_bytes,
    digest: sha256Buffer(group.entries.sort().join('\n')),
  }]));
}

export function canonicalArtifactSet(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) throw new Error('custody artifact set is empty');
  const names = new Set();
  const canonical = artifacts.map((artifact) => {
    const kind = String(artifact?.kind || '');
    const name = String(artifact?.name || '');
    const bytes = Number(artifact?.bytes);
    const sha256 = String(artifact?.sha256 || '').toLowerCase();
    if (!kind || !name || name.includes('..') || name.includes('\\') || name.startsWith('/') || names.has(name)
      || !Number.isSafeInteger(bytes) || bytes < 0 || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error('custody artifact set contains an invalid artifact');
    }
    names.add(name);
    return { kind, name, bytes, sha256 };
  });
  return canonical.sort((a, b) => `${a.kind}\0${a.name}`.localeCompare(`${b.kind}\0${b.name}`));
}

export function artifactSetDigest(artifacts) {
  return sha256Buffer(JSON.stringify(canonicalArtifactSet(artifacts)));
}

function encryptBuffer(runTool, agePath, recipient, output, value) {
  const tmp = `${output}.tmp`;
  try {
    mkdirSync(dirname(output), { recursive: true });
    const result = runTool(agePath, ['--encrypt', '--recipient', recipient, '--output', tmp], {
      input: value,
      windowsHide: true,
      encoding: 'utf8',
    });
    if (result.error || result.status !== 0 || !existsSync(tmp) || statSync(tmp).size === 0) {
      throw new Error('age encryption failed');
    }
    writeFileSync(`${tmp}.sha256`, `${sha256File(tmp)}  ${basename(output)}\n`, 'utf8');
    mkdirSync(dirname(output), { recursive: true });
    // rename is performed by the caller so an interrupted write cannot be mistaken for custody material.
    return { tmp, sidecarTmp: `${tmp}.sha256` };
  } catch (error) {
    try { rmSync(tmp, { force: true }); rmSync(`${tmp}.sha256`, { force: true }); } catch { /* encrypted cleanup best effort */ }
    throw error;
  }
}

function finalizeEncrypted(output, encrypted) {
  const sidecar = `${output}.sha256`;
  // Same-directory moves publish a completed ciphertext without exposing plaintext.
  renameSync(encrypted.tmp, output);
  renameSync(encrypted.sidecarTmp, sidecar);
  return { path: output, sidecar, bytes: statSync(output).size, sha256: sha256File(output) };
}

export async function createStorageSnapshot({ storage, target, stamp, outputDir, agePath, recipient, runTool }) {
  if (!storage || typeof storage !== 'object') return null;
  const url = process.env[String(storage.source_url_env || '')];
  const key = process.env[String(storage.source_service_role_env || '')];
  const projectRef = process.env[String(storage.source_project_env || '')];
  if (!url || !key) throw new Error(`Storage source credentials are not set (${!url ? storage.source_url_env : storage.source_service_role_env})`);
  const base = validateSupabaseProjectUrl(url, projectRef, 'source');
  const personalPrefix = String(storage.mode_prefixes?.personal || '');
  const businessPrefix = String(storage.mode_prefixes?.business || '');
  if (storage.required === true && (!personalPrefix || !businessPrefix || personalPrefix.startsWith(businessPrefix) || businessPrefix.startsWith(personalPrefix))) {
    throw new Error('Storage mode prefixes must be non-empty and non-overlapping');
  }
  const backupSet = randomUUID().replace(/-/g, '');
  const storageDir = join(outputDir, 'storage', backupSet);
  try {
  const bucketResponse = await storageRequest(base, key, '/storage/v1/bucket', 'bucket inventory');
  const buckets = await bucketResponse.json();
  if (!Array.isArray(buckets)) throw new Error('Storage bucket inventory returned a non-array');

  const objects = [];
  for (const bucket of buckets) {
    if (!bucket?.id) throw new Error('Storage bucket inventory contains an invalid bucket');
    objects.push(...await listStorageObjects(base, key, bucket.id));
  }

  const stored = [];
  for (const object of objects) {
    const encodedPath = object.path.split('/').map(encodeURIComponent).join('/');
    const response = await storageRequest(base, key, `/storage/v1/object/authenticated/${encodeURIComponent(object.bucket)}/${encodedPath}`, 'object download');
    const bytes = Buffer.from(await response.arrayBuffer());
    const keyId = opaqueStorageKey();
    const encryptedName = `${backupSet}-${keyId}.age`;
    const encryptedPath = join(storageDir, encryptedName);
    const encrypted = encryptBuffer(runTool, agePath, recipient, encryptedPath, bytes);
    const artifact = finalizeEncrypted(encryptedPath, encrypted);
    stored.push({
      key: keyId,
      bucket: object.bucket,
      path: object.path,
      metadata: object.metadata,
      content_type: object.metadata.mimetype,
      cache_control: object.metadata.cache_control,
      mode: modeForObject(object, storage.mode_prefixes),
      bytes: bytes.length,
      sha256: sha256Buffer(bytes),
      artifact: encryptedName,
      artifact_bytes: artifact.bytes,
      artifact_sha256: artifact.sha256,
      artifact_path: artifact.path,
      sidecar_path: artifact.sidecar,
    });
  }

  if (storage.required === true && stored.some((entry) => entry.mode === 'unclassified' || entry.mode === 'ambiguous')) {
    throw new Error('Storage mode isolation is incomplete: every object must map to exactly one configured mode prefix');
  }

  const modeAggregates = aggregateModes(stored);
  const detailedManifest = Buffer.from(JSON.stringify({
    version: 1,
    target,
    backup_set: backupSet,
    format: 'supabase-storage-opaque-age-v1',
    buckets: buckets.map(normalizeStorageBucketMetadata),
    objects: stored.map(({ artifact_path, sidecar_path, ...entry }) => entry),
    mode_aggregates: modeAggregates,
  }), 'utf8');
  const manifestPath = join(storageDir, `${backupSet}-storage-manifest.json.age`);
  const encryptedManifest = encryptBuffer(runTool, agePath, recipient, manifestPath, detailedManifest);
  const manifest = finalizeEncrypted(manifestPath, encryptedManifest);

  return {
    backup_set: backupSet,
    manifest: { name: basename(manifest.path), bytes: manifest.bytes, sha256: manifest.sha256, path: manifest.path, sidecar_path: manifest.sidecar },
    objects: stored,
    object_count: stored.length,
    mode_aggregates: modeAggregates,
  };
  } catch (error) {
    try { rmSync(storageDir, { recursive: true, force: true }); } catch { /* encrypted cleanup best effort */ }
    throw error;
  }
}

export function custodyArtifacts(database, snapshot) {
  const artifacts = [{ kind: 'database', name: basename(database.path), bytes: database.bytes, sha256: database.sha256, path: database.path, sidecar_path: database.sidecar_path || database.sidecar }];
  if (!snapshot) return artifacts;
  artifacts.push({ kind: 'storage-manifest', name: snapshot.manifest.name, bytes: snapshot.manifest.bytes, sha256: snapshot.manifest.sha256, path: snapshot.manifest.path, sidecar_path: snapshot.manifest.sidecar });
  for (const object of snapshot.objects) {
    artifacts.push({ kind: 'storage-object', name: object.artifact, bytes: object.artifact_bytes, sha256: object.artifact_sha256, path: object.artifact_path, sidecar_path: object.sidecar_path });
  }
  return artifacts;
}

export function cleanStorageSnapshot(snapshot) {
  if (!snapshot) return;
  for (const artifact of custodyArtifacts({ path: '', bytes: 0, sha256: '', sidecar: '' }, snapshot).slice(1)) {
    try { rmSync(artifact.path, { force: true }); rmSync(artifact.sidecar_path, { force: true }); } catch { /* encrypted cleanup best effort */ }
  }
}

export function parseAndVerifyStorageManifest(manifestBytes, storageArtifacts) {
  let manifest;
  try { manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8')); }
  catch { throw new Error('decrypted Storage manifest is invalid JSON'); }
  if (manifest?.format !== 'supabase-storage-opaque-age-v1' || !Array.isArray(manifest.objects)) {
    throw new Error('decrypted Storage manifest has an unsupported shape');
  }
  const byName = new Map(storageArtifacts.map((artifact) => [artifact.name, artifact]));
  if (byName.size !== storageArtifacts.length || manifest.objects.length !== storageArtifacts.length) {
    throw new Error('Storage manifest and receipt-bound artifact set have different cardinality');
  }
  const manifestNames = new Set();
  const checked = [];
  for (const entry of manifest.objects) {
    if (!entry || !/^[a-f0-9]{32}$/.test(String(entry.key || '')) || !/^[a-f0-9]{32}-[a-f0-9]{32}\.age$/.test(String(entry.artifact || ''))
      || !entry.metadata || typeof entry.metadata !== 'object') {
      throw new Error('Storage manifest contains a non-opaque artifact key');
    }
    if (manifestNames.has(entry.artifact)) {
      throw new Error('Storage manifest contains an ambiguous or mismatched opaque object key');
    }
    manifestNames.add(entry.artifact);
    const artifact = byName.get(entry.artifact);
    if (!artifact) throw new Error('Storage manifest references a missing ciphertext object');
    checked.push({ entry, artifact });
  }
  if (manifestNames.size !== byName.size || [...byName.keys()].some((name) => !manifestNames.has(name))) {
    throw new Error('Storage receipt contains an artifact omitted from the encrypted manifest');
  }
  const expected = aggregateModes(manifest.objects.map((entry) => ({ key: entry.key, bytes: entry.bytes, sha256: entry.sha256, mode: entry.mode })));
  if (JSON.stringify(expected) !== JSON.stringify(manifest.mode_aggregates || {})) {
    throw new Error('Storage manifest mode aggregates do not match its encrypted object records');
  }
  return { manifest, checked, modeAggregates: expected };
}
