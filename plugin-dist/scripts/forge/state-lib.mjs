// state-lib.mjs -- coord-state/1 library behind `forge state` (VF-T14).
// Justified: "receipt" here means a completion-receipt v3 evidence manifest for task state, not OCR of purchase receipts; no MCP server or Skill manages coord-state/1 task queues, leases or evidence gates.
// Spec: docs/architecture/coordination-layer-v1.md sections 0.2 and 2.1-2.2, plus the
// HH-ORCH-03 card additions (task `add` with lane ownership, six evidence slots).
// Dependency-free Node >= 18. Every mutation goes through mutate(): one exclusive lockfile,
// read, validate, change, re-validate, atomic tmp+rename write, one coord.* event.
//
// What this protects: two writers can never interleave a STATE.json update, a task can never be
// claimed twice, and a stage can never move without the evidence the rules require.
// What it does NOT protect: a person or agent editing STATE.json by hand. The integrity hash is
// unkeyed (decision F8); `validate` reports a mismatch but cannot prove who made it.

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, lstatSync, fstatSync, fsyncSync, rmdirSync, constants, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { inspectRoot } from './portfolio-policy.mjs';
import { processStartMs, processLiveness as nativeLiveness } from './dispatch-lib.mjs';

export const SCHEMA = 'coord-state/1';
export const WRITER = 'forge state 1.0.0';
export const TASK_STAGES = Object.freeze(['queued', 'ready', 'active', 'blocked', 'review', 'done', 'parked']);
export const EVIDENCE_SLOTS = Object.freeze(['implemented', 'reviewed', 'ciPassed', 'merged', 'deployed', 'liveVerified']);
// Actions a worker can never be granted by any task, lane or authorization file. Code, not config.
export const NEVER_GRANTABLE = Object.freeze([
  'push-default-branch', 'merge', 'deploy', 'hosted-db-write', 'secret-access', 'spend',
  'ownership-change', 'schedule-register',
]);
export const LOCK_STALE_MS = 25 * 60_000; // F5: exclusive wx lockfile, stale after 25 min
export const LEASE_DEFAULT_MIN = 25; // F13: heartbeat-stale (15) + grace (10)
export const LEASE_MAX_MIN = 240;
export const PACK_BUDGET_BYTES = 32 * 1024; // Codex reads only the first 32 KiB of a file

const here = dirname(fileURLToPath(import.meta.url));
const SETTABLE = new Set(['title', 'note', 'acceptance', 'priority', 'timeboxMin', 'needsEnv']);
const SECRET_PATTERNS = [
  /sbp_[A-Za-z0-9]{20,}/, /sk-ant-[A-Za-z0-9_-]{10,}/, /sk-proj-[A-Za-z0-9_-]{10,}/, /\bsk-[A-Za-z0-9]{32,}/,
  /AKIA[A-Z0-9]{16}/, /eyJhbGciOiJ[A-Za-z0-9_-]{10,}/, /gh[pousr]_[A-Za-z0-9]{30,}/, /xox[baprs]-[A-Za-z0-9-]{10,}/,
];
const ENV_PATH = /(^|[\\/])\.env(\.[^\\/]*)?$|(^|[\\/])[^\\/]*\.env$/i;

export class StateError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
const fail = (code, message, details) => { throw new StateError(code, message, details); };
// Finding 17: a timebox is a positive, finite number of minutes, at most the longest lease.
export function validTimebox(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= LEASE_MAX_MIN ? n : null;
}

