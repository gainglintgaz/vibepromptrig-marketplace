#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

function die(message) { console.error(`FAIL: ${message}`); process.exit(1); }
function parse(argv) {
  const allowed = new Set(['--root', '--receipt', '--expected-sha']);
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!allowed.has(key) || !value || value.startsWith('--')) die(`unsupported or incomplete argument: ${key ?? '(missing)'}`);
    out[key.slice(2)] = value;
  }
  if (!out.receipt) die('--receipt is required; implicit newest-receipt selection is not allowed');
  return out;
}

const args = parse(process.argv.slice(2));
const root = resolve(args.root || process.cwd());
const realRoot = realpathSync(root);
if (isAbsolute(args.receipt) || args.receipt.split(/[\\/]/).includes('..')) die('--receipt must be a repository-relative path');
const receiptPath = resolve(root, args.receipt);
const receiptRel = relative(root, receiptPath);
if (receiptRel === '..' || receiptRel.startsWith(`..${sep}`)) die('--receipt must stay inside the repository');
if (!existsSync(receiptPath)) die(`receipt not found: ${receiptPath}`);
let receipt;
try { receipt = JSON.parse(readFileSync(receiptPath, 'utf8')); }
catch (error) { die(`malformed receipt JSON: ${error instanceof Error ? error.message : String(error)}`); }

