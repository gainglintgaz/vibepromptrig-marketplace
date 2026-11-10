// S7-I disposable broker. Automated evidence is SIMULATED; never real AT17 proof.
// Import createAttendedBroker/runAttended for a host-owned observer callback.
// --attended never loads node:test and never trusts stdin as attendance authority.
// Imported production module: no implicit CLI activation or test registration.
// Authorized host: import {runAttended,createAttendedBroker} from this module;
// await runAttended({root: savedRoot, observe: trustedHostObserver});
// Observe must independently match actual participant messages to m.sender,
// assignment/candidate, actualStart/actualStop and verdict. Return provenance,
// actor, envelopeHash, evidenceRef; assignment additionally authorityRef/grant/
// limits; result/verdict additionally stopConfirmed/releaseRef. Never return
// those fields merely because stdin/proposal JSON requested them. The callback
// verifies already-observed messages promptly (<=1s); it must not wait for a user.
// Admission windows are rechecked against a fresh clock after the callback.
// Commands use {command,args:[...]}; start args are [phase,{actualStart}], result
// [{candidateCommitSha,actualStop,stopRef}], verdict [{verdict,actualStop,stopRef}],
// consume [{evidenceRef}]. Order assignment,start(build),result,review,
// start(review),verdict,consume. Assignment/review return immutable ACK pointers.
// Manifest/checkpoint outside SQLite supports orderly restart; an unclean crash
// before checkpoint save fails closed. This same-user fixture is NOT isolation.
// Proposed account/provider fields require owner confirmation before real proof.
import * as fs from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import * as H from './handoff.mjs';
import * as S from './state-lib.mjs';
import * as D from './dispatch-lib.mjs';
import {createAttendedFence} from './stop.mjs';
import {inspectCandidate} from '../completion/safe-inspection.mjs';
import {inspectRoot} from './portfolio-policy.mjs';
import {relayProjection,renderDigest} from '../coordinator.mjs';
const digest=b=>createHash('sha256').update(b).digest('hex');
const stamp=t=>new Date(t).toISOString();
export const proposedBindings=Object.fromEntries(['manager','builder','reviewer','observer'].map(role=>[role,{agent:role==='builder'?'codex':role==='reviewer'?'claude':role,provider:'codex',accountContextId:'inert-disposable-fixture',role,sessionId:randomUUID(),bindingGeneration:'1'}]));
function plain(path){const s=fs.lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>1024*1024)throw Error('UNSAFE_FIXTURE_FILE');return fs.readFileSync(path,'utf8');}
function git(root,args){const nil=process.platform==='win32'?'NUL':'/dev/null',env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^GIT_/i.test(k)));Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:nil,GIT_TERMINAL_PROMPT:'0'});const r=spawnSync('git',['-c','core.hooksPath='+nil,'-c','core.fsmonitor=false','-c','core.autocrlf=false','-c','user.name=S7 Fixture','-c','user.email=s7@example.invalid',...args],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:10000});if(r.status!==0)throw Error('FIXTURE_GIT_FAILED');return r.stdout.trim();}
function compile(root){const binary=join(root,'owned-job.exe'),compiler=join(process.env.WINDIR||'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');const r=spawnSync(compiler,['/nologo','/target:exe','/optimize+','/r:System.Web.Extensions.dll','/out:'+binary,fileURLToPath(new URL('./owned-job.cs',import.meta.url))],{encoding:'utf8',windowsHide:true,timeout:30000});if(r.status!==0)throw Error('FIXTURE_HELPER_COMPILE');return {path:binary,sha256:digest(fs.readFileSync(binary))};}

