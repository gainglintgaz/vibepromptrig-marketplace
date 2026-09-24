#!/usr/bin/env node
// pg-dump-offsite.mjs -- cross-platform port P2, T3 (UNIFORM OS-NATIVE scheduler tranche) of
// scripts/pg-dump-offsite.ps1. Dependency-free (Node stdlib only), ESM, Node >= 18.
//
// VibePromptRig daily off-platform Postgres backup -- per data-protection.md SS2.2.
// Reads backup-targets.json + per-target env vars for DB connection strings.
// pg_dump -> gzip -> `rclone copy` to a remote (default: Backblaze B2 via the user's rclone config).
// Logs results to factory_metrics.jsonl. Exits non-zero on any target failure.
//
// This is a LOCAL job run by the OS scheduler on the OPERATOR'S machine -- NOT in CI / GitHub Actions.
// The dump holds end-user PII and must never transit a third party; it stays local + goes only to the
// operator's own off-platform remote.
//
// SECRETS (secrets-handling.md): the per-target Postgres connection string is read from env ONLY
// (process.env[<pg_uri_env>]); it is NEVER hardcoded, NEVER printed, NEVER written to any file/log.
// rclone auth lives in the user's rclone config (set up once via `rclone config`) and is never touched
// by this script. --dry-run redacts the credential value in the planned-command preview.
//
// Usage:
//   node pg-dump-offsite.mjs --init                       # scaffold a sample backup-targets.json
//   node pg-dump-offsite.mjs                              # full run (every enabled target)
//   node pg-dump-offsite.mjs --target example-finance-app-prod        # one target only
//   node pg-dump-offsite.mjs --target example-finance-app-prod --dry-run  # validate + print planned cmds, no exec
//   node pg-dump-offsite.mjs --config <path> --local-dump-dir <dir> --retain-local-days 3
//
// Port notes vs the .ps1:
//   - The .ps1 gzip'd via .NET GZipStream; here we capture pg_dump stdout (a Buffer) and zlib.gzipSync
//     it -- same .sql.gz artifact, no `gzip` binary dependency.
//   - utcStamp() is genuine UTC (the .ps1 wrote a literal 'Z' on LOCAL time -- a deliberate correctness
//     tightening, same as hook-lib's note). The dump-file STAMP keeps the .ps1's local-time shape so
//     filenames sort the way the operator already expects.
//   - The per-target ledger row (event=pg_dump_offsite) is preserved verbatim; the single
//     event=scheduled_run row is the NEW T3 run-summary contract layered on top.

import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, writeFileSync, readFileSync, statSync,
  renameSync, rmSync, readdirSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { appendJsonl, utcStamp } from './hooks/hook-lib.mjs';
import { artifactSetDigest, canonicalArtifactSet, cleanStorageSnapshot, createStorageSnapshot, custodyArtifacts } from './custody-storage.mjs';

const JOB = 'pg-dump-offsite';
const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- Resolve the operator factory root (VIBE_ROOT or one level above scripts/). ----
// hook-lib's resolver is intentionally two levels up for scripts/hooks/*; using it from scripts/*
// selected the parent worktrees directory and made the scheduled generic job miss its registry.
const FACTORY_ROOT = process.env.VIBE_ROOT || dirname(__dirname);
const METRICS_PATH = join(FACTORY_ROOT, 'factory_metrics.jsonl');

// ---- The single T3 run-summary row (exactly one per run, success OR handled failure) ----
let summaryWritten = false;
function writeRunSummary(status, detail) {
  if (summaryWritten) return; // exactly one
  summaryWritten = true;
  appendJsonl(METRICS_PATH, { ts: utcStamp(), event: 'scheduled_run', job: JOB, status, detail });
}

// ---- Fail-loud helpers: clear stderr + run-summary fail row + non-zero exit, never crash the host ----
function failLoud(detail) {
  process.stderr.write(`[FAIL] ${JOB}: ${detail}\n`);
  writeRunSummary('fail', detail);
  process.exit(1);
}

// ---- Minimal arg parser (Node stdlib only) ----
function parseArgs(argv) {
  const a = {
    config: null, target: null, dryRun: false, init: false,
    pgDumpPath: 'pg_dump', rcloneRemote: null, retainLocalDays: 3,
    localDumpDir: null, rclonePath: 'rclone', agePath: 'age', startupCatchup: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    switch (k) {
      case '--config': a.config = next(); break;
      case '--target': a.target = next(); break;
      case '--dry-run': a.dryRun = true; break;
      case '--init': a.init = true; break;
      case '--pg-dump-path': a.pgDumpPath = next(); break;
      case '--rclone-remote': a.rcloneRemote = next(); break;
      case '--rclone-path': a.rclonePath = next(); break;
      case '--age-path': a.agePath = next(); break;
      case '--startup-catchup': a.startupCatchup = true; break;
      case '--retain-local-days': a.retainLocalDays = parseInt(next(), 10); break;
      case '--local-dump-dir': a.localDumpDir = next(); break;
      case '-h': case '--help': a.help = true; break;
      default:
        process.stderr.write(`[WARN] ${JOB}: unknown arg '${k}' ignored\n`);
    }
  }
  if (!Number.isFinite(a.retainLocalDays) || a.retainLocalDays < 0) a.retainLocalDays = 3;
  return a;
}

