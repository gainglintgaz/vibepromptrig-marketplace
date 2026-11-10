// S8 attended Windows output-fence capability. No CLI/provisioning/activation.
// This scoped adapter does NOT qualify the older project-discovery/ledger pass,
// unattended isolation, restore recovery or worker termination. No resume API.
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { inspectRoot } from './portfolio-policy.mjs';

const contexts=new WeakMap(), locks=new WeakMap(), ownedRuns=new WeakMap();
const id=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, counter=/^(0|[1-9][0-9]{0,15})$/;
const fail=(code,message)=>Object.assign(new Error(`${code}: ${message}`),{code});
const identity=s=>`${s.dev}:${s.ino}`;
function state(context) { const s=contexts.get(context); if(!s) throw fail('UNKNOWN','unrecognized fence capability'); return s; }
function root(s) {
  const checked=inspectRoot(s.runtime);
  if(checked.reason || checked.canonical!==s.runtime || identity(lstatSync(s.runtime))!==s.rootIdentity) throw fail('UNKNOWN','runtime identity changed');
}
function plainFile(path,max) {
  const before=lstatSync(path);
  if(!before.isFile() || before.isSymbolicLink() || before.nlink!==1 || before.size>max) throw fail('UNKNOWN','unsafe control entry');
  const fd=openSync(path,'r');
  try {
    const opened=fstatSync(fd); if(identity(before)!==identity(opened)) throw fail('UNKNOWN','control entry changed');
    const buffer=Buffer.alloc(max+1); const length=readSync(fd,buffer,0,buffer.length,0); const bytes=buffer.subarray(0,length);
    const after=lstatSync(path);
    if(bytes.length>max || identity(after)!==identity(opened) || after.nlink!==1 || after.isSymbolicLink()) throw fail('UNKNOWN','control entry changed');
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  } finally { closeSync(fd); }
}
// Conservative request inspection for the legacy discovery pass. It supplies
// no native fenced acknowledgment and cannot qualify that pass's nested helpers.
export function inspectPauseRequest(runtime) {
  try{plainFile(join(runtime,'STOP'),4096);return {state:'PAUSED'};}
  catch(e){return e.code==='ENOENT'?{state:'ALLOW'}:{state:'UNKNOWN'};}
}
class NativeChannel {
  constructor(path,request) {
    this.token=randomBytes(16).toString('hex'); this.messages=[]; this.buffer=''; this.error=null; this.closed=false;
    this.child=spawn(path,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.done=new Promise(resolveDone=>this.child.once('close',()=>{this.closed=true; resolveDone();}));
    this.child.on('error',()=>{this.error=fail('UNKNOWN','native gate launch failed');});
    this.child.stdin.on('error',()=>{this.error=fail('UNKNOWN','native gate channel closed');});
    this.child.stderr.resume();
    this.child.stdout.on('data',bytes=>{
      this.buffer+=bytes;
      if(this.buffer.length>8192){this.error=fail('UNKNOWN','native gate response exceeds bound'); this.child.stdin.end();return;}
      for(;;){const n=this.buffer.indexOf('\n');if(n<0)break;const line=this.buffer.slice(0,n);this.buffer=this.buffer.slice(n+1);
        try { const m=JSON.parse(line); if(m.state!=='gate-waiting') this.messages.push(m); } catch {this.error=fail('UNKNOWN','invalid native gate response');}
      }
      if(this.messages.length>8){this.error=fail('UNKNOWN','unexpected native gate responses');this.child.stdin.end();}
    });
    this.send(request);
  }
  alive(){return !this.closed && !this.error && this.child.exitCode===null && this.child.signalCode===null;}
  send(command){this.child.stdin.write(JSON.stringify({...command,token:this.token})+'\n');}
  async take(expected){
    const end=performance.now()+6000;
    for(;;){
      if(this.messages.length){const m=this.messages.shift();if(m.state===expected)return m;throw fail('UNKNOWN',`native gate ${m.state}`);}
      if(!this.alive())throw this.error||fail('UNKNOWN','native gate exited');
      if(performance.now()>end){this.error=fail('UNKNOWN','native gate response timed out');this.child.stdin.end();throw this.error;}
      await new Promise(r=>setTimeout(r,5));
    }
  }
  async close(){this.child.stdin.end();await this.done;}
}
class NativeGate extends NativeChannel {
  constructor(path,gate,leasePath){super(path,{version:1,op:'gate-server',gate,leasePath});}
  async acquire(){this.leaseId=randomBytes(16).toString('hex');this.send({op:'acquire',waitMs:5000,leaseId:this.leaseId});const ack=await this.take('gate-acquired');if(ack.leaseId!==this.leaseId)throw fail('UNKNOWN','native admission record mismatch');}
  async release(){this.send({op:'release',leaseId:this.leaseId});await this.take('gate-released');this.leaseId=null;}
}
// Called only by the attended owner/controller with a separately compiled pinned
// helper. Neither environment nor project files can create this capability.
export async function createAttendedFence({runtime,runtimeId,authorityEpoch,generation,helper}) {
  if(process.platform!=='win32')throw fail('UNSUPPORTED','native Windows fence required');
  if(![runtimeId,authorityEpoch].every(x=>typeof x==='string'&&id.test(x))||typeof generation!=='string'||!counter.test(generation))throw fail('UNKNOWN','invalid control binding');
  const checked=inspectRoot(runtime);if(checked.reason)throw fail('UNKNOWN',checked.reason);
  if(!helper || !/^[a-f0-9]{64}$/.test(helper.sha256))throw fail('UNKNOWN','pinned native helper required');
  const parent=inspectRoot(dirname(resolve(helper.path)));if(parent.reason)throw fail('UNKNOWN','unsafe helper parent');
  const hs=lstatSync(helper.path);if(!hs.isFile()||hs.isSymbolicLink()||hs.nlink!==1||hs.size>4*1024*1024)throw fail('UNKNOWN','unsafe helper');
  if(createHash('sha256').update(readFileSync(helper.path)).digest('hex')!==helper.sha256)throw fail('UNKNOWN','helper hash mismatch');
  const canonical=checked.canonical;
  if(inspectPauseRequest(canonical).state!=='ALLOW')throw fail('PAUSED','no new native helper after a pause request');
  const gate='Local\\VPR-S8-'+createHash('sha256').update(canonical.toLowerCase()).digest('hex').slice(0,32);
  const leasePath=join(canonical,'.fence-inflight');
  try{lstatSync(leasePath);throw fail('UNKNOWN','unresolved native admission requires owner reconciliation');}catch(e){if(e.code!=='ENOENT')throw e;}
  const native=new NativeGate(helper.path,gate,leasePath);
  try{await native.take('gate-ready');}catch(e){await native.close();throw e;}
  const context=Object.freeze({close:()=>{if(!s.closePromise){s.closed=true;s.closePromise=serial(s,async()=>{for(const run of s.owned)await run.close();await native.close();});}return s.closePromise;}});
  const s={runtime:canonical,runtimeId,authorityEpoch,generation,rootIdentity:identity(lstatSync(canonical)),native,helper:Object.freeze({...helper}),owned:new Set(),runIds:new Set(),pending:false,poisoned:false,tail:Promise.resolve(),closed:false};
  contexts.set(context,s);return context;
}
function serial(s,fn){const p=s.tail.then(fn);s.tail=p.catch(()=>{});return p;}
export function fenceRuntime(context){const s=state(context);root(s);return s.runtime;}
export function checkFence(context,{expectedEpoch,expectedGeneration}={}) {
  const s=state(context);
  if((expectedEpoch!==undefined&&expectedEpoch!==s.authorityEpoch)||(expectedGeneration!==undefined&&expectedGeneration!==s.generation))return {state:'STALE'};
  if(s.closed||s.poisoned||!s.native.alive())return {state:'UNKNOWN',reason:'native capability unavailable'};
  try{
    root(s); let raw;
    try{raw=plainFile(join(s.runtime,'STOP'),4096);}catch(e){if(e.code==='ENOENT')return {state:s.pending?'PAUSED':'ALLOW'};throw e;}
    let doc;try{doc=JSON.parse(raw);}catch{return {state:raw.trim()?'PAUSED':'UNKNOWN',reason:'legacy or invalid STOP'};}
    if(!doc||typeof doc!=='object'||Array.isArray(doc)||doc.schema!=='vf-pause/1'||doc.runtimeId!==s.runtimeId||doc.authorityEpoch!==s.authorityEpoch||typeof doc.generation!=='string'||!counter.test(doc.generation)||BigInt(doc.generation)<BigInt(s.generation)||typeof doc.requestId!=='string'||!id.test(doc.requestId)||doc.reasonCode!=='OWNER_PAUSE')return {state:'UNKNOWN',reason:'control binding mismatch'};
    const allowed=['schema','runtimeId','authorityEpoch','generation','requestId','requestedBy','requestedAt','reasonCode'];
    if(Object.keys(doc).some(k=>!allowed.includes(k))||doc.requestedBy!=='attended-controller'||!Number.isFinite(Date.parse(doc.requestedAt)))return {state:'UNKNOWN',reason:'invalid pause record'};
    return {state:'PAUSED',generation:doc.generation};
  }catch{return {state:'UNKNOWN',reason:'control inspection failed'};}
}
async function gated(s,fn){
  if(s.poisoned||!s.native.alive())throw fail('UNKNOWN','native capability unavailable');
  try{await s.native.acquire();}catch(e){s.poisoned=true;throw e;}
  try{root(s);return await fn();}
  finally{try{await s.native.release();}catch(e){s.poisoned=true;throw e;}}
}
export function withFencedEffect(context,fn,expected={}) {
  const s=state(context);
  return serial(s,()=>gated(s,async()=>{
    const check=checkFence(context,expected);if(check.state!=='ALLOW')throw fail(check.state,check.reason||'ordinary effect refused');
    return await fn(); // one admitted unit drains before publication; never release on a timer
  }));
}
export async function requestPause(context,{requestId}) {
  const s=state(context);if(typeof requestId!=='string'||!id.test(requestId))throw fail('UNKNOWN','invalid request id');
  s.pending=true;
  const publish=serial(s,()=>gated(s,()=>{
    const current=checkFence(context);
    if(current.state==='UNKNOWN'||current.state==='STALE')throw fail(current.state,'pause requires control reconciliation');
    const target=join(s.runtime,'STOP');
    if(existsSync(target)&&!current.generation)throw fail('UNKNOWN','legacy pause requires owner reconciliation');
    if(existsSync(target))return {requested:true,fenced:true,workersStopped:false,external:'unresolved',scope:'attended-coordinator-output',generation:current.generation??null};
    const generation=(BigInt(s.generation)+1n).toString();
    if(!counter.test(generation))throw fail('UNKNOWN','generation exhausted');
    const marker={schema:'vf-pause/1',runtimeId:s.runtimeId,authorityEpoch:s.authorityEpoch,generation,requestId,requestedBy:'attended-controller',requestedAt:new Date().toISOString(),reasonCode:'OWNER_PAUSE'};
    const temp=join(s.runtime,'.pause-'+randomBytes(16).toString('hex')+'.tmp');
    const fd=openSync(temp,'wx');
    try{writeFileSync(fd,JSON.stringify(marker));fsyncSync(fd);}finally{closeSync(fd);}
    // A failed publication retains its owned temp for explicit reconciliation.
    root(s);if(existsSync(target))throw fail('UNKNOWN','STOP changed during publication');
    renameSync(temp,target);
    return {requested:true,fenced:true,workersStopped:false,external:'unresolved',scope:'attended-coordinator-output',generation};
  }));
  let timer;
  try{return await Promise.race([publish,new Promise(resolveTimeout=>{timer=setTimeout(()=>resolveTimeout({requested:true,fenced:false,workersStopped:false,external:'unresolved',reason:'admitted unit or native gate has not drained'}),5000);})]);}
  finally{clearTimeout(timer);}
}
// Exact portfolio lock ownership, retained as a private capability. No stale-lock
// takeover and no creation of an unowned cleanup guard after pause.
export function takeFencedPortfolioLock(context) {
  const s=state(context);
  return withFencedEffect(context,()=>{
    const path=join(s.runtime,'_portfolio.run.lock');if(existsSync(path+'.guard'))throw fail('UNKNOWN','legacy lock mutation guard held');
    const token=randomBytes(16).toString('hex'),fd=openSync(path,'wx');let stat;
    try{writeFileSync(fd,JSON.stringify({pid:process.pid,startedMs:null,token,scope:'attended-output'}));stat=fstatSync(fd);}finally{closeSync(fd);}
    const cap=Object.freeze({});locks.set(cap,{context,path,token,identity:identity(stat)});return cap;
  });
}
export function releaseFencedPortfolioLock(context,cap) {
  const s=state(context),owned=locks.get(cap);if(!owned||owned.context!==context)throw fail('UNKNOWN','unowned cleanup capability');
  return serial(s,()=>gated(s,()=>{
    if(existsSync(owned.path+'.guard'))return {released:false,reason:'foreign guard retained'};
    const current=lstatSync(owned.path);
    if(identity(current)!==owned.identity||JSON.parse(plainFile(owned.path,4096)).token!==owned.token)return {released:false,reason:'successor retained'};
    unlinkSync(owned.path);locks.delete(cap);return {released:true};
  }));
}

// Attended fixture-only adapter: fixed Node executable, pinned script within an
// owner-created fixture tree containing this runtime. Not a configured worker
// executor, CLI command, authorization grant, install or enrollment path.
function withinFixture(base,path){const rel=relative(base,path);return rel!== '..'&&!rel.startsWith('..\\')&&!rel.startsWith('../')&&!isAbsolute(rel);}
function fixtureSpec(s,spec){
  if(!spec||typeof spec.runId!=='string'||!id.test(spec.runId)||!Array.isArray(spec.args)||spec.args.length>8||spec.args.some(a=>typeof a!=='string'||a.length>512))throw fail('REFUSED','bounded fixture specification required');
  const parent=inspectRoot(spec.fixtureRoot),cwd=inspectRoot(spec.cwd);
  if(parent.reason||cwd.reason||!withinFixture(parent.canonical,s.runtime)||!withinFixture(parent.canonical,cwd.canonical))throw fail('REFUSED','fixture runtime and cwd must share owned tree');
  if(typeof spec.script!=='string'||!spec.script.endsWith('.mjs')||!withinFixture(parent.canonical,resolve(spec.script))||inspectRoot(dirname(resolve(spec.script))).reason)throw fail('REFUSED','fixture script path');
  const st=lstatSync(spec.script);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>1024*1024||typeof spec.scriptSha256!=='string'||!/^[a-f0-9]{64}$/.test(spec.scriptSha256))throw fail('REFUSED','pinned fixture script required');
  if(createHash('sha256').update(readFileSync(spec.script)).digest('hex')!==spec.scriptSha256)throw fail('REFUSED','fixture script changed');
  const helperStat=lstatSync(s.helper.path);
  if(!helperStat.isFile()||helperStat.isSymbolicLink()||helperStat.nlink!==1||createHash('sha256').update(readFileSync(s.helper.path)).digest('hex')!==s.helper.sha256)throw fail('REFUSED','native helper changed');
  return {version:1,op:'run',gate:'Local\\VPR-S8-'+randomBytes(16).toString('hex'),executable:process.execPath,args:[resolve(spec.script),...spec.args],cwd:cwd.canonical,assignFailure:false};
}
export async function startOwnedFixture(context,spec){
  const s=state(context);
  return withFencedEffect(context,async()=>{
    if(s.runIds.has(spec?.runId))throw fail('REFUSED','fixture run already used');
    const request=fixtureSpec(s,spec);
    if(Buffer.byteLength(JSON.stringify(request))>7000)throw fail('REFUSED','fixture request too large');
    s.runIds.add(spec.runId); // uncertain failed admission never silently reuses the run
    const channel=new NativeChannel(s.helper.path,request);s.owned.add(channel);
    try{
      const ready=await channel.take('ready');
      if(ready.jobHandleInheritable!==false||!Number.isSafeInteger(ready.root?.pid)||ready.root.pid<=0||typeof ready.root?.startedTicks!=='string'||!/^[0-9]+$/.test(ready.root.startedTicks))throw fail('UNKNOWN','native root receipt unavailable');
      const cap=Object.freeze({runId:spec.runId,root:Object.freeze({...ready.root}),scope:'attended-owned-fixture'});
      ownedRuns.set(cap,{context,channel,runId:spec.runId,root:cap.root,tail:Promise.resolve(),stopPromise:null});return cap;
    }catch(e){await channel.close();throw e;}
  });
}
function owned(context,cap){state(context);const run=ownedRuns.get(cap);if(!run||run.context!==context)throw fail('REFUSED','unowned native stop capability');return run;}
export async function inspectOwnedFixture(context,cap){
  const run=owned(context,cap);if(run.stopPromise)throw fail('UNKNOWN','stop already requested');
  return serial(run,async()=>{run.channel.send({op:'status'});return run.channel.take('status');});
}
function stopAudit(s,run,phase,receipt){
  // Fixed C-AUDIT only: bounded immutable controller receipt, no generic callback,
  // directory creation, project prose, command text or overwrite of prior bytes.
  try{
    root(s);const path=join(s.runtime,`.control-stop-${run.runId}-${phase}.json`);
    const bytes=JSON.stringify({schema:'owned-stop-audit/1',runId:run.runId,root:run.root,phase,...receipt});
    if(Buffer.byteLength(bytes)>4096)return false;
    const fd=openSync(path,'wx');try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}return true;
  }catch{return false;}
}
export async function stopOwnedFixture(context,cap){
  const run=owned(context,cap),s=state(context);
  if(run.stopPromise)return run.stopPromise;
  // Separately preauthorized emergency C-SAFETY uses only the already-held Job
  // capability. Gate/STOP/ledger/audit failure must not prevent this request.
  run.stopPromise=serial(run,async()=>{
    let localState='unknown',proof=null;
    run.channel.send({op:'stop'}); // native stop dispatched before any fallible audit I/O
    const intent=stopAudit(s,run,'intent',{reasonCode:'OWNER_OWNED_FIXTURE_STOP',emergency:true});
    try{const result=await run.channel.take('stopped');if(result.activeProcesses===0){localState='stopped';proof={kind:'native-job-active-zero',runId:run.runId};}}catch{/* no PID/name fallback or inferred death */}
    const audit=stopAudit(s,run,'result',{localState,proof});
    return {runId:run.runId,localState,proof,emergency:true,audit:intent&&audit?'recorded':'degraded',capacity:localState==='stopped'?'local-zero-proven':'held-unknown',taskOwnership:'held',financial:'held',external:'unresolved'};
  });
  return run.stopPromise;
}
export async function pauseAndStopOwnedFixture(context,cap,{requestId}){
  owned(context,cap); // no pause mutation for an unowned target
  const pause=requestPause(context,{requestId}).catch(()=>({requested:true,fenced:false,workersStopped:false,reason:'fence unresolved'}));
  const stop=await stopOwnedFixture(context,cap);
  return {pause:await pause,stop};
}
