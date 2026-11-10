// Pure bounded S7-J oracle/scheduler. No imports from the implementation under test.
export const MODEL_VERSION='relay-model/1';
export const PRNG_VERSION='xorshift32/1';
export const MODEL_SCOPE=Object.freeze({covered:['ledger reservation/START/delivery/expiry/settlement','state build/result/review/verdict replay','journal export crashes/restart/rollback/pause','F3 fixture PASS/BLOCKED/CHANGES_REQUESTED cycles','all exposed prepared-state checkpoint kinds across representative phases','attended artifact/policy/capability binding refusal','monotonic restart/sleep/skew STOP projection and uncertain settlement refusal','mid-run observation/policy revocation, actor replacement and retained task holds'],pending:['exhaustive phase/crash interleavings and every low-level write failure','native restore/isolation and power-loss qualification','real actor/provider cancellation and measured billing']});
export const REGRESSION_SEEDS=Object.freeze([1,7,42,20261012]);
export function random(seed){if(!Number.isInteger(seed)||seed<0||seed>0xffffffff)throw Error('MODEL_SEED');let x=seed||0x9e3779b9;return()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return x>>>0;};}
const corpus=random(0x20261012);
export const BOUNDED_SEEDS=Object.freeze(Array.from({length:4},()=>corpus()));
export function schedule(seed,domain,count=80){
 if(!['account','phase'].includes(domain)||!Number.isInteger(count)||count<1||count>200)throw Error('MODEL_BOUND');
 const rng=random(seed),events=[];
 if(domain==='account')events.push({kind:'start',i:0,utc:1},{kind:'reserve',i:0},{kind:'reserve',i:0},{kind:'reserve',i:0,changed:true},{kind:'unknown',i:0},{kind:'expire',utc:1100},{kind:'settle',i:0,proof:'local'},{kind:'replacement',i:0},{kind:'reserve',i:1},{kind:'start',i:1,utc:10},{kind:'start',i:1,utc:11},{kind:'start',i:1,utc:11,stale:true},{kind:'reserve',i:2},{kind:'restart'});
 else events.push({kind:'consume'},{kind:'result'});
 while(events.length<count){if(domain==='account'){const kind=['reserve','start','unknown','expire','settle','restart'][rng()%6];events.push({kind,i:rng()%3,utc:[-10,10,999,1000,1999,2000,10000][rng()%7],changed:kind==='reserve'&&rng()%5===0,stale:kind==='start'&&rng()%4===0,proof:['local','finance','full'][rng()%3]});}else{events.push({kind:['start','result','review','consume','restart'][rng()%5],bad:['','candidate','actor','generation'][rng()%4]});}}
 return events.slice(0,count);
}
export function initialAccount(){return {claims:{}};}
const cap=i=>[10,20,31][i];
export function accountStep(previous,event){
 const state=structuredClone(previous),rows=Object.values(state.claims),r=state.claims[event.i];let accepted=true;
 const reject=()=>{accepted=false;};
 if(event.kind==='restart'){}
 else if(event.kind==='reserve'){
  if(r){if(Boolean(event.changed)!==r.changed)reject();}
  else if(rows.filter(x=>x.capacity).length>=2||rows.reduce((n,x)=>n+(x.financial?x.cap:x.charged??x.cap),0)+cap(event.i)>30)reject();
  else state.claims[event.i]={i:event.i,changed:Boolean(event.changed),cap:cap(event.i),status:'pending',capacity:1,task:1,financial:1,charged:null,run:false,delivery:'unsent',settled:null};
 }else if(event.kind==='replacement'){if(!r?.task)throw Error('MODEL_REPLACEMENT_PRECONDITION');reject();}
 else if(event.kind==='expire'){
  for(const x of rows){if(x.status==='pending'&&event.utc>=1000){if(x.delivery==='unsent')Object.assign(x,{status:'expired',capacity:0,task:0,financial:0,charged:0});else x.status='unknown';}else if(x.status==='running'&&event.utc>=2000)x.status='unknown';}
 }else if(!r)reject();
 else if(event.kind==='start'){
  if(event.stale)reject();else if(r.run){}else if(r.status!=='pending'||event.utc<0||event.utc>=1000)reject();else Object.assign(r,{status:'running',run:true,delivery:'observed'});
 }else if(event.kind==='unknown'){
  if(!['pending','running','unknown'].includes(r.status))reject();else r.delivery='unknown';
 }else if(event.kind==='settle'){
  const minutes=event.proof==='finance'?50:3;
  if(event.proof!=='local'&&r.settled!==null&&r.settled!==minutes)reject();
  else {r.capacity=0;if(event.proof==='full')r.task=0;if(event.proof!=='local'){r.financial=0;r.charged=minutes;r.settled=minutes;}else r.charged??=r.cap;r.status=r.task?'unknown':'complete';}
 }else throw Error('MODEL_EVENT');
 return {accepted,state:accepted?state:previous};
}
export function accountView(s){const rows=Object.values(s.claims).sort((a,b)=>a.i-b.i);return {claims:rows.map(r=>[r.i,r.status,r.capacity,r.task,r.financial,r.charged,r.run,r.delivery]),runs:rows.filter(r=>r.run).length,used:rows.reduce((n,r)=>n+(r.financial?r.cap:r.charged??r.cap),0),nextDay:rows.reduce((n,r)=>n+(r.financial?r.cap:0),0)};}
export function initialPhase(){return {stage:'ready',applied:[],review:false,reviewed:false};}
export function phaseStep(previous,e){const s=structuredClone(previous);let accepted=true;if(e.kind==='restart')return {accepted,state:s};if(s.applied.includes(e.kind))accepted=!e.bad;else if(e.bad)accepted=false;else if(e.kind==='start'){accepted=s.stage==='ready';if(accepted)s.stage='active';}else if(e.kind==='result'){accepted=s.stage==='active';if(accepted)s.stage='review';}else if(e.kind==='review'){accepted=s.stage==='review'&&!s.review;if(accepted)s.review=true;}else if(e.kind==='consume'){accepted=s.stage==='review'&&s.review&&!s.reviewed;if(accepted)s.reviewed=true;}else throw Error('MODEL_EVENT');if(accepted&&!s.applied.includes(e.kind))s.applied.push(e.kind);return {accepted,state:accepted?s:previous};}
export function phaseView(s){return {stage:s.stage,operations:s.applied.length,review:s.review,reviewed:s.reviewed,merged:false};}
export async function compareSchedule({seed,domain,events=domain==='journal'?journalSchedule(seed):schedule(seed,domain),coreVersion,step}){
 if(!Array.isArray(events)||events.length<1||events.length>200)throw Error('MODEL_BOUND');
 if(!['account','phase','journal'].includes(domain))throw Error('MODEL_DOMAIN');
 const reducer=domain==='account'?accountStep:domain==='phase'?phaseStep:journalStep,view=domain==='account'?accountView:domain==='phase'?phaseView:journalView;let state=domain==='account'?initialAccount():domain==='phase'?initialPhase():initialJournal();
 const record={schema:MODEL_VERSION,prng:PRNG_VERSION,coreVersion,scope:MODEL_SCOPE,seed,domain,eventCount:events.length,events,counterexample:'unreduced'};
 for(let index=0;index<events.length;index++){const expected=reducer(state,events[index]),actual=await step(events[index]);const want={accepted:expected.accepted,view:view(expected.state)};if(JSON.stringify(actual)!==JSON.stringify(want)){const replay=Buffer.from(JSON.stringify({schema:MODEL_VERSION,prng:PRNG_VERSION,coreVersion,seed,domain,events})).toString('base64');throw Object.assign(Error(JSON.stringify({...record,failureCheckpoint:index,expected:want,actual,replay:`$env:VPR_MODEL_REPLAY='${replay}'; node --test scripts/tests/handoff-model.test.mjs`})),{counterexample:record});}state=expected.state;}
 return {...record,final:view(state)};
}

