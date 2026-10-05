import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { checkMessage } from './block-unverified-claims.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const blocker = join(here, 'block-unverified-claims.mjs');
const validator = join(here, 'validate-completion-receipt.mjs');
const generator = join(here, 'generate-completion-receipt.mjs');
const installer = join(here, 'install-completion-truth-hook.mjs');
const trackedHook = [
  join(here, '..', '.githooks', 'commit-msg'),
  join(here, '..', '..', 'scripts', 'templates', 'shared', '.githooks', 'commit-msg'),
].find((path) => existsSync(path));

function run(script, args, cwd) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'vibepromptrig-manifest-'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'user.name', 'Completion Test']);
  mkdirSync(join(root, 'evidence'));
  writeFileSync(join(root, 'evidence', 'tests.log'), '6/6 checks passed\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'test: evidence fixture']);
  const sha = git(root, ['rev-parse', 'HEAD']);
  const now = Date.now();
  const manifest = {
    schema_version: 3,
    scope_id: 'TEST-SCOPE-1',
    scope_description: 'Completion contract mutation fixture',
    source_commit_sha: sha,
    environment: 'local',
    work_author_id: 'builder-agent',
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + 24 * 60 * 60_000).toISOString(),
    acceptance_criteria: [{
      id: 'AC-1',
      expected_behavior: 'The isolated completion checks reject forged claims and evidence.',
      evidence_source: 'cmd-tests',
      commit_sha: sha,
      environment: 'local',
      required: true,
      status: 'passed',
      gap: null,
      evidence_refs: ['cmd-tests'],
    }],
    verification_records: [{
      id: 'cmd-tests',
      attestation_level: 'operator_recorded',
      command: 'node --test',
      exit_code: 0,
      commit_sha: sha,
      checks_passed: 6,
      checks_total: 6,
      started_at: new Date(now - 2000).toISOString(),
      finished_at: new Date(now - 1000).toISOString(),
      evidence: { path: 'evidence/tests.log', sha256: digest(join(root, 'evidence', 'tests.log')) },
    }],
    known_gaps: [],
  };
  const manifestPath = join(root, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { root, manifest, manifestPath, sha, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('absolute claim language is rejected; measured scope language is allowed', () => {
  for (const text of ['100% complete', 'fully verified', 'fully **complete**', 'production-ready', 'Everything is finished', 'Everything has been completed.', 'All four cycles are done', 'All work has been completed.', 'The project is complete.', 'The project has been completed.', 'Project complete.', 'Implementation complete.', 'Example Wellness App is complete and verified.', 'Example Wellness App has been completed.', 'Ready for production.', 'Ready to ship.', 'Done and verified.', 'All acceptance criteria passed.']) {
    assert.equal(checkMessage(text).allowed, false, text);
  }
  const status = [
    'State: ci_verified',
    'Frozen scope: TEST-SCOPE-1 from docs/acceptance.md',
    `Exact commit/environment: ${'a'.repeat(40)} / ci`,
    'Passed: completion checks 7/7',
    'Not verified: production runtime',
    'Known gaps: production runtime remains unverified',
    'Independent review: not provided',
    'Human release approval: not provided',
    'Evidence manifest: none',
  ].join('\n');
  assert.equal(run(blocker, ['--text', status], process.cwd()).status, 0);
  assert.equal(run(blocker, ['--text', 'Implementation complete.'], process.cwd()).status, 1);
  assert.equal(run(blocker, ['--text', 'All 7/7 checks passed.'], process.cwd()).status, 1);
});

test('malformed blocker arguments fail closed', () => {
  assert.equal(run(blocker, [], process.cwd()).status, 2);
  assert.equal(run(blocker, ['--unknown', 'x'], process.cwd()).status, 2);
  assert.equal(run(blocker, ['missing-message-file'], process.cwd()).status, 2);
});

test('manifest generator refuses to invent missing evidence', () => {
  const result = run(generator, [], process.cwd());
  assert.equal(result.status, 1);
  assert.match(result.stderr, /never invents release evidence/);
});

test('manifest tools reject paths outside the repository', () => {
  const result = run(generator, [
    '--scope', 'S', '--desc', 'D', '--env', 'local', '--source-sha', '0'.repeat(40),
    '--work-author', 'agent', '--criteria-file', 'criteria.json', '--commands-file', 'commands.json',
    '--gaps-file', 'gaps.json', '--output', '../escape.json',
  ], process.cwd());
  assert.equal(result.status, 1);
  assert.match(result.stderr, /repository-relative path|stay inside/);
  const validation = run(validator, ['--receipt', '../outside.json'], process.cwd());
  assert.equal(validation.status, 1);
  assert.match(validation.stderr, /repository-relative path|stay inside/);
});

test('validator accepts a current-HEAD, digest-bound v3 evidence manifest', () => {
  const f = fixture();
  try {
    const result = run(validator, ['--root', f.root, '--receipt', 'manifest.json', '--expected-sha', f.sha], f.root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /internal consistency/);
    assert.match(result.stdout, /does not prove command execution/);
  } finally { f.cleanup(); }
});

test('each forged-manifest defense fails independently', () => {
  const cases = [
    ['v2 self-issued receipt', (f) => { f.manifest.schema_version = 2; }],
    ['empty records', (f) => { f.manifest.verification_records = []; }],
    ['fake independent review', (f) => { f.manifest.independent_review = { status: 'approved', reviewer_id: 'typed-name' }; }],
    ['fake human approval alias', (f) => { f.manifest.human_release_approval = { status: 'approved', approver: 'the project owner' }; }],
    ['fake reviewer alias', (f) => { f.manifest.reviewer_id = 'typed-name'; }],
    ['fake verified alias', (f) => { f.manifest.verification_records[0].verified = true; }],
    ['false verified attestation', (f) => { f.manifest.verification_records[0].attestation_level = 'verified'; }],
    ['missing criterion behavior', (f) => { delete f.manifest.acceptance_criteria[0].expected_behavior; }],
    ['production alias', (f) => { f.manifest.environment = 'Production'; f.manifest.acceptance_criteria[0].environment = 'Production'; }],
    ['production without live record', (f) => { f.manifest.environment = 'production'; f.manifest.acceptance_criteria[0].environment = 'production'; }],
    ['altered evidence', (f) => { writeFileSync(join(f.root, 'evidence', 'tests.log'), 'changed after manifest\n'); }],
    ['stale ancestor SHA', (f) => {
      writeFileSync(join(f.root, 'later.txt'), 'later commit\n');
      git(f.root, ['add', 'later.txt']);
      git(f.root, ['commit', '-m', 'test: later change']);
    }],
  ];
  for (const [name, mutate] of cases) {
    const f = fixture();
    try {
      mutate(f);
      writeFileSync(f.manifestPath, JSON.stringify(f.manifest, null, 2));
      const result = run(validator, ['--root', f.root, '--receipt', 'manifest.json'], f.root);
      assert.notEqual(result.status, 0, `${name} unexpectedly passed\n${result.stdout}${result.stderr}`);
    } finally { f.cleanup(); }
  }
});

test('production cannot reuse a generic test log as deployment and live invocation evidence', () => {
  const f = fixture();
  try {
    f.manifest.environment = 'production';
    f.manifest.acceptance_criteria[0].environment = 'production';
    f.manifest.production_verification = {
      status: 'passed', attestation_level: 'operator_recorded', deployed_commit_sha: f.sha,
      checks_passed: 1, checks_total: 1, evidence_id: 'generic-production-claim',
      evidence: f.manifest.verification_records[0].evidence,
    };
    writeFileSync(f.manifestPath, JSON.stringify(f.manifest, null, 2));
    const result = run(validator, ['--root', f.root, '--receipt', 'manifest.json'], f.root);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /artifact_observation|live_invocation/);
  } finally { f.cleanup(); }
});

function productionFixture() {
  const f = fixture();
  const evidence = (name, content) => {
    const path = `evidence/${name}.json`;
    writeFileSync(join(f.root, path), JSON.stringify(content));
    return { path, sha256: digest(join(f.root, path)) };
  };
  const common = {
    environment: 'production', target: 'test-only-service', deployed_commit_sha: f.sha,
    observed_at: f.manifest.created_at,
  };
  f.manifest.environment = 'production';
  f.manifest.acceptance_criteria[0].environment = 'production';
  f.manifest.production_verification = {
    status: 'passed', attestation_level: 'operator_recorded', deployed_commit_sha: f.sha,
    checks_passed: 2, checks_total: 2, evidence_id: 'production-summary',
    evidence: evidence('summary', { fixture: true, checks: '2/2' }),
    artifact_observation: {
      ...common, evidence_id: 'artifact',
      evidence: evidence('artifact', { fixture: true, commit: f.sha }),
    },
    live_invocation: {
      ...common, surface: 'test-only-cli', operation: 'health', result_code: '200', outcome: 'succeeded',
      evidence_id: 'invocation', evidence: evidence('invocation', { fixture: true, code: '200' }),
    },
  };
  return f;
}

test('separate production observation records pass consistency checks, not live certification', () => {
  const f = productionFixture();
  try {
    writeFileSync(f.manifestPath, JSON.stringify(f.manifest, null, 2));
    const result = run(validator, ['--root', f.root, '--receipt', 'manifest.json'], f.root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /does not prove.*production truth/);
    // An intentionally verified refusal is valid only within its stated acceptance scope.
    f.manifest.production_verification.live_invocation.outcome = 'honest_failure';
    f.manifest.production_verification.live_invocation.result_code = 'DEPENDENCY_UNAVAILABLE';
    writeFileSync(f.manifestPath, JSON.stringify(f.manifest, null, 2));
    assert.equal(run(validator, ['--root', f.root, '--receipt', 'manifest.json'], f.root).status, 0);
  } finally { f.cleanup(); }
});

test('production observation mutations fail independently', () => {
  const cases = [
    ['missing artifact', (p) => { delete p.artifact_observation; }, /artifact_observation/],
    ['missing invocation', (p) => { delete p.live_invocation; }, /live_invocation/],
    ['wrong artifact commit', (p) => { p.artifact_observation.deployed_commit_sha = '0'.repeat(40); }, /exact deployed commit/],
    ['wrong invocation commit', (p) => { p.live_invocation.deployed_commit_sha = '0'.repeat(40); }, /exact deployed commit/],
    ['wrong environment', (p) => { p.live_invocation.environment = 'ci'; }, /environment must be production/],
    ['missing surface', (p) => { delete p.live_invocation.surface; }, /requires surface/],
    ['missing operation', (p) => { delete p.live_invocation.operation; }, /requires operation/],
    ['missing result', (p) => { delete p.live_invocation.result_code; }, /requires result_code/],
    ['mocked outcome', (p) => { p.live_invocation.outcome = 'mocked_only'; }, /outcome must be/],
    ['wrong target', (p) => { p.live_invocation.target = 'different-service'; }, /same target/],
    ['future observation', (p) => { p.live_invocation.observed_at = '2999-01-01T00:00:00Z'; }, /observed_at/],
    ['stale observation', (p) => { p.artifact_observation.observed_at = '2000-01-01T00:00:00Z'; }, /observed_at/],
    ['missing observation time', (p) => { delete p.artifact_observation.observed_at; }, /observed_at/],
    ['duplicate evidence id', (p) => { p.live_invocation.evidence_id = 'artifact'; }, /duplicate evidence id/],
    ['same evidence file', (p) => { p.live_invocation.evidence = p.artifact_observation.evidence; }, /separate evidence file/],
    ['body field forbidden', (p) => { p.live_invocation.response_body = 'test sentinel'; }, /forbidden or unknown field/],
    ['altered live evidence', (p, f) => { writeFileSync(join(f.root, p.live_invocation.evidence.path), 'tampered'); }, /digest does not match/],
  ];
  for (const [name, mutate, message] of cases) {
    const f = productionFixture();
    try {
      mutate(f.manifest.production_verification, f);
      writeFileSync(f.manifestPath, JSON.stringify(f.manifest, null, 2));
      const result = run(validator, ['--root', f.root, '--receipt', 'manifest.json'], f.root);
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, message, name);
    } finally { f.cleanup(); }
  }
});

