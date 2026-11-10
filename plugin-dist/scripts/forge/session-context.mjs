#!/usr/bin/env node
// Optional local context, never a task queue or an execution permission store.
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { inspectProject, readCheckup } from './checkup.mjs';
import { parseProjectJson } from './project-json.mjs';
import { reviewChange, applyChange, reviewUndo, undoChange, readEditBackup, readBytes, resolveInside, exactHash } from './reviewed-edits.mjs';

const LIMIT = 256 * 1024;
const HANDOFF = '.vibepromptrig/handoff.json', HISTORY = '.vibepromptrig/history.json';
const stop = message => { throw new Error(message); };
const digest = value => exactHash(Buffer.from(JSON.stringify(value)));
const keys = (value, expected, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== expected.length || expected.some(k => !Object.hasOwn(value, k))) stop('Invalid ' + label + ' fields. Preserve the record for review.');
};
const text = (value, label) => { if (typeof value !== 'string' || !value.trim() || value.length > 2000) stop('Invalid ' + label + ': use a short summary without private details.'); };
const list = (value, label) => { if (!Array.isArray(value) || value.length > 50) stop('Invalid ' + label + ' list.'); value.forEach(v => text(v, label)); };
const date = value => typeof value === 'string' && value.length <= 32 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const hash = value => /^[a-f0-9]{64}$/.test(value || '');
function git(root, args, allowFailure = false, encoding = 'utf8') {
  // Read metadata only. Ignore environment repository overrides and optional status hooks.
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k))), GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' };
  try {
    return execFileSync('git', ['--no-optional-locks', '--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], {
      cwd: root, env, encoding, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, maxBuffer: LIMIT,
    });
  } catch (error) {
    if (allowFailure && error.status === 1) return null;
    stop('Local Git metadata could not be checked. Nothing was changed; review Git access before continuing.');
  }
}
function gitState(root, includeDirty = true) {
  const base = realpathSync.native(root);
  if (!existsSync(join(base, '.git'))) {
    for (let parent = dirname(base); ; parent = dirname(parent)) {
      if (existsSync(join(parent, '.git'))) stop('Choose the parent repository project root. Nothing was changed.');
      if (parent === dirname(parent)) break;
    }
    return { status: 'no-git', head: null, branch: null, dirty: digest('no-git') };
  }
  if (lstatSync(join(root, '.git')).isSymbolicLink()) stop('Linked Git metadata is excluded. Nothing was changed.');
  const top = git(root, ['rev-parse', '--show-toplevel']).trim();
  const canonical = path => realpathSync.native(path).replace(/^[A-Z]:/, drive => drive.toLowerCase());
  if (canonical(top) !== canonical(root)) stop('Choose the local Git project root. Nothing was changed.');
  const head = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], true)?.trim() || null;
  if (head && !/^[a-f0-9]{40,64}$/.test(head)) stop('Local Git revision is invalid. Nothing was changed.');
  if (!includeDirty) return { status: head ? 'git' : 'empty', head, branch: null, dirty: digest('not-read') };
  const branch = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true)?.trim() || null;
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all', '--', '.', ':(exclude).vibepromptrig'], false, 'buffer');
  // Metadata detects later writes to the same dirty path without reading private file bodies.
  const metadata = [], entries = [];
  for (let start = 0, end; (end = status.indexOf(0, start)) !== -1; start = end + 1) {
    if (end > start) entries.push(status.subarray(start, end));
  }
  for (let i = 0; i < entries.length; i++) {
    const row = entries[i], paths = [row.slice(3)];
    if (/^[RC]|^.[RC]/.test(row.subarray(0, 2).toString('ascii'))) paths.push(entries[++i]);
    for (const path of paths) {
      if (!path?.length) stop('Local Git status could not be checked. Nothing was changed.');
      // Validate each byte-level path component without following a final symlink.
      const parts = [], identity = path.toString('hex');
      for (let start = 0, end; start <= path.length; start = end + 1) {
        end = path.indexOf(47, start); if (end === -1) end = path.length;
        const part = path.subarray(start, end);
        if (!part.length || part.equals(Buffer.from('.')) || part.equals(Buffer.from('..')) || part.includes(92) || part.includes(58)) stop('Unsafe Git status path.');
        parts.push(part); if (end === path.length) break;
      }
      let target = Buffer.from(base);
      for (let index = 0; index < parts.length; index++) {
        target = Buffer.concat([target, Buffer.from('/'), parts[index]]);
        if (index < parts.length - 1) {
          try { const stat = lstatSync(target); if (stat.isSymbolicLink() || !stat.isDirectory()) stop('Linked parent paths are excluded.'); }
          catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
      }
      try { const stat = lstatSync(target); metadata.push([identity, stat.size, stat.mtimeMs, stat.ctimeMs]); }
      catch (e) { if (e.code === 'ENOENT') metadata.push([identity, null]); else throw e; }
    }
  }
  return { status: head ? 'git' : 'empty', head, branch, dirty: digest([status, metadata]) };
}
function handoffValid(v) {
  keys(v, ['schema_version', 'kind', 'context_only', 'objective', 'completed_evidence', 'remaining_task', 'decisions', 'permission_note', 'failure', 'next_action', 'binding', 'recorded_at', 'approvals'], 'handoff');
  if (v.schema_version !== 1 || v.kind !== 'handoff-context' || v.context_only !== true || v.approvals !== 'not-transferred' || !date(v.recorded_at)) stop('Unsupported handoff context. Preserve it for review.');
  for (const name of ['objective', 'remaining_task', 'permission_note', 'failure', 'next_action']) text(v[name], name);
  for (const name of ['completed_evidence', 'decisions']) list(v[name], name);
  keys(v.binding, ['checkup', 'goal', 'source', 'branch', 'dirty', 'head', 'next_action'], 'handoff binding');
  for (const name of ['checkup', 'goal', 'source', 'dirty', 'next_action']) if (!hash(v.binding[name])) stop('Invalid handoff binding.');
  if ((v.binding.branch !== null && typeof v.binding.branch !== 'string') || (v.binding.head !== null && !/^[a-f0-9]{40,64}$/.test(v.binding.head))) stop('Invalid handoff Git context.');
}
function historyValid(v) {
  keys(v, ['schema_version', 'kind', 'source', 'events', 'reviewed_at', 'privacy'], 'history');
  if (v.schema_version !== 1 || v.kind !== 'local-git-history' || !date(v.reviewed_at) || v.privacy !== 'IDs and dates only; no messages, identities or diffs') stop('Unsupported local history. Preserve it for review.');
  keys(v.source, ['status', 'head', 'limit'], 'history source');
  if (!['git', 'empty', 'no-git'].includes(v.source.status) || (v.source.head !== null && !/^[a-f0-9]{40,64}$/.test(v.source.head)) || !Number.isSafeInteger(v.source.limit) || v.source.limit < 1 || v.source.limit > 200) stop('Invalid history source.');
  if (!Array.isArray(v.events) || v.events.length > 200) stop('Keep local history under 200 events. Narrow the reviewed import.');
  const ids = new Set();
  for (const event of v.events) {
    keys(event, ['type', 'source_id', 'occurred_at', 'summary', 'provenance', 'reachability'], 'history event');
    if (event.type !== 'git-commit' || !/^[a-f0-9]{40,64}$/.test(event.source_id) || ids.has(event.source_id) || !date(event.occurred_at) || event.summary !== 'Local commit recorded; contents and outcomes were not inspected.' || !['reachable', 'no-longer-reachable', 'unverified'].includes(event.reachability)) stop('Invalid or duplicate local history event.');
    ids.add(event.source_id);
    keys(event.provenance, ['method', 'imported_at'], 'history provenance');
    if (event.provenance.method !== 'local-git-head-metadata' || !date(event.provenance.imported_at)) stop('Invalid history provenance.');
  }
}
function readRecord(root, target, validate) {
  const bytes = readBytes(root, target);
  if (bytes === null) return null;
  const state = parseProjectJson(bytes, target); validate(state); return state;
}
function binding(root, checkup) {
  const state = gitState(root), current = inspectProject(root, checkup.state.goal);
  return { checkup: checkup.etag, goal: digest(checkup.state.goal), source: current.source.fingerprint,
    branch: state.branch, dirty: state.dirty, head: state.head, next_action: digest(checkup.state.next_action) };
}
export function previewHandoff(root, input) {
  keys(input, ['completed_evidence', 'remaining_task', 'decisions', 'permission_note', 'failure'], 'handoff input');
  const checkup = readCheckup(root);
  if (!checkup.state) stop('Confirm the goal and review a checkup before saving handoff context. Nothing was changed.');
  if (!checkup.scoped_fresh) stop('Checkup sources changed. Review current findings before preparing a handoff.');
  const state = { schema_version: 1, kind: 'handoff-context', context_only: true, objective: checkup.state.goal.outcome,
    ...structuredClone(input), next_action: checkup.state.next_action, binding: binding(root, checkup), recorded_at: new Date().toISOString(), approvals: 'not-transferred' };
  handoffValid(state);
  return reviewChange(root, { kind: 'handoff', target: HANDOFF, content: JSON.stringify(state, null, 2) + '\n', dependencies: ['.vibepromptrig/checkup.json'] });
}
export function resumeSession(root, options = {}) {
  keys(options, Object.hasOwn(options, 'completed_actions') ? ['completed_actions'] : [], 'resume options');
  list(options.completed_actions || [], 'completed actions');
  const handoff = readRecord(root, HANDOFF, handoffValid);
  if (!handoff) return { handoff: null, context_only: true, executable: false, approvals: 'not-transferred', action_status: 'no-handoff', explanation: 'No saved handoff is normal. Review the current goal and one next action.' };
  const checkup = readCheckup(root), rechecks = { checkup: 'MISSING', goal: 'UNVERIFIED', source: 'UNVERIFIED', branch: 'UNVERIFIED', dirty: 'UNVERIFIED', head: 'UNVERIFIED', next_action: 'UNVERIFIED', runtime_evidence: 'UNVERIFIED', access: 'UNVERIFIED' };
  if (checkup.state) {
    const state = gitState(root), current = binding(root, checkup, state);
    for (const name of Object.keys(current)) rechecks[name] = current[name] === handoff.binding[name] ? 'MATCH' : 'CHANGED';
    if (state.status === 'no-git') for (const name of ['branch', 'head', 'dirty']) rechecks[name] = 'UNVERIFIED';
    if (handoff.objective !== checkup.state.goal.outcome) rechecks.goal = 'CHANGED';
    if (handoff.next_action !== checkup.state.next_action) rechecks.next_action = 'CHANGED';
    if (!checkup.scoped_fresh) rechecks.source = 'CHANGED';
  }
  const complete = (options.completed_actions || []).includes(handoff.next_action);
  const stale = Object.values(rechecks).some(v => v === 'CHANGED' || v === 'MISSING');
  return { handoff, rechecks, context_only: true, executable: false, approvals: 'not-transferred',
    action_status: stale ? 'stale-context' : complete ? 'already-completed' : 'needs-current-review',
    explanation: 'Review current goal, findings, files, branch, dirty state, test evidence, access and whether the action is complete. This context never executes an action or renews permission.' };
}
export function previewHistory(root, { limit = 50 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) stop('Choose a local commit limit from 1 to 200. Nothing was changed.');
  const prior = readRecord(root, HISTORY, historyValid), source = gitState(root, false), now = new Date().toISOString();
  const events = new Map((prior?.events || []).map(event => [event.source_id, structuredClone(event)])), loggedIds = new Set();
  if (source.head) {
    const rows = git(root, ['log', '--no-show-signature', '--format=%H%x09%cI', '--max-count=' + limit, source.head]).trim().split('\n').filter(Boolean);
    for (const row of rows) {
      const [id, occurred_at, extra] = row.trim().split('\t');
      if (extra !== undefined || !/^[a-f0-9]{40,64}$/.test(id) || !date(occurred_at)) stop('Local commit metadata could not be read. Nothing was changed.');
      loggedIds.add(id);
      if (!events.has(id)) events.set(id, { type: 'git-commit', source_id: id, occurred_at, summary: 'Local commit recorded; contents and outcomes were not inspected.', provenance: { method: 'local-git-head-metadata', imported_at: now }, reachability: 'reachable' });
    }
  }
  if (events.size > 200) stop('Keep local history under 200 events. Narrow the reviewed import; prior events were preserved.');
  for (const event of events.values()) {
    if (source.status === 'no-git') event.reachability = 'unverified';
    else if (!source.head) event.reachability = 'no-longer-reachable';
    // Validated rows returned by log of this exact HEAD already prove ancestry.
    else if (loggedIds.has(event.source_id)) event.reachability = 'reachable';
    else {
      // A rewritten-away object may have been pruned. Verify existence, then exact ancestry;
      // never guess an equivalent new commit from dates or content.
      const exists = git(root, ['rev-parse', '--verify', '--quiet', event.source_id + '^{commit}'], true);
      event.reachability = exists !== null && git(root, ['merge-base', '--is-ancestor', event.source_id, source.head], true) !== null ? 'reachable' : 'no-longer-reachable';
    }
  }
  const state = { schema_version: 1, kind: 'local-git-history', source: { status: source.status, head: source.head, limit }, events: [...events.values()], reviewed_at: now, privacy: 'IDs and dates only; no messages, identities or diffs' };
  historyValid(state);
  return reviewChange(root, { kind: 'history', target: HISTORY, content: JSON.stringify(state, null, 2) + '\n' });
}
export function saveSessionContext(root, proposal, reviewHash, approved = false) {
  if (approved !== true) stop('Explicit approval is required for this exact reviewed local save. Nothing was changed.');
  if (!proposal || !['handoff', 'history'].includes(proposal.kind) || typeof proposal.content_base64 !== 'string' || proposal.content_base64.length > LIMIT * 1.34 + 4) stop('Invalid session proposal.');
  const state = parseProjectJson(Buffer.from(proposal.content_base64, 'base64'), 'reviewed session context');
  if (proposal.kind === 'handoff') {
    handoffValid(state); const checkup = readCheckup(root);
    if (!checkup.state || !checkup.scoped_fresh || JSON.stringify(binding(root, checkup)) !== JSON.stringify(state.binding)) stop('Session context changed since review. Prepare a fresh handoff. Nothing was changed.');
    if (state.objective !== checkup.state.goal.outcome || state.next_action !== checkup.state.next_action) stop('Handoff objective or next action is inconsistent with current findings. Prepare a fresh handoff. Nothing was changed.');
    if (proposal.target !== HANDOFF || proposal.dependencies?.length !== 1 || proposal.dependencies[0].path !== '.vibepromptrig/checkup.json' || proposal.dependencies[0].hash !== state.binding.checkup) stop('Invalid handoff source binding.');
  } else {
    historyValid(state); const current = gitState(root, false);
    if (state.source.head !== current.head || state.source.status !== current.status) stop('Local Git source changed since history review. Preview it again. Nothing was changed.');
    if (proposal.target !== HISTORY) stop('Invalid history target.');
    // Recheck ancestry too, including pruning/replacements that preserve HEAD.
    const checked = parseProjectJson(Buffer.from(previewHistory(root, { limit: state.source.limit }).content_base64, 'base64'), 'current history');
    const identity = events => events.map(e => [e.source_id, e.occurred_at, e.reachability]);
    if (JSON.stringify(identity(state.events)) !== JSON.stringify(identity(checked.events))) stop('Local history sources changed since review. Preview again.');
    const prior = new Map((readRecord(root, HISTORY, historyValid)?.events || []).map(event => [event.source_id, event]));
    for (const event of state.events) if (prior.has(event.source_id) && JSON.stringify(event.provenance) !== JSON.stringify(prior.get(event.source_id).provenance)) stop('Existing history import provenance changed. Preserve its original import record. Nothing was changed.');
  }
  return applyChange(root, proposal, reviewHash, approved);
}
function sessionBackup(root, backup) {
  const data = readEditBackup(root, backup);
  if (!((data.kind === 'handoff' && data.target === HANDOFF) || (data.kind === 'history' && data.target === HISTORY))) stop('Choose a handoff or history backup. Nothing was changed.');
}
export function previewSessionUndo(root, backup) {
  sessionBackup(root, backup);
  return reviewUndo(root, backup);
}
export function undoSessionContext(root, backup, expected, approved = false) {
  // Restrict the generic writer's recovery to the two disclosed context targets.
  if (approved !== true) stop('Explicit approval is required for this exact undo. Nothing was changed.');
  if (!/^\.vibepromptrig\/backups\/edits-[a-f0-9-]{36}\.json$/.test(backup || '')) stop('Choose a reviewed session backup.');
  sessionBackup(root, backup);
  return undoChange(root, backup, expected, approved);
}
export function main(args, root = process.cwd(), input) {
  const data = () => parseProjectJson(input, 'reviewed session input');
  let result;
  if (args[0] === 'handoff' && args.length === 1 && input) result = previewHandoff(root, data());
  else if (args[0] === 'resume' && args.length === 1) result = resumeSession(root, input ? data() : {});
  else if (args[0] === 'history' && (args.length === 1 || (args.length === 2 && args[1] === '--preview'))) result = previewHistory(root);
  else if (args[0] === 'history' && args.length === 4 && args[1] === '--preview' && args[2] === '--limit' && /^\d+$/.test(args[3])) result = previewHistory(root, { limit: Number(args[3]) });
  else if (args[0] === 'save' && args.length === 3 && args[2] === '--approved' && input) result = saveSessionContext(root, data(), args[1], true);
  else if (args[0] === 'undo-preview' && args.length === 2) result = previewSessionUndo(root, args[1]);
  else if (args[0] === 'undo' && args.length === 4 && args[3] === '--approved') result = undoSessionContext(root, args[1], args[2], true);
  else stop('Use handoff (reviewed summary on stdin), resume, history --preview [--limit 1..200], save <review-hash> --approved (proposal on stdin), undo-preview <backup>, or undo <backup> <undo-hash> --approved.');
  return JSON.stringify(result, null, 2) + '\n';
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const chunks = []; let size = 0;
    if (!process.stdin.isTTY && ['handoff', 'resume', 'save'].includes(process.argv[2])) for await (const chunk of process.stdin) { size += chunk.length; if (size > LIMIT * 2) stop('Keep the reviewed input under 512 KiB.'); chunks.push(chunk); }
    process.stdout.write(main(process.argv.slice(2), process.cwd(), chunks.length ? Buffer.concat(chunks) : undefined));
  } catch (error) { process.stderr.write('Session context could not continue: ' + (error.code ? 'A local project operation failed. Review access and recovery files before retrying.' : error.message) + '\n'); process.exitCode = 1; }
}
