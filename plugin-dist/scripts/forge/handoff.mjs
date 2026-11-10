// S7-A pure relay/1 validation. Hashes are integrity, never actor authentication
// or execution authority. No filesystem, process, network or admission side effect.
import {createHash} from 'node:crypto';
export const RELAY_VERSION='relay/1';
export const CANONICAL_VERSION='RFC8785/1';
export const reject=(code)=>{throw Object.assign(new Error(code),{code});};
const hex=n=>v=>typeof v==='string'&&new RegExp('^[a-f0-9]{'+n+'}$').test(v);
const sha=hex(40),hash=hex(64),uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v)&&!/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(v);
const counter=v=>typeof v==='string'&&/^(0|[1-9][0-9]{0,15})$/.test(v);
const nullable=(fn,v)=>v===null||fn(v);
const string=v=>typeof v==='string'&&Buffer.byteLength(v)<=4096;
function unicode(s,stringLimit=4096){if(typeof s!=='string'||Buffer.byteLength(s)>stringLimit)reject('STRING_LIMIT');for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const d=s.charCodeAt(++i);if(!(d>=0xdc00&&d<=0xdfff))reject('INVALID_UNICODE');}else if(c>=0xdc00&&c<=0xdfff)reject('INVALID_UNICODE');}return s;}
export function canonicalize(value){return canonicalizeBounded(value,4096);}
function canonicalizeBounded(value,stringLimit){
  const active=new Set();
  function visit(v,depth){if(depth>8)reject('DEPTH_LIMIT');if(v===null||typeof v==='boolean')return JSON.stringify(v);if(typeof v==='number'){if(!Number.isFinite(v))reject('NONFINITE');return JSON.stringify(v);}if(typeof v==='string')return JSON.stringify(unicode(v,stringLimit));if(typeof v!=='object'||active.has(v))reject('JSON_TYPE');
    const proto=Object.getPrototypeOf(v);if(!Array.isArray(v)&&proto!==Object.prototype&&proto!==null)reject('JSON_TYPE');active.add(v);
    const descriptors=Object.getOwnPropertyDescriptors(v);if(Reflect.ownKeys(descriptors).some(k=>typeof k!=='string'||!Object.hasOwn(descriptors[k],'value')))reject('JSON_TYPE');let result;
    if(Array.isArray(v)){if(v.length>100||Object.keys(v).length!==v.length||Object.keys(v).some((k,i)=>k!==String(i)))reject('LIST_LIMIT');result='['+v.map(x=>visit(x,depth+1)).join(',')+']';}
    else{const keys=Object.keys(v).sort();if(keys.length>100||Reflect.ownKeys(v).length!==keys.length)reject('OBJECT_LIMIT');result='{'+keys.map(k=>JSON.stringify(unicode(k,stringLimit))+':'+visit(descriptors[k].value,depth+1)).join(',')+'}';}
    active.delete(v);return result;
  }
  return visit(value,0);
}
export const canonicalHash=v=>createHash('sha256').update(canonicalize(v),'utf8').digest('hex');
export function parseStrict(input){return parseStrictBounded(input,4096);}
// Native CLI events may contain a serialized inner document in a string.
// Only transport parsing gets the larger string ceiling; total bytes remain 65536.
// Never use this entrypoint to validate a relay envelope or its inner payload.
export function parseNativeTransport(input){return parseStrictBounded(input,65536);}
function parseStrictBounded(input,stringLimit){
  if(typeof input==='string'){for(let i=0;i<input.length;i++){const c=input.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const d=input.charCodeAt(++i);if(!(d>=0xdc00&&d<=0xdfff))reject('INVALID_UNICODE');}else if(c>=0xdc00&&c<=0xdfff)reject('INVALID_UNICODE');}}
  const bytes=typeof input==='string'?Buffer.from(input,'utf8'):input;if(!(bytes instanceof Uint8Array)||bytes.length>65536)reject('MESSAGE_LIMIT');
  if(bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf)reject('BOM');let source;try{source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{reject('INVALID_UTF8');}let at=0;
  const ws=()=>{while(/[ \t\r\n]/.test(source[at]||'X'))at++;};
  function quoted(){const start=at++;let escaped=false;for(;at<source.length;at++){const c=source[at];if(!escaped&&c==='"'){at++;try{return unicode(JSON.parse(source.slice(start,at)),stringLimit);}catch{reject('INVALID_STRING');}}if(!escaped&&c==='\\')escaped=true;else escaped=false;}reject('INVALID_JSON');}
  function value(depth){if(depth>8)reject('DEPTH_LIMIT');ws();const c=source[at];if(c==='"')return quoted();if(c==='{'||c==='['){at++;const object=c==='{',out=object?Object.create(null):[],seen=new Set(),end=object?'}':']';ws();if(source[at]===end){at++;return out;}for(;;){if(object){if(source[at]!=='"')reject('INVALID_JSON');const key=quoted();if(seen.has(key))reject('DUPLICATE_KEY');seen.add(key);ws();if(source[at++]!==':')reject('INVALID_JSON');out[key]=value(depth+1);}else out.push(value(depth+1));if((object?seen.size:out.length)>100)reject('LIST_LIMIT');ws();if(source[at]===end){at++;return out;}if(source[at++]!==',')reject('INVALID_JSON');ws();}}
    for(const[lit,v]of [['true',true],['false',false],['null',null]])if(source.startsWith(lit,at)){at+=lit.length;return v;}
    const m=/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(at));if(!m)reject('INVALID_JSON');at+=m[0].length;const n=Number(m[0]);if(!Number.isFinite(n))reject('NONFINITE');return n;
  }
  const result=value(0);ws();if(at!==source.length)reject('INVALID_JSON');canonicalizeBounded(result,stringLimit);return result;
}
function shape(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))reject('SCHEMA');}
function list(v,predicate,{sorted=false}={}){if(!Array.isArray(v)||v.length>100||v.some(x=>!predicate(x))||new Set(v).size!==v.length||sorted&&v.some((x,i)=>i&&v[i-1]>=x))reject('SCHEMA');}
const roles=['owner','manager','builder','reviewer','observer'];
function actor(v){shape(v,['agent','provider','accountContextId','role','sessionId','bindingGeneration']);if(![v.agent,v.provider,v.accountContextId,v.sessionId].every(id)||!roles.includes(v.role)||!counter(v.bindingGeneration))reject('BINDING');}
function timestamp(v){if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v))return false;const t=Date.parse(v);if(!Number.isFinite(t))return false;const normalized=v.includes('.')?v.replace(/\.(\d+)Z$/,(_,s)=>'.'+s.padEnd(3,'0')+'Z'):v.replace('Z','.000Z');return new Date(t).toISOString()===normalized;}
function path(v){return typeof v==='string'&&v.length>0&&v.length<=512&&!/[\x00-\x1f\x7f\\:]/.test(v)&&!v.startsWith('/')&&!v.split('/').some(s=>!s||s==='.'||s==='..'||/^\.env(?:\.|$)|^\.(?:aws|ssh|git|npmrc|netrc)$|^credentials(?:\.|$)|^id_(?:rsa|ed25519)$|\.(?:pem|key)$/i.test(s));}
function tokenPath(v){return typeof v==='string'&&/^<[A-Z_]+>(?:\/[A-Za-z0-9._ /-]+)?$/.test(v)&&!v.split('/').some(x=>x==='..'||x==='.')&&v.length<=1024;}
function evidence(v){shape(v,['ref','sha256']);return id(v.ref)&&hash(v.sha256);}
function release(v){shape(v,['capacity','task','financial','evidenceRef']);if(!['released','unknown'].includes(v.capacity)||!['released','held'].includes(v.task)||!['settled','held'].includes(v.financial)||!id(v.evidenceRef))reject('SCHEMA');}
function checks(v){if(!Array.isArray(v)||v.length>100)reject('SCHEMA');for(const c of v){shape(c,['name','passed','total','attribution']);if(!id(c.name)||!Number.isSafeInteger(c.passed)||!Number.isSafeInteger(c.total)||c.passed<0||c.total<c.passed||!['worker-reported','independently-run','not-run'].includes(c.attribution))reject('SCHEMA');}}
const kinds=['assignment','review-assignment','delivery-attempt','delivery-receipt','start','builder-result','verdict','consume','expire','supersede','stop-request','stopped','reconcile','probe','probe-ack','seen'];
function payload(m){const p=m.payload;
  if(['assignment','review-assignment'].includes(m.kind)){shape(p,['briefRef','briefSha256','acceptanceIds','evidenceRefs','authorityRef','producerResultId']);list(p.acceptanceIds,id);list(p.evidenceRefs,evidence);if(!id(p.authorityRef)||p.briefRef!==m.intentBinding.briefRef||p.briefSha256!==m.intentBinding.briefSha256||m.kind==='assignment'&&p.producerResultId!==null||m.kind==='review-assignment'&&!uuid(p.producerResultId))reject('SCHEMA');}
  else if(['delivery-attempt','delivery-receipt'].includes(m.kind)){shape(p,['originalId','originalHash','attemptId','adapterCapabilityRef','adapterVersion','destination','startedAt','observedAt','outcome','providerRef']);actor(p.destination);if(!uuid(p.originalId)||!hash(p.originalHash)||!uuid(p.attemptId)||!id(p.adapterCapabilityRef)||!id(p.adapterVersion)||!timestamp(p.startedAt)||!nullable(timestamp,p.observedAt)||!['prepared','attempted','submitted','delivered','unknown','refused'].includes(p.outcome)||!nullable(id,p.providerRef))reject('SCHEMA');}
  else if(m.kind==='start'){shape(p,['originalId','originalHash','acceptedKey','actualStart','taskId','claimId','runId','leaseGeneration','stopFence','recipient','inputEvidence','claimReceipt']);actor(p.recipient);list(p.inputEvidence,evidence);if(!uuid(p.originalId)||!hash(p.originalHash)||!hash(p.acceptedKey)||!timestamp(p.actualStart)||p.taskId!==m.taskId||p.claimId!==m.claimId||p.runId!==m.runId||p.leaseGeneration!==m.capWindow.leaseGeneration||p.stopFence!==m.capWindow.stopFence||!id(p.claimReceipt)||canonicalize(p.recipient)!==canonicalize(m.sender))reject('SCHEMA');}
  else if(m.kind==='builder-result'){shape(p,['assignmentId','startId','actualStart','actualStop','inputCommitSha','candidateCommitSha','parentCommitSha','changedPaths','result','evidenceRefs','release']);shape(p.result,['status','summary','commits','checks','gaps']);list(p.changedPaths,path,{sorted:true});list(p.result.commits,sha);list(p.result.gaps,string);checks(p.result.checks);list(p.evidenceRefs,evidence);release(p.release);if(!uuid(p.assignmentId)||!uuid(p.startId)||!timestamp(p.actualStart)||!timestamp(p.actualStop)||Date.parse(p.actualStop)<Date.parse(p.actualStart)||p.inputCommitSha!==m.inputCommitSha||p.candidateCommitSha!==m.candidateCommitSha||!nullable(sha,p.parentCommitSha)||!['done','blocked'].includes(p.result.status)||!string(p.result.summary)||p.result.status==='done'&&!sha(p.candidateCommitSha))reject('SCHEMA');}
  else if(m.kind==='verdict'){shape(p,['assignmentId','startId','resultId','candidateCommitSha','verdict','coveredPaths','acceptanceIds','findings','checks','gaps','evidenceRefs','actualStart','actualStop','release']);list(p.coveredPaths,path,{sorted:true});list(p.acceptanceIds,id);list(p.gaps,string);list(p.evidenceRefs,evidence);checks(p.checks);release(p.release);if(!Array.isArray(p.findings)||p.findings.length>100)reject('SCHEMA');for(const f of p.findings){shape(f,['code','priority','path','detailRef']);if(!id(f.code)||![0,1,2,3].includes(f.priority)||!path(f.path)||!id(f.detailRef))reject('SCHEMA');}if(![p.assignmentId,p.startId,p.resultId].every(uuid)||p.candidateCommitSha!==m.candidateCommitSha||!sha(p.candidateCommitSha)||!['PASS','CHANGES_REQUESTED','BLOCKED'].includes(p.verdict)||!timestamp(p.actualStart)||!timestamp(p.actualStop)||Date.parse(p.actualStop)<Date.parse(p.actualStart)||p.verdict==='PASS'&&p.findings.length)reject('SCHEMA');}
  else if(m.kind==='consume'){shape(p,['resultId','verdictId','verdictHash','manager','bindingGeneration','stateOperationId','priorStateHash','newStateHash','outcome','evidenceRef','nextDependency']);actor(p.manager);if(canonicalize(p.manager)!==canonicalize(m.sender)||p.bindingGeneration!==m.sender.bindingGeneration)reject('BINDING_MISMATCH');if(![p.resultId,p.verdictId].every(uuid)||![p.verdictHash,p.priorStateHash,p.newStateHash].every(hash)||!counter(p.bindingGeneration)||!id(p.stateOperationId)||!['reviewed','repair-held','blocked'].includes(p.outcome)||!id(p.evidenceRef)||!nullable(id,p.nextDependency))reject('SCHEMA');}
  else if(['probe','probe-ack','seen'].includes(m.kind)){shape(p,['originalId','originalHash','requiresWork','observationCode','evidenceRefs']);list(p.evidenceRefs,evidence);if(!nullable(uuid,p.originalId)||!nullable(hash,p.originalHash)||p.requiresWork!==false||!id(p.observationCode))reject('SCHEMA');}
  else{shape(p,['targetId','targetGeneration','operationId','reasonCode','authorityRef','evidenceRefs','reservationDisposition','observations','releaseProof']);list(p.evidenceRefs,evidence);shape(p.observations,['local','task','financial','external']);if(!uuid(p.targetId)||!counter(p.targetGeneration)||![p.operationId,p.reasonCode,p.authorityRef].every(id)||!['held','released','settled','unknown'].includes(p.reservationDisposition)||!Object.values(p.observations).every(x=>['unknown','held','stopped','released','settled','unresolved'].includes(x))||!nullable(id,p.releaseProof)||m.kind==='stopped'&&p.releaseProof===null)reject('SCHEMA');}
}
const bodyKeys=['schemaVersion','messageId','kind','projectId','repository','stateRoot','worktree','sender','recipient','taskId','claimId','runId','phase','inputCommitSha','candidateCommitSha','scopePaths','actions','intentBinding','capWindow','createdAt','expiresAt','inReplyTo','rootMessageId','supersedes','payload'];
function validateBody(m){shape(m,[...bodyKeys,'idempotencyKey','payloadHash','envelopeHash']);canonicalize(m);if(m.schemaVersion!==RELAY_VERSION||!uuid(m.messageId)||!kinds.includes(m.kind)||![m.projectId,m.taskId,m.claimId].every(id)||!nullable(id,m.runId)||!['build','review','probe','control'].includes(m.phase)||!sha(m.inputCommitSha)||!nullable(sha,m.candidateCommitSha)||!tokenPath(m.stateRoot)||!tokenPath(m.worktree)||!timestamp(m.createdAt)||!timestamp(m.expiresAt)||Date.parse(m.expiresAt)<=Date.parse(m.createdAt)||!nullable(uuid,m.inReplyTo)||!uuid(m.rootMessageId)||!nullable(uuid,m.supersedes))reject('SCHEMA');
  shape(m.repository,['host','owner','name']);if(!Object.values(m.repository).every(id))reject('SCHEMA');actor(m.sender);actor(m.recipient);list(m.scopePaths,path,{sorted:true});list(m.actions,x=>['read-evidence','report-result','review-source','record-start','stop','reconcile'].includes(x),{sorted:true});
  const flow={assignment:['build','manager','builder'],'review-assignment':['review','manager','reviewer'],'builder-result':['build','builder','manager'],verdict:['review','reviewer','manager'],consume:['control','manager','observer']}[m.kind];
  if(flow&&(m.phase!==flow[0]||m.sender.role!==flow[1]||m.recipient.role!==flow[2]))reject('BINDING');
  if(m.kind==='start'&&(!['build','review'].includes(m.phase)||m.sender.role!==(m.phase==='build'?'builder':'reviewer')||m.recipient.role!=='manager'))reject('BINDING');
  const b=m.intentBinding;shape(b,['canonicalizationVersion','briefRef','briefSha256','acceptanceRef','acceptanceSha256','policySha256','authorityEpoch','adapterCapabilityRef','adapterVersion','environmentFingerprint']);if(b.canonicalizationVersion!==CANONICAL_VERSION||![b.briefRef,b.acceptanceRef,b.authorityEpoch,b.adapterCapabilityRef,b.adapterVersion].every(id)||![b.briefSha256,b.acceptanceSha256,b.policySha256,b.environmentFingerprint].every(hash))reject('BINDING');
  const c=m.capWindow;shape(c,['activeMinutes','startNotBefore','startBefore','outerStopAt','grantRef','reservationRef','leaseGeneration','stopFence']);if(!counter(c.leaseGeneration)||!counter(c.stopFence))reject('SCHEMA');
  if(['build','review'].includes(m.phase)){if(!Number.isFinite(c.activeMinutes)||c.activeMinutes<=0||c.activeMinutes>240||![c.startNotBefore,c.startBefore,c.outerStopAt].every(timestamp)||Date.parse(c.startBefore)<=Date.parse(c.startNotBefore)||Date.parse(c.outerStopAt)<Date.parse(c.startBefore)||![c.grantRef,c.reservationRef].every(id))reject('WINDOW');}
  else if(c.activeMinutes!==0||[c.startNotBefore,c.startBefore,c.outerStopAt,c.grantRef,c.reservationRef].some(x=>x!==null))reject('WINDOW');
  if(['review-assignment','verdict'].includes(m.kind)&&m.inputCommitSha!==m.candidateCommitSha)reject('REVISION_MISMATCH');
  if(m.kind==='assignment'&&(m.phase!=='build'||m.candidateCommitSha!==null)||m.kind==='review-assignment'&&(m.phase!=='review'||!sha(m.candidateCommitSha))||['probe','probe-ack','seen'].includes(m.kind)&&!['probe','control'].includes(m.phase)||['start','builder-result','verdict'].includes(m.kind)&&m.runId===null)reject('SCHEMA');payload(m);if(Buffer.byteLength(canonicalize(m.payload))>32768)reject('PAYLOAD_LIMIT');
}
// relay/1 keys remain stable for persisted envelopes. Lineage is bound by the
// envelope hash; a same-key envelope with different links is a held conflict.
export function intentKey(m){const b=m.intentBinding,c=m.capWindow,p=m.payload;if(['assignment','review-assignment'].includes(m.kind))return canonicalHash([m.kind,m.projectId,m.repository,m.taskId,m.phase,m.claimId,c.leaseGeneration,m.inputCommitSha,m.candidateCommitSha,m.scopePaths,m.sender,m.recipient,m.actions,c,b,...(m.kind==='review-assignment'?[p.producerResultId]:[])]);if(['start','builder-result','verdict'].includes(m.kind))return canonicalHash([p.originalId||p.assignmentId,m.kind,m.claimId,c.leaseGeneration,m.runId,b.authorityEpoch]);if(['delivery-attempt','delivery-receipt'].includes(m.kind))return canonicalHash([p.originalId,m.kind,p.attemptId,b.authorityEpoch]);return canonicalHash([p.targetId||m.rootMessageId,m.kind,p.operationId||p.stateOperationId||m.messageId,b.authorityEpoch]);}
export function sealEnvelope(body){shape(body,bodyKeys);const m=parseStrict(canonicalize({...body,idempotencyKey:'',payloadHash:'',envelopeHash:''}));validateBody(m);m.idempotencyKey=intentKey(m);m.payloadHash=canonicalHash(m.payload);const {envelopeHash,...rest}=m;m.envelopeHash=canonicalHash(rest);return validateEnvelope(canonicalize(m));}
export function validateEnvelope(bytes){const m=parseStrict(bytes);validateBody(m);const {envelopeHash,...rest}=m;if(m.idempotencyKey!==intentKey(m)||m.payloadHash!==canonicalHash(m.payload)||envelopeHash!==canonicalHash(rest))reject('HASH_MISMATCH');function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}}freeze(m);return m;}
export function assertRegisteredBinding(m,registered){for(const key of ['projectId','repository','stateRoot','worktree','sender','recipient','intentBinding'])if(canonicalize(m[key])!==canonicalize(registered[key]))reject('BINDING_MISMATCH');return true;}
export function assertArtifactBindings(m,artifacts,policy){const b=m.intentBinding;for(const[ref,expected]of [[b.briefRef,b.briefSha256],[b.acceptanceRef,b.acceptanceSha256]]){const bytes=artifacts[ref];if(!(bytes instanceof Uint8Array)||createHash('sha256').update(bytes).digest('hex')!==expected)reject('INTENT_ARTIFACT_CHANGED');}if(canonicalHash(policy)!==b.policySha256)reject('INTENT_ARTIFACT_CHANGED');return true;}
export function admissionWindow(m,brokerNow){return ['build','review'].includes(m.phase)&&Number.isFinite(brokerNow)&&brokerNow>=Date.parse(m.capWindow.startNotBefore)&&brokerNow<Math.min(Date.parse(m.capWindow.startBefore),Date.parse(m.expiresAt),Date.parse(m.capWindow.outerStopAt));}

