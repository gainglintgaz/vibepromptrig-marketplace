#!/usr/bin/env node
// Internal consistency only. No receipt command executes and no test execution,
// reviewer identity or delivery authorization is inferred from this manifest.
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {inspectRepository,inspectRoot} from './safe-inspection.mjs';
const invalid=()=>{throw new Error('MANIFEST_INVALID');};
const str=v=>typeof v==='string'&&v.trim().length>0&&v.length<=4096;
const count=v=>Number.isSafeInteger(v)&&v>=0&&v<=1000000000;
const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const digest=b=>createHash('sha256').update(b).digest('hex');
function shape(v,required,optional=[]){if(!v||typeof v!=='object'||Array.isArray(v)||required.some(k=>!Object.hasOwn(v,k))||Object.keys(v).some(k=>![...required,...optional].includes(k)))invalid();}
function list(v,nonempty=true){if(!Array.isArray(v)||v.length>100||nonempty&&!v.length)invalid();return v;}
function time(v){if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v)||!Number.isFinite(Date.parse(v)))invalid();return Date.parse(v);}
// Reject Win32 aliases before filesystem inspection or reads: ADS and stripped suffixes
// can otherwise bypass the sensitive-name checks. These are literal names on POSIX.
function safeRead(root,path,max){
  if(typeof path!=='string'||path.length>1024||isAbsolute(path)||path.includes('\\')||path.split('/').some(p=>!p||p==='.'||p==='..'||process.platform==='win32'&&(p.includes(':')||/[. ]$/.test(p))||/^\.env(?:\.|$)|^credentials$|^id_(rsa|ed25519)$|^\.(?:aws|ssh|git|npmrc|netrc)$|\.(?:pem|key)$/i.test(p)))invalid();
  const full=join(root,path);if(inspectRoot(dirname(full)).reason)invalid();const a=lstatSync(full);if(!a.isFile()||a.isSymbolicLink()||a.nlink!==1||a.size>max)invalid();const b=readFileSync(full),z=lstatSync(full);if(b.length>max||a.ino!==z.ino||a.dev!==z.dev||a.mtimeMs!==z.mtimeMs||a.size!==z.size)invalid();return b;
}
export function validateReceipt(root,receiptPath,{expectedSha=null,base=null}={}){
  // The guard is the FIRST repository-dependent operation. No legacy validator
  // subprocess can bypass it; all former Git calls are replaced by its HEAD.
  const inspection=inspectRepository(root,{base});
  if(inspection.state!=='CLEAN')return {valid:false,inspection,code:'INSPECTION_REFUSED'};
  try{
    root=resolve(root);const bytes=safeRead(root,receiptPath,65536),raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(raw.charCodeAt(0)===0xfeff)invalid();const r=JSON.parse(raw);
    shape(r,['schema_version','scope_id','scope_description','source_commit_sha','environment','work_author_id','created_at','expires_at','acceptance_criteria','verification_records','known_gaps'],['production_verification']);
    if(r.schema_version!==3||!sha(r.source_commit_sha)||r.source_commit_sha!==inspection.head||expectedSha!==null&&expectedSha!==r.source_commit_sha||!['scope_id','scope_description','work_author_id'].every(k=>str(r[k]))||!['local','ci','staging','production'].includes(r.environment))invalid();
    const created=time(r.created_at),expires=time(r.expires_at),now=Date.now();if(created>now+300000||expires<=now||expires<=created||expires-created>604800000)invalid();
    if(list(r.known_gaps,false).some(x=>!str(x)))invalid();
    const evidenceIds=new Set(),evidenceFiles=new Set(),snapshots=[];
    function evidence(id,e,unique=false){if(!str(id)||evidenceIds.has(id))invalid();evidenceIds.add(id);shape(e,['path','sha256']);if(typeof e.sha256!=='string'||!/^[a-f0-9]{64}$/.test(e.sha256))invalid();const b=safeRead(root,e.path,8*1024*1024);const st=lstatSync(join(root,e.path)),identity=String(st.dev)+':'+String(st.ino);if(digest(b)!==e.sha256||unique&&evidenceFiles.has(identity))invalid();evidenceFiles.add(identity);snapshots.push([e.path,e.sha256]);}
    for(const v of list(r.verification_records)){
      shape(v,['id','attestation_level','command','exit_code','commit_sha','checks_passed','checks_total','started_at','finished_at','evidence']);
      if(v.attestation_level!=='operator_recorded'||!str(v.command)||v.exit_code!==0||v.commit_sha!==r.source_commit_sha||!count(v.checks_passed)||v.checks_passed<1||v.checks_passed!==v.checks_total)invalid();
      const started=time(v.started_at),finished=time(v.finished_at);if(finished<started||finished>created+300000)invalid();evidence(v.id,v.evidence);
    }
    const ids=new Set();for(const c of list(r.acceptance_criteria)){
      shape(c,['id','expected_behavior','evidence_source','commit_sha','environment','required','status','gap','evidence_refs']);
      if(!str(c.id)||ids.has(c.id)||!str(c.expected_behavior)||!str(c.evidence_source)||c.commit_sha!==r.source_commit_sha||c.environment!==r.environment||typeof c.required!=='boolean'||!['passed','failed','not_run','mocked_only','skipped','authority_blocked'].includes(c.status)||c.required&&c.status!=='passed'||c.gap!==null&&!str(c.gap))invalid();ids.add(c.id);list(c.evidence_refs);
    }
    if(r.environment==='production'){
      const p=r.production_verification;shape(p,['status','attestation_level','deployed_commit_sha','checks_passed','checks_total','evidence_id','evidence','artifact_observation','live_invocation']);
      if(p.status!=='passed'||p.attestation_level!=='operator_recorded'||p.deployed_commit_sha!==r.source_commit_sha||!count(p.checks_passed)||p.checks_passed<1||p.checks_passed!==p.checks_total)invalid();evidence(p.evidence_id,p.evidence);
      for(const kind of ['artifact_observation','live_invocation']){const o=p[kind];shape(o,['environment','target','deployed_commit_sha','observed_at','evidence_id','evidence',...(kind==='live_invocation'?['surface','operation','result_code','outcome']:[])]);const observed=time(o.observed_at);if(o.environment!=='production'||!str(o.target)||o.deployed_commit_sha!==r.source_commit_sha||observed>now+300000||observed>created+300000||observed<created-604800000)invalid();if(kind==='live_invocation'&&(!['surface','operation','result_code'].every(k=>str(o[k]))||!['succeeded','honest_failure'].includes(o.outcome)))invalid();evidence(o.evidence_id,o.evidence,true);}
      if(p.artifact_observation.target!==p.live_invocation.target)invalid();
    }else if(Object.hasOwn(r,'production_verification'))invalid();
    for(const c of r.acceptance_criteria)for(const ref of c.evidence_refs)if(!evidenceIds.has(ref))invalid();
    const after=inspectRepository(root,{base});if(after.state!=='CLEAN'||after.head!==inspection.head||digest(safeRead(root,receiptPath,65536))!==digest(bytes))invalid();
    for(const[p,h]of snapshots)if(digest(safeRead(root,p,8*1024*1024))!==h)invalid();
    return {valid:true,inspection:after,receipt:r,code:'INTERNAL_CONSISTENCY'};
  }catch{return {valid:false,inspection,code:'MANIFEST_INVALID'};}
}
// Node runs the resolved file, so compare resolved paths: a symlinked launch path must not
// skip the checks and exit 0 as if the manifest had passed.
// An entry point that cannot be resolved (stdin "-", a vanished path) is simply not this module.
const isMain=()=>{try{return realpathSync(resolve(process.argv[1]))===realpathSync(fileURLToPath(import.meta.url));}catch{return false;}};
if(process.argv[1]&&isMain()){
  try{const args={};for(let i=2;i<process.argv.length;i+=2){const k=process.argv[i],v=process.argv[i+1];if(!['--root','--receipt','--expected-sha'].includes(k)||!v||Object.hasOwn(args,k))throw Error();args[k]=v;}if(!args['--receipt'])throw Error();const r=validateReceipt(args['--root']||process.cwd(),args['--receipt'],{expectedSha:args['--expected-sha']||null});console.log(r.valid?'PASS: manifest internal consistency; execution and delivery authority not established.':'FAIL: manifest or guarded inspection did not qualify.');process.exitCode=r.valid?0:1;}catch{console.error('USAGE: explicit root and relative receipt required; details withheld.');process.exitCode=2;}
}
