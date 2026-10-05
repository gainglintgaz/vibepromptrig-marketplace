#!/usr/bin/env node
// restore-drill.mjs
//
// VibePromptRig quarterly MANUAL restore drill -- proves backups are usable.
// Node twin of restore-drill.ps1 (cross-platform port P2, T3 -- the UNIFORM
// OS-NATIVE scheduler tranche, approved 2026-06-14).
//
// Pulls a recent off-platform pg_dump from the rclone remote, restores it to a
// local Postgres staging database, runs integrity checks (table count / approx
// row counts), reports time-to-restore, and writes a drill report to
// docs/restore-drills/<target>-<date>.md.
//
// LOCAL job, run MANUALLY (quarterly) by the operator's OS -- NOT in CI, NOT
// GitHub Actions. Dependency-free (Node stdlib only), node:path throughout,
// Node >= 18, ESM. Shells out to rclone + psql via spawnSync. Secrets (staging
// URI) come from env only and reach psql through its environment -- never a
// CLI argument, never printed, and never written to a file or log.
//
// Usage:
//   node restore-drill.mjs --target example-finance-app-prod --dry-run
//   node restore-drill.mjs --target example-finance-app-prod --confirm-target example-finance-app-prod
//   node restore-drill.mjs --target example-finance-app-prod --dry-run --max-age-days 2
//
// Exit codes: 0 = drill passed (or dry-run / nothing-to-do), non-zero = failure.

import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import process from 'node:process';

import { appendJsonl, utcStamp } from './hooks/hook-lib.mjs';
import { artifactSetDigest, canonicalArtifactSet, parseAndVerifyStorageManifest, sha256Buffer } from './custody-storage.mjs';

const JOB = 'restore-drill';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// ---- Resolve the operator factory root (VIBE_ROOT or one level above scripts/). ----
// restore-drill.mjs lives in scripts/, so the factory root is dirname(SCRIPT_DIR).
// resolveFactoryRoot() expects the dir of the importing module and walks two parents
// (it is tuned for scripts/hooks/*), so we resolve directly here for a scripts/ script
// and keep VIBE_ROOT as the override, matching the .ps1.
const FactoryRoot = process.env.VIBE_ROOT || dirname(SCRIPT_DIR);
const REQUIRED_RESTORE_SURFACES = new Set([
  'auth', 'storage_metadata', 'storage_byte_manifest', 'schema', 'data', 'roles',
  'configuration_inventory', 'deployed_function_parity',
]);

function loadRestoreContract(registryRoot, targetConfig) {
  const ref = String(targetConfig.restore_manifest || '');
  if (!ref || ref.includes('..') || !ref.endsWith('.json')) fail('target has no valid restore_manifest');
  const path = join(registryRoot, ref);
  let manifest;
  try { manifest = JSON.parse(readFileSync(path, 'utf8')); }
  catch { fail(`cannot read restore manifest ${ref}`); }
  const inspections = Array.isArray(manifest.required_inspections) ? manifest.required_inspections : [];
  const surfaces = new Set(inspections.map((x) => x && x.surface));
  for (const surface of REQUIRED_RESTORE_SURFACES) {
    if (!surfaces.has(surface)) fail(`restore manifest lacks required '${surface}' inspection`);
  }
  if (!Array.isArray(manifest.verification_queries) || manifest.verification_queries.length === 0) {
    fail('restore manifest lacks verification_queries');
  }
  return {
    path: ref,
    status: String(manifest.status || 'unknown'),
    fullContinuityInspected: inspections.every((x) => x && x.status === 'inspected'),
    verificationQueries: manifest.verification_queries.map((x) => ({ name: String(x.name || 'unnamed'), sql: String(x.sql || '') })),
  };
}

function sha256(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }

function parsePostgresEndpoint(value, label) {
  let parsed;
  try { parsed = new URL(value); }
  catch { fail(`${label} env is not a valid PostgreSQL URL`); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname) {
    fail(`${label} env is not a valid PostgreSQL URL`);
  }
  const host = parsed.hostname.toLowerCase();
  const username = decodeURIComponent(parsed.username || '');
  const directProject = /^db\.([a-z0-9-]+)\.supabase\.co$/i.exec(host)?.[1] || '';
  const pooledProject = /(?:^|\.)([a-z0-9-]+)$/i.exec(username)?.[1] || '';
  return {
    host,
    username,
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    project: directProject || (host.endsWith('.pooler.supabase.com') ? pooledProject : ''),
  };
}

function receiptNameForArtifact(artifactName) {
  const suffix = '.sql.gz.age';
  if (!artifactName.endsWith(suffix)) return '';
  return `${artifactName.slice(0, -suffix.length)}-r2.custody-receipt.json`;
}

function parseSidecar(text, artifactName) {
  const match = /^([a-f0-9]{64})\s+\*?([^\r\n]+)\s*$/i.exec(String(text || '').trim());
  if (!match || match[2].trim() !== artifactName) return null;
  return match[1].toLowerCase();
}

// ---- Single RUN-SUMMARY emitter: exactly one row per run (success OR handled failure). ----
let summaryWritten = false;
function writeRunSummary(status, detail) {
  if (summaryWritten) return;
  summaryWritten = true;
  try {
    appendJsonl(join(FactoryRoot, 'factory_metrics.jsonl'), {
      ts: utcStamp(),
      event: 'scheduled_run',
      job: JOB,
      status,           // 'ok' | 'fail' | 'skipped'
      detail: String(detail || '').slice(0, 200),
    });
  } catch { /* never let logging crash the host */ }
}

// Fail-loud: print to stderr, write a fail run-summary row, exit non-zero.
function fail(detail, code = 1) {
  process.stderr.write(`[FAIL] ${detail}\n`);
  writeRunSummary('fail', detail);
  process.exit(code);
}

