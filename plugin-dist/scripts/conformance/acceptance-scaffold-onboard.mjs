#!/usr/bin/env node
// acceptance-scaffold-onboard.mjs -- T1b end-to-end milestone test (cross-platform port P2).
//
// Proves the testable T1b milestone on EVERY OS cell: a new project can be
//   create -> onboard -> gates-fire
// on Windows / macOS / Linux using the Node twins. Dependency-free, Node >= 18.
//
//   1. scaffold a project (into a temp HOME) -> compact context + .githooks + initial commit
//   2. onboard a separate bare repo            -> compact context + .githooks wired
//   3. gates-fire: a feat( commit with no ARCHITECTURE.md is BLOCKED by the commit-msg arch-gate,
//      and the [no-arch: ...] override is honored -- the gate actually BITES on this OS.
//
// All artifacts land in os.tmpdir() + are cleaned up; the factory `projects/<name>` briefs the
// twins write are removed too (so a CI checkout / local repo stays clean).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const stamp = `${process.pid}-${Date.now()}`;
const scaffoldName = `xplat acceptance scaffold ${stamp}`;
const tmpHome = join(tmpdir(), `vf-accept-home-${stamp}`);
const onboardProj = join(tmpdir(), `vf-accept-onboard-${stamp}`);
const legacyProj = join(tmpdir(), `vf-accept-legacy-${stamp}`);
const projDir = join(tmpHome, 'Projects', scaffoldName);

