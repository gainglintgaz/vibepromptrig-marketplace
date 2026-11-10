#!/usr/bin/env node
// coordinator.mjs -- zero-AI coordinator pass + DIGEST.md (coordination-layer-v1 section 2.4, kickoff
// P5, HH-ORCH-03 step C).
// Justified: plain code over coord-state/1 and the dispatcher ledger; no MCP server or Skill writes this digest.
//
//   node scripts/coordinator.mjs --root <stateRoot> [--root <other>] [--dry-run] [--now <iso>]
//
// Per project root (STATE.json present, paused=false for writes): release expired leases (a lease
// with a live worker PID is kept), promote queued -> ready, build missing packs into the runtime
// folder, re-check stored receipt digests against committed files, flag blocked > 3 days, then
// write DIGEST.md into the runtime folder. --dry-run computes the digest without any write.
//
// The digest separates "Worker actions pending" (an agent can do it) from "Only you" (merge,
// deploy, secrets, policy, authorization). Every line names the exact command or file. It copies
// structured fields only; worker free text never reaches it (F11).
//
// Not covered here (reported, not silently skipped): discovering every registered project from the
// BRIEF registry, the monthly connectivity file-write probe, and cockpit rows. Pass --root per project.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from './forge/state-lib.mjs';
import * as D from './forge/dispatch-lib.mjs';
import { portfolioAtRoot } from './forge/dispatch.mjs';

const DAY = 24 * 3600_000;

const quote = (p) => `"${String(p).replace(/"/g, '\\"')}"`;

function loadDispatchView(rt, project) {
  // Read-only view of the dispatcher ledger and its last run, if the runtime exists.
  const view = { lastRun: null };
  const last = join(rt, 'runs', project, 'last-run.json');
  if (existsSync(last)) { try { view.lastRun = JSON.parse(readFileSync(last, 'utf8')); } catch { view.lastRun = { unreadable: true }; } }
  return view;
}


// Read-only projection: no expiry, claim release, message import or provider calls.
export function relayProjection(db, state, now) {
 const view={heldTasks:[],rows:[],accepted:[]};
 const table=name=>!!db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
 const safe=x=>typeof x==='string'&&/^[A-Za-z0-9._-]{1,120}$/.test(x);
 if(table('relay_claims')) for(const r of db.prepare('SELECT * FROM relay_claims WHERE project=? ORDER BY reserved_ms,claim_id').all(state.project)) {
  if(r.task_held) view.heldTasks.push(r.task);
  if(!safe(r.task)) continue;
  const expired=!r.run_id && now>=r.start_before;
  const status=['pending','running','released','unknown','expired'].includes(r.status)?r.status.toUpperCase():'UNKNOWN';
  view.rows.push(r.task+': '+status+(expired?'; START window expired; no START received; owner relay needed':'')+'; capacity '+(r.capacity_held?'held':'released')+'; ownership '+(r.task_held?'held':'released')+'; financial '+(r.financial_held?'held':'released'));
 }
 if(table('relay_operations')) for(const t of state.tasks) {
  const h=t.handoff;
  if(!h||h.outcome!=='reviewed'||!h.reviewOperationId||!h.verdictMessageId||h.candidate!==t.result?.headSha||!t.evidence?.reviewed)continue;
  const row=db.prepare('SELECT * FROM relay_operations WHERE operation_id=? AND applied=1').get(h.reviewOperationId);
  if(!row||createHash('sha256').update(row.canonical).digest('hex')!==row.operation_hash||h.operations?.[h.reviewOperationId]!==row.operation_hash)continue;
  let op;try{op=JSON.parse(row.canonical);}catch{continue;}
  if(op.kind==='consume'&&op.project===state.project&&op.task===t.id&&op.verdict==='PASS'&&op.candidateSha===h.candidate&&op.messageId===h.verdictMessageId&&op.generation===h.generation&&op.actorBinding===h.managerBinding&&op.claimId===h.reviewClaim&&op.ref===t.evidence.reviewed.ref)view.accepted.push(t.id);
 }
 return view;
}

