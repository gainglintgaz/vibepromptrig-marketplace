#!/usr/bin/env node
// scaffold-new-project.mjs
//
// VibePromptRig project scaffolding -- Node twin of scaffold-new-project.ps1
// (cross-platform port P2, T1b). Creates a fully-loaded project under
// <home>/Projects/<Name>. node:path throughout; no literal separators. Behavior-faithful
// to the .ps1 (same files copied, same token replacement, same git init + core.hooksPath
// + initial commit so the gates fire from commit #1). Dependency-free, Node >= 18.
//
// Usage: node scaffold-new-project.mjs --name <Name> [--template vite|nextjs|empty]
//                                      [--pack <pack>] [--client-ready]
// (also accepts the PowerShell-style -Name / -Template / -Pack / -ClientReady flags)

import {
  existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync,
  copyFileSync, cpSync, chmodSync, mkdtempSync, rmSync,
} from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { buildInstallPlan, applyInstall } from './forge/context-install.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function die(msg) { console.error(msg); process.exit(1); }

function parseArgs(argv) {
  const o = { name: '', template: 'vite', pack: '', clientReady: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i].toLowerCase();
    if (a === '-name' || a === '--name') o.name = argv[++i];
    else if (a === '-template' || a === '--template') o.template = argv[++i];
    else if (a === '-pack' || a === '--pack') o.pack = argv[++i];
    else if (a === '-clientready' || a === '--client-ready' || a === '-client-ready') o.clientReady = true;
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
if (!args.name) die('scaffold: -Name is required');
if (!['vite', 'nextjs', 'empty'].includes(args.template)) die(`scaffold: invalid -Template '${args.template}'`);
if (!['', 'ai-purchase-research', 'saas', 'bookkeeping', 'travel'].includes(args.pack)) die(`scaffold: invalid -Pack '${args.pack}'`);

const Name = args.name;
const Template = args.template;
const Pack = args.pack;

import { realpathSync } from 'node:fs';
const FactoryRoot = realpathSync.native(dirname(here));
const ProjectRoot = join(homedir(), 'Projects', Name);
const TemplateDir = join(FactoryRoot, 'scripts', 'templates');
const SharedDir = join(TemplateDir, 'shared');
const CompletionDir = join(FactoryRoot, 'scripts', 'completion');

if (existsSync(ProjectRoot)) die(`Project directory already exists: ${ProjectRoot}`);
if (!existsSync(join(FactoryRoot, '.claude', 'rules-manifest.json'))) die(`Context manifest not found at: ${join(FactoryRoot, '.claude', 'rules-manifest.json')}`);
if (Pack) {
  const rules = join(TemplateDir, 'packs', Pack, 'rules');
  if (!existsSync(rules) || !statSync(rules).isDirectory()) die(`Vertical pack rules missing: ${Pack}`);
  if (!walkFiles(rules).some((file) => /\.md$/i.test(file) && readFileSync(file, 'utf8').trim())) die(`Vertical pack rules empty: ${Pack}`);
}

console.log(`\n  ${args.clientReady ? 'AI Factory' : 'VibePromptRig'} Scaffold`);
console.log(`  Project: ${Name}`);
console.log(`  Template: ${Template}`);
if (Pack) console.log(`  Vertical Pack: ${Pack}`);
if (args.clientReady) console.log(`  Mode: CLIENT-READY`);
console.log(`  Path: ${ProjectRoot}\n`);

// copy the CONTENTS of src into dst (mirrors `Copy-Item "$src\*" -Destination dst`)
function copyContents(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) cpSync(join(src, entry), join(dst, entry), { recursive: true });
}
function walkFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}
// git only RUNS hooks that are executable on POSIX; the shared pack is stored 100644, so
// the copy must be made executable or the gates silently no-op on macOS/Linux. (Windows
// ignores the bit -- guard to avoid touching mode there.)
function makeHooksExecutable(githooksDir) {
  if (process.platform === 'win32') return;
  for (const f of readdirSync(githooksDir)) {
    try { chmodSync(join(githooksDir, f), 0o755); } catch { /* ignore */ }
  }
}

mkdirSync(ProjectRoot, { recursive: true });

// template files (if not empty)
if (Template !== 'empty') {
  const templateSrc = join(TemplateDir, Template);
  if (!existsSync(templateSrc)) die(`Template not found: ${templateSrc}`);
  copyContents(templateSrc, ProjectRoot);
}

// shared files
for (const f of ['.gitignore', '.gitattributes', 'CURRENT_SPRINT.md', 'V1_FEATURE_BACKLOG.md', 'errors-fixed.json', 'golden-paths.md', '.env.example']) {
  copyFileSync(join(SharedDir, f), join(ProjectRoot, f));
}

// Completion-truth tools are project-local so every agent and CI runner executes
// the same tracked implementation from a clean clone.
copyContents(CompletionDir, join(ProjectRoot, 'tools'));
copyContents(join(SharedDir, '.github'), join(ProjectRoot, '.github'));

