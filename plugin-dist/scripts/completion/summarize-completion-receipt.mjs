#!/usr/bin/env node
import {validateReceipt} from './validate-completion-receipt.mjs';
console.log('Receipt consistency summary');
function parse(argv){const out={};for(let i=0;i<argv.length;i++){const k=argv[i];if(!['--root','--receipt','--base','--show-notes'].includes(k)||Object.hasOwn(out,k))throw Error();if(k==='--show-notes'){out[k]=true;continue;}const v=argv[++i];if(!v||v.startsWith('--'))throw Error();out[k]=v;}if(!out['--receipt'])throw Error();return out;}
function notes(r){
  const withheld=[];for(const v of r.verification_records){withheld.push(v.command);for(const token of v.command.match(/"[^"]*"|'[^']*'|\S+/g)||[]){const value=token.includes('=')?token.slice(token.indexOf('=')+1):token;if(!value.startsWith('-'))withheld.push(value.replace(/^['"]|['"]$/g,''));}}
  const clean=value=>{let s=value;for(const token of withheld.filter(Boolean).sort((a,b)=>b.length-a.length))s=s.split(token).join('[withheld]');return s.replace(/\b(?:sk-ant-|sk-|gh[pousr]_|github_pat_|sb_secret_)[A-Za-z0-9_-]+/g,'[withheld]').replace(/\b(?:password|secret|token|credential|api[_-]?key)\s*[:=]\s*\S+/gi,'[withheld]').replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/\S+/gi,'[withheld]').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,240);};
  console.log("Redaction of notes is best effort and is not a confidentiality guarantee. These notes enter the receiving agent's transcript.");
  [r.scope_description,...r.known_gaps,...r.acceptance_criteria.flatMap(c=>[c.expected_behavior,...(c.gap?[c.gap]:[])])].slice(0,30).forEach((s,i)=>console.log(`note${i+1}: ${clean(s)}`));
}
try{
  const args=parse(process.argv.slice(2)),v=validateReceipt(args['--root']||process.cwd(),args['--receipt'],{base:args['--base']||null});
  if(!v.valid){console.log('Receipt consistency: NOT VALIDATED');console.log(`Inspection: ${v.inspection.state==='CLEAN'?'CLEAN within supported inspection only':v.inspection.state}`);console.log(v.code==='MANIFEST_INVALID'?'Manifest failed typed consistency checks; authored diagnostics withheld.':'Guarded inspection refused or unavailable; details withheld.');process.exitCode=1;}
  else{
    const r=v.receipt;console.log('Receipt consistency: PASSED (internally consistent manifest)');console.log(`Source: ${r.source_commit_sha}; environment: ${r.environment} (self-declared)`);
    r.verification_records.forEach((c,i)=>console.log(`check${i+1}: agent-reported (operator_recorded), not re-run; command details withheld; exit${c.exit_code}; ${c.checks_passed}/${c.checks_total}`));
    r.acceptance_criteria.forEach((c,i)=>console.log(`criterion${i+1}: required=${c.required}; status=${c.status}; gap recorded=${c.gap!==null}`));
    r.verification_records.forEach((c,i)=>console.log(`evidence${i+1}: sha256=${c.evidence.sha256}; authored path withheld`));
    console.log('Inspection: CLEAN within the supported consistency contract');console.log(`Ignored, not attested: ${v.inspection.ignored} entries`);console.log(`Known gap records: ${r.known_gaps.length}`);
    if(v.inspection.comparison){console.log(`Base comparison: ${v.inspection.comparison.files} files; deleted test paths: ${v.inspection.comparison.deletedTests}`);if(v.inspection.comparison.deletedTests)process.exitCode=1;}
    if(args['--show-notes'])notes(r);
    console.log('Re-run independently: none recorded; this summary reruns nothing');console.log('Not verified: ignored build inputs; actual check execution; behavior/test weakening; native/CI outcomes');console.log(`CONSISTENT at ${r.source_commit_sha}; delivery readiness not established`);
  }
}catch{console.error('USAGE: explicit receipt and supported options required; argument details withheld.');process.exitCode=2;}