const defaultFixture={initialFiles:{'src/a.txt':'before\n'},scopePaths:['src/**'],brief:'Change only src/a.txt from before to after; direct single-parent local commit.',acceptance:'AC1: src/a.txt equals after newline; no other paths; source review only.'};
// Custom fixtures are at most three exact source files, never executable hooks,
// globs, environment files, drive paths, aliases or Windows device names.
export function validateFixtureSpec(value){
 const fail=()=>{throw Error('FIXTURE_SPEC');};
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='acceptance,brief,initialFiles,scopePaths')fail();
 const {initialFiles,scopePaths,brief,acceptance}=value;
 if(!initialFiles||typeof initialFiles!=='object'||Array.isArray(initialFiles)||!Array.isArray(scopePaths)||scopePaths.length<1||scopePaths.length>3||[brief,acceptance].some(x=>typeof x!=='string'||!x.trim()||Buffer.byteLength(x)>4096||x.includes('\0')))fail();
 if(scopePaths.some(path=>typeof path!=='string'))fail();
 const paths=[...scopePaths].sort();
 if(new Set(paths.map(x=>typeof x==='string'?x.toLowerCase():x)).size!==paths.length||JSON.stringify(Object.keys(initialFiles).sort())!==JSON.stringify(paths))fail();
 let bytes=0;
 for(const path of paths){
  if(typeof path!=='string'||path.length>160||!/^src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(path)||path.split('/').some(x=>/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(x))||paths.some(other=>other!==path&&other.toLowerCase().startsWith(path.toLowerCase()+'/')))fail();
  const content=initialFiles[path];if(typeof content!=='string'||content.includes('\0')||Buffer.byteLength(content)>4096)fail();bytes+=Buffer.byteLength(content);
 }
 if(bytes>12288)fail();return {initialFiles:Object.fromEntries(paths.map(path=>[path,initialFiles[path]])),scopePaths:paths,brief,acceptance};
}