function printHelp() {
  process.stdout.write(
    `${JOB} -- off-platform pg_dump -> rclone backup (LOCAL scheduled job)\n\n` +
    `  --init                   scaffold a sample backup-targets.json and exit\n` +
    `  --config <path>          path to backup-targets.json\n` +
    `  --target <name>          run only the named target\n` +
    `  --dry-run                validate inputs + print planned commands (creds redacted), no exec\n` +
    `  --pg-dump-path <path>    pg_dump binary (default: pg_dump in PATH)\n` +
    `  --rclone-remote <r>      override the default rclone remote (e.g. b2:vibepromptrig-backups)\n` +
    `  --rclone-path <path>     rclone binary (default: rclone in PATH)\n` +
    `  --age-path <path>        age binary (default: age in PATH)\n` +
    `  --startup-catchup        run only when the newest custody receipt is stale\n` +
    `  --retain-local-days <n>  days to keep local dumps (default: 3)\n` +
    `  --local-dump-dir <dir>   local dump directory\n`,
  );
}

const REQUIRED_RESTORE_SURFACES = new Set([
  'auth', 'storage_metadata', 'storage_byte_manifest', 'schema', 'data', 'roles',
  'configuration_inventory', 'deployed_function_parity',
]);

function safeTargetName(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/i.test(value);
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function removeLocalFiles(...files) {
  const failed = [];
  for (const file of files) {
    if (!file) continue;
    try { rmSync(file, { force: true }); } catch { failed.push(file); }
    if (existsSync(file)) failed.push(file);
  }
  return failed;
}

function writeCiphertextSidecar(ciphertextFile, hash) {
  const sidecar = `${ciphertextFile}.sha256`;
  writeFileSync(sidecar, `${hash}  ${basename(ciphertextFile)}\n`, 'utf8');
  return sidecar;
}

function receiptFileName(target, stamp, providerName) {
  return `${target}-${stamp}-${providerName}.custody-receipt.json`;
}

function readRestoreManifest(factoryRoot, target) {
  const manifestRef = String(target.restore_manifest || '');
  if (!manifestRef || manifestRef.includes('..') || !manifestRef.endsWith('.json')) {
    throw new Error('missing valid restore_manifest');
  }
  const path = join(factoryRoot, manifestRef);
  if (!existsSync(path)) throw new Error(`restore manifest not found: ${manifestRef}`);
  let manifest;
  try { manifest = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`restore manifest is invalid JSON: ${manifestRef}`); }
  const inspections = Array.isArray(manifest.required_inspections) ? manifest.required_inspections : [];
  const surfaces = new Set(inspections.map((x) => x && x.surface));
  for (const surface of REQUIRED_RESTORE_SURFACES) {
    if (!surfaces.has(surface)) throw new Error(`restore manifest lacks required '${surface}' inspection`);
  }
  if (!Array.isArray(manifest.verification_queries) || manifest.verification_queries.length === 0) {
    throw new Error('restore manifest lacks verification_queries');
  }
  return {
    path: manifestRef,
    status: String(manifest.status || 'unknown'),
    fullContinuityInspected: inspections.every((x) => x && x.status === 'inspected'),
    verificationQueryNames: manifest.verification_queries.map((x) => String(x.name || 'unnamed')),
  };
}

function resolveProvider(provider) {
  const name = String(provider.name || '');
  const configuredRemote = provider.rclone_remote ? String(provider.rclone_remote) : '';
  const remoteEnv = provider.rclone_remote_env ? String(provider.rclone_remote_env) : '';
  const remote = configuredRemote || (remoteEnv ? process.env[remoteEnv] : '');
  return {
    name,
    kind: String(provider.kind || ''),
    remote,
    remoteEnv,
    path: String(provider.rclone_path || ''),
    required: provider.required !== false,
    configured: !!remote,
  };
}

