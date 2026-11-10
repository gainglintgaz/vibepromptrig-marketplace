#!/usr/bin/env node
// forge-dispatch.mjs -- HH-ORCH-04 S2: the scheduled routine body (routine "forge-dispatch" in
// .forge/routines.json; registered only by the owner). Zero AI inside.
// Justified: the scheduler registers scripts/<name>.mjs bodies; this one drives the existing forge
// dispatch + coordinator for every enrolled project; no MCP server or Skill orchestrates them.
//
// One pass: STOP file -> portfolio pass lock (passes never overlap, Card 04 Q1) -> for each project
// enrolled in the runtime portfolio.json: dispatcher DRY RUN + coordinator DRY RUN, with the digest
// written to <runtime>/digests/<project>/DIGEST.md. Execution stays disabled (HH-ORCH-03 amendment):
// a requested mode "execute" is refused and reported, never attempted.
//
// Boundaries (S2 review repair):
//  - F1 writes: a project name must be a plain identifier, unique in the pass, and the digest folder
//    must resolve inside the runtime folder (no traversal, no junction or symlink redirect).
//  - F2 execution: a shadow pass never runs a project-configured agent command; the dispatcher's CLI
//    preflight is replaced by a refusal that is reported in the digest.
//  - F3 truth: the digest shows THIS pass's owner items, refusals and actions, never a stale last run.
//  - F4 overlap: the pass lock is taken over only when its owner is proven gone (PID absent or reused);
//    a live or unknown owner keeps it whatever its age, and a pass releases only its own lock.
// A shadow pass never writes STATE.json; it writes only inside the runtime folder.

import { randomUUID } from 'node:crypto';
import { notificationStatus } from './forge/notify.mjs';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as D from './forge/dispatch-lib.mjs';
import { runOnce, EXECUTION_DISABLED_REASON } from './forge/dispatch.mjs';
import { coordinate } from './coordinator.mjs';
import { validatePortfolio, revalidate } from './forge/portfolio-policy.mjs';
import { inspectPauseRequest, fenceRuntime, withFencedEffect, takeFencedPortfolioLock, releaseFencedPortfolioLock } from './forge/stop.mjs';

