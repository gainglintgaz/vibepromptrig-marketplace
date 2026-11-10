#!/usr/bin/env node
// dispatch.mjs -- `forge dispatch` (HH-ORCH-03 step B). Zero AI inside; plain code moves state.
// Justified: orchestrates the local claude/codex CLIs over coord-state/1 under an owner authorization file; no MCP server or Skill provides this.
//
//   forge dispatch run --root <stateRoot> [--execute]   one dry-run pass; --execute is refused (below)
//   forge dispatch status --root <stateRoot>
//   forge dispatch stop <task>|--all --root <stateRoot>  kill the worker tree, task -> blocked
//   forge dispatch pause | resume                        create/remove the STOP file (all projects)
//   forge dispatch confirm-auth --root <stateRoot>       owner confirms the current authorization file
//   forge dispatch auth init <project>                   write a DRAFT, unconfirmed authorization file (never overwrites)
//   forge dispatch auth show <project>                   read-only: state, lanes, hash; never prints file contents
//   forge dispatch auth confirm <project> [--sha256 <hex>]  owner confirms the exact bytes now on disk (a draft is refused)
//   forge dispatch config-template --project <name> ...  print a dispatch.json with resolved CLI paths
//
// Unattended execution is DISABLED (HH-ORCH-03 amendment v1, owner-approved 2026-10-09): every
// --execute pass refuses with EXECUTION_DISABLED before it reads the STOP file, takes the run lock,
// opens the ledger, touches STATE.json or a worktree, runs a preflight or spawns anything. There is no
// flag, environment variable or dependency switch that skips the refusal; re-enabling it is a reviewed
// code change in HH-ORCH-04 once S4 (enforced isolation) and S5 (portfolio enrollment) exist. The
// execute-pass code below is kept for that change and is unreachable until then.
//
// Order of an --execute pass (when re-enabled): STOP file -> project run lock -> config -> authorization hash ->
// collect finished workers (state change first, ledger finalized after) -> release expired leases
// (never a live PID) -> promote -> launch ready tasks; each launch reserves budget inside one
// SQLite IMMEDIATE transaction shared by every project. A dry run reads a temporary copy of the
// ledger and changes nothing: no STATE.json, ledger, authorization view, log or report writes.
// Exit 0 ok (including "nothing to do"), 1 refused/failed, 2 usage.

import { lstatSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from './state-lib.mjs';
import * as D from './dispatch-lib.mjs';
import { inspectRoot, rootSyntaxError } from './portfolio-policy.mjs';

const readText = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const escapeRe = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Finding 7: every state change applyOutcome makes names its run id, so a pass that crashed between the
// state change and the ledger update can recognise its own result and finalise without replaying it.
function alreadyApplied(task, runId) {
  if (!task) return false;
  if (task.result?.runId === runId) return true;
  return task.stage === 'blocked' && new RegExp(`\\(run ${escapeRe(runId)}[;)]`).test(String(task.note || ''));
}

function chargeFor(row, exitInfo, now) {
  const exitMs = exitInfo?.exitAt ? Date.parse(exitInfo.exitAt) : null;
  return exitMs
    ? { status: 'exited', exitAt: exitInfo.exitAt, charged: Math.max(1, Math.ceil((exitMs - row.started_ms) / 60_000)), basis: 'elapsed, conservative' }
    : { status: 'crashed', exitAt: new Date(now).toISOString(), charged: row.timebox_min, basis: 'unknown: died without exit record, charged full timebox' };
}
function finalize(db, row, charge, exitInfo) {
  db.prepare('UPDATE runs SET status = ?, exit_at = ?, exit_code = ?, charged_min = ?, charge_basis = ? WHERE id = ?')
    .run(charge.status, charge.exitAt, exitInfo?.exitCode ?? null, charge.charged, charge.basis, row.id);
}

// Decide what a finished or dead worker means for its task, and apply it to STATE.json. Returns the
// outcome. Throws if STATE.json cannot be changed (paused, locked): the caller then leaves the ledger
// row 'running' so the next pass retries (review P2: no lost results).
function applyOutcome({ stateRoot, base, cfg, row, finished, exitInfo, report, deps }) {
  const outDir = row.result_path;
  if (!finished) {
    S.block(stateRoot, { ...base, task: row.task, reason: `worker died without an exit record (run ${row.id}); output in ${outDir}` });
    report.workerActions.push(`${row.task}: inspect crashed run ${outDir}, then unblock`);
    return { outcome: 'crashed' };
  }
  const parsed = D.parseResult(cfg.agents[row.agent]?.kind === 'claude-code' ? 'claude-json' : 'codex-file', readText(join(outDir, 'stdout.txt')), readText(join(outDir, 'result.json')));
  if (exitInfo.timedOut) { S.block(stateRoot, { ...base, task: row.task, reason: `worker hit its ${row.timebox_min}-minute timebox (run ${row.id})` }); return { outcome: 'timeout', parsed }; }
  if (!parsed.ok || exitInfo.exitCode !== 0) {
    S.block(stateRoot, { ...base, task: row.task, reason: `worker exit ${exitInfo.exitCode}; ${parsed.ok ? 'result present' : parsed.reason}; raw output ${outDir} (run ${row.id})` });
    report.workerActions.push(`${row.task}: read ${outDir} and decide repair or unblock`);
    return { outcome: 'blocked', parsed };
  }
  if (parsed.result.status === 'blocked') {
    S.block(stateRoot, { ...base, task: row.task, reason: `worker reported BLOCKED (run ${row.id}); details in ${outDir}` });
    return { outcome: 'blocked-by-worker', parsed };
  }
  // Lane gate: every changed file (since the base pinned at launch) must be inside the owned paths, and a
  // task without edit-owned-paths may change nothing. The dispatcher never commits for a worker (delta
  // review 2): committing without hooks bypasses trusted gates, and committing with them can execute
  // worker-edited code. Uncommitted owned edits wait for a supervised commit with every gate intact.
  const taskNow = S.readState(stateRoot).tasks.find((t) => t.id === row.task);
  const actions = JSON.parse(row.actions || '[]');
  let gate = null;
  try {
    const { files } = D.changedFiles(row.worktree, row.base_sha, deps.git);
    const allowed = actions.includes('edit-owned-paths') ? (taskNow?.paths || []) : [];
    const outside = files.filter((f) => !S.pathOwnedBy(f, allowed));
    if (outside.length) gate = `worker changed files it was not granted: ${outside.slice(0, 8).join(', ')}`;
    else if (D.hasUncommitted(row.worktree, deps.git)) gate = actions.includes('local-commit')
      ? 'supervised commit required: the worker left uncommitted owned-path edits; the dispatcher does not commit (gates must run, worker-edited code must not), so commit them under supervision'
      : 'commit not granted: the worker left uncommitted owned-path edits and the run lacks local-commit';
  } catch (e) { gate = `${e.code || 'GIT'}: ${e.message}`; }
  if (gate) {
    S.block(stateRoot, { ...base, task: row.task, reason: `${gate} (run ${row.id}; worktree ${row.worktree} kept for inspection)` });
    report.workerActions.push(`${row.task}: inspect ${row.worktree}; ungranted changes were not committed`);
    return { outcome: 'blocked-lane-gate', parsed };
  }
  // Verify the worker's commit claims against git before recording anything (no trust in prose).
  const g = (args) => (deps.git ?? spawnSync)('git', ['-C', row.worktree, ...args], { encoding: 'utf8', windowsHide: true });
  const head = g(['rev-parse', 'HEAD']);
  const headSha = head.status === 0 ? head.stdout.trim() : '';
  const missing = parsed.result.commits.filter((c) => g(['cat-file', '-e', `${c}^{commit}`]).status !== 0);
  if (!/^[0-9a-f]{40}$/.test(headSha) || missing.length) {
    S.block(stateRoot, { ...base, task: row.task, reason: `worker claimed commits that git cannot find in ${row.worktree}: ${missing.join(', ') || 'HEAD unreadable'} (run ${row.id})` });
    return { outcome: 'blocked-unverified-commits', parsed };
  }
  S.recordResult(stateRoot, { ...base, task: row.task, agent: row.agent, worktree: row.worktree, runId: row.id, result: parsed.result, headSha });
  report.workerActions.push(`${row.task}: independent review of ${headSha.slice(0, 12)} (reviewer = the other agent)`);
  return { outcome: 'review', parsed };
}

// Codex delta review 2 of 9497ea6, findings 4 and 5: without an enforced isolation boundary the
// dispatcher cannot contain what a worker executes, and without portfolio enrollment it cannot see
// another project's outside-ledger worker. Capability disabled with a tested refusal; not fixed.
// HH-ORCH-04 S4-D (owner-selected 2026-10-09): no isolated check runner exists, so execution, unattended test
// runs and unattended edits stay disabled. There is no config key, environment variable or flag that changes this;
// enabling it needs a separately approved, natively tested runner (S4-W) plus S5 enrollment, as a reviewed code change.
export const EXECUTION_DISABLED_REASON = 'unattended dispatch --execute is disabled: no isolated check runner exists (HH-ORCH-04 S4-D, explicit disabled fallback); enabling it needs a separately approved, natively tested runner and S5 enrollment; dry run, status, stop, auth and the coordinator digest still work';
export const CHECKS_NOT_RUN = 'checks are not run by the dispatcher: run-tests and edit-owned-paths stay disabled for unattended workers (no isolated check runner, HH-ORCH-04 S4-D)';

function denyPortfolio(portfolio, reason) {
  return { ...portfolio, valid: false, enrollmentRefused: true, errors: [...portfolio.errors, reason], capMinutes: null, maxWorkers: null, timezone: null };
}

export function portfolioAtRoot(rt, stateRoot) {
  const portfolio = D.readPortfolio(rt);
  // Enrollment identity is checked even when its independent budget policy is incomplete.
  const syntax = rootSyntaxError(stateRoot);
  const root = syntax ? { reason: syntax } : inspectRoot(stateRoot);
  if (root.reason) return denyPortfolio(portfolio, `requested root refused: ${root.reason}`);
  const entry = portfolio.entries.find(e => e.canonical === root.canonical);
  return entry ? { ...portfolio, entry } : denyPortfolio(portfolio, 'requested root is not enrolled in this portfolio');
}

function policyRefusal(portfolio, now, project = portfolio.entry?.id ?? null) {
  const reason = `portfolio policy invalid or incomplete: ${portfolio.errors.join('; ')}`;
  return { project, enrollmentRefused: portfolio.enrollmentRefused === true, at: new Date(now).toISOString(), mode: 'dry-run',
    execution: `disabled: ${EXECUTION_DISABLED_REASON}`, collected: [], released: [], promoted: [], launched: [], planned: [], refused: [], workerActions: [],
    onlyYou: [`Fix the portfolio cap, slots, timezone and enrollment in ${portfolio.path}: ${reason}`],
    budget: { day: null, timezone: null, projectUsed: null, projectCap: null, portfolioUsed: null, portfolioCap: null,
      portfolioMaxWorkers: null, basis: 'unknown: valid enrolled project policy required' } };
}
export async function runOnce({ stateRoot, execute = false, env = process.env, now = Date.now(), deps = {} }) {
  if (execute) throw new S.StateError('EXECUTION_DISABLED', EXECUTION_DISABLED_REASON);
  // R3: Mac/Linux process-group cleanup (report findings 9 and 10) is not fixed, so only Windows may
  // launch workers. Dry runs work everywhere.
  if (execute && (deps.platform ?? process.platform) !== 'win32') throw new S.StateError('PLATFORM', 'dispatch --execute is Windows-only until report findings 9 and 10 (Mac/Linux process cleanup) are fixed; a dry run is available');
  const rt = D.runtimeDir(env);
  if (existsSync(D.stopFile(rt))) return { stopped: true, reason: `STOP file present at ${D.stopFile(rt)}` };
  const portfolio = portfolioAtRoot(rt, stateRoot);
  if (portfolio.enrollmentRefused) return policyRefusal(portfolio, now);
  const cfg = D.loadConfig(stateRoot);
  if (cfg.project !== portfolio.entry.id || S.readState(stateRoot).project !== portfolio.entry.id) return policyRefusal(denyPortfolio(portfolio, 'configured or STATE project identity does not match enrollment id'), now, cfg.project);
  if (!portfolio.valid) return policyRefusal(portfolio, now);
  const pass = async () => {
    const db = execute ? await D.openLedger(rt) : await D.openLedgerCopy(rt);
    try {
      const base = { metricsPath: deps.metricsPath ?? null, now: () => now };
      const report = { project: cfg.project, at: new Date(now).toISOString(), mode: execute ? 'execute' : 'dry-run', execution: `disabled: ${EXECUTION_DISABLED_REASON}`, collected: [], released: [], promoted: [], launched: [], planned: [], refused: [], onlyYou: [], workerActions: [], budget: {} };
      const isAliveRow = (row) => (deps.isAlive ?? D.isAlive)({ pid: row.pid, startedAtMs: row.started_ms });

      // 1. Authorization: present, not revoked, and its exact bytes confirmed by the owner.
      const auth = D.readAuthorization(cfg.project, env);
      let authBlocked = false;
      if (!auth.present) { authBlocked = true; report.onlyYou.push(`Create the authorization file ${auth.path} (no lane is granted yet)`); }
      else {
        if (auth.draft) { authBlocked = true; report.onlyYou.push(`Authorization file ${auth.path} is a DRAFT and grants nothing. Edit it, remove "draft", then run: forge dispatch auth confirm ${cfg.project}`); }
        if (execute) {
          mkdirSync(D.authDir(env), { recursive: true });
          writeFileSync(auth.path.replace(/\.json$/, '.md'), D.renderAuthorizationMd(auth, cfg.project));
        }
        const row = db.prepare('SELECT confirmed_at FROM auth_hashes WHERE project = ? AND sha256 = ?').get(cfg.project, auth.sha256);
        if (!row) db.prepare('INSERT INTO auth_hashes (project, sha256, seen_at) VALUES (?, ?, ?)').run(cfg.project, auth.sha256, new Date(now).toISOString());
        if (!row?.confirmed_at) { authBlocked = true; report.onlyYou.push(`Authorization file changed (sha256 ${auth.sha256.slice(0, 12)}). Review ${execute ? auth.path.replace(/\.json$/, '.md') : `${auth.path} (the readable view is regenerated on the next execute pass)`}, then run: forge dispatch confirm-auth --root "${stateRoot}"`); }
        if (auth.revoked) { authBlocked = true; report.onlyYou.push('Authorization file is revoked; no new dispatches'); }
      }

      // 2. Collect workers that were running at the end of the last pass.
      for (const row of db.prepare("SELECT * FROM runs WHERE project = ? AND status = 'running'").all(cfg.project)) {
        let exitInfo = null;
        try { exitInfo = JSON.parse(readText(join(row.result_path, 'exit.json')) || 'null'); } catch { exitInfo = null; }
        const finished = exitInfo?.state === 'exited';
        // Finding 14: a crash between spawn and the PID update leaves pid NULL; the wrapper records its
        // own PID and start time in exit.json at start, so adopt them instead of declaring a crash.
        let adopt = exitInfo?.wrapperPid ? { pid: exitInfo.wrapperPid, startedMs: Date.parse(exitInfo.startedAt) || row.started_ms } : null;
        if (!row.pid && !adopt) {
          // Review delta finding 3: no PID and no exit record yet. Look the wrapper up by its spec file;
          // if the process table cannot be read, liveness is unknown and the reservation is held.
          try { adopt = (deps.findWrapper ?? D.findWrapper)(join(row.result_path, 'spec.json')); }
          catch (e) { report.workerActions.push(`${row.task}: run ${row.id} has unknown liveness (no PID, no exit record, ${e.message}); reservation held`); continue; }
        }
        if (!row.pid && adopt) {
          const startedMs = adopt.startedMs || row.started_ms;
          if (execute) db.prepare('UPDATE runs SET pid = ?, started_ms = ? WHERE id = ?').run(adopt.pid, startedMs, row.id);
          row.pid = adopt.pid; row.started_ms = startedMs;
        }
        if (!finished && isAliveRow(row)) {
          if (execute) {
            try { S.heartbeat(stateRoot, { ...base, task: row.task, agent: row.agent, worktree: row.worktree, minutes: Math.min(row.timebox_min + 15, S.LEASE_MAX_MIN), allowExpired: true }); }
            catch (e) { report.workerActions.push(`${row.task}: lease heartbeat failed (${e.code || e.message}); worker still running`); }
          }
          continue;
        }
        const charge = chargeFor(row, finished ? exitInfo : null, now);
        if (!execute) { report.collected.push({ task: row.task, runId: row.id, outcome: 'would collect', charged: charge.charged }); continue; }
        if (alreadyApplied(S.readState(stateRoot).tasks.find((t) => t.id === row.task), row.id)) {
          finalize(db, row, charge, finished ? exitInfo : null);
          report.collected.push({ task: row.task, runId: row.id, agent: row.agent, charged: charge.charged, basis: charge.basis, outcome: 'finalized-already-applied' });
          continue;
        }
        let outcome;
        try { outcome = applyOutcome({ stateRoot, base, cfg, row, finished, exitInfo, report, deps }); }
        catch (e) { report.collected.push({ task: row.task, runId: row.id, outcome: 'deferred', reason: `${e.code || ''} ${e.message}`.trim() }); continue; }
        finalize(db, row, charge, finished ? exitInfo : null);
        const cost = outcome.parsed?.costUsd;
        db.prepare('UPDATE runs SET cost_usd = ?, cost_basis = ? WHERE id = ?').run(typeof cost === 'number' ? cost : null, typeof cost === 'number' ? 'reported by CLI' : 'unknown', row.id);
        report.collected.push({ task: row.task, runId: row.id, agent: row.agent, charged: charge.charged, basis: charge.basis, outcome: outcome.outcome });
      }

      // 3-4. Leases that expired with a dead worker go back to ready; then promote.
      const runningByTask = new Map(db.prepare("SELECT * FROM runs WHERE project = ? AND status = 'running'").all(cfg.project).map((r) => [r.task, r]));
      const projectHolds = D.dispatchHolds(db, { project: cfg.project });
      const heldTasks = new Set(projectHolds.taskIds);
      if (execute) {
        // A running ledger row keeps its lease, PID or not (finding 15). A lease PID taken outside the
        // ledger (forge state lease --pid) keeps it while that process lives (finding 16).
        const leaseAlive = (lease, t) => heldTasks.has(t.id) || (lease.pid ? (deps.isAlive ?? D.isAlive)({ pid: lease.pid, startedAtMs: null }) : false);
        report.released = S.releaseExpired(stateRoot, { ...base, graceMinutes: cfg.leaseGraceMinutes ?? 30, isAlive: leaseAlive });
        if (!S.readState(stateRoot).paused) report.promoted = S.promote(stateRoot, base);
      }

      // 5. Budget. Unknown usage is charged as full timebox, never zero.
      const accountingTz = portfolio.timezone;
      const day = D.dayKey(now, accountingTz);
      let portfolioCap = portfolio.capMinutes;
      if (portfolioCap === null) report.onlyYou.push(`Set the portfolio cap: create ${portfolio.path} with {"capMinutes": <n>, "maxWorkers": 1, "timezone": "${D.DEFAULT_PORTFOLIO_TIMEZONE}"} (no launches without it)`);
      if (portfolio.present && (portfolio.maxWorkers === null || portfolio.timezone === null)) { portfolioCap = null; report.onlyYou.push(`Fix ${portfolio.path}: maxWorkers must be a positive integer and timezone a valid IANA zone (no launches until fixed)`); }
      const portfolioWorkers = portfolio.maxWorkers;
      // Review delta finding 4: a live lease taken outside the ledger (forge state lease --pid) holds a
      // slot and its timebox of unknown effort until it is released or reconciled. Only this project's
      // STATE.json is visible here; other projects' outside leases are not (recorded gap).
      const external = [];
      for (const t of S.readState(stateRoot).tasks) {
        if (t.stage !== 'active' || !t.lease?.pid || heldTasks.has(t.id)) continue;
        if (!(deps.isAlive ?? D.isAlive)({ pid: t.lease.pid, startedAtMs: null })) continue;
        const hold = S.validTimebox(t.timeboxMin ?? cfg.defaultTimeboxMin ?? 30) ?? S.LEASE_MAX_MIN;
        external.push({ task: t.id, pid: t.lease.pid, hold });
        report.onlyYou.push(`${t.id} has a live lease outside the dispatch ledger (pid ${t.lease.pid}); its slot and ${hold} min are held until it is released or reconciled`);
      }
      const externalMin = external.reduce((n, x) => n + x.hold, 0);
      report.budget = { day, timezone: accountingTz, projectUsed: D.usedMinutes(db, { project: cfg.project, day }) + externalMin, projectCap: cfg.dailyCapMinutes, portfolioUsed: D.usedMinutes(db, { day }) + externalMin, portfolioCap, portfolioMaxWorkers: portfolioWorkers, outsideLedgerHolds: external, basis: 'elapsed, conservative (running workers and outside-ledger leases count at full timebox)' };

      // 6. Launch.
      // Slots: this project's maxWorkers AND the portfolio-wide maxWorkers, counting every running row in
      // the shared ledger (R2). The authoritative check repeats inside the reservation transaction.
      const runningAll = D.dispatchHolds(db).capacity;
      let slots = Math.min(cfg.maxWorkers - projectHolds.capacity - external.length, portfolioWorkers - runningAll - external.length);
      let plannedMinutes = 0;
      const preflightCache = new Map();
      const state = S.readState(stateRoot);
      const ready = state.tasks.filter((t) => t.stage === 'ready').sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || a.id.localeCompare(b.id));
      for (const task of ready) {
        const refuse = (reason, onlyYou = null) => { report.refused.push({ task: task.id, reason }); if (onlyYou) report.onlyYou.push(onlyYou); };
        if (heldTasks.has(task.id)) { refuse('task has an unreconciled dispatch or manual claim'); continue; }
        if (slots <= 0) { refuse(projectHolds.capacity + external.length >= cfg.maxWorkers ? `MaxWorkers ${cfg.maxWorkers} reached` : `portfolio maxWorkers ${portfolioWorkers} reached`); continue; }
        if (state.paused) { refuse('STATE.json paused'); continue; }
        const agentCfg = cfg.agents[task.owner];
        if (!agentCfg) { refuse(`no agent config for owner ${task.owner}`); continue; }
        if (authBlocked) { refuse('authorization not confirmed'); continue; }
        const grant = D.grantFor(auth, task, { allowEditWorkers: deps.allowEditWorkers === true });
        // S4-D: an action disabled in code (run-tests, unattended edits) cannot be fixed by a grant, so the owner
        // is told that plainly instead of being asked to grant the lane.
        // Decided from the task's requested actions, not from grant.reason, so it holds whether or not the lane has
        // a grant (review F1): grantFor reports a missing lane before it looks at disabled actions.
        const requested = task.workerActions && task.workerActions.length ? task.workerActions : D.DEFAULT_WORKER_ACTIONS;
        const blocked = requested.filter((a) => S.NEVER_GRANTABLE.includes(a) || D.DISABLED_ACTIONS[a] || (a === 'edit-owned-paths' && deps.allowEditWorkers !== true));
        const disabledInCode = blocked.length > 0;
        if (!grant.ok) { refuse(grant.reason, disabledInCode ? `${task.id} needs an action that is disabled in code; no grant can enable it (${blocked.join(', ')}). Run it supervised.` : `Grant lane ${task.lane} for ${task.id} in ${auth.path} (${grant.reason})`); continue; }
        if (portfolioCap === null) { refuse('portfolio cap not set'); continue; }
        const timebox = S.validTimebox(task.timeboxMin ?? cfg.defaultTimeboxMin ?? 30);
        if (timebox === null) { refuse(`invalid timebox ${task.timeboxMin ?? cfg.defaultTimeboxMin} (must be 1..${S.LEASE_MAX_MIN} minutes)`); continue; }
        if (!preflightCache.has(task.owner)) {
          const pf = (deps.preflight ?? D.preflight)(agentCfg);
          preflightCache.set(task.owner, pf);
          // Telemetry only: a busy ledger must not abort the pass.
          if (execute) { try { db.prepare('INSERT INTO preflights (project, agent, at, ok, detail) VALUES (?, ?, ?, ?, ?)').run(cfg.project, task.owner, new Date(now).toISOString(), pf.ok ? 1 : 0, pf.reason || pf.mode || null); } catch (e) { report.workerActions.push(`preflight record for ${task.owner} not saved (${e.message})`); } }
        }
        const pf = preflightCache.get(task.owner);
        if (!pf.ok) { refuse(`preflight: ${pf.reason}`, `${task.owner} preflight failed: ${pf.reason}`); continue; }
        if (!execute) {
          const used = D.usedMinutes(db, { project: cfg.project, day }) + plannedMinutes + externalMin, pUsed = D.usedMinutes(db, { day }) + plannedMinutes + externalMin;
          if (used + timebox > cfg.dailyCapMinutes) { refuse(`project cap: ${used}+${timebox} > ${cfg.dailyCapMinutes} min`); continue; }
          if (pUsed + timebox > portfolioCap) { refuse(`portfolio cap: ${pUsed}+${timebox} > ${portfolioCap} min`); continue; }
          report.planned.push({ task: task.id, agent: task.owner, actions: grant.actions, timebox }); slots -= 1; plannedMinutes += timebox; continue;
        }

        let worktree;
        try { ({ worktree } = D.ensureWorktree({ stateRoot, cfg, task, git: deps.git })); }
        catch (e) { refuse(`${e.code}: ${e.message}`, `Worktree problem for ${task.id}: ${e.message}`); continue; }
        let baseSha;
        try { baseSha = D.baseShaAtLaunch(worktree, cfg.baseRef, deps.git); }
        catch (e) { refuse(`${e.code}: ${e.message}`); continue; }
        const envFiles = D.envFilesUnder(worktree);
        if (envFiles.length) { refuse(`.env file(s) in worktree: ${envFiles.length}`, `Remove env files from ${worktree} before ${task.id} can run (Codex unelevated sandbox cannot deny reads)`); continue; }
        // Delta review 2, finding 5: an unattended worker can execute code (Codex runs commands even when
        // read-only). With no enforced isolation boundary (HH-ORCH-04 S4), it may only start on a worktree
        // that is exactly its trusted base: no unreviewed commits, no uncommitted or untracked files.
        const headRes = (deps.git ?? spawnSync)('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
        const headNow = headRes.status === 0 ? headRes.stdout.trim() : '';
        if (headNow !== baseSha || D.hasUncommitted(worktree, deps.git)) {
          refuse(`worktree ${worktree} holds unreviewed commits or changes beyond its base ${baseSha.slice(0, 12)}; an unattended worker could execute them (no enforced isolation yet)`, `Review or clear ${worktree} before ${task.id} can run unattended`);
          continue;
        }
        const runId = `${task.id}-${now}`;
        const outDir = join(rt, 'runs', cfg.project, runId);
        // Atomic reservation shared by every project (review P1): the budget check and the insert run in
        // one IMMEDIATE transaction on the shared ledger; the unique index allows one running row per task.
        let reserved = false;
        try {
          db.exec('BEGIN IMMEDIATE');
          const used = D.usedMinutes(db, { project: cfg.project, day }) + externalMin, pUsed = D.usedMinutes(db, { day }) + externalMin;
          const projRunning = D.dispatchHolds(db, {project:cfg.project}).capacity + external.length;
          const allRunning = D.dispatchHolds(db).capacity + external.length;
          if (D.dispatchHolds(db,{project:cfg.project}).taskIds.includes(task.id)) refuse('task has an unreconciled dispatch or manual claim');
          else if (projRunning >= cfg.maxWorkers) refuse(`MaxWorkers ${cfg.maxWorkers} reached`);
          else if (allRunning >= portfolioWorkers) refuse(`portfolio maxWorkers ${portfolioWorkers} reached`);
          else if (used + timebox > cfg.dailyCapMinutes) refuse(`project cap: ${used}+${timebox} > ${cfg.dailyCapMinutes} min`);
          else if (pUsed + timebox > portfolioCap) refuse(`portfolio cap: ${pUsed}+${timebox} > ${portfolioCap} min`);
          else {
            db.prepare("INSERT INTO runs (id, project, task, agent, worktree, pid, started_at, started_ms, timebox_min, status, result_path, sandbox_mode, day, actions, base_sha) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'running', ?, ?, ?, ?, ?)")
              .run(runId, cfg.project, task.id, task.owner, worktree, new Date().toISOString(), Date.now(), timebox, outDir, agentCfg.sandboxMode ?? null, day, JSON.stringify(grant.actions), baseSha);
            reserved = true;
          }
          db.exec('COMMIT');
        } catch (e) {
          try { db.exec('ROLLBACK'); } catch { /* no open transaction to roll back */ }
          refuse(/locked|busy/i.test(e.message) ? 'portfolio budget busy (another project is reserving); retry next pass' : `reservation failed: ${e.message}`);
          continue;
        }
        if (!reserved) continue;
        try { S.lease(stateRoot, { ...base, task: task.id, agent: task.owner, worktree, minutes: Math.min(timebox + 15, S.LEASE_MAX_MIN) }); }
        catch (e) { db.prepare('DELETE FROM runs WHERE id = ?').run(runId); refuse(`lease refused: ${e.code} ${e.message}`); continue; }
        const packDir = join(rt, 'runs', cfg.project, 'packs');
        const packed = S.pack(stateRoot, { ...base, task: task.id, outDir: packDir, contextPacket: deps.contextPacket ?? null });
        const launched = D.launchWorker({ rt, cfg, task: { ...task, timeboxMin: timebox }, agentName: task.owner, agentCfg, actions: grant.actions, worktree, packFile: packed.file, spawnImpl: deps.spawn, now, env });
        // Record the wrapper's real start time (review P1), not the pass timestamp.
        db.prepare('UPDATE runs SET pid = ?, started_at = ?, started_ms = ? WHERE id = ?').run(launched.pid ?? null, new Date(launched.startedMs).toISOString(), launched.startedMs, runId);
        S.heartbeat(stateRoot, { ...base, task: task.id, agent: task.owner, worktree, minutes: Math.min(timebox + 15, S.LEASE_MAX_MIN), pid: launched.pid ?? null });
        report.launched.push({ task: task.id, agent: task.owner, runId, pid: launched.pid, timebox, actions: grant.actions });
        D.log(rt, cfg.project, `launched ${task.id} as ${task.owner} pid ${launched.pid} timebox ${timebox}m`);
        slots -= 1;
      }

      if (execute) {
        mkdirSync(join(rt, 'runs', cfg.project), { recursive: true });
        writeFileSync(join(rt, 'runs', cfg.project, 'last-run.json'), JSON.stringify(report, null, 2));
        D.log(rt, cfg.project, `execute: collected ${report.collected.length}, launched ${report.launched.length}, refused ${report.refused.length}, only-you ${report.onlyYou.length}`);
      }
      return report;
    } finally { db.close(); }
  };
  return execute ? D.withRunLock(rt, cfg.project, pass, { now: () => now }) : pass();
}

export async function stop({ stateRoot, task = null, all = false, env = process.env, now = Date.now(), deps = {} }) {
  if (!task && !all) throw new S.StateError('USAGE', 'stop needs <task> or --all');
  const rt = D.runtimeDir(env);
  const cfg = D.loadConfig(stateRoot);
  // Serialized against launches (review P1): a stop never races an in-flight dispatch pass.
  const result = await D.withRunLock(rt, cfg.project, async () => {
    const db = await D.openLedger(rt);
    try {
      const rows = db.prepare("SELECT * FROM runs WHERE project = ? AND status = 'running'").all(cfg.project).filter((r) => all || r.task === task);
      const out = D.dispatchHolds(db,{project:cfg.project}).manual.filter(r=>all||r.task===task).map(r=>({...r,pid:null,killed:false,note:'manual session: send an owner stop request and reconcile separate holds; no PID kill'}));
      for (const r of rows) {
        // Verify identity before signalling (review P1): never kill a reused PID.
        const alive = r.pid ? (deps.isAlive ?? D.isAlive)({ pid: r.pid, startedAtMs: r.started_ms }) : false;
        if (!alive) { out.push({ task: r.task, pid: r.pid, killed: false, note: 'worker already exited or PID reused; left for the next pass to collect' }); continue; }
        const killed = (deps.killTree ?? D.killTree)(r.pid);
        if (!killed) { out.push({ task: r.task, pid: r.pid, killed: false, note: 'kill failed; run stays tracked as running' }); D.log(rt, cfg.project, `stop FAILED ${r.task} pid ${r.pid}`); continue; }
        const charged = Math.max(1, Math.ceil((Date.now() - r.started_ms) / 60_000));
        db.prepare("UPDATE runs SET status = 'stopped', exit_at = ?, charged_min = ?, charge_basis = 'elapsed until owner stop', cost_basis = 'unknown' WHERE id = ?").run(new Date(now).toISOString(), charged, r.id);
        S.block(stateRoot, { metricsPath: deps.metricsPath ?? null, now: () => now, task: r.task, reason: `stopped by owner (run ${r.id}; worktree kept at ${r.worktree})` });
        D.log(rt, cfg.project, `stopped ${r.task} pid ${r.pid}`);
        out.push({ task: r.task, pid: r.pid, killed: true });
      }
      return out;
    } finally { db.close(); }
  });
  if (result?.skipped) throw new S.StateError('BUSY', `${result.reason}; retry stop in a moment`);
  return result;
}

// S3: one confirmation path for `confirm-auth --root` and `auth confirm <project>`. The ledger row is keyed
// by (project, sha256 of the exact bytes read here), so editing the file or confirming another project
// never creates authority, and a draft can never be confirmed.
async function recordConfirmation({ project, env, now, expectSha256 = null }) {
  const rt = D.runtimeDir(env);
  const auth = D.readAuthorization(project, env);
  if (!auth.present) throw new S.StateError('NO_AUTH', `no authorization file at ${auth.path}`);
  if (auth.draft) throw new S.StateError('AUTH_DRAFT', `${auth.path} is still a DRAFT: edit it, remove "draft", then confirm`);
  if (expectSha256 !== null) {
    const e = String(expectSha256).toLowerCase();
    if (!/^[0-9a-f]{12,64}$/.test(e) || !auth.sha256.startsWith(e)) throw new S.StateError('AUTH_HASH_MISMATCH', `the file on disk is sha256 ${auth.sha256}, not ${String(expectSha256).slice(0, 64)}; review it again`);
  }
  const db = await D.openLedger(rt);
  try {
    db.prepare('INSERT INTO auth_hashes (project, sha256, seen_at, confirmed_at) VALUES (?, ?, ?, ?) ON CONFLICT(project, sha256) DO UPDATE SET confirmed_at = excluded.confirmed_at')
      .run(project, auth.sha256, new Date(now).toISOString(), new Date(now).toISOString());
  } finally { db.close(); }
  return auth;
}

export async function confirmAuth({ stateRoot, env = process.env, now = Date.now() }) {
  return recordConfirmation({ project: D.loadConfig(stateRoot).project, env, now });
}

export async function authConfirm({ project, env = process.env, now = Date.now(), expectSha256 = null }) {
  return recordConfirmation({ project, env, now, expectSha256 });
}

export function authInit({ project, env = process.env, now = Date.now() }) {
  const path = D.authPath(project, env); // validates the name before anything is created
  if (D.inspectAuthEntry(path) !== 'absent') throw new S.StateError('AUTH_EXISTS', `${path} already exists; init never overwrites`);
  mkdirSync(D.authDir(env), { recursive: true });
  const body = `${JSON.stringify({
    project, draft: true, revoked: false, createdAt: new Date(now).toISOString(),
    note: 'DRAFT: grants nothing. Add one entry per lane to "grants" (lane, actions, grantedBy, grantedAt), delete "draft", then run: forge dispatch auth confirm <project>. Editing this file later needs a new confirmation.',
    grants: [],
  }, null, 2)}
`;
  try { writeFileSync(path, body, { flag: 'wx' }); }
  catch (e) { if (e.code === 'EEXIST') throw new S.StateError('AUTH_EXISTS', `${path} already exists; init never overwrites`); throw e; }
  return { path, sha256: D.readAuthorization(project, env).sha256, draft: true };
}

// Read-only: reads the file and a temporary ledger snapshot; creates nothing. Prints lanes and actions
// only, never the file's other contents.
export async function authShow({ project, env = process.env }) {
  const auth = D.readAuthorization(project, env);
  let confirmedAt = null;
  if (auth.present) {
    const db = await D.openLedgerCopy(D.runtimeDir(env));
    try { confirmedAt = db.prepare('SELECT confirmed_at FROM auth_hashes WHERE project = ? AND sha256 = ?').get(project, auth.sha256)?.confirmed_at ?? null; } finally { db.close(); }
  }
  const state = !auth.present ? 'absent' : auth.draft ? 'draft' : auth.revoked ? 'revoked' : confirmedAt ? 'confirmed' : 'unconfirmed';
  return {
    project, path: auth.path, present: auth.present, state, draft: auth.draft === true, revoked: auth.present ? auth.revoked : false,
    sha256: auth.sha256, confirmed: confirmedAt !== null, confirmedAt,
    lanes: auth.grants.map((g) => ({ lane: g.lane, actions: g.actions, ignored: g.ignored, grantedBy: g.grantedBy, grantedAt: g.grantedAt })),
    neverGrantable: [...S.NEVER_GRANTABLE], executionEnabled: false, executionNote: EXECUTION_DISABLED_REASON,
  };
}

export async function status({ stateRoot, env = process.env, now = Date.now() }) {
  const rt = D.runtimeDir(env);
  let portfolio = portfolioAtRoot(rt, stateRoot);
  if (portfolio.enrollmentRefused) return { project: portfolio.entry?.id ?? null, stopFile: existsSync(D.stopFile(rt)), day: null,
    execution: `disabled: ${EXECUTION_DISABLED_REASON}`, checks: CHECKS_NOT_RUN, projectUsed: null, projectCap: null,
    portfolioUsed: null, running: null, policyErrors: portfolio.errors };
  const cfg = D.loadConfig(stateRoot);
  if (cfg.project !== portfolio.entry.id || S.readState(stateRoot).project !== portfolio.entry.id) portfolio = denyPortfolio(portfolio, 'configured or STATE project identity does not match enrollment id');
  const db = await D.openLedgerCopy(rt);
  try {

    const day = portfolio.valid ? D.dayKey(now, portfolio.timezone) : null;
    return {
      project: cfg.project, stopFile: existsSync(D.stopFile(rt)), day, execution: `disabled: ${EXECUTION_DISABLED_REASON}`, checks: CHECKS_NOT_RUN,
      projectUsed: day === null ? null : D.usedMinutes(db, { project: cfg.project, day }), projectCap: cfg.dailyCapMinutes,
      portfolioUsed: day === null ? null : D.usedMinutes(db, { day }), policyErrors: portfolio.errors,
      manualHolds: D.dispatchHolds(db,{project:cfg.project}).manual,
      running: db.prepare("SELECT task, agent, pid, started_at, timebox_min FROM runs WHERE project = ? AND status = 'running'").all(cfg.project),
    };
  } finally { db.close(); }
}

export async function main(argv, { out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`), env = process.env } = {}) {
  // Re-review R2: a null-prototype map keeps every supplied flag as an own key ("--__proto__" included),
  // so unknown-flag validation sees it; a plain {} would route "__proto__" to the prototype setter.
  const positional = [], flags = Object.create(null);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) flags[k] = true; else { flags[k] = v; i += 1; } }
    else positional.push(argv[i]);
  }
  const cmd = positional[0];
  const rt = D.runtimeDir(env);
  try {
    if (cmd === 'pause') {
      let parent=rt;
      for(;;) { try { lstatSync(parent);break; } catch(e) { if(e.code!=='ENOENT'||dirname(parent)===parent)throw e;parent=dirname(parent); } }
      if(rootSyntaxError(rt)||inspectRoot(parent).reason)throw new Error('UNSAFE_RUNTIME');
      mkdirSync(rt,{recursive:true});if(inspectRoot(rt).reason)throw new Error('UNSAFE_RUNTIME');
      const target=D.stopFile(rt);
      try { writeFileSync(target,`paused ${new Date().toISOString()}\n`,{flag:'wx'}); }
      catch(e) {
        if(e.code!=='EEXIST')throw e;
        const existing=lstatSync(target);
        if(existing.isSymbolicLink()||!existing.isFile()||existing.nlink!==1)throw new Error('UNSAFE_STOP');
        // An existing regular pause marker is already effective. Never truncate it.
      }
      out(`STOP file present: ${target}`);return 0;
    }
    if (cmd === 'resume') { rmSync(D.stopFile(rt), { force: true }); out('STOP file removed'); return 0; }
    if (cmd === 'config-template') {
      const agents = {};
      for (const [name, kind] of [['codex', 'codex'], ['claude-code', 'claude-code']]) {
        try { agents[name] = { kind, command: D.resolveAgentCommand(kind, { env }), ...(kind === 'codex' ? { sandboxMode: 'unelevated' } : {}) }; }
        catch (e) { err(`WARN ${name}: ${e.message}`); }
      }
      out(JSON.stringify({ project: flags.project || '<project>', dailyCapMinutes: '<owner sets>', timezone: 'America/New_York', maxWorkers: 1, worktreesRoot: '<absolute folder>', baseRef: 'origin/main', defaultTimeboxMin: 30, testCommands: [], agents }, null, 2));
      return 0;
    }
    if (cmd === 'auth') {
      const sub = positional[1], project = positional[2];
      if (!['init', 'confirm', 'show'].includes(sub) || project === undefined || positional.length > 3) { err('usage: forge dispatch auth <init|confirm|show> <project> [--sha256 <hex>]'); return 2; }
      // PR112-6: every flag except --sha256 is a usage error, so a typo cannot degrade confirm to the unrestricted form.
      const unknown = Object.keys(flags).filter((k) => k !== 'sha256');
      if (unknown.length) { err(`unknown flag ${unknown.map((k) => '--' + k).join(', ')}; usage: forge dispatch auth <init|confirm|show> <project> [--sha256 <hex>]`); return 2; }
      // S3 repair F1: a supplied --sha256 must carry a 12-64 hex value; a bare or malformed flag is a usage
      // error before any authorization read or ledger access, never a silent unrestricted confirmation.
      const shaGiven = Object.prototype.hasOwnProperty.call(flags, 'sha256');
      if (shaGiven && (sub !== 'confirm' || typeof flags.sha256 !== 'string' || !/^[0-9a-fA-F]{12,64}$/.test(flags.sha256))) {
        err('usage: --sha256 needs a value of 12-64 hex characters and is only valid with auth confirm'); return 2;
      }
      if (sub === 'init') { const r = authInit({ project, env }); out(`created DRAFT ${r.path} (grants nothing; edit, remove "draft", then: forge dispatch auth confirm ${project})`); return 0; }
      if (sub === 'show') { out(JSON.stringify(await authShow({ project, env }), null, 2)); return 0; }
      const a = await authConfirm({ project, env, expectSha256: shaGiven ? flags.sha256 : null });
      out(`confirmed ${a.path} sha256 ${a.sha256}`); return 0;
    }
    if (typeof flags.root !== 'string') { err('usage: forge dispatch <run|status|stop|confirm-auth> --root <stateRoot> | auth <init|confirm|show> <project> | pause | resume | config-template'); return 2; }
    const stateRoot = resolve(flags.root);
    const metricsPath = typeof flags.metrics === 'string' ? resolve(flags.metrics) : null;
    if (cmd === 'run') { out(JSON.stringify(await runOnce({ stateRoot, execute: flags.execute === true, env, deps: { metricsPath } }), null, 2)); return 0; }
    if (cmd === 'stop') { out(JSON.stringify(await stop({ stateRoot, task: positional[1] ?? null, all: flags.all === true, env, deps: { metricsPath } }))); return 0; }
    if (cmd === 'confirm-auth') { const a = await confirmAuth({ stateRoot, env }); out(`confirmed ${a.path} sha256 ${a.sha256}`); return 0; }
    if (cmd === 'status') { out(JSON.stringify(await status({ stateRoot, env }), null, 2)); return 0; }
    err(`unknown dispatch command: ${cmd}`); return 2;
  } catch (e) {
    if (e instanceof S.StateError) { err(`REFUSED ${e.code}: ${e.message}`); return e.code === 'USAGE' ? 2 : 1; }
    err(`ERROR ${e.stack || e.message}`); return 1;
  }
}

// Canonical, import-safe entry check: Node loads the ESM entry through its realpath (macOS /var -> /private/var,
// Windows junctions); an unresolved comparison skipped main() and exited 0 silently (pause/stop false success).
const isMain = (() => { try { return !!process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