function findNewestReceipt(receiptDir, targetName, providers, storageRequired = false) {
  if (!existsSync(receiptDir)) return null;
  const prefix = `${targetName}-`;
  const expectedProviders = providers.filter((provider) => provider.required || provider.configured);
  if (expectedProviders.length < (storageRequired ? 2 : 1) || new Set(expectedProviders.map((provider) => provider.name)).size !== expectedProviders.length
    || expectedProviders.some((provider) => !provider.configured)) return null;
  const receiptGroups = new Map();
  const now = Date.now();
  for (const entry of readdirSync(receiptDir)) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.custody-receipt.json')) continue;
    const candidate = join(receiptDir, entry);
    try {
      const receipt = JSON.parse(readFileSync(candidate, 'utf8'));
      if (receipt.target !== targetName || receipt.custody_receipt !== true) continue;
      if (receipt.provider_verification?.status !== 'verified') continue;
      if (!expectedProviders.some((provider) => provider.name === receipt.provider)) continue;
      if (!receipt.artifact?.name?.endsWith('.sql.gz.age') || !/^[a-f0-9]{64}$/i.test(receipt.artifact?.sha256 || '')) continue;
      if (receipt.sidecar !== `${receipt.artifact.name}.sha256`) continue;
      const artifactSet = Array.isArray(receipt.artifacts) ? receipt.artifacts : [];
      let digest;
      try { digest = artifactSetDigest(artifactSet); } catch { continue; }
      if (receipt.version < 2 || receipt.artifact_set_digest !== digest || Number(receipt.artifact_count) !== artifactSet.length
        || receipt.backup_set !== receipt.storage?.backup_set) continue;
      if (storageRequired) {
        const storage = receipt.storage;
        const artifacts = Array.isArray(receipt.artifacts) ? receipt.artifacts : [];
        const storageObjects = artifacts.filter((artifact) => artifact?.kind === 'storage-object');
        const manifest = artifacts.find((artifact) => artifact?.kind === 'storage-manifest');
        if (storage?.format !== 'supabase-storage-opaque-age-v1' || !storage?.backup_set || !manifest
          || storageObjects.length !== Number(storage.object_count) || !storage.mode_aggregates?.personal || !storage.mode_aggregates?.business) continue;
      }
      const time = Date.parse(receipt.provider_verification?.verified_at || '');
      if (!Number.isFinite(time) || time > now) continue;
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
      const group = receiptGroups.get(binding) || { artifact: receipt.artifact.name, hash: receipt.artifact.sha256.toLowerCase(), receipts: new Map() };
      const prior = group.receipts.get(receipt.provider);
      if (!prior || time > prior.time) group.receipts.set(receipt.provider, { time, receipt, path: candidate });
      receiptGroups.set(binding, group);
    } catch { /* invalid evidence never counts as a receipt */ }
  }
  let newest = null;
  for (const group of receiptGroups.values()) {
    if (!expectedProviders.every((provider) => group.receipts.has(provider.name))) continue;
    const verifiedReceipts = expectedProviders.map((provider) => group.receipts.get(provider.name));
    const time = Math.min(...verifiedReceipts.map((item) => item.time));
    if (!newest || time > newest.time) {
      newest = { time, artifact: group.artifact, receipts: verifiedReceipts.map((item) => item.path) };
    }
  }
  return newest;
}

function emitBackupAgeAlarm(target, previous, maxAgeHours, catchup) {
  const ageHours = previous ? Math.round(((Date.now() - previous.time) / 3600000) * 10) / 10 : null;
  const detail = previous
    ? `latest verified custody receipt is ${ageHours}h old (limit ${maxAgeHours}h)`
    : `no verified custody receipt exists (limit ${maxAgeHours}h)`;
  process.stderr.write(`[ALARM] ${target} -- ${detail}${catchup ? '; startup catch-up required' : ''}\n`);
  appendJsonl(METRICS_PATH, {
    ts: utcStamp(), event: 'backup_age_alarm', target, max_age_hours: maxAgeHours,
    receipt_age_hours: ageHours, startup_catchup: catchup,
  });
}