export function journalSchedule(seed){const rng=random(seed),fault=['before-export','after-intent','after-temp','after-link','after-export'][rng()%5];return [{kind:'publish'},{kind:'stage'},{kind:'stage'},{kind:'publish',fault},{kind:'restart'},{kind:'publish'},{kind:'rollback'},{kind:'stale-epoch'},...Array.from({length:4},()=>({kind:['stage','publish','restart'][rng()%3]})),{kind:'pause'},{kind:'stage'},{kind:'publish'}];}
export function initialJournal(){return {staged:false,saved:false,paused:false};}
export function journalStep(previous,e){const s={...previous};let accepted=true;if(e.kind==='pause')s.paused=true;else if(['rollback','stale-epoch'].includes(e.kind))accepted=false;else if(e.kind==='restart'){}else if(s.paused)accepted=false;else if(e.kind==='stage')s.staged=true;else if(e.kind==='publish'){if(!s.staged||e.fault)accepted=false;else s.saved=true;}else throw Error('MODEL_EVENT');return {accepted,state:s};}
export function journalView(s){return {messages:s.staged?1:0,runs:0,saved:s.saved,paused:s.paused};}

// Finite orthogonal phase cases: cover verdict alternatives and distinct durable
// write boundaries without multiplying every phase by every fault permutation.
export const PHASE_SCENARIOS=Object.freeze([
 {verdict:'PASS',outcome:'reviewed',reviewed:true,faults:['after-attended-intent','after-state','after-finalize','after-state']},
 {verdict:'BLOCKED',outcome:'blocked',reviewed:false,faults:['after-intent','after-finalize','after-state','before-attended-finalize']},
 {verdict:'CHANGES_REQUESTED',outcome:'repair-held',reviewed:false,faults:['after-state','after-attended-intent','before-attended-finalize','after-finalize']}
]);
