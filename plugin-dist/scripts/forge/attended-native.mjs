// Attended native invocations only. No CLI, enrollment, dispatcher activation or authority from JSON.
// Native read-only Codex is NOT whole-host read isolation. The host supplies only disposable source.
import * as fs from 'node:fs';
import {join,resolve,delimiter} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {resolveAgentCommand} from './dispatch-lib.mjs';
import {inspectRoot} from './portfolio-policy.mjs';
import {parseStrict,parseNativeTransport,canonicalize} from './handoff.mjs';
import {safeRelPath} from './state-lib.mjs';
import {inspectRepository} from '../completion/safe-inspection.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(x);
const fail=code=>{throw Object.assign(new Error(code),{code});};
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===[...keys].sort().join(',');
const text=x=>typeof x==='string'&&Buffer.byteLength(x)<=8192&&!/[\u0000]/.test(x);
const reviewId=x=>id(x)&&!/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(x);
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(x);
const DEFAULT_SCOPE=Object.freeze(['src/a.txt']);
const continuationToken=Symbol('host-validated-continuation');
function immutableRead(path){const s=fs.lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>262144)fail('UNSAFE_PRIOR_EVIDENCE');return fs.readFileSync(path,'utf8');}
function immutableWrite(path,value){const fd=fs.openSync(path,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
function bindScope(scopePaths=DEFAULT_SCOPE){
 // Canonicalization rejects getters, sparse arrays and non-JSON types before reads.
 const paths=parseStrict(canonicalize(scopePaths));
 if(!Array.isArray(paths)||paths.length<1||paths.length>3)fail('SCOPE_PATHS');
 for(const p of paths){
  if(typeof p!=='string'||p.length>512||!safeRelPath(p)||!/^src\/[^/]+$/.test(p)
   ||/[\x00-\x1f\x7f\\:*?\[\]{}<>"|~]/.test(p))fail('SCOPE_PATHS');
  const name=p.slice(4);
  if(name!==name.trim()||/[. ]$/.test(name)
   ||/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)|^\.env(?:\.|$)|^\.(?:aws|ssh|git|npmrc|netrc)$|^credentials(?:\.|$)|^id_(?:rsa|ed25519)$|\.(?:pem|key)$/i.test(name))fail('SCOPE_PATHS');
 }
 if(new Set(paths.map(p=>p.toLowerCase())).size!==paths.length)fail('SCOPE_PATHS');
 return Object.freeze(paths);
}
function scopedSchema(provider,scopePaths){
 const schema=structuredClone(provider==='codex'?REVIEW_SCHEMA:PROPOSAL_SCHEMA);
 const properties=provider==='codex'?schema.properties.findings.items.properties:schema.properties;
 properties.path=scopePaths.length===1?{type:'string',const:scopePaths[0]}:{type:'string',enum:[...scopePaths]};
 return freeze(schema);
}
export {immutableWrite as writeNativeEvidence, bindScope as bindNativeScope};
export const PROPOSAL_SCHEMA={type:'object',additionalProperties:false,required:['path','content'],properties:{path:{type:'string',const:'src/a.txt'},content:{type:'string',maxLength:8192}}};
export const REVIEW_SCHEMA={
 type:'object',additionalProperties:false,required:['verdict','findings','summary'],
 properties:{
  verdict:{type:'string',enum:['PASS','CHANGES_REQUESTED','BLOCKED']},
  // Bounded exact-file fixture contract. Outer transport accepts bounded serialized
  // documents; inner strings and downstream validation retain their own limits.
  summary:{type:'string',maxLength:256,pattern:'^[^\\u0000]*$',description:'Put the full review explanation and concrete repair instructions here, including explanations of every finding. Do not place explanatory prose in detailRef.'},
  findings:{type:'array',maxItems:5,items:{
   type:'object',additionalProperties:false,required:['code','priority','path','detailRef'],
   properties:{
    code:{type:'string',minLength:9,maxLength:64,pattern:'^finding_[A-Za-z0-9][A-Za-z0-9._-]{0,55}$',description:'A symbolic finding code, prefixed with finding_, such as finding_newline.'},
    priority:{type:'integer',minimum:0,maximum:3},
    path:{type:'string',const:'src/a.txt'},
    detailRef:{type:'string',minLength:9,maxLength:64,pattern:'^finding_[A-Za-z0-9][A-Za-z0-9._-]{0,55}$',description:'A symbolic identifier, prefixed with finding_, such as finding_1, not a quotation or explanation. Put all explanatory text in summary.'}
   }
  }}
 }
};

freeze(PROPOSAL_SCHEMA);freeze(REVIEW_SCHEMA);

export function validateNativePayload(provider,value,{scopePaths=DEFAULT_SCOPE}={}){
 const scope=bindScope(scopePaths);
 if(!['claude','codex','grok'].includes(provider))fail('PROVIDER_UNSUPPORTED');
 if(provider==='claude'||provider==='grok'){
  if(!exact(value,['path','content'])||!scope.includes(value.path)||!text(value.content))fail('PROPOSAL_SCHEMA');
 }else{
  if(!exact(value,['verdict','findings','summary'])||!['PASS','CHANGES_REQUESTED','BLOCKED'].includes(value.verdict)||!text(value.summary)||Buffer.byteLength(value.summary)>4096||!Array.isArray(value.findings)||value.findings.length>20||value.verdict==='PASS'&&value.findings.length)fail('REVIEW_SCHEMA');
  for(const f of value.findings)if(!exact(f,['code','priority','path','detailRef'])||!reviewId(f.code)||![0,1,2,3].includes(f.priority)||!scope.includes(f.path)||!reviewId(f.detailRef))fail('REVIEW_SCHEMA');
 }
 return value;
}
function parseOutput(provider,stdout,expectedSession,scopePaths){
 let sessionId,payload;const commandObservations=[];
 if(provider==='claude'){
  const r=parseNativeTransport(stdout);
  if(r.type!=='result'||r.subtype!=='success'||r.is_error!==false)fail('PROVIDER_FAILED');
  if(!uuid(r.session_id)||r.session_id!==expectedSession)fail('SESSION_MISMATCH');
  sessionId=r.session_id;
  payload=r.structured_output;
  if(payload===undefined&&typeof r.result==='string')payload=parseStrict(r.result);
 }else{
  let started=false,completed=false,message=null;const commands=new Map();
  for(const line of stdout.trim().split(/\r?\n/)){
   if(!line)continue;
   const r=parseNativeTransport(line);
   if(r.type==='error'||r.type==='turn.failed')fail('PROVIDER_FAILED');
   if(completed)fail('EVENT_ORDER');
   if(r.type==='thread.started'){
    if(started||!uuid(r.thread_id))fail('SESSION_MISMATCH');
    sessionId=r.thread_id;started=true;
   }else if(!started)fail('SESSION_REQUIRED');
   else if(r.type==='turn.completed'){
    if([...commands.values()].some(c=>!c.completed))fail('COMMAND_INCOMPLETE');
    completed=true;
   }else if(r.type?.startsWith('item.')){
    if(!['item.started','item.updated','item.completed'].includes(r.type))fail('UNEXPECTED_EVENT');
    const item=r.item;
    if(item?.type==='command_execution'){
     // Native read-only sandbox governs execution, not this post-execution parser.
     // Persist hashes/exit metadata only. No command or aggregated output is saved.
     if(!id(item.id)||!text(item.command)||typeof item.aggregated_output!=='string')fail('COMMAND_SCHEMA');
     const prior=commands.get(item.id),commandSha256=sha(item.command);
     if(r.type==='item.started'){
      if(prior||commands.size>=20||item.status!=='in_progress'||item.exit_code!==null)fail('COMMAND_ORDER');
      commands.set(item.id,{commandSha256,completed:false});
     }else{
      if(!prior||prior.completed||prior.commandSha256!==commandSha256)fail('COMMAND_ORDER');
      if(r.type==='item.completed'){
       if(!['completed','failed'].includes(item.status)||!Number.isSafeInteger(item.exit_code))fail('COMMAND_SCHEMA');
       prior.completed=true;
       commandObservations.push({itemId:item.id,commandSha256,outputSha256:sha(item.aggregated_output),exitCode:item.exit_code,status:item.status});
      }else if(item.status!=='in_progress'||item.exit_code!==null)fail('COMMAND_SCHEMA');
     }
    }else if(item?.type==='reasoning'){
     continue;
    }else if(item?.type==='agent_message'){
     if(r.type==='item.completed'){
      if(typeof item.text!=='string')fail('UNEXPECTED_ITEM');
      // Completed messages can include interim commentary without a phase field.
      // Only the last completed message is validated after the terminal event.
      message=item.text;
     }
    }else fail('UNEXPECTED_TOOL_USE');
   }else if(r.type!=='turn.started')fail('UNEXPECTED_EVENT');
  }
  if(!started||!completed||message===null)fail('TERMINAL_REQUIRED');
  if(expectedSession&&sessionId!==expectedSession)fail('SESSION_MISMATCH');
  payload=parseStrict(message);
 }
 return {sessionId,payload:validateNativePayload(provider,payload,{scopePaths}),commandObservations};
}
function resolveNativeCommand(kind){
 if(kind!=='grok')return resolveAgentCommand(kind);
 // Resolve only a native executable; no shell/shim, API fallback, or auth inspection.
 for(const dir of String(process.env.PATH||process.env.Path||'').split(delimiter).filter(Boolean)){
  const candidate=resolve(dir,process.platform==='win32'?'grok.exe':'grok');
  try{const stat=fs.lstatSync(candidate);if(stat.isFile()&&!stat.isSymbolicLink())return [candidate];}catch{}
 }
 fail('GROK_EXECUTABLE_UNAVAILABLE');
}
function buildArgs(provider,{worktree,sessionId,schemaFile,promptFile,schema,resume=false}){
 if(provider==='grok')return ['--cwd',worktree,'--session-id',sessionId,'--prompt-file',promptFile,'--json-schema',JSON.stringify(schema),'--output-format','json','--permission-mode','dontAsk','--no-subagents','--disable-web-search','--max-turns','1'];
 if(provider==='claude')return ['-p','--output-format','json','--max-budget-usd','0.25','--permission-mode','dontAsk','--permission-prompts','none','--safe-mode','--restricted','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-chrome','--session-id',sessionId,'--json-schema',JSON.stringify(schema)];
 const args=['exec','--ignore-user-config','--ignore-rules','-C',worktree,'-s','read-only','-c','approval_policy="never"','-c','web_search="disabled"','--disable','hooks','--disable','plugins','--disable','apps','--disable','browser_use','--disable','browser_use_external','--disable','computer_use','--disable','multi_agent','--color','never'];
 return [...args,...(resume?['resume',sessionId]:[]),'--output-schema',schemaFile,'--json','-'];
}

// One explicit continuation of a timed-out review. Old receipts and broker
// accounting are never edited or released. A fresh host callback must independently
// bind the rollout/session and inventory the prior process, including executable
// identity and normalized slash/case variants of its known -C worktree. No matching
// process is an observation, NOT proof that all descendants stopped.
export async function continueAttendedNative(options,dependencies={}){
 const {priorInvocationId,sessionId,worktree,evidenceRoot,candidateCommitSha,authorizeContinuation,beforeInput,timeoutMs=120000}=options||{};
 if(!uuid(priorInvocationId)||!uuid(sessionId)||typeof candidateCommitSha!=='string'||!/^[a-f0-9]{40}$/.test(candidateCommitSha)||typeof authorizeContinuation!=='function'||typeof beforeInput!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000)fail('CONTINUATION_INPUT');
 for(const p of [worktree,evidenceRoot])if(typeof p!=='string'||inspectRoot(p).reason)fail('UNSAFE_INVOCATION_ROOT');
 const cwd=fs.realpathSync.native(worktree),base=fs.realpathSync.native(evidenceRoot),priorDir=join(base,priorInvocationId);
 if(inspectRoot(priorDir).reason||cwd===base)fail('UNSAFE_PRIOR_EVIDENCE');
 const manifestText=immutableRead(join(priorDir,'manifest.json')),prior=parseNativeTransport(manifestText),observationText=immutableRead(join(priorDir,'observation.json')),observation=parseNativeTransport(observationText),priorPrompt=immutableRead(join(priorDir,'prompt.txt')),schemaText=immutableRead(join(priorDir,'schema.json'));
 const scopePaths=bindScope(options.scopePaths??prior.scopePaths),schema=scopedSchema('codex',scopePaths),mode=dependencies.transport?'simulated':'native';
 if(prior.version!=='attended-native/1'||prior.provider!=='codex'||prior.mode!==mode||prior.invocationId!==priorInvocationId||prior.worktree!==cwd||prior.continuation||JSON.stringify(prior.scopePaths)!==JSON.stringify(scopePaths)||prior.promptSha256!==sha(priorPrompt)||prior.schemaSha256!==sha(JSON.stringify(parseNativeTransport(schemaText)))||prior.schemaSha256!==sha(JSON.stringify(schema)))fail('PRIOR_BINDING');
 if(observation.invocationId!==priorInvocationId||observation.provider!=='codex'||observation.mode!==mode||observation.worktree!==cwd||JSON.stringify(observation.scopePaths)!==JSON.stringify(scopePaths)||observation.promptSha256!==prior.promptSha256||observation.schemaSha256!==prior.schemaSha256||observation.code!=='TIMEOUT'||observation.completionObserved!==false||observation.inputDelivered!==true)fail('PRIOR_NOT_CONTINUABLE');
 const task=parseNativeTransport(priorPrompt);
 if(task.candidateCommitSha!==candidateCommitSha||JSON.stringify(task.scopePaths)!==JSON.stringify(scopePaths)||!task.source||Object.keys(task.source).sort().join(',')!==[...scopePaths].sort().join(','))fail('CANDIDATE_BINDING');
 let observedSession=observation.sessionId||null;
 if(fs.existsSync(join(priorDir,'session.json'))){const s=parseNativeTransport(immutableRead(join(priorDir,'session.json')));if(s.invocationId!==priorInvocationId||s.promptSha256!==prior.promptSha256||!uuid(s.sessionId)||observedSession&&observedSession!==s.sessionId)fail('PRIOR_SESSION_BINDING');observedSession=s.sessionId;}
 if(observedSession&&observedSession!==sessionId)fail('PRIOR_SESSION_BINDING');
 const checkCandidate=()=>{const p=inspectRepository(cwd);if(p.state!=='CLEAN'||p.head!==candidateCommitSha||scopePaths.some(path=>immutableRead(join(cwd,path))!==task.source[path]))fail('CANDIDATE_CHANGED');};
 checkCandidate();
 const invocationId=options.invocationId||randomUUID();if(!uuid(invocationId)||invocationId===priorInvocationId)fail('INVOCATION_ID');
 const binding={priorInvocationId,sessionId,worktree:cwd,candidateCommitSha,scopePaths,promptSha256:prior.promptSha256,schemaSha256:prior.schemaSha256,priorManifestSha256:sha(manifestText),priorObservationSha256:sha(observationText)};
 const bindingHash=sha(canonicalize(binding)),intent={version:'native-continuation/1',invocationId,binding,bindingHash,createdAt:new Date().toISOString(),mode,priorStop:'unknown'};
 const intentPath=join(base,'continuation-'+priorInvocationId+'.json');
 try{immutableWrite(intentPath,intent);}catch(e){if(e.code==='EEXIST')fail('CONTINUATION_ALREADY_ATTEMPTED');throw e;}
 dependencies.fault?.('after-continuation-intent');
 let timer,admission;
 try{admission=await Promise.race([Promise.resolve().then(()=>authorizeContinuation(freeze({...intent,observedSessionId:observedSession,priorProcess:observation.process||null}))),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('CONTINUATION_ADMISSION_TIMEOUT')),5000);})]);}finally{clearTimeout(timer);}
 const now=Date.now(),allowance=admission?.allowance,inventory=admission?.processInventory;
 if(admission?.bindingHash!==bindingHash||admission?.observedSessionId!==sessionId||!id(admission?.evidenceRef)||!inventory||!['original-exit-observed','no-matching-process-observed'].includes(inventory.state)||!id(inventory.evidenceRef)||!Number.isFinite(Date.parse(inventory.observedAt))||Date.parse(inventory.observedAt)>now+1000||now-Date.parse(inventory.observedAt)>30000||!allowance||!id(allowance.id)||!Number.isInteger(allowance.maxDurationMs)||allowance.maxDurationMs<timeoutMs||allowance.maxDurationMs>600000||!Number.isFinite(Date.parse(allowance.issuedAt))||Date.parse(allowance.issuedAt)>now+1000||now-Date.parse(allowance.issuedAt)>30000||!Number.isFinite(Date.parse(allowance.expiresAt))||Date.parse(allowance.expiresAt)<=now||Date.parse(allowance.expiresAt)-Date.parse(allowance.issuedAt)>600000)fail('CONTINUATION_ADMISSION_HELD');
 const authority={bindingHash,observedSessionId:sessionId,evidenceRef:admission.evidenceRef,processInventory:{state:inventory.state,evidenceRef:inventory.evidenceRef,observedAt:inventory.observedAt},allowance:{id:allowance.id,maxDurationMs:allowance.maxDurationMs,issuedAt:allowance.issuedAt,expiresAt:allowance.expiresAt}};
 immutableWrite(join(base,'continuation-admission-'+invocationId+'.json'),authority);
 checkCandidate();
 if(sha(immutableRead(join(priorDir,'manifest.json')))!==binding.priorManifestSha256||sha(immutableRead(join(priorDir,'observation.json')))!==binding.priorObservationSha256||sha(immutableRead(join(priorDir,'prompt.txt')))!==binding.promptSha256||sha(JSON.stringify(parseNativeTransport(immutableRead(join(priorDir,'schema.json')))))!==binding.schemaSha256)fail('PRIOR_EVIDENCE_CHANGED');
 const prompt=JSON.stringify({instruction:'Continue the interrupted review in this same conversation. Complete the pending verdict for the unchanged candidate and original acceptance; do not start unrelated work or use tools. Return the supplied review schema.',priorInvocationId,candidateCommitSha,priorPromptSha256:prior.promptSha256});
 return invokeAttendedNative({provider:'codex',worktree:cwd,evidenceRoot:base,scopePaths,sessionId,invocationId,prompt,timeoutMs,maxOutputBytes:options.maxOutputBytes,beforeInput:async event=>{if(Date.now()>=Date.parse(authority.allowance.expiresAt))fail('CONTINUATION_ALLOWANCE_EXPIRED');checkCandidate();await beforeInput(event);if(Date.now()>=Date.parse(authority.allowance.expiresAt))fail('CONTINUATION_ALLOWANCE_EXPIRED');},[continuationToken]:{...intent,admission:authority}},dependencies);
}
// Injected transport is explicitly SIMULATED evidence, never native proof.
// beforeInput is executable host code. It may reserve/admit an invocation using
// a conservative submission bound, but must not call process launch a model ACK.
export async function invokeAttendedNative(options,dependencies={}){
 if(options?.provider==='grok'&&(options.grokAcp===true||options.grokHeadless===true)){
  const {invokeAttendedGrok}=await import('./attended-grok.mjs');
  return invokeAttendedGrok(options,dependencies);
 }
 const {provider,worktree,evidenceRoot,prompt,beforeInput,sessionId:requestedSession,invocationId:requestedInvocation,timeoutMs=120000,maxOutputBytes=65536}=options||{};
 if(!['claude','codex','grok'].includes(provider)||typeof beforeInput!=='function'||typeof prompt!=='string'||!prompt||Buffer.byteLength(prompt)>32768||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000||!Number.isInteger(maxOutputBytes)||maxOutputBytes<128||maxOutputBytes>262144)fail('INVOCATION_INPUT');
 const scopePaths=bindScope(options.scopePaths);
 const continuation=options[continuationToken]||null;
 if(options.resumeSessionId!==undefined||options.continuation!==undefined)fail('EXPLICIT_CONTINUATION_REQUIRED');
 for(const p of [worktree,evidenceRoot])if(typeof p!=='string'||inspectRoot(p).reason)fail('UNSAFE_INVOCATION_ROOT');
 const cwd=fs.realpathSync.native(worktree), evidenceBase=fs.realpathSync.native(evidenceRoot);
 if(cwd===evidenceBase)fail('EVIDENCE_ROOT_SEPARATE');
 if(requestedSession!==undefined&&!uuid(requestedSession))fail('SESSION_INPUT');
 if(requestedInvocation!==undefined&&!uuid(requestedInvocation))fail('INVOCATION_ID');
 const sessionId=provider==='codex'?requestedSession:(requestedSession||randomUUID());
 const schema=scopedSchema(provider,scopePaths);
 const invocationId=requestedInvocation||randomUUID(),dir=join(evidenceBase,invocationId);
 fs.mkdirSync(dir);
 const save=(name,value)=>fs.writeFileSync(join(dir,name),typeof value==='string'?value:JSON.stringify(value,null,2),{flag:'wx',mode:0o600});
 const mode=provider==='grok'?'prepare-only':dependencies.transport?'simulated':'native';
 const clock=dependencies.clock||(()=>new Date().toISOString());
 const schemaFile=join(dir,'schema.json'),promptFile=join(dir,'prompt.txt');
 save('prompt.txt',prompt);save('schema.json',schema);
 const command=(dependencies.resolveCommand||resolveNativeCommand)(provider==='claude'?'claude-code':provider);
 if(!Array.isArray(command)||!command.length||command.some(x=>typeof x!=='string')||!(/^(?:[A-Za-z]:[\\/]|\/)/.test(command[0])))fail('COMMAND_RESOLUTION');
 const args=[...command.slice(1),...buildArgs(provider,{worktree:cwd,sessionId,schemaFile,promptFile,schema,resume:!!continuation})];
 const manifest={version:'attended-native/1',mode,invocationId,provider,scopePaths,requestedSession:sessionId||null,worktree:cwd,promptSha256:sha(prompt),schemaSha256:sha(JSON.stringify(schema)),createdAt:clock(),limitations:['Host invocation start is not model acknowledgement','Financial duration remains held','Child exit is not proof of all descendant or remote cancellation',...(provider==='codex'?['Read-only sandbox does not isolate all filesystem reads']:[])]};
 if(continuation)manifest.continuation=continuation;
 if(provider==='grok')manifest.limitations=['Preparation only; no provider invocation or observed session','Native response envelope and spending cap remain unqualified','Tool/config restrictions remain unqualified; this plan is not launch authority'];
 freeze(manifest);
 save('manifest.json',manifest);
 if(provider==='grok'){
  // Help proves request flags, not a native response envelope or monetary ceiling.
  // This branch is deliberately before transport selection, callbacks and timers.
  const prepared={provider,command:[...command],args:[...args],cwd,sessionId,promptFile,schemaFile,launchAllowed:false,blockers:['GROK_SPEND_CAP_UNQUALIFIED','GROK_RESULT_ENVELOPE_UNQUALIFIED','GROK_TOOL_CONFIG_BOUNDARY_UNQUALIFIED']};
  const evidence={...manifest,status:'not_run',code:'GROK_PREPARE_ONLY',hostInvocationStartedAt:null,submittedAt:null,inputDelivered:false,observedAt:clock(),sessionId:null,exit:null,completionObserved:false};
  save('preparation.json',prepared);save('observation.json',evidence);
  return {ok:false,code:'GROK_PREPARE_ONLY',status:'not_run',preparationComplete:true,prepared,evidence:{...evidence,directory:dir},completionObserved:false,financial:'not_run',stop:'not-started'};
 }
 const transport=dependencies.transport||spawn;
 return await new Promise(resolveResult=>{
  let child,finished=false,stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),hostInvocationStartedAt=null,submittedAt=null,inputDelivered=false,exit=null,earlySession=null,lineOffset=0,processIdentity=null;
  const remaining=continuation?Math.min(timeoutMs,Date.parse(continuation.admission.allowance.expiresAt)-Date.now()):timeoutMs;
  let timer;
  if(remaining<=0){finish('CONTINUATION_ALLOWANCE_EXPIRED');return;}
  timer=setTimeout(()=>finish('TIMEOUT'),remaining);
  function finish(code,parsed=null){
   if(finished)return;finished=true;clearTimeout(timer);
   let cancellationRequested=false;
   if(code&&child&&exit===null){try{cancellationRequested=child.kill()===true;}catch{}}
   const evidence={...manifest,hostInvocationStartedAt,submittedAt,inputDelivered,observedAt:clock(),sessionId:parsed?.sessionId||earlySession,process:processIdentity,exit,stdoutSha256:sha(stdout),stderrSha256:sha(stderr),stdoutBytes:stdout.length,stderrBytes:stderr.length,cancellationRequested,code:code||'OK',completionObserved:!code};
   // No environment, raw diagnostics, provider error body or credentials are persisted.
   try{if(parsed)save('result.json',parsed);save('observation.json',evidence);}catch{code='EVIDENCE_WRITE_FAILED';}
   resolveResult({ok:!code,code:code||'OK',...(parsed?{[provider==='claude'?'proposal':'review']:parsed.payload}:{}),evidence:{...evidence,code:code||'OK',completionObserved:!code,directory:dir},completionObserved:!code,financial:'held',stop:code?'unknown':'invocation-complete'});
  }
  try{child=transport(command[0],args,{cwd,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});}
  catch{return finish('SPAWN_FAILED');}
  for(const [channel,key]of [[child.stdout,'out'],[child.stderr,'err']]){
   channel.on('data',bytes=>{
    if(finished)return;
    const b=Buffer.from(bytes),old=key==='out'?stdout:stderr;
    if(stdout.length+stderr.length+b.length>maxOutputBytes)return finish('OUTPUT_LIMIT');
    if(key==='out')stdout=Buffer.concat([old,b]);else stderr=Buffer.concat([old,b]);
    if(key==='out'&&provider==='codex')try{
     let end;while((end=stdout.indexOf(10,lineOffset))>=0){const line=new TextDecoder('utf-8',{fatal:true}).decode(stdout.subarray(lineOffset,end)).trim();lineOffset=end+1;if(!line)continue;const item=parseNativeTransport(line);if(item.type==='thread.started'){if(earlySession||!uuid(item.thread_id)||sessionId&&sessionId!==item.thread_id)fail('SESSION_MISMATCH');earlySession=item.thread_id;immutableWrite(join(dir,'session.json'),{invocationId,sessionId:earlySession,promptSha256:manifest.promptSha256,observedAt:clock(),mode});}}
    }catch(e){finish(id(e.code)?e.code:'INVALID_OUTPUT');}
   });
  }
  child.on('error',()=>finish('PROCESS_ERROR'));
  child.stdin.on('error',()=>finish('INPUT_FAILED'));
  child.once('spawn',async()=>{
   if(finished)return;hostInvocationStartedAt=clock();
   processIdentity=Object.freeze({pid:Number.isSafeInteger(child.pid)&&child.pid>0?child.pid:null,executable:command[0],argvSha256:sha(JSON.stringify(args)),hostSpawnObservedAt:hostInvocationStartedAt,osStartTime:null,descendants:'unknown'});
   const event=Object.freeze({kind:'host-invocation-started',mode,provider,invocationId,hostInvocationStartedAt,process:processIdentity,modelAcknowledged:false,requestedSession:sessionId||null,promptSha256:manifest.promptSha256,evidenceDirectory:dir});
   try{save('invocation.json',event);await beforeInput(event);}catch{return finish('HOST_ADMISSION_FAILED');}
   if(finished)return;
   submittedAt=clock();
   try{save('submission.json',{invocationId,submittedAt,modelAcknowledged:false});inputDelivered=true;child.stdin.end(prompt);}catch{finish('INPUT_FAILED');}
  });
  child.once('close',(code,signal)=>{
   if(finished){try{immutableWrite(join(dir,'late-close.json'),{invocationId,process:processIdentity,exit:{code,signal:signal||null,observedAt:clock()},originalOutcomeUnchanged:true,descendantStop:'unknown'});}catch{}return;}exit={code,signal:signal||null,observedAt:clock()};
   if(!inputDelivered)return finish('EXIT_BEFORE_INPUT');
   if(code!==0||signal)return finish('PROCESS_FAILED');
   try{const parsed=parseOutput(provider,new TextDecoder('utf-8',{fatal:true}).decode(stdout),sessionId,scopePaths);finish(null,parsed);}
   catch(e){finish(id(e.code)?e.code:'INVALID_OUTPUT');}
  });
 });
}