export async function createAttendedBroker({root=null,observe=null,bindings=proposedBindings,clock=null,activeMinutes=10,fixtureSpec=undefined}={}){
 if(!Number.isFinite(activeMinutes)||activeMinutes<=0||activeMinutes>10)throw Error('FIXTURE_CAP');
 if(process.platform!=='win32')throw Error('WINDOWS_NATIVE_FENCE_REQUIRED');
 const clockIdentity=randomUUID();const readClock=clock||(()=>({utc:Date.now(),monotonic:Number(process.hrtime.bigint()/1000000n),identity:clockIdentity}));
 const requestedSpec=fixtureSpec===undefined?null:validateFixtureSpec(fixtureSpec);
 // Canonical validation must finish before files, Git, helper or state setup.
 const preparedSpec=requestedSpec||structuredClone(defaultFixture),preparedSpecHash=H.canonicalHash(preparedSpec);
 let doc;
 if(root===null){
  root=fs.mkdtempSync(join(fs.realpathSync.native(tmpdir()),'vpr-s7-attended-'));
  for(const name of ['runtime','state','worktree','proposals'])fs.mkdirSync(join(root,name));
  const spec=preparedSpec;
  for(const [path,content]of Object.entries(spec.initialFiles)){const target=join(root,'worktree',path);fs.mkdirSync(dirname(target),{recursive:true});fs.writeFileSync(target,content,{flag:'wx'});}
  git(join(root,'worktree'),['init']);git(join(root,'worktree'),['add','--',...Object.keys(spec.initialFiles)]);git(join(root,'worktree'),['commit','-m','S7 disposable input']);
  const input=git(join(root,'worktree'),['rev-parse','HEAD']),now=readClock().utc,helper=compile(root);
  S.init(join(root,'state'),{project:'s7_fixture'});S.setLane(join(root,'state'),{lane:'backend',owner:bindings.builder.agent,paths:spec.scopePaths,approvedBy:'disposable fixture setup'});S.addTask(join(root,'state'),{id:'task1',title:'Disposable attended proof',owner:bindings.builder.agent,lane:'backend',paths:spec.scopePaths});
  doc={version:'s7-fixture/1',fixtureSpec:spec,fixtureSpecHash:preparedSpecHash,generation:1,activeMinutes,createdAt:stamp(now),input,bindings,helper,checkpoint:{epoch:'fixture-epoch',sequence:0,headHash:'0'.repeat(64)},messages:{},grant:{ref:'fixture-grant',epoch:'fixture-epoch',cap:30,expiresAt:now+30*60000,authorityRef:'fixture-owner'},limits:{projectCap:30,portfolioCap:30,projectSlots:1,portfolioSlots:1}};
 }else{root=resolve(root);if(inspectRoot(root).reason)throw Error('UNSAFE_FIXTURE_ROOT');doc=JSON.parse(plain(join(root,'broker.json')));if(doc.version!=='s7-fixture/1'||doc.helper.path!==join(root,'owned-job.exe'))throw Error('FIXTURE_BINDING');}
 const savedSpec=doc.fixtureSpec||structuredClone(defaultFixture);
 if(H.canonicalHash(savedSpec)!==H.canonicalHash(defaultFixture))validateFixtureSpec(savedSpec);
 if(doc.fixtureSpecHash&&doc.fixtureSpecHash!==H.canonicalHash(savedSpec)||requestedSpec&&preparedSpecHash!==H.canonicalHash(savedSpec))throw Error('FIXTURE_SPEC_CHANGED');
 doc.fixtureSpec=savedSpec;doc.fixtureSpecHash=H.canonicalHash(savedSpec);
 const stateRoot=join(root,'state'),worktree=join(root,'worktree'),runtime=join(root,'runtime'),proposals=join(root,'proposals');
 for(const p of [stateRoot,worktree,runtime,proposals])if(inspectRoot(p).reason)throw Error('UNSAFE_FIXTURE_ROOT');
 doc.generation??=1;doc.activeMinutes??=10;
 const key=(name,generation=doc.generation)=>generation===1?name:name+generation;
 const artifacts={brief:Buffer.from(savedSpec.brief),acceptance:Buffer.from(savedSpec.acceptance)},policy={mode:'attended-disposable',cap:doc.activeMinutes};
 const hash=digest(artifacts.brief),id=randomUUID(),begin=Date.parse(doc.createdAt);
 const base={schemaVersion:'relay/1',messageId:id,kind:'assignment',projectId:'s7_fixture',repository:{host:'local',owner:'fixture',name:'disposable'},stateRoot:'<FIXTURE>/state',worktree:'<FIXTURE>/worktree',sender:doc.bindings.manager,recipient:doc.bindings.builder,taskId:'task1',claimId:'build-claim',runId:null,phase:'build',inputCommitSha:doc.input,candidateCommitSha:null,scopePaths:savedSpec.scopePaths,actions:['read-evidence','record-start','report-result'],intentBinding:{canonicalizationVersion:'RFC8785/1',briefRef:'brief',briefSha256:hash,acceptanceRef:'acceptance',acceptanceSha256:digest(artifacts.acceptance),policySha256:H.canonicalHash(policy),authorityEpoch:'fixture-epoch',adapterCapabilityRef:'attended',adapterVersion:'1',environmentFingerprint:digest(Buffer.from('Windows disposable fixture'))},capWindow:{activeMinutes:doc.activeMinutes,startNotBefore:stamp(begin),startBefore:stamp(begin+25*60000),outerStopAt:stamp(begin+30*60000),grantRef:'fixture-grant',reservationRef:'fixture-reservation',leaseGeneration:'1',stopFence:'0'},createdAt:stamp(begin),expiresAt:stamp(begin+25*60000),inReplyTo:null,rootMessageId:id,supersedes:null,payload:{briefRef:'brief',briefSha256:hash,acceptanceIds:['AC1'],evidenceRefs:[],authorityRef:'fixture-owner',producerResultId:null}};
 if(!doc.messages.assignment)doc.messages.assignment=H.sealEnvelope(base);
 let closed=false,sampled=readClock(),fence=await createAttendedFence({runtime,runtimeId:'s7_fixture',authorityEpoch:'fixture-epoch',generation:'0',helper:doc.helper}),journal;
 const attended={bindings:doc.bindings,worktree,timezone:'America/New_York',clock:()=>sampled,observe:async m=>{
  if(typeof observe!=='function')throw Error('HOST_ATTENDANCE_REQUIRED');
  // Proposal/state preparation is not observer latency. Keep the command clock
  // for accounting, but measure the prompt host callback from its own boundary.
  const observationStart=readClock();
  if(observationStart.identity!==sampled.identity||observationStart.monotonic<sampled.monotonic)throw Error('ATTENDANCE_OBSERVATION_DELAY');
  const observation=await observe(m,{grant:doc.grant,limits:doc.limits,root,worktree});
  const current=readClock();
  if(current.identity!==observationStart.identity||current.monotonic<observationStart.monotonic||current.monotonic-observationStart.monotonic>1000)throw Error('ATTENDANCE_OBSERVATION_DELAY');
  if(['assignment','review-assignment','start'].includes(m.kind)&&!H.admissionWindow(m,current.utc))throw Error('ATTENDANCE_WINDOW_EXPIRED');
  return observation;
 }};
 const options=()=>({fence,stateRoot,epoch:'fixture-epoch',generation:'0',checkpoint:doc.checkpoint,registration:doc.messages.assignment,artifacts,policy,attended});
 journal=await H.openRelayJournal(options());
 function save(){doc.checkpoint=journal.checkpoint();const path=join(root,'broker.json');if(fs.existsSync(path))plain(path);const temp=join(root,'broker-'+randomUUID()+'.tmp');fs.writeFileSync(temp,JSON.stringify(doc,null,2),{flag:'wx'});fs.renameSync(temp,path);}
 function seal(kind,from,changes){const b=structuredClone(from);for(const k of ['envelopeHash','payloadHash','idempotencyKey'])delete b[k];return H.sealEnvelope({...b,kind,messageId:randomUUID(),...changes});}
 function pointer(name){const m=doc.messages[name];if(!m)throw Error('PROPOSAL_MISSING');const path=join(proposals,m.messageId+'.json'),bytes=H.canonicalize(m);if(fs.existsSync(path)){if(plain(path)!==bytes)throw Error('PROPOSAL_CHANGED');}else fs.writeFileSync(path,bytes,{flag:'wx'});return {name,path,messageId:m.messageId,envelopeHash:m.envelopeHash,unsigned:true,authority:'none; host attendance required',worktree,inputCommitSha:m.inputCommitSha,candidateCommitSha:m.candidateCommitSha};}
 async function admit(name,{fault}={}){const m=doc.messages[name];if(!m)throw Error('PROPOSAL_MISSING');try{return await journal.attend(H.canonicalize(m),{fault});}finally{save();}}
 function release(ref){if(typeof ref!=='string'||!ref)throw Error('ACTUAL_STOP_REFERENCE_REQUIRED');return {capacity:'released',task:'released',financial:'held',evidenceRef:ref};}
 const broker={root,worktree,stateRoot,runtime,bindings:doc.bindings,pointer,
  async digest(){const db=await D.openLedger(runtime);try{const state=S.readState(stateRoot),now=readClock().utc,relay=relayProjection(db,state,now),usedToday=D.usedMinutes(db,{project:state.project,day:D.dayKey(now,'America/New_York')});return {relay,text:renderDigest({state,actions:{released:[],promoted:[],packs:[],receiptMismatch:[],deadLetters:[]},running:[],usedToday,costToday:null,cfg:null,view:{lastRun:null},now,timezone:'America/New_York',stateRoot,relay})};}finally{db.close();}},
  status(){sampled=readClock();return {root,state:S.readState(stateRoot),counts:journal.counts(),clock:journal.attendedStatus(),messages:Object.keys(doc.messages),proof:'fixture observations are not authentication; real AT17 requires actual participant evidence'};},
  async assignment(){sampled=readClock();const receipt=await admit(key('assignment'));return {receipt,pointer:pointer(key('assignment'))};},
  async start(phase,{actualStart}={}){if(!['build','review'].includes(phase)||typeof actualStart!=='string')throw Error('ACTUAL_START_REQUIRED');sampled=readClock();const a=doc.messages[key(phase==='build'?'assignment':'review')];if(!a)throw Error('PREDECESSOR_REQUIRED');const name=key(phase+'Start');if(!doc.messages[name])doc.messages[name]=seal('start',a,{sender:a.recipient,recipient:a.sender,runId:'task1-'+sampled.utc,inReplyTo:a.messageId,payload:{originalId:a.messageId,originalHash:a.envelopeHash,acceptedKey:a.idempotencyKey,actualStart,taskId:'task1',claimId:a.claimId,runId:'task1-'+sampled.utc,leaseGeneration:a.capWindow.leaseGeneration,stopFence:'0',recipient:a.recipient,inputEvidence:[],claimReceipt:'attended-claim'}});save();return {receipt:await admit(name),pointer:pointer(name)};},
  async result({candidateCommitSha,actualStop,stopRef,summary='Participant-reported fixture result',checks=[],gaps=['No independent runtime checks']}={}){if(typeof actualStop!=='string')throw Error('ACTUAL_STOP_REQUIRED');sampled=readClock();const a=doc.messages[key('assignment')],s=doc.messages[key('buildStart')];if(!s)throw Error('PREDECESSOR_REQUIRED');const candidate=candidateCommitSha,proof=inspectCandidate(worktree,{input:a.inputCommitSha,candidate});if(proof.state!=='CLEAN')throw Error('CANDIDATE_INSPECTION_HELD');if(proof.changedPaths.some(path=>!savedSpec.scopePaths.some(scope=>scope==='src/**'?path.startsWith('src/'):path===scope)))throw Error('CANDIDATE_SCOPE_HELD');if(!doc.messages[key('result')])doc.messages[key('result')]=seal('builder-result',s,{candidateCommitSha:candidate,inReplyTo:s.messageId,payload:{assignmentId:a.messageId,startId:s.messageId,actualStart:s.payload.actualStart,actualStop,inputCommitSha:a.inputCommitSha,candidateCommitSha:candidate,parentCommitSha:proof.parent,changedPaths:proof.changedPaths,result:{status:'done',summary,commits:[candidate],checks,gaps},evidenceRefs:[],release:release(stopRef)}});save();return {receipt:await admit(key('result')),pointer:pointer(key('result'))};},
  async review(){sampled=readClock();const r=doc.messages[key('result')];if(!r)throw Error('PREDECESSOR_REQUIRED');if(!doc.messages[key('review')])doc.messages[key('review')]=seal('review-assignment',doc.messages[key('assignment')],{phase:'review',claimId:'review-claim-'+doc.generation,supersedes:null,inputCommitSha:r.candidateCommitSha,candidateCommitSha:r.candidateCommitSha,recipient:doc.bindings.reviewer,inReplyTo:r.messageId,payload:{...base.payload,producerResultId:r.messageId}});save();return {receipt:await admit(key('review')),pointer:pointer(key('review'))};},
  async verdict({actualStop,stopRef,verdict,checks=[],gaps=['Source-only review'],findings=[]}={}){if(typeof actualStop!=='string'||!['PASS','CHANGES_REQUESTED','BLOCKED'].includes(verdict))throw Error('ACTUAL_VERDICT_REQUIRED');sampled=readClock();const a=doc.messages[key('review')],s=doc.messages[key('reviewStart')],r=doc.messages[key('result')];if(!s)throw Error('PREDECESSOR_REQUIRED');if(!doc.messages[key('verdict')])doc.messages[key('verdict')]=seal('verdict',s,{inReplyTo:s.messageId,payload:{assignmentId:a.messageId,startId:s.messageId,resultId:r.messageId,candidateCommitSha:r.candidateCommitSha,verdict,coveredPaths:r.payload.changedPaths,acceptanceIds:['AC1'],findings,checks,gaps,evidenceRefs:[],actualStart:s.payload.actualStart,actualStop,release:release(stopRef)}});save();return {receipt:await admit(key('verdict')),pointer:pointer(key('verdict'))};},
  async consume({evidenceRef,fault}={}){if(typeof evidenceRef!=='string'||!evidenceRef)throw Error('MANAGER_EVIDENCE_REQUIRED');sampled=readClock();const v=doc.messages[key('verdict')],r=doc.messages[key('result')];if(!v)throw Error('PREDECESSOR_REQUIRED');if(!doc.messages[key('consume')]){const priorStateHash=S.bodyHash(S.readState(stateRoot)),op={id:'attended-consume-'+doc.generation,project:'s7_fixture',task:'task1',claimId:v.claimId,generation:v.capWindow.leaseGeneration,scopePaths:savedSpec.scopePaths,inputSha:r.inputCommitSha,managerBinding:H.canonicalHash(doc.bindings.manager),actorBinding:H.canonicalHash(doc.bindings.manager),agent:doc.bindings.manager.agent,worktree,runId:v.runId,kind:'consume',candidateSha:r.candidateCommitSha,verdict:v.payload.verdict,ref:evidenceRef,messageId:v.messageId,expectedStateHash:priorStateHash},newStateHash=S.bodyHash(S.applyRelayState(stateRoot,op,{now:()=>sampled.utc,preview:true}).state);doc.messages[key('consume')]=seal('consume',v,{phase:'control',sender:doc.bindings.manager,recipient:doc.bindings.observer,inReplyTo:v.messageId,capWindow:{...v.capWindow,activeMinutes:0,startNotBefore:null,startBefore:null,outerStopAt:null,grantRef:null,reservationRef:null},payload:{resultId:r.messageId,verdictId:v.messageId,verdictHash:v.envelopeHash,manager:doc.bindings.manager,bindingGeneration:doc.bindings.manager.bindingGeneration,stateOperationId:op.id,priorStateHash,newStateHash,outcome:{PASS:'reviewed',CHANGES_REQUESTED:'repair-held',BLOCKED:'blocked'}[v.payload.verdict],evidenceRef,nextDependency:null}});}save();return {receipt:await admit(key('consume'),{fault}),pointer:pointer(key('consume'))};},
  async repair({candidateCommitSha,fault}={}){
   sampled=readClock();let pending=doc.pendingRepair;
   if(!pending){
    const a=doc.messages[key('assignment')],v=doc.messages[key('verdict')],r=doc.messages[key('result')],c=doc.messages[key('consume')],state=S.readState(stateRoot),h=state.tasks.find(t=>t.id==='task1')?.handoff;
    if(doc.generation>=3||!c||v?.payload.verdict!=='CHANGES_REQUESTED'||h?.outcome!=='repair-held'||h.reviewOperationId!==c.payload.stateOperationId||S.bodyHash(state)!==c.payload.newStateHash)throw Error('REPAIR_NOT_ALLOWED');
    if(candidateCommitSha!==r.candidateCommitSha)throw Error('REPAIR_CANDIDATE');
    const generation=doc.generation+1,name=key('assignment',generation);
    doc.messages[name]=seal('assignment',a,{claimId:'build-claim-'+generation,inputCommitSha:candidateCommitSha,candidateCommitSha:null,runId:null,inReplyTo:c.messageId,supersedes:a.messageId,capWindow:{...a.capWindow,leaseGeneration:String(generation)}});
    pending=doc.pendingRepair={name,generation};save();pointer(name);
   }
   if(candidateCommitSha!==doc.messages[pending.name].inputCommitSha)throw Error('REPAIR_CANDIDATE');
   const receipt=await admit(pending.name,{fault});doc.generation=pending.generation;delete doc.pendingRepair;save();return {receipt,pointer:pointer(pending.name)};
  },
  async replay(name){sampled=readClock();return admit(name);},
  async restart(){save();journal.close();await fence.close();fence=await createAttendedFence({runtime,runtimeId:'s7_fixture',authorityEpoch:'fixture-epoch',generation:'0',helper:doc.helper});journal=await H.openRelayJournal(options());},
  async close(){if(closed)return;save();journal.close();await fence.close();closed=true;}
 };
 save();return broker;
}