export const PORTFOLIO_LOCK = '_portfolio';
export const SHADOW_PREFLIGHT_REASON = 'shadow pass does not run project-configured agent commands (CLI preflight not executed; execution is disabled)';
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// S5-A: one strict policy decides enrollment before any project is read (scripts/forge/portfolio-policy.mjs).
// Refused entries are reported and never run; a top-level error refuses the whole portfolio.
function enrolled(rt) {
  const p = join(rt, 'portfolio.json');
  if (!existsSync(p)) return { entries: [], refused: [], errors: [], mode: null, path: p };
  let doc;
  try { doc = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { return { entries: [], refused: [], errors: [], mode: null, path: p, error: `portfolio.json unreadable: ${e.message}` }; }
  return { ...validatePortfolio(doc), path: p };
}

// F1: the digest folder must be inside <runtime>/digests after resolving links, and must not itself be a link.
function rejectLink(path) {
  let stat;
  try { stat = lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (stat.isSymbolicLink()) throw Object.assign(new Error(`${path} is a link; refusing output outside the runtime folder`), { code: 'OUTSIDE_RUNTIME' });
}
function assertDigestProject(project) {
  if (!PROJECT_NAME.test(project) || project === '.' || project === '..') throw Object.assign(new Error(`invalid project name ${JSON.stringify(project)} (letters, digits, . _ - only; no path separators)`), { code: 'BAD_PROJECT' });
}
function digestDir(rt, project) {
  assertDigestProject(project);
  const root = join(rt, 'digests');
  rejectLink(root);
  mkdirSync(root, { recursive: true });
  const realRoot = realpathSync.native(root);
  const realRt = realpathSync.native(rt);
  const inside = (base, p) => { const r = relative(base, p); return r !== '' && !r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r); };
  if (!inside(realRt, realRoot)) throw Object.assign(new Error(`digest root ${root} resolves outside the runtime folder`), { code: 'OUTSIDE_RUNTIME' });
  const dir = join(root, project);
  rejectLink(dir);
  mkdirSync(dir, { recursive: true });
  const real = realpathSync.native(dir);
  if (!inside(realRoot, real)) throw Object.assign(new Error(`digest folder ${dir} resolves outside the runtime folder`), { code: 'OUTSIDE_RUNTIME' });
  const file = join(real, 'DIGEST.md');
  rejectLink(file);
  return file;
}

// PR112-1: the pass summary uses the same temp-file + rename replacement as the digest, so an existing
// symlink or hard link at the final name is replaced, never written through.
function writeSummary(rt, pass) {
  const file = join(rt, 'forge-dispatch-last.json');
  rejectLink(file);
  const temp = join(rt, `.summary-${randomUUID()}.tmp`);
  let created = false;
  try {
    const fd = openSync(temp, 'wx'); created = true;
    try { writeFileSync(fd, JSON.stringify(pass, null, 2)); } finally { closeSync(fd); }
    renameSync(temp, file);
  } finally { if (created) rmSync(temp, { force: true }); }
}

function writeDigest(rt, project, digest) {
  // Revalidate after the awaited coordinator. Rename replaces a directory entry,
  // so a final-file link swapped after validation cannot redirect the write.
  const file = digestDir(rt, project);
  const temp = join(dirname(file), `.digest-${randomUUID()}.tmp`);
  let created = false;
  try {
    const fd = openSync(temp, 'wx'); created = true;
    try { writeFileSync(fd, digest); } finally { closeSync(fd); }
    if (digestDir(rt, project) !== file) throw new Error('digest directory changed while writing');
    renameSync(temp, file);
  } finally { if (created) rmSync(temp, { force: true }); }
  return file;
}

// F4: ownership-safe portfolio lock.
// PR112-4: the real OS start time, or null (liveness is then unknown and the lock is retained) -- never
// derived from wall clock minus uptime, which drifts after suspend or a clock change.
const myStartMs = (deps = {}) => { try { const t = (deps.processStartMs ?? D.processStartMs)(process.pid); return Number.isFinite(t) && t > 0 ? t : null; } catch { return null; } };
function takeGuard(lp) {
  const guard = `${lp}.guard`;
  try { mkdirSync(guard); return guard; }
  catch (e) { if (e.code === 'EEXIST') return null; throw e; }
}
function acquireLock(rt, deps) {
  const lp = join(rt, `${PORTFOLIO_LOCK}.run.lock`);
  mkdirSync(rt, { recursive: true });
  const token = randomUUID();
  const body = JSON.stringify({ pid: process.pid, startedMs: myStartMs(deps), startedAt: new Date().toISOString(), token });
  // Every lock mutation, including release, uses this short-lived exclusive guard.
  // Never reclaim the guard automatically: an interrupted mutation requires owner reconciliation.
  const guard = takeGuard(lp);
  if (!guard) return { ok: false, reason: 'pass lock mutation guard is held; recovery status is unknown', onlyYou: `If ${lp}.guard persists, remove it only after confirming all forge-dispatch passes have stopped` };
  try {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { const fd = openSync(lp, 'wx'); try { writeFileSync(fd, body); } finally { closeSync(fd); } return { ok: true, lp, token }; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    let raw = null, holder = null;
    try { raw = readFileSync(lp, 'utf8'); holder = JSON.parse(raw); } catch { holder = null; }
    if (!holder?.pid) return { ok: false, reason: `pass lock ${lp} is unreadable; its owner is unknown`, onlyYou: `Remove ${lp} only after confirming no forge-dispatch pass is running` };
    let life;
    try { life = (deps.processLiveness ?? D.processLiveness)({ pid: holder.pid, startedAtMs: holder.startedMs ?? null }); }
    catch { life = { state: 'unknown' }; }
    if (life?.state === 'live') return { ok: false, reason: `pass lock held by a live pass (pid ${holder.pid}, since ${holder.startedAt ?? 'unknown'})` };
    if (life?.state !== 'dead') return { ok: false, reason: `pass lock owner has unknown liveness (pid ${holder.pid}); retaining lock`, onlyYou: `Resolve process identity lookup before recovering ${lp}` };
    // Proven abandoned: remove it only if it is still the same holder we examined.
    let again = null; try { again = readFileSync(lp, 'utf8'); } catch { again = null; }
    if (again === raw) rmSync(lp, { force: true });
  }
  return { ok: false, reason: 'pass lock changed hands while recovering an abandoned lock; skipping this pass' };
  } finally { rmdirSync(guard); }
}
function releaseLock(lock) {
  const guard = takeGuard(lock.lp);
  if (!guard) return; // Leave the lock in place; never race another mutation.
  try {
  let cur = null; try { cur = JSON.parse(readFileSync(lock.lp, 'utf8')); } catch { cur = null; }
  if (cur?.token === lock.token) rmSync(lock.lp, { force: true });
  } finally { rmdirSync(guard); }
}

// M2's explicitly scoped attended coordinator-output adapter. Already-rendered
// snapshots avoid calling unqualified project/ledger/Git helpers under a fence.
// The legacy discovery pass below is NOT upgraded to a strict runtime fence by
// this milestone. No CLI/environment switch provisions this native capability.
async function runFencedOutputPass({env,now,deps}) {
  const rt=fenceRuntime(deps.fence);
  if(resolve(D.runtimeDir(env))!==rt)throw new Error('fence runtime mismatch');
  if(!Array.isArray(deps.prepared)||deps.prepared.length>64)throw new Error('bounded prepared coordinator output required');
  const prepared=structuredClone(deps.prepared),seen=new Set();
  for(const p of prepared){assertDigestProject(p.project);const key=p.project.toLowerCase();if(seen.has(key)||typeof p.digest!=='string'||Buffer.byteLength(p.digest)>1024*1024)throw new Error('invalid prepared output');seen.add(key);}
  const pass={at:new Date(now).toISOString(),mode:'shadow',fenceScope:'attended-coordinator-output',projects:[],onlyYou:[],ownerItems:0,notifications:notificationStatus()};
  let lock;
  try{
    lock=await takeFencedPortfolioLock(deps.fence);
    for(const item of prepared){
      await deps.afterPrepared?.(item); // pure preparation/test barrier outside the mutation gate
      const digest=await withFencedEffect(deps.fence,()=>writeDigest(rt,item.project,item.digest));
      pass.projects.push({project:item.project,digest});
    }
    await withFencedEffect(deps.fence,()=>writeSummary(rt,pass));
  }catch(e){
    if(['PAUSED','STALE','UNKNOWN'].includes(e.code)){pass.stopped=true;pass.reason=e.message;pass.fenced=false;}
    else throw e;
  }finally{
    if(lock){try{pass.cleanup=await releaseFencedPortfolioLock(deps.fence,lock);}catch(e){pass.cleanup={released:false,reason:e.message};}}
  }
  return pass;
}
function refusePauseRequest(rt) {
  if(inspectPauseRequest(rt).state!=='ALLOW')throw Object.assign(new Error('STOP present or inspection unknown; later shadow effects refused'),{code:'PAUSE_REQUEST'});
}
export async function runPass({ env = process.env, now = Date.now(), deps = {} } = {}) {
  if(deps.fence) return runFencedOutputPass({env,now,deps});
  const rt = D.runtimeDir(env);
  const at = new Date(now).toISOString();
  if (inspectPauseRequest(rt).state!=='ALLOW') return { at, notifications: notificationStatus(), stopped: true, fenced: false, reason: `STOP file present at ${D.stopFile(rt)}`, projects: [], onlyYou: [], ownerItems: 0 };
  let pausedReported=false;
  const lock = acquireLock(rt, deps);
  if (!lock.ok) return { at, notifications: notificationStatus(), skipped: true, interventionRequired: Boolean(lock.onlyYou), reason: lock.reason, projects: [], onlyYou: lock.onlyYou ? [lock.onlyYou] : [], ownerItems: lock.onlyYou ? 1 : 0 };
  try {
    const portfolio = enrolled(rt);
    const pass = { at, mode: 'shadow', projects: [], onlyYou: [], notifications: notificationStatus() };
    if (portfolio.error) pass.onlyYou.push(`Fix ${portfolio.path}: ${portfolio.error}`);
    for (const m of portfolio.errors) pass.onlyYou.push(`Fix ${portfolio.path}: ${m}; nothing in it is enrolled`);
    for (const r of portfolio.refused) pass.onlyYou.push(`Fix ${portfolio.path}: portfolio.json entry #${r.index + 1} refused: ${r.reason}`);
    const executeRefusal = portfolio.mode === 'execute' ? `portfolio.json asks for mode "execute"; refused (EXECUTION_DISABLED): ${EXECUTION_DISABLED_REASON}` : null;
    if (executeRefusal) pass.onlyYou.push(executeRefusal);
    if (!portfolio.entries.length && !portfolio.refused.length && !portfolio.errors.length) pass.onlyYou.push(`No projects are enrolled: add {"projects": [{"id": "<project-id>", "stateRoot": "<path>"}]} to ${portfolio.path}`);
    const seen = new Set();
    // Every entry is reported in its original order; refused ones carry their reason and run nothing.
    const ordered = [...portfolio.entries.map((e) => ({ ...e })), ...portfolio.refused.map((r) => ({ ...r, refusedReason: r.reason }))].sort((a, b) => a.index - b.index);
    for (const item of ordered) {
      if(inspectPauseRequest(rt).state!=='ALLOW'){pass.stopped=true;pass.fenced=false;pass.reason='STOP request observed';pausedReported=true;break;}
      const stateRoot = item.input;
      const entry = { stateRoot, project: typeof stateRoot === 'string' ? basename(stateRoot) : '(invalid)' };
      if (item.refusedReason) { entry.error = `REFUSED: ${item.refusedReason}`; pass.projects.push(entry); deps.afterProject?.(entry); continue; }
      entry.canonical = item.canonical;
      try {
        // S5-A: identity can change after validation; recheck immediately before the first project read.
        const changed = revalidate(item);
        if (changed) throw Object.assign(new Error(changed), { code: 'REFUSED' });
        // F2: the dispatcher's preflight would run the project's configured CLI; a shadow pass refuses instead.
        const dispatchDeps = { ...(deps.dispatchDeps ?? {}), preflight: () => ({ ok: false, reason: SHADOW_PREFLIGHT_REASON }) };
        const dispatch = await (deps.runOnce ?? runOnce)({ stateRoot, execute: false, env, now, deps: dispatchDeps });
        refusePauseRequest(rt);
        // PR112-3: a STOP created after the pass-level check is honoured: keep the reason, write no digest, run no further project.
        if (dispatch?.stopped) { pausedReported=true; pass.fenced=false; pass.stopped = true; pass.reason = dispatch.reason; entry.stopped = dispatch.reason; pass.projects.push(entry); deps.afterProject?.(entry); break; }
        const name = String(dispatch.project ?? entry.project);
        assertDigestProject(name); // Validate the name without creating output directories.
        const key = name.toLowerCase();
        if (seen.has(key)) throw Object.assign(new Error(`project name ${name} collides with another enrolled project in this pass`), { code: 'BAD_PROJECT' });
        if (dispatch.enrollmentRefused) throw Object.assign(new Error(dispatch.onlyYou.join('; ')), { code: 'ENROLLMENT_REFUSED' });
        seen.add(key);
        refusePauseRequest(rt);
        digestDir(rt, name); // Validate output containment before coordinating.
        entry.project = name;
        entry.dispatch = { mode: dispatch.mode, planned: dispatch.planned ?? [], launched: dispatch.launched ?? [], refused: dispatch.refused ?? [], onlyYou: dispatch.onlyYou ?? [], workerActions: [...new Set(dispatch.workerActions ?? [])] };
        // F3: the digest renders this pass's items, dated, in place of any older last-run file.
        const onlyYou = [...new Set([...(executeRefusal ? [executeRefusal] : []), ...entry.dispatch.onlyYou])];
        const workerActions = [...new Set([...entry.dispatch.workerActions, ...entry.dispatch.refused.map((x) => `${x.task}: not launched (${x.reason})`)])];
        entry.ownerItems = onlyYou.length;
        const currentRun = { at, mode: 'shadow', onlyYou, workerActions };
        const { digest } = await (deps.coordinate ?? coordinate)({ stateRoot, dryRun: true, now, env, deps: { currentRun } });
        refusePauseRequest(rt);
        entry.digest = writeDigest(rt, name, digest);
      } catch (e) {
        entry.error = `${e.code || 'ERROR'}: ${e.message}`;
        if(e.code==='PAUSE_REQUEST'){pass.stopped=true;pass.fenced=false;pass.reason=e.message;pausedReported=true;}
      }
      pass.projects.push(entry);
      deps.afterProject?.(entry);
      if(pass.stopped)break;
    }
    // Portfolio-level items once, plus each project's own current items (the execute refusal is not double counted).
    pass.ownerItems = pass.onlyYou.length + pass.projects.reduce((n, p) => n + new Set(p.dispatch?.onlyYou ?? []).size, 0);
    if(!pass.stopped) {
      try {
        refusePauseRequest(rt); writeSummary(rt,pass);
        refusePauseRequest(rt); D.log(rt,PORTFOLIO_LOCK,`forge-dispatch shadow pass: ${pass.projects.length} project(s), ${pass.ownerItems} owner item(s)`);
      }catch(e){if(e.code!=='PAUSE_REQUEST')throw e;pass.stopped=true;pass.fenced=false;pass.reason=e.message;pausedReported=true;}
    }
    return pass;
  } finally { if(!pausedReported&&inspectPauseRequest(rt).state==='ALLOW')releaseLock(lock); }
}

export async function main(argv, { out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`), env = process.env } = {}) {
  if (argv.length) { err('usage: node scripts/forge-dispatch.mjs   (no arguments; reads <runtime>/portfolio.json)'); return 2; }
  try {
    const r = await runPass({ env });
    if (r.skipped && r.interventionRequired) {
      // PR112-2: a wedged lock needs the owner; fail the routine (nonzero exit + instruction on stderr) instead of
      // a quiet success. Re-review R1: this pass owns no lock, so it writes NOTHING to disk -- an append to
      // dispatch.log would follow a hard link or symlink at that name to a file outside the runtime folder.
      for (const l of r.onlyYou) err(`forge-dispatch: ${l}`);
      err(`forge-dispatch: ${r.reason}`);
      return 1;
    }
    if (r.stopped || r.skipped) { out(`forge-dispatch: ${r.reason}`); return 0; }
    out(`forge-dispatch ${r.mode} pass: ${r.projects.length} project(s), ${r.projects.filter((p) => p.error).length} error(s), ${r.ownerItems} owner item(s)`);
    return 0;
  } catch (e) { err(`forge-dispatch ERROR ${e.code || ''} ${e.message}`); return 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
