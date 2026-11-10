// Bounded, attended ACP proposal transport. No enrollment, retries or auth commands.
// Native policy qualification is executable host authority, never request JSON.
import * as fs from 'node:fs';
import {join,isAbsolute,relative,sep} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {inspectRoot} from './portfolio-policy.mjs';
import {parseStrict,parseNativeTransport} from './handoff.mjs';
import {containsSecret} from './state-lib.mjs';
import {validateNativePayload,bindNativeScope,writeNativeEvidence} from './attended-native.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(x);
const id=x=>typeof x==='string'&&/^[A-Za-z0-9._-]{1,128}$/.test(x);
function read(path){const s=fs.lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>262144)fail('GROK_RECORD_UNSAFE');return parseStrict(fs.readFileSync(path,'utf8'));}
function freeze(x){if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;}
async function bounded(fn,ms){let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('GROK_HOST_TIMEOUT')),ms);})]);}finally{clearTimeout(timer);}}
function containsRoot(parent,child){const path=relative(parent,child);return path===''||path!=='..'&&!path.startsWith('..'+sep)&&!isAbsolute(path);}
// beforeInput(event, {signal}) must settle with {cancelled:true,evidenceRef}
// to acknowledge completed cancellation/cleanup, including before abort. An ignored abort,
// late success or late rejection cannot prove admission side effects stopped.
function startAdmission(beforeInput,event,cancelGraceMs){
 const controller=new AbortController();let wakeAbort,timer,graceTimer;
 const aborted=new Promise(resolve=>{wakeAbort=resolve;});
 const abort=()=>{if(!controller.signal.aborted){controller.abort();wakeAbort({aborted:true});}};
 const work=Promise.resolve().then(()=>beforeInput(freeze(event),Object.freeze({signal:controller.signal}))).then(value=>({settled:true,fulfilled:true,value}),()=>({settled:true,fulfilled:false}));
 const promise=(async()=>{
  timer=setTimeout(abort,1000);
  try{
   const first=await Promise.race([work,aborted]);
   if(!controller.signal.aborted){
    if(first.fulfilled&&first.value?.cancelled===true)return id(first.value.evidenceRef)?{state:'cancelled',settled:true,evidenceRef:first.value.evidenceRef}:{state:'uncertain',settled:true};
    return {state:first.fulfilled?'admitted':'refused',settled:true};
   }
   const result=await Promise.race([work,new Promise(resolve=>{graceTimer=setTimeout(()=>resolve({settled:false}),cancelGraceMs);})]);
   if(result.fulfilled&&result.value?.cancelled===true&&id(result.value.evidenceRef))return {state:'cancelled',settled:true,evidenceRef:result.value.evidenceRef};
   return {state:'uncertain',settled:result.settled};
  }finally{clearTimeout(timer);clearTimeout(graceTimer);}
 })();
 return {abort,promise};
}
export async function invokeAttendedGrok(options={},deps={}){
 const {worktree,evidenceRoot,prompt,beforeInput,qualifyNative,executable,authPath,timeoutMs=120000,cancelGraceMs=3000,maxOutputBytes=65536}=options;
 if(typeof beforeInput!=='function'||typeof prompt!=='string'||!prompt||Buffer.byteLength(prompt)>32768||containsSecret(prompt)||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000||!Number.isInteger(cancelGraceMs)||cancelGraceMs<1||cancelGraceMs>10000||!Number.isInteger(maxOutputBytes)||maxOutputBytes<128||maxOutputBytes>262144)fail('GROK_INPUT');
 if(Object.keys(deps).length&&deps.simulated!==true)fail('GROK_SIMULATION_REQUIRED');
 const simulated=deps.simulated===true;
 const headless=options.grokHeadless===true;
 if(headless&&options.grokAcp===true)fail('GROK_TRANSPORT_CONFLICT');
 const requestedSession=headless?(options.sessionId||options.invocationId||randomUUID()):null;
 if(headless&&!uuid(requestedSession))fail('GROK_SESSION');
 if(simulated&&typeof deps.transport!=='function')fail('GROK_SIMULATION_REQUIRED');
 for(const p of [worktree,evidenceRoot])if(typeof p!=='string'||inspectRoot(p).reason)fail('GROK_ROOT');
 const cwd=fs.realpathSync.native(worktree),base=fs.realpathSync.native(evidenceRoot);
 if(containsRoot(cwd,base)||containsRoot(base,cwd))fail('GROK_ROOT');
 const scopePaths=bindNativeScope(options.scopePaths),invocationId=options.invocationId||randomUUID();if(!uuid(invocationId))fail('GROK_INPUT');
 const binding={version:'attended-grok/1',mode:simulated?'simulated':'native',transport:headless?'headless':'acp',requestedSession,invocationId,worktree:cwd,scopePaths,promptSha256:hash(prompt)};
 const bindingHash=hash(JSON.stringify(binding)),dir=join(base,invocationId);
 if(fs.existsSync(dir)){
  if(inspectRoot(dir).reason||read(join(dir,'manifest.json')).bindingHash!==bindingHash)fail('GROK_INVOCATION_CONFLICT');
  if(fs.existsSync(join(dir,'observation.json'))){const prior=read(join(dir,'observation.json'));return {ok:false,code:prior.code==='GROK_ADMISSION_UNCERTAIN'?'GROK_ADMISSION_UNCERTAIN':'GROK_ALREADY_RECORDED',completionObserved:false,financial:'held',operation:'held',stop:'unknown',invocationId,evidenceDirectory:dir};}
  return {ok:false,code:'GROK_INVOCATION_UNKNOWN',completionObserved:false,financial:'held',stop:'unknown',invocationId};
 }
 fs.mkdirSync(dir);const save=(name,value)=>writeNativeEvidence(join(dir,name),value);
 save('manifest.json',{...binding,bindingHash});save('prompt.json',{prompt});
 const home=join(dir,'home');fs.mkdirSync(home);
 const policy='allow_managed_hooks_only = true\n[permission]\nrules = ['+['bash','read','edit','grep','mcp','webfetch','websearch'].map(tool=>'{ action = "deny", tool = "'+tool+'" }').join(',')+']\n';
 const profile='---\nname: attended-proposal\ndescription: Return only the supplied proposal schema\ntools: []\nmcpServers: {}\nmcpInheritance: none\n---\nUse only the supplied prompt. Return one JSON object with path and content.\n';
 const policyPath=join(home,'requirements.toml'),profilePath=join(dir,'agent.md');fs.writeFileSync(policyPath,policy,{flag:'wx'});fs.writeFileSync(profilePath,profile,{flag:'wx'});
 const env={};for(const k of ['SystemRoot','WINDIR','TEMP','TMP','PATH','PATHEXT','USERPROFILE'])if(process.env[k])env[k]=process.env[k];
 Object.assign(env,{HOME:home,USERPROFILE:home,GROK_HOME:home,GROK_DISABLE_AUTOUPDATER:'1',GROK_MEMORY:'0',GROK_SUBAGENTS:'0',GROK_GOAL:'0',GROK_WEB_FETCH:'0'});
 for(const vendor of ['CLAUDE','CURSOR'])for(const surface of ['HOOKS','MCPS','SKILLS','RULES','AGENTS'])env['GROK_'+vendor+'_'+surface+'_ENABLED']='0';
 if(authPath!==undefined){if(typeof authPath!=='string'||!isAbsolute(authPath))fail('GROK_AUTH_PATH');env.GROK_AUTH_PATH=authPath;} // path only; never read it
 const promptFile=join(dir,'prompt.txt');
 if(headless)fs.writeFileSync(promptFile,prompt,{flag:'wx',mode:0o600});
 const args=headless?['--cwd',cwd,'--session-id',requestedSession,'--prompt-file',promptFile,'--output-format','json','--tools','todo_write','--disallowed-tools','todo_write,search_tool,use_tool,Agent','--permission-mode','dontAsk','--no-subagents','--disable-web-search','--max-turns','1','--no-auto-update']:['agent','--no-leader','--agent-profile',profilePath,'stdio'];
 let qualifiedRef=null,verifyLaunch=()=>{};
 if(!simulated){
  if(typeof qualifyNative!=='function'||typeof executable!=='string'||!isAbsolute(executable))fail('GROK_NATIVE_POLICY_UNQUALIFIED');
  const stat=fs.lstatSync(executable);if(!stat.isFile()||stat.isSymbolicLink())fail('GROK_EXECUTABLE');
  if(headless&&authPath===undefined)fail('GROK_AUTH_PATH');
  const fields={bindingHash,transport:binding.transport,executable,executableSha256:hash(fs.readFileSync(executable)),cwd,args:[...args],home,env:{...env},policyPath,profilePath,policySha256:hash(policy),profileSha256:hash(profile),toolPolicy:headless?'headless-explicit-allow-deny/1':'acp-empty-effective-tools/1'};
  const challenge=freeze({...fields,launchHash:hash(JSON.stringify(fields))});
  const proof=await bounded(()=>qualifyNative(challenge),5000);
  // The host must demonstrate an empty EFFECTIVE tool registry, not merely tools: [].
  if(proof?.bindingHash!==bindingHash||proof.launchHash!==challenge.launchHash||proof.executableSha256!==challenge.executableSha256||proof.policySha256!==challenge.policySha256||proof.profileSha256!==challenge.profileSha256||proof.nonManagedHooks!==false||!['mcpServers','plugins','projectInstructions',...headless?[]:['effectiveTools']].every(k=>Array.isArray(proof[k])&&proof[k].length===0)||headless&&proof.toolPolicy!==challenge.toolPolicy||!id(proof.evidenceRef))fail('GROK_NATIVE_POLICY_UNQUALIFIED');
  verifyLaunch=()=>{for(const [path,expected] of [[executable,challenge.executableSha256],[policyPath,challenge.policySha256],[profilePath,challenge.profileSha256]]){const s=fs.lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||hash(fs.readFileSync(path))!==expected)fail('GROK_POLICY_CHANGED');}};
  verifyLaunch();
  qualifiedRef=proof.evidenceRef;const {env:ignoredEnvironment,...record}=challenge;save('qualification.json',{...record,evidenceRef:qualifiedRef});
 }
 if(headless)return runHeadless({options,deps,save,binding,bindingHash,dir,cwd,env,args,executable,qualifiedRef,promptFile,verifyLaunch});
 save('launch-intent.json',{bindingHash,qualifiedRef,at:new Date().toISOString()});deps.fault?.('after-launch-intent');
 return new Promise(resolveResult=>{
  let child,buffer='',bytes=0,text='',sessionId=null,nextId=0,promptId=null,terminal=null,finished=false,cancelling=false,cancelTimer,deadline,closeTimer,inputDelivered=false,code=null,hostAdmission=null,admission=null,deferredFinish=null;
  const pending=new Map(),decoder=new TextDecoder('utf-8',{fatal:true});const at=()=>new Date().toISOString();
  function finish(error,exit=null){if(finished)return;
   if(hostAdmission&&!admission){deferredFinish??={error,exit};hostAdmission.abort();return;}
   if(admission?.state==='uncertain')error='GROK_ADMISSION_UNCERTAIN';
   finished=true;clearTimeout(deadline);clearTimeout(cancelTimer);clearTimeout(closeTimer);
   for(const {reject} of pending.values())reject(Error('GROK_CLOSED'));pending.clear();
   let proposal=null;if(!error&&terminal==='end_turn'){try{proposal=validateNativePayload('grok',parseStrict(text),{scopePaths});}catch{error='GROK_PROPOSAL_INVALID';}}
   const ok=!error&&terminal==='end_turn'&&exit?.code===0;
   const result={ok,code:error|| (terminal==='cancelled'?'GROK_CANCELLED':ok?'GROK_COMPLETE':'GROK_EXIT'),provider:'grok',mode:binding.mode,invocationId,sessionId,inputDelivered,completionObserved:ok,proposal:ok?proposal:null,stop:terminal==='cancelled'?'turn-cancelled':ok?'invocation-complete':'unknown',financial:'held',operation:'held',admission,terminalReason:terminal,exit,evidence:{...binding,bindingHash,sessionId,observedAt:at(),qualifiedRef,directory:dir}};
   save('observation.json',result);resolveResult(result);
  }
  function write(message){if(!finished)child.stdin.write(JSON.stringify(message)+'\n');}
  function request(method,params){const requestId=++nextId;return {id:requestId,promise:new Promise((resolve,reject)=>{pending.set(requestId,{resolve,reject});write({jsonrpc:'2.0',id:requestId,method,params});})};}
  function terminate(error){code=error;try{child?.kill();}catch{}finish(error);}
  function cancel(reason){if(finished||cancelling)return;cancelling=true;code=reason;
   if(!sessionId||promptId===null){terminate(reason);return;}
   try{save('cancel-intent.json',{sessionId,promptId,reason,at:at()});write({jsonrpc:'2.0',method:'session/cancel',params:{sessionId}});}catch{terminate('GROK_IO');return;}
   cancelTimer=setTimeout(()=>terminate('GROK_CANCEL_UNCONFIRMED'),cancelGraceMs);
  }
  function receive(m){
   if(m.jsonrpc!=='2.0')return cancel('GROK_PROTOCOL');
   if(m.method==='session/request_permission'){
    write({jsonrpc:'2.0',id:m.id,result:{outcome:{outcome:'cancelled'}}});return cancel('GROK_TOOL_REFUSED');
   }
   if(m.method==='session/update'){
    if(m.params?.sessionId!==sessionId)return cancel('GROK_SESSION_MISMATCH');
    const u=m.params.update;if(u?.sessionUpdate==='tool_call'||u?.sessionUpdate==='tool_call_update')return cancel('GROK_TOOL_REFUSED');
    if(u?.sessionUpdate==='agent_message_chunk'){
     if(promptId===null||terminal||u.content?.type!=='text'||typeof u.content.text!=='string')return cancel('GROK_PROTOCOL');
     text+=u.content.text;
    }return;
   }
   if(m.method){if(m.id!==undefined)write({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Unsupported client method'}});return cancel('GROK_CLIENT_METHOD_REFUSED');}
   const p=pending.get(m.id);if(!p)return cancel('GROK_REQUEST_MISMATCH');pending.delete(m.id);
   if(m.error)p.reject(Error('GROK_PROVIDER_REFUSED'));else if(!m.result||typeof m.result!=='object')p.reject(Error('GROK_PROTOCOL'));else p.resolve(m.result);
  }
  try{
   child=(deps.transport||spawn)(executable||'SIMULATED',args,{cwd,env,stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
   child.on('error',()=>terminate('GROK_SPAWN'));
   child.stdin.on('error',()=>terminate('GROK_IO'));
   child.on('close',(exitCode,signal)=>finish(code,{code:exitCode,signal}));
   child.stdout.on('data',chunk=>{if(finished)return;bytes+=Buffer.byteLength(chunk);if(bytes>maxOutputBytes)return cancel('GROK_OUTPUT_LIMIT');try{buffer+=decoder.decode(Buffer.from(chunk),{stream:true});}catch{return cancel('GROK_PROTOCOL');}let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line.trim())continue;try{receive(parseStrict(line));}catch{cancel('GROK_PROTOCOL');}}});
   child.stderr.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>maxOutputBytes)cancel('GROK_OUTPUT_LIMIT');});
   deadline=setTimeout(()=>cancel('GROK_TIMEOUT'),timeoutMs);
   (async()=>{
    const init=await request('initialize',{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}}).promise;
    if(init.protocolVersion!==1)throw Error('GROK_PROTOCOL');
    const session=await request('session/new',{cwd,mcpServers:[]}).promise;
    if(typeof session.sessionId!=='string'||!session.sessionId||session.sessionId.length>256)throw Error('GROK_SESSION');sessionId=session.sessionId;
    save('session.json',{sessionId,bindingHash});
    save('submit-intent.json',{sessionId,bindingHash,at:at()});deps.fault?.('after-submit-intent');
    hostAdmission=startAdmission(beforeInput,{provider:'grok',mode:binding.mode,invocationId,sessionId,worktree:cwd,scopePaths,promptSha256:binding.promptSha256,bindingHash,modelAcknowledged:false,hostInvocationStartedAt:at()},cancelGraceMs);
    admission=await hostAdmission.promise;save('admission.json',{...admission,bindingHash,at:at()});
    if(deferredFinish){finish(deferredFinish.error,deferredFinish.exit);return;}
    if(admission.state!=='admitted'){terminate(admission.state==='uncertain'?'GROK_ADMISSION_UNCERTAIN':'GROK_HOST_REFUSED');return;}
    if(finished||cancelling)return;
    promptId=nextId+1;inputDelivered=true;
    const result=await request('session/prompt',{sessionId,prompt:[{type:'text',text:prompt}]}).promise;
    terminal=result.stopReason;
    if(!['end_turn','cancelled'].includes(terminal)){code='GROK_TURN_REFUSED';}else if(cancelling&&terminal!=='cancelled'){code='GROK_CANCEL_UNCONFIRMED';}else if(terminal==='cancelled'&&code==='GROK_TIMEOUT'){code=null;}
    clearTimeout(deadline);clearTimeout(cancelTimer);save('terminal.json',{sessionId,promptId,stopReason:terminal,at:at()});
    child.stdin.end();closeTimer=setTimeout(()=>terminate('GROK_CLOSE_UNCONFIRMED'),cancelGraceMs);
   })().catch(e=>{if(!finished){const error=/^GROK_[A-Z_]+$/.test(e.message)?e.message:'GROK_HOST_REFUSED';if(error==='GROK_PROVIDER_REFUSED')terminate(error);else cancel(error);}});
  }catch{terminate('GROK_SPAWN');}
 });
}

