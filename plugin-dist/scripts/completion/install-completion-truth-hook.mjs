#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

function die(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.length !== 0 && (argv.length !== 2 || argv[0] !== '--root' || !argv[1])) {
  die('usage: node tools/install-completion-truth-hook.mjs [--root <repository>]');
}

const root = resolve(argv[1] || process.cwd());
for (const path of ['.git', '.githooks/commit-msg', 'tools/block-unverified-claims.mjs']) {
  if (!existsSync(resolve(root, path))) die(`required path is missing: ${path}`);
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

try {
  git(['config', 'extensions.worktreeConfig', 'true']);
  git(['config', '--worktree', 'core.hooksPath', '.githooks']);
  const configured = git(['config', '--worktree', '--get', 'core.hooksPath']);
  if (configured !== '.githooks') die(`core.hooksPath verification failed: ${configured || '(empty)'}`);
  console.log(`PASS: completion-truth hook active for ${root}`);
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}
