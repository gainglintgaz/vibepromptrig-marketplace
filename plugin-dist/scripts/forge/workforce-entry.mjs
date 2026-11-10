#!/usr/bin/env node
// Runnable host entry for the bounded Claude-cloud builder / Codex reviewer loop.
// Generalises the attended trial host (attest/observe/checks over openCloudLoop)
// and drives openAutomaticCloudCoordinator for a finite, explicitly bounded run.
// No schedule, service, installation, credential-file read or provider fallback.
// Authority is this executable code plus the per-invocation --consent flag; no
// JSON field (registration, receipt, environment) grants permission.
// Stopping is local only: it never requests or confirms remote cancellation.
import * as fs from 'node:fs';
import {join,resolve,relative,isAbsolute,sep,dirname,parse} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync,execFile} from 'node:child_process';
import {openCloudLoop} from './attended-cloud-loop.mjs';
import {openAutomaticCloudCoordinator} from './automatic-cloud-coordinator.mjs';
import {resolveAgentCommand} from './dispatch-lib.mjs';
import {inspectRoot} from '../completion/safe-inspection.mjs';

export const CONSENT='bounded-provider-use';
export const LOOP_LIFETIME_MS=25*60000;
// Each sign-in status command may take this long. A busy Windows PC took 71-145 s to
// answer `claude auth status`; a command still running at the limit counts as not signed in.
export const SIGN_IN_STATUS_TIMEOUT_MS=5*60000;
const BUILDERS=['claude-cloud'],REVIEWERS=['codex'];
// openAutomaticCloudCoordinator hardcodes this scope limit; no constant is exported.
const MAX_REGISTERED_PROJECTS=16;
const RESULT_FORMAT='\nUse only supplied source and acceptance; cloud checkout is unrelated. No tools, commands, network, installation or subagents. Return exact JSON {sessionId,requestId,inputSha,files:[{path,content}]} using the outer request bindings, no markdown. Stop after one response.';
const fail=code=>{throw Object.assign(Error(code),{code});};
const hash=x=>createHash('sha256').update(x).digest('hex');
// Same Windows device-name exclusion as attended-native.mjs and mandate.mjs.
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(x)&&!/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(x);
const nested=(a,b)=>{const r=relative(a,b);return !r||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep));};
const overlaps=(a,b)=>nested(a,b)||nested(b,a);
const keyOf=r=>r.tenantId+'.'+r.projectId;

function preconditions(){
 if(Number(process.versions.node.split('.')[0])<24)fail('NODE_24_REQUIRED');
 if(process.platform!=='win32')fail('WINDOWS_REQUIRED');
}
function requireConsent(value){if(value!==CONSENT)fail('CONSENT_REQUIRED');}
function regular(path,limit=65536){const s=fs.lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.size>limit)fail('UNSAFE_FILE');return fs.readFileSync(path,'utf8');}
function writeOnce(path,value){fs.writeFileSync(path,typeof value==='string'?value:JSON.stringify(value,null,2),{flag:'wx'});}
function realDir(path,code){try{const p=fs.realpathSync.native(resolve(path));if(!fs.statSync(p).isDirectory())fail(code);return p;}catch(e){if(e.code===code)throw e;fail(code);}}
function safeStateRoot(path){
 const full=resolve(path);
 // Reject network/device volumes before even probing their filesystem.
 if(inspectRoot(parse(full).root).reason)fail('UNSAFE_STATE_PATH');
 let ancestor=full;
 for(;;){
  try{fs.lstatSync(ancestor);break;}catch(e){
   if(e.code!=='ENOENT'||dirname(ancestor)===ancestor)fail('UNSAFE_STATE_PATH');
   ancestor=dirname(ancestor);
  }
 }
 // inspectRoot requires an existing directory and refuses every linked ancestor.
 const inspected=inspectRoot(ancestor);if(inspected.reason)fail('UNSAFE_STATE_PATH');
 return ancestor===full?inspected.canonical:full;
}