// S7-B supervised journal. The native fence serializes cooperative writers.
// A trusted attended controller must retain checkpoint OUTSIDE database backups.
// Supplied checkpoint/provenance is not authenticated by JSON or by this API.
// Missing/stale checkpoint or changed epoch fails closed; no restore auto-repair.
// No assignment is admitted, reserved, delivered or started by this component.
import * as fs from 'node:fs';
import * as paths from 'node:path';
import {randomUUID} from 'node:crypto';
import {openLedger,dayKey,initRelayAccounting,relayTransaction,recordRelayGrant,reserveRelayClaim,startRelayClaim,settleRelayClaim,expireRelayClaim} from './dispatch-lib.mjs';
import {inspectRepository,inspectCandidate} from '../completion/safe-inspection.mjs';
import {inspectRoot} from './portfolio-policy.mjs';
import {fenceRuntime,withFencedEffect,requestPause,checkFence} from './stop.mjs';
import {containsSecret,applyRelayState,readState,pathOwnedBy,bodyHash} from './state-lib.mjs';
const identity=s=>`${s.dev}:${s.ino}`;
function regular(file,{absent=false,limit=64*1024*1024,links=1}={}){let s;try{s=fs.lstatSync(file);}catch(e){if(absent&&e.code==='ENOENT')return null;reject('UNSAFE_STORAGE');}if(!s.isFile()||s.isSymbolicLink()||s.nlink!==links||s.size>limit)reject('UNSAFE_STORAGE');return s;}
function exactRead(file,expected,{links=1,owned=null}={}){const before=regular(file,{limit:65536,links}),fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));try{const opened=fs.fstatSync(fd);if(identity(before)!==identity(opened)||opened.nlink!==links||(owned!==null&&identity(opened)!==owned))reject('UNSAFE_STORAGE');const b=fs.readFileSync(fd);const after=regular(file,{limit:65536,links});if(identity(after)!==identity(opened)||b.toString('utf8')!==expected)reject('EXPORT_MISMATCH');return b;}finally{fs.closeSync(fd);}}
const journalContexts=new WeakMap();
export async function openRelayJournal({fence,stateRoot,epoch,generation,checkpoint,registration,artifacts,policy,attended=null}){
 registration=validateEnvelope(canonicalize(registration));
 const runtime=fenceRuntime(fence),root=inspectRoot(stateRoot);if(root.reason||!id(epoch)||!counter(generation))reject('JOURNAL_BINDING');const canonicalRoot=root.canonical,rootId=identity(fs.lstatSync(canonicalRoot)),runtimeId=identity(fs.lstatSync(runtime));
 const expectedFence={expectedEpoch:epoch,expectedGeneration:generation};let db,closed=false,current;
 const observedStoppedResults=new WeakSet(); // only attend() can qualify a STOP/result continuation
 function storage(){if(closed||inspectRoot(canonicalRoot).canonical!==canonicalRoot||identity(fs.lstatSync(canonicalRoot))!==rootId||identity(fs.lstatSync(runtime))!==runtimeId)reject('UNSAFE_STORAGE');for(const name of ['ledger.db','ledger.db-wal','ledger.db-shm'])regular(paths.join(runtime,name),{absent:true});const free=fs.statfsSync(runtime);if(free.bavail*free.bsize<16*1024*1024)reject('STORAGE_HEADROOM');}
 function meta(){return db.prepare('SELECT epoch,sequence,head_hash AS headHash FROM relay_meta WHERE singleton=1').get();}
 function match(cp){const m=meta();if(!cp||cp.epoch!==m.epoch||cp.sequence!==m.sequence||cp.headHash!==m.headHash)reject('CHECKPOINT_RECONCILIATION_REQUIRED');return {...m};}
 function tx(fn){storage();const result=relayTransaction(db,()=>{match(current);return fn();});current={...meta()};return result;}
 function event(kind,messageId,detail){const m=meta(),next=m.sequence+1;if(next>20000)reject('JOURNAL_QUOTA');const eventHash=canonicalHash([m.headHash,next,kind,messageId,detail]);db.prepare('INSERT INTO relay_events VALUES(?,?,?,?,?)').run(next,kind,messageId,detail,eventHash);db.prepare('UPDATE relay_meta SET sequence=?,head_hash=? WHERE singleton=1').run(next,eventHash);}
 function row(messageId){if(!uuid(messageId))reject('MESSAGE_ID');const r=db.prepare('SELECT * FROM relay_messages WHERE message_id=?').get(messageId);if(!r)reject('MESSAGE_MISSING');return r;}
 function view(r){return {messageId:r.message_id,state:r.state,envelopeHash:r.envelope_hash};}
 try{await withFencedEffect(fence,async()=>{storage();db=await openLedger(runtime);db.exec(`PRAGMA synchronous=FULL;
 CREATE TABLE IF NOT EXISTS relay_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch TEXT NOT NULL,sequence INTEGER NOT NULL,head_hash TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS relay_messages(message_id TEXT PRIMARY KEY,intent_key TEXT NOT NULL UNIQUE,payload_hash TEXT NOT NULL,envelope_hash TEXT NOT NULL,canonical TEXT NOT NULL,state TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS relay_publications(message_id TEXT PRIMARY KEY,temp_name TEXT NOT NULL,temp_identity TEXT NOT NULL,envelope_hash TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS relay_operations(operation_id TEXT PRIMARY KEY,operation_hash TEXT NOT NULL,canonical TEXT NOT NULL,applied INTEGER NOT NULL,at_ms INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS relay_attended(message_id TEXT PRIMARY KEY,canonical TEXT NOT NULL,applied INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS relay_events(sequence INTEGER PRIMARY KEY,kind TEXT NOT NULL,message_id TEXT NOT NULL,detail TEXT NOT NULL,event_hash TEXT NOT NULL);`);
 if(!meta()){if(!checkpoint||checkpoint.epoch!==epoch||checkpoint.sequence!==0||checkpoint.headHash!=='0'.repeat(64))reject('CHECKPOINT_RECONCILIATION_REQUIRED');db.prepare('INSERT INTO relay_meta VALUES(1,?,0,?)').run(epoch,'0'.repeat(64));}
 initRelayAccounting(db);current=match(checkpoint);if(current.epoch!==epoch)reject('CHECKPOINT_EPOCH_RECONCILIATION_REQUIRED');if(db.prepare('PRAGMA journal_mode').get().journal_mode!=='wal'||db.prepare('PRAGMA synchronous').get().synchronous!==2)reject('SQLITE_SETTINGS');storage();
 },expectedFence);}catch(e){db?.close();throw e;}
 const journal=Object.freeze({
 close(){if(!closed){closed=true;db.close();}},checkpoint(){if(closed)reject('CLOSED');return {...current};},settings(){return {journalMode:db.prepare('PRAGMA journal_mode').get().journal_mode,synchronous:db.prepare('PRAGMA synchronous').get().synchronous,busyTimeout:db.prepare('PRAGMA busy_timeout').get().timeout};},
 counts(){return {messages:db.prepare('SELECT count(*) AS n FROM relay_messages').get().n,events:db.prepare('SELECT count(*) AS n FROM relay_events').get().n,runs:db.prepare('SELECT count(*) AS n FROM runs').get().n};},
 async stage(bytes){const m=validateEnvelope(bytes);assertRegisteredBinding(m,registration);assertArtifactBindings(m,artifacts,policy);if(m.intentBinding.authorityEpoch!==epoch||containsSecret(m))reject('MESSAGE_REFUSED');const canonical=canonicalize(m);return withFencedEffect(fence,()=>tx(()=>{
  assertRegisteredBinding(m,registration);assertArtifactBindings(m,artifacts,policy);
  const sameId=db.prepare('SELECT * FROM relay_messages WHERE message_id=?').get(m.messageId),old=db.prepare('SELECT * FROM relay_messages WHERE intent_key=?').get(m.idempotencyKey);
  if(sameId&&sameId.envelope_hash!==m.envelopeHash){db.prepare("UPDATE relay_messages SET state='unknown' WHERE message_id=?").run(sameId.message_id);event('conflict',sameId.message_id,'MESSAGE_ID_CONFLICT');return view(row(sameId.message_id));}
  if(old){if(old.payload_hash!==m.payloadHash){db.prepare("UPDATE relay_messages SET state='unknown' WHERE message_id=?").run(old.message_id);event('conflict',old.message_id,'INTENT_PAYLOAD_CONFLICT');}return view(row(old.message_id));}
  const size=db.prepare('SELECT count(*) AS n,coalesce(sum(length(CAST(canonical AS BLOB))),0) AS bytes FROM relay_messages').get();if(size.n>=5000||size.bytes+Buffer.byteLength(canonical)>8*1024*1024)reject('JOURNAL_QUOTA');db.prepare("INSERT INTO relay_messages VALUES(?,?,?,?,?,'proposed')").run(m.messageId,m.idempotencyKey,m.payloadHash,m.envelopeHash,canonical);event('staged',m.messageId,m.envelopeHash);return view(row(m.messageId));
 }),expectedFence);},

 // Read-only clock projection: crossing either deadline requests attended STOP.
 // A different clock identity cannot prove elapsed duration after restart.
 attendedStatus(){
  if(!attended||typeof attended.clock!=='function')reject('ATTENDANCE_REQUIRED');storage();match(current);const now=attended.clock();
  if(!now||!Number.isSafeInteger(now.utc)||!Number.isFinite(now.monotonic)||!id(now.identity))reject('CLOCK_REQUIRED');
  return db.prepare("SELECT m.canonical,a.canonical plan FROM relay_messages m JOIN relay_attended a ON a.message_id=m.message_id WHERE a.applied=1").all().map(r=>({message:validateEnvelope(r.canonical),plan:JSON.parse(r.plan)})).filter(r=>r.message.kind==='start').map(({message:m,plan:p})=>{const claim=db.prepare('SELECT * FROM relay_claims WHERE claim_id=?').get(m.claimId);const unknown=now.identity!==p.clock.identity||now.monotonic<p.clock.monotonic||Math.abs((now.utc-p.clock.utc)-(now.monotonic-p.clock.monotonic))>30000;return {messageId:m.messageId,claimId:m.claimId,capacityHeld:!!claim.capacity_held,stopRequired:!!claim.capacity_held&&(unknown||now.monotonic-p.clock.monotonic>=m.capWindow.activeMinutes*60000||now.utc>=Date.parse(m.capWindow.outerStopAt)),durationUnknown:unknown};});
 },

 // Attended-only host boundary. observe is executable host code, never a field
 // imported from a request file. Equal-user callers are NOT isolated/authenticated.
 // No CLI or unattended activation is exposed by this API.
 async attend(bytes,{fault=()=>{}}={}) {
  if(!attended||typeof attended.observe!=='function'||typeof attended.clock!=='function')reject('ATTENDANCE_REQUIRED');
  const m=validateEnvelope(bytes),canonical=canonicalize(m);
  if(!['assignment','start','builder-result','review-assignment','verdict','consume'].includes(m.kind))reject('ATTENDED_KIND');
  for(const key of ['projectId','repository','stateRoot','worktree','taskId','scopePaths','intentBinding'])if(canonicalize(m[key])!==canonicalize(registration[key]))reject('BINDING_MISMATCH');
  for(const who of ['sender','recipient'])if(canonicalize(m[who])!==canonicalize(attended.bindings?.[m[who].role]))reject('BINDING_MISMATCH');
  assertArtifactBindings(m,artifacts,policy);if(containsSecret(m)||m.intentBinding.authorityEpoch!==epoch)reject('MESSAGE_REFUSED');
  const observation=await attended.observe(m),clock=attended.clock();
  if(!observation||!['session_observed','owner_attested'].includes(observation.provenance)||observation.envelopeHash!==m.envelopeHash||canonicalize(observation.actor)!==canonicalize(m.sender)||!id(observation.evidenceRef))reject('ATTENDANCE_REQUIRED');
  if(typeof attended.timezone!=='string')reject('CLOCK_REQUIRED');
  if(!clock||!Number.isSafeInteger(clock.utc)||!Number.isFinite(clock.monotonic)||clock.monotonic<0||!id(clock.identity))reject('CLOCK_REQUIRED');
  const same=(a,b)=>canonicalize(a)===canonicalize(b), actorKey=a=>canonicalHash(a);
  function predecessor(messageId,kind){if(!db.prepare('SELECT 1 FROM relay_messages WHERE message_id=?').get(messageId))reject('PENDING_PREDECESSOR');const r=row(messageId),p=db.prepare('SELECT applied FROM relay_attended WHERE message_id=?').get(messageId);if(r.state==='unknown')reject('MESSAGE_CONFLICT');if(!p?.applied)reject('PENDING_PREDECESSOR');const e=validateEnvelope(r.canonical);if(e.kind!==kind)reject('PREDECESSOR_KIND');return e;}
  function inspect(input,candidate=null){const proof=candidate?inspectCandidate(attended.worktree,{input,candidate}):inspectRepository(attended.worktree);if(proof.state!=='CLEAN'||proof.head!==(candidate||input))reject('CANDIDATE_INSPECTION_HELD');return proof;}
  function repairBinding(a){
   const state=readState(canonicalRoot),task=state.tasks.find(t=>t.id===a.taskId),h=task?.handoff;
   if(state.paused||h&&(task.stage!=='review'||task.lease||task.owner!==a.recipient.agent))reject('REPAIR_STATE');
   if(!h&&!a.inReplyTo&&!a.supersedes)return null;
   if(!h||!a.inReplyTo||!a.supersedes||(h.history?.length||0)>=2)reject('REPAIR_LINEAGE');
   const consume=predecessor(a.inReplyTo,'consume'),v=predecessor(consume.payload.verdictId,'verdict'),r=predecessor(consume.payload.resultId,'builder-result'),prior=predecessor(a.supersedes,'assignment');
   if(consume.payload.outcome!=='repair-held'||v.payload.verdict!=='CHANGES_REQUESTED'||consume.payload.verdictHash!==v.envelopeHash||v.payload.resultId!==r.messageId||r.payload.assignmentId!==prior.messageId||h.outcome!=='repair-held'||h.reviewOperationId!==consume.payload.stateOperationId||h.verdictMessageId!==v.messageId||h.generation!==prior.capWindow.leaseGeneration||BigInt(a.capWindow.leaseGeneration)!==BigInt(h.generation)+1n||a.inputCommitSha!==r.candidateCommitSha||h.candidate!==a.inputCommitSha||bodyHash(state)!==consume.payload.newStateHash||a.claimId===prior.claimId||a.claimId===v.claimId)reject('REPAIR_LINEAGE');
   for(const e of [consume,v,r,prior])for(const key of ['projectId','repository','stateRoot','worktree','taskId','scopePaths','intentBinding'])if(!same(a[key],e[key]))reject('REPAIR_BINDING');
   if(!same(a.sender,consume.sender)||!same(a.sender,prior.sender)||!same(a.recipient,prior.recipient))reject('REPAIR_BINDING');
   inspect(r.inputCommitSha,a.inputCommitSha);
   return {repair:{consumeId:consume.messageId,consumeOperationId:consume.payload.stateOperationId,verdictId:v.messageId,assignmentId:prior.messageId,generation:h.generation},expectedStateHash:consume.payload.newStateHash};
  }
  let plan,alreadyApplied=false,existingReceipt=null;
  try { await withFencedEffect(fence,()=>{
   storage();match(current);
   const old=db.prepare('SELECT * FROM relay_messages WHERE message_id=? OR intent_key=?').all(m.messageId,m.idempotencyKey);
   if(old.some(r=>r.state==='unknown'))reject('MESSAGE_CONFLICT');
   const retry=old.find(r=>r.intent_key===m.idempotencyKey&&r.message_id!==m.messageId);
   if(retry){const comparable=v=>{const c=structuredClone(v);for(const k of ['messageId','createdAt','envelopeHash'])delete c[k];if(['assignment','review-assignment'].includes(c.kind))delete c.rootMessageId;return canonicalize(c);};if(comparable(validateEnvelope(retry.canonical))===comparable(m)){existingReceipt=view(retry);return;}}
   if(old.some(r=>r.envelope_hash!==m.envelopeHash)){tx(()=>{for(const r of old){db.prepare("UPDATE relay_messages SET state='unknown' WHERE message_id=?").run(r.message_id);event('conflict',r.message_id,'ATTENDED_CONFLICT');}});reject('MESSAGE_CONFLICT');}
   const pending=db.prepare('SELECT * FROM relay_attended WHERE message_id=?').get(m.messageId);
   if(pending){plan=JSON.parse(pending.canonical);if(pending.applied){alreadyApplied=true;return;}if(m.kind==='assignment')repairBinding(m);if(plan.candidate)inspect(plan.input,plan.candidate);else if(m.kind==='start'||m.kind==='assignment')inspect(m.inputCommitSha);return;}
   if(m.capWindow.stopFence!==generation)reject('STOP_FENCE');
   const manager=attended.bindings.manager,builder=attended.bindings.builder,reviewer=attended.bindings.reviewer;
   const sessionKey=a=>a&&canonicalHash([a.provider,a.accountContextId,a.sessionId]);
   if(!manager||!builder||!reviewer||[sessionKey(manager),sessionKey(builder)].includes(sessionKey(reviewer)))reject('REVIEW_INDEPENDENCE');
   let assignment,start,result,verdict,repair=null,op=null,claim=null;
   if(m.kind==='assignment'||m.kind==='review-assignment'){
    if(!admissionWindow(m,clock.utc)||observation.authorityRef!==m.payload.authorityRef||!observation.grant||!observation.limits)reject('AUTHORITY_REQUIRED');
    if(m.kind==='review-assignment'){result=predecessor(m.payload.producerResultId,'builder-result');if(result.payload.result.status!=='done'||m.candidateCommitSha!==result.candidateCommitSha||m.inputCommitSha!==result.candidateCommitSha||!same(m.sender,result.recipient)||m.inReplyTo!==result.messageId)reject('PREDECESSOR_BINDING');inspect(result.inputCommitSha,m.candidateCommitSha);}
    else {repair=repairBinding(m);inspect(m.inputCommitSha);}
    claim={claimId:m.claimId,key:m.idempotencyKey,project:m.projectId,task:m.taskId,phase:m.phase,agent:m.recipient.agent,binding:actorKey(m.recipient),worktree:attended.worktree,inputSha:m.inputCommitSha,scopePaths:m.scopePaths,cap:m.capWindow.activeMinutes,grantRef:m.capWindow.grantRef,epoch,generation:m.capWindow.leaseGeneration,day:dayKey(clock.utc,attended.timezone),now:clock.utc,startBefore:Math.min(Date.parse(m.capWindow.startBefore),Date.parse(m.expiresAt)),outerStop:Date.parse(m.capWindow.outerStopAt)};
    if(observation.grant.ref!==claim.grantRef||observation.grant.authorityRef!==observation.authorityRef)reject('AUTHORITY_REQUIRED');
   }else if(m.kind==='consume'){
    verdict=predecessor(m.payload.verdictId,'verdict');result=predecessor(m.payload.resultId,'builder-result');assignment=predecessor(verdict.payload.assignmentId,'review-assignment');
    if(m.payload.verdictHash!==verdict.envelopeHash||verdict.payload.resultId!==result.messageId||m.claimId!==verdict.claimId||m.candidateCommitSha!==result.candidateCommitSha||m.inReplyTo!==verdict.messageId||m.capWindow.leaseGeneration!==verdict.capWindow.leaseGeneration||m.payload.outcome!==({PASS:'reviewed',CHANGES_REQUESTED:'repair-held',BLOCKED:'blocked'}[verdict.payload.verdict]))reject('PREDECESSOR_BINDING');
    inspect(result.inputCommitSha,result.candidateCommitSha);
   }else{
    assignment=predecessor(m.payload.originalId||m.payload.assignmentId,m.phase==='build'?'assignment':'review-assignment');
    if(!same(m.sender,assignment.recipient)||!same(m.recipient,assignment.sender)||!same(m.capWindow,assignment.capWindow)||m.claimId!==assignment.claimId||m.inputCommitSha!==assignment.inputCommitSha||m.rootMessageId!==assignment.rootMessageId)reject('PREDECESSOR_BINDING');
    if(m.kind==='start'){
     if(m.payload.originalHash!==assignment.envelopeHash||m.payload.acceptedKey!==assignment.idempotencyKey||m.inReplyTo!==assignment.messageId||!admissionWindow(m,clock.utc)||Math.abs(clock.utc-Date.parse(m.payload.actualStart))>30000)reject('START_WINDOW');
     if(m.phase==='review'){result=predecessor(assignment.payload.producerResultId,'builder-result');inspect(result.inputCommitSha,m.candidateCommitSha);}else {repair=repairBinding(assignment);inspect(m.inputCommitSha);}
    }else{
     start=predecessor(m.payload.startId,'start');if(start.payload.originalId!==assignment.messageId||start.runId!==m.runId||m.inReplyTo!==start.messageId||m.payload.actualStart!==start.payload.actualStart||Date.parse(m.payload.actualStop)>clock.utc+30000||observation.stopConfirmed!==true||observation.releaseRef!==m.payload.release.evidenceRef)reject('STOP_EVIDENCE_REQUIRED');
     if(m.kind==='builder-result'){
      if(m.payload.result.status==='done'){const proof=inspect(m.inputCommitSha,m.candidateCommitSha);if(m.payload.parentCommitSha!==proof.parent||!same(m.payload.changedPaths,proof.changedPaths)||proof.changedPaths.some(p=>!pathOwnedBy(p,m.scopePaths))||!m.payload.result.commits.includes(m.candidateCommitSha))reject('CANDIDATE_PATHS');}
      else if(m.candidateCommitSha!==null)reject('BLOCKED_CANDIDATE');
     }else{result=predecessor(m.payload.resultId,'builder-result');if(assignment.payload.producerResultId!==result.messageId||m.candidateCommitSha!==result.candidateCommitSha||!same(m.payload.coveredPaths,result.payload.changedPaths)||!same(m.payload.acceptanceIds,assignment.payload.acceptanceIds))reject('VERDICT_COVERAGE');inspect(result.inputCommitSha,m.candidateCommitSha);}
    }
   }
   const base={id:'relay-'+m.messageId,project:m.projectId,task:m.taskId,claimId:m.claimId,generation:m.capWindow.leaseGeneration,scopePaths:m.scopePaths,inputSha:result?.inputCommitSha||m.inputCommitSha,managerBinding:actorKey(manager),actorBinding:actorKey(m.sender),agent:m.sender.agent,worktree:attended.worktree,runId:m.runId};
   if(m.kind==='start')op={...base,kind:m.phase==='build'?'build-start':'review-start',...(m.phase==='build'?{minutes:m.capWindow.activeMinutes,...repair}:{candidateSha:m.candidateCommitSha})};
   if(m.kind==='builder-result')op={...base,kind:'result',candidateSha:m.candidateCommitSha,result:m.payload.result,messageId:m.messageId};
   if(m.kind==='consume')op={...base,id:m.payload.stateOperationId,kind:'consume',inputSha:result.inputCommitSha,candidateSha:result.candidateCommitSha,verdict:verdict.payload.verdict,ref:m.payload.evidenceRef,messageId:verdict.messageId,expectedStateHash:m.payload.priorStateHash};
   if(m.kind==='consume'&&bodyHash(applyRelayState(canonicalRoot,op,{now:()=>clock.utc,preview:true}).state)!==m.payload.newStateHash)reject('CONSUME_STATE_HASH');
   if(m.kind==='start')applyRelayState(canonicalRoot,op,{now:()=>clock.utc,preview:true});
   plan={op,input:result?.inputCommitSha||m.inputCommitSha,candidate:m.candidateCommitSha,clock,evidenceRef:observation.evidenceRef,settlement:null};
   if(start){const initial=JSON.parse(db.prepare('SELECT canonical FROM relay_attended WHERE message_id=?').get(start.messageId).canonical).clock;const elapsed=clock.identity===initial.identity&&clock.monotonic>=initial.monotonic&&Math.abs((clock.utc-initial.utc)-(clock.monotonic-initial.monotonic))<=30000?(clock.monotonic-initial.monotonic)/60000:null;
    // Unknown intervals and financial usage retain the cap. A STOP observation
    // can release capacity/task separately, never manufactures financial proof.
    plan.elapsedMinutes=elapsed;plan.overCap=elapsed===null||elapsed>m.capWindow.activeMinutes||clock.utc>Date.parse(m.capWindow.outerStopAt);
    plan.settlement={capacityProof:m.payload.release.capacity==='released'?observation.releaseRef:null,taskProof:m.payload.release.task==='released'?observation.releaseRef:null};
    if(m.payload.release.financial==='settled'){if(!id(observation.financialProof)||elapsed===null||!Number.isFinite(observation.minutes)||observation.minutes<elapsed)reject('FINANCIAL_EVIDENCE_REQUIRED');Object.assign(plan.settlement,{financialProof:observation.financialProof,minutes:observation.minutes});}
   }
   tx(()=>{
    if(claim){recordRelayGrant(db,observation.grant);reserveRelayClaim(db,claim,observation.limits);}
    if(m.kind==='start'){const run=startRelayClaim(db,m.claimId,{now:clock.utc,binding:actorKey(m.sender),epoch,generation:m.capWindow.leaseGeneration});if(run.id!==m.runId)reject('RUN_BINDING');}
    const size=db.prepare('SELECT count(*) n,coalesce(sum(length(CAST(canonical AS BLOB))),0) bytes FROM relay_messages').get();if(size.n>=5000||size.bytes+Buffer.byteLength(canonical)>8*1024*1024)reject('JOURNAL_QUOTA');
    if(!old.length)db.prepare("INSERT INTO relay_messages VALUES(?,?,?,?,?,'proposed')").run(m.messageId,m.idempotencyKey,m.payloadHash,m.envelopeHash,canonical);
    db.prepare('INSERT INTO relay_attended VALUES(?,?,0)').run(m.messageId,canonicalize(plan));event('attended-intent',m.messageId,m.envelopeHash);
   });
  },expectedFence);
  }catch(e){if(e.code!=='PENDING_PREDECESSOR')throw e;return withFencedEffect(fence,()=>tx(()=>{if(!db.prepare('SELECT 1 FROM relay_messages WHERE message_id=?').get(m.messageId)){const size=db.prepare('SELECT count(*) n,coalesce(sum(length(CAST(canonical AS BLOB))),0) bytes FROM relay_messages').get();if(size.n>=5000||size.bytes+Buffer.byteLength(canonical)>8*1024*1024)reject('JOURNAL_QUOTA');db.prepare("INSERT INTO relay_messages VALUES(?,?,?,?,?,'pending-predecessor')").run(m.messageId,m.idempotencyKey,m.payloadHash,m.envelopeHash,canonical);event('pending-predecessor',m.messageId,m.envelopeHash);}return view(row(m.messageId));}),expectedFence);}
  if(existingReceipt)return existingReceipt;
  if(alreadyApplied)return {...view(row(m.messageId)),operationId:plan.op?.id||null,overCap:plan.overCap??false};
  fault('after-attended-intent');
  if(plan.candidate){const proof=inspectCandidate(attended.worktree,{input:plan.input,candidate:plan.candidate});if(proof.state!=='CLEAN')reject('CANDIDATE_INSPECTION_HELD');}
  if(plan.op){
   // A durable attended plan was qualified against its START and actual STOP
   // observation. Grant only this object a one-call continuation capability.
   if(m.kind==='builder-result'&&plan.settlement&&plan.op.kind==='result')observedStoppedResults.add(plan.op);
   try{await this.applyPreparedState(plan.op,{now:plan.clock.utc,fault});}
   finally{observedStoppedResults.delete(plan.op);}
  }
  return withFencedEffect(fence,()=>tx(()=>{const r=row(m.messageId);if(r.state==='unknown')reject('MESSAGE_CONFLICT');const receipt=db.prepare('SELECT applied FROM relay_attended WHERE message_id=?').get(m.messageId);if(!receipt.applied){if(plan.settlement)settleRelayClaim(db,m.claimId,plan.settlement);db.prepare('UPDATE relay_attended SET applied=1 WHERE message_id=?').run(m.messageId);db.prepare("UPDATE relay_messages SET state='admitted' WHERE message_id=?").run(m.messageId);event('attended-applied',m.messageId,m.envelopeHash);}fault('before-attended-finalize');return {...view(row(m.messageId)),operationId:plan.op?.id||null,overCap:plan.overCap??false};}),expectedFence);
 },

 // Recovery primitive for an already-reserved manual run. It does not admit a
 // session or authenticate caller-supplied JSON. The attended envelope controller
 // must qualify predecessor, actor and Git evidence before preparing this intent.
 async applyPreparedState(operation,{now=Date.now(),fault=()=>{}}={}) {
  const canonical=canonicalize(operation),operationHash=canonicalHash(operation),op=JSON.parse(canonical);
  if(!id(op.id)||!Number.isSafeInteger(now)||op.project!==registration.projectId||op.task!==registration.taskId||canonicalize(op.scopePaths)!==canonicalize(registration.scopePaths))reject('STATE_OPERATION_BINDING');
  return withFencedEffect(fence,()=>{
   storage();match(current);
   let prior=db.prepare('SELECT * FROM relay_operations WHERE operation_id=?').get(op.id);
   if(prior&&prior.operation_hash!==operationHash)reject('STATE_OPERATION_CONFLICT');
   if(!prior){
    const exists=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='relay_claims'").get();
    const claim=exists&&db.prepare('SELECT * FROM relay_claims WHERE claim_id=?').get(op.claimId);
    const run=claim?.run_id&&db.prepare('SELECT * FROM runs WHERE id=?').get(claim.run_id);
    const stoppedContinuation=op.kind==='result'&&observedStoppedResults.has(operation)&&claim?.status==='unknown'&&run?.status==='relay_unknown';
    if(!claim||!run||claim.project!==op.project||claim.task!==op.task||claim.epoch!==epoch||claim.generation!==op.generation||(op.kind==='consume'? !['running','complete','unknown'].includes(claim.status) : claim.status!=='running'&&!stoppedContinuation)||(op.kind!=='consume'&&!claim.task_held)||(op.kind!=='consume'&&run.status!=='relay_running'&&!stoppedContinuation)||run.pid!==null)reject('STATE_OPERATION_CLAIM');
    const consuming=op.kind==='consume',review=op.kind==='review-start'||consuming;
    if(claim.phase!==(review?'review':'build')||(!consuming&&(claim.binding!==op.actorBinding||claim.run_id!==op.runId||claim.agent!==op.agent))||claim.input_sha!==(review?op.candidateSha:op.inputSha)||canonicalize(JSON.parse(claim.intent)[8])!==canonicalize(op.scopePaths))reject('STATE_OPERATION_CLAIM');
    if(op.kind==='build-start'&&(op.minutes!==claim.cap||inspectRoot(op.worktree).canonical!==claim.worktree))reject('STATE_OPERATION_CLAIM');
    tx(()=>{if(db.prepare('SELECT count(*) n FROM relay_operations').get().n>=5000)reject('JOURNAL_QUOTA');db.prepare('INSERT INTO relay_operations VALUES(?,?,?,0,?)').run(op.id,operationHash,canonical,now);event('state-intent',op.id,operationHash);});
    prior=db.prepare('SELECT * FROM relay_operations WHERE operation_id=?').get(op.id);
   }
   fault('after-intent');
   const result=applyRelayState(canonicalRoot,JSON.parse(prior.canonical),{now:()=>prior.at_ms});
   fault('after-state');
   if(!prior.applied)tx(()=>{db.prepare('UPDATE relay_operations SET applied=1 WHERE operation_id=?').run(op.id);event('state-applied',op.id,operationHash);});
   fault('after-finalize');
   return {operationId:op.id,state:'applied',recovered:result.replayed};
  },expectedFence);
 },

 async publish(messageId,{fault=()=>{}}={}){return withFencedEffect(fence,()=>{storage();match(current);const r=row(messageId);if(r.state==='unknown')reject('MESSAGE_CONFLICT');const m=validateEnvelope(r.canonical);const admitted=db.prepare('SELECT applied FROM relay_attended WHERE message_id=?').get(messageId);if(!admitted?.applied)assertRegisteredBinding(m,registration);assertArtifactBindings(m,artifacts,policy);let dir=canonicalRoot;for(const part of ['docs','handoff','relay','v1','messages',m.projectId]){dir=paths.join(dir,part);try{fs.mkdirSync(dir);}catch(e){if(e.code!=='EEXIST')throw e;}const q=inspectRoot(dir);if(q.reason||q.canonical!==dir)reject('UNSAFE_STORAGE');}
  const final=paths.join(dir,messageId+'.json');fault('before-export');let publication=db.prepare('SELECT * FROM relay_publications WHERE message_id=?').get(messageId);
  const tempPath=()=>{if(!publication||publication.envelope_hash!==r.envelope_hash||!publication.temp_name.startsWith('.'+messageId+'.')||!/^\.[a-f0-9-]+\.[a-f0-9-]+\.tmp$/.test(publication.temp_name))reject('PUBLICATION_IDENTITY');return paths.join(dir,publication.temp_name);};
  const tempRead=links=>exactRead(tempPath(),r.canonical,{links,owned:publication.temp_identity});
  function finishLinks(){const st=fs.lstatSync(final);if(st.nlink===2&&publication){tempRead(2);exactRead(final,r.canonical,{links:2,owned:publication.temp_identity});fs.unlinkSync(tempPath());}else{exactRead(final,r.canonical);if(publication){let tempStat;try{tempStat=fs.lstatSync(tempPath());}catch(e){if(e.code!=='ENOENT')throw e;}if(tempStat){tempRead(1);fs.unlinkSync(tempPath());}}}exactRead(final,r.canonical);}
  let existing;try{existing=fs.lstatSync(final);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(existing)finishLinks();else{
   if(!publication){const name='.'+messageId+'.'+randomUUID()+'.tmp',temp=paths.join(dir,name),fd=fs.openSync(temp,'wx');try{publication={message_id:messageId,temp_name:name,temp_identity:identity(fs.fstatSync(fd)),envelope_hash:r.envelope_hash};tx(()=>{db.prepare('INSERT INTO relay_publications VALUES(?,?,?,?)').run(messageId,name,publication.temp_identity,r.envelope_hash);event('publication-intent',messageId,r.envelope_hash);});fault('after-intent');fs.writeFileSync(fd,r.canonical);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
   // Resume only the exact recorded single-link temporary inode. It is our
   // unpublished output, never a final file or an unrecorded temporary name.
   const pending=tempPath(),before=regular(pending,{limit:65536});if(identity(before)!==publication.temp_identity)reject('PUBLICATION_IDENTITY');
   const resume=fs.openSync(pending,fs.constants.O_RDWR|(fs.constants.O_NOFOLLOW||0));try{const opened=fs.fstatSync(resume);if(identity(opened)!==publication.temp_identity||opened.nlink!==1||identity(regular(pending,{limit:65536}))!==publication.temp_identity)reject('PUBLICATION_IDENTITY');storage();if(inspectRoot(dir).canonical!==dir)reject('UNSAFE_STORAGE');fs.ftruncateSync(resume,0);fs.writeFileSync(resume,r.canonical);fs.fsyncSync(resume);}finally{fs.closeSync(resume);}
   fault('after-temp');storage();if(inspectRoot(dir).canonical!==dir)reject('UNSAFE_STORAGE');tempRead(1);
   try{fs.linkSync(tempPath(),final);}catch(e){if(e.code!=='EEXIST')throw e;}
   fault('after-link');finishLinks();fault('after-export');
  }
  if(!db.prepare("SELECT 1 FROM relay_events WHERE kind='published' AND message_id=?").get(messageId))tx(()=>{db.prepare("UPDATE relay_messages SET state='saved' WHERE message_id=? AND state='proposed'").run(messageId);db.prepare('DELETE FROM relay_publications WHERE message_id=?').run(messageId);event('published',messageId,r.envelope_hash);});return {...view(row(messageId)),path:final};
 },expectedFence);}
 });
 journalContexts.set(journal,{fence,expectedFence,attended,registration,artifacts,policy,db,storage,assertCurrent:()=>match(current),row,tx,event});
 return journal;
}

// node scripts/forge/handoff.mjs <command> --request <absolute.json> [--apply]
// No --apply: read-only preview. Actual openRelayJournal objects are host-issued
// capabilities. CLI flags, JSON and environment variables cannot create one.
import {fileURLToPath} from 'node:url';
const cliKinds=Object.freeze({prepare:'assignment',seen:'seen',start:'start',result:'builder-result',review:'review-assignment',verdict:'verdict',consume:'consume',reconcile:'reconcile',expire:'expire','stop-request':'stop-request'});
function cliArgs(argv){
 const command=argv[0]||'poll',flags=Object.create(null);
 if(command!=='poll'&&!Object.hasOwn(cliKinds,command))reject('USAGE');
 for(let i=1;i<argv.length;i++){
  const key=argv[i];if(!['--request','--apply'].includes(key)||Object.hasOwn(flags,key))reject('USAGE');
  if(key==='--apply')flags[key]=true;
  else{const value=argv[++i];if(typeof value!=='string'||!value.trim()||value.startsWith('--'))reject('USAGE');flags[key]=value;}
 }
 if(command==='poll'&&(flags['--apply']||flags['--request'])||command!=='poll'&&!flags['--request'])reject('USAGE');
 return {command,request:flags['--request'],apply:flags['--apply']===true};
}
function readCliRequest(file){
 if(typeof file!=='string'||file.length>2048||file.includes('\0')||!paths.isAbsolute(file)||file!==file.trim())reject('REQUEST_PATH');
 const parts=file.slice(paths.parse(file).root.length).split(process.platform==='win32'?/[\\/]/:/\//);
 if(parts.some(p=>!p||p==='.'||p==='..'||/^(?:\.env(?:\.|$)|credentials(?:\.|$)|id_(?:rsa|ed25519)$|\.(?:aws|ssh|git|npmrc|netrc)$)|\.(?:pem|key)$/i.test(p)||process.platform==='win32'&&(p.includes(':')||/[. ]$/.test(p))))reject('REQUEST_PATH');
 if(inspectRoot(paths.dirname(file)).reason)reject('REQUEST_PATH');
 const before=regular(file,{limit:65536}),fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
 try{
  const opened=fs.fstatSync(fd);if(identity(opened)!==identity(before)||opened.nlink!==1)reject('REQUEST_CHANGED');
  const buffer=Buffer.alloc(65537);let size=0,n;while(size<buffer.length&&(n=fs.readSync(fd,buffer,size,buffer.length-size,null))>0)size+=n;
  const after=regular(file,{limit:65536}),end=fs.fstatSync(fd);
  if(size>65536||identity(after)!==identity(opened)||end.size!==size||end.mtimeMs!==opened.mtimeMs||after.mtimeMs!==opened.mtimeMs||inspectRoot(paths.dirname(file)).reason)reject('REQUEST_CHANGED');
  return validateEnvelope(buffer.subarray(0,size));
 }finally{fs.closeSync(fd);}
}
async function observeControl(c,m){
 const {attended,registration}=c;
 if(!attended||typeof attended.observe!=='function'||typeof attended.clock!=='function')reject('ATTENDANCE_REQUIRED');
 for(const key of ['projectId','repository','stateRoot','worktree','taskId','scopePaths','intentBinding'])if(canonicalize(m[key])!==canonicalize(registration[key]))reject('BINDING_MISMATCH');
 for(const who of ['sender','recipient'])if(canonicalize(m[who])!==canonicalize(attended.bindings?.[m[who].role]))reject('BINDING_MISMATCH');
 if(m.kind!=='seen'&&!['manager','owner'].includes(m.sender.role))reject('BINDING_MISMATCH');
 assertArtifactBindings(m,c.artifacts,c.policy);if(containsSecret(m))reject('MESSAGE_REFUSED');
 const proof=await attended.observe(m);
 if(!proof||!['session_observed','owner_attested'].includes(proof.provenance)||proof.envelopeHash!==m.envelopeHash||canonicalize(proof.actor)!==canonicalize(m.sender)||!id(proof.evidenceRef))reject('ATTENDANCE_REQUIRED');
 if(m.kind!=='seen'&&(!id(proof.authorityRef)||proof.authorityRef!==m.payload.authorityRef))reject('AUTHORITY_REQUIRED');
 c.storage();c.assertCurrent();
 const target=validateEnvelope(c.row(m.kind==='seen'?m.payload.originalId:m.payload.targetId).canonical);
 if(m.rootMessageId!==target.rootMessageId||m.claimId!==target.claimId||m.inReplyTo!==target.messageId)reject('CONTROL_TARGET');
 if(m.kind==='seen'?(m.payload.originalHash!==target.envelopeHash||canonicalize(m.sender)!==canonicalize(target.recipient)):m.payload.targetGeneration!==target.capWindow.leaseGeneration)reject('CONTROL_TARGET');
 return target;
}
export async function runHandoff(argv,{controller=null,transport={mode:'disabled'},out=s=>process.stdout.write(s+'\n'),err=s=>process.stderr.write(s+'\n')}={}){
 try{
  const {command,request,apply}=cliArgs(argv),c=journalContexts.get(controller);
  const {transportStatus,initializeTransport,saveTransport,exerciseSimulatedTransport}=await import('./transport.mjs');
  if(command==='poll'){
   if(c){c.storage();c.assertCurrent();}
   out(JSON.stringify({command,readOnly:true,transport:transportStatus(),journal:c?{checkpoint:controller.checkpoint(),counts:controller.counts(),claims:c.db.prepare('SELECT claim_id AS claimId,status,capacity_held AS capacityHeld,task_held AS taskHeld,financial_held AS financialHeld FROM relay_claims WHERE project=? AND task=? LIMIT 100').all(c.registration.projectId,c.registration.taskId),active:c.attended?controller.attendedStatus():[]}:null,code:c?'JOURNAL_PROJECTION':'HOST_CONTEXT_UNAVAILABLE'}));return 0;
  }
  if(apply&&!c)reject('HOST_CONTEXT_REQUIRED'); // before reading a request
  const m=readCliRequest(request);if(m.kind!==cliKinds[command])reject('COMMAND_KIND');
  if(!apply){out(JSON.stringify({command,readOnly:true,messageId:m.messageId,envelopeHash:m.envelopeHash,admitted:false,transport:transportStatus()}));return 0;}
  let result;
  if(['seen','reconcile','stop-request','expire'].includes(command)){
   const target=await observeControl(c,m);
   if(command==='expire'){
    if(m.sender.role!=='manager'||!['assignment','review-assignment'].includes(target.kind)||m.capWindow.stopFence!==c.expectedFence.expectedGeneration||!m.payload.evidenceRefs.some(e=>e.ref===target.messageId&&e.sha256===target.envelopeHash))reject('EXPIRY_TARGET');
    result=await withFencedEffect(c.fence,()=>c.tx(()=>{
     const existing=c.db.prepare('SELECT * FROM relay_messages WHERE message_id=? OR intent_key=?').get(m.messageId,m.idempotencyKey);
     if(existing&&existing.envelope_hash!==m.envelopeHash)reject('MESSAGE_CONFLICT');
     const admitted=c.db.prepare('SELECT applied FROM relay_attended WHERE message_id=?').get(target.messageId);
     if(!admitted?.applied||c.row(target.messageId).state==='unknown')reject('EXPIRY_TARGET');
     const clock=c.attended.clock();if(!clock||!Number.isSafeInteger(clock.utc)||!Number.isFinite(clock.monotonic)||!id(clock.identity))reject('CLOCK_REQUIRED');
     const r=expireRelayClaim(c.db,{project:target.projectId,claimId:target.claimId,key:target.idempotencyKey,epoch:target.intentBinding.authorityEpoch,generation:target.capWindow.leaseGeneration,now:clock.utc});
     if(!existing){
      const bytes=canonicalize(m),size=c.db.prepare('SELECT count(*) n,coalesce(sum(length(CAST(canonical AS BLOB))),0) bytes FROM relay_messages').get();
      if(size.n>=5000||size.bytes+Buffer.byteLength(bytes)>8*1024*1024)reject('JOURNAL_QUOTA');
      c.db.prepare("INSERT INTO relay_messages VALUES(?,?,?,?,?,'expiry-recorded')").run(m.messageId,m.idempotencyKey,m.payloadHash,m.envelopeHash,bytes);c.event('expiry-recorded',m.messageId,m.envelopeHash);
     }
     return {messageId:m.messageId,claimId:r.claim_id,status:r.status,capacityHeld:!!r.capacity_held,taskHeld:!!r.task_held,financialHeld:!!r.financial_held,workersStopped:false};
    }),c.expectedFence);
   }
   else if(command==='seen')result=await withFencedEffect(c.fence,()=>c.tx(()=>{
    const old=c.db.prepare('SELECT * FROM relay_messages WHERE message_id=? OR intent_key=?').get(m.messageId,m.idempotencyKey);
    if(old){if(old.envelope_hash!==m.envelopeHash)reject('MESSAGE_CONFLICT');return {messageId:old.message_id,state:old.state,start:'unobserved'};}
    const size=c.db.prepare('SELECT count(*) n,coalesce(sum(length(CAST(canonical AS BLOB))),0) bytes FROM relay_messages').get(),bytes=canonicalize(m);
    if(size.n>=5000||size.bytes+Buffer.byteLength(bytes)>8*1024*1024)reject('JOURNAL_QUOTA');
    c.db.prepare("INSERT INTO relay_messages VALUES(?,?,?,?,?,'seen')").run(m.messageId,m.idempotencyKey,m.payloadHash,m.envelopeHash,bytes);c.event('seen',m.messageId,m.envelopeHash);
    return {messageId:m.messageId,state:'seen',start:'unobserved'};
   }),c.expectedFence);
   else if(command==='stop-request'){
    if(checkFence(c.fence,c.expectedFence).state!=='ALLOW')reject('FENCE_HELD');
    result=await requestPause(c.fence,{requestId:m.payload.operationId});
   }else{
    const prior=c.db.prepare('SELECT canonical FROM relay_attended WHERE message_id=?').get(target.messageId),op=prior&&JSON.parse(prior.canonical).op;
    if(!op)reject('RECORDED_OPERATION_REQUIRED');
    const recorded=c.db.prepare('SELECT canonical,at_ms FROM relay_operations WHERE operation_id=?').get(op.id);
    if(!recorded)reject('RECORDED_OPERATION_REQUIRED');
    result={...await controller.applyPreparedState(JSON.parse(recorded.canonical),{now:recorded.at_ms}),attendedFinalization:'pending'};
   }
  }else{
   if(['prepare','review'].includes(command)&&!['save-only','simulated'].includes(transport?.mode))reject('TRANSPORT_DISABLED');
   if(transport?.mode==='simulated'&&(!transport.adapter||transport.adapter.kind!=='simulated'||typeof transport.adapter.send!=='function'))reject('SIMULATED_ADAPTER_REQUIRED');
   result=await controller.attend(canonicalize(m));
   if(['prepare','review'].includes(command)){
    const saved=await controller.publish(result.messageId);
    let delivery={mode:'save-only',delivery:'not-delivered',start:'unobserved',path:saved.path};
    if(transport.mode==='simulated')delivery=await withFencedEffect(c.fence,async()=>{
     c.storage();c.assertCurrent();initializeTransport(c.db);
     saveTransport(c.db,c.row(result.messageId).canonical);
     return {mode:'simulated',...await exerciseSimulatedTransport(c.db,result.messageId,transport.adapter)};
    },c.expectedFence);
    result={...result,transport:delivery};
   }
  }
  out(JSON.stringify({command,readOnly:false,result}));return 0;
 }catch(e){const code=/^[A-Z][A-Z0-9_]{0,79}$/.test(e?.code||'')?e.code:'HANDOFF_REFUSED';err(JSON.stringify({code}));return code==='USAGE'?2:1;}
}
// Canonical, import-safe entry check: Node loads the ESM entry through its realpath (macOS /var -> /private/var,
// Windows junctions); an unresolved comparison skipped runHandoff and exited 0 silently (stop-request false success).
const isMain=(()=>{try{return !!process.argv[1]&&fs.realpathSync(paths.resolve(process.argv[1]))===fs.realpathSync(fileURLToPath(import.meta.url));}catch{return false;}})();
if(isMain)runHandoff(process.argv.slice(2)).then(code=>{process.exitCode=code;});
