// Inert proposed-1 syntax contract. Validation and hashes never establish consent.
// Filesystem identity, trusted confirmation, grant ceilings, capacity and native
// capabilities must be checked separately by admission before any dispatch.
import path from 'node:path';
import { canonicalize, canonicalHash, parseStrict } from './handoff.mjs';
import { rootSyntaxError } from './portfolio-policy.mjs';
import { GRANTABLE } from './dispatch-lib.mjs';
import { safeRelPath } from './state-lib.mjs';

export const MANDATE_VERSION = 'vpr-mandate/proposed-1';
export const MANDATE_TRANSITIONS = Object.freeze(['assign', 'build', 'review', 'repair', 'recheck', 'record-result']);
const id = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v)
  && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(v);
const sha = v => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
const integer = (v, min = 1) => Number.isSafeInteger(v) && v >= min;
const positive = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
const fail = field => { throw Object.assign(new Error(`MANDATE_SCHEMA: ${field}`), { code: 'MANDATE_SCHEMA' }); };
function shape(v, keys, field) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) fail(field);
}
function requireValue(ok, field) { if (!ok) fail(field); }
function list(v, predicate, field) {
  requireValue(Array.isArray(v) && v.length > 0 && v.every(predicate) && new Set(v).size === v.length, field);
}
function timestamp(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v)) return false;
  const t = Date.parse(v);
  const normalized = v.includes('.') ? v.replace(/\.(\d+)Z$/, (_, digits) => '.' + digits.padEnd(3, '0') + 'Z') : v.replace('Z', '.000Z');
  return Number.isFinite(t) && new Date(t).toISOString() === normalized;
}
function root(v, platform) {
  if (rootSyntaxError(v, platform)) return false;
  const p = platform === 'win32' ? path.win32 : path.posix;
  // No aliases, alternate separators, glob/ADS syntax or filesystem-wide root.
  return !/[\x00-\x1f\x7f*?]/.test(v) && !(platform === 'win32' && v.slice(2).includes(':'))
    && !(platform === 'win32' && v.slice(3).split(/[\\/]/).some(s => /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s)))
    && p.normalize(v) === v && p.parse(v).root !== v && !v.endsWith(p.sep);
}
function scope(v) {
  return typeof v === 'string' && v.length <= 512 && safeRelPath(v)
    && !/[\x00-\x1f\x7f\\:*?\[\]{}]/.test(v)
    && v.split('/').every(s => s !== '.' && !/[. ]$/.test(s)
      && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)|^\.env(?:\.|$)|^\.(?:aws|ssh|git|npmrc|netrc)$|^credentials(?:\.|$)|^id_(?:rsa|ed25519)$|\.(?:pem|key)$/i.test(s));
}
function actor(v, role) {
  shape(v, ['agent', 'provider', 'accountContextId', 'role', 'sessionId', 'bindingGeneration'], `actors.${role}`);
  requireValue([v.agent, v.provider, v.accountContextId, v.sessionId].every(id) && v.role === role
    && typeof v.bindingGeneration === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(v.bindingGeneration), `actors.${role}`);
}
function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }

// Accept serialized JSON only: duplicate keys cannot survive an object API.
// Draft/validated are proposal states, never issued authority. No wall-clock read.
export function parseMandate(input, { platform = process.platform } = {}) {
  const m = parseStrict(input);
  shape(m, ['schema_version', 'status', 'mandate_id', 'project', 'task_id', 'acceptance_ref', 'actors', 'adapter', 'authority', 'limits', 'locations'], 'mandate');
  requireValue(m.schema_version === MANDATE_VERSION && ['draft', 'validated'].includes(m.status), 'version/status');
  requireValue([m.mandate_id, m.task_id, m.acceptance_ref].every(id), 'identity');
  const p = m.project;
  shape(p, ['id', 'repository', 'canonical_root', 'input_commit', 'allowed_paths'], 'project');
  requireValue(id(p.id) && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(p.id) && sha(p.input_commit) && root(p.canonical_root, platform), 'project.identity');
  shape(p.repository, ['host', 'owner', 'name'], 'project.repository');
  requireValue(Object.values(p.repository).every(id), 'project.repository');
  list(p.allowed_paths, scope, 'project.allowed_paths');
  requireValue(new Set(p.allowed_paths.map(v => platform === 'win32' ? v.toLowerCase() : v)).size === p.allowed_paths.length, 'project.path_collision');
  shape(m.actors, ['manager_binding', 'builder_binding', 'reviewer_binding'], 'actors');
  for (const role of ['manager', 'builder', 'reviewer']) actor(m.actors[role + '_binding'], role);
  const bindings = Object.values(m.actors).map(v => canonicalize([v.provider, v.accountContextId, v.sessionId]));
  requireValue(new Set(bindings).size === bindings.length, 'actors.distinct_sessions');
  const a = m.adapter;
  shape(a, ['id', 'version', 'source_revision', 'capability_evidence_ref', 'isolation_evidence_ref', 'stop_evidence_ref'], 'adapter');
  requireValue([a.id, a.version, a.capability_evidence_ref, a.isolation_evidence_ref, a.stop_evidence_ref].every(id) && sha(a.source_revision), 'adapter.binding');
  const auth = m.authority;
  shape(auth, ['existing_grant_ref', 'owner_confirmation_ref', 'generation', 'valid_from_utc', 'expires_at_utc', 'allowed_actions', 'allowed_transitions'], 'authority');
  requireValue(id(auth.existing_grant_ref) && (auth.owner_confirmation_ref === null || id(auth.owner_confirmation_ref)) && integer(auth.generation, 0), 'authority.references');
  requireValue(timestamp(auth.valid_from_utc) && timestamp(auth.expires_at_utc) && Date.parse(auth.valid_from_utc) < Date.parse(auth.expires_at_utc), 'authority.window');
  list(auth.allowed_actions, v => GRANTABLE.includes(v), 'authority.allowed_actions');
  list(auth.allowed_transitions, v => MANDATE_TRANSITIONS.includes(v), 'authority.allowed_transitions');
  const l = m.limits;
  shape(l, ['max_concurrent_workers', 'max_worker_invocations', 'max_parent_model_turns', 'max_repairs_per_cause', 'active_minutes', 'wall_minutes', 'accounting_mode', 'usage_cap', 'spend_cap_usd', 'enforcement_evidence_ref'], 'limits');
  requireValue(['max_concurrent_workers', 'max_worker_invocations', 'max_parent_model_turns'].every(k => integer(l[k])) && integer(l.max_repairs_per_cause, 0), 'limits.counts');
  requireValue(l.max_concurrent_workers <= 16 && l.max_concurrent_workers <= l.max_worker_invocations, 'limits.concurrency');
  requireValue(positive(l.active_minutes) && positive(l.wall_minutes) && positive(l.usage_cap)
    && typeof l.spend_cap_usd === 'number' && Number.isFinite(l.spend_cap_usd) && l.spend_cap_usd >= 0, 'limits.caps');
  requireValue(['tokens', 'provider-quota', 'invocations'].includes(l.accounting_mode) && id(l.enforcement_evidence_ref), 'limits.accounting');
  requireValue(l.wall_minutes <= (Date.parse(auth.expires_at_utc) - Date.parse(auth.valid_from_utc)) / 60000, 'limits.wall_window');
  shape(m.locations, ['runtime_root', 'evidence_root', 'stop_control_ref'], 'locations');
  requireValue(root(m.locations.runtime_root, platform) && root(m.locations.evidence_root, platform) && id(m.locations.stop_control_ref), 'locations');
  return freeze(m);
}

// The external confirmation reference is deliberately not a payload field for
// hashing. Its existence, trust and exact binding are admission responsibilities.
export function mandatePayloadHash(input, options) {
  const m = parseMandate(input, options);
  const { owner_confirmation_ref, ...authority } = m.authority;
  return canonicalHash({ ...m, authority });
}

// A true result says ONLY that now is in the proposal window, never "admitted".
// Reparse even objects to avoid treating a caller-created object as validated.
export function mandateWindow(proposal, nowMs, options) {
  const m = parseMandate(canonicalize(proposal), options);
  return Number.isFinite(nowMs) && nowMs >= Date.parse(m.authority.valid_from_utc) && nowMs < Date.parse(m.authority.expires_at_utc);
}