// ---- Arg parsing (matches sibling .mjs convention: argVal + includes). ----
function argVal(flag) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; }
function hasFlag(flag) { return process.argv.includes(flag); }

const target = argVal('--target');
const dryRun = hasFlag('--dry-run');
let configPath = argVal('--config-path');
const confirmTarget = argVal('--confirm-target');
const rclonePath = argVal('--rclone-path') || 'rclone';
const agePath = argVal('--age-path') || 'age';
const psqlPath = argVal('--psql-path') || 'psql';
const maxAgeDaysArg = argVal('--max-age-days');
const maxAgeDays = maxAgeDaysArg != null ? Number(maxAgeDaysArg) : 2;

if (!target) {
  fail('--target is required (must match an entry in backup-targets.json). ' +
       'Usage: node restore-drill.mjs --target <name> [--dry-run]');
}
if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
  fail(`--max-age-days must be a positive number (got: ${maxAgeDaysArg})`);
}

// ---- Resolve paths (mirror the .ps1). ----
if (!configPath) configPath = join(FactoryRoot, 'scripts', 'backup-targets.json');
const registryRoot = dirname(dirname(configPath));
const drillDir = join(FactoryRoot, 'docs', 'restore-drills');
const workDir = join(FactoryRoot, 'backups', 'restore-work');

if (!existsSync(configPath)) {
  fail(`Config not found: ${configPath}. Run pg-dump-offsite -Init first.`);
}

// ---- Load + parse config. ----
let cfg;
try {
  cfg = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (e) {
  fail(`Invalid JSON in ${configPath}: ${e.message}`);
}

const targetsArr = Array.isArray(cfg?.targets) ? cfg.targets : [];
const t = targetsArr.find((x) => x && x.name === target);
if (!t) {
  fail(`Target '${target}' not found in ${configPath}`);
}
const restoreContract = loadRestoreContract(registryRoot, t);

// ---- Resolve and validate the destructive-restore destination. ----
// Database URLs are accepted from named environment variables only. They never enter this
// process's CLI, a child argv, a report, or a log. The guard requires all three independent
// controls: exact configured staging host, source/destination inequality, and an explicit target
// confirmation. This avoids unsafe substring guesses such as "URI contains prod".
const restoreGuard = t.restore_guard && typeof t.restore_guard === 'object' ? t.restore_guard : {};
const stagingUriEnv = String(restoreGuard.staging_uri_env || '');
const stagingHostEnv = String(restoreGuard.staging_host_env || '');
const stagingProjectEnv = String(restoreGuard.staging_project_env || '');
const expectedConfirmation = String(restoreGuard.confirmation || '');
const sourceUriEnv = String(t.pg_uri_env || '');
const stagingUri = stagingUriEnv ? process.env[stagingUriEnv] : '';
const expectedStagingHost = stagingHostEnv ? process.env[stagingHostEnv] : '';
const expectedStagingProject = stagingProjectEnv ? process.env[stagingProjectEnv] : '';
const sourceUri = sourceUriEnv ? process.env[sourceUriEnv] : '';

if (!stagingUriEnv || !stagingUri) fail(`staging database env ${stagingUriEnv || '<missing>'} is not set`);
if (!stagingHostEnv || !expectedStagingHost) fail(`staging host env ${stagingHostEnv || '<missing>'} is not set`);
if (!stagingProjectEnv || !expectedStagingProject) fail(`staging project env ${stagingProjectEnv || '<missing>'} is not set`);
if (!sourceUriEnv || !sourceUri) fail(`source database env ${sourceUriEnv || '<missing>'} is not set for restore safety comparison`);

const stagingEndpoint = parsePostgresEndpoint(stagingUri, 'staging database');
const sourceEndpoint = parsePostgresEndpoint(sourceUri, 'source database');
if (stagingEndpoint.host !== expectedStagingHost.trim().toLowerCase()) {
  fail('staging database host does not match the configured restore allowlist');
}
if (!stagingEndpoint.project || stagingEndpoint.project !== expectedStagingProject.trim().toLowerCase()) {
  fail('staging database project does not match the configured restore allowlist');
}
const sameSourceDestination = stagingEndpoint.project && sourceEndpoint.project
  ? stagingEndpoint.project === sourceEndpoint.project
  : stagingEndpoint.host === sourceEndpoint.host && stagingEndpoint.database === sourceEndpoint.database;
if (sameSourceDestination) {
  fail('staging database resolves to the configured source database; refusing destructive restore');
}
if (!dryRun && (!expectedConfirmation || confirmTarget !== expectedConfirmation)) {
  fail(`destructive restore requires --confirm-target ${expectedConfirmation || '<configured-target>'}`);
}

const r2 = Array.isArray(t.providers) ? t.providers.find((x) => x && x.name === 'r2' && x.kind === 'rclone') : null;
const remote = r2 ? (r2.rclone_remote ? String(r2.rclone_remote) : process.env[String(r2.rclone_remote_env || '')])
  : (t.rclone_remote ? String(t.rclone_remote) : String(cfg?.defaults?.rclone_remote || ''));
const remotePath = r2 ? String(r2.rclone_path || '') : (t.rclone_path ? String(t.rclone_path) : '');

if (!remote || !remotePath) {
  fail(`No remote/path configured for ${target}`);
}

// ---- Ensure work + drill dirs exist. ----
try {
  mkdirSync(workDir, { recursive: true });
  mkdirSync(drillDir, { recursive: true });
} catch (e) {
  fail(`Could not create work/drill directories: ${e.message}`);
}

console.log(`[DRILL] ${target}`);
console.log(`        remote: ${remote}:${remotePath}`);
console.log('        staging: <redacted; resolved from configured environment variable>');
console.log(`        max age: ${maxAgeDays} days`);
console.log(`        restore contract: ${restoreContract.path} (${restoreContract.status})`);

// ---- Helper: run an external tool, return {ok, code, stdout, stderr}. ----
function run(cmd, args, opts = {}) {
  const isWindowsWrapper = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
  const command = isWindowsWrapper ? process.env.ComSpec || 'cmd.exe' : cmd;
  const commandArgs = isWindowsWrapper ? ['/c', cmd, ...args] : args;
  const r = spawnSync(command, commandArgs, { encoding: 'utf8', windowsHide: true, shell: false, ...opts });
  if (r.error) {
    return { ok: false, code: -1, stdout: '', stderr: String(r.error.message || r.error), spawnError: true };
  }
  return { ok: r.status === 0, code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function runPsql(args) {
  // libpq accepts a connection string via PGDATABASE. Keeping it in the child environment means
  // process listings, test spies, command previews, and failure logs never expose the database URL.
  const childEnv = { ...process.env, PGDATABASE: stagingUri };
  delete childEnv[stagingUriEnv];
  delete childEnv[sourceUriEnv];
  return run(psqlPath, args, { env: childEnv });
}

function configuredProjectRef(value, label) {
  const ref = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9-]{3,63}$/.test(ref)) fail(`${label} Storage project ref is invalid`);
  return ref;
}

// Storage service-role endpoints are deliberately pinned to an expected project ref.  Do not
// accept a convenient URL with a path/query/userinfo: it could turn an otherwise-valid key into
// an SSRF or cross-project request.  `URL.origin` also gives requests one canonical, path-free
// base and fetch is separately told never to follow redirects.
function storageProjectFromUrl(value, expectedProject, label) {
  let parsed;
  try { parsed = new URL(value); } catch { fail(`${label} Storage URL is invalid`); }
  const project = configuredProjectRef(expectedProject, label);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
    || parsed.pathname !== '/' || parsed.search || parsed.hash
    || parsed.hostname.toLowerCase() !== `${project}.supabase.co`) {
    fail(`${label} Storage URL must be the configured direct HTTPS project origin`);
  }
  return { base: parsed.origin, project };
}