export async function coordinate({ stateRoot, dryRun = false, now = Date.now(), env = process.env, deps = {} }) {
  const rt = D.runtimeDir(env);
  const base = { metricsPath: deps.metricsPath ?? null, now: () => now };
  const portfolio = portfolioAtRoot(rt, stateRoot);
  if (portfolio.enrollmentRefused) throw new S.StateError('ENROLLMENT_REFUSED', portfolio.errors.join('; '));
  let state = S.readState(stateRoot);
  if (state.project !== portfolio.entry.id) throw new S.StateError('ENROLLMENT_REFUSED', 'STATE project identity does not match enrollment id');
  const actions = { released: [], promoted: [], packs: [], receiptMismatch: [], deadLetters: [] };
  let cfg = null;
  try { cfg = D.loadConfig(stateRoot); } catch (e) { if (e.code !== 'NO_CONFIG') throw e; }
  if (cfg && cfg.project !== portfolio.entry.id) throw new S.StateError('ENROLLMENT_REFUSED', 'configured project identity does not match enrollment id');
  // One accounting day for every project (finding 18): the portfolio timezone, as the dispatcher uses.
  const timezone = portfolio.timezone;

  // Ledger-backed liveness, when a dispatcher runtime exists for this project.
  let db = null;
  if (existsSync(join(rt, 'ledger.db'))) db = await D.openLedgerCopy(rt); // the coordinator never writes the ledger
  try {
    const running = db ? db.prepare("SELECT * FROM runs WHERE project = ? AND status = 'running'").all(state.project) : [];
    const relay = relayProjection(db, state, now);
    const byTask = new Set([...running.map(r => r.task), ...relay.heldTasks]);
    if (!dryRun && !state.paused) {
      // A lease whose ledger row is still 'running' belongs to the dispatcher until it collects the
      // result (review P1); releasing it here could lose a finished worker's output.
      actions.released = S.releaseExpired(stateRoot, { ...base, isAlive: (lease, t) => (byTask.has(t.id) || t.handoff ? true : !lease.pid ? false : true) });
      actions.promoted = S.promote(stateRoot, base);
      state = S.readState(stateRoot);
      const packDir = join(rt, 'runs', state.project, 'packs');
      for (const t of state.tasks.filter((x) => x.stage === 'ready')) {
        if (existsSync(join(packDir, `${t.id}.md`))) continue;
        try { S.pack(stateRoot, { ...base, task: t.id, outDir: packDir }); actions.packs.push(t.id); }
        catch (e) { actions.packs.push(`${t.id} (refused: ${e.code || e.message})`); }
      }
    }
    // F3: confirm a stored receipt digest still matches the committed file when it is present.
    for (const t of state.tasks) {
      if (!t.receipt?.path || !t.receipt.receiptSha256) continue;
      const p = join(stateRoot, t.receipt.path);
      if (!existsSync(p)) continue; // not merged into the canonical root yet
      const h = createHash('sha256').update(readFileSync(p)).digest('hex');
      if (h !== t.receipt.receiptSha256) actions.receiptMismatch.push(t.id);
    }
    for (const t of state.tasks) if (t.stage === 'blocked' && now - Date.parse(t.updatedAt || 0) > 3 * DAY) actions.deadLetters.push(t);

    const day = timezone === null ? null : D.dayKey(now, timezone);
    const usedToday = db && day !== null ? D.usedMinutes(db, { project: state.project, day }) : null;
    const costToday = db && day !== null ? db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN cost_basis = 'reported by CLI' THEN cost_usd END) AS usd, SUM(CASE WHEN cost_basis IS NULL OR cost_basis = 'unknown' THEN 1 ELSE 0 END) AS unknown FROM runs WHERE project = ? AND day = ?").get(state.project, day) : null;
    // A caller holding a CURRENT pass result (the forge-dispatch shadow pass) supplies it; it replaces any
    // older last-run file so the digest never presents stale instructions as current (S2-F3).
    const view = deps.currentRun ? { lastRun: deps.currentRun } : loadDispatchView(rt, state.project);
    const digest = renderDigest({ state, actions, running, usedToday, costToday, cfg, view, now, timezone, stateRoot, policyErrors: portfolio.errors, relay });
    if (!dryRun) {
      const out = join(rt, 'digests', state.project);
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'DIGEST.md'), digest);
      S.appendEvent(base.metricsPath, { kind: 'coord.digest', project: state.project, released: actions.released.length, promoted: actions.promoted.length, deadLetters: actions.deadLetters.length });
    }
    return { digest, actions };
  } finally { db?.close(); }
}

// Lines copied from the last dispatch pass are history, not live instructions (finding 20): each is
// dated, and a line about a task that changed after that pass is dropped (its current stage and note
// are shown elsewhere in the digest).
function lastPassLines(lastRun, key, state) {
  const at = Date.parse(lastRun?.at);
  if (!Number.isFinite(at)) return [];
  const out = [];
  for (const line of lastRun?.[key] || []) {
    const id = String(line).match(/^([A-Za-z0-9._-]+):/)?.[1];
    const task = id ? state.tasks.find((t) => t.id === id) : null;
    if (task && Date.parse(task.updatedAt) > at) continue;
    out.push(`${line} (from ${lastRun?.mode === 'shadow' ? 'shadow' : 'dispatch'} pass ${new Date(at).toISOString()})`);
  }
  return out;
}

