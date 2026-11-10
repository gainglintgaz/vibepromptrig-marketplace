// S6 disabled notification interface. No native/provider implementation, CLI,
// configuration switch, scheduler or installation. Production calls only status.
// Outbox primitives operate on an explicitly supplied existing ledger connection;
// future live wiring requires its own fenced admission. Fake sends are test-only.
import {createHash,randomUUID} from 'node:crypto';
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v);
const bad=()=>{throw new Error('NOTIFICATION_METADATA_REFUSED');};
const initialized=new WeakSet();
export const notificationStatus=()=>({state:'disabled',userReceipt:'unknown'});
function ready(db){if(!initialized.has(db))throw Error('OUTBOX_NOT_INITIALIZED');}
function transaction(db,fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}
export function initializeOutbox(db){
  if(initialized.has(db))return;
  // Explicit caller-owned test/preparation path only. Never called by runPass.
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS notification_items(project TEXT NOT NULL,item_id TEXT NOT NULL,content_hash TEXT NOT NULL,version INTEGER NOT NULL,resolved INTEGER NOT NULL,PRIMARY KEY(project,item_id));
    CREATE TABLE IF NOT EXISTS notification_outbox(key TEXT PRIMARY KEY,project TEXT NOT NULL,item_id TEXT NOT NULL,content_hash TEXT NOT NULL,version INTEGER NOT NULL,state TEXT NOT NULL,eligible INTEGER NOT NULL,attempt_id TEXT,user_receipt TEXT NOT NULL DEFAULT 'unknown');`);
  transaction(db,()=>db.prepare("UPDATE notification_outbox SET state='unknown' WHERE state='attempted'").run());initialized.add(db);
}
export function reconcileItems(db,project,items){
  ready(db);if(!id(project)||!Array.isArray(items)||items.length>100)bad();const seen=new Set();for(const item of items){if(!item||Object.keys(item).sort().join(',')!=='contentHash,id'||!id(item.id)||typeof item.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(item.contentHash)||seen.has(item.id))bad();seen.add(item.id);}
  return transaction(db,()=>{
    const keys=[];for(const row of db.prepare('SELECT * FROM notification_items WHERE project=?').all(project))if(!seen.has(row.item_id)){db.prepare('UPDATE notification_items SET resolved=1 WHERE project=? AND item_id=?').run(project,row.item_id);db.prepare('UPDATE notification_outbox SET eligible=0 WHERE project=? AND item_id=?').run(project,row.item_id);}
    for(const item of items){const old=db.prepare('SELECT * FROM notification_items WHERE project=? AND item_id=?').get(project,item.id);if(old&&!old.resolved&&old.content_hash===item.contentHash)continue;const version=(old?.version||0)+1;if(!Number.isSafeInteger(version)||db.prepare('SELECT count(*) AS n FROM notification_outbox').get().n>=10000)throw Error('OUTBOX_QUOTA');
      const key=createHash('sha256').update(JSON.stringify([project,item.id,item.contentHash,version])).digest('hex');
      db.prepare('UPDATE notification_outbox SET eligible=0 WHERE project=? AND item_id=?').run(project,item.id);
      db.prepare('INSERT INTO notification_items VALUES(?,?,?,?,0) ON CONFLICT(project,item_id) DO UPDATE SET content_hash=excluded.content_hash,version=excluded.version,resolved=0').run(project,item.id,item.contentHash,version);
      db.prepare("INSERT INTO notification_outbox(key,project,item_id,content_hash,version,state,eligible) VALUES(?,?,?,?,?,'queued',1)").run(key,project,item.id,item.contentHash,version);keys.push(key);
    }return keys;
  });
}
export function readOutbox(db,key){ready(db);if(typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))bad();const r=db.prepare('SELECT * FROM notification_outbox WHERE key=?').get(key);if(!r)throw Error('OUTBOX_MISSING');return {key:r.key,projectId:r.project,itemId:r.item_id,version:r.version,state:r.state,eligible:r.eligible===1,userReceipt:r.user_receipt,attemptId:r.attempt_id};}
export function beginFixtureAttempt(db,key){ready(db);return transaction(db,()=>{const row=readOutbox(db,key);if(row.state!=='queued'||!row.eligible)return {...row,startedHere:false};const attempt=randomUUID();db.prepare("UPDATE notification_outbox SET state='attempted',attempt_id=? WHERE key=? AND state='queued' AND eligible=1").run(attempt,key);return {...readOutbox(db,key),startedHere:true};});}
export async function exerciseFixtureDelivery(db,key,adapter,{timeoutMs=100}={}){
  // No live adapter constructor exists. This explicit injection is solely for
  // disposable fake-adapter tests; it is never reachable from runtime settings.
  if(!adapter||adapter.kind!=='fixture'||typeof adapter.send!=='function')return notificationStatus();
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>1000)bad();const before=readOutbox(db,key);if(before.state!=='queued'||!before.eligible)return before;
  const row=beginFixtureAttempt(db,key);if(row.state!=='attempted'||!row.startedHere)return readOutbox(db,key);
  const payload=Object.freeze({projectId:row.projectId,itemId:row.itemId,version:row.version,ownerItemCount:1});let state='unknown',timer;
  try{const r=await Promise.race([Promise.resolve().then(()=>adapter.send(payload)),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),timeoutMs);})]);if(r&&r.accepted===true)state='provider-accepted';}catch{/* never persist adapter exception text */}finally{clearTimeout(timer);}
  transaction(db,()=>db.prepare("UPDATE notification_outbox SET state=? WHERE key=? AND attempt_id=? AND state='attempted'").run(state,key,row.attemptId));return readOutbox(db,key);
}