function uploadAndVerify(rclonePath, provider, { artifacts, receiptFile, receiptName }) {
  const remoteDir = `${provider.remote}:${provider.path}`;
  const uploads = artifacts.flatMap((artifact) => [
    { local: artifact.path, remoteName: artifact.name },
    { local: artifact.sidecar_path, remoteName: `${artifact.name}.sha256` },
  ]);
  uploads.push({ local: receiptFile, remoteName: receiptName });
  for (const upload of uploads) {
    const copy = runTool(rclonePath, ['copyto', upload.local, `${remoteDir}/${upload.remoteName}`, '--progress=false'],
      { windowsHide: true, encoding: 'utf8' });
    if (copy.error || copy.status !== 0) throw new Error('upload failed');
  }
  const listing = runTool(rclonePath, ['lsf', remoteDir, '--files-only'], { windowsHide: true, encoding: 'utf8' });
  if (listing.error || listing.status !== 0) throw new Error('verification listing failed');
  const remoteFiles = new Set(String(listing.stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
  for (const upload of uploads) {
    if (!remoteFiles.has(upload.remoteName)) throw new Error(`verification missing ${upload.remoteName}`);
  }
  for (const artifact of artifacts) {
    const sidecarReadBack = runTool(rclonePath, ['cat', `${remoteDir}/${artifact.name}.sha256`], { windowsHide: true, encoding: 'utf8' });
    if (sidecarReadBack.error || sidecarReadBack.status !== 0 || String(sidecarReadBack.stdout || '') !== readFileSync(artifact.sidecar_path, 'utf8')) {
      throw new Error('ciphertext SHA-256 sidecar read-back failed');
    }
  }
  const receiptReadBack = runTool(rclonePath, ['cat', `${remoteDir}/${receiptName}`], { windowsHide: true, encoding: 'utf8' });
  if (receiptReadBack.error || receiptReadBack.status !== 0 || String(receiptReadBack.stdout || '') !== readFileSync(receiptFile, 'utf8')) {
    throw new Error('custody receipt read-back failed');
  }
  for (const artifact of artifacts) {
    const ciphertextReadBack = join(dirname(artifact.path), `.${artifact.name}.provider-readback-${randomUUID()}`);
    try {
      const copyBack = runTool(rclonePath, ['copyto', `${remoteDir}/${artifact.name}`, ciphertextReadBack, '--progress=false'],
        { windowsHide: true, encoding: 'utf8' });
      if (copyBack.error || copyBack.status !== 0 || !existsSync(ciphertextReadBack)) {
        throw new Error('ciphertext read-back failed');
      }
      if (sha256File(ciphertextReadBack) !== artifact.sha256) {
        throw new Error('ciphertext SHA-256 read-back mismatch');
      }
    } finally {
      try { rmSync(ciphertextReadBack, { force: true }); } catch { /* best effort; encrypted bytes only */ }
    }
  }
  return remoteDir;
}

function publishVerifiedReceipt(rclonePath, remoteDir, receiptFile, receiptName) {
  const remoteReceipt = `${remoteDir}/${receiptName}`;
  const copy = runTool(rclonePath, ['copyto', receiptFile, remoteReceipt, '--progress=false'],
    { windowsHide: true, encoding: 'utf8' });
  if (copy.error || copy.status !== 0) throw new Error('verified receipt upload failed');
  const readBack = runTool(rclonePath, ['cat', remoteReceipt], { windowsHide: true, encoding: 'utf8' });
  if (readBack.error || readBack.status !== 0 || String(readBack.stdout || '') !== readFileSync(receiptFile, 'utf8')) {
    throw new Error('verified custody receipt read-back failed');
  }
}

// ---- Local-time stamp for the dump filename: matches the .ps1's "yyyy-MM-dd-HHmm" ----
function dumpStampLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// ---- Genuine-UTC stamp in the .ps1's "yyyy-MM-ddTHH:mm:ssZ" shape (for the preserved ledger row) ----
function metricsTs() { return utcStamp(); }

// ---- Verify an external tool is callable; returns true/false without throwing ----
function toolPresent(binary) {
  // A non-zero exit still means the tool is present (e.g. it rejected --version). Only a genuine
  // ENOENT (not on PATH / no such file) means absent. The probe runs only `<bin> --version` with NO
  // untrusted input, so the Windows .cmd/.bat shell retry below is injection-safe -- the credential-
  // bearing pg_dump/rclone spawns in the main loop stay shell:false to eliminate injection risk.
  try {
    const r = spawnSync(binary, ['--version'], { stdio: 'ignore', windowsHide: true });
    if (!r.error) return true;
    if (r.error.code !== 'ENOENT') return true; // EACCES / other -> let the real spawn give the verdict
    // Windows: spawnSync (shell:false) cannot exec a .cmd/.bat wrapper -> ENOENT. PowerShell's `&`
    // CAN, so re-probe through the shell ONLY for those extensions to preserve .ps1 behavior.
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary)) {
      const rs = spawnSync(binary, ['--version'], { stdio: 'ignore', windowsHide: true, shell: true });
      return !rs.error;
    }
    return false;
  } catch { return false; }
}