// ---------------------------------------------------------------------------- paths
// F7/F16: stored worktree paths never carry the operator's absolute home path. A path under
// VF_WORKTREES_ROOT becomes `<WORKTREES_ROOT>/...`; one under the home folder becomes `<HOME>/...`.
const fwd = (p) => String(p).replace(/\\/g, '/');
function tokenRoots() {
  const roots = [];
  if (process.env.VF_WORKTREES_ROOT) roots.push(['<WORKTREES_ROOT>', fwd(resolve(process.env.VF_WORKTREES_ROOT))]);
  roots.push(['<HOME>', fwd(resolve(homedir()))]);
  return roots;
}
export function tokenizePath(p) {
  const full = fwd(resolve(String(p)));
  for (const [token, root] of tokenRoots()) {
    if (full.toLowerCase() === root.toLowerCase()) return token;
    if (full.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return `${token}${full.slice(root.length)}`;
  }
  return full;
}
export function expandPath(p) {
  const s = String(p);
  for (const [token, root] of tokenRoots()) if (s === token || s.startsWith(`${token}/`)) return `${root}${s.slice(token.length)}`;
  return s;
}
export function pathKey(p) {
  // Filesystem identity: realpath when it exists, forward slashes, lowercase (Windows/macOS
  // default filesystems are case-insensitive). Mirrors worktree-retire.mjs.
  let full = resolve(expandPath(p));
  try { full = realpathSync.native(full); } catch { /* missing path: compare the resolved spelling */ }
  return full.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
// .env.example* holds placeholders only and stays readable (secrets-handling.md section 2.1).
export function isEnvPath(p) {
  const s = String(p).trim();
  if (/(^|[\\/])\.env\.example([.\\/]|$)/i.test(s)) return false;
  return ENV_PATH.test(s);
}
export function containsSecret(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return SECRET_PATTERNS.some((re) => re.test(text));
}

// Minimal glob matcher for owned-path overlap: '**' any depth, '*' within one segment.
function globToRegex(glob) {
  const g = String(glob).replace(/\\/g, '/').replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += '.*'; i += 1; if (g[i + 1] === '/') i += 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}
const literalPrefix = (glob) => String(glob).replace(/\\/g, '/').replace(/^\.\//, '').split(/[*?]/)[0].toLowerCase();
export function globsOverlap(a, b) {
  // Conservative: overlap if either literal prefix is a prefix of the other, or one matches the other.
  const pa = literalPrefix(a), pb = literalPrefix(b);
  if (pa.startsWith(pb) || pb.startsWith(pa)) return true;
  return globToRegex(a).test(String(b)) || globToRegex(b).test(String(a));
}
// Paths must be repository-relative, forward-slash, with no '..' or empty segments (review P1).
export function safeRelPath(p) {
  const s = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!s || s.startsWith('/') || /^[A-Za-z]:/.test(s)) return false;
  return s.split('/').every((seg) => seg !== '..' && seg !== '' && seg !== '.');
}
const hasWildcard = (g) => /[*?]/.test(String(g));
// A task path (or glob) is contained by a lane glob only when every path it can match is also
// matched by the lane glob: a literal path must match the lane regex; a glob must equal the lane
// glob or sit under a lane glob of the form '<dir>/**' (review P1: prefix sharing is not containment).
function insideGlob(p, g) {
  const task = String(p).replace(/\\/g, '/').replace(/^\.\//, ''), lane = String(g).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!safeRelPath(task) || !safeRelPath(lane)) return false;
  if (!hasWildcard(task)) return globToRegex(lane).test(task);
  if (task.toLowerCase() === lane.toLowerCase()) return true;
  if (lane === '**') return true;
  if (lane.endsWith('/**') && !hasWildcard(lane.slice(0, -3))) return task.toLowerCase().startsWith(lane.slice(0, -2).toLowerCase());
  return false;
}
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export function pathOwnedBy(file, globs) { return (globs || []).some((g) => globToRegex(g).test(String(file).replace(/\\/g, '/'))); }

// ---------------------------------------------------------------------------- read / validate
export function statePath(root) { return join(root, 'STATE.json'); }

export function canonicalBody(state) {
  const { integrity, ...rest } = state;
  return JSON.stringify(rest);
}
export function bodyHash(state) { return createHash('sha256').update(canonicalBody(state)).digest('hex'); }

export function readState(root) {
  const p = statePath(root);
  if (!existsSync(p)) fail('NO_STATE', `STATE.json not found at ${p}; run \`forge state init\` or pass --root`);
  safeStateRoot(root);safeStateFile(p);
  let state;
  try { state = JSON.parse(readOwned(p).raw.replace(/^﻿/, '')); }
  catch (e) { fail('BAD_JSON', `STATE.json is not valid JSON: ${e.message}`); }
  return state;
}

export function validateState(state, { now = Date.now() } = {}) {
  const errors = [], warnings = [];
  if (!state || typeof state !== 'object') return { errors: ['state must be an object'], warnings };
  if (state.version !== SCHEMA) errors.push(`version must be ${SCHEMA}`);
  if (typeof state.project !== 'string' || !state.project) errors.push('project is required');
  if (typeof state.paused !== 'boolean') errors.push('paused must be a boolean');
  if (!Array.isArray(state.tasks)) errors.push('tasks must be an array');
  if (state.lanes !== undefined && (typeof state.lanes !== 'object' || state.lanes === null || Array.isArray(state.lanes))) errors.push('lanes must be an object');
  const ids = new Set();
  for (const t of state.tasks || []) {
    const label = `task ${t?.id ?? '(no id)'}`;
    if (!t?.id || typeof t.id !== 'string') { errors.push(`${label}: id required`); continue; }
    if (ids.has(t.id)) errors.push(`${label}: duplicate id`);
    if (!TASK_ID.test(t.id)) errors.push(`${label}: id is not a safe file name`);
    for (const p of t.paths || []) if (!safeRelPath(p)) errors.push(`${label}: owned path ${p} is not repository-relative`);
    ids.add(t.id);
    if (!TASK_STAGES.includes(t.stage)) errors.push(`${label}: stage ${t.stage} not in ${TASK_STAGES.join('|')}`);
    if (t.stage === 'active' && !t.lease) errors.push(`${label}: active requires a lease`);
    if (t.lease) {
      if (!t.lease.by || !t.lease.worktree || !Number.isFinite(Date.parse(t.lease.until))) errors.push(`${label}: lease needs by, worktree and until`);
      else if (Date.parse(t.lease.until) <= now) warnings.push(`${label}: lease expired at ${t.lease.until}`);
    }
    for (const p of t.paths || []) if (isEnvPath(p)) errors.push(`${label}: owned path ${p} is an env file`);
    if (t.evidence) for (const k of Object.keys(t.evidence)) if (!EVIDENCE_SLOTS.includes(k)) errors.push(`${label}: unknown evidence slot ${k}`);
    for (const a of t.workerActions || []) if (NEVER_GRANTABLE.includes(a)) errors.push(`${label}: workerActions contains never-grantable ${a}`);
  }
  for (const t of state.tasks || []) for (const d of t?.dependsOn || []) if (!ids.has(d)) warnings.push(`task ${t.id}: depends on unknown task ${d}`);
  if (containsSecret(state)) errors.push('STATE.json contains a secret-shaped value');
  const integ = state.integrity || {};
  if (integ.writer === 'manual-bootstrap') warnings.push('integrity.writer is manual-bootstrap; adopt once with `forge state validate --adopt` (F8)');
  else if (integ.sha256 && integ.sha256 !== bodyHash(state)) warnings.push('body changed since the last `forge state` write (unkeyed hash: shows a change, cannot show who made it)');
  return { errors, warnings };
}

// ---------------------------------------------------------------------------- locked atomic write
function lockPath(root) { return join(root, '.forge', 'state.lock'); }


const stateIdentity=s=>String(s.dev)+':'+String(s.ino);
function safeStateRoot(root){const r=inspectRoot(resolve(root));if(r.reason)fail('UNSAFE_STATE_PATH','state root or ancestor is unsafe');return r.canonical;}
function safeStateFile(p,absent=false){let s;try{s=lstatSync(p);}catch(e){if(absent&&e.code==='ENOENT')return null;throw e;}if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>8*1024*1024)fail('UNSAFE_STATE_PATH','state file is not an owned regular file');return s;}
function readOwned(p){const before=safeStateFile(p),fd=openSync(p,constants.O_RDONLY|(constants.O_NOFOLLOW||0));try{const opened=fstatSync(fd);if(stateIdentity(before)!==stateIdentity(opened)||opened.nlink!==1)fail('UNSAFE_STATE_PATH','state file changed');const raw=readFileSync(fd,'utf8');if(stateIdentity(safeStateFile(p))!==stateIdentity(opened))fail('UNSAFE_STATE_PATH','state file changed');return {raw,identity:stateIdentity(opened)};}finally{closeSync(fd);}}
let ownStart;
export function withLock(root,fn,{now=()=>Date.now(),processLiveness=nativeLiveness}={}){
 if(typeof fn!=='function'||fn.constructor?.name==='AsyncFunction')fail('ASYNC_STATE_LOCK','state mutations must be synchronous');
 const canonical=safeStateRoot(root),rootIdentity=stateIdentity(lstatSync(canonical)),folder=join(canonical,'.forge');try{mkdirSync(folder);}catch(e){if(e.code!=='EEXIST')throw e;}if(inspectRoot(folder).reason)fail('UNSAFE_STATE_PATH','unsafe state lock directory');
 const lp=lockPath(canonical),guard=lp+'.guard',token=randomUUID();let owned,uncertain=false;
 const check=()=>{if(safeStateRoot(root)!==canonical||stateIdentity(lstatSync(canonical))!==rootIdentity||inspectRoot(folder).reason)fail('UNSAFE_STATE_PATH','state root changed');};
 const take=()=>{check();try{mkdirSync(guard);return stateIdentity(lstatSync(guard));}catch(e){if(e.code==='EEXIST')fail('LOCKED','state lock mutation is unresolved');throw e;}};
 const drop=g=>{try{if(stateIdentity(lstatSync(guard))===g&&!lstatSync(guard).isSymbolicLink())rmdirSync(guard);}catch{/* retain uncertain guard for explicit reconciliation */}};
 const g=take();try{
  if(safeStateFile(lp,true)){const old=readOwned(lp);let holder;try{holder=JSON.parse(old.raw);}catch{fail('LOCKED','state lock owner is unknown');}let life;try{life=processLiveness({pid:holder.pid,startedAtMs:holder.startedMs??null});}catch{life={state:'unknown'};}
   if(life?.state!=='dead')fail('LOCKED','state lock owner is live or unknown');const again=readOwned(lp);if(again.identity!==old.identity||again.raw!==old.raw)fail('LOCKED','state lock changed');rmSync(lp);
  }
  if(ownStart===undefined){try{ownStart=processStartMs(process.pid);}catch{ownStart=null;}}
  const fd=openSync(lp,'wx');try{owned=stateIdentity(fstatSync(fd));writeFileSync(fd,JSON.stringify({pid:process.pid,startedMs:ownStart,startedAt:new Date(now()).toISOString(),token}));fsyncSync(fd);}finally{closeSync(fd);}
 }finally{drop(g);}
 try{check();const result=fn();if(result&&typeof result.then==='function'){uncertain=true;fail('ASYNC_STATE_LOCK','state mutations must be synchronous');}return result;}
 finally{let cleanupGuard;try{if(uncertain)fail('LOCKED','async ownership unresolved');cleanupGuard=take();if(safeStateFile(lp,true)){const current=readOwned(lp);if(current.identity===owned&&JSON.parse(current.raw).token===token)rmSync(lp);}}catch{/* never remove a successor or unknown lock */}finally{if(cleanupGuard)drop(cleanupGuard);}}
}
export function writeStateAtomic(root,state){
 const canonical=safeStateRoot(root),rootIdentity=stateIdentity(lstatSync(canonical)),p=statePath(canonical);safeStateFile(p,true);state.integrity={sha256:bodyHash(state),writer:WRITER};
 const tmp=join(canonical,'.state-'+randomUUID()+'.tmp'),fd=openSync(tmp,'wx');let owned;
 try{owned=stateIdentity(fstatSync(fd));writeFileSync(fd,JSON.stringify(state,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
 try{if(safeStateRoot(root)!==canonical||stateIdentity(lstatSync(canonical))!==rootIdentity)fail('UNSAFE_STATE_PATH','state root changed');safeStateFile(p,true);if(stateIdentity(safeStateFile(tmp))!==owned)fail('UNSAFE_STATE_PATH','temporary file changed');renameSync(tmp,p);}
 finally{try{if(safeStateFile(tmp,true)&&stateIdentity(lstatSync(tmp))===owned)rmSync(tmp);}catch{/* retain unknown file */}}
}

export function appendEvent(metricsPath, event) {
  if (!metricsPath) return;
  mkdirSync(dirname(metricsPath), { recursive: true });
  appendFileSync(metricsPath, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
}

// mutate(root, opts, (state) => eventOrNull). Refuses when paused unless opts.allowPaused.
export function mutate(root, opts, change) {
  return withLock(root, () => {
    const state = readState(root);
    const before = validateState(state, { now: opts.now?.() ?? Date.now() });
    if (before.errors.length) fail('INVALID_STATE', `STATE.json is invalid; refusing to write:\n  - ${before.errors.join('\n  - ')}`);
    if (state.paused && !opts.allowPaused) fail('PAUSED', 'STATE.json is paused; writes are refused');
    const event = change(state);
    const after = validateState(state, { now: opts.now?.() ?? Date.now() });
    if (after.errors.length) fail('INVALID_RESULT', `change would make STATE.json invalid:\n  - ${after.errors.join('\n  - ')}`);
    writeStateAtomic(root, state);
    if (event) appendEvent(opts.metricsPath, { kind: `coord.${event.kind}`, project: state.project, ...event.data });
    return { state, event };
  }, opts);
}

// ---------------------------------------------------------------------------- helpers
const nowIso = (opts) => new Date(opts.now?.() ?? Date.now()).toISOString();
const emptyEvidence = () => Object.fromEntries(EVIDENCE_SLOTS.map((s) => [s, null]));
function findTask(state, id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) fail('NO_TASK', `no task ${id}`);
  return t;
}
function pathConflict(state, task, stages) {
  for (const other of state.tasks) {
    if (other.id === task.id || !stages.includes(other.stage)) continue;
    for (const a of other.paths || []) for (const b of task.paths || []) if (globsOverlap(a, b)) return { other, a, b };
  }
  return null;
}
function depsDone(state, t) { return (t.dependsOn || []).every((d) => state.tasks.find((x) => x.id === d)?.stage === 'done'); }
function rejectSecret(label, value) { if (containsSecret(value)) fail('SECRET', `${label} contains a secret-shaped value; refused`); }

// ---------------------------------------------------------------------------- commands
export function init(root, { project, now } = {}) {
  if (!project) fail('USAGE', 'init needs --project <name>');
  if (existsSync(statePath(root))) fail('EXISTS', `STATE.json already exists at ${statePath(root)}`);
  const state = { version: SCHEMA, project, paused: false, coordinator: null, connectivity: {}, lanes: {}, tasks: [], topics: [], ownerActions: [] };
  mkdirSync(root, { recursive: true });
  withLock(root, () => {
    if (existsSync(statePath(root))) fail('EXISTS', `STATE.json already exists at ${statePath(root)}`);
    writeStateAtomic(root, state);
  }, { now });
  return state;
}

// Lanes are ownership. Setting one is an ownership decision, so it needs an explicit approval note.
export function setLane(root, { lane, owner, paths, approvedBy, ...opts }) {
  if (!lane || !owner || !paths?.length) fail('USAGE', 'lane needs <name> --owner <agent> --paths <glob,...>');
  if (!approvedBy || !String(approvedBy).trim()) fail('NEEDS_OWNER_APPROVAL', 'changing lane ownership needs --approved-by "<who, when>" (ownership is an owner decision)');
  for (const p of paths) if (isEnvPath(p)) fail('ENV_PATH', `lane path ${p} is an env file`);
  for (const p of paths) if (!safeRelPath(p)) fail('UNSAFE_PATH', `lane path ${p} must be repository-relative with no '..'`);
  rejectSecret('lane', { lane, owner, paths, approvedBy });
  return mutate(root, opts, (state) => {
    state.lanes ||= {};
    for (const [name, l] of Object.entries(state.lanes)) {
      if (name === lane) continue;
      for (const a of l.paths) for (const b of paths) if (globsOverlap(a, b)) fail('LANE_OVERLAP', `lane ${lane} path ${b} overlaps lane ${name} path ${a}`);
    }
    state.lanes[lane] = { owner, paths, approvedBy, updatedAt: nowIso(opts) };
    return { kind: 'lane', data: { lane, owner, by: 'manual' } };
  });
}

export function addTask(root, spec) {
  const { id, title, owner, lane, paths = [], dependsOn = [], acceptance = '', requires = [], workerActions = [], timeboxMin, priority = 100, ...opts } = spec;
  if (!id || !title || !owner || !lane) fail('USAGE', 'add needs --id --title --owner --lane');
  if (!TASK_ID.test(String(id))) fail('BAD_ID', `task id ${id} must match ${TASK_ID} (it becomes a file name)`);
  for (const p of paths) if (!safeRelPath(p)) fail('UNSAFE_PATH', `owned path ${p} must be repository-relative with no '..'`);
  rejectSecret('task', { id, title, acceptance, paths });
  for (const p of paths) if (isEnvPath(p)) fail('ENV_PATH', `owned path ${p} is an env file`);
  for (const s of requires) if (!EVIDENCE_SLOTS.includes(s)) fail('BAD_SLOT', `unknown evidence slot ${s}; one of ${EVIDENCE_SLOTS.join(', ')}`);
  for (const a of workerActions) if (NEVER_GRANTABLE.includes(a)) fail('CEILING', `${a} can never be granted to a worker`);
  if (timeboxMin !== undefined && timeboxMin !== null && validTimebox(timeboxMin) === null) fail('BAD_TIMEBOX', `timeboxMin must be 1..${LEASE_MAX_MIN} minutes (got ${timeboxMin})`);
  return mutate(root, opts, (state) => {
    if (state.tasks.some((t) => t.id === id)) fail('DUPLICATE', `task ${id} already exists`);
    const l = state.lanes?.[lane];
    if (!l) fail('NO_LANE', `lane ${lane} is not defined; ownership must be recorded first with \`forge state lane\``);
    if (l.owner !== owner) fail('WRONG_OWNER', `lane ${lane} is owned by ${l.owner}, not ${owner}`);
    for (const p of paths) if (!l.paths.some((g) => insideGlob(p, g))) fail('OUTSIDE_LANE', `path ${p} is outside lane ${lane} (${l.paths.join(', ')})`);
    const c = pathConflict(state, { id, paths }, ['active', 'ready']);
    if (c) fail('PATH_OVERLAP', `path ${c.b} overlaps ${c.other.stage} task ${c.other.id} path ${c.a}`);
    for (const d of dependsOn) if (!state.tasks.some((t) => t.id === d)) fail('NO_DEP', `dependency ${d} does not exist`);
    const task = {
      id, title, owner, lane, stage: 'queued', priority, dependsOn, paths, acceptance,
      requires, workerActions, ...(timeboxMin !== undefined && timeboxMin !== null ? { timeboxMin: validTimebox(timeboxMin) } : {}),
      evidence: emptyEvidence(), lease: null, receipt: null, note: '', updatedAt: nowIso(opts),
    };
    if (depsDone(state, task)) task.stage = 'ready';
    state.tasks.push(task);
    return { kind: 'add', data: { task: id, owner, stage: task.stage, by: 'manual' } };
  });
}

export function setField(root, { task: id, field, value, ...opts }) {
  if (field === 'stage') fail('STAGE_FORBIDDEN', '`set` cannot change stage; use lease, receipt, block, accept or park (F4)');
  if (!SETTABLE.has(field)) fail('FIELD_FORBIDDEN', `field ${field} is not settable; settable: ${[...SETTABLE].join(', ')}`);
  rejectSecret(field, value);
  if (field === 'timeboxMin' && validTimebox(value) === null) fail('BAD_TIMEBOX', `timeboxMin must be 1..${LEASE_MAX_MIN} minutes (got ${value})`);
  if (field === 'priority' && !Number.isFinite(Number(value))) fail('BAD_PRIORITY', `priority must be a number (got ${value})`);
  return mutate(root, opts, (state) => {
    const t = findTask(state, id);
    t[field] = field === 'priority' || field === 'timeboxMin' ? Number(value) : value;
    t.updatedAt = nowIso(opts);
    return { kind: 'set', data: { task: id, field, by: 'manual' } };
  });
}

export function next(state, { agent } = {}) {
  if (!agent) fail('USAGE', 'next needs --agent <name>');
  if (state.paused) return { task: null, reason: 'paused' };
  if (state.connectivity?.[agent]?.file === false) return { task: null, reason: `connectivity for ${agent} is false; no dispatch` };
  const ready = state.tasks
    .filter((t) => t.owner === agent && t.stage === 'ready' && depsDone(state, t))
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || String(a.id).localeCompare(String(b.id)));
  const blocked = state.tasks.filter((t) => t.stage === 'blocked').length;
  return { task: ready[0] || null, reason: ready[0] ? 'ready' : `no ready task (${blocked} blocked, ${(state.ownerActions || []).length} owner actions)` };
}

export function lease(root, { task: id, agent, worktree, minutes = LEASE_DEFAULT_MIN, pid = null, ...opts }) {
  if (!agent || !worktree) fail('USAGE', 'lease needs --agent and --worktree');
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0 || m > LEASE_MAX_MIN) fail('BAD_MINUTES', `lease minutes must be 1..${LEASE_MAX_MIN}`);
  return mutate(root, opts, (state) => {
    const t = findTask(state, id);
    const now = opts.now?.() ?? Date.now();
    if (t.lease && Date.parse(t.lease.until) > now) fail('ALREADY_LEASED', `task ${id} is already leased by ${t.lease.by} (worktree ${t.lease.worktree}) until ${t.lease.until}`, { holder: t.lease });
    if (t.stage !== 'ready') fail('NOT_READY', `task ${id} is ${t.stage}, not ready`);
    if (!depsDone(state, t)) fail('DEPS', `task ${id} has unfinished dependencies`);
    if (t.owner !== agent) fail('WRONG_OWNER', `task ${id} is owned by ${t.owner}, not ${agent}`);
    if (state.connectivity?.[agent]?.file === false) fail('NO_CONNECTIVITY', `connectivity for ${agent} is false`);
    for (const other of state.tasks) {
      if (other.id !== id && other.lease && other.stage === 'active' && pathKey(other.lease.worktree) === pathKey(worktree)) {
        fail('WORKTREE_BUSY', `worktree ${worktree} is held by ${other.id} until its lease is released`);
      }
    }
    const c = pathConflict(state, t, ['active']);
    if (c) fail('PATH_OVERLAP', `cannot activate ${id}: path ${c.b} overlaps active task ${c.other.id} path ${c.a}`);
    t.lease = { by: agent, worktree: tokenizePath(worktree), until: new Date(now + m * 60_000).toISOString(), heartbeatAt: new Date(now).toISOString(), ...(pid ? { pid } : {}) };
    t.stage = 'active';
    t.updatedAt = new Date(now).toISOString();
    return { kind: 'lease', data: { task: id, agent, minutes: m } };
  });
}

function assertHolder(t, agent, worktree, now, { allowExpired = false } = {}) {
  // F13/F14: identity, not SHA. Only the live holder in its own worktree may act on the lease.
  if (!t.lease) fail('NO_LEASE', `task ${t.id} has no lease`);
  if (t.lease.by !== agent || pathKey(t.lease.worktree) !== pathKey(worktree)) fail('NOT_HOLDER', `task ${t.id} is leased by ${t.lease.by} in ${t.lease.worktree}; caller is ${agent} in ${worktree}`);
  if (!allowExpired && Date.parse(t.lease.until) <= now) fail('LEASE_EXPIRED', `lease on ${t.id} expired at ${t.lease.until}`);
}

// allowExpired: only for a caller that has just proven the recorded worker PID is alive (the
// dispatcher). The lease must still name the same holder and worktree; nobody else can have claimed it.
export function heartbeat(root, { task: id, agent, worktree, minutes = LEASE_DEFAULT_MIN, pid = null, allowExpired = false, ...opts }) {
  const m = typeof minutes === 'number' || typeof minutes === 'string' ? Number(minutes) : NaN;
  if (!Number.isFinite(m) || m < 1 || m > LEASE_MAX_MIN)
    fail('BAD_MINUTES', `heartbeat minutes must be 1..${LEASE_MAX_MIN}`);
  return mutate(root, opts, (state) => {
    const t = findTask(state, id);
    const now = opts.now?.() ?? Date.now();
    if (t.stage !== 'active') fail('NOT_ACTIVE', `task ${id} is ${t.stage}, not active`);
    assertHolder(t, agent, worktree, now, { allowExpired });
    t.lease.until = new Date(now + m * 60_000).toISOString();
    t.lease.heartbeatAt = new Date(now).toISOString();
    if (pid) t.lease.pid = pid;
    return null;
  });
}

// Coordinator duty: release leases that expired more than graceMinutes ago (F13: after expiry +
// one run interval). Callers that track workers (dispatcher, coordinator) pass isAlive; it is asked
// about every expired lease, with or without a PID (finding 15: a running ledger row whose PID was
// never saved must keep its lease). Without a callback, a lease that names a PID is kept (unknown
// liveness) and a lease without one is released.
export function releaseExpired(root, { graceMinutes = 30, isAlive = null, ...opts } = {}) {
  const released = [];
  mutate(root, { ...opts, allowPaused: true }, (state) => {
    const now = opts.now?.() ?? Date.now();
    for (const t of state.tasks) {
      if (!t.lease || t.stage !== 'active') continue;
      if (Date.parse(t.lease.until) + graceMinutes * 60_000 > now) continue;
      if (isAlive ? isAlive(t.lease, t) : Boolean(t.lease.pid)) continue; // unknown liveness = keep (review P1)
      released.push(t.id);
      t.lease = null; t.stage = 'ready'; t.updatedAt = new Date(now).toISOString();
    }
    return released.length ? { kind: 'lease_expired', data: { tasks: released } } : null;
  });
  return released;
}

export function block(root, { task: id, reason, agent = null, worktree = null, ...opts }) {
  if (!reason) fail('USAGE', 'block needs --reason');
  rejectSecret('reason', reason);
  return mutate(root, { ...opts, allowPaused: true }, (state) => {
    const t = findTask(state, id);
    if (agent) assertHolder(t, agent, worktree, opts.now?.() ?? Date.now());
    if (t.stage === 'done') fail('DONE_IS_FINAL', `task ${id} is done; regressions become new tasks (A4)`);
    t.stage = 'blocked'; t.lease = null; t.note = reason; t.updatedAt = nowIso(opts);
    return { kind: 'blocked', data: { task: id } };
  });
}

export function unblock(root, { task: id, ...opts }) {
  return mutate(root, opts, (state) => {
    const t = findTask(state, id);
    if (t.stage !== 'blocked' && t.stage !== 'parked') fail('NOT_BLOCKED', `task ${id} is ${t.stage}`);
    const c = pathConflict(state, t, ['active', 'ready']);
    if (c) fail('PATH_OVERLAP', `cannot unblock ${id}: path ${c.b} overlaps ${c.other.stage} task ${c.other.id} path ${c.a}`);
    t.stage = depsDone(state, t) ? 'ready' : 'queued'; t.updatedAt = nowIso(opts);
    return { kind: 'unblocked', data: { task: id, stage: t.stage, by: 'manual' } };
  });
}

// Promote queued tasks whose dependencies are done. Coordinator duty; idempotent.
export function promote(root, opts = {}) {
  const promoted = [];
  mutate(root, opts, (state) => {
    for (const t of state.tasks) {
      if (t.stage !== 'queued' || !depsDone(state, t)) continue;
      if (pathConflict(state, t, ['active', 'ready'])) continue; // stays queued until the conflicting task leaves
      t.stage = 'ready'; t.updatedAt = nowIso(opts); promoted.push(t.id);
    }
    return promoted.length ? { kind: 'promoted', data: { tasks: promoted } } : null;
  });
  return promoted;
}

// receipt: validate a completion receipt v3 once, in the task worktree (F3), by the live lease
// holder (F13). Intake-authored receipts can never advance tasks (F9).
export function submitReceipt(root, { task: id, receiptPath, agent, worktree, validator = defaultValidator, ...opts }) {
  if (!receiptPath || !agent || !worktree) fail('USAGE', 'receipt needs <task> <receipt.json> --agent --worktree');
  const wt = resolve(worktree);
  const abs = isAbsolute(receiptPath) ? receiptPath : resolve(wt, receiptPath);
  const rel = relative(wt, abs);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail('RECEIPT_OUTSIDE', 'receipt must live inside the task worktree (committed on the task branch)');
  let receipt;
  try { receipt = JSON.parse(readFileSync(abs, 'utf8')); } catch (e) { fail('BAD_RECEIPT', `cannot read receipt: ${e.message}`); }
  if (String(receipt.work_author_id || '').startsWith('intake:')) fail('INTAKE_RECEIPT', 'intake receipts may advance topics only, never tasks (F9)');
  if (receipt.scope_id !== id) fail('SCOPE_MISMATCH', `receipt scope_id ${receipt.scope_id} does not match task ${id}`);
  return mutate(root, opts, (state) => {
    const t = findTask(state, id);
    if (t.stage !== 'active') fail('NOT_ACTIVE', `task ${id} is ${t.stage}, not active`);
    assertHolder(t, agent, wt, opts.now?.() ?? Date.now());
    const v = validator({ root: wt, receiptRel: rel.split(sep).join('/') });
    if (!v.ok) fail('RECEIPT_INVALID', `receipt failed validation:\n${v.output}`);
    const now = nowIso(opts);
    t.receipt = { sha: receipt.source_commit_sha, expiresAt: receipt.expires_at ?? null, validatedAt: now, receiptSha256: createHash('sha256').update(readFileSync(abs)).digest('hex'), path: rel.split(sep).join('/') };
    t.result = null;
    t.evidence = emptyEvidence(); // a new revision voids review, CI, merge, deploy and live evidence (review P2)
    t.evidence.implemented = { ref: `receipt ${t.receipt.path} @ ${receipt.source_commit_sha}`, at: now };
    t.stage = 'review'; t.lease = null; t.updatedAt = now;
    return { kind: 'advance', data: { task: id, to: 'review', by: 'receipt' } };
  });
}

export function defaultValidator({ root, receiptRel }) {
  const script = join(dirname(here), 'completion', 'validate-completion-receipt.mjs');
  const r = spawnSync(process.execPath, [script, '--root', root, '--receipt', receiptRel], { encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, output: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

// result: the dispatcher records a parsed, schema-checked worker result for the live lease holder
// (HH-ORCH-03 B.4), with the worktree's full HEAD SHA it verified. It fills only `implemented` and,
// like a new receipt, resets every other evidence slot. Free text is stored for the owner but never
// copied into packs (F11).
export function recordResult(root, { task: id, agent, worktree, runId, result, headSha, ...opts }) {
  if (!runId || !result) fail('USAGE', 'result needs runId and a parsed result');
  if (result.status !== 'done') fail('NOT_DONE', `worker result status is ${result.status}; use block for blocked results`);
  if (!/^[0-9a-f]{40}$/.test(String(headSha || ''))) fail('NO_HEAD', 'result needs the full 40-character HEAD SHA of the worktree');
  rejectSecret('result', result);
  return mutate(root, opts, (state) => {
    const t = findTask(state, id);
    if (t.stage !== 'active') fail('NOT_ACTIVE', `task ${id} is ${t.stage}, not active`);
    assertHolder(t, agent, worktree, opts.now?.() ?? Date.now(), { allowExpired: true });
    const now = nowIso(opts);
    const passed = result.checks.reduce((n, c) => n + c.passed, 0), total = result.checks.reduce((n, c) => n + c.total, 0);
    t.result = { runId, headSha, commits: result.commits, checks: result.checks.map((c) => ({ ...c, source: 'worker_reported' })), summary: String(result.summary).slice(0, 2000), gaps: result.gaps, at: now };
    t.receipt = null;
    t.evidence = emptyEvidence();
    t.evidence.implemented = { ref: `worker run ${runId} @ ${headSha.slice(0, 12)}: ${result.commits.length} commit(s), checks ${passed}/${total} (worker-reported, not independently run)`, at: now };
    t.stage = 'review'; t.lease = null; t.updatedAt = now;
    return { kind: 'advance', data: { task: id, to: 'review', by: 'worker-result' } };
  });
}

// evidence: record one slot. `implemented` only comes from a receipt or a recorded worker result; `merged` only from accept.
export function recordEvidence(root, { task: id, slot, ref, ...opts }) {
  if (!EVIDENCE_SLOTS.includes(slot)) fail('BAD_SLOT', `unknown slot ${slot}`);
  if (slot === 'implemented') fail('SLOT_RESERVED', '`implemented` is filled only by a validated receipt');
  if (slot === 'merged') fail('SLOT_RESERVED', '`merged` is filled only by `accept --pr`');
  if (!ref || !String(ref).trim()) fail('USAGE', 'evidence needs --ref "<command, URL or SHA>"');
  rejectSecret('ref', ref);
  return mutate(root, opts, (state) => {
    const t = findTask(state, id);
    if (t.stage === 'done') fail('DONE_IS_FINAL', `task ${id} is done`);
    t.evidence ||= emptyEvidence();
    t.evidence[slot] = { ref: String(ref), at: nowIso(opts) };
    t.updatedAt = nowIso(opts);
    return { kind: 'evidence', data: { task: id, slot } };
  });
}

// accept: review -> done (F4, as amended by owner decision D1 on 2026-10-09). The PR must be merged,
// contain the validated revision, and every context the base branch's protection requires must be green
// on the PR head (check runs AND commit statuses, latest result per context). The head must have been up
// to date with the base when merged (the merge commit's first parent is an ancestor of the head), and the
// squash/merge commit's tree must equal the tested head's tree. Truncated or missing evidence fails
// closed. Every evidence slot the task declared in `requires` must be filled. done is permanent (A4).
const GREEN_CHECK = new Set(['success', 'neutral', 'skipped']);
const latestBy = (items, key, at) => {
  const out = new Map();
  for (const x of items || []) {
    const k = x?.[key];
    if (!k) continue;
    const prev = out.get(k);
    if (!prev || String(at(x) || '') >= String(at(prev) || '')) out.set(k, x);
  }
  return out;
};
export function evaluatePr(info, { revision, paths = [] } = {}) {
  const refuse = (code, detail) => ({ ok: false, code, detail });
  if (!info || info.state !== 'MERGED' || !info.mergeSha) return refuse('PR_NOT_MERGED', 'PR is not merged');
  if (!(info.commits || []).some((c) => c === revision || c.startsWith(revision) || revision.startsWith(c))) return refuse('PR_UNRELATED', `PR does not contain the validated revision ${revision}`);
  if (!info.afterRevision || info.afterRevision.complete !== true) return refuse('EVIDENCE_INCOMPLETE', 'the change list after the validated revision is missing or truncated');
  const touched = [];
  for (const f of info.afterRevision.files || []) for (const name of [f.filename, f.previous_filename]) if (name && pathOwnedBy(name, paths)) touched.push(name);
  if (touched.length) return refuse('CHANGED_AFTER_RECEIPT', `owned paths changed after the validated revision: ${[...new Set(touched)].slice(0, 5).join(', ')}`);
  // Delta review 2: every requirement is kept as its own (context, appId) pair; one name may be bound to
  // several Apps (classic protection and a ruleset), and each binding must be satisfied.
  const bound = (info.required?.checks || []).filter((c) => c?.context);
  const reqs = [];
  for (const c of [...bound, ...(info.required?.contexts || []).filter((x) => !bound.some((b) => b.context === x)).map((x) => ({ context: x, appId: null }))]) {
    const appId = c.appId == null ? null : Number(c.appId);
    if (!reqs.some((r) => r.context === c.context && r.appId === appId)) reqs.push({ context: c.context, appId });
  }
  const required = reqs;
  if (!info.required) return refuse('NO_REQUIRED_CHECKS', 'the base branch has no required status checks policy');
  if (info.required.complete !== true) return refuse('EVIDENCE_INCOMPLETE', 'the required checks policy could not be read completely');
  if (!required.length) return refuse('NO_REQUIRED_CHECKS', 'the base branch requires no status checks');
  if (info.headCheckRuns?.complete !== true || info.headStatuses?.complete !== true) return refuse('EVIDENCE_INCOMPLETE', 'check runs or commit statuses on the PR head are missing or truncated');
  const statuses = latestBy(info.headStatuses.statuses, 'context', (x) => x.updated_at || x.created_at);
  const bad = [];
  for (const { context: ctx, appId } of required) {
    // Review delta finding 2: a context bound to an App counts only check runs from that App, and a
    // commit status (which carries no verified App) cannot stand in for it.
    const pool = (info.headCheckRuns.runs || []).filter((r) => r.name === ctx && (appId === null || Number(r.app?.id) === appId));
    const run = latestBy(pool, 'name', (r) => r.completed_at || r.started_at).get(ctx), st = statuses.get(ctx);
    // Review delta finding 1: when a required name exists as both a check run and a commit status,
    // GitHub requires both; every present form must be green and at least one must exist.
    const runOk = !run || (run.status === 'completed' && GREEN_CHECK.has(run.conclusion));
    const stOk = !st || st.state === 'success';
    if ((appId === null ? (run || st) : run) && runOk && stOk) continue;
    const why = [];
    if (run && !runOk) why.push(`check ${run.status}/${run.conclusion ?? 'none'}`);
    if (st && !stOk) why.push(`status ${st.state}`);
    if (appId !== null && !run) why.push(`no check run from App ${appId}`);
    else if (!run && !st) why.push('missing');
    bad.push(`${ctx}${appId === null ? '' : `@app${appId}`}:${why.join('+')}`);
  }
  if (bad.length) return refuse('CHECKS_NOT_GREEN', `required contexts not green on head ${String(info.headSha).slice(0, 12)}: ${bad.join(', ')}`);
  if (!['ahead', 'identical'].includes(info.upToDate?.status)) return refuse('STALE_HEAD', `the head was not up to date with the base when merged (compare status ${info.upToDate?.status ?? 'unknown'})`);
  if (!info.headTree || !info.mergeTree) return refuse('EVIDENCE_INCOMPLETE', 'the head or merge commit tree could not be read');
  if (info.headTree !== info.mergeTree) return refuse('TREE_MISMATCH', `merge commit ${info.mergeSha} tree differs from the tested head ${info.headSha}`);
  return { ok: true, ciPassedRef: `head ${String(info.headSha).slice(0, 12)}: required ${required.length}/${required.length} green (check runs + statuses); squash ${info.mergeSha.slice(0, 12)} tree = tested tree` };
}

// Reject branch names, URLs and option-like selectors before reading state or calling GitHub.
function prNumber(value) {
  const n = typeof value === 'number' || (typeof value === 'string' && /^[1-9][0-9]*$/.test(value))
    ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) fail('USAGE', 'accept needs --pr <positive integer>');
  return n;
}

export function accept(root, { task: id, pr, prInfo = defaultPrInfo, ...opts }) {
  pr = prNumber(pr);
  const pre = readState(root).tasks.find((x) => x.id === id);
  if (!pre) fail('NO_TASK', `no task ${id}`);
  const revision = pre.receipt?.sha || pre.result?.headSha;
  if (!revision) fail('NO_RECEIPT', `task ${id} has neither a validated receipt nor a recorded worker result`);
  const info = prInfo(pr, { root, revision, paths: pre.paths || [] });
  const verdict = evaluatePr(info, { revision, paths: pre.paths || [] });
  if (!verdict.ok) fail(verdict.code, `PR #${pr}: ${verdict.detail}`);
  return mutate(root, opts, (state) => {
    const t = findTask(state, id);
    if (t.stage !== 'review') fail('NOT_IN_REVIEW', `task ${id} is ${t.stage}, not review`);
    if ((t.receipt?.sha || t.result?.headSha) !== revision) fail('REVISION_CHANGED', `task ${id} revision changed during accept`);
    if (t.receipt?.expiresAt && Date.parse(t.receipt.expiresAt) <= (opts.now?.() ?? Date.now())) fail('RECEIPT_EXPIRED', `receipt for ${id} expired at ${t.receipt.expiresAt}; review -> done needs a fresh receipt (F3)`);
    const now = nowIso(opts);
    t.evidence ||= emptyEvidence();
    t.evidence.merged = { ref: `PR #${pr} merge ${info.mergeSha}`, at: now };
    t.evidence.ciPassed = { ref: verdict.ciPassedRef, at: now };
    const missing = (t.requires || []).filter((s) => !t.evidence[s]);
    if (missing.length) fail('EVIDENCE_MISSING', `task ${id} still needs evidence: ${missing.join(', ')}`);
    t.receipt = { ...(t.receipt || { source: 'worker-result', runId: t.result.runId, sha: t.result.headSha }), pr: Number(pr), mergeSha: info.mergeSha };
    t.stage = 'done'; t.updatedAt = now;
    return { kind: 'advance', data: { task: id, to: 'done', by: 'receipt', pr: Number(pr) } };
  });
}

// Gathers the raw evidence evaluatePr needs. gh runs with cwd = the state repository (review P2), so
// the PR resolves in the right repo. Every list records whether it is complete; nothing is inferred.
export function defaultPrInfo(pr, { root, revision, gh: ghImpl = null } = {}) {
  pr = prNumber(pr);
  const gh = ghImpl ?? ((args) => {
    const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true, cwd: root });
    if (r.status !== 0) {
      if (/HTTP 404|Not Found|Branch not protected/i.test(r.stderr || '')) return null;
      fail('GH_FAILED', `gh ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || '').trim()}`);
    }
    return JSON.parse(r.stdout || 'null');
  });
  const j = gh(['pr', 'view', String(pr), '--json', 'state,mergeCommit,headRefOid,baseRefName,commits']);
  const mergeSha = j?.mergeCommit?.oid || null, headSha = j?.headRefOid || null;
  const info = { state: j?.state, mergeSha, headSha, commits: (j?.commits || []).map((c) => c.oid), required: null, headCheckRuns: { runs: [], complete: false }, headStatuses: { statuses: [], complete: false }, afterRevision: { files: [], complete: false }, upToDate: null, headTree: null, mergeTree: null, mergeParent: null };
  if (!headSha) return info;
  // Required policy = classic branch protection PLUS active repository rulesets (review delta finding 2),
  // keeping each check's App binding. Either source being unreadable makes the policy incomplete.
  const checks = [];
  let complete = true, any = false;
  try {
    const prot = gh(['api', `repos/{owner}/{repo}/branches/${j.baseRefName}/protection/required_status_checks`]);
    // Amendment v1 P2: classic `contexts` is a legacy mirror of `checks`; a name already listed in
    // `checks` is that same requirement (with its App binding), not an extra unbound one.
    if (prot) {
      any = true;
      const classic = (prot.checks || []).map((c) => ({ context: c.context, appId: c.app_id ?? null }));
      for (const c of prot.contexts || []) if (!classic.some((k) => k.context === c)) checks.push({ context: c, appId: null });
      checks.push(...classic);
    }
  } catch { complete = false; }
  try {
    // One page of 100; a full page may hide more rules, and a missing endpoint is not "no rules".
    const rules = gh(['api', `repos/{owner}/{repo}/rules/branches/${j.baseRefName}?per_page=100`]);
    if (!Array.isArray(rules) || rules.length >= 100) complete = false;
    for (const r of Array.isArray(rules) ? rules : []) {
      if (r?.type !== 'required_status_checks') continue;
      any = true;
      for (const c of r.parameters?.required_status_checks || []) checks.push({ context: c.context, appId: c.integration_id ?? null });
    }
  } catch { complete = false; }
  if (any || !complete) {
    const kept = [];
    for (const c of checks) if (!kept.some((k) => k.context === c.context && k.appId === c.appId)) kept.push(c);
    info.required = { contexts: [...new Set(kept.map((c) => c.context))], checks: kept, complete };
  }
  const cr = gh(['api', `repos/{owner}/{repo}/commits/${headSha}/check-runs?per_page=100`]);
  if (cr) info.headCheckRuns = { runs: cr.check_runs || [], complete: Number(cr.total_count) <= (cr.check_runs || []).length };
  const cs = gh(['api', `repos/{owner}/{repo}/commits/${headSha}/status?per_page=100`]);
  if (cs) info.headStatuses = { statuses: cs.statuses || [], complete: Number(cs.total_count) <= (cs.statuses || []).length };
  // GitHub's compare lists at most 300 files: a full page is treated as truncated (finding 4).
  if (revision && revision !== headSha) {
    const cmp = gh(['api', `repos/{owner}/{repo}/compare/${revision}...${headSha}`]);
    const files = cmp?.files;
    info.afterRevision = { files: (files || []).map((f) => ({ filename: f.filename, previous_filename: f.previous_filename })), complete: Array.isArray(files) && files.length < 300 };
  } else info.afterRevision = { files: [], complete: true };
  const head = gh(['api', `repos/{owner}/{repo}/git/commits/${headSha}`]);
  info.headTree = head?.tree?.sha ?? null;
  if (mergeSha) {
    const m = gh(['api', `repos/{owner}/{repo}/git/commits/${mergeSha}`]);
    info.mergeTree = m?.tree?.sha ?? null;
    info.mergeParent = m?.parents?.[0]?.sha ?? null;
    if (info.mergeParent) {
      const up = gh(['api', `repos/{owner}/{repo}/compare/${info.mergeParent}...${headSha}`]);
      info.upToDate = up ? { status: up.status } : null;
    }
  }
  return info;
}

// pack: task context for a worker, <= 32 KiB. Structured fields only from dependency receipts (F11).
export function pack(root, { task: id, outDir, contextPacket = null, promptVersion = 'pack/1', ...opts }) {
  const state = readState(root);
  const t = findTask(state, id);
  for (const p of t.paths || []) if (isEnvPath(p)) fail('ENV_PATH', `owned path ${p} is an env file; pack refused`);
  const deps = (t.dependsOn || []).map((d) => {
    const dt = state.tasks.find((x) => x.id === d);
    return dt ? { id: dt.id, stage: dt.stage, sha: dt.receipt?.sha ?? null, mergeSha: dt.receipt?.mergeSha ?? null } : { id: d, stage: 'missing' };
  });
  const lines = [
    `# Task pack: ${t.id}`, '', `promptVersion: ${promptVersion}`, `project: ${state.project}`, '',
    '## Task', '', `- title: ${t.title}`, `- owner: ${t.owner}`, `- lane: ${t.lane ?? ''}`, `- stage: ${t.stage}`,
    `- timeboxMin: ${t.timeboxMin ?? 'unset'}`, '', '## Acceptance', '', String(t.acceptance || '(none recorded)'), '',
    '## Owned paths (edit only these)', '', ...(t.paths || []).map((p) => `- ${p}`), '',
    '## Evidence this task must produce', '', ...(t.requires || []).map((s) => `- ${s}`), '',
    '## Dependencies (structured fields only)', '', '```json', JSON.stringify(deps, null, 2), '```', '',
    '## Rules for this run', '', '- Never read or print .env files or secrets.',
    '- Never push, merge, deploy, write a hosted database, or change schedules.',
    '- Do not execute tests or scripts that this task created or changed: no isolated runner exists yet (HH-ORCH-04 S4), so the owner runs them supervised. List only checks you actually ran; an empty checks list is valid.',
    '- End with the required structured result: status done or blocked, summary, commits, checks with passed/total (0 <= passed <= total, total >= 1), gaps.', '',
  ];
  let content = lines.join('\n');
  if (contextPacket) content = `${content}\n---\n\n${contextPacket}`;
  rejectSecret('pack', content);
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > PACK_BUDGET_BYTES) fail('PACK_TOO_LARGE', `pack is ${bytes} bytes, over the ${PACK_BUDGET_BYTES}-byte budget; nothing was dropped`);
  const dir = outDir || join(root, '.forge', 'packs');
  mkdirSync(dir, { recursive: true });
  if (!TASK_ID.test(String(t.id))) fail('BAD_ID', `task id ${t.id} is not a safe file name`);
  const file = resolve(dir, `${t.id}.md`);
  const rel = relative(resolve(dir), file);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes(sep)) fail('PACK_OUTSIDE', `pack path for ${t.id} escapes ${dir}`);
  writeFileSync(file, content);
  appendEvent(opts.metricsPath, { kind: 'coord.pack', project: state.project, task: id, bytes });
  return { file, bytes };
}

// validate --adopt: one-time conversion of the hand-written bootstrap file (F8).
export function adopt(root, opts = {}) {
  return withLock(root, () => {
    const state = readState(root);
    const { errors } = validateState(state);
    if (errors.length) fail('INVALID_STATE', `cannot adopt an invalid STATE.json:\n  - ${errors.join('\n  - ')}`);
    if (state.integrity?.writer !== 'manual-bootstrap') fail('NOT_BOOTSTRAP', 'adopt only converts a manual-bootstrap file');
    writeStateAtomic(root, state);
    appendEvent(opts.metricsPath, { kind: 'coord.adopt', project: state.project, by: 'manual' });
    return state;
  }, opts);
}

// Trusted-controller primitive, not actor authentication or a START admission API.
// The relay controller must commit its durable intent and verify all envelope,
// authority, candidate and accounting evidence before invoking this operation.
export function applyRelayState(root, op, opts={}) {
  const bad=code=>fail(code,code), id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(x), sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x), binding=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
  const allowed=['id','kind','project','task','claimId','generation','actorBinding','managerBinding','agent','inputSha','candidateSha','scopePaths','worktree','runId','minutes','result','verdict','ref','messageId','expectedStateHash','repair'];
  if(!op||Object.getPrototypeOf(op)!==Object.prototype||Object.keys(op).some(k=>!allowed.includes(k))||!['id','project','task','claimId','agent'].every(k=>id(op[k]))||!['build-start','result','review-start','consume'].includes(op.kind)||!/^([1-9][0-9]*|0)$/.test(op.generation)||!binding(op.actorBinding)||!binding(op.managerBinding)||!sha(op.inputSha)||!Array.isArray(op.scopePaths)||op.scopePaths.some(p=>!safeRelPath(p)||isEnvPath(p)))bad('RELAY_OPERATION_INVALID');
  rejectSecret('relay operation',op);
  const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
  const operationHash=createHash('sha256').update(JSON.stringify(canonical(op))).digest('hex');
  const now=opts.now?.()??Date.now();if(!Number.isSafeInteger(now))bad('RELAY_CLOCK');
  return withLock(root,()=>{
    const state=readState(root);if(validateState(state,{now}).errors.length)bad('INVALID_STATE');
    if(state.project!==op.project)bad('RELAY_PROJECT');const t=findTask(state,op.task),previous=t.handoff?.operations?.[op.id];
    if(previous){if(previous!==operationHash)bad('RELAY_OPERATION_CONFLICT');return {state,replayed:true};}
    if(op.expectedStateHash!==undefined&&op.expectedStateHash!==bodyHash(state))bad('RELAY_STATE_CHANGED');
    if(state.paused)bad('PAUSED');if(t.stage==='done')bad('DONE_IS_FINAL');
    if(JSON.stringify([...t.paths].sort())!==JSON.stringify([...op.scopePaths].sort()))bad('RELAY_SCOPE');
    const stamp=new Date(now).toISOString();let h=t.handoff;
    if(op.kind==='build-start'){
      const repair=op.repair;
      if(h){
        if(!repair||Object.keys(repair).sort().join(',')!=='assignmentId,consumeId,consumeOperationId,generation,verdictId'||!binding(op.expectedStateHash)||h.outcome!=='repair-held'||t.stage!=='review'||!id(repair.consumeId)||h.reviewOperationId!==repair.consumeOperationId||h.verdictMessageId!==repair.verdictId||!id(repair.assignmentId)||h.generation!==repair.generation||BigInt(op.generation)!==BigInt(h.generation)+1n||h.candidate!==op.inputSha||t.result?.headSha!==op.inputSha||h.managerBinding!==op.managerBinding||h.authorBinding!==op.actorBinding||op.claimId===h.buildClaim||op.claimId===h.reviewClaim||op.runId===h.buildRun||op.runId===h.reviewRun)bad('RELAY_REPAIR_LINEAGE');
        if((h.history?.length||0)>=2||Object.keys(h.operations).length>=100)bad('RELAY_OPERATION_QUOTA');
      }else if(repair)bad('RELAY_REPAIR_LINEAGE');
      if((!h&&t.stage!=='ready')||t.lease||t.owner!==op.agent||!depsDone(state,t)||state.connectivity?.[op.agent]?.file===false)bad('RELAY_BUILD_HELD');
      if(typeof op.minutes!=='number'||validTimebox(op.minutes)===null||!id(op.runId)||inspectRoot(op.worktree).reason)bad('RELAY_BUILD_INPUT');
      if(pathConflict(state,t,['active'])||state.tasks.some(x=>x.id!==t.id&&x.lease&&pathKey(x.lease.worktree)===pathKey(op.worktree)))bad('RELAY_RESOURCE_HELD');
      const history=h?[...(h.history||[]),Object.fromEntries(Object.entries(h).filter(([k])=>!['history','operations'].includes(k)))]:[];const operations=h?.operations||{};
      h={...(history.length?{history}:{}),generation:op.generation,authorBinding:op.actorBinding,managerBinding:op.managerBinding,inputSha:op.inputSha,buildClaim:op.claimId,buildRun:op.runId,operations};t.handoff=h;
      t.lease={by:op.agent,worktree:tokenizePath(op.worktree),until:new Date(now+op.minutes*60000).toISOString(),heartbeatAt:stamp};t.stage='active';
    }else{
      if(!h||h.generation!==op.generation||h.managerBinding!==op.managerBinding||h.inputSha!==op.inputSha)bad('RELAY_PREDECESSOR');
      if(Object.keys(h.operations).length>=100)bad('RELAY_OPERATION_QUOTA');
      if(!(op.kind==='result'&&op.result?.status==='blocked'&&op.candidateSha===null)&&!sha(op.candidateSha))bad('RELAY_CANDIDATE');
      if(op.kind==='result'){
        if(t.stage!=='active'||h.buildClaim!==op.claimId||h.buildRun!==op.runId||h.authorBinding!==op.actorBinding||!id(op.messageId))bad('RELAY_RESULT_BINDING');
        assertHolder(t,op.agent,op.worktree,now,{allowExpired:true});const r=op.result;
        if(!r||!['done','blocked'].includes(r.status)||typeof r.summary!=='string'||!Array.isArray(r.commits)||!r.commits.every(sha)||!Array.isArray(r.checks)||r.checks.some(c=>!c||typeof c.name!=='string'||!Number.isSafeInteger(c.passed)||!Number.isSafeInteger(c.total)||c.passed<0||c.total<c.passed)||!Array.isArray(r.gaps)||r.gaps.some(x=>typeof x!=='string'))bad('RELAY_RESULT_SCHEMA');
        t.result={runId:op.runId,headSha:op.candidateSha,commits:r.commits,checks:r.checks.map(c=>({...c,source:'worker_reported'})),summary:r.summary.slice(0,2000),gaps:r.gaps,at:stamp};
        t.receipt=null;t.evidence=emptyEvidence();if(r.status==='done')t.evidence.implemented={ref:'manual run '+op.runId+' @ '+op.candidateSha+' (worker-reported checks)',at:stamp};t.stage=r.status==='blocked'?'blocked':'review';if(r.status==='blocked')t.note=r.summary.slice(0,2000);t.lease=null;h.candidate=op.candidateSha;h.resultMessageId=op.messageId;
      }else{
        if(t.stage!=='review'||h.candidate!==op.candidateSha||t.result?.headSha!==op.candidateSha)bad('RELAY_CANDIDATE');
        if(op.kind==='review-start'){
          if(h.reviewClaim||op.actorBinding===h.authorBinding||op.actorBinding===h.managerBinding||!id(op.runId))bad('RELAY_REVIEW_INDEPENDENCE');
          h.reviewClaim=op.claimId;h.reviewerBinding=op.actorBinding;h.reviewRun=op.runId;
        }else{
          if(op.actorBinding!==h.managerBinding||op.claimId!==h.reviewClaim||!h.reviewerBinding||!id(op.messageId)||!['PASS','CHANGES_REQUESTED','BLOCKED'].includes(op.verdict)||typeof op.ref!=='string'||!op.ref||op.ref.length>2000||h.verdictMessageId)bad('RELAY_CONSUME_BINDING');
          h.verdictMessageId=op.messageId;h.reviewOperationId=op.id;h.outcome=op.verdict==='PASS'?'reviewed':op.verdict==='BLOCKED'?'blocked':'repair-held';
          if(op.verdict==='PASS')t.evidence.reviewed={ref:op.ref,at:stamp};
        }
      }
    }
    h.operations[op.id]=operationHash;t.updatedAt=stamp;
    if(validateState(state,{now}).errors.length)bad('INVALID_RESULT');if(!opts.preview)writeStateAtomic(root,state);
    return {state,replayed:false};
  },opts);
}