function canonicalBucket(bucket) {
  if (!bucket || typeof bucket !== 'object' || typeof bucket.id !== 'string' || !bucket.id
    || typeof bucket.name !== 'string' || !bucket.name
    || typeof bucket.public !== 'boolean'
    || !Object.hasOwn(bucket, 'file_size_limit') || !Object.hasOwn(bucket, 'allowed_mime_types')) {
    throw new Error('Storage manifest bucket metadata is incomplete');
  }
  const limit = bucket.file_size_limit;
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new Error('Storage manifest bucket size limit is invalid');
  }
  const allowlist = bucket.allowed_mime_types;
  if (allowlist !== null && (!Array.isArray(allowlist) || allowlist.some((item) => typeof item !== 'string'))) {
    throw new Error('Storage manifest bucket MIME allowlist is invalid');
  }
  return {
    id: bucket.id,
    name: bucket.name,
    public: bucket.public,
    file_size_limit: limit,
    allowed_mime_types: allowlist === null ? null : [...allowlist].sort(),
  };
}

function canonicalObjectMetadata(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.bucket !== 'string' || !entry.bucket
    || typeof entry.path !== 'string' || !entry.path || typeof entry.content_type !== 'string' || !entry.content_type
    || typeof entry.cache_control !== 'string' || !entry.cache_control) {
    throw new Error('Storage manifest object metadata is incomplete');
  }
  return { content_type: entry.content_type, cache_control: entry.cache_control };
}

function storageModeAggregates(entries) {
  const groups = Object.fromEntries(['personal', 'business', 'unclassified', 'ambiguous'].map((mode) => [mode, {
    object_count: 0, total_bytes: 0, entries: [],
  }]));
  for (const entry of entries) {
    const mode = Object.hasOwn(groups, entry.mode) ? entry.mode : 'unclassified';
    const group = groups[mode];
    group.object_count += 1;
    group.total_bytes += Number(entry.bytes);
    // `key` is an opaque, receipt-bound snapshot identifier. It never reaches a log or provider
    // path here; it only makes the in-memory parity digest bind the exact restored artifact.
    group.entries.push(`${String(entry.key || '')}\0${Number(entry.bytes)}\0${String(entry.sha256 || '')}`);
  }
  return Object.fromEntries(Object.entries(groups).map(([mode, group]) => [mode, {
    object_count: group.object_count,
    total_bytes: group.total_bytes,
    digest: sha256Buffer(group.entries.sort().join('\n')),
  }]));
}

function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function encodeStoragePath(value) { return String(value).split('/').map(encodeURIComponent).join('/'); }

async function storageJson(request, action, path, init = {}) {
  const response = await request(action, path, init);
  let body;
  try { body = await response.json(); }
  catch { throw new Error(`Storage ${action} returned invalid JSON`); }
  return body;
}