test('evidence symlinks cannot escape the repository', { skip: process.platform === 'win32' }, () => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'vibepromptrig-outside-'));
  try {
    const external = join(outside, 'external.log');
    writeFileSync(external, '6/6 checks passed\n');
    rmSync(join(f.root, 'evidence', 'tests.log'));
    symlinkSync(external, join(f.root, 'evidence', 'tests.log'));
    const result = run(validator, ['--root', f.root, '--receipt', 'manifest.json'], f.root);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /symbolic link|outside the repository/);
  } finally {
    f.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test('clean-clone installer activates the hook and a real forbidden commit is rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibepromptrig-hook-'));
  try {
    git(root, ['init']);
    git(root, ['config', 'user.email', 'test@example.invalid']);
    git(root, ['config', 'user.name', 'Completion Test']);
    mkdirSync(join(root, 'tools'));
    mkdirSync(join(root, '.githooks'));
    cpSync(blocker, join(root, 'tools', 'block-unverified-claims.mjs'));
    cpSync(installer, join(root, 'tools', 'install-completion-truth-hook.mjs'));
    assert.ok(trackedHook, 'tracked completion-truth commit hook was not found');
    const hook = join(root, '.githooks', 'commit-msg');
    cpSync(trackedHook, hook);

    const install = run(join(root, 'tools', 'install-completion-truth-hook.mjs'), ['--root', root], root);
    assert.equal(install.status, 0, install.stdout + install.stderr);
    assert.equal(git(root, ['config', '--worktree', '--get', 'core.hooksPath']), '.githooks');

    const rejected = spawnSync('git', ['commit', '--allow-empty', '-m', 'This project is 100% complete and verified.'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(rejected.status, 0, rejected.stdout + rejected.stderr);
    assert.match(rejected.stdout + rejected.stderr, /COMPLETION CLAIM BLOCKED/);
    assert.notEqual(spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root }).status, 0);

    const accepted = spawnSync('git', ['commit', '--allow-empty', '-m', 'chore: add measured release evidence'], { cwd: root, encoding: 'utf8' });
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