// Sign-in is checked through each CLI's own status command; this module never
// opens a credential store. A missing or signed-out CLI is refused, not replaced.
export function signedIn(kind,run,resolve=resolveAgentCommand){
 let command;try{command=resolve(kind==='codex'?'codex':'claude-code');}catch{fail('PROVIDER_COMMAND_UNAVAILABLE');}
 const args=kind==='codex'?['login','status']:['auth','status'];
 const r=run(command[0],[...command.slice(1),...args],{encoding:'utf8',windowsHide:true,timeout:SIGN_IN_STATUS_TIMEOUT_MS});
 const out=(r.stdout||'')+(r.stderr||'');
 if(kind==='codex')return r.status===0&&/logged in/i.test(out)&&!/not logged in/i.test(out);
 try{return r.status===0&&JSON.parse(r.stdout||'{}').loggedIn===true;}catch{return false;}
}
function preflight(deps){
 // SIMULATED only: onPreflight stands in for slow sign-in checks in tests. The CLI never passes deps.
 if(deps.simulated){deps.onPreflight?.();return;}
 for(const kind of ['claude','codex'])if(!signedIn(kind,spawnSync))fail('PROVIDER_NOT_SIGNED_IN');
}
function loopDependencies(deps){
 if(!deps.simulated)return {};
 return Object.fromEntries(Object.entries({simulated:true,cloud:deps.cloud,native:deps.native}).filter(([,v])=>v!==undefined));
}

function readProject(dir){
 const brief=regular(join(dir,'brief.md'),4096),acceptance=regular(join(dir,'acceptance.md'),4096);
 const names=fs.readdirSync(join(dir,'src'),{withFileTypes:true});
 if(names.length<1||names.length>3||names.some(n=>!n.isFile()||!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(n.name)))fail('PROJECT_LAYOUT');
 const initialFiles=Object.fromEntries(names.map(n=>['src/'+n.name,regular(join(dir,'src',n.name),4096)]));
 const checks=fs.readdirSync(join(dir,'checks'),{withFileTypes:true}).filter(n=>n.name.endsWith('.test.mjs'));
 if(checks.length<1||checks.length>5||checks.some(n=>!n.isFile()))fail('PROJECT_CHECKS_REQUIRED');
 return {spec:{initialFiles,scopePaths:Object.keys(initialFiles).sort(),brief:brief+RESULT_FORMAT,acceptance},checks:checks.map(n=>({name:n.name,source:regular(join(dir,'checks',n.name))}))};
}
function registrations(state){
 const dir=join(state,'registrations');if(!fs.existsSync(dir))return [];
 return fs.readdirSync(dir).filter(n=>n.endsWith('.json')).sort().map(n=>{
  const r=JSON.parse(regular(join(dir,n)));
  if(r.version!=='workforce-entry/1'||!id(r.tenantId)||!id(r.projectId)||n!==keyOf(r)+'.json')fail('REGISTRATION_CHANGED');
  return r;
 });
}

