// Explicit host API, not a service or schedule. Notifications only wake a scan
// of existing loop checkpoints. S7 remains the task/admission/accounting owner.
import {relative,isAbsolute,sep} from 'node:path';
import {openCloudLoop} from './attended-cloud-loop.mjs';
import {inspectRoot} from '../completion/safe-inspection.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(x);
const key=p=>JSON.stringify([p.tenantId,p.projectId]);
const nested=(parent,child)=>{const r=relative(parent,child);return !r||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep));};
const advancePhases=new Set(['observed','candidate','checked','review-ready','reviewed','verdict','consumed']);
const sameBinding=(s,p)=>s.root===p.root&&s.sessionId===p.sessionId&&s.projectBinding?.tenantId===p.tenantId&&s.projectBinding?.projectId===p.projectId;
const safeCode=error=>/^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code||'')?error.code:'PROJECT_OPERATION_HELD';

export async function openAutomaticCloudCoordinator({projects,maxActions=24}={},dependencies={}){
 if(!Array.isArray(projects)||projects.length<1||projects.length>16||!Number.isInteger(maxActions)||maxActions<projects.length||maxActions>64)fail('COORDINATOR_SCOPE');
 if(Object.keys(dependencies).length&&dependencies.simulated!==true)fail('SIMULATION_LABEL_REQUIRED');
 const registered=[],keys=new Set(),sessions=new Set();
 // Reject ambiguous registration before opening any broker or invoking a host.
 for(const p of projects){
  if(!p||Object.keys(p).sort().join(',')!=='host,projectId,root,sessionId,tenantId'||!id(p.tenantId)||!id(p.projectId)||typeof p.root!=='string'||!/^session_[A-Za-z0-9]{1,100}$/.test(p.sessionId||''))fail('PROJECT_REGISTRATION');
  if(typeof p.host?.attest!=='function'||typeof p.host?.observe!=='function'||typeof p.host?.checks!=='function')fail('HOST_CALLBACKS_REQUIRED');
  const inspected=inspectRoot(p.root);if(inspected.reason)fail('UNSAFE_ROOT');
  const registration=Object.freeze({...p,root:inspected.canonical,host:Object.freeze({...p.host})});
  if(keys.has(key(p))||sessions.has(p.sessionId)||registered.some(q=>nested(q.root,registration.root)||nested(registration.root,q.root)))fail('PROJECT_OVERLAP');
  keys.add(key(p));sessions.add(p.sessionId);registered.push(registration);
 }
 const handles=[];let closed=false,running=false,activeRun=false;
 for(const p of registered){
  let loop;
  try{
   loop=await (dependencies.openLoop||openCloudLoop)({root:p.root,sessionId:p.sessionId,projectBinding:{tenantId:p.tenantId,projectId:p.projectId}},p.host);
   if(!sameBinding(loop.status(),p))fail('PROJECT_CHANGED');
   handles.push({registration:p,loop});
  }catch(error){
   if(loop)await Promise.allSettled([loop.close()]);
   handles.push({registration:p,loop:null,openError:safeCode(error)});
  }
 }
 function snapshot(h){
  if(!h.loop)return {root:h.registration.root,sessionId:h.registration.sessionId,projectBinding:{tenantId:h.registration.tenantId,projectId:h.registration.projectId},phase:'held',code:h.openError,canObserve:false};
  const s=h.loop.status();if(!sameBinding(s,h.registration))fail('PROJECT_CHANGED');return s;
 }
 function validateEvent(event){
  if(!event||Object.keys(event).sort().join(',')!=='eventId,generation,inputSha,projectId,requestId,sessionId,tenantId'||!id(event.eventId))fail('EVENT_BINDING');
  const h=handles.find(h=>key(h.registration)===key(event));if(!h)fail('EVENT_BINDING');
  const s=snapshot(h);
  if(!s.requestId||['sessionId','requestId','inputSha','generation'].some(k=>event[k]!==s[k]))fail('EVENT_BINDING');
 }
 async function pass({event}={}){
  if(closed)fail('COORDINATOR_CLOSED');if(running)fail('COORDINATOR_BUSY');
  if(event!==undefined)validateEvent(event);
  running=true;
  const observed=new Set(),failed=new Map(),actions=[];
  try{
   let progress=true;
   while(progress&&actions.length<maxActions){
    progress=false;
    // One operation per project per round. An unavailable project cannot consume
    // the whole action budget with retries while another has actionable state.
    for(const h of handles){
     if(actions.length>=maxActions)break;
     const p=h.registration,k=key(p);if(failed.has(k))continue;
     let before,operation;
     try{
      before=snapshot(h);
      const observationKey=JSON.stringify([k,before.requestId]);
      if(['new','ready','repair-ready'].includes(before.phase))operation='submit';
      else if(before.canObserve&&!observed.has(observationKey)){operation='observe';observed.add(observationKey);}
      else if(advancePhases.has(before.phase))operation='advance';
      if(!operation)continue;
      // The persisted loop owns duplicate suppression and admission. A hint
      // never names files, commands, callbacks or an authority token.
      const after=await h.loop[operation]();
      if(!sameBinding(after,p))fail('PROJECT_CHANGED');
      actions.push({tenantId:p.tenantId,projectId:p.projectId,operation,phase:after.phase,code:after.code});
      if(JSON.stringify(after)!==JSON.stringify(before))progress=true;
     }catch(error){
      const code=safeCode(error);
      failed.set(k,code);actions.push({tenantId:p.tenantId,projectId:p.projectId,operation:operation||'status',phase:'held',code});
     }
    }
   }
   return {mode:dependencies.simulated?'SIMULATED':'host-driven',actions,actionLimitReached:actions.length>=maxActions,projects:handles.map(h=>{
    const p=h.registration;let status;
    try{status=snapshot(h);}catch{status={phase:'held',code:'PROJECT_STATUS_HELD'};}
    return {tenantId:p.tenantId,projectId:p.projectId,root:p.root,status,error:failed.get(key(p))||null};
   })};
  }finally{running=false;}
 }
 async function reconcile(options){if(activeRun)fail('COORDINATOR_BUSY');return pass(options);}
 // An in-process, finite event pump. A timeout triggers read/observe reconciliation
 // of the same durable requests, never replacement submission. No OS schedule.
 async function run({events=null,intervalMs=1000,maxPasses=16,signal=null}={}){
  if(activeRun||running)fail('COORDINATOR_BUSY');if(closed)fail('COORDINATOR_CLOSED');
  if(!Number.isInteger(intervalMs)||intervalMs<10||intervalMs>30000||!Number.isInteger(maxPasses)||maxPasses<1||maxPasses>64||events!==null&&typeof events?.[Symbol.asyncIterator]!=='function'||signal!==null&&!(signal instanceof AbortSignal))fail('EVENT_SOURCE');
  activeRun=true;const passes=[];let iterator,pending=null,event,ended,result;
  const finish=state=>(result={state,passes,eventSource:'none'});
  try{
   try{iterator=events?.[Symbol.asyncIterator]();ended=!iterator;}
   catch{return finish('event-source-held');}
   while(passes.length<maxPasses&&!signal?.aborted){
    let report;
    try{report=await pass(event===undefined?{}:{event});}
    catch(error){if(error.code!=='EVENT_BINDING')throw error;report={eventRejected:'EVENT_BINDING',projects:[],actions:[]};}
    passes.push(report);event=undefined;
    if(report.projects.length&&report.projects.every(p=>p.status.phase==='done'))return finish('terminal');
    if(report.projects.length&&report.projects.every(p=>p.error||p.status.phase==='done'||p.status.phase==='held'&&!p.status.canObserve))return finish('held');
    if(passes.length>=maxPasses)break;
    if(!ended&&!pending)pending=Promise.resolve().then(()=>iterator.next()).then(value=>({kind:'event',value}),()=>({kind:'source-error'}));
    let timer,onAbort;
    try{
     const abort=signal?new Promise(resolve=>{onAbort=()=>resolve({kind:'abort'});signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();}):null;
     const wake=await Promise.race([...(pending?[pending]:[]),...(abort?[abort]:[]),new Promise(resolve=>{timer=setTimeout(()=>resolve({kind:'timer'}),intervalMs);})]);
     if(wake.kind==='event'){pending=null;if(wake.value.done)ended=true;else event=wake.value.value;}
     if(wake.kind==='source-error')return finish('event-source-held');
    }finally{clearTimeout(timer);if(onAbort)signal.removeEventListener('abort',onAbort);}
   }
   return finish(signal?.aborted?'stopped':'bounded');
  }finally{
   if(iterator){
    let timer;
    try{
     const closure=typeof iterator.return==='function'?await Promise.race([Promise.resolve().then(()=>iterator.return()).then(()=>true,()=>false),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),1000);})]):false;
     if(result)result.eventSource=closure?'closed':'close-unconfirmed';
    }finally{clearTimeout(timer);}
   }
   activeRun=false;
  }
 }
 return {reconcile,run,async close(){if(running||activeRun)fail('COORDINATOR_BUSY');if(!closed){closed=true;const results=await Promise.allSettled(handles.filter(h=>h.loop).map(h=>h.loop.close()));if(results.some(r=>r.status==='rejected'))fail('COORDINATOR_CLOSE_HELD');}}};
}
