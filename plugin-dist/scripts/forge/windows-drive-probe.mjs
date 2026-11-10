// Fresh DriveInfo classification per call, without starting PowerShell per check.
// Only the executable is process-local cached; drive results are never cached.
// Compilation, integrity or native execution failure uses the original PS probe.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync,realpathSync,mkdtempSync,writeFileSync,readFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';

const SOURCE = `using System;
using System.IO;
class DriveProbe {
  static int Main(string[] args) {
    if(args.Length!=1 || args[0].Length!=3 || !Char.IsLetter(args[0][0]) || args[0][1]!=':' || args[0][2]!='\\\\') return 2;
    try { Console.Write(((int)new DriveInfo(args[0]).DriveType).ToString(System.Globalization.CultureInfo.InvariantCulture)); return 0; }
    catch { return 1; }
  }
}`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function plainAncestors(root) {
  let current=root;
  while(true){const st=lstatSync(current);if(!st.isDirectory()||st.isSymbolicLink())return false;const parent=dirname(current);if(parent===current)return true;current=parent;}
}

function compileHelper(run) {
  const parent=realpathSync.native(tmpdir());
  if(!plainAncestors(parent))throw Error('UNSAFE_PROBE_TEMP');
  const root=mkdtempSync(join(parent,'vf-drive-probe-'));
  const identity=lstatSync(root,{bigint:true});
  const source=join(root,'probe.cs'),binary=join(root,'probe.exe');
  const cleanup=()=>{
    try{
      const now=lstatSync(root,{bigint:true});
      if(now.isSymbolicLink()||now.dev!==identity.dev||now.ino!==identity.ino||!plainAncestors(root))return;
      // Exact files only; never recursively remove unexpected contents.
      for(const file of [source,binary])try{unlinkSync(file);}catch{}
      try{rmdirSync(root);}catch{}
    }catch{}
  };
  process.once('exit',cleanup);
  writeFileSync(source,SOURCE,{flag:'wx'});
  const system=process.env.SystemRoot||'C:/Windows';
  const compiler=join(system,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const built=run(compiler,['/nologo','/target:exe','/optimize+','/out:'+binary,source],{encoding:'utf8',windowsHide:true,timeout:30000});
  if(built.error||built.status!==0)throw Error('DRIVE_PROBE_COMPILE');
  const digest=hash(readFileSync(binary));
  return {path:binary,verify:()=>{
    if(!plainAncestors(root))return false;
    const now=lstatSync(root,{bigint:true}),file=lstatSync(binary);
    return now.dev===identity.dev&&now.ino===identity.ino&&file.isFile()&&!file.isSymbolicLink()&&file.nlink===1&&file.size<1024*1024&&hash(readFileSync(binary))===digest;
  }};
}

// Dependency injection is for contract tests; production uses only the defaults.
export function createWindowsDriveProbe({run=spawnSync,build=compileHelper,platform=process.platform}={}) {
  let helper=null,attempted=false;
  const legacy=drive=>run('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    `([System.IO.DriveInfo]::new('${drive}\\')).DriveType.value__`],
    {encoding:'utf8',windowsHide:true,timeout:10000});
  return drive=>{
    if(!/^[A-Za-z]:$/.test(drive))return {error:{code:'INVALID_DRIVE'},status:null,stdout:''};
    if(platform!=='win32')return legacy(drive);
    try{
      if(!attempted){attempted=true;helper=build(run);}
      if(helper&&helper.verify()){
        const result=run(helper.path,[drive+'\\'],{encoding:'utf8',windowsHide:true,timeout:10000});
        if(!result.error&&result.status===0&&/^[0-6]$/.test(result.stdout||''))return {...result,method:'native'};
        helper=null; // A denied/failed executable is not retried throughout this process.
      }
      else if(helper){helper=null;}
    }catch{helper=null; /* Fall back to a fresh classification, never a saved result. */ }
    return {...legacy(drive),method:'powershell'};
  };
}

export const probeWindowsDrive=createWindowsDriveProbe();