// Trusted host callbacks, generalised from the attended Claude-Codex trial host.
export function createHost(reg,state,{simulated=false}={}){
 const expectedMode=simulated?'SIMULATED':'attended',eventMode=simulated?'simulated':'native',observedMode=simulated?'simulated':'host-observed';
 const notes={observer:null};
 const inbox=join(state,'observations',keyOf(reg)),checkRoot=join(state,'checks',keyOf(reg));
 function attest(message,context){
  if(context.coordinatorMode!==expectedMode)fail('HOST_MODE');
  if(message.projectId!=='s7_fixture'||JSON.stringify([...message.scopePaths].sort())!==JSON.stringify(reg.scopePaths))fail('HOST_SCOPE');
  const expected=reg.bindings[message.sender?.role];
  if(!expected||message.sender.sessionId!==expected.sessionId)fail('HOST_ACTOR');
  const event=context.event;
  if(message.kind==='start'){
   if(message.phase==='build'&&(event?.kind!=='cloud-submit-intent'||event.sessionId!==reg.sessionId||event.inputSha!==message.inputCommitSha||event.modelAcknowledged!==false||event.mode!==eventMode))fail('HOST_BUILD_START');
   if(message.phase==='review'&&(event?.kind!=='host-invocation-started'||event.provider!=='codex'||event.mode!==eventMode||event.modelAcknowledged!==false))fail('HOST_REVIEW_START');
  }
  let stop=false,releaseRef;
  if(message.kind==='builder-result'){
   if(event?.kind!=='cloud-final-idle'||event.candidateCommitSha!==message.candidateCommitSha)fail('HOST_BUILD_STOP');
   const observed=JSON.parse(regular(join(context.root,'cloud-loop','cloud',event.requestId,'observed.json'),262144));
   if(observed.mode!==observedMode||observed.resultHash!==event.resultHash||observed.observation.sessionId!==reg.sessionId||!observed.observation.idle||!observed.observation.final)fail('HOST_BUILD_EVIDENCE');
   stop=true;releaseRef=event.evidenceRef;
  }
  if(message.kind==='verdict'){
   if(event?.kind!=='native-review-completed'||!event.ok||!event.completionObserved||event.evidence.mode!==eventMode||event.stop!=='invocation-complete'||event.candidateCommitSha!==message.candidateCommitSha)fail('HOST_REVIEW_STOP');
   stop=true;releaseRef=event.evidence.invocationId;
  }
  return {provenance:'owner_attested',actor:message.sender,envelopeHash:message.envelopeHash,evidenceRef:event?.requestId||event?.invocationId||event?.evidence?.invocationId||'workforce-entry-'+reg.tenantId+'-'+reg.projectId,authorityRef:'fixture-owner',grant:context.grant,limits:context.limits,...(stop?{stopConfirmed:true,releaseRef}:{})};
 }
 // Observation route: a receipt saved by the operator (or the operator's own
 // browser automation) after seeing the cloud session final and Idle. Only the
 // seven observation fields are read; any other receipt field is ignored.
 function observe(pointer){
  const file=join(inbox,pointer.requestId+'.json');
  if(!fs.existsSync(file)){notes.observer='RECEIPT_MISSING';fail('PROVIDER_UNAVAILABLE');}
  let r;try{r=JSON.parse(regular(file).replace(/^\uFEFF/,''));}catch{notes.observer='RECEIPT_UNREADABLE';fail('PROVIDER_UNAVAILABLE');}
  const at=Date.parse(r?.observedAt);
  if(!Number.isFinite(at)||Date.now()-at>55000){notes.observer='RECEIPT_STALE';fail('PROVIDER_UNAVAILABLE');}
  notes.observer='RECEIPT_READ';
  return {sessionId:r.sessionId,requestId:r.requestId,inputSha:r.inputSha,files:r.files,final:r.final,idle:r.idle,observedAt:r.observedAt,evidenceRef:'receipt-'+pointer.requestId};
 }
 // Checks are the operator's own tests, frozen at create time, run against the
 // candidate under Node's permission model (read-only files, no child processes).
 async function checks({worktree,candidateCommitSha,generation,signal}){
  const frozen=join(state,'projects',keyOf(reg),'checks');
  const evidenceRef='checks-'+generation+'-'+candidateCommitSha.slice(0,12),dir=join(checkRoot,evidenceRef);
  fs.mkdirSync(checkRoot,{recursive:true});fs.mkdirSync(dir);
  const srcUrl=pathToFileURL(join(worktree,'src')).href+'/',results=[];
  for(const check of reg.checks){
   const source=regular(join(frozen,check.name));if(hash(source)!==check.sha256)fail('CHECKS_CHANGED');
   const path=join(dir,check.name);writeOnce(path,source.replace(/(['"])\.\.\/src\//g,'$1'+srcUrl));
   const r=await new Promise(done=>execFile(process.execPath,['--permission','--allow-fs-read='+worktree,'--allow-fs-read='+dir,path],{cwd:dir,encoding:'utf8',windowsHide:true,timeout:25000,maxBuffer:65536,signal},(error,stdout,stderr)=>done({status:error?(Number.isInteger(error.code)?error.code:1):0,error:error&&!Number.isInteger(error.code)?String(error.code||error.name):null,stdout,stderr})));
   results.push({name:check.name,...r});
  }
  const passed=results.every(r=>r.status===0&&!r.error);
  writeOnce(join(checkRoot,evidenceRef+'.json'),{candidateCommitSha,generation,passed,results,limitations:['Node permission model: read-only files, no child processes; not a network sandbox']});
  const summary=results.map(r=>r.name+': '+(r.status===0&&!r.error?'pass':'FAIL')).join('\n')+'\n'+results.map(r=>(r.stdout||'')+(r.stderr||'')).join('\n').slice(-1500);
  return {candidateCommitSha,passed,evidenceRef,summary:summary.replace(/\0/g,'')};
 }
 return {host:{attest,observe,checks},notes};
}

export async function createProject(options,deps={}){
 preconditions();requireConsent(options.consent);
 if(!BUILDERS.includes(options.builder)||!REVIEWERS.includes(options.reviewer))fail('PROVIDER_UNSUPPORTED');
 if(!/^session_[A-Za-z0-9]{1,100}$/.test(options.builderSession||''))fail('SESSION_UNBOUND');
 if(!id(options.tenant)||!id(options.projectId))fail('PROJECT_BINDING');
 if(!options.state||!options.project)fail('PATH_REQUIRED');
 const project=realDir(options.project,'PROJECT_NOT_FOUND');
 if(overlaps(project,resolve(options.state)))fail('PROJECT_OVERLAP');
 let state=safeStateRoot(options.state);
 if(overlaps(project,state))fail('PROJECT_OVERLAP');
 const regs=registrations(state),key=keyOf({tenantId:options.tenant,projectId:options.projectId}).toLowerCase();
 if(regs.length>=MAX_REGISTERED_PROJECTS)fail('COORDINATOR_SCOPE');
 for(const r of regs)if(overlaps(project,r.projectDir)||keyOf(r).toLowerCase()===key||r.sessionId===options.builderSession)fail('PROJECT_OVERLAP');
 fs.mkdirSync(state,{recursive:true});
 const created=inspectRoot(resolve(options.state));if(created.reason)fail('UNSAFE_STATE_PATH');state=created.canonical;
 if(overlaps(project,state))fail('PROJECT_OVERLAP');
 let spec,checks;
 try{({spec,checks}=readProject(project));}catch(e){fail(['PROJECT_LAYOUT','PROJECT_CHECKS_REQUIRED'].includes(e.code)?e.code:'PROJECT_LAYOUT');}
 preflight(deps);
 const slot=role=>({agent:role==='builder'?'claude':'codex',provider:role==='builder'?'claude-cloud':'codex',accountContextId:'operator-attended',role,sessionId:role==='builder'?options.builderSession:randomUUID(),bindingGeneration:'1'});
 const bindings=Object.fromEntries(['manager','builder','reviewer','observer'].map(role=>[role,slot(role)]));
 const createdAt=Date.now();
 const reg={version:'workforce-entry/1',tenantId:options.tenant,projectId:options.projectId,projectDir:project,root:null,sessionId:options.builderSession,builder:options.builder,reviewer:options.reviewer,bindings,scopePaths:spec.scopePaths,checks:checks.map(c=>({name:c.name,sha256:hash(c.source)})),createdAt:new Date(createdAt).toISOString(),expiresBy:new Date(createdAt+LOOP_LIFETIME_MS).toISOString(),mode:deps.simulated?'SIMULATED':'attended'};
 const {host}=createHost(reg,state,deps);
 const loop=await openCloudLoop({sessionId:reg.sessionId,bindings,fixtureSpec:spec,activeMinutes:4,projectBinding:{tenantId:reg.tenantId,projectId:reg.projectId}},host,loopDependencies(deps));
 let status;try{status=loop.status();}finally{await loop.close();}
 reg.root=status.root;
 const frozen=join(state,'projects',keyOf(reg),'checks');fs.mkdirSync(frozen,{recursive:true});
 for(const c of checks)writeOnce(join(frozen,c.name),c.source);
 fs.mkdirSync(join(state,'observations',keyOf(reg)),{recursive:true});fs.mkdirSync(join(state,'registrations'),{recursive:true});
 writeOnce(join(state,'registrations',keyOf(reg)+'.json'),reg);
 return {ok:true,command:'create',tenantId:reg.tenantId,projectId:reg.projectId,root:reg.root,worktree:status.worktree,phase:status.phase,expiresBy:reg.expiresBy,observationInbox:join(state,'observations',keyOf(reg)),financial:'held'};
}

function projectReport(p,reg,notes){
 const s=p.status||{};const last=s.history?.at?.(-1)||null;
 return {tenantId:p.tenantId,projectId:p.projectId,root:p.root,phase:s.phase,code:s.code||null,error:p.error||null,generation:s.generation??null,requestId:s.requestId??null,inputSha:s.inputSha??null,candidateCommitSha:s.candidateCommitSha??null,verdict:s.verdict??last?.verdict??null,checks:last?.checks??null,history:s.history||[],observationInbox:reg?join('observations',keyOf(reg)):null,observer:notes?.observer||null,expiresBy:reg?.expiresBy||null,financial:'held'};
}

export async function runProjects(options,deps={}){
 preconditions();requireConsent(options.consent);
 const maxActions=Number(options.maxActions),maxPasses=Number(options.maxPasses),intervalMs=Number(options.intervalMs??5000),expiresAt=Date.parse(options.expiresAt);
 if(options.maxActions===undefined||options.maxPasses===undefined||options.expiresAt===undefined)fail('LIMITS_REQUIRED');
 if(![maxActions,maxPasses,intervalMs].every(Number.isInteger)||maxActions<1||maxActions>64||maxPasses<1||maxPasses>64||intervalMs<10||intervalMs>30000)fail('LIMITS_INVALID');
 if(!Number.isFinite(expiresAt)||expiresAt<=Date.now()||expiresAt>Date.now()+LOOP_LIFETIME_MS)fail('EXPIRY_INVALID');
 if(!options.state)fail('PATH_REQUIRED');
 const state=realDir(safeStateRoot(options.state),'STATE_NOT_FOUND'),regs=registrations(state);
 if(!regs.length)fail('NO_REGISTERED_PROJECTS');
 preflight(deps);
 const hosts=new Map(regs.map(r=>[keyOf(r),createHost(r,state,deps)]));
 const projects=regs.map(r=>({tenantId:r.tenantId,projectId:r.projectId,root:r.root,sessionId:r.sessionId,host:hosts.get(keyOf(r)).host}));
 const coordinator=await openAutomaticCloudCoordinator({projects,maxActions},deps.simulated?{simulated:true,openLoop:(o,h)=>openCloudLoop(o,h,loopDependencies(deps))}:{});
 const controller=new AbortController();let stoppedBy=null;
 const stop=reason=>{if(!controller.signal.aborted){stoppedBy=reason;controller.abort();}};
 const onExternal=()=>stop('operator');
 if(options.signal){if(options.signal.aborted)stop('operator');else options.signal.addEventListener('abort',onExternal,{once:true});}
 // Re-check after the sign-in checks and coordinator setup: a deadline that passed meanwhile
 // stops synchronously, so the first pass never starts after --expires-at. Later passes rely
 // on the timer below, which the coordinator checks between passes.
 const remaining=expiresAt-Date.now();if(remaining<=0)stop('expiry');
 const timer=setTimeout(()=>stop('expiry'),Math.max(0,remaining));
 const startedAt=new Date().toISOString();let result;
 try{result=await coordinator.run({intervalMs,maxPasses,signal:controller.signal});}
 finally{clearTimeout(timer);options.signal?.removeEventListener('abort',onExternal);await coordinator.close();}
 const last=result.passes.at(-1);
 const report={ok:true,command:'run',mode:deps.simulated?'SIMULATED':'attended',state:result.state,startedAt,finishedAt:new Date().toISOString(),limits:{maxActions,maxPasses,intervalMs,expiresAt:new Date(expiresAt).toISOString()},passes:result.passes.length,actions:result.passes.reduce((n,p)=>n+p.actions.length,0),eventSource:result.eventSource,
  stop:result.state==='stopped'?{by:stoppedBy,localProcess:'stopped between passes',remoteCancellation:'not requested',remoteCancellationConfirmed:false}:null,
  projects:(last?.projects||[]).map(p=>{const reg=regs.find(r=>r.tenantId===p.tenantId&&r.projectId===p.projectId);return projectReport(p,reg,hosts.get(keyOf(p))?.notes);}),
  financial:'held'};
 fs.mkdirSync(join(state,'runs'),{recursive:true});
 writeOnce(join(state,'runs','run-'+startedAt.replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8)+'.json'),report);
 return report;
}

// Read-only status: reopens each loop to read its checkpoint, never acts.
export async function projectStatus(options,deps={}){
 preconditions();
 if(!options.state)fail('PATH_REQUIRED');
 const state=realDir(safeStateRoot(options.state),'STATE_NOT_FOUND'),regs=registrations(state);
 if(!regs.length)fail('NO_REGISTERED_PROJECTS');
 const projects=[];
 for(const r of regs){
  let status,error=null;
  try{const loop=await openCloudLoop({root:r.root,sessionId:r.sessionId,projectBinding:{tenantId:r.tenantId,projectId:r.projectId}},createHost(r,state,deps).host,loopDependencies(deps));try{status=loop.status();}finally{await loop.close();}}
  catch(e){error=/^[A-Z][A-Z0-9_]{0,63}$/.test(e.code||'')?e.code:'PROJECT_STATUS_HELD';status={phase:'held',code:error};}
  projects.push(projectReport({tenantId:r.tenantId,projectId:r.projectId,root:r.root,status,error},r,null));
 }
 return {ok:true,command:'status',projects,financial:'held'};
}

const FLAGS={'--state':'state','--project':'project','--tenant':'tenant','--project-id':'projectId','--builder':'builder','--builder-session':'builderSession','--reviewer':'reviewer','--consent':'consent','--max-actions':'maxActions','--max-passes':'maxPasses','--interval-ms':'intervalMs','--expires-at':'expiresAt'};
export function parseArgs(argv){
 const [command,...rest]=argv,options={};
 if(!['create','run','status'].includes(command))fail('COMMAND_REQUIRED');
 for(let i=0;i<rest.length;i+=2){const key=FLAGS[rest[i]];if(!key||rest[i+1]===undefined||key in options)fail('ARGUMENT_REFUSED');options[key]=rest[i+1];}
 return {command,options};
}

export async function main(argv,{stdout=process.stdout,signal=null}={}){
 try{
  preconditions();
  const {command,options}=parseArgs(argv);
  const result=command==='create'?await createProject(options):command==='run'?await runProjects({...options,signal}):await projectStatus(options);
  stdout.write(JSON.stringify(result,null,2)+'\n');return 0;
 }catch(e){
  const code=/^[A-Z][A-Z0-9_]{0,63}$/.test(e?.code||'')?e.code:null;
  stdout.write(JSON.stringify({ok:false,refused:code||'ENTRY_FAILED'})+'\n');return code?2:1;
 }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const controller=new AbortController();
 // First Ctrl+C asks the run to stop between passes; a second one ends the process.
 for(const name of ['SIGINT','SIGBREAK'])process.once(name,()=>controller.abort());
 process.exitCode=await main(process.argv.slice(2),{signal:controller.signal});
}
