// S7-H preparation and disposable simulation only. No production adapter or CLI.
// Caller supplies an existing ledger; controller admission/fencing remains separate.
// These rows are simulated provenance and cannot establish recipient START or wake.
import {randomUUID} from 'node:crypto';
import {canonicalize, validateEnvelope} from './handoff.mjs';
const initialized = new WeakSet();
const fail = code => { throw Error(code); };
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
export const transportStatus = () => ({mode:'disabled', delivery:'not-delivered', start:'unobserved'});
function ready(db) { if (!initialized.has(db)) fail('TRANSPORT_NOT_INITIALIZED'); }
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function initializeTransport(db) {
  if (initialized.has(db)) return;
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS relay_transport_simulation (
      message_id TEXT PRIMARY KEY, intent_key TEXT UNIQUE NOT NULL,
      envelope_hash TEXT NOT NULL, route TEXT NOT NULL, state TEXT NOT NULL,
      attempt_id TEXT, started_at TEXT, observed_at TEXT);`);
  if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal' ||
      db.prepare('PRAGMA synchronous').get().synchronous !== 2) fail('TRANSPORT_STORAGE_SETTINGS');
  // An interrupted callback is ambiguous. Recovery never retries it.
  transaction(db, () => db.prepare("UPDATE relay_transport_simulation SET state='unknown' WHERE state='attempted'").run());
  initialized.add(db);
}
export function readTransport(db, messageId) {
  ready(db); if (!uuid(messageId)) fail('TRANSPORT_ID');
  const r = db.prepare('SELECT * FROM relay_transport_simulation WHERE message_id=?').get(messageId);
  if (!r) fail('TRANSPORT_MISSING');
  return {messageId:r.message_id, envelopeHash:r.envelope_hash, route:JSON.parse(r.route),
    state:r.state, attemptId:r.attempt_id, startedAt:r.started_at, observedAt:r.observed_at,
    provenance:'simulated', start:'unobserved', ownerRelayNeeded:true};
}
export function saveTransport(db, bytes) {
  ready(db); const m = validateEnvelope(bytes);
  const route = canonicalize({destination:m.recipient,
    adapterCapabilityRef:m.intentBinding.adapterCapabilityRef,
    adapterVersion:m.intentBinding.adapterVersion,
    environmentFingerprint:m.intentBinding.environmentFingerprint,
    authorityEpoch:m.intentBinding.authorityEpoch});
  return transaction(db, () => {
    const old = db.prepare('SELECT * FROM relay_transport_simulation WHERE message_id=? OR intent_key=?').get(m.messageId, m.idempotencyKey);
    if (old) {
      if (old.message_id !== m.messageId || old.envelope_hash !== m.envelopeHash || old.route !== route) fail('TRANSPORT_IMMUTABLE_CONFLICT');
      return readTransport(db, m.messageId);
    }
    if (db.prepare('SELECT count(*) AS n FROM relay_transport_simulation').get().n >= 5000) fail('TRANSPORT_QUOTA');
    db.prepare("INSERT INTO relay_transport_simulation(message_id,intent_key,envelope_hash,route,state) VALUES(?,?,?,?,'saved')").run(m.messageId,m.idempotencyKey,m.envelopeHash,route);
    return readTransport(db, m.messageId);
  });
}
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export async function exerciseSimulatedTransport(db, messageId, adapter, {timeoutMs=100}={}) {
  // Explicit injection is solely for fixture callbacks, never runtime configuration.
  if (!adapter || adapter.kind !== 'simulated' || typeof adapter.send !== 'function') return transportStatus();
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1000) fail('TRANSPORT_TIMEOUT');
  const send = adapter.send;
  const row = transaction(db, () => {
    const before = readTransport(db,messageId);
    if (canonicalize(adapter.route) !== canonicalize(before.route)) fail('TRANSPORT_ROUTE');
    if (before.state !== 'saved') return null;
    db.prepare("UPDATE relay_transport_simulation SET state='attempted',attempt_id=?,started_at=? WHERE message_id=? AND state='saved'").run(randomUUID(),new Date().toISOString(),messageId);
    return readTransport(db,messageId);
  });
  if (!row) return readTransport(db,messageId);
  // Attempt is committed before callback. Minimal immutable pointer; no raw payload.
  const pointer = freeze({messageId:row.messageId,envelopeHash:row.envelopeHash,attemptId:row.attemptId,route:row.route,provenance:'simulated'});
  let state = 'unknown', timer;
  try {
    const result = await Promise.race([Promise.resolve().then(() => send(pointer)),
      new Promise(resolve => { timer = setTimeout(() => resolve(null),timeoutMs); })]);
    if (result?.accepted === true) state = 'submitted';
    if (result?.delivered === true) {
      // Even a matching receipt proves only synthetic availability, never START.
      if (canonicalize(result.receipt) === canonicalize(pointer)) state = 'delivered';
      else state = 'unknown';
    }
  } catch { state = 'unknown'; /* Do not persist adapter exception or response bodies. */ }
  finally { clearTimeout(timer); }
  transaction(db, () => db.prepare("UPDATE relay_transport_simulation SET state=?,observed_at=? WHERE message_id=? AND attempt_id=? AND state='attempted'").run(state,new Date().toISOString(),messageId,row.attemptId));
  return readTransport(db,messageId);
}
