// Durable attended existing-session Claude Cloud turns. No polling, browser transport,
// enrollment, credential reads or ledger mutation. A native ACK proves submission only.
// Same-user filesystem records are integrity/recovery evidence, not OS isolation.
import * as fs from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const requireBuiltin=createRequire(import.meta.url);
import {parseNativeTransport} from './handoff.mjs';
import {inspectRoot} from './portfolio-policy.mjs';
import {resolveAgentCommand,processStartMs} from './dispatch-lib.mjs';
import {pathOwnedBy,containsSecret} from './state-lib.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const session=v=>typeof v==='string'&&/^session_[A-Za-z0-9]{1,100}$/.test(v);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
const fail=code=>{throw Object.assign(new Error(code),{code});};
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===[...keys].sort().join(',');
const now=d=>{const n=(d.clock||Date.now)();if(!Number.isSafeInteger(n))fail('CLOCK_REQUIRED');return n;};
function rootAt(root){const p=inspectRoot(root);if(p.reason)fail('UNSAFE_ROOT');return p.canonical;}
function pathSafe(p,scope=false){
 if(typeof p!=='string'||!p||p.length>256||/[\\:\x00-\x1f\x7f]/.test(p)||p.startsWith('/'))return false;
 return p.split('/').every((s,i,parts)=>s&&s!=='.'&&s!=='..'&&!/[. ]$/.test(s)&&!/^\.?(?:git|ssh|aws|npmrc|netrc)$|^\.env(?:\.|$)|^credentials(?:\.|$)|^id_(?:rsa|ed25519)$|\.(?:pem|key)$/i.test(s)&&!/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s)&&(scope&&s==='**'&&i===parts.length-1||/^[A-Za-z0-9_. -]+$/.test(s)));
}
function put(path,value){
 const bytes=Buffer.from(JSON.stringify(value));
 if(bytes.length>65536)fail('RECORD_LIMIT');
 let fd;try{fd=fs.openSync(path,'wx',0o600);}catch(e){if(e.code==='EEXIST')return false;throw e;}
 try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 return true;
}
function read(path){
 const s=fs.lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>65536)fail('UNSAFE_RECORD');
 const fd=fs.openSync(path,'r');
 try{const opened=fs.fstatSync(fd);if(opened.ino!==s.ino||opened.dev!==s.dev||opened.nlink!==1)fail('UNSAFE_RECORD');return parseNativeTransport(fs.readFileSync(fd));}finally{fs.closeSync(fd);}
}
const present=path=>{try{fs.lstatSync(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
function open({root,requestId}){
 if(!uuid(requestId))fail('REQUEST_ID');
 root=rootAt(root);const dir=join(root,requestId);if(rootAt(dir)!==dir)fail('UNSAFE_ROOT');
 const record=read(join(dir,'request.json')),r=record.request;
 if(!exact(record,['request','requestHash'])||hash(JSON.stringify(r))!==record.requestHash||r.requestId!==requestId||r.version!=='attended-cloud/1'||!session(r.sessionId))fail('REQUEST_BINDING');
 const wire=read(join(dir,'prompt.json'));
 if(!exact(wire,['text'])||hash(wire.text)!==r.wirePromptSha256)fail('PROMPT_CHANGED');
 return {root,dir,r,requestHash:record.requestHash,wirePrompt:wire.text};
}
function status(c){
 const has=name=>present(join(c.dir,name)),base={requestId:c.r.requestId,sessionId:c.r.sessionId,inputSha:c.r.inputSha,requestHash:c.requestHash,scopePaths:[...c.r.scopePaths],promptSha256:c.r.promptSha256,promptRef:join(c.dir,'prompt.json'),launch:has('launch-attempt.json')?'attempted':'not_attempted',financial:'held',completionObserved:false,stop:'unknown'};
 if(has('observation-conflict.json'))return {...base,state:'held',code:'OBSERVATION_CONFLICT'};
 if(has('consumed.json'))return {...base,state:'consumed',completionObserved:true,stop:'host-observed-idle',resultHash:readResult(c).resultHash};
 if(has('observed.json'))return {...base,state:'observed',completionObserved:true,stop:'host-observed-idle',resultHash:readResult(c).resultHash};
 if(has('observation-held.json'))return {...base,state:'held',code:read(join(c.dir,'observation-held.json')).code};
 if(has('submit-outcome.json')){const o=read(join(c.dir,'submit-outcome.json'));return {...base,state:o.accepted?'pending':'held',code:o.code};}
 return {...base,state:has('submit-intent.json')?'held':'prepared',code:has('submit-intent.json')?'SUBMISSION_UNKNOWN':'NOT_SUBMITTED'};
}
export function cloudTurnStatus(options){return status(open(options));}
const lockPath=c=>join(c.root,'session-'+hash(c.r.sessionId)+'.lock');
const identity=s=>[s.dev,s.ino,s.birthtimeMs].join(':');
let processOwner;
function ownerIdentity(){
 if(!processOwner){const startedAtMs=processStartMs(process.pid);if(!Number.isFinite(startedAtMs)||startedAtMs<=0)fail('LOCK_OWNER_UNKNOWN');processOwner={pid:process.pid,startedAtMs};}
 return {...processOwner,token:randomUUID()};
}
function snapshot(path){
 const before=fs.lstatSync(path);
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>65536)fail('UNSAFE_RECORD');
 const fd=fs.openSync(path,'r');
 try{
  const opened=fs.fstatSync(fd);if(identity(opened)!==identity(before)||opened.nlink!==1)fail('SESSION_LOCK_CHANGED');
  const bytes=fs.readFileSync(fd),end=fs.fstatSync(fd),after=fs.lstatSync(path);
  if(bytes.length>65536||identity(opened)!==identity(after)||identity(end)!==identity(opened)||end.nlink!==1
    ||after.isSymbolicLink()||after.size!==bytes.length||end.size!==bytes.length
    ||opened.mtimeMs!==end.mtimeMs||opened.mtimeMs!==after.mtimeMs)fail('SESSION_LOCK_CHANGED');
  return {value:parseNativeTransport(bytes),identity:identity(after),hash:hash(bytes)};
 }finally{fs.closeSync(fd);}
}
function sameSnapshot(path,prior){
 try{const current=snapshot(path);return current.identity===prior.identity&&current.hash===prior.hash;}catch{return false;}
}
// Serialize every lock mutation with SQLite's native transaction lock. This
// empty database is only a mutex, never authority/provider state. Unlike a
// directory guard, its exclusion is released by the OS when an owner crashes.
function guarded(lock,fn){
 const guard=lock+'.mutex.db';
 const qualify=()=>{if(present(guard)){const s=fs.lstatSync(guard);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)fail('UNSAFE_RECORD');}};
 qualify();let db;
 try{
  const {DatabaseSync}=requireBuiltin('node:sqlite');db=new DatabaseSync(guard);qualify();
  try{db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');}catch{fail('SESSION_LOCK_HELD');}
  try{return fn();}finally{db.exec('ROLLBACK');}
 }finally{db?.close();}
}
function sessionTransaction(c,fn,deps={}){
 const lock=lockPath(c),owner=ownerIdentity();
 // fn is synchronous and only mutates local records. Keep one native mutex
 // through creation, work and cleanup: cleanup never has to reacquire it.
 // Provider submission and awaited host callbacks remain outside this boundary.
 return guarded(lock,()=>{
  if(!put(lock,{version:'cloud-session-lock/1',sessionId:c.r.sessionId,requestId:c.r.requestId,owner}))fail('SESSION_LOCK_HELD');
  const held=snapshot(lock);
  try{
   deps.fault?.('after-session-lock-persisted');deps.fault?.('after-session-lock');
   const value=fn();deps.fault?.('before-session-unlock');return value;
  }finally{if(sameSnapshot(lock,held))fs.unlinkSync(lock);}
 });
}
// Host callback must confirm this exact owner's exit from a retained native
// process handle/exit event or equivalent positive host evidence. PID absence,
// age, caller JSON and timeout are not proof. Recovery only removes the lock;
// submission intent, session hold, results and financial holds remain untouched.
export async function recoverCloudSessionLock(options){
 if(typeof options?.confirmOwnerExit!=='function')fail('HOST_OWNER_EXIT_REQUIRED');
 const c=open(options),lock=lockPath(c);let prior;try{prior=snapshot(lock);}catch{fail('LOCK_OWNER_UNKNOWN');}const record=prior.value,o=record.owner;
 if(!exact(record,['version','sessionId','requestId','owner'])||record.version!=='cloud-session-lock/1'||record.sessionId!==c.r.sessionId||!uuid(record.requestId)
   ||!exact(o,['pid','startedAtMs','token'])||!Number.isSafeInteger(o.pid)||o.pid<=0||!Number.isFinite(o.startedAtMs)||o.startedAtMs<=0||!uuid(o.token))fail('LOCK_OWNER_UNKNOWN');
 const nonce=randomUUID(),challenge=Object.freeze({nonce,sessionId:record.sessionId,requestId:record.requestId,owner:Object.freeze({...o}),lockHash:prior.hash});
 const proof=await options.confirmOwnerExit(challenge);
 if(!exact(proof,['nonce','owner','state','evidenceRef'])||proof.nonce!==nonce||JSON.stringify(proof.owner)!==JSON.stringify(o)||proof.state!=='exited'||!id(proof.evidenceRef))fail('OWNER_EXIT_UNCONFIRMED');
 return guarded(lock,()=>{
  if(!sameSnapshot(lock,prior))fail('SESSION_LOCK_CHANGED');
  const receipt={sessionId:record.sessionId,requestId:record.requestId,owner:o,lockHash:prior.hash,evidenceRef:proof.evidenceRef};
  const recoveryFile=join(c.root,'recovered-'+o.token+'.json');
  if(!put(recoveryFile,receipt)){const old=read(recoveryFile);if(!exact(old,Object.keys(receipt))||!id(old.evidenceRef)||JSON.stringify({...old,evidenceRef:receipt.evidenceRef})!==JSON.stringify(receipt))fail('RECOVERY_CONFLICT');}
  fs.unlinkSync(lock);
  return {recovered:true,...receipt,submission:'unchanged',financial:'held'};
 });
}
function claimSession(c){
 const file=join(c.root,'session-'+hash(c.r.sessionId)+'.hold');
 if(present(file)){
  const old=read(file);
  if(old.requestId===c.r.requestId)return;
  if(!uuid(old.requestId))fail('SESSION_HELD');
  const prior=open({root:c.root,requestId:old.requestId});
  if(status(prior).state!=='consumed')fail('SESSION_HELD');
  fs.unlinkSync(file);
 }
 put(file,{requestId:c.r.requestId,sessionId:c.r.sessionId});
}
export function prepareCloudTurn({root,worktree,sessionId,inputSha,scopePaths,prompt,requestId=randomUUID()},deps={}){
 root=rootAt(root);worktree=rootAt(worktree);
 if(!session(sessionId)||!uuid(requestId)||!(/^[a-f0-9]{40}$/.test(inputSha||''))||typeof prompt!=='string'||!prompt||Buffer.byteLength(prompt)>8192||containsSecret(prompt)||!Array.isArray(scopePaths)||!scopePaths.length||scopePaths.length>10||scopePaths.some(p=>!pathSafe(p,true))||new Set(scopePaths.map(p=>p.toLowerCase())).size!==scopePaths.length)fail('REQUEST_INPUT');
 const normalized=[...scopePaths].sort(),dir=join(root,requestId);
 const bound={requestId,sessionId,inputSha,scopePaths:normalized,promptSha256:hash(prompt),worktree};
 const wirePrompt=JSON.stringify({request:bound,instruction:'Return proposed file contents only, bound to requestId, sessionId and inputSha. Do not claim host completion or approval.',task:prompt});
 if(present(dir)){
  const prior=open({root,requestId});
  for(const k of Object.keys(bound))if(JSON.stringify(prior.r[k])!==JSON.stringify(bound[k]))fail('REQUEST_CONFLICT');
  return status(prior);
 }
 fs.mkdirSync(dir);const request={version:'attended-cloud/1',...bound,wirePromptSha256:hash(wirePrompt),preparedAt:now(deps)};
 put(join(dir,'prompt.json'),{text:wirePrompt});
 put(join(dir,'request.json'),{request,requestHash:hash(JSON.stringify(request))});
 return status(open({root,requestId}));
}
function nativeSubmission(command,args,cwd,timeoutMs,maxOutputBytes,transport){
 return new Promise(resolve=>{
  let child,done=false,out=Buffer.alloc(0),err=Buffer.alloc(0),exit=null;
  const timer=setTimeout(()=>finish('SUBMIT_TIMEOUT'),timeoutMs);
  function finish(code){
   if(done)return;done=true;clearTimeout(timer);let cancellationRequested=false;
   if(code&&child&&exit===null){try{cancellationRequested=child.kill()===true;}catch{}}
   resolve({code,stdout:out,stdoutSha256:hash(out),stderrSha256:hash(err),exit,cancellationRequested});
  }
  try{child=transport(command[0],[...command.slice(1),...args],{cwd,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});}catch{return finish('SUBMIT_SPAWN_FAILED');}
  for(const [channel,key]of [[child.stdout,'out'],[child.stderr,'err']])channel.on('data',bytes=>{
   if(done)return;const b=Buffer.from(bytes);
   if(out.length+err.length+b.length>maxOutputBytes)return finish('SUBMIT_OUTPUT_LIMIT');
   if(key==='out')out=Buffer.concat([out,b]);else err=Buffer.concat([err,b]);
  });
  child.once('error',()=>finish('SUBMIT_PROCESS_ERROR'));
  child.once('close',(code,signal)=>{if(done)return;exit={code,signal:signal||null};finish(code===0&&!signal?null:'SUBMIT_PROCESS_FAILED');});
 });
}
export async function submitCloudTurn(options,deps={}){
 const c=open(options),prior=status(c);if(prior.state!=='prepared')return prior;
 if(typeof options?.beforeSubmit!=='function')fail('HOST_ADMISSION_REQUIRED');
 const timeoutMs=deps.timeoutMs??60000,maxOutputBytes=deps.maxOutputBytes??65536;
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000||!Number.isInteger(maxOutputBytes)||maxOutputBytes<128||maxOutputBytes>65536)fail('SUBMIT_LIMIT');
 const command=(deps.resolveCommand||resolveAgentCommand)('claude-code');
 if(!Array.isArray(command)||!command.length||command.some(v=>typeof v!=='string')||!isAbsolute(command[0]))fail('COMMAND_RESOLUTION');
 rootAt(c.r.worktree);
 const intent={requestHash:c.requestHash,requestId:c.r.requestId,sessionId:c.r.sessionId,at:now(deps),mode:deps.transport?'simulated':'native'};
 const reserved=sessionTransaction(c,()=>{
  if(present(join(c.dir,'submit-intent.json')))return false;
  claimSession(c);return put(join(c.dir,'submit-intent.json'),intent);
 },deps);
 if(!reserved)return status(c);
 deps.fault?.('after-submit-intent'); // crash here is durably HELD; never resend
 let admissionTimer;
 try{
  const pointer=Object.freeze({requestId:c.r.requestId,sessionId:c.r.sessionId,inputSha:c.r.inputSha,promptSha256:c.r.promptSha256,requestHash:c.requestHash,hostSubmitIntentAt:intent.at,modelAcknowledged:false,mode:intent.mode});
  await Promise.race([Promise.resolve().then(()=>options.beforeSubmit(pointer)),new Promise((_,reject)=>{admissionTimer=setTimeout(()=>reject(Object.assign(Error('HOST_ADMISSION_TIMEOUT'),{code:'HOST_ADMISSION_TIMEOUT'})),timeoutMs);})]);
 }catch(e){
  const causeCode=e?.code??e?.message;
  const cause=id(causeCode)&&causeCode.length<=64&&/^[A-Z]/.test(causeCode)&&! /[^A-Z0-9_]/.test(causeCode)?{cause:causeCode}:{};
  put(join(c.dir,'submit-outcome.json'),{accepted:false,code:'HOST_ADMISSION_FAILED',...cause,requestHash:c.requestHash,at:now(deps),mode:intent.mode,launchAttempted:false});
  return status(c);
 }finally{clearTimeout(admissionTimer);}
 put(join(c.dir,'launch-attempt.json'),{requestHash:c.requestHash,at:now(deps),mode:intent.mode});
 const args=['--safe-mode','-p',c.wirePrompt,'--cloud',c.r.sessionId,'--output-format','json'];
 const result=await nativeSubmission(command,args,c.r.worktree,timeoutMs,maxOutputBytes,deps.transport||spawn);
 let code=result.code,ack=null;
 if(!code)try{
  ack=parseNativeTransport(result.stdout);
  if(!exact(ack,['ok','session_id','url'])||ack.ok!==true||ack.session_id!==c.r.sessionId||typeof ack.url!=='string')fail('SUBMIT_ACK_BINDING');
  // Installed CLI 2.1.296 appends from=cli&m=0. Match only the exact bound
  // production URL and that pair (either order); no URL normalization aliases,
  // extra/duplicate query keys, credentials, ports, fragments or path prefixes.
  const url='https://claude.ai/code/'+c.r.sessionId;
  if(![url,url+'?from=cli&m=0',url+'?m=0&from=cli'].includes(ack.url))fail('SUBMIT_ACK_URL');
 }catch(e){code=id(e.code)?e.code:'SUBMIT_ACK_INVALID';}
 deps.fault?.('before-submit-outcome');
 put(join(c.dir,'submit-outcome.json'),{accepted:!code,code:code||'SUBMITTED_PENDING',requestHash:c.requestHash,at:now(deps),mode:intent.mode,ack:code?null:ack,stdoutSha256:result.stdoutSha256,stderrSha256:result.stderrSha256,exit:result.exit,cancellationRequested:result.cancellationRequested});
 return status(c);
}
function validateObservation(value,c,intent,at){
 const o=parseNativeTransport(typeof value==='string'?value:JSON.stringify(value));
 if(!exact(o,['sessionId','requestId','inputSha','files','final','idle','observedAt','evidenceRef'])||o.sessionId!==c.r.sessionId||o.requestId!==c.r.requestId||o.inputSha!==c.r.inputSha)fail('OBSERVATION_BINDING');
 const stamp=Date.parse(o.observedAt);
 if(typeof o.observedAt!=='string'||!Number.isFinite(stamp)||stamp<intent.at||stamp>at+1000||at-stamp>60000)fail('OBSERVATION_STALE');
 if(o.final!==true||o.idle!==true)fail('STOP_UNOBSERVED');
 if(!id(o.evidenceRef)||!Array.isArray(o.files)||!o.files.length||o.files.length>10||Buffer.byteLength(JSON.stringify(o.files))>32768)fail('OBSERVATION_LIMIT');
 const seen=new Set();
 for(const f of o.files){
  if(!exact(f,['path','content'])||!pathSafe(f.path)||!pathOwnedBy(f.path,c.r.scopePaths)||seen.has(f.path.toLowerCase())||typeof f.content!=='string'||Buffer.byteLength(f.content)>8192||containsSecret(f.content))fail('PROPOSAL_REFUSED');
  const key=f.path.toLowerCase();
  if([...seen].some(prior=>key.startsWith(prior+'/')||prior.startsWith(key+'/')))fail('PROPOSAL_REFUSED');
  seen.add(key);
 }
 return o;
}
function resultDigest(record){
 return hash(JSON.stringify({requestHash:record.requestHash,observation:record.observation,validatedAt:record.validatedAt,mode:record.mode}));
}
function consumedReceipt(c,result){return {requestId:c.r.requestId,requestHash:c.requestHash,resultHash:result.resultHash};}
function readResult(c){
 try{
  const record=read(join(c.dir,'observed.json')),intent=read(join(c.dir,'submit-intent.json'));
  if(!exact(record,['requestHash','resultHash','observation','validatedAt','mode'])||record.requestHash!==c.requestHash
    ||intent.requestHash!==c.requestHash||!Number.isSafeInteger(intent.at)||!Number.isSafeInteger(record.validatedAt)||record.validatedAt<intent.at
    ||!present(join(c.dir,'launch-attempt.json'))||record.mode!==(intent.mode==='simulated'?'simulated':'host-observed')
    ||resultDigest(record)!==record.resultHash)fail('RESULT_CHANGED');
  // Freshness is checked at original validation time, not later consumption.
  // Revalidate every semantic field; a stored hash never replaces validation.
  validateObservation(record.observation,c,intent,record.validatedAt);
  if(present(join(c.dir,'consumed.json'))&&JSON.stringify(read(join(c.dir,'consumed.json')))!==JSON.stringify(consumedReceipt(c,record)))fail('RESULT_CHANGED');
  return record;
 }catch{fail('RESULT_CHANGED');}
}
export async function observeCloudTurn(options,deps={}){
 if(typeof options?.observe!=='function')fail('HOST_OBSERVER_REQUIRED');
 const c=open(options),prior=status(c);
 if(['observed','consumed'].includes(prior.state)||prior.code==='OBSERVATION_CONFLICT')return prior;
 if(!present(join(c.dir,'submit-intent.json'))||!present(join(c.dir,'launch-attempt.json')))fail('SUBMISSION_REQUIRED');
 const intent=read(join(c.dir,'submit-intent.json'));
 if(intent.requestHash!==c.requestHash)fail('REQUEST_BINDING');
 const timeoutMs=deps.timeoutMs??5000;if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)fail('OBSERVATION_LIMIT');
 let timer;
 try{
  const pointer=Object.freeze({requestId:c.r.requestId,sessionId:c.r.sessionId,inputSha:c.r.inputSha,scopePaths:Object.freeze([...c.r.scopePaths]),promptSha256:c.r.promptSha256,submittedAfter:intent.at});
  const raw=await Promise.race([Promise.resolve().then(()=>options.observe(pointer)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('OBSERVATION_TIMEOUT'),{code:'OBSERVATION_TIMEOUT'})),timeoutMs);})]);
  const validatedAt=now(deps),observation=validateObservation(raw,c,intent,validatedAt);
  const record={requestHash:c.requestHash,observation,validatedAt,mode:intent.mode==='simulated'?'simulated':'host-observed'}; const resultHash=record.resultHash=resultDigest(record);
  if(!put(join(c.dir,'observed.json'),record)&&read(join(c.dir,'observed.json')).resultHash!==resultHash)put(join(c.dir,'observation-conflict.json'),{code:'OBSERVATION_CONFLICT'});
 }catch(e){put(join(c.dir,'observation-held.json'),{code:id(e.code)?e.code:'OBSERVATION_REFUSED',at:now(deps)});}
 finally{clearTimeout(timer);}
 return status(c);
}
// Resume is read/observe only. It NEVER calls submit, wakes a provider or schedules work.
export async function resumeCloudTurn(options,deps={}){return typeof options?.observe==='function'?observeCloudTurn(options,deps):cloudTurnStatus(options);}
export function consumeCloudTurn(options,deps={}){
 const c=open(options),prior=status(c);if(!['observed','consumed'].includes(prior.state))fail('CLOUD_RESULT_HELD');
 const result=readResult(c);

 sessionTransaction(c,()=>{
  if(present(join(c.dir,'observation-conflict.json')))fail('CLOUD_RESULT_HELD');
  const current=readResult(c);if(current.resultHash!==result.resultHash)fail('RESULT_CHANGED');
  const receipt=consumedReceipt(c,result);
  if(!put(join(c.dir,'consumed.json'),receipt)&&JSON.stringify(read(join(c.dir,'consumed.json')))!==JSON.stringify(receipt))fail('CONSUME_CONFLICT');
 },deps);
 return {...status(c),files:result.observation.files,evidenceRef:result.observation.evidenceRef};
}