export function renderDigest({ state, actions, running, usedToday, costToday, cfg, view, now, timezone, stateRoot, policyErrors = [], relay = { rows: [], accepted: [] } }) {
  const L = [];
  const by = (stage) => state.tasks.filter((t) => t.stage === stage);
  const ids = (arr) => arr.map((t) => (typeof t === 'string' ? t : t.id)).join(', ') || 'none';
  const root = quote(stateRoot.replace(/\\/g, '/'));
  L.push(`# Digest: ${state.project}`, '', `As of ${new Date(now).toISOString()} (${timezone ?? 'accounting timezone unknown'}). Generated by scripts/coordinator.mjs from STATE.json and the dispatch ledger; no AI.`, '');
  if (state.paused) L.push('**STATE.json is paused: nothing advances until it is unpaused.**', '');

  L.push('## Only you');
  const only = [];
  if (policyErrors.length) only.push('Fix portfolio policy before budget admission: ' + policyErrors.join('; '));
  const reviewed = t => !!t.evidence?.reviewed && (!t.handoff || relay.accepted.includes(t.id));
  for (const t of by('review')) {
    if (t.evidence?.implemented && reviewed(t)) only.push(`Merge decision for ${t.id} "${t.title}": review recorded; after merging, run \`forge state accept ${t.id} --pr <n> --root ${root}\``);
  }
  for (const a of state.ownerActions || []) only.push(`${a.id}: ${a.text} (open since ${a.since ?? 'unknown'})`);
  for (const line of lastPassLines(view.lastRun, 'onlyYou', state)) only.push(line);
  if (actions.receiptMismatch.length) only.push(`Receipt file changed after validation for ${ids(actions.receiptMismatch)}: decide whether to re-validate (forge state receipt) or investigate`);
  L.push(...(only.length ? [...new Set(only)].map((x) => `- ${x}`) : ['- Nothing waiting on you.']), '');

  L.push('## Worker actions pending');
  const work = [];
  for (const t of by('review').filter(t => t.handoff && !reviewed(t))) work.push(`${t.id}: authenticated relay verdict consumption required; generic evidence is insufficient`);
  for (const t of by('review')) if (!t.handoff && !reviewed(t)) work.push(`Independent review of ${t.id} (${t.owner} built it; the other agent reviews), then \`forge state evidence ${t.id} reviewed --ref "<review file>" --root ${root}\``);
  // The note may contain worker-authored text (F11), so only structured fields are rendered here.
  for (const t of by('blocked')) work.push(`${t.id} is blocked since ${t.updatedAt ?? 'unknown'}; the reason is in its STATE.json note. Fix, then \`forge state unblock ${t.id} --root ${root}\``);
  for (const p of actions.packs.filter((x) => x.includes('(refused'))) work.push(`Pack refused for ${p}; shorten the task acceptance or split the task`);
  for (const line of lastPassLines(view.lastRun, 'workerActions', state)) work.push(line);
  L.push(...(work.length ? [...new Set(work)].map((x) => `- ${x}`) : ['- None.']), '');

  L.push('## Moved and running');
  L.push(`- Released expired leases: ${ids(actions.released)}`);
  L.push(`- Promoted to ready: ${ids(actions.promoted)}`);
  L.push(`- Running now: ${running.length ? running.map((r) => `${r.task} (${r.agent}, pid ${r.pid ?? '?'})`).join(', ') : 'none'}`);
  L.push(`- Ready: ${ids(by('ready'))}. Review: ${ids(by('review'))}. Done: ${by('done').length}.`);
  if (actions.deadLetters.length) L.push(`- Dead letters (blocked over 3 days): ${ids(actions.deadLetters)}`);
  L.push('');

  L.push('## Attended relay');
  L.push(...(relay.rows.length ? relay.rows.map(x => `- ${x}`) : ['- No relay claims observed.']), '');

  L.push('## Budget today');
  if (timezone === null) L.push('- Budget unknown: portfolio policy is invalid or incomplete; no accounting day is assumed.');
  else if (usedToday === null) L.push('- No dispatch ledger yet: usage is unknown.');
  else {
    L.push(`- Elapsed, conservative: ${usedToday} of ${cfg?.dailyCapMinutes ?? '?'} project minutes (running workers count at full timebox).`);
    const usd = costToday?.usd;
    L.push(`- Reported cost: ${typeof usd === 'number' ? `$${usd.toFixed(4)}` : 'none reported'}; runs with unknown cost: ${costToday?.unknown ?? 0} of ${costToday?.n ?? 0}.`);
  }
  return `${L.join('\n')}\n`;
}

export async function main(argv, { out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`), env = process.env } = {}) {
  const roots = []; let dryRun = false; let now = Date.now(); let metricsPath = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') roots.push(resolve(argv[++i]));
    else if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--now') now = Date.parse(argv[++i]);
    else if (argv[i] === '--metrics') metricsPath = resolve(argv[++i]);
    else { err(`unknown argument ${argv[i]}`); return 2; }
  }
  if (!roots.length) { err('usage: node scripts/coordinator.mjs --root <stateRoot> [--root ...] [--dry-run]'); return 2; }
  if (!Number.isFinite(now)) { err('--now must be an ISO timestamp'); return 2; }
  let failed = 0;
  for (const stateRoot of roots) {
    try { const r = await coordinate({ stateRoot, dryRun, now, env, deps: { metricsPath } }); out(r.digest); }
    catch (e) { failed += 1; err(`REFUSED ${stateRoot}: ${e.code || ''} ${e.message}`); }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