// Host slot IDs below bind attended actors. Native session IDs remain separate
// receipts; executable spawn starts accounting and is never a model ACK.
export async function runNativeFixture({invoke=null,brokerFactory=createAttendedBroker,seedFirstCandidate=false}={}){
 if(typeof seedFirstCandidate!=='boolean')throw Error('FIXTURE_SEED_OPTION');
 const native=await import('./attended-native.mjs');invoke??=native.invokeAttendedNative;
 const bindings=structuredClone(proposedBindings);
 for(const role of ['builder','reviewer'])bindings[role]={...bindings[role],agent:role==='builder'?'claude':'codex',provider:role==='builder'?'claude':'codex',sessionId:randomUUID(),accountContextId:'attended-host-invocation-slot'};
 let active=null,broker;const receipts=[],materializations=[],sessions=new Set(),invocations=new Set();
 const observe=async(m,c)=>{
  if(['start','builder-result','verdict'].includes(m.kind)){
   const role=m.phase==='build'?'builder':'reviewer';
   if(!active||active.role!==role||m.sender.sessionId!==bindings[role].sessionId||m.payload.originalId!==active.assignment.messageId&&m.payload.assignmentId!==active.assignment.messageId)throw Error('HOST_EVENT_BINDING');
   if(m.kind==='start'&&!active.start||m.kind!=='start'&&!active.done)throw Error('HOST_EVENT_REQUIRED');
  }
  return {provenance:'owner_attested',actor:m.sender,envelopeHash:m.envelopeHash,evidenceRef:active?.invocationId||'host-fixture-authority',authorityRef:'fixture-owner',grant:c.grant,limits:c.limits,...(active?.done?{stopConfirmed:true,releaseRef:active.invocationId}:{})};
 };
 try{
  broker=await brokerFactory({bindings,observe,activeMinutes:5});let assignment=(await broker.assignment()).pointer;
  async function call(role,assignment,prompt){
   const invocationId=randomUUID(),provider=role==='builder'?'claude':'codex',nativeSession=provider==='claude'?randomUUID():undefined;
   active={role,assignment,invocationId,start:null,done:null};
   const result=await invoke({provider,worktree:broker.worktree,evidenceRoot:broker.root,prompt,invocationId,...(nativeSession?{sessionId:nativeSession}:{}),beforeInput:async event=>{
    if(event.kind!=='host-invocation-started'||event.provider!==provider||event.invocationId!==invocationId||event.modelAcknowledged!==false||active.start)throw Error('HOST_EVENT_BINDING');
    active.start=event;await broker.start(role==='builder'?'build':'review',{actualStart:event.hostInvocationStartedAt});
   }});
   const e=result.evidence;
   if(!result.ok||!result.completionObserved||result.stop!=='invocation-complete'||!active.start||e?.invocationId!==invocationId||!e.sessionId||nativeSession&&e.sessionId!==nativeSession||sessions.has(e.sessionId)||invocations.has(invocationId))throw Error('NATIVE_COMPLETION_HELD');
   native.validateNativePayload(provider,role==='builder'?result.proposal:result.review);sessions.add(e.sessionId);invocations.add(invocationId);active.done=result;
   const receipt={role,hostSlotId:bindings[role].sessionId,invocationId,nativeSessionId:e.sessionId,evidenceDirectory:e.directory,mode:e.mode,startSemantics:'host executable spawn before input; not model ACK',financial:'held',...(role==='reviewer'?{reviewFeedback:{summary:result.review.summary,findings:result.review.findings,detailReferences:'Identifiers only; no referenced text was resolved.'}}:{proposedSha256:digest(result.proposal.content)})};receipt.receiptPath=join(broker.root,'native-receipt-'+invocationId+'.json');fs.writeFileSync(receipt.receiptPath,JSON.stringify(receipt,null,2),{flag:'wx'});receipts.push(receipt);return result;
  }
  let feedback=null;
  for(let generation=1;generation<=3;generation++){
   const source=join(broker.worktree,'src/a.txt'),before=plain(source),head=git(broker.worktree,['rev-parse','HEAD']);
   if(head!==assignment.inputCommitSha||git(broker.worktree,['status','--porcelain']))throw Error('HOST_INPUT_CHANGED');
   const built=await call('builder',assignment,'Return only the schema proposal for src/a.txt. Acceptance: content must equal after followed by newline. Current content: '+JSON.stringify(before)+' Review feedback (summary is review text; detailRef values are unresolved identifiers): '+JSON.stringify(feedback));
   if(git(broker.worktree,['rev-parse','HEAD'])!==head||git(broker.worktree,['status','--porcelain'])||plain(source)!==before)throw Error('HOST_INPUT_CHANGED');
   const seeded=seedFirstCandidate&&generation===1,proposed=built.proposal.content;if(seeded&&proposed!=='after\n')throw Error('FIXTURE_SEED_NOT_APPLICABLE');const materialized=seeded?proposed.slice(0,-1):proposed;
   fs.writeFileSync(join(broker.root,'before-'+generation+'.txt'),before,{flag:'wx'});fs.writeFileSync(source,materialized);git(broker.worktree,['add','src/a.txt']);git(broker.worktree,['commit','-m','Attended disposable candidate '+generation]);
   const candidate=git(broker.worktree,['rev-parse','HEAD']),materialization={generation,candidate,seeded,description:seeded?'Seeded disposable fault: host removed the proposed final newline':'Host applied native proposal unchanged',proposedSha256:digest(proposed),materializedSha256:digest(materialized),nativeInvocationId:active.invocationId};fs.writeFileSync(join(broker.root,'materialization-'+generation+'.json'),JSON.stringify(materialization,null,2),{flag:'wx'});materializations.push(materialization);await broker.result({candidateCommitSha:candidate,actualStop:built.evidence.observedAt,stopRef:active.invocationId,summary:materialization.description,gaps:['Financial duration held; source fixture only']});
   const review=(await broker.review()).pointer,reviewed=await call('reviewer',review,'Review this exact disposable candidate '+candidate+'. The host verified this exact candidate and its changed paths before this invocation. Acceptance: src/a.txt equals after followed by newline; only src/a.txt changed. Do not use tools; review only the supplied source and return the review schema. Source: '+JSON.stringify(plain(source)));
   if(reviewed.review.verdict==='PASS'&&plain(source)!=='after\n')throw Error('ACCEPTANCE_MISMATCH');
   await broker.verdict({actualStop:reviewed.evidence.observedAt,stopRef:active.invocationId,...reviewed.review,gaps:['Runtime source review; not independent source-candidate approval']});await broker.consume({evidenceRef:active.invocationId});
   if(reviewed.review.verdict!=='CHANGES_REQUESTED'||generation===3)return {root:broker.root,verdict:reviewed.review.verdict,receipts,materializations,status:broker.status()};
   feedback=receipts.at(-1).reviewFeedback;assignment=(await broker.repair({candidateCommitSha:candidate})).pointer;
  }
 }finally{if(broker)await broker.close();}
}

export async function runAttended({observe=null,root=null,fixtureSpec=undefined,input=process.stdin,output=process.stdout}={}){
 const broker=await createAttendedBroker({root,observe,fixtureSpec});output.write(JSON.stringify({mode:'attended-fixture',root:broker.root,admission:observe?'host callback required per message':'disabled',pointer:broker.pointer('assignment')})+'\n');
 const lines=createInterface({input});try{for await(const line of lines){try{if(Buffer.byteLength(line)>65536)throw Error('REQUEST_LIMIT');const q=JSON.parse(line);if(!q||Object.keys(q).some(k=>!['command','args'].includes(k)))throw Error('REQUEST_SCHEMA');if(!['status','digest','assignment','start','result','review','verdict','consume','repair','replay','restart'].includes(q.command))throw Error('COMMAND_REFUSED');const result=await broker[q.command](...(q.args||[]));output.write(JSON.stringify({ok:true,result:result??null})+'\n');}catch(e){output.write(JSON.stringify({ok:false,code:/^[A-Z_]+$/.test(e.message)?e.message:'BROKER_REFUSED'})+'\n');}}}finally{await broker.close();}
}