async function runHeadless({options,deps,save,binding,bindingHash,dir,cwd,env,args,executable,qualifiedRef,promptFile,verifyLaunch}){
 const {timeoutMs=120000,maxOutputBytes=65536,beforeInput,cancelGraceMs=3000}=options;
 const sessionId=binding.requestedSession,at=()=>new Date().toISOString();
 // This immutable intent precedes admission AND process launch. An interrupted
 // invocation is never relaunched from the same evidence identity.
 save('submit-intent.json',{bindingHash,sessionId,at:at()});deps.fault?.('after-submit-intent');
 const admission=await startAdmission(beforeInput,{provider:'grok',mode:binding.mode,invocationId:binding.invocationId,sessionId,worktree:cwd,scopePaths:binding.scopePaths,promptSha256:binding.promptSha256,bindingHash,modelAcknowledged:false,hostInvocationStartedAt:at()},cancelGraceMs).promise;
 save('admission.json',{...admission,bindingHash,at:at()});
 if(admission.state!=='admitted'){const uncertain=admission.state==='uncertain',r={ok:false,code:uncertain?'GROK_ADMISSION_UNCERTAIN':'GROK_HOST_REFUSED',invocationId:binding.invocationId,inputDelivered:false,completionObserved:false,stop:uncertain?'unknown':'not-started',financial:'held',operation:'held',admission};save('observation.json',r);return r;}
 const promptStat=fs.lstatSync(promptFile);if(!promptStat.isFile()||promptStat.isSymbolicLink()||promptStat.nlink!==1||hash(fs.readFileSync(promptFile))!==binding.promptSha256)fail('GROK_PROMPT_CHANGED');
 verifyLaunch();
 save('launch-intent.json',{bindingHash,sessionId,at:at()});deps.fault?.('after-launch-intent');
 return new Promise(resolveResult=>{
  let child,timer,finished=false,output=Buffer.alloc(0),bytes=0,launched=false;
  function finish(code,exit=null){if(finished)return;finished=true;clearTimeout(timer);let proposal=null,requestId=null,terminalReason=null;
   if(!code&&exit?.code===0){try{const raw=parseNativeTransport(new TextDecoder('utf-8',{fatal:true}).decode(output));
    if(raw.sessionId!==sessionId)fail('GROK_SESSION_MISMATCH');
    if(raw.stopReason!=='end_turn')fail('GROK_TURN_REFUSED');
    if(typeof raw.requestId!=='string'||!raw.requestId||raw.requestId.length>256||typeof raw.text!=='string')fail('GROK_ENVELOPE');
    proposal=validateNativePayload('grok',parseNativeTransport(raw.text),{scopePaths:binding.scopePaths});requestId=raw.requestId;terminalReason=raw.stopReason;
   }catch(e){code=/^GROK_[A-Z_]+$/.test(e.code||'')?e.code:'GROK_PROPOSAL_INVALID';}}
   const ok=!code&&exit?.code===0&&proposal!==null;
   const r={ok,code:code|| (ok?'GROK_COMPLETE':'GROK_EXIT'),provider:'grok',mode:binding.mode,invocationId:binding.invocationId,sessionId,requestId,inputDelivered:launched,completionObserved:ok,proposal:ok?proposal:null,stop:ok?'invocation-complete':'unknown',financial:'held',terminalReason,exit,evidence:{...binding,bindingHash,sessionId,observedAt:at(),qualifiedRef,directory:dir}};
   save('observation.json',r);resolveResult(r);
  }
  function stop(code){try{child?.kill();}catch{}finish(code);}
  try{
   child=(deps.transport||spawn)(executable||'SIMULATED',args,{cwd,env,stdio:['ignore','pipe','pipe'],windowsHide:true,shell:false});launched=true;
   child.on('error',()=>finish('GROK_SPAWN'));child.on('close',(code,signal)=>finish(null,{code,signal}));
   child.stdout.on('data',chunk=>{if(finished)return;bytes+=Buffer.byteLength(chunk);if(bytes>maxOutputBytes)return stop('GROK_OUTPUT_LIMIT');output=Buffer.concat([output,Buffer.from(chunk)]);});
   child.stderr.on('data',chunk=>{if(finished)return;bytes+=Buffer.byteLength(chunk);if(bytes>maxOutputBytes)stop('GROK_OUTPUT_LIMIT');});
   timer=setTimeout(()=>stop('GROK_TIMEOUT'),timeoutMs);
  }catch{finish('GROK_SPAWN');}
 });
}