// Spawn an external tool with NO shell string interpolation (so a credential in args can never be
// shell-injected). On Windows, a .cmd/.bat wrapper can't be exec'd by spawnSync(shell:false), so we
// invoke it as `cmd.exe /c <wrapper> <args...>` -- still an argv ARRAY, so each arg (including the
// connection string) is passed literally, never parsed by a shell. Real Windows pg_dump.exe /
// rclone.exe resolve directly and skip this path.
function runTool(binary, toolArgs, opts) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary)) {
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/c', binary, ...toolArgs],
      { ...opts, shell: false });
  }
  return spawnSync(binary, toolArgs, { ...opts, shell: false });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); writeRunSummary('skipped', 'help'); process.exit(0); }

  const configPath = args.config || join(FACTORY_ROOT, 'scripts', 'backup-targets.json');
  // The registry owns its restore-manifest references. This keeps an explicit fixture/worktree
  // registry self-contained even when VIBE_ROOT points at another durable factory checkout.
  const registryRoot = dirname(dirname(configPath));
  const localDumpDir = args.localDumpDir || join(FACTORY_ROOT, 'backups', 'local');

  // ---- Init mode (scaffold sample config; not a backup => exit 0 / skipped) ----
  if (args.init) {
    if (existsSync(configPath)) {
      process.stdout.write(`[SKIP] ${configPath} already exists -- not overwriting.\n`);
      writeRunSummary('skipped', 'init: config exists');
      process.exit(0);
    }
    const sample = {
      version: 2,
      defaults: { local_retention_days: 3, backup_age_hours: 30, receipt_dir: 'backups/receipts' },
      targets: [{
        name: 'example-prod', enabled: false, pg_uri_env: 'EXAMPLE_PG_DUMP_URL',
        age_recipient_env: 'EXAMPLE_BACKUP_AGE_RECIPIENT',
        restore_manifest: 'docs/restore-manifests/example-prod.json',
        providers: [{ name: 'r2', kind: 'rclone', rclone_remote_env: 'EXAMPLE_R2_RCLONE_REMOTE', rclone_path: 'example/prod/encrypted', required: true }],
      }],
    };
    try {
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify(sample, null, 2), 'utf8');
    } catch (e) {
      failLoud(`init: could not write ${configPath}: ${e.message}`);
    }
    process.stdout.write(`[OK] Wrote sample config: ${configPath}\n\n`);
    process.stdout.write('Next steps:\n');
    process.stdout.write(`  1. Edit ${configPath} -- enable each target you want to back up.\n`);
    process.stdout.write("  2. Set only the named connection-string and public age-recipient env vars; never put values in this file.\n");
    process.stdout.write("  3. Configure rclone remotes locally (R2 required; Proton Drive optional) and set their named remote aliases.\n");
    process.stdout.write('  4. Add a complete restore manifest before enabling the target.\n');
    process.stdout.write('  5. Test a single target: node pg-dump-offsite.mjs --target example-prod --dry-run\n');
    writeRunSummary('skipped', 'init: wrote sample config');
    process.exit(0);
  }

  // ---- Load config (fail-loud: a missing/invalid config for a backup job is a real failure) ----
  if (!existsSync(configPath)) {
    failLoud(`Config not found: ${configPath}. Run with --init to scaffold.`);
  }
  let cfg;
  try {
    let raw = readFileSync(configPath, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // tolerate a UTF-8 BOM
    cfg = JSON.parse(raw);
  } catch (e) {
    failLoud(`Invalid JSON in ${configPath}: ${e.message}`);
  }

  if (!Array.isArray(cfg.targets) || cfg.targets.length === 0) {
    failLoud(`No targets defined in ${configPath}`);
  }

  // ---- Determine which targets will actually run (respect --target + enabled flag) ----
  const selected = cfg.targets.filter((t) => {
    if (args.target && t.name !== args.target) return false;
    if (Object.prototype.hasOwnProperty.call(t, 'enabled') && !t.enabled) {
      process.stdout.write(`[SKIP] ${t.name} -- disabled in config\n`);
      return false;
    }
    return true;
  });

  if (selected.length === 0) {
    // Nothing to do is a legitimate no-op -> exit 0, status:skipped (NOT a silent backup no-op:
    // there were genuinely no enabled/matching targets, which the operator chose).
    const reason = args.target ? `no enabled target matched '${args.target}'` : 'no enabled targets';
    process.stdout.write(`[RESULT] ${reason} -- nothing to back up.\n`);
    writeRunSummary('skipped', reason);
    process.exit(0);
  }

  // ---- Tool presence (fail-loud BEFORE attempting any dump; a backup must never silently no-op) ----
  // pg_dump is always required. rclone is required when a remote+path is configured for any selected
  // target; if every selected target is local-only, rclone isn't needed.
  if (!args.dryRun) {
    if (!toolPresent(args.pgDumpPath)) {
      failLoud(`pg_dump not found ('${args.pgDumpPath}' not callable). Install Postgres client tools or pass --pg-dump-path.`);
    }
    if (!toolPresent(args.rclonePath)) {
      failLoud(`rclone not found ('${args.rclonePath}' not callable). Install rclone (https://rclone.org) or pass --rclone-path.`);
    }
    if (!toolPresent(args.agePath)) {
      failLoud(`age not found ('${args.agePath}' not callable). Install age or pass --age-path.`);
    }
  }

  // ---- Prep local dump dir ----
  if (!existsSync(localDumpDir)) {
    try { mkdirSync(localDumpDir, { recursive: true }); }
    catch (e) { failLoud(`could not create local dump dir ${localDumpDir}: ${e.message}`); }
  }
  const receiptDir = join(FACTORY_ROOT, String(cfg.defaults?.receipt_dir || 'backups/receipts'));
  try { mkdirSync(receiptDir, { recursive: true }); }
  catch (e) { failLoud(`could not create receipt dir ${receiptDir}: ${e.message}`); }
  const maxAgeHours = Number(cfg.defaults?.backup_age_hours || 30);

  // ---- Iterate selected targets ----
  const results = [];
  let anyFailed = false;
  let okCount = 0;

  for (const t of selected) {
    const name = String(t.name);
    const pgUriEnv = String(t.pg_uri_env || '');
    if (!safeTargetName(name)) {
      process.stderr.write(`[FAIL] invalid target name '${name}'\n`);
      results.push({ target: name || 'unknown', status: 'fail', reason: 'invalid target name' });
      anyFailed = true;
      continue;
    }
    let restoreContract;
    try { restoreContract = readRestoreManifest(registryRoot, t); }
    catch (e) {
      process.stderr.write(`[FAIL] ${name} restore contract: ${e.message}\n`);
      results.push({ target: name, status: 'fail', reason: 'invalid restore manifest' });
      anyFailed = true;
      continue;
    }
    const providers = Array.isArray(t.providers) ? t.providers.map(resolveProvider) : [];
    const requiredProviders = providers.filter((p) => p.required);
    const r2Provider = requiredProviders.find((p) => p.name === 'r2' && p.kind === 'rclone');
    if (!r2Provider || (t.storage?.required === true && (requiredProviders.length < 2 || new Set(requiredProviders.map((p) => p.name)).size !== requiredProviders.length))
      || requiredProviders.some((p) => p.kind !== 'rclone' || !p.configured)) {
      process.stderr.write(`[FAIL] ${name} -- two distinct configured required custody providers (including r2) are mandatory\n`);
      results.push({ target: name, status: 'fail', reason: 'two required configured custody providers missing' });
      anyFailed = true;
      continue;
    }
    const previous = findNewestReceipt(receiptDir, name, providers, t.storage?.required === true);
    const ageMs = previous ? Date.now() - previous.time : Infinity;
    const stale = ageMs > maxAgeHours * 60 * 60 * 1000;
    if (stale) emitBackupAgeAlarm(name, previous, maxAgeHours, args.startupCatchup);
    if (args.startupCatchup) {
      if (previous && ageMs <= maxAgeHours * 60 * 60 * 1000) {
        process.stdout.write(`[SKIP] ${name} -- latest verified custody receipt is ${Math.round(ageMs / 60000)}m old\n`);
        results.push({
          target: name,
          status: 'skipped-fresh',
          artifact: previous.artifact,
          receipts: previous.receipts.map((receiptPath) => basename(receiptPath)),
        });
        okCount++;
        continue;
      }
      process.stderr.write(`[ALARM] ${name} -- ${previous ? 'custody receipt is stale' : 'no custody receipt exists'}; running startup catch-up\n`);
    }
    const stamp = dumpStampLocal();
    const dumpFile = join(localDumpDir, `${name}-${stamp}.sql.gz`);
    const ciphertextFile = `${dumpFile}.age`;

    // Credential: from env ONLY. Never logged.
    const pgUri = process.env[pgUriEnv];
    if (!pgUri) {
      // A configured-but-unset credential is a fail-loud condition (never a silent skip for a backup).
      process.stderr.write(`[FAIL] ${name} -- env var ${pgUriEnv} is not set\n`);
      results.push({ target: name, status: 'fail', reason: `missing env ${pgUriEnv}` });
      anyFailed = true;
      continue;
    }
    const ageRecipientEnv = String(t.age_recipient_env || '');
    const ageRecipient = ageRecipientEnv ? process.env[ageRecipientEnv] : '';
    if (!ageRecipient) {
      process.stderr.write(`[FAIL] ${name} -- age recipient env ${ageRecipientEnv || '<missing>'} is not set\n`);
      results.push({ target: name, status: 'fail', reason: 'missing age recipient' });
      anyFailed = true;
      continue;
    }

    process.stdout.write(`[RUN ] ${name} -> encrypted required custody providers\n`);

    if (args.dryRun) {
      // Print the PLANNED commands with the credential VALUE redacted; do NOT execute.
      const pgArgsRedacted = ['--format=plain', '--no-owner', '--no-acl', '--quote-all-identifiers'];
      process.stdout.write(`        (dry-run; not executing)\n`);
      process.stdout.write(`        planned: PGDATABASE=<REDACTED $${pgUriEnv}> ${args.pgDumpPath} ${pgArgsRedacted.join(' ')}  | gzip -> ${dumpFile}\n`);
      process.stdout.write(`        planned: ${args.agePath} --encrypt --recipient <REDACTED $${String(t.age_recipient_env || '')}> --output ${ciphertextFile} ${dumpFile}\n`);
      for (const provider of providers) {
        if (!provider.configured && provider.required) {
          process.stderr.write(`[FAIL] ${name} -- required provider ${provider.name} remote is not configured\n`);
          anyFailed = true;
        } else if (provider.configured) {
          process.stdout.write(`        planned: ${args.rclonePath} copyto ${ciphertextFile} ${provider.remote}:${provider.path}/${basename(ciphertextFile)}\n`);
        }
      }
      if (t.storage) {
        process.stdout.write('        planned: fetch Supabase Storage bytes -> opaque age ciphertext + encrypted detailed manifest -> provider read-back\n');
      }
      results.push({ target: name, status: anyFailed ? 'fail' : 'dry-run', artifact: basename(ciphertextFile), restore_contract: restoreContract.path });
      continue;
    }

    // ---- pg_dump -> Buffer -> gzip ----
    // Pass the connection string through PGDATABASE, never argv. External stderr is deliberately not
    // echoed because provider/client diagnostics can reflect connection details on some versions.
    let dumpOk = false;
    const tmp = `${dumpFile}.tmp`;
    try {
      const pgArgs = ['--format=plain', '--no-owner', '--no-acl', '--quote-all-identifiers'];
      const r = runTool(args.pgDumpPath, pgArgs, {
        maxBuffer: 1024 * 1024 * 1024, // 1 GiB cap for the SQL text before gzip
        windowsHide: true,
        encoding: 'buffer',
        env: { ...process.env, PGDATABASE: pgUri },
      });
      if (r.error) throw new Error('pg_dump spawn failed (external detail redacted)');
      if (r.status !== 0) {
        throw new Error(`pg_dump exit ${r.status} (external stderr redacted)`);
      }
      const sql = r.stdout || Buffer.alloc(0);
      if (sql.length === 0) throw new Error('dump output empty');
      const gz = gzipSync(sql, { level: 9 }); // CompressionLevel.Optimal analogue
      writeFileSync(tmp, gz);
      if (existsSync(tmp) && statSync(tmp).size > 0) {
        renameSync(tmp, dumpFile);
        dumpOk = true;
      } else {
        throw new Error('dump file empty or missing after write');
      }
    } catch (e) {
      process.stderr.write(`[FAIL] ${name} pg_dump: ${e.message}\n`);
      try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* best effort */ }
    }

    if (!dumpOk) {
      results.push({ target: name, status: 'fail', reason: 'pg_dump failed' });
      anyFailed = true;
      continue;
    }

    const sizeKb = Math.round((statSync(dumpFile).size / 1024) * 10) / 10;
    process.stdout.write(`        pg_dump OK (${sizeKb} KB)\n`);

    const ciphertextTmp = `${ciphertextFile}.tmp`;
    let sidecar;
    let ciphertextHash;
    try {
      const encrypted = runTool(args.agePath, ['--encrypt', '--recipient', ageRecipient, '--output', ciphertextTmp, dumpFile],
        { windowsHide: true, encoding: 'utf8' });
      if (encrypted.error || encrypted.status !== 0 || !existsSync(ciphertextTmp) || statSync(ciphertextTmp).size === 0) {
        throw new Error('age encryption failed');
      }
      renameSync(ciphertextTmp, ciphertextFile);
      ciphertextHash = sha256File(ciphertextFile);
      sidecar = writeCiphertextSidecar(ciphertextFile, ciphertextHash);
      rmSync(dumpFile, { force: true });
      if (existsSync(dumpFile)) throw new Error('transient plaintext cleanup failed');
    } catch {
      const cleanupFailures = removeLocalFiles(ciphertextTmp, ciphertextFile, sidecar, dumpFile);
      const reason = cleanupFailures.includes(dumpFile)
        ? 'age encryption failed; transient plaintext cleanup also failed'
        : 'age encryption failed';
      process.stderr.write(`[FAIL] ${name} -- ${reason}\n`);
      results.push({ target: name, status: 'fail', reason });
      anyFailed = true;
      continue;
    }

    let storageSnapshot = null;
    try {
      storageSnapshot = await createStorageSnapshot({
        storage: t.storage,
        target: name,
        stamp,
        outputDir: dirname(ciphertextFile),
        agePath: args.agePath,
        recipient: ageRecipient,
        runTool,
      });
      if (storageSnapshot) {
        process.stdout.write(`        Storage encrypted: ${storageSnapshot.object_count} opaque object ciphertext(s) + encrypted manifest\n`);
      }
    } catch (error) {
      cleanStorageSnapshot(storageSnapshot);
      removeLocalFiles(ciphertextFile, sidecar);
      process.stderr.write(`[FAIL] ${name} -- Storage encrypted custody export failed: ${error.message}\n`);
      results.push({ target: name, status: 'fail', reason: 'Storage encrypted custody export failed' });
      anyFailed = true;
      continue;
    }
    const artifacts = custodyArtifacts({
      path: ciphertextFile,
      sidecar_path: sidecar,
      bytes: statSync(ciphertextFile).size,
      sha256: ciphertextHash,
    }, storageSnapshot);

    const providerResults = [];
    for (const provider of providers) {
      if (!provider.configured) {
        if (provider.required) {
          providerResults.push({ provider: provider.name, status: 'fail', reason: 'remote not configured' });
          anyFailed = true;
        } else {
          providerResults.push({ provider: provider.name, status: 'not-configured' });
        }
        continue;
      }
      const receiptName = receiptFileName(name, stamp, provider.name);
      const receiptPath = join(receiptDir, receiptName);
      const pendingReceiptPath = join(receiptDir, `.${receiptName}.pending-${randomUUID()}`);
      const receipt = {
        version: 2,
        custody_receipt: true,
        created_at: new Date().toISOString(),
        target: name,
        provider: provider.name,
        artifact: { name: basename(ciphertextFile), bytes: statSync(ciphertextFile).size, sha256: ciphertextHash, encrypted_with: 'age' },
        artifacts: canonicalArtifactSet(artifacts).map((artifact) => ({ ...artifact, encrypted_with: 'age' })),
        artifact_count: artifacts.length,
        artifact_set_digest: artifactSetDigest(artifacts),
        backup_set: storageSnapshot?.backup_set,
        sidecar: basename(sidecar),
        storage: storageSnapshot ? {
          format: 'supabase-storage-opaque-age-v1',
          backup_set: storageSnapshot.backup_set,
          encrypted_manifest: {
            name: storageSnapshot.manifest.name,
            bytes: storageSnapshot.manifest.bytes,
            sha256: storageSnapshot.manifest.sha256,
            sidecar: `${storageSnapshot.manifest.name}.sha256`,
          },
          object_count: storageSnapshot.object_count,
          mode_aggregates: storageSnapshot.mode_aggregates,
        } : undefined,
        provider_verification: {
          status: 'pending',
          method: 'ciphertext-sha256-plus-exact-sidecar-and-receipt-read-back',
        },
        restore_contract: restoreContract,
      };
      try {
        // Publish the local receipt only after provider read-back succeeds. Startup catch-up scans
        // only final *.custody-receipt.json names, so an interrupted/failed upload cannot look fresh.
        writeFileSync(pendingReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
        const remoteDir = uploadAndVerify(args.rclonePath, provider, {
          artifacts, receiptFile: pendingReceiptPath, receiptName,
        });
        receipt.provider_verification.status = 'verified';
        receipt.provider_verification.verified_at = new Date().toISOString();
        writeFileSync(pendingReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
        publishVerifiedReceipt(args.rclonePath, remoteDir, pendingReceiptPath, receiptName);
        renameSync(pendingReceiptPath, receiptPath);
        providerResults.push({ provider: provider.name, status: 'verified', remote: remoteDir, receipt: basename(receiptPath) });
        process.stdout.write(`        ${provider.name} custody receipt verified\n`);
      } catch {
        try { rmSync(pendingReceiptPath, { force: true }); } catch { /* best effort */ }
        providerResults.push({ provider: provider.name, status: 'fail', reason: 'upload or receipt verification failed' });
        anyFailed = true;
        process.stderr.write(`[FAIL] ${name} -- ${provider.name} upload/receipt verification failed\n`);
      }
    }
    const configuredProviderFailed = providerResults.some((x) => {
      const provider = providers.find((p) => p.name === x.provider);
      return (provider?.required || provider?.configured) && x.status !== 'verified';
    });
    if (configuredProviderFailed) {
      // A partial provider set is not custody evidence. Remove only final receipts created by
      // this run; prior independently verified sets remain available for freshness checks.
      for (const result of providerResults) {
        if (result.status === 'verified' && result.receipt) {
          try { rmSync(join(receiptDir, result.receipt), { force: true }); } catch { /* best effort */ }
        }
      }
      results.push({ target: name, status: 'fail', reason: 'configured custody verification failed', artifact: basename(ciphertextFile), providers: providerResults });
      anyFailed = true;
      continue;
    }
    results.push({ target: name, status: 'ok', artifact: basename(ciphertextFile), ciphertext_sha256: ciphertextHash, size_kb: sizeKb, storage: storageSnapshot ? { object_count: storageSnapshot.object_count, mode_aggregates: storageSnapshot.mode_aggregates } : undefined, providers: providerResults, full_continuity_inspected: restoreContract.fullContinuityInspected });
    okCount++;
  }

  // ---- Prune old local custody material (best effort; never fails the run) ----
  try {
    const cutoff = Date.now() - args.retainLocalDays * 24 * 60 * 60 * 1000;
    for (const f of readdirSync(localDumpDir)) {
      const full = join(localDumpDir, f);
      try {
        const custodyArtifact = f === 'storage' || f.endsWith('.sql.gz') || f.endsWith('.sql.gz.age')
          || f.endsWith('.sql.gz.age.sha256') || f.includes('.provider-readback-');
        if (custodyArtifact && statSync(full).mtimeMs < cutoff) {
          process.stdout.write(`[PRUNE] ${f} (>${args.retainLocalDays} days old)\n`);
          rmSync(full, { force: true, recursive: f === 'storage' });
        }
      } catch { /* best effort per-file */ }
    }
    for (const f of readdirSync(receiptDir)) {
      const full = join(receiptDir, f);
      try {
        const custodyReceipt = f.endsWith('.custody-receipt.json') || f.includes('.custody-receipt.json.pending-');
        if (custodyReceipt && statSync(full).mtimeMs < cutoff) {
          process.stdout.write(`[PRUNE] ${f} (>${args.retainLocalDays} days old)\n`);
          rmSync(full, { force: true });
        }
      } catch { /* best effort per-file */ }
    }
  } catch { /* best effort prune */ }

  // ---- Preserve the .ps1's per-run ledger row (event=pg_dump_offsite) ----
  appendJsonl(METRICS_PATH, {
    ts: metricsTs(),
    event: 'pg_dump_offsite',
    dry_run: !!args.dryRun,
    targets: results,
    any_failed: anyFailed,
  });

  // ---- T3 run-summary + exit ----
  // anyFailed is checked FIRST -- even under --dry-run. The only way a target fails during a dry-run
  // is a missing/unset credential env var (pg_dump + rclone never execute), and a missing prerequisite
  // for a backup is a fail-loud condition (spec rule 4) -- never a silent skip. This matches the .ps1,
  // whose final $any_failed -> exit 1 has no dry-run override.
  if (anyFailed) {
    process.stdout.write('\n[RESULT] one or more targets failed -- see warnings above. Exit 1.\n');
    const failed = results.filter((r) => r.status === 'fail').map((r) => r.target);
    writeRunSummary('fail', `failed: ${failed.join(', ')}`);
    process.exit(1);
  }

  if (args.dryRun) {
    process.stdout.write('\n[RESULT] dry-run complete -- no data dumped or uploaded.\n');
    writeRunSummary('skipped', `dry-run (${results.length} target(s) planned)`);
    process.exit(0);
  }

  const uninspected = results.filter((r) => r.status === 'ok' && r.full_continuity_inspected === false).length;
  process.stdout.write(`\n[RESULT] ${okCount} target(s) have verified required encrypted custody receipts.\n`);
  if (uninspected) {
    process.stderr.write(`[NOTICE] ${uninspected} target(s) still have pending restore-manifest inspections; no full-continuity claim is made.\n`);
  }
  writeRunSummary('ok', `${okCount} target(s) encrypted custody verified; ${uninspected} pending full-continuity inspections`);
  process.exit(0);
}

// ---- Top-level guard: any unexpected error is fail-loud, never an unhandled crash on the host ----
try {
  await main();
} catch (e) {
  failLoud(`unexpected error: ${e && e.message ? e.message : String(e)}`);
}