const errors = [];
function rejectUnknownKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${label} contains forbidden or unknown field: ${key}`);
}
rejectUnknownKeys(receipt, new Set([
  'schema_version', 'scope_id', 'scope_description', 'source_commit_sha', 'environment',
  'work_author_id', 'created_at', 'expires_at', 'acceptance_criteria',
  'verification_records', 'known_gaps', 'production_verification',
]), 'manifest');
const sourceSha = receipt.source_commit_sha || '';
if (receipt.schema_version !== 3) errors.push('schema_version must be 3; v1/v2 self-issued receipts are invalid');
if (!/^[0-9a-f]{40}$/.test(sourceSha)) errors.push('source_commit_sha must be a full 40-character lowercase SHA');
else {
  const exists = spawnSync('git', ['cat-file', '-e', `${sourceSha}^{commit}`], { cwd: root });
  if (exists.status !== 0) errors.push('source_commit_sha does not exist in this repository');
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (head.status !== 0 || String(head.stdout || '').trim() !== sourceSha) errors.push('source_commit_sha must equal current HEAD; ancestor receipts are stale');
}
if (args['expected-sha'] && args['expected-sha'] !== sourceSha) errors.push('source_commit_sha does not match --expected-sha');
if (!receipt.scope_id || !receipt.scope_description || !receipt.environment || !receipt.work_author_id) errors.push('scope_id, scope_description, environment, and work_author_id are required');
if (!['local', 'ci', 'staging', 'production'].includes(receipt.environment)) errors.push('environment must be exactly local, ci, staging, or production');
if (receipt.environment !== 'production' && 'production_verification' in receipt) errors.push('production_verification is only allowed when environment is production');

const created = Date.parse(receipt.created_at), expires = Date.parse(receipt.expires_at), now = Date.now();
if (!Number.isFinite(created) || !Number.isFinite(expires)) errors.push('created_at and expires_at must be valid timestamps');
else {
  if (created > now + 5 * 60_000) errors.push('created_at is in the future');
  if (expires <= now) errors.push('receipt is expired');
  if (expires - created > 7 * 24 * 60 * 60_000) errors.push('receipt validity exceeds seven days');
}
if (!Array.isArray(receipt.known_gaps) || receipt.known_gaps.some((g) => typeof g !== 'string' || !g.trim())) errors.push('known_gaps must be an explicit array of non-empty strings');

const evidenceIds = new Set();
const evidenceFiles = new Set();
function verifyEvidence(id, evidence, label, uniqueFile = false) {
  if (!id || evidenceIds.has(id)) { errors.push(`${label} has a missing or duplicate evidence id`); return; }
  evidenceIds.add(id);
  rejectUnknownKeys(evidence, new Set(['path', 'sha256']), `${label} evidence`);
  if (!evidence || typeof evidence.path !== 'string' || !/^[0-9a-f]{64}$/.test(evidence.sha256 || '')) { errors.push(`${label} requires an evidence path and SHA-256 digest`); return; }
  if (isAbsolute(evidence.path) || evidence.path.split(/[\\/]/).includes('..')) { errors.push(`${label} evidence path is unsafe`); return; }
  const absolute = resolve(root, evidence.path), rel = relative(root, absolute);
  if (rel === '..' || rel.startsWith(`..${sep}`) || !existsSync(absolute) || !statSync(absolute).isFile()) { errors.push(`${label} evidence file is missing or outside the repository`); return; }
  if (lstatSync(absolute).isSymbolicLink()) { errors.push(`${label} evidence file must not be a symbolic link`); return; }
  const realEvidence = realpathSync(absolute), realRel = relative(realRoot, realEvidence);
  if (realRel === '..' || realRel.startsWith(`..${sep}`)) { errors.push(`${label} evidence resolves outside the repository`); return; }
  if (uniqueFile && evidenceFiles.has(realEvidence)) errors.push(`${label} requires a separate evidence file, not a reused check log`);
  evidenceFiles.add(realEvidence);
  const digest = createHash('sha256').update(readFileSync(realEvidence)).digest('hex');
  if (digest !== evidence.sha256) errors.push(`${label} evidence digest does not match the file`);
}

if ('independent_review' in receipt) errors.push('independent_review is forbidden in a self-issued manifest; use a separately authenticated review source');

const commands = receipt.verification_records;
if (!Array.isArray(commands) || commands.length === 0) errors.push('verification_records must contain operator-recorded checks');
else for (const command of commands) {
  const label = `verification record ${command?.id || '(unnamed)'}`;
  rejectUnknownKeys(command, new Set([
    'id', 'attestation_level', 'command', 'exit_code', 'commit_sha', 'checks_passed',
    'checks_total', 'started_at', 'finished_at', 'evidence',
  ]), label);
  if (command?.attestation_level !== 'operator_recorded') errors.push(`${label} must declare attestation_level=operator_recorded; a manifest cannot self-certify execution`);
  if (!command?.command?.trim()) errors.push(`${label} has no command`);
  if (command?.exit_code !== 0) errors.push(`${label} did not exit 0`);
  if (command?.commit_sha !== sourceSha) errors.push(`${label} was not recorded for the source commit`);
  if (!Number.isInteger(command?.checks_passed) || !Number.isInteger(command?.checks_total) || command.checks_total < 1 || command.checks_passed !== command.checks_total) errors.push(`${label} requires equal positive checks_passed/checks_total denominators`);
  const started = Date.parse(command?.started_at), finished = Date.parse(command?.finished_at);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started || (Number.isFinite(created) && finished > created + 5 * 60_000)) errors.push(`${label} has invalid execution timestamps`);
  verifyEvidence(command?.id, command?.evidence, label);
}

const criteria = receipt.acceptance_criteria;
if (!Array.isArray(criteria) || criteria.length === 0) errors.push('acceptance_criteria must not be empty');
else {
  const ids = new Set();
  for (const criterion of criteria) {
    rejectUnknownKeys(criterion, new Set([
      'id', 'expected_behavior', 'evidence_source', 'commit_sha', 'environment',
      'required', 'status', 'gap', 'evidence_refs',
    ]), `acceptance criterion ${criterion?.id || '(unnamed)'}`);
    if (!criterion?.id || ids.has(criterion.id)) errors.push('acceptance criteria require unique ids');
    ids.add(criterion?.id);
    if (!criterion?.expected_behavior?.trim()) errors.push(`acceptance criterion ${criterion?.id || '(unnamed)'} has no expected_behavior`);
    if (!criterion?.evidence_source?.trim()) errors.push(`acceptance criterion ${criterion?.id || '(unnamed)'} has no evidence_source`);
    if (criterion?.commit_sha !== sourceSha) errors.push(`acceptance criterion ${criterion?.id || '(unnamed)'} does not match the source commit`);
    if (criterion?.environment !== receipt.environment) errors.push(`acceptance criterion ${criterion?.id || '(unnamed)'} does not match the manifest environment`);
    if (!Object.prototype.hasOwnProperty.call(criterion || {}, 'gap') || (criterion.gap !== null && typeof criterion.gap !== 'string')) errors.push(`acceptance criterion ${criterion?.id || '(unnamed)'} requires a string or null gap`);
    if (!['passed', 'failed', 'not_run', 'mocked_only', 'skipped', 'authority_blocked'].includes(criterion?.status)) errors.push(`acceptance criterion ${criterion?.id || '(unnamed)'} has an invalid status`);
    if (criterion?.required !== false && criterion?.status !== 'passed') errors.push(`required acceptance criterion ${criterion?.id || '(unnamed)'} is not passed`);
    if (!Array.isArray(criterion?.evidence_refs) || criterion.evidence_refs.length === 0) errors.push(`acceptance criterion ${criterion?.id || '(unnamed)'} has no evidence refs`);
  }
}

if (receipt.environment === 'production') {
  const prod = receipt.production_verification;
  if (!prod || prod.status !== 'passed' || prod.deployed_commit_sha !== sourceSha) errors.push('production receipt requires passed live verification of the exact deployed commit');
  else {
    rejectUnknownKeys(prod, new Set([
      'status', 'attestation_level', 'deployed_commit_sha', 'checks_passed',
      'checks_total', 'evidence_id', 'evidence',
      'artifact_observation', 'live_invocation',
    ]), 'production verification');
    if (prod.attestation_level !== 'operator_recorded') errors.push('production verification must declare attestation_level=operator_recorded; the manifest cannot self-certify production truth');
    if (!Number.isInteger(prod.checks_passed) || prod.checks_passed !== prod.checks_total || prod.checks_total < 1) errors.push('production verification requires equal positive checks_passed/checks_total denominators');
    verifyEvidence(prod.evidence_id, prod.evidence, 'production verification');
    // PT-2: deployment output and unit logs cannot stand in for both live observations.
    // These are operator records, not authenticated proof that either event occurred.
    for (const kind of ['artifact_observation', 'live_invocation']) {
      const observation = prod[kind], label = `production ${kind}`;
      rejectUnknownKeys(observation, new Set([
        'environment', 'target', 'deployed_commit_sha', 'observed_at', 'evidence_id', 'evidence',
        ...(kind === 'live_invocation' ? ['surface', 'operation', 'result_code', 'outcome'] : []),
      ]), label);
      if (!observation || typeof observation !== 'object' || Array.isArray(observation)) continue;
      if (observation.environment !== 'production') errors.push(`${label} environment must be production`);
      if (observation.deployed_commit_sha !== sourceSha) errors.push(`${label} must identify the exact deployed commit`);
      if (typeof observation.target !== 'string' || !observation.target.trim()) errors.push(`${label} requires a target label`);
      const observed = Date.parse(observation.observed_at);
      if (!Number.isFinite(observed) || observed > now + 5 * 60_000 || observed > created + 5 * 60_000 || observed < created - 7 * 24 * 60 * 60_000) errors.push(`${label} has a missing, stale, or future observed_at`);
      if (kind === 'live_invocation') {
        for (const field of ['surface', 'operation', 'result_code']) {
          if (typeof observation[field] !== 'string' || !observation[field].trim()) errors.push(`${label} requires ${field}`);
        }
        if (!['succeeded', 'honest_failure'].includes(observation.outcome)) errors.push(`${label} outcome must be succeeded or honest_failure`);
      }
      verifyEvidence(observation.evidence_id, observation.evidence, label, true);
    }
    if (prod.artifact_observation?.target !== prod.live_invocation?.target) errors.push('production observations must identify the same target');
  }
}

for (const criterion of criteria || []) for (const ref of criterion?.evidence_refs || []) if (!evidenceIds.has(ref)) errors.push(`acceptance criterion ${criterion.id} references unknown evidence ${ref}`);

if (errors.length) {
  console.error(`FAIL: completion receipt validation failed for ${receiptPath}:`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(`PASS: evidence-manifest internal consistency for ${receipt.scope_id} at ${sourceSha}`);
console.log('NOTICE: this does not prove command execution, independent review, human approval, production truth, or completion.');
