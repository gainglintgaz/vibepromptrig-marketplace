#!/usr/bin/env node
// One local goal/findings record. No network, command execution from documents or installations.
// safe-write owns template installation; user-owned findings need expected hashes, locking and atomic replacement.
import { existsSync, chmodSync, lstatSync, realpathSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import { execFileSync } from 'node:child_process';
import { parseProjectJson, ProjectJsonError } from './project-json.mjs';

const LIMIT = 256 * 1024;
const RECORD = '.vibepromptrig/checkup.json';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
const goalKeys = ['outcome', 'stage', 'acceptance', 'constraints', 'confirmed', 'unknown', 'project_kind'];
const reportKeys = ['schema_version', 'revision', 'goal', 'observations', 'recommendations', 'decisions', 'next_action', 'source', 'observed_at', 'runtime_evidence', 'cost'];
const text = (v, label) => { if (typeof v !== 'string' || !v.trim() || v.length > 4000) fail('Invalid ' + label + ': use a short plain-language summary.'); };
function object(v, keys, label) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(v, k))) fail('Invalid ' + label + ' fields.');
}
function list(v, label) { if (!Array.isArray(v) || v.length > 100) fail('Invalid ' + label + ' list.'); v.forEach(x => text(x, label)); }
function goal(v) {
  object(v, goalKeys, 'goal'); text(v.outcome, 'goal');
  if (!['idea', 'notes', 'partly-working', 'existing', 'unsure'].includes(v.stage)) fail('Choose a listed project stage or unsure.');
  if (!['physical', 'software', 'research', 'service', 'content', 'mixed', 'unsure', 'tools-only'].includes(v.project_kind)) fail('Choose a listed project kind or unsure.');
  for (const k of ['acceptance', 'constraints', 'confirmed', 'unknown']) list(v[k], k);
  if (v.confirmed.some(k => v.unknown.includes(k))) fail('Some answers are both confirmed and unknown. Ask the user to resolve them before saving.');
}
function validate(v) {
  object(v, reportKeys, 'findings'); goal(v.goal);
  if (v.schema_version !== 1 || !Number.isSafeInteger(v.revision) || v.revision < 0) fail('Unsupported findings version.');
  text(v.next_action, 'next action'); list(v.decisions, 'decisions'); list(v.runtime_evidence, 'runtime evidence');
  if (!Number.isFinite(Date.parse(v.observed_at))) fail('Invalid observation date.');
  object(v.source, ['revision', 'fingerprint', 'dirty_fingerprint', 'scope'], 'source');
  if (v.source.revision !== null && !/^[a-f0-9]{40,64}$/.test(v.source.revision)) fail('Invalid source revision.');
  for (const k of ['fingerprint', 'dirty_fingerprint']) if (!/^[a-f0-9]{64}$/.test(v.source[k])) fail('Invalid source fingerprint.');
  list(v.source.scope, 'source scope');
  object(v.cost, ['status', 'reason'], 'cost');
  if (v.cost.status !== 'UNKNOWN') fail('This offline checkup cannot establish CI cost.'); text(v.cost.reason, 'cost reason');
  if (!Array.isArray(v.observations) || v.observations.length > 200) fail('Too many observations.');
  for (const o of v.observations) {
    object(o, ['claim', 'location', 'evidence', 'status', 'reason', 'severity'], 'observation');
    for (const k of ['claim', 'location', 'reason']) text(o[k], k);
    list(o.evidence, 'evidence');
    if (!['VERIFIED', 'WRONG', 'UNVERIFIED'].includes(o.status) || !['info', 'warning'].includes(o.severity)) fail('Invalid observation status.');
  }
  if (!Array.isArray(v.recommendations) || v.recommendations.length > 30) fail('Too many recommendations.');
  for (const r of v.recommendations) {
    object(r, ['name', 'requirement', 'rationale', 'alternative', 'availability', 'cost', 'sources', 'checked_at', 'first_use_check'], 'recommendation');
    for (const k of ['name', 'requirement', 'rationale', 'alternative', 'availability', 'cost', 'first_use_check']) text(r[k], k);
    list(r.sources, 'sources');
    if (r.checked_at !== null && !Number.isFinite(Date.parse(r.checked_at))) fail('Invalid recommendation date.');
  }
  if (Buffer.byteLength(JSON.stringify(v)) > LIMIT) fail('Keep findings under 256 KiB. Do not store transcripts or secrets.');
}
function inside(root, rel) {
  const base = realpathSync(root), target = resolve(base, rel), delta = relative(base, target);
  if (delta === '..' || delta.startsWith('..\\') || delta.startsWith('../') || isAbsolute(delta)) fail('Path is outside this project. Nothing was changed.');
  let current = base;
  for (const part of delta.split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) fail('Linked files and folders are excluded. Nothing was changed.'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return target;
}
function bounded(path, label, limit = LIMIT) {
  try { const stat = lstatSync(path); if (!stat.isFile() || stat.size > limit) throw new Error(); return readFileSync(path); }
  catch { throw new ProjectJsonError(label); }
}
function decodeText(bytes, label) {
  let encoding = 'utf-8', offset = 0;
  if (bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) offset = 3;
  else if (bytes[0] === 255 && bytes[1] === 254) { encoding = 'utf-16le'; offset = 2; }
  else if (bytes[0] === 254 && bytes[1] === 255) { encoding = 'utf-16be'; offset = 2; }
  try { return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(offset)); }
  catch { throw new ProjectJsonError(label); }
}
function snapshot(root) {
  const scope = ['package.json', 'README.md', 'CLAUDE.md', 'AGENTS.md', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'Gemfile'];
  const dir = inside(root, '.github/workflows');
  if (existsSync(dir)) {
    const names = readdirSync(dir).filter(n => /^[\w.-]+\.ya?ml$/.test(n)).sort();
    if (names.length > 30) fail('Too many workflows for this bounded checkup. Ask for a smaller reviewed scope.');
    scope.push(...names.map(n => '.github/workflows/' + n));
  }
  const files = new Map();
  for (const name of scope) {
    const path = inside(root, name);
    if (existsSync(path)) files.set(name, bounded(path, name));
  }
  // Include existence and exact bytes of followed literal script claims in freshness identity.
  // No recursive scan: at most fifty relative script files explicitly named in the three documents.
  const references = new Set();
  for (const name of ['README.md', 'CLAUDE.md', 'AGENTS.md']) for (const m of (files.has(name) ? decodeText(files.get(name), name) : '').matchAll(/\bnode\s+["']?((?:[\w.-]+\/)+[\w.-]+\.m?js)\b/g)) {
    if (!m[1].includes('..') && !/(?:^|\/)(?:node_modules|\.git|\.env)/.test(m[1])) references.add(m[1]);
  }
  if (references.size > 50) fail('Too many literal script claims for this bounded checkup.');
  const referenceIdentity = [...references].sort().map(name => {
    const path = inside(root, name);
    return [name, existsSync(path) ? hash(bounded(path, name)) : null];
  });
  scope.push(...[...references].filter(name => !scope.includes(name)).sort());
  let revision = null, dirty = 'no-git';
  // Git metadata only. Never execute a command copied from project files; ignore repository-selecting environment overrides.
  if (existsSync(join(realpathSync(root), '.git'))) {
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k))), GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' };
    try {
      const options = { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: LIMIT, windowsHide: true };
      revision = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], options).trim();
      dirty = execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', 'status', '--porcelain', '--untracked-files=no', '--', '.', ':(exclude).vibepromptrig'], options);
    } catch { revision = null; dirty = 'git-unavailable'; }
  }
  const identity = [...files].map(([name, bytes]) => [name, hash(bytes)]);
  return { files, source: { revision, fingerprint: hash(JSON.stringify({ identity, referenceIdentity, revision, dirty })), dirty_fingerprint: hash(dirty), scope } };
}
export const emptyGoal = () => ({ outcome: 'Not confirmed yet', stage: 'unsure', acceptance: [], constraints: [], confirmed: [], unknown: ['outcome', 'first useful result', 'limits'], project_kind: 'unsure' });
export function renderGoalQuestions() {
  return `Let's start with what you want to achieve. You can say "I'm not sure" to any question.
1. What do you want to make, improve, or achieve?
   Describe it in your own words. Physical products, research, services, writing and software all fit.
2. What do you already have?
   An idea / notes or designs / something partly working / an existing project / I'm not sure.
3. What would be a useful first result?
   For example, a clearer plan, a design to review, a working sample, or an explanation of a problem.
4. What limits should we work within?
   Tell me any relevant budget, time, equipment, experience or private-information limits. Unknown is fine.
5. I'll summarize the goal and suggest one next step. What should I correct?
You can also choose "Only help me configure my tools". No tool, agent team or software framework is required.
I will reuse answers you have already confirmed. Nothing is saved, installed or connected by these questions.
If you want to save a short summary later, I will show the exact record, backup and undo paths first.
`;
}
export function inspectProject(root, input = emptyGoal()) {
  goal(input);
  const { files, source } = snapshot(root), observations = [];
  let pkg = {};
  if (files.has('package.json')) {
    pkg = parseProjectJson(files.get('package.json'), 'package.json');
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new ProjectJsonError('package.json');
  }
  const add = (claim, location, status, reason, evidence = []) => {
    if (observations.length >= 200) fail('Too many claims for this bounded checkup. Ask for a smaller reviewed scope.');
    observations.push({ claim, location, status, reason, evidence, severity: status === 'WRONG' ? 'warning' : 'info' });
  };
  for (const name of ['README.md', 'CLAUDE.md', 'AGENTS.md']) {
    if (!files.has(name)) continue;
    const lines = decodeText(files.get(name), name).split(/\r?\n/);
    lines.forEach((line, i) => {
      const location = name + ':' + (i + 1);
      for (const match of line.matchAll(/\b(?:npm|pnpm|yarn) run ([\w:-]+)/g)) {
        const declared = Object.hasOwn(pkg.scripts || {}, match[1]);
        add(match[0], location, declared ? 'VERIFIED' : 'WRONG', declared ? 'Declared in package.json; it was not run and no passing result is claimed.' : 'No matching script is declared in package.json.', ['package.json:scripts.' + match[1]]);
      }
      for (const match of line.matchAll(/\bnode\s+["']?((?:[\w.-]+\/)+[\w.-]+\.m?js)\b/g)) {
        const rel = match[1];
        if (rel.includes('..') || /(?:^|\/)(?:node_modules|\.git|\.env)/.test(rel)) { add('node [excluded path]', location, 'UNVERIFIED', 'This path is outside the read-only audit scope.'); continue; }
        const present = existsSync(inside(root, rel));
        add('node ' + rel, location, present ? 'VERIFIED' : 'WRONG', present ? 'The literal script path exists; it was not executed.' : 'The literal script path is missing.', [rel]);
      }
      for (const match of line.matchAll(/\bPR\s+#(\d+)\s+(?:is\s+)?(merged|open|closed)/gi)) add('PR #' + match[1] + ' ' + match[2], location, 'UNVERIFIED', 'Offline checkup did not read GitHub. A document is not live merge evidence.');
      if (/\b(?:node\s+-e|python\s+-c|node\s+["']?\$)/.test(line)) add('Computed or inline command', location, 'UNVERIFIED', 'Dynamic commands are not followed or executed by checkup.');
    });
  }
  return { schema_version: 1, revision: 0, goal: structuredClone(input), observations, recommendations: [], decisions: [],
    next_action: 'Confirm the goal and first useful result with the user; choose one relevant next step.', source, observed_at: new Date().toISOString(), runtime_evidence: [],
    cost: { status: 'UNKNOWN', reason: 'No jobs API durations were requested. Workflow files alone do not establish spend.' } };
}
function readRaw(root) {
  const path = inside(root, RECORD);
  if (!existsSync(path)) return { state: null, etag: 'new', bytes: null };
  const bytes = bounded(path, RECORD), state = parseProjectJson(bytes, RECORD);
  validate(state);
  if (state.revision < 1) fail('Saved findings have no revision. Preserve the file for review.');
  return { state, etag: hash(bytes), bytes };
}
export function readCheckup(root) {
  const { state, etag } = readRaw(root);
  const inspected = state ? inspectProject(root, state.goal) : null;
  const scoped_fresh = state ? isDeepStrictEqual(state.source, inspected.source) && isDeepStrictEqual(state.observations, inspected.observations) : null;
  // This helper does not run tests or bind third-party runtime outcomes to all of their inputs.
  return { state, etag, scoped_fresh, fresh: state ? scoped_fresh && !state.runtime_evidence.length : null,
    runtime_evidence_freshness: state?.runtime_evidence.length ? 'UNVERIFIED' : 'not_run' };
}
function approval(approved, expected) {
  if (approved !== true) fail('Explicit approval is required for this reviewed save or undo. Nothing was changed.');
  if (expected !== 'new' && !/^[a-f0-9]{64}$/.test(expected || '')) fail('Read the current record and provide its expected hash.');
}
function locked(root, fn) {
  mkdirSync(inside(root, '.vibepromptrig'), { recursive: true });
  const lock = inside(root, '.vibepromptrig/checkup.lock');
  try { writeFileSync(lock, 'A reviewed findings write is in progress.\n', { flag: 'wx' }); }
  catch (e) { if (e.code === 'EEXIST') fail('Findings are locked. Review the active or interrupted writer before trying again.'); throw e; }
  try { return fn(); } finally { unlinkSync(lock); }
}
function replace(root, bytes) {
  const temp = inside(root, '.vibepromptrig/checkup-' + randomUUID() + '.tmp');
  const target = inside(root, RECORD);
  const mode = existsSync(target) ? lstatSync(target).mode & 0o777 : 0o600;
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode });
    if (process.platform !== 'win32') chmodSync(temp, mode);
    renameSync(temp, target);
  }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}
export function saveCheckup(root, input, expected, approved = false) {
  approval(approved, expected);
  const state = structuredClone(input), prior = readRaw(root);
  object(state, reportKeys, 'findings'); goal(state.goal);
  if (prior.etag !== expected) fail('Findings changed since review. Read and reconcile before saving.');
  // A changed goal clears dependent acceptance/recommendations before validation, never file observations.
  if (prior.state && !isDeepStrictEqual(state.goal, prior.state.goal)) {
    if (['outcome', 'constraints', 'project_kind'].some(k => JSON.stringify(state.goal[k]) !== JSON.stringify(prior.state.goal[k]))) state.goal.acceptance = [];
    state.recommendations = []; state.runtime_evidence = []; state.decisions = [];
    state.next_action = 'Confirm acceptance and recommendations for the changed goal before taking another action.';
  }
  validate(state);
  state.revision = (prior.state?.revision || 0) + 1;
  const bytes = Buffer.from(JSON.stringify(state, null, 2) + '\n'), etag = hash(bytes);
  if (bytes.length > LIMIT) fail('Keep serialized findings under 256 KiB. Nothing was changed.');
  const assertInspection = () => {
    const inspected = inspectProject(root, state.goal);
    if (state.source.fingerprint !== inspected.source.fingerprint) fail('Project files changed since this checkup. Inspect them again before saving.');
    if (!isDeepStrictEqual(state.source, inspected.source) || !isDeepStrictEqual(state.observations, inspected.observations)) fail('Inspection source metadata or observations changed. Inspect again; caller-authored evidence cannot be saved.');
  };
  assertInspection();
  return locked(root, () => {
    if (readRaw(root).etag !== expected) fail('Findings changed since review. Read and reconcile before saving.');
    assertInspection();
    const backup = '.vibepromptrig/backups/' + randomUUID() + '.json';
    mkdirSync(inside(root, '.vibepromptrig/backups'), { recursive: true });
    // Recovery metadata is durable before replacement; postimage guards also apply to interrupted saves.
    writeFileSync(inside(root, backup), JSON.stringify({ schema_version: 1, before: prior.bytes?.toString('base64') ?? null, after: etag }) + '\n', { flag: 'wx', mode: 0o600 });
    if (readRaw(root).etag !== expected) fail('Findings changed during save. Original retained; review the backup.');
    assertInspection();
    replace(root, bytes);
    return { state, etag, backup, written: true };
  });
}
export function restoreCheckup(root, backup, expected, approved = false) {
  approval(approved, expected);
  if (!/^\.vibepromptrig\/backups\/[a-f0-9-]{36}\.json$/.test(backup)) fail('Choose a findings backup from this project.');
  // Base64 preimages expand by 4/3; this recovery envelope has a separate bounded size.
  const data = parseProjectJson(bounded(inside(root, backup), backup, LIMIT * 2), backup);
  object(data, ['schema_version', 'before', 'after'], 'backup');
  if (data.schema_version !== 1 || data.after !== expected || (data.before !== null && (typeof data.before !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.before)))) fail('Backup does not match the reviewed record.');
  const bytes = data.before === null ? null : Buffer.from(data.before, 'base64');
  if (bytes && bytes.length > LIMIT) fail('Backup preimage exceeds the findings limit. Preserve it for review.');
  if (bytes) validate(parseProjectJson(bytes, RECORD));
  if (readRaw(root).etag !== expected) fail('Findings changed since review. Undo would overwrite later edits.');
  return locked(root, () => {
    if (readRaw(root).etag !== expected) fail('Findings changed since review. Undo refused.');
    if (bytes) replace(root, bytes); else unlinkSync(inside(root, RECORD));
    return { restored: true, path: RECORD, etag: bytes ? hash(bytes) : 'new' };
  });
}
export function main(args, root = process.cwd(), input) {
  const [action, ...rest] = args;
  if (action === 'questions' && !rest.length) return renderGoalQuestions();
  if (action === 'template' && !rest.length) return JSON.stringify(inspectProject(root), null, 2) + '\n';
  if (action === 'inspect' && !rest.length) return JSON.stringify(inspectProject(root, input ? parseProjectJson(input, 'reviewed goal input') : readCheckup(root).state?.goal || emptyGoal()), null, 2) + '\n';
  if (action === 'read' && !rest.length) return JSON.stringify(readCheckup(root), null, 2) + '\n';
  if (action === 'save' && rest.length === 2 && rest[1] === '--approved' && input) return JSON.stringify(saveCheckup(root, parseProjectJson(input, 'reviewed findings input'), rest[0], true), null, 2) + '\n';
  if (action === 'undo' && rest.length === 3 && rest[2] === '--approved') return JSON.stringify(restoreCheckup(root, rest[0], rest[1], true), null, 2) + '\n';
  fail('Use questions, template, inspect (optional goal JSON on stdin), read, save <reviewed-hash> --approved (findings JSON on stdin), or undo <backup> <reviewed-hash> --approved.');
}
// Resolve both identities so linked launch paths execute the CLI; unresolved entries stay imports.
const isMain = () => { try { return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (process.argv[1] && isMain()) {
  try {
    const chunks = []; let size = 0;
    if (!process.stdin.isTTY && ['inspect', 'save'].includes(process.argv[2])) for await (const chunk of process.stdin) {
      size += chunk.length; if (size > LIMIT) fail('Keep the reviewed summary under 256 KiB.'); chunks.push(chunk);
    }
    process.stdout.write(main(process.argv.slice(2), process.cwd(), chunks.length ? Buffer.concat(chunks) : undefined));
  } catch (e) {
    process.stderr.write('Checkup could not continue: ' + (e.code ? 'The project file operation failed. Nothing else was changed; review the named project and its recovery files.' : e.message) + '\n');
    process.exitCode = 1;
  }
}