function cleanup() {
  // the factory briefs the twins write are named after the project basename:
  // scaffold -> projects/<scaffoldName>, onboard -> projects/<basename(onboardProj)>
  for (const p of [tmpHome, onboardProj, legacyProj,
    join(repoRoot, 'projects', scaffoldName.toLowerCase().replace(/\s+/g, '-')),
    join(repoRoot, 'projects', basename(onboardProj).toLowerCase()),
    join(repoRoot, 'projects', basename(legacyProj).toLowerCase())]) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
process.on('exit', cleanup);

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name} -- ${detail}`); }
}
function git(cwd, a) { return spawnSync('git', a, { cwd, encoding: 'utf8' }); }
function setIdentity(cwd) { git(cwd, ['config', 'user.email', 'accept@example.com']); git(cwd, ['config', 'user.name', 'Acceptance']); }
function hasMd(dir) { return existsSync(dir) && readdirSync(dir).some((f) => f.toLowerCase().endsWith('.md')); }

const idEnv = { GIT_AUTHOR_NAME: 'Acceptance', GIT_AUTHOR_EMAIL: 'accept@example.com', GIT_COMMITTER_NAME: 'Acceptance', GIT_COMMITTER_EMAIL: 'accept@example.com' };

// ---- 1. CREATE (scaffold) ----
mkdirSync(tmpHome, { recursive: true });
const scEnv = { ...process.env, ...idEnv, HOME: tmpHome, USERPROFILE: tmpHome, VIBE_ROOT: repoRoot };
const sc = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'scaffold-new-project.mjs'), '--name', scaffoldName, '--template', 'empty'], { env: scEnv, encoding: 'utf8' });
check('scaffold: exit 0', sc.status === 0, `status=${sc.status} ${sc.stderr}`);
check('scaffold: project dir created', existsSync(projDir), projDir);
check('scaffold: compact context installed', existsSync(join(projDir, '.forge', 'context', 'kernel.md')));
check('scaffold: no full .claude/rules autoload tree', !existsSync(join(projDir, '.claude', 'rules')));
check('scaffold: .claude/CLAUDE.md present', existsSync(join(projDir, '.claude', 'CLAUDE.md')));
check('scaffold: .githooks/commit-msg present', existsSync(join(projDir, '.githooks', 'commit-msg')));
check('scaffold: completion blocker present', existsSync(join(projDir, 'tools', 'block-unverified-claims.mjs')));
check('scaffold: completion self-test present', existsSync(join(projDir, 'tools', 'completion-truth.selftest.mjs')));
check('scaffold: completion CI present', existsSync(join(projDir, '.github', 'workflows', 'vibepromptrig-completion-truth.yml')));
check('scaffold: core.hooksPath=.githooks', git(projDir, ['config', '--get', 'core.hooksPath']).stdout.trim() === '.githooks');
const scLog = git(projDir, ['log', '--oneline']);
check('scaffold: initial commit present', scLog.status === 0 && /Initial scaffold/.test(scLog.stdout), (scLog.stdout + scLog.stderr).trim());

// ---- 2. ONBOARD (a separate existing repo) ----
mkdirSync(onboardProj, { recursive: true });
git(onboardProj, ['init', '--quiet']); setIdentity(onboardProj);
writeFileSync(join(onboardProj, 'README.md'), '# existing project\n');
git(onboardProj, ['add', '-A']); git(onboardProj, ['commit', '-m', 'init', '--quiet']);
const ob = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'onboard-existing-project.mjs'), '--path', onboardProj], { env: { ...process.env, VIBE_ROOT: repoRoot }, encoding: 'utf8' });
check('onboard: exit 0', ob.status === 0, `status=${ob.status} ${ob.stderr}`);
check('onboard: compact context installed', existsSync(join(onboardProj, '.forge', 'context', 'kernel.md')));
check('onboard: no full .claude/rules autoload tree', !existsSync(join(onboardProj, '.claude', 'rules')));
check('onboard: .githooks/commit-msg wired', existsSync(join(onboardProj, '.githooks', 'commit-msg')));
check('onboard: completion blocker present', existsSync(join(onboardProj, 'tools', 'block-unverified-claims.mjs')));
check('onboard: completion CI present', existsSync(join(onboardProj, '.github', 'workflows', 'vibepromptrig-completion-truth.yml')));
check('onboard: core.hooksPath=.githooks', git(onboardProj, ['config', '--get', 'core.hooksPath']).stdout.trim() === '.githooks');

// ---- 2b. ONBOARD a pre-Context-V2 project (Delivery 3b): legacy copies are reported, never deleted ----
mkdirSync(join(legacyProj, '.claude', 'rules'), { recursive: true });
const legacyBody = readFileSync(join(repoRoot, 'docs', 'rules-reference', 'factory', 'seo.md'));
writeFileSync(join(legacyProj, '.claude', 'rules', 'seo.md'), legacyBody);
writeFileSync(join(legacyProj, '.claude', 'rules', 'auth.md'), '# team-edited auth rule\n');
const lob = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'onboard-existing-project.mjs'), '--path', legacyProj], { env: { ...process.env, VIBE_ROOT: repoRoot }, encoding: 'utf8' });
check('onboard legacy: exit 0', lob.status === 0, `status=${lob.status} ${lob.stderr}`);
check('onboard legacy: reports proven copies and preserved conflicts', /1 proven factory-owned, 1 customized \(preserved\)/.test(lob.stdout), lob.stdout);
check('onboard legacy: deletes nothing itself', readFileSync(join(legacyProj, '.claude', 'rules', 'seo.md')).equals(legacyBody)
  && existsSync(join(legacyProj, '.claude', 'rules', 'auth.md')));

// ---- 3. GATES-FIRE (the milestone proof) ----
writeFileSync(join(onboardProj, 'feature.txt'), 'a new feature\n');
git(onboardProj, ['add', '-A']);
const blocked = git(onboardProj, ['commit', '-m', 'feat(demo): add a feature']);
check('gates-fire: feat() commit BLOCKED by the .githooks arch-gate (non-zero exit)', blocked.status !== 0, `status=${blocked.status}`);
const allowed = git(onboardProj, ['commit', '-m', 'feat(demo): add a feature [no-arch: acceptance test]']);
check('gates-fire: [no-arch] override is honored (commit allowed)', allowed.status === 0, `status=${allowed.status} ${(allowed.stderr || '').trim()}`);
writeFileSync(join(onboardProj, 'claim.txt'), 'forged finish line\n');
git(onboardProj, ['add', '-A']);
const claimBlocked = git(onboardProj, ['commit', '-m', 'chore: 100% complete and verified']);
check('gates-fire: absolute completion claim is BLOCKED (non-zero exit)', claimBlocked.status !== 0, `status=${claimBlocked.status}`);

console.log(`\nACCEPTANCE (create -> onboard -> gates-fire) on ${process.platform}: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
