// R0 guarded inspection. No repository commands execute before nonexecuting
// config qualification. No receipt exemptions, recursive submodule commands or
// configuration repair. Equal-rights concurrent writers are not sandboxed.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,readdirSync,existsSync,realpathSync} from 'node:fs';
import {join,resolve,dirname,isAbsolute,parse,relative} from 'node:path';
// Completion tools are copied as a flat tools directory. Keep this directory
// identity gate self-contained there; preserve S5's no-ancestor-link policy.
export function inspectRoot(input){
  try{
    if(typeof input!=='string'||!isAbsolute(input)||input.includes('\0')||input!==input.trim()||input.split(process.platform==='win32'?/[\\/]/:/\//).includes('..'))return {reason:'UNSUPPORTED_ROOT'};
    if(process.platform==='win32'&&(!/^[A-Za-z]:[\\/]/.test(input)||input.split(/[\\/]/).some(x=>/[. ]$/.test(x))))return {reason:'UNSUPPORTED_ROOT'};
    const full=resolve(input),volume=parse(full).root;let cursor=volume;
    for(const part of full.slice(volume.length).split(process.platform==='win32'?/[\\/]/:/\//).filter(Boolean)){cursor=join(cursor,part);const s=lstatSync(cursor);if(s.isSymbolicLink()||!s.isDirectory())return {reason:'UNSUPPORTED_ROOT'};}
    return {canonical:realpathSync.native(full)};
  }catch{return {reason:'UNSUPPORTED_ROOT'};}
}
const nil=process.platform==='win32'?'NUL':'/dev/null';
const defaultExecutable=process.platform==='win32'?'C:/Program Files/Git/cmd/git.exe':'/usr/bin/git';
const sha=/^[a-f0-9]{40}$/;
const deny=(state='UNVERIFIED',code='INSPECTION_UNAVAILABLE')=>{throw Object.assign(new Error(code),{state,code});};
const digest=b=>createHash('sha256').update(b).digest('hex');
function regular(path,max=1024*1024){const a=lstatSync(path);if(!a.isFile()||a.isSymbolicLink()||a.nlink!==1||a.size>max)deny();const b=readFileSync(path),z=lstatSync(path);if(b.length>max||a.dev!==z.dev||a.ino!==z.ino||a.size!==z.size||a.mtimeMs!==z.mtimeMs)deny();return b;}
function text(b){return new TextDecoder('utf-8',{fatal:true}).decode(b);}
function nul(b){const t=text(b);if(!t)return [];if(!t.endsWith('\0'))deny();return t.slice(0,-1).split('\0');}
function safePath(p){if(!p||isAbsolute(p)||p.includes('\\')||p.split('/').some(x=>!x||x==='.'||x==='..')||p.includes('\0'))deny();return p;}
function environment(){const e=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^GIT_|^GCM_|^SSH_|^LD_|^DYLD_/i.test(k)));return {...e,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_SYSTEM:nil,GIT_CONFIG_GLOBAL:nil,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_PAGER:'cat',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',LC_ALL:'C'};}
function context(input,trustedGitExecutable){
  const r=inspectRoot(resolve(input));if(r.reason)deny();const root=r.canonical;
  const gitEntry=join(root,'.git');let gd=gitEntry,common=gitEntry;const entry=lstatSync(gitEntry);
  const anchors=new Map();const anchor=(p,decode=true,max=1024*1024)=>{const b=regular(p,max);anchors.set(p,{hash:digest(b),max});return decode?text(b):b;};
  if(entry.isSymbolicLink())deny();
  if(entry.isFile()){const m=/^gitdir: ([^\r\n]+)\r?\n?$/.exec(anchor(gitEntry));if(!m)deny();gd=resolve(root,m[1]);if(inspectRoot(gd).reason)deny();const c=anchor(join(gd,'commondir')).trim();common=resolve(gd,c);}
  else if(!entry.isDirectory())deny();
  if(inspectRoot(gd).reason||inspectRoot(common).reason)deny();
  for(const base of new Set([gd,common]))for(const name of ['objects/info/alternates','objects/info/http-alternates','shallow','info/grafts'])if(existsSync(join(base,name)))deny();
  // Explicit trusted setup input only: never project configuration or PATH.
  const executable=trustedGitExecutable===undefined?defaultExecutable:trustedGitExecutable;
  if(typeof executable!=='string'||!isAbsolute(executable)||executable.includes('\0'))deny();
  const exec=realpathSync(executable);
  const inside=(base,path)=>{const r=relative(base,path);return r===''||(!r.startsWith('..'+(process.platform==='win32'?'\\':'/'))&&r!=='..'&&!isAbsolute(r));};
  if([root,gd,common].some(base=>inside(base,exec)||inside(base,resolve(executable)))||!lstatSync(exec).isFile())deny();
  const env=environment(),deadline=performance.now()+15000;
  const checkDeadline=()=>{if(performance.now()>=deadline)deny();};
  const raw=(args,inputBytes)=>{checkDeadline();const out=spawnSync(exec,args,{cwd:root,env,input:inputBytes,windowsHide:true,timeout:Math.max(1,Math.floor(deadline-performance.now())),maxBuffer:8*1024*1024});if(out.error||out.signal||![0,1].includes(out.status))deny();return out;};
  // Index snapshots have their own 64MiB ceiling; configuration remains capped at 1MiB.
  for(const path of [join(gd,'HEAD'),join(gd,'index'),join(common,'info','exclude'),join(common,'info','attributes')])if(existsSync(path))anchor(path,false,path===join(gd,'index')?64*1024*1024:1024*1024);
  if(inspectRoot(join(common,'objects')).reason)deny();
  const configs=[join(common,'config')];if(existsSync(join(gd,'config.worktree')))configs.push(join(gd,'config.worktree'));
  for(const path of configs){anchor(path);const result=raw(['config','--no-includes','--null','--file',path,'--list']);if(result.status!==0)deny();for(const row of nul(result.stdout)){const i=row.indexOf('\n'),key=(i<0?row:row.slice(0,i)).toLowerCase(),value=i<0?'':row.slice(i+1);
      if(/^include(if)?\.|^filter\.|^diff\..*\.textconv$|^diff\.external$|^core\.(hookspath|worktree|sshcommand)$|^extensions\.(?!worktreeconfig$)/.test(key))deny('UNVERIFIED','UNSAFE_CONFIGURATION');
      if(key==='core.fsmonitor'&&!['false','0','no','off'].includes(value.toLowerCase()))deny('UNVERIFIED','UNSAFE_CONFIGURATION');
      if(/^core\.sparsecheckout(cone)?$|^index\.sparse$/.test(key)&&!['false','0','no','off'].includes(value.toLowerCase()))deny('UNVERIFIED','UNSUPPORTED_INDEX');
    }}
  const rootId=lstatSync(root),gitId=lstatSync(gd),commonId=lstatSync(common);
  function stable(){if(inspectRoot(root).reason||inspectRoot(gd).reason||inspectRoot(common).reason)deny();for(const [p,s] of [[root,rootId],[gd,gitId],[common,commonId]]){const n=lstatSync(p);if(s.dev!==n.dev||s.ino!==n.ino)deny();}for(const[p,a]of anchors)if(digest(regular(p,a.max))!==a.hash)deny('UNVERIFIED','INSPECTION_CHANGED');}
  const prefix=['--no-pager','--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath='+nil,'-c','core.untrackedCache=false','-c','core.excludesFile='+nil,'-c','core.attributesFile='+nil,'-c','diff.external=','-c','status.submoduleSummary=false','--git-dir='+gd,'--work-tree='+root];
  function git(args,inputBytes,allowOne=false){stable();const r=raw([...prefix,...args],inputBytes);if(r.status!==0&&!(allowOne&&r.status===1))deny();stable();return r;}
  return {root,gd,common,git,stable,anchor,checkDeadline};
}
export function inspectRepository(input,{maxEntries=50000,base=null,candidateProof=null,trustedGitExecutable}={}){
  try{
    if(!Number.isInteger(maxEntries)||maxEntries<1||maxEntries>50000)deny();
    const c=context(input,trustedGitExecutable),{root,git}=c;
    const head=text(git(['rev-parse','--verify','HEAD']).stdout).trim();if(!sha.test(head))deny();
    const top=text(git(['rev-parse','--show-toplevel']).stdout).trim();if(realpathSync(top)!==root)deny('INCOMPLETE','ROOT_NOT_TOP_LEVEL');
    const indexRows=nul(git(['ls-files','--stage','-z']).stdout),tracked=new Map();
    if(indexRows.length>maxEntries)deny('UNVERIFIED','TRAVERSAL_LIMIT');
    for(const row of indexRows){const m=/^(\d{6}) ([a-f0-9]{40}) ([0-3])\t([\s\S]+)$/.exec(row);if(!m)deny();const p=safePath(m[4]);if(m[1]==='160000'||m[1]==='040000')deny('UNVERIFIED','UNSUPPORTED_INDEX');if(!['100644','100755'].includes(m[1]))deny('UNVERIFIED','UNSUPPORTED_ENTRY');if(m[3]!=='0')deny('INCOMPLETE','UNMERGED_INDEX');tracked.set(p,{blob:m[2],mode:m[1]});}
    for(const row of nul(git(['ls-files','-v','-z']).stdout)){if(!/^H /.test(row))deny('UNVERIFIED','UNSUPPORTED_INDEX');safePath(row.slice(2));}
    // Exhaustive traversal includes ignored directories. Secret leaf CONTENT is
    // never read here. Only qualified ignore rules are read as policy.
    let count=0;const leaves=[],ignores=[],snapshots=[];
    function walk(dir,rel=''){
      c.checkDeadline();if(++count>maxEntries)deny('UNVERIFIED','TRAVERSAL_LIMIT');c.stable();const st=lstatSync(dir);snapshots.push([dir,st.dev,st.ino,st.mtimeMs]);
      const names=readdirSync(dir);const aliases=new Set();
      for(const name of names){if(!rel&&name==='.git')continue;const folded=name.toLowerCase();if(aliases.has(folded)||folded==='.gitignore'&&name!=='.gitignore'||folded==='.git'&&name!=='.git')deny('UNVERIFIED','AMBIGUOUS_PATH');aliases.add(folded);if(++count>maxEntries)deny('UNVERIFIED','TRAVERSAL_LIMIT');
        const path=join(dir,name),p=rel?rel+'/'+name:name,a=lstatSync(path);if(a.isSymbolicLink())deny('UNVERIFIED','UNSUPPORTED_ENTRY');if(a.isDirectory()){if(name==='.git')deny('UNVERIFIED','NESTED_REPOSITORY');walk(path,p);}else if(a.isFile()){if(a.nlink!==1)deny('UNVERIFIED','UNSUPPORTED_ENTRY');leaves.push(p);snapshots.push([path,a.dev,a.ino,a.mtimeMs,a.size,a.mode]);if(name==='.gitignore')ignores.push(p);}else deny();
      }
    }walk(root);
    for(const p of ignores){if(!tracked.has(p))deny('INCOMPLETE','UNCOMMITTED_IGNORE');const current=text(regular(join(root,p))),committed=text(git(['show',head+':'+p]).stdout);if(current.replace(/\r\n/g,'\n')!==committed.replace(/\r\n/g,'\n'))deny('INCOMPLETE','IGNORE_CHANGED');}
    for(const p of tracked.keys())if(p.split('/').at(-1)==='.gitignore'&&!ignores.includes(p))deny('INCOMPLETE','IGNORE_CHANGED');
    // NUL porcelain records are not rendered; any tracked change is incomplete.
    for(const mode of [[],['--cached']]){const rows=nul(git(['diff',...mode,'--no-ext-diff','--no-textconv','--no-renames','--name-only','-z','--ignore-submodules=none','--']).stdout);if(rows.length)deny('INCOMPLETE','TRACKED_CHANGES');}
    // Git's index stat cache is not content evidence. Verify every supported
    // tracked file without writing objects or refreshing the index. All files
    // share one guarded Git batch, preserving built-in text/CRLF/ident conversion
    // even if a raw blob matches. External filters were already refused.
    let totalBytes=0;const converted=[];
    for(const [p,indexEntry] of tracked){
      c.checkDeadline();
      if(process.platform!=='win32'){
        let mode;try{mode=lstatSync(join(root,p)).mode;}catch(e){if(e.code==='ENOENT')deny('INCOMPLETE','TRACKED_CHANGES');throw e;}
        if(((mode&0o100)!==0)!==(indexEntry.mode==='100755'))deny('INCOMPLETE','TRACKED_CHANGES');
      }
      if(p.split('/').some(s=>/^\.env(?:\.|$)|^\.(?:aws|ssh|npmrc|netrc)$|^credentials$|^id_(?:rsa|ed25519)$|\.(?:pem|key)$/i.test(s)))deny('UNVERIFIED','SENSITIVE_TRACKED_INPUT');
      let bytes;try{bytes=regular(join(root,p),8*1024*1024);}catch(e){if(e.code==='ENOENT')deny('INCOMPLETE','TRACKED_CHANGES');throw e;}
      totalBytes+=bytes.length;if(totalBytes>64*1024*1024)deny('UNVERIFIED','CONTENT_LIMIT');
      converted.push({path:p,expected:indexEntry.blob,rawHash:digest(bytes)});
    }
    if(converted.length){
      // C-quoted UTF8 bytes preserve newlines, quotes and Unicode without shell use.
      const quoted=p=>'"'+Array.from(Buffer.from(p),b=>'\\'+b.toString(8).padStart(3,'0')).join('')+'"';
      const output=text(git(['hash-object','--stdin-paths'],Buffer.from(converted.map(r=>quoted(r.path)).join('\n')+'\n')).stdout);
      const hashes=output.trimEnd().split('\n');if(hashes.length!==converted.length)deny();
      for(let i=0;i<converted.length;i++){c.checkDeadline();const row=converted[i];if(!sha.test(hashes[i]))deny();if(hashes[i]!==row.expected)deny('INCOMPLETE','TRACKED_CHANGES');if(digest(regular(join(root,row.path),8*1024*1024))!==row.rawHash)deny('UNVERIFIED','INSPECTION_CHANGED');}
    }
    let ignored=0,untracked=0;
    const others=leaves.filter(p=>!tracked.has(p));
    if(others.length){const res=git(['check-ignore','--no-index','-v','-z','--stdin'],Buffer.from(others.join('\0')+'\0'),true),fields=nul(res.stdout);if(fields.length%4)deny();const accepted=new Set();for(let i=0;i<fields.length;i+=4){const[source,line,pattern,path]=fields.slice(i,i+4);if(!/^\d+$/.test(line)||!others.includes(path))deny();if(ignores.includes(source)&&!pattern.startsWith('!'))accepted.add(path);}ignored=accepted.size;untracked=others.length-ignored;}
    if(untracked)deny('INCOMPLETE','UNTRACKED_CONTENT');
    let proof=null;
    if(candidateProof!==null){
      if(!candidateProof||Object.keys(candidateProof).length!==2||!sha.test(candidateProof.input)||!sha.test(candidateProof.candidate))deny();
      if(head!==candidateProof.candidate)deny('INCOMPLETE','CANDIDATE_CHANGED');
      const ancestry=text(git(['rev-list','--parents','-n','1',head,'--']).stdout).trim().split(' ');
      if(ancestry.length!==2||ancestry[0]!==head||ancestry[1]!==candidateProof.input)deny('INCOMPLETE','CANDIDATE_PARENT');
      const changed=nul(git(['diff','--no-ext-diff','--no-textconv','--no-renames','--ignore-submodules=none','--name-only','-z',candidateProof.input,head,'--']).stdout).map(safePath).sort();
      proof={parent:ancestry[1],changedPaths:changed};
    }
    let comparison=null;
    if(base!==null){if(typeof base!=='string'||base.length>200)deny();const ref=text(git(['rev-parse','--verify','--end-of-options',base+'^{commit}']).stdout).trim();if(!sha.test(ref))deny();const rows=nul(git(['diff','--no-ext-diff','--no-textconv','--no-renames','--ignore-submodules=none','--name-status','-z',ref+'...'+head,'--']).stdout);if(rows.length%2)deny();comparison={files:rows.length/2,deletedTests:0};for(let i=0;i<rows.length;i+=2){if(!/^[AMDTUXB]$/.test(rows[i]))deny();safePath(rows[i+1]);if(rows[i]==='D'&&/(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\./i.test(rows[i+1]))comparison.deletedTests++;}}
    c.stable();for(const[p,dev,ino,mtime,size,mode]of snapshots){const s=lstatSync(p);if(s.dev!==dev||s.ino!==ino||s.mtimeMs!==mtime||size!==undefined&&s.size!==size||mode!==undefined&&s.mode!==mode)deny('UNVERIFIED','INSPECTION_CHANGED');}
    if(text(git(['rev-parse','HEAD']).stdout).trim()!==head)deny('UNVERIFIED','INSPECTION_CHANGED');
    return {state:'CLEAN',code:'SUPPORTED_CONSISTENCY',head,ignored,comparison,...(proof||{}),limits:'Ignored inputs and actual execution are not attested; concurrent equal-rights writers are not isolated.'};
  }catch(e){return {state:['INCOMPLETE','UNVERIFIED'].includes(e.state)?e.state:'UNVERIFIED',code:/^[A-Z_]+$/.test(e.code||'')?e.code:'INSPECTION_UNAVAILABLE'};}
}

// Exact-object evidence only; callers must still bind paths, actors and authority.
export function inspectCandidate(root,{input,candidate}={}) {
  if(typeof input!=='string'||typeof candidate!=='string'||!sha.test(input)||!sha.test(candidate))return {state:'UNVERIFIED',code:'CANDIDATE_IDENTITY'};
  return inspectRepository(root,{candidateProof:{input,candidate}});
}
