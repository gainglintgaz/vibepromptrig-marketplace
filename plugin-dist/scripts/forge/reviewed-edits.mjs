#!/usr/bin/env node
// Single-file reviewed writes. Native permissions and trusted user consent remain authoritative.
import { lstatSync, realpathSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, join, dirname, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseProjectJson, ProjectJsonError } from './project-json.mjs';

const LIMIT = 256 * 1024;
export const MAX_SOURCES = 128; // Checkup: 9 base files + 30 workflows + 50 literal references, plus cited evidence.
const stop = message => { throw new Error(message); };
export const exactHash = bytes => bytes === null ? 'new' : createHash('sha256').update(bytes).digest('hex');
const validHash = value => value === 'new' || /^[a-f0-9]{64}$/.test(value || '');
const projectIdentity = root => exactHash(Buffer.from(realpathSync.native(root).replace(/^[A-Z]:/, drive => drive.toLowerCase())));
// Only the drive-letter spelling changed in legacy Windows records; never accept another folder.
const legacyProjectIdentity = root => exactHash(Buffer.from(realpathSync.native(root).replace(/^[a-z]:/i, drive => drive.toUpperCase())));
const undoIdentity = (root, path, bytes, identity = projectIdentity(root)) => exactHash(Buffer.from(JSON.stringify({ project_identity: identity, backup: path, backup_hash: exactHash(bytes) })));
const exactKeys = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) stop('Invalid ' + label + ' fields. Nothing was changed.');
};
export function resolveInside(root, path) {
  if (typeof path !== 'string' || !path || path.length > 250 || isAbsolute(path) || path.includes('\\') || /[:\x00-\x1f]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) stop('Use an allowed relative project path. Nothing was changed.');
  const base = realpathSync(root), target = resolve(base, path), delta = relative(base, target);
  if (isAbsolute(delta) || delta === '..' || delta.startsWith('../') || delta.startsWith('..\\')) stop('Path is outside this project. Nothing was changed.');
  let cursor = base;
  for (const part of path.split('/')) {
    cursor = join(cursor, part);
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) stop('Linked project paths are excluded. Nothing was changed.');
      if (cursor !== target && !stat.isDirectory()) stop('A project path is not a folder. Nothing was changed.');
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return target;
}
export function readBytes(root, path) {
  excludeCredentials(path);
  const target = resolveInside(root, path);
  try {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.size > LIMIT) stop('Project file exceeds the 256 KiB limit or is not a regular file: ' + path + '. Nothing was changed.');
    return readFileSync(target);
  } catch (e) { if (e.code === 'ENOENT') return null; if (e.code) throw new ProjectJsonError(path); throw e; }
}
function targetAllowed(kind, target) {
  const allowed = {
    skill: /^\.claude\/skills\/[a-z0-9][a-z0-9-]{0,62}\/SKILL\.md$/,
    agent: /^\.claude\/agents\/[a-z0-9][a-z0-9-]{0,62}\.md$/,
    instructions: /^(?:CLAUDE\.md|AGENTS\.md|README\.md|\.claude\/rules\/[a-z0-9][a-z0-9-]*\.md)$/,
    handoff: /^\.vibepromptrig\/handoff\.json$/,
    history: /^\.vibepromptrig\/history\.json$/,
  };
  if (!allowed[kind]?.test(target)) stop('This target path is not allowed for the reviewed change. Nothing was changed.');
}
function excludeCredentials(path) {
  if (typeof path === 'string' && path.split('/').some(part => /(?:^|[._-])(?:tokens?|secrets?|auth)(?:[._-]|$)/i.test(part))) stop('Credential or excluded source path. Nothing was changed.');
  if (typeof path !== 'string' || /(?:^|\/)(?:\.env[^/]*|\.git|\.aws|\.ssh|node_modules|\.mcp\.json|\.npmrc|settings(?:\.local)?\.json|(?:credentials?|secrets?|tokens?|auth)(?:\.[^/]+)?|id_(?:rsa|ed25519)[^/]*)(?:\/|$)/i.test(path) || /(?:^|\/)[^/]*(?:credentials|private-key)[^/]*$/i.test(path) || /\.(?:pem|key|p12|pfx)$/i.test(path)) stop('Credential or excluded source path. Nothing was changed.');
}
function sourceAllowed(path) {
  excludeCredentials(path);
  if (!/\.(?:md|json|mjs|js|ts|tsx|yaml|yml|toml|txt)$/.test(path) && !['go.mod', 'Gemfile'].includes(path)) stop('Source file type is outside the reviewed scope.');
}
export function inspectSources(root, paths) {
  if (!Array.isArray(paths) || paths.length > MAX_SOURCES || new Set(paths).size !== paths.length) stop('Choose at most ' + MAX_SOURCES + ' distinct reviewed sources.');
  // Validate every path before reading any source, so an excluded entry cannot trigger a partial scan.
  for (const path of paths) { sourceAllowed(path); resolveInside(root, path); }
  return paths.map(path => ({ path, hash: exactHash(readBytes(root, path)) }));
}
function contentBytes(content) {
  if (!Buffer.isBuffer(content) && typeof content !== 'string') stop('Provide the exact reviewed file content.');
  const bytes = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content, 'utf8');
  if (bytes.length > LIMIT) stop('Reviewed content exceeds the 256 KiB limit. Nothing was changed.');
  return bytes;
}
export function screenSecrets(...values) {
  // Conservative shape checks only: passing this check is not a guarantee of secrecy.
  const pattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-(?:proj-|live_)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b|\bBearer\s+[A-Za-z0-9._-]{20,}/i;
  if (values.some(value => value !== null && pattern.test(Buffer.isBuffer(value) ? value.toString('utf8') : String(value)))) stop('Secret-shaped content was detected. Remove private details before review or save; nothing was changed.');
}
function hashProposal(proposal) { const { review_hash, ...payload } = proposal; return exactHash(Buffer.from(JSON.stringify(payload))); }
export function reviewChange(root, { kind, target, content, dependencies = [] }) {
  targetAllowed(kind, target);
  const prior = readBytes(root, target), after = contentBytes(content);
  screenSecrets(prior, after);
  const sources = inspectSources(root, dependencies);
  const id = randomUUID();
  const proposal = { schema_version: 1, project_identity: projectIdentity(root), id, kind, target, before_hash: exactHash(prior), after_hash: exactHash(after), content_base64: after.toString('base64'),
    dependencies: sources, backup: '.vibepromptrig/backups/edits-' + id + '.json', lock: '.vibepromptrig/edits.lock' };
  // Check all metadata paths now, without creating them.
  resolveInside(root, proposal.backup); resolveInside(root, proposal.lock);
  proposal.review_hash = hashProposal(proposal);
  return proposal;
}
function validateProposal(root, p, reviewed) {
  exactKeys(p, ['schema_version', 'project_identity', 'id', 'kind', 'target', 'before_hash', 'after_hash', 'content_base64', 'dependencies', 'backup', 'lock', 'review_hash'], 'proposal');
  if (p.project_identity !== projectIdentity(root)) stop('This review belongs to a different project folder. Nothing was changed.');
  if (p.schema_version !== 1 || !/^[a-f0-9-]{36}$/.test(p.id || '') || !validHash(p.before_hash) || !/^[a-f0-9]{64}$/.test(p.after_hash || '') || p.backup !== '.vibepromptrig/backups/edits-' + p.id + '.json' || p.lock !== '.vibepromptrig/edits.lock') stop('Invalid reviewed proposal identity.');
  if (typeof p.content_base64 !== 'string' || p.content_base64.length > LIMIT * 1.34 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(p.content_base64)) stop('Invalid reviewed content.');
  const bytes = Buffer.from(p.content_base64, 'base64');
  if (bytes.length > LIMIT || bytes.toString('base64') !== p.content_base64 || exactHash(bytes) !== p.after_hash || reviewed !== p.review_hash || p.review_hash !== hashProposal(p)) stop('The proposal changed or its review hash does not match. Review it again.');
  targetAllowed(p.kind, p.target); resolveInside(root, p.target); resolveInside(root, p.backup); resolveInside(root, p.lock);
  if (!Array.isArray(p.dependencies) || p.dependencies.length > MAX_SOURCES || new Set(p.dependencies.map(d => d?.path)).size !== p.dependencies.length) stop('Invalid reviewed sources.');
  for (const dep of p.dependencies) { exactKeys(dep, ['path', 'hash'], 'source'); sourceAllowed(dep.path); if (!validHash(dep.hash)) stop('Invalid source hash.'); }
  return bytes;
}
function sourcesCurrent(root, proposal) {
  for (const dep of proposal.dependencies) if (exactHash(readBytes(root, dep.path)) !== dep.hash) stop('A reviewed source changed: ' + dep.path + '. Inspect the evidence again. Nothing was replaced.');
}
const LOCK_PATH = '.vibepromptrig/edits.lock';
const tempPath = (target, id) => (dirname(target) === '.' ? '' : dirname(target).replaceAll('\\', '/') + '/') + '.' + basename(target) + '.vpr-' + id + '.tmp';
function ownerState(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return 'unknown';
  try { process.kill(pid, 0); return 'live'; }
  catch (error) { return error.code === 'ESRCH' ? 'dead' : error.code === 'EPERM' ? 'live' : 'unknown'; }
}
export function reviewLockRecovery(root) {
  const bytes = readBytes(root, LOCK_PATH);
  if (bytes === null) stop('There is no interrupted edit lock to recover.');
  let record;
  try { record = parseProjectJson(bytes, LOCK_PATH); } catch { stop('Legacy or malformed lock has no verifiable owner. Preserve it for manual owner review.'); }
  exactKeys(record, ['pid', 'created_at', 'kind', 'target', 'id'], 'lock');
  targetAllowed(record.kind, record.target);
  return lockReview(root, record, bytes);
}
function lockReview(root, record, bytes) {
  if (!/^[a-f0-9-]{36}$/.test(record.id || '') || !Number.isFinite(Date.parse(record.created_at))) stop('Invalid interrupted writer identity.');
  const owner = ownerState(record.pid);
  const temp = tempPath(record.target, record.id), tempBytes = readBytes(root, temp);
  const review = { lock_hash: exactHash(bytes), owner_pid: record.pid, owner, age_ms: Math.max(0, Date.now() - Date.parse(record.created_at)), recoverable: owner === 'dead', temp, temp_hash: exactHash(tempBytes) };
  // Age is disclosed for review; a live or unverifiable owner is never removed based on age alone.
  review.recovery_hash = exactHash(Buffer.from(JSON.stringify({ project: projectIdentity(root), lock: review.lock_hash, temp, hash: review.temp_hash })));
  return review;
}
export function recoverLock(root, expected, approved = false) {
  if (approved !== true) stop('Explicit approval is required for the reviewed interrupted-writer recovery.');
  const review = reviewLockRecovery(root);
  if (!review.recoverable || review.recovery_hash !== expected) stop('Lock recovery refused: owner is live/unverified or recovery changed.');
  const bytes = readBytes(root, LOCK_PATH);
  if (exactHash(bytes) !== review.lock_hash || ownerState(review.owner_pid) !== 'dead') stop('Lock owner or bytes changed during recovery.');
  const recovery = resolveInside(root, '.vibepromptrig/backups/recovered-lock-' + randomUUID() + '.json');
  mkdirSync(dirname(recovery), { recursive: true });
  writeFileSync(recovery, bytes, { flag: 'wx', mode: 0o600 });
  if (exactHash(readBytes(root, review.temp)) !== review.temp_hash) stop('Interrupted temporary file changed. Preserve it for review.');
  if (review.temp_hash !== 'new') unlinkSync(resolveInside(root, review.temp));
  if (exactHash(readBytes(root, LOCK_PATH)) !== review.lock_hash) stop('Lock changed during recovery.');
  unlinkSync(resolveInside(root, LOCK_PATH));
  return { recovered: true, removed_temp: review.temp_hash !== 'new', lock_backup: recovery };
}
function withLock(root, callback, operation) {
  const directory = resolveInside(root, '.vibepromptrig'), lock = resolveInside(root, '.vibepromptrig/edits.lock');
  mkdirSync(directory, { recursive: true });
  try { writeFileSync(lock, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString(), kind: operation.kind, target: operation.target, id: operation.id }) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code === 'EEXIST') stop('Project edits are locked by another or interrupted session. Nothing was replaced.'); throw e; }
  try { return callback(); } finally { unlinkSync(lock); }
}
function replace(root, target, bytes, id, mode) {
  const destination = resolveInside(root, target);
  const tempRel = tempPath(target, id);
  const temp = resolveInside(root, tempRel);
  mkdirSync(dirname(destination), { recursive: true });
  resolveInside(root, target);
  try { writeFileSync(temp, bytes, { flag: 'wx', mode: mode ?? 0o600 }); resolveInside(root, target); renameSync(temp, destination); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}
export function applyChange(root, proposal, reviewed, approved = false) {
  if (approved !== true) stop('Explicit user approval is required for this exact reviewed save. Nothing was changed.');
  const bytes = validateProposal(root, proposal, reviewed);
  screenSecrets(bytes, readBytes(root, proposal.target));
  sourcesCurrent(root, proposal);
  let prior = readBytes(root, proposal.target), current = exactHash(prior);
  if (current === proposal.after_hash) return { written: false, target: proposal.target, etag: current, backup: null, undo_hash: null };
  if (current !== proposal.before_hash) stop('The target changed since review. Nothing was replaced.');
  return withLock(root, () => {
    sourcesCurrent(root, proposal);
    prior = readBytes(root, proposal.target);
    if (exactHash(prior) !== proposal.before_hash) stop('The target changed during review. Nothing was replaced.');
    const mode = prior === null ? null : lstatSync(resolveInside(root, proposal.target)).mode & 0o777;
    mkdirSync(resolveInside(root, '.vibepromptrig/backups'), { recursive: true });
    // This pre-recorded postimage protects recovery even if the process dies before a completion log.
    const backup = { schema_version: 1, project_identity: proposal.project_identity, target: proposal.target, kind: proposal.kind, before_hash: proposal.before_hash, before_base64: prior?.toString('base64') ?? null, after_hash: proposal.after_hash, mode };
    const backupBytes = Buffer.from(JSON.stringify(backup) + '\n');
    writeFileSync(resolveInside(root, proposal.backup), backupBytes, { flag: 'wx', mode: 0o600 });
    sourcesCurrent(root, proposal);
    if (exactHash(readBytes(root, proposal.target)) !== proposal.before_hash) stop('The target changed during save. Review the backup; nothing was replaced.');
    replace(root, proposal.target, bytes, proposal.id, mode);
    return { written: true, target: proposal.target, etag: proposal.after_hash, backup: proposal.backup, undo_hash: undoIdentity(root, proposal.backup, backupBytes) };
  }, proposal);
}
function backupRecord(root, backupPath) {
  if (!/^\.vibepromptrig\/backups\/edits-[a-f0-9-]{36}\.json$/.test(backupPath || '')) stop('Choose this project edit backup path.');
  const disk = resolveInside(root, backupPath);
  let backupBytes;
  try { const stat = lstatSync(disk); if (!stat.isFile() || stat.size > LIMIT * 2) stop('Backup is too large or not a regular file.'); backupBytes = readFileSync(disk); }
  catch (e) { if (e.code) throw new ProjectJsonError(backupPath); throw e; }
  return { data: parseProjectJson(backupBytes, backupPath), bytes: backupBytes };
}
export function readEditBackup(root, backupPath) { return backupRecord(root, backupPath).data; }
function validateBackup(root, data) {
  exactKeys(data, ['schema_version', 'project_identity', 'target', 'kind', 'before_hash', 'before_base64', 'after_hash', 'mode'], 'backup');
  targetAllowed(data.kind, data.target); resolveInside(root, data.target);
  if (data.project_identity !== projectIdentity(root) && !(process.platform === 'win32' && data.project_identity === legacyProjectIdentity(root))) stop('Backup belongs to a different project folder.');
  if (data.schema_version !== 1 || !/^[a-f0-9]{64}$/.test(data.after_hash || '') || !validHash(data.before_hash) || (data.mode !== null && (!Number.isInteger(data.mode) || data.mode < 0 || data.mode > 0o777))) stop('Backup does not match the reviewed target.');
  let before = null;
  if (data.before_base64 !== null) {
    if (typeof data.before_base64 !== 'string' || data.before_base64.length > LIMIT * 1.34 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.before_base64)) stop('Invalid backup bytes.');
    before = Buffer.from(data.before_base64, 'base64');
    if (before.length > LIMIT || before.toString('base64') !== data.before_base64) stop('Invalid backup bytes.');
  }
  if (exactHash(before) !== data.before_hash) stop('Backup preimage hash is incorrect. Nothing was changed.');
  return before;
}
export function reviewUndo(root, backupPath) {
  const { data, bytes } = backupRecord(root, backupPath);
  validateBackup(root, data);
  return { target: data.target, kind: data.kind, project_identity: data.project_identity, after_hash: data.after_hash, backup_hash: exactHash(bytes), undo_hash: undoIdentity(root, backupPath, bytes, data.project_identity) };
}
export function undoChange(root, backupPath, expected, approved = false) {
  if (approved !== true) stop('Explicit approval is required for this exact undo. Nothing was changed.');
  const { data, bytes } = backupRecord(root, backupPath);
  validateBackup(root, data);
  if (expected !== undoIdentity(root, backupPath, bytes, data.project_identity)) stop('The backup changed or its undo review does not match. Review the exact backup again. Nothing was changed.');
  const before = validateBackup(root, data);
  const current = exactHash(readBytes(root, data.target));
  if (current === data.before_hash) return { restored: false, target: data.target, etag: current };
  if (current !== data.after_hash) stop('Undo refused: the target changed after save. Keep the later edits.');
  const id = randomUUID();
  return withLock(root, () => {
    if (undoIdentity(root, backupPath, backupRecord(root, backupPath).bytes, data.project_identity) !== expected) stop('Backup changed during undo. Review it again.');
    if (exactHash(readBytes(root, data.target)) !== data.after_hash) stop('Undo refused: later edits changed the target.');
    if (before === null) unlinkSync(resolveInside(root, data.target));
    else replace(root, data.target, before, id, data.mode);
    return { restored: true, target: data.target, etag: data.before_hash };
  }, { kind: data.kind, target: data.target, id });
}
export function main(args, root = process.cwd(), input) {
  if (args[0] === 'review-lock' && args.length === 1) return JSON.stringify(reviewLockRecovery(root), null, 2) + '\n';
  if (args[0] === 'recover-lock' && args.length === 3 && args[2] === '--approved') return JSON.stringify(recoverLock(root, args[1], true), null, 2) + '\n';
  if (args[0] === 'review-undo' && args.length === 2) return JSON.stringify(reviewUndo(root, args[1]), null, 2) + '\n';
  if (args[0] === 'undo' && args.length === 4 && args[3] === '--approved') return JSON.stringify(undoChange(root, args[1], args[2], true), null, 2) + '\n';
  stop('Use a feature-specific validated save; generic apply is unavailable. Use review-undo <backup-path>, or undo <backup-path> <undo-hash> --approved. Native approval is still required.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const chunks = []; let size = 0;
    if (!process.stdin.isTTY && process.argv[2] === 'apply') for await (const chunk of process.stdin) { size += chunk.length; if (size > LIMIT * 2) stop('Reviewed proposal exceeds its size limit.'); chunks.push(chunk); }
    process.stdout.write(main(process.argv.slice(2), process.cwd(), chunks.length ? Buffer.concat(chunks) : undefined));
  } catch (e) { process.stderr.write('The reviewed change could not continue: ' + (e.code ? 'A project file could not be read or written. Review the target and recovery record before retrying.' : e.message) + '\n'); process.exitCode = 1; }
}