async function listStorageObjects(request, bucket, prefix = '') {
  const objects = [];
  let offset = 0;
  for (;;) {
    const page = await storageJson(request, 'inventory', `/storage/v1/object/list/${encodeURIComponent(bucket)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }),
    });
    if (!Array.isArray(page)) throw new Error('Storage inventory returned an invalid object list');
    for (const item of page) {
      if (!item || typeof item.name !== 'string' || !item.name) throw new Error('Storage inventory returned an invalid object');
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.metadata === null) objects.push(...await listStorageObjects(request, bucket, path));
      else objects.push({ bucket, path, metadata: item.metadata || {} });
    }
    if (page.length < 1000) return objects;
    offset += page.length;
  }
}

async function inventoryStorage(request) {
  const buckets = await storageJson(request, 'bucket inventory', '/storage/v1/bucket');
  if (!Array.isArray(buckets)) throw new Error('Storage bucket inventory returned an invalid list');
  const canonicalBuckets = buckets.map(canonicalBucket).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(canonicalBuckets.map((bucket) => bucket.id)).size !== canonicalBuckets.length) {
    throw new Error('Storage bucket inventory contains duplicate bucket identifiers');
  }
  const objects = [];
  for (const bucket of canonicalBuckets) objects.push(...await listStorageObjects(request, bucket.id));
  return { buckets: canonicalBuckets, objects };
}

function createStorageRequest(staging, stagingKey) {
  return async (action, path, init = {}) => {
    let response;
    try {
      response = await fetch(`${staging.base}${path}`, {
        ...init,
        redirect: 'error',
        headers: { apikey: stagingKey, Authorization: `Bearer ${stagingKey}`, ...(init.headers || {}) },
      });
    } catch {
      throw new Error(`Storage ${action} request failed`);
    }
    if (!response.ok) throw new Error(`Storage ${action} returned HTTP ${response.status}`);
    return response;
  };
}

async function preflightStagingStorage(storageVerification) {
  if (!storageVerification) return null;
  const storage = t.storage;
  const sourceUrl = process.env[String(storage?.source_url_env || '')];
  const stagingUrl = process.env[String(storage?.staging_url_env || '')];
  const stagingKey = process.env[String(storage?.staging_service_role_env || '')];
  const sourceProject = process.env[String(storage?.source_project_env || '')];
  const stagingProject = process.env[String(storage?.staging_project_env || '')];
  if (!sourceUrl || !stagingUrl || !stagingKey || !sourceProject || !stagingProject) {
    fail('Storage restore requires configured source/staging project refs, origins, and staging service-role credentials');
  }
  const source = storageProjectFromUrl(sourceUrl, sourceProject, 'source');
  const staging = storageProjectFromUrl(stagingUrl, stagingProject, 'staging');
  if (source.project === staging.project) fail('Storage staging project violates source/destination isolation');

  const expectedBuckets = (storageVerification.manifest.buckets || []).map(canonicalBucket)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(expectedBuckets.map((bucket) => bucket.id)).size !== expectedBuckets.length) {
    throw new Error('Storage manifest contains duplicate bucket identifiers');
  }
  for (const { entry } of storageVerification.checked) canonicalObjectMetadata(entry);

  const request = createStorageRequest(staging, stagingKey);
  const stagingInventory = await inventoryStorage(request);
  // This source slice never clears inventory. Any object (including an object in a bucket not in
  // the backup) is a hard stop before the database schema is touched; clearing requires separate
  // operator authority and cannot be smuggled into a restore drill.
  if (stagingInventory.objects.length !== 0) throw new Error('staging Storage is nonempty; refusing restore before database mutation');
  const expectedById = new Map(expectedBuckets.map((bucket) => [bucket.id, bucket]));
  for (const bucket of stagingInventory.buckets) {
    const expected = expectedById.get(bucket.id);
    if (!expected || !sameJson(bucket, expected)) {
      throw new Error('staging Storage bucket inventory does not match the encrypted manifest');
    }
  }
  return { request, expectedBuckets };
}

async function restoreVerifiedStorage(storageVerification, stagingStorage) {
  if (!storageVerification || !stagingStorage) return null;
  const { request, expectedBuckets } = stagingStorage;
  const existing = await inventoryStorage(request);
  if (existing.objects.length !== 0) throw new Error('staging Storage became nonempty before restore');
  const existingIds = new Set(existing.buckets.map((bucket) => bucket.id));
  for (const bucket of expectedBuckets) {
    if (existingIds.has(bucket.id)) continue;
    const response = await request('bucket creation', '/storage/v1/bucket', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bucket),
    });
    if (!response.ok) throw new Error('Storage bucket creation failed');
  }
  for (const { entry, artifact } of storageVerification.checked) {
    const metadata = canonicalObjectMetadata(entry);
    const decrypted = run(agePath, ['--decrypt', '--identity', ageIdentity, artifact.path], { encoding: 'buffer' });
    if (!decrypted.ok || !Buffer.isBuffer(decrypted.stdout) || decrypted.stdout.length !== Number(entry.bytes)
      || sha256Buffer(decrypted.stdout) !== String(entry.sha256).toLowerCase()) {
      throw new Error('Storage byte checksum changed after preflight');
    }
    const write = await request('object upload', `/storage/v1/object/${encodeURIComponent(entry.bucket)}/${encodeStoragePath(entry.path)}`, {
      method: 'POST',
      headers: { 'Content-Type': metadata.content_type, 'Cache-Control': metadata.cache_control, 'x-upsert': 'false' },
      body: decrypted.stdout,
    });
    if (!write.ok) throw new Error('Storage object upload failed');
  }

  // Re-enumerate staging after all writes, then re-read every byte and header.  The aggregate is
  // built from this fresh inventory and read-back data, never from the source manifest itself.
  const restored = await inventoryStorage(request);
  if (!sameJson(restored.buckets, expectedBuckets)) throw new Error('staging Storage bucket metadata parity mismatch');
  const expectedByLocation = new Map(storageVerification.checked.map(({ entry }) => [`${entry.bucket}\0${entry.path}`, entry]));
  if (restored.objects.length !== expectedByLocation.size) throw new Error('staging Storage object cardinality mismatch');
  const restoredRecords = [];
  for (const object of restored.objects) {
    const expected = expectedByLocation.get(`${object.bucket}\0${object.path}`);
    if (!expected) throw new Error('staging Storage contains an unexpected object');
    const metadata = canonicalObjectMetadata(expected);
    const listedType = String(object.metadata.mimetype || object.metadata.content_type || '');
    const listedCache = String(object.metadata.cacheControl || object.metadata.cache_control || '');
    if (listedType !== metadata.content_type || listedCache !== metadata.cache_control) {
      throw new Error('staging Storage object list metadata parity mismatch');
    }
    const readBack = await request('object read-back', `/storage/v1/object/authenticated/${encodeURIComponent(object.bucket)}/${encodeStoragePath(object.path)}`);
    const bytes = Buffer.from(await readBack.arrayBuffer());
    const responseType = String(readBack.headers.get('content-type') || '').split(';', 1)[0];
    const responseCache = String(readBack.headers.get('cache-control') || '');
    if (bytes.length !== Number(expected.bytes) || sha256Buffer(bytes) !== String(expected.sha256).toLowerCase()
      || responseType !== metadata.content_type || responseCache !== metadata.cache_control) {
      throw new Error('staging Storage byte or response metadata parity mismatch');
    }
    restoredRecords.push(expected);
  }
  const freshAggregates = storageModeAggregates(restoredRecords);
  if (!sameJson(freshAggregates, storageVerification.modeAggregates)) {
    throw new Error('staging Storage mode aggregate parity mismatch');
  }
  return freshAggregates;
}

function readAndValidateRemoteEvidence(artifact) {
  const sidecarName = `${artifact.name}.sha256`;
  const receiptName = receiptNameForArtifact(artifact.name);
  if (!receiptName) fail('selected ciphertext has no deterministic R2 receipt name');

  const receiptRead = run(rclonePath, ['cat', `${remote}:${remotePath}/${receiptName}`]);
  const sidecarRead = run(rclonePath, ['cat', `${remote}:${remotePath}/${sidecarName}`]);
  if (!receiptRead.ok || !sidecarRead.ok) {
    fail('newest ciphertext is orphaned: matching R2 receipt and sidecar read-back are required');
  }

  let receipt;
  try { receipt = JSON.parse(receiptRead.stdout); }
  catch { fail('newest ciphertext has an invalid R2 custody receipt'); }
  const sidecarHash = parseSidecar(sidecarRead.stdout, artifact.name);
  const receiptHash = String(receipt?.artifact?.sha256 || '').toLowerCase();
  const receiptBytes = Number(receipt?.artifact?.bytes);
  const expectedManifest = String(t.restore_manifest || '');
  const baseValid = receipt?.version >= 2 && receipt?.custody_receipt === true
    && receipt?.target === target
    && receipt?.provider === 'r2'
    && receipt?.provider_verification?.status === 'verified'
    && receipt?.artifact?.name === artifact.name
    && receipt?.artifact?.encrypted_with === 'age'
    && Number.isFinite(receiptBytes)
    && receiptBytes === artifact.size
    && /^[a-f0-9]{64}$/.test(receiptHash)
    && sidecarHash === receiptHash
    && receipt?.sidecar === sidecarName
    && receipt?.restore_contract?.path === expectedManifest;
  if (!baseValid) fail('newest ciphertext R2 receipt is not bound to its artifact, sidecar, hash, target, and restore contract');
  const artifacts = Array.isArray(receipt.artifacts) && receipt.artifacts.length > 0 ? receipt.artifacts : [];
  let canonicalArtifacts;
  try { canonicalArtifacts = canonicalArtifactSet(artifacts); }
  catch { fail('custody receipt contains an invalid artifact set'); }
  if (receipt.artifact_set_digest !== artifactSetDigest(canonicalArtifacts) || Number(receipt.artifact_count) !== canonicalArtifacts.length
    || receipt.backup_set !== receipt.storage?.backup_set) {
    fail('custody receipt does not bind one canonical complete artifact set');
  }
  const names = new Set();
  for (const item of artifacts) {
    const itemName = String(item?.name || '');
    const itemHash = String(item?.sha256 || '').toLowerCase();
    if (!itemName || itemName.includes('..') || itemName.includes('\\') || itemName.startsWith('/') || names.has(itemName)
      || !Number.isFinite(Number(item?.bytes)) || !/^[a-f0-9]{64}$/.test(itemHash) || item?.encrypted_with !== 'age') {
      fail('custody receipt contains an invalid artifact set');
    }
    names.add(itemName);
    const remoteSidecar = run(rclonePath, ['cat', `${remote}:${remotePath}/${itemName}.sha256`]);
    if (!remoteSidecar.ok || parseSidecar(remoteSidecar.stdout, itemName) !== itemHash) {
      fail('custody receipt artifact sidecar is missing or mismatched');
    }
  }
  const storageRequired = t.storage?.required === true;
  const storageArtifacts = canonicalArtifacts.filter((item) => item.kind === 'storage-object');
  const storageManifest = canonicalArtifacts.find((item) => item.kind === 'storage-manifest');
  if (storageRequired) {
    const storage = receipt.storage;
    if (storage?.format !== 'supabase-storage-opaque-age-v1' || !storage?.backup_set || !storageManifest
      || storageManifest.name !== storage.encrypted_manifest?.name || storageManifest.sha256 !== storage.encrypted_manifest?.sha256
      || storageArtifacts.length !== Number(storage.object_count) || receipt.backup_set !== storage.backup_set
      || !storage.mode_aggregates?.personal || !storage.mode_aggregates?.business) {
      fail('custody receipt is missing a complete Storage artifact set');
    }
  }
  // R2 is the selected transport, but custody is valid only when every required provider has
  // independently recorded the same immutable whole-artifact-set binding.  We read receipts
  // only: restore never writes, cleans, or otherwise mutates either provider.
  const binding = JSON.stringify({
    backup_set: receipt.backup_set,
    artifact_set_digest: receipt.artifact_set_digest,
    artifact_count: receipt.artifact_count,
    storage: receipt.storage ? {
      backup_set: receipt.storage.backup_set,
      manifest_sha256: receipt.storage.encrypted_manifest?.sha256,
      object_count: receipt.storage.object_count,
    } : null,
  });
  const requiredProviders = Array.isArray(t.providers) ? t.providers.filter((provider) => provider?.required !== false) : [];
  if (storageRequired && (requiredProviders.length < 2 || new Set(requiredProviders.map((provider) => provider.name)).size !== requiredProviders.length)) {
    fail('restore requires two distinct required custody providers');
  }
  for (const provider of storageRequired ? requiredProviders : []) {
    if (provider.name === 'r2') continue;
    const providerRemote = provider.rclone_remote || process.env[String(provider.rclone_remote_env || '')];
    const providerPath = String(provider.rclone_path || '');
    if (!providerRemote || !providerPath || provider.kind !== 'rclone') fail('required custody provider is not configured');
    const peerName = receiptName.replace(/-r2\.custody-receipt\.json$/, `-${provider.name}.custody-receipt.json`);
    if (peerName === receiptName) fail('required custody provider receipt name is invalid');
    const peerRead = run(rclonePath, ['cat', `${providerRemote}:${providerPath}/${peerName}`]);
    let peer;
    try { peer = peerRead.ok ? JSON.parse(peerRead.stdout) : null; } catch { peer = null; }
    const peerBinding = peer ? JSON.stringify({
      backup_set: peer.backup_set,
      artifact_set_digest: peer.artifact_set_digest,
      artifact_count: peer.artifact_count,
      storage: peer.storage ? {
        backup_set: peer.storage.backup_set,
        manifest_sha256: peer.storage.encrypted_manifest?.sha256,
        object_count: peer.storage.object_count,
      } : null,
    }) : '';
    if (peer?.custody_receipt !== true || peer?.target !== target || peer?.provider !== provider.name
      || peer?.provider_verification?.status !== 'verified' || peerBinding !== binding) {
      fail('required provider custody receipts do not agree on the complete artifact set');
    }
  }
  return { sidecarName, receiptName, expectedHash: receiptHash, receipt, artifacts: canonicalArtifacts, storageArtifacts, storageManifest };
}

// ---- STEP 1: list recent backups via rclone. ----
console.log('[STEP 1] Listing recent backups via rclone...');
const ls = run(rclonePath, ['lsl', `${remote}:${remotePath}`]);
if (ls.spawnError) {
  fail('rclone failed to launch while listing custody evidence (external detail redacted)');
}
if (!ls.ok) {
  fail('rclone lsl failed. Check rclone config + remote name.');
}

// rclone lsl format: "<size> <YYYY-MM-DD HH:MM:SS.fffffffff> <name>"
// We split into at most 4 fields like the .ps1: size, date, time(+ms), name.
const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
let newest = null;
for (const rawLine of ls.stdout.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line) continue;
  const parts = line.split(/\s+/);
  if (parts.length < 4) continue;
  const sz = Number(parts[0]);
  const date = parts[1];                 // YYYY-MM-DD
  const time = parts[2];                 // HH:MM:SS(.fffffffff)
  const name = parts.slice(3).join(' '); // remainder is the filename
  if (!Number.isFinite(sz) || !name.endsWith('.sql.gz.age')) continue;
  // Parse "YYYY-MM-DD HH:MM:SS" (first 19 chars of "date time") as LOCAL time, matching the
  // .ps1's DateTime.ParseExact (which used local kind). rclone lsl prints local mod-time.
  const dtStr = `${date} ${time}`.slice(0, 19); // "YYYY-MM-DD HH:MM:SS"
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(dtStr);
  if (!m) continue;
  const ts = new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]),
  );
  const tsMs = ts.getTime();
  if (!Number.isFinite(tsMs) || tsMs < cutoffMs) continue;
  if (!newest || tsMs > newest.tsMs) {
    newest = { tsMs, ts, name, size: sz };
  }
}

if (!newest) {
  fail(`No backups newer than ${maxAgeDays} days at ${remote}:${remotePath}`);
}

// Never fall back from an orphaned newest artifact to an older one. That would hide a broken
// custody cycle. The selected artifact must carry a matching R2 receipt and sidecar that both
// read back successfully before any decryption or staging mutation is possible.
const remoteEvidence = readAndValidateRemoteEvidence(newest);

const sizeKb = Math.round((newest.size / 1024) * 10) / 10;
// Render the selected timestamp the way the .ps1's default DateTime.ToString() did (local).
const newestTsStr = formatLocal(newest.ts);
console.log(`        selected: ${newest.name} (${sizeKb} KB; ${newestTsStr})`);

const databaseArtifact = remoteEvidence.artifacts.find((item) => item.kind === 'database');
if (!databaseArtifact || databaseArtifact.name !== newest.name) fail('custody receipt database artifact does not match selected ciphertext');
const localCiphertext = join(workDir, databaseArtifact.name);
const localDump = localCiphertext.replace(/\.age$/, '');
const sidecarName = remoteEvidence.sidecarName;

// ---- DRY-RUN: validate remote evidence + plan; do not decrypt or mutate staging. ----
if (dryRun) {
  console.log('[DRY-RUN] Verified complete receipt-bound ciphertext artifact set; would copy and hash-verify every database and Storage ciphertext before decrypting or mutating staging');
  console.log(`[DRY-RUN] Plan for target '${target}':`);
  console.log(`  1. rclone copy ${remoteEvidence.artifacts.length} receipt-bound ciphertext artifact(s) to ${workDir}`);
  console.log(`  2. verify every previously read-back sidecar + ciphertext hash (including ${remoteEvidence.storageArtifacts.length} opaque Storage byte artifact(s))`);
  console.log(`  3. age --decrypt --identity <redacted> ${newest.name} -> ${basename(localDump)}`);
  console.log(`  4. gunzip ${basename(localDump)} -> ${basename(localDump).replace(/\.gz$/, '')}`);
  console.log('  5. psql (connection via child environment) -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; ..."');
  console.log('  6. psql (connection via child environment) -v ON_ERROR_STOP=1 -f <decompressed.sql>');
  console.log(`  7. Run ${restoreContract.verificationQueries.length} restore-manifest verification query/queries without logging query output`);
  console.log('  (dry-run; not executing rclone, gunzip, or psql; staging DB untouched)');
  writeRunSummary('skipped', `dry-run for ${target}; selected ${newest.name}`);
  process.exit(0);
}

const startMs = Date.now();

// ---- STEP 2: pull the complete receipt-bound ciphertext set before any decryption or staging mutation. ----
console.log('[STEP 2] Pulling complete encrypted artifact set + validating every SHA-256 sidecar...');
const localArtifacts = [];
for (const artifact of remoteEvidence.artifacts) {
  const localPath = join(workDir, artifact.name);
  const cp = run(rclonePath, ['copy', `${remote}:${remotePath}/${artifact.name}`, workDir]);
  if (cp.spawnError || !cp.ok || !existsSync(localPath)) {
    cleanup(...localArtifacts.map((item) => item.path));
    fail('rclone failed to copy a receipt-bound ciphertext artifact');
  }
  if (sha256(localPath) !== String(artifact.sha256).toLowerCase()) {
    cleanup(localPath, ...localArtifacts.map((item) => item.path));
    fail('downloaded ciphertext does not match the verified R2 receipt-bound sidecar');
  }
  localArtifacts.push({ ...artifact, path: localPath });
}

// ---- STEP 3: decrypt age ciphertext locally, then decompress (.gz -> .sql). ----
console.log('[STEP 3] Decrypting local age ciphertext + decompressing...');
const sqlFile = localDump.replace(/\.gz$/, '');
const ageIdentityEnv = String(t.age_identity_env || '');
const ageIdentity = ageIdentityEnv ? process.env[ageIdentityEnv] : '';
if (!ageIdentity) {
  cleanup(localCiphertext);
  fail(`age identity env ${ageIdentityEnv || '<missing>'} is not set`);
}
let storageVerification = null;
let stagingStorage = null;
if (remoteEvidence.storageManifest) {
  // Every encrypted Storage byte was fetched and hash-checked before this first decryption. The
  // detailed object names now exist only in an in-memory decrypted manifest; no path or object
  // identifier is written to reports, metrics, or provider-visible filenames.
  const manifestLocal = localArtifacts.find((item) => item.name === remoteEvidence.storageManifest.name);
  if (!manifestLocal) fail('Storage manifest ciphertext is missing after preflight');
  const manifestDecrypt = run(agePath, ['--decrypt', '--identity', ageIdentity, manifestLocal.path], { encoding: 'buffer' });
  if (!manifestDecrypt.ok || !Buffer.isBuffer(manifestDecrypt.stdout)) {
    cleanup(...localArtifacts.map((item) => item.path));
    fail('Storage manifest decrypt failed');
  }
  try {
    storageVerification = parseAndVerifyStorageManifest(manifestDecrypt.stdout, localArtifacts.filter((item) => item.kind === 'storage-object'));
    for (const { entry, artifact } of storageVerification.checked) {
      const decrypted = run(agePath, ['--decrypt', '--identity', ageIdentity, artifact.path], { encoding: 'buffer' });
      if (!decrypted.ok || !Buffer.isBuffer(decrypted.stdout) || decrypted.stdout.length !== Number(entry.bytes)
        || sha256Buffer(decrypted.stdout) !== String(entry.sha256).toLowerCase()) {
        throw new Error('Storage byte checksum mismatch');
      }
    }
    if (JSON.stringify(storageVerification.modeAggregates) !== JSON.stringify(remoteEvidence.receipt.storage.mode_aggregates)) {
      throw new Error('Storage mode aggregate parity mismatch');
    }
    // This read-only inventory check happens before the database wipe. A populated or
    // metadata-mismatched staging Storage target is never cleared by this command.
    stagingStorage = await preflightStagingStorage(storageVerification);
  } catch (error) {
    cleanup(...localArtifacts.map((item) => item.path));
    fail(`Storage restore preflight refused: ${error.message}`);
  }
  console.log(`        Storage preflight verified ${remoteEvidence.storageArtifacts.length} opaque ciphertext object(s); mode aggregates remain redacted`);
}
const decrypt = run(agePath, ['--decrypt', '--identity', ageIdentity, '--output', localDump, localCiphertext]);
if (!decrypt.ok || !existsSync(localDump)) {
  cleanup(localCiphertext, localDump);
  fail('age decrypt failed');
}
try {
  const gz = readFileSync(localDump);
  const sql = gunzipSync(gz);
  writeFileSync(sqlFile, sql);
} catch (e) {
  cleanup(localCiphertext, localDump, sqlFile);
  fail(`gunzip failed: ${e.message}`);
}
let sqlSizeKb = 0;
try { sqlSizeKb = Math.round((statSync(sqlFile).size / 1024) * 10) / 10; } catch { /* report 0 */ }
console.log(`        decompressed: ${sqlSizeKb} KB`);

// ---- STEP 4: wipe staging schema + restore via psql (matches .ps1 exactly). ----
console.log('[STEP 4] Wiping staging schema + restoring...');
const wipeSql = 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO PUBLIC;';
const wipe = runPsql(['-c', wipeSql]);
if (wipe.spawnError) {
  cleanup(localCiphertext, localDump, sqlFile);
  fail('psql failed to launch (external detail redacted)');
}
if (!wipe.ok) {
  cleanup(localCiphertext, localDump, sqlFile);
  fail('could not wipe staging schema');
}

const restore = runPsql(['-v', 'ON_ERROR_STOP=1', '-f', sqlFile]);
// restore.ok mirrors $restoreOk = ($LASTEXITCODE -eq 0). A psql spawn failure here is also "not ok".
const restoreOk = restore.ok === true;

// ---- STEP 5: integrity checks + restore-manifest verification-query contract. ----
console.log('[STEP 5] Running integrity checks + restore contract queries...');
const tableQuery = "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname='public';";
const tableRes = runPsql(['-v', 'ON_ERROR_STOP=1', '-A', '-t', '-c', tableQuery]);
const tableCountText = String(tableRes.stdout || '').trim();
const tableCount = tableRes.ok && /^\d+$/.test(tableCountText) ? Number(tableCountText) : 0;
const contractResults = restoreContract.verificationQueries.map((query) => {
  const res = runPsql(['-v', 'ON_ERROR_STOP=1', '-A', '-t', '-c', query.sql]);
  return { name: query.name, ok: res.ok };
});
const contractQueriesPassed = contractResults.every((x) => x.ok);

// Storage byte ciphertext and detailed manifest were fully verified before database mutation. Only
// after the database restore and its contract checks succeed do we write/read-back staging Storage.
if (storageVerification && restoreOk && tableCount > 0 && contractQueriesPassed) {
  try {
    const restoredAggregates = await restoreVerifiedStorage(storageVerification, stagingStorage);
    if (JSON.stringify(restoredAggregates) !== JSON.stringify(remoteEvidence.receipt.storage.mode_aggregates)) {
      throw new Error('staging Storage mode aggregate parity mismatch');
    }
    console.log('        Storage staging read-back verified; Personal/Business aggregate parity remains redacted');
  } catch (error) {
    cleanup(...localArtifacts.map((item) => item.path), localDump, sqlFile);
    fail(`Storage staging restore refused: ${error.message}`);
  }
}

const elapsedSec = Math.round((Date.now() - startMs) / 100) / 10; // time-to-restore, 0.1s precision

// ---- Write the drill report. ----
const stamp = formatDate(new Date());                 // yyyy-MM-dd
const reportPath = join(drillDir, `${target}-${stamp}.md`);
const databaseRestorable = restoreOk && tableCount > 0 && contractQueriesPassed;
const verdict = databaseRestorable && restoreContract.fullContinuityInspected
  ? `OK -- Full continuity contract inspected and database restore verification passed.\n\nTime-to-restore: ${elapsedSec}s.\n\nNext drill: ${formatDate(new Date(Date.now() + 90 * 24 * 60 * 60 * 1000))} (quarterly).`
  : databaseRestorable
    ? `PARTIAL -- Database restore verification passed, but the full continuity contract remains '${restoreContract.status}'. Auth, Storage bytes, roles, configuration, and deployed-function parity are not asserted by this drill.`
    : 'FAIL -- Backup did not produce a usable database or a required verification query failed. Investigate before next backup cycle.';

const report = [
  `# Restore drill report -- ${target} (${stamp})`,
  '',
  '| Item | Value |',
  '|---|---|',
  `| Backup file | ${newest.name} |`,
  `| Backup timestamp | ${newestTsStr} |`,
  `| Compressed size | ${sizeKb} KB |`,
  `| Uncompressed SQL | ${sqlSizeKb} KB |`,
  `| Restore exit | ${restoreOk ? 'OK' : 'FAIL'} |`,
  `| Table count (post-restore) | ${tableCount} |`,
  `| Restore manifest | ${restoreContract.path} (${restoreContract.status}) |`,
  `| Full continuity inspections | ${restoreContract.fullContinuityInspected ? 'complete' : 'pending' } |`,
  `| Verification queries | ${contractQueriesPassed ? 'PASS' : 'FAIL'} |`,
  `| Time-to-restore | ${elapsedSec}s |`,
  '',
  '## Restore-manifest verification queries',
  '',
  ...contractResults.map((result) => `- ${result.ok ? '[PASS]' : '[FAIL]'} ${result.name}`),
  '',
  '## Verdict',
  '',
  verdict,
  '',
  `_Generated by scripts/restore-drill.mjs on ${formatLocal(new Date()).slice(0, 16)}._`,
  '',
].join('\n');

try {
  writeFileSync(reportPath, report);
  console.log(`[OK] Report: ${reportPath}`);
} catch (e) {
  cleanup(localCiphertext, localDump, sqlFile);
  fail(`could not write report ${reportPath}: ${e.message}`);
}

// ---- Cleanup local work files (best-effort, matches .ps1 SilentlyContinue). ----
cleanup(...localArtifacts.map((item) => item.path), localDump, sqlFile);

// ---- Final verdict -> run-summary + exit code. ----
if (!databaseRestorable || !restoreContract.fullContinuityInspected) {
  // Report was still written; surface the path so the operator can investigate.
  fail(`Drill failed -- see ${reportPath}`);
}

console.log(`[DONE] Drill passed for ${target}.`);
writeRunSummary('ok', `${target}: ${tableCount} tables restored in ${elapsedSec}s from ${newest.name}`);
process.exit(0);

// ============================ helpers ============================

function cleanup(...paths) {
  for (const p of paths) {
    if (!p) continue;
    try { rmSync(p, { force: true }); } catch { /* best-effort */ }
  }
}

// "yyyy-MM-dd" in local time (matches .ps1 (Get-Date).ToString("yyyy-MM-dd")).
function formatDate(d) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

// "yyyy-MM-dd HH:mm:ss" in local time -- mirrors .ps1's default DateTime rendering /
// (Get-Date -Format 'yyyy-MM-dd HH:mm') for the report footer + selected-backup line.
function formatLocal(d) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${y}-${mo}-${da} ${h}:${mi}:${s}`;
}
