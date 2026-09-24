#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

function parse(argv) {
  const allowed = new Set(['--scope', '--desc', '--env', '--source-sha', '--work-author', '--criteria-file', '--commands-file', '--gaps-file', '--production-file', '--output', '--root']);
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!allowed.has(key) || !value || value.startsWith('--')) throw new Error(`unsupported or incomplete argument: ${key ?? '(missing)'}`);
    result[key.slice(2)] = value;
  }
  for (const key of ['scope', 'desc', 'env', 'source-sha', 'work-author', 'criteria-file', 'commands-file', 'gaps-file', 'output']) {
    if (!result[key]) throw new Error(`--${key} is required; the generator never invents release evidence`);
  }
  if (!['local', 'ci', 'staging', 'production'].includes(result.env)) throw new Error('--env must be exactly local, ci, staging, or production');
  if (result.env === 'production' && !result['production-file']) throw new Error('--production-file is required for production evidence manifests');
  return result;
}

function git(root, args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
function safePath(root, value, label) {
  if (isAbsolute(value) || value.split(/[\\/]/).includes('..')) throw new Error(`${label} must be a repository-relative path`);
  const absolute = resolve(root, value), rel = relative(root, absolute);
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`${label} must stay inside the repository`);
  const realRoot = realpathSync(root);
  let probe = absolute;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  if (existsSync(probe)) {
    if (probe === absolute && lstatSync(probe).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
    const realProbe = realpathSync(probe), realRel = relative(realRoot, realProbe);
    if (realRel === '..' || realRel.startsWith(`..${sep}`)) throw new Error(`${label} resolves outside the repository`);
  }
  return absolute;
}

try {
  const args = parse(process.argv.slice(2));
  const root = resolve(args.root || process.cwd());
  const destination = safePath(root, args.output, '--output');
  if (!/^[0-9a-f]{40}$/.test(args['source-sha'])) throw new Error('--source-sha must be a full 40-character lowercase SHA');
  git(root, ['cat-file', '-e', `${args['source-sha']}^{commit}`]);
  const head = git(root, ['rev-parse', 'HEAD']);
  if (args['source-sha'] !== head) throw new Error('--source-sha must equal current HEAD; ancestor receipts are stale');
  const readJson = (file, label) => JSON.parse(readFileSync(safePath(root, file, label), 'utf8'));
  const created = new Date();
  const receipt = {
    schema_version: 3,
    scope_id: args.scope,
    scope_description: args.desc,
    source_commit_sha: args['source-sha'],
    environment: args.env,
    work_author_id: args['work-author'],
    created_at: created.toISOString(),
    expires_at: new Date(created.getTime() + 7 * 24 * 60 * 60_000).toISOString(),
    acceptance_criteria: readJson(args['criteria-file'], '--criteria-file'),
    verification_records: readJson(args['commands-file'], '--commands-file'),
    known_gaps: readJson(args['gaps-file'], '--gaps-file'),
    ...(args['production-file'] ? { production_verification: readJson(args['production-file'], '--production-file') } : {}),
  };
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(`Evidence manifest generated: ${destination}`);
  console.log('This records internal evidence integrity only; it does not prove execution, independent review, approval, or completion.');
} catch (error) {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