// tracked git hooks (the mechanical gates; wired via core.hooksPath below -> live from commit #1)
cpSync(join(SharedDir, '.githooks'), join(ProjectRoot, '.githooks'), { recursive: true });
makeHooksExecutable(join(ProjectRoot, '.githooks'));

// template-specific README
const readmeSrc = join(SharedDir, `README-${Template}.md`);
if (existsSync(readmeSrc)) copyFileSync(readmeSrc, join(ProjectRoot, 'README.md'));

// vertical pack (if specified)
if (Pack) {
  const PackSrc = join(TemplateDir, 'packs', Pack);
  if (!existsSync(PackSrc)) die(`Vertical pack not found: ${PackSrc}`);
  const PackRulesSrc = join(PackSrc, 'rules');
  if (existsSync(PackRulesSrc)) {
    const PackReferenceDir = join(ProjectRoot, 'docs', 'rules-reference', 'vertical', Pack);
    copyContents(PackRulesSrc, PackReferenceDir);
    console.log(`  Copied pack rules as references from ${Pack}`);
  }
  if (existsSync(join(PackSrc, 'intake-form.md'))) { copyFileSync(join(PackSrc, 'intake-form.md'), join(ProjectRoot, 'INTAKE_FORM.md')); console.log(`  Copied ${Pack} intake form to INTAKE_FORM.md`); }
  const ChecklistDir = join(ProjectRoot, '.claude', 'checklists');
  mkdirSync(ChecklistDir, { recursive: true });
  if (existsSync(join(PackSrc, 'hostile-architect-scenarios.md'))) { copyFileSync(join(PackSrc, 'hostile-architect-scenarios.md'), join(ChecklistDir, `ha-scenarios-${Pack}.md`)); console.log(`  Copied ${Pack} HA scenarios to .claude/checklists/`); }
  for (const gp of readdirSync(PackSrc).filter((f) => /^golden-paths-.*\.md$/.test(f))) {
    const gpContent = readFileSync(join(PackSrc, gp), 'utf8');
    const existing = existsSync(join(ProjectRoot, 'golden-paths.md')) ? readFileSync(join(ProjectRoot, 'golden-paths.md'), 'utf8') : '';
    writeFileSync(join(ProjectRoot, 'golden-paths.md'), existing + `\n\n---\n\n# Vertical Pack: ${Pack}\n\n` + gpContent);
    console.log(`  Appended ${gp} to golden-paths.md`);
  }
  const SharedBugChecklist = join(SharedDir, '.claude', 'checklists', 'bug-checklist.md');
  if (existsSync(SharedBugChecklist)) copyFileSync(SharedBugChecklist, join(ChecklistDir, 'bug-checklist.md'));
  if (Pack === 'bookkeeping') {
    const RlsTemplate = join(SharedDir, 'supabase', 'two-level-rls.sql');
    if (existsSync(RlsTemplate)) {
      const MigDir = join(ProjectRoot, 'supabase', 'migrations');
      mkdirSync(MigDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      copyFileSync(RlsTemplate, join(MigDir, `${ts}_two_level_rls.sql`));
      console.log('  Bookkeeping pack: copied two-level-rls.sql migration to supabase/migrations/');
    }
  }
}

// auto-allow permissions
const permsSrc = join(SharedDir, '.claude', 'settings.local.json');
if (existsSync(permsSrc)) {
  mkdirSync(join(ProjectRoot, '.claude'), { recursive: true });
  copyFileSync(permsSrc, join(ProjectRoot, '.claude', 'settings.local.json'));
}

// token replacement
const NameLower = Name.toLowerCase().replace(/\s+/g, '-');
const TechStack = Template === 'vite'
  ? 'Vite + React 19 + TypeScript + Tailwind 4 + shadcn/ui + Zustand + Supabase'
  : Template === 'nextjs'
    ? 'Next.js 16 (App Router) + Tailwind 4 + shadcn/ui + Supabase'
    : 'Add your tech stack here';

for (const f of walkFiles(ProjectRoot)) {
  if (!/\.(md|json|ts|tsx|html|css|template)$/i.test(f)) continue;
  let content = readFileSync(f, 'utf8');
  if (content.includes('{{')) {
    content = content
      .replace(/\{\{PROJECT_NAME\}\}/g, Name)
      .replace(/\{\{PROJECT_NAME_LOWER\}\}/g, NameLower)
      .replace(/\{\{PROJECT_PATH\}\}/g, ProjectRoot)
      .replace(/\{\{TECH_STACK\}\}/g, TechStack);
    writeFileSync(f, content);
  }
}

// Exact text substitutions preserve JSON structure and executable syntax. Stable
// lowercase runtime paths and VF contract identifiers remain unchanged.
function clientText(content, file) {
  let output = content.replaceAll('VibePromptRig AI OS', 'AI Development OS')
    .replaceAll('VibePromptRig', 'AI Factory');
  if (/\.(md|json)$/i.test(file)) output = output
    .replaceAll("the project owner's", 'Your')
    .replace(/\b[A-Z][a-z]+ is an AI Business Consultant in [^.\r\n"]+ who delivers working V1s in days, not months\./g, 'Your Chief Architect and Build Partner.')
    .split(FactoryRoot).join('{{FACTORY_PATH}}');
  return output;
}

// Sanitize template prose without deleting arbitrary spans or rewriting code tokens.
if (args.clientReady) {
  console.log('  Applying client-ready sanitization...');
  for (const f of walkFiles(ProjectRoot)) {
    if (!/\.(md|json|mjs|ps1|ts|tsx|html|css)$/i.test(f)) continue;
    const content = readFileSync(f, 'utf8');
    const neutral = clientText(content, f);
    if (neutral !== content) writeFileSync(f, neutral);
  }
  writeFileSync(join(ProjectRoot, 'HANDOFF_GUIDE.md'), HANDOFF_GUIDE());
}

// Compact context delivery is the only scaffolded native entrypoint.  Rule bodies remain
// reference material; native files contain the selected packet plus resolver instructions.
let contextResult;
if (args.clientReady) {
  // Prepare a neutral portable runtime before installation, so the canonical
  // transaction hashes and ownership ledger describe the final shipped bytes.
  const neutralRoot = mkdtempSync(join(tmpdir(), 'client-context-'));
  try {
    const sourcePlan = buildInstallPlan({ factoryRoot: FactoryRoot, projectRoot: ProjectRoot });
    for (const file of sourcePlan.files) {
      const disk = join(neutralRoot, file.relPath);
      mkdirSync(dirname(disk), { recursive: true });
      writeFileSync(disk, clientText(file.content, file.relPath));
    }
    const neutralInstaller = await import(pathToFileURL(join(neutralRoot, 'scripts/forge/context-install.mjs')).href);
    contextResult = neutralInstaller.applyInstall(neutralInstaller.buildInstallPlan({ factoryRoot: neutralRoot, projectRoot: ProjectRoot }));
  } finally { rmSync(neutralRoot, { recursive: true, force: true }); }
} else contextResult = applyInstall(buildInstallPlan({ factoryRoot: FactoryRoot, projectRoot: ProjectRoot }));
if (contextResult.conflicts?.length) die(`scaffold: compact context installation refused: ${contextResult.conflicts.map((item) => item.path).join(', ')}`);
console.log(`  Installed compact context packet (${contextResult.inventory.filter((item) => item.action !== 'unchanged').length} changed)`);

// git init + initial commit (hooksPath set BEFORE the commit so gates are live from commit #1)
const git = (a) => spawnSync('git', a, { cwd: ProjectRoot, stdio: 'ignore' });
git(['init', '--quiet']);
git(['config', 'core.hooksPath', '.githooks']);
git(['add', '-A']);
git(['commit', '-m', `Initial scaffold from ${args.clientReady ? 'AI Factory' : 'VibePromptRig'} factory (${Template} template)`, '--quiet']);

// factory project brief
const BriefDir = join(FactoryRoot, 'projects', NameLower);
if (!existsSync(BriefDir)) {
  mkdirSync(BriefDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(join(BriefDir, 'BRIEF.md'),
    `# ${Name} — Project Brief\n\n## One Sentence\n[What this project does]\n\n## Status: DISCUSSED (${date})\n\n## Tech Stack\n${TechStack}\n\n## Revenue Model\n[How this makes money]\n\n## Validation Needed\n- [ ] [First validation step]\n`);
}

// open VS Code (best-effort)
try { spawnSync('code', [ProjectRoot], { stdio: 'ignore' }); } catch { /* ignore */ }

console.log(`\n  Scaffold complete!`);
console.log(`  Created: ${ProjectRoot}`);
console.log(`    compact native context + .forge/context/ + tracking files`);
console.log(`    Git initialized + initial commit + pre-commit gates (.githooks via core.hooksPath)`);
console.log(`\n  Next: cd ${ProjectRoot} && claude\n`);

function HANDOFF_GUIDE() {
  return `# How to Use Your AI Development System

## Getting Started
1. Open your terminal in the project directory
2. Run: claude
3. Say what you want to build -- the system handles the rest

## What's Included
- .forge/context/ -- compact context cards and facts
- CURRENT_SPRINT.md -- Track active tasks
- V1_FEATURE_BACKLOG.md -- Feature pipeline
- errors-fixed.json -- Bug patterns and fixes
- golden-paths.md -- Proven patterns to reuse

## Quick Commands
| Say this | What happens |
|----------|-------------|
| "Build [feature]" | Plans, builds, tests, commits |
| "Status" | Shows current progress and blockers |
| "Hostile Architect [feature]" | Stress-tests before building |

## Monthly Maintenance
The system improves itself after every session. No manual maintenance required.
`;
}
