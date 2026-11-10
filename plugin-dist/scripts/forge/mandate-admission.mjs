// Read-only admission preflight. This result is never an issuance, reservation,
// tool grant or dispatch token. The host must inject observe, env and clock from
// trusted configuration, never from proposal JSON or an untrusted request.
// A function's trust cannot be discovered by JavaScript: the host boundary owns
// its provenance and must collect real capability/STOP/accounting observations.
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {inspectRoot, inspectRepository} from '../completion/safe-inspection.mjs';

import * as D from './dispatch-lib.mjs';
import {parseMandate, mandatePayloadHash, mandateWindow} from './mandate.mjs';
import {parseStrict, canonicalize} from './handoff.mjs';

const fail = code => { throw Object.assign(new Error(code), {code}); };
const same = (a, b) => { try { return canonicalize(a) === canonicalize(b); } catch { return false; } };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function binding(m, lane, actions) {
  return {project:m.project.id, task_id:m.task_id, lane,
    repository:m.project.repository, root:m.project.canonical_root,
    input_commit:m.project.input_commit, allowed_paths:m.project.allowed_paths,
    actors:m.actors, adapter:m.adapter, limits:m.limits, locations:m.locations,
    acceptance_ref:m.acceptance_ref, generation:m.authority.generation, actions};
}
function checkInput(m, env) {
  try {
    for (const root of [m.project.canonical_root, m.locations.runtime_root, m.locations.evidence_root]) {
      if (inspectRoot(root).canonical !== root) fail('INPUT_BINDING');
    }
    if (D.runtimeDir(env) !== m.locations.runtime_root) fail('INPUT_BINDING');
    // Reuse qualified configuration, a trusted absolute executable and sanitized
    // Git environment; inherited GIT_DIR/GIT_WORK_TREE and PATH are not authority.
    const inspected = inspectRepository(m.project.canonical_root);
    if (inspected.state !== 'CLEAN' || inspected.head !== m.project.input_commit) fail('INPUT_BINDING');
  } catch { fail('INPUT_BINDING'); }
}
async function authorization(m, project, lane, actions, env) {
  const auth = D.readAuthorization(project, env);
  if (!auth.present || auth.revoked || auth.draft) fail('AUTH_REFUSED');
  // D.readAuthorization intentionally exposes only the existing grant surface.
  // Inspect additive records only after proving this second read is identical.
  const raw = readFileSync(auth.path);
  if (sha(raw) !== auth.sha256) fail('AUTH_CHANGED');
  let doc;
  try { doc = parseStrict(raw.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { fail('AUTH_REFUSED'); }
  if (doc.project !== project) fail('AUTH_REFUSED');
  const db = await D.openLedgerCopy(m.locations.runtime_root);
  try {
    const row = db.prepare('SELECT confirmed_at FROM auth_hashes WHERE project=? AND sha256=?')
      .get(project, auth.sha256);
    if (!row || typeof row.confirmed_at !== 'string' || !Number.isFinite(Date.parse(row.confirmed_at))) fail('AUTH_UNCONFIRMED');
  } finally { db.close(); }
  if (D.readAuthorization(project, env).sha256 !== auth.sha256) fail('AUTH_CHANGED');
  const records = Array.isArray(doc.mandates) ? doc.mandates.filter(r => r?.mandate_id === m.mandate_id) : [];
  const expected = {mandate_id:m.mandate_id, payload_hash:mandatePayloadHash(JSON.stringify(m)),
    generation:m.authority.generation, grant_ref:m.authority.existing_grant_ref,
    lane, confirmation_ref:m.authority.owner_confirmation_ref, revoked:false};
  if (!expected.confirmation_ref || records.length !== 1 || !same(records[0], expected)) fail('MANDATE_RECORD');
  // Preserve the existing lane ceiling and disabled-action rules without overrides.
  if (!D.grantFor(auth, {lane, workerActions:actions}).ok) fail('ACTION_REFUSED');
  return auth.sha256;
}

export async function checkMandateAdmission({proposal, project, transition, caller,
  observe, env = process.env, clock = Date.now} = {}) {
  const m = parseMandate(proposal);
  if (typeof observe !== 'function' || typeof clock !== 'function') fail('HOST_OBSERVER_REQUIRED');
  if (project !== m.project.id || !caller || typeof caller.lane !== 'string') fail('CALLER_BINDING');
  const actions = caller.actions;
  if (!Array.isArray(actions) || !actions.length || new Set(actions).size !== actions.length
    || actions.some(a => !m.authority.allowed_actions.includes(a))) fail('ACTION_REFUSED');
  const expected = binding(m, caller.lane, structuredClone(actions));
  if (!same(caller, expected)) fail('CALLER_BINDING');
  if (!m.authority.allowed_transitions.includes(transition)) fail('MANDATE_TRANSITION');
  const started = clock();
  if (!mandateWindow(m, started)) fail('MANDATE_WINDOW');
  checkInput(m, env);
  const authHash = await authorization(m, project, expected.lane, expected.actions, env);
  const nonce = randomUUID();
  const observed = await observe(Object.freeze({nonce, payloadHash:mandatePayloadHash(proposal), transition, startedAt:started}));
  const ended = clock();
  if (!mandateWindow(m, ended) || ended < started) fail('MANDATE_WINDOW');
  if (!observed || observed.nonce !== nonce || !Number.isFinite(observed.observedAt)
    || observed.observedAt < started || observed.observedAt > ended
    || observed.transition !== transition || !same(observed.caller, expected)
    || !same(caller, expected)) fail('HOST_EVIDENCE');
  const evidence = {
    capability:{ref:m.adapter.capability_evidence_ref, state:'verified'},
    isolation:{ref:m.adapter.isolation_evidence_ref, state:'verified'},
    stop:{ref:m.adapter.stop_evidence_ref, control_ref:m.locations.stop_control_ref, state:'ready'},
    accounting:{ref:m.limits.enforcement_evidence_ref, state:'enforced'}
  };
  for (const [key, value] of Object.entries(evidence)) if (!same(observed[key], value)) fail('HOST_EVIDENCE');
  checkInput(m, env);
  if (await authorization(m, project, expected.lane, expected.actions, env) !== authHash) fail('AUTH_CHANGED');
  if (!mandateWindow(m, clock())) fail('MANDATE_WINDOW');
  return Object.freeze({activation:'disabled', workerTools:Object.freeze([]),
    payloadHash:mandatePayloadHash(proposal), authorizationHash:authHash});
}
