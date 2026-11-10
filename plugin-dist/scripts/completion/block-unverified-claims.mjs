#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN = [
  /100%\s*(?:complete|completed|verified|done|finished)/i,
  /\bfully\s*(?:complete|completed|verified|finished)\b/i,
  /\bproduction[\s_-]*ready\b/i,
  /\beverything\s+(?:(?:is|has\s+been)\s+)?(?:done|complete|completed|verified|finished)\b/i,
  /\ball\s+(?:(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(?:work|features?|cycles?|requirements?)\s+(?:(?:are|is|has\s+been|have\s+been)\s+)?(?:done|complete|completed|verified|finished)\b/i,
  /\b(?:the\s+)?(?:entire\s+)?(?:project|application|app|product|implementation|release)\s+(?:(?:is|has\s+been)\s+)?(?:now\s+)?(?:done|complete|completed|verified|finished)\b/i,
  /\b[A-Z][A-Za-z0-9_-]{2,}\s+(?:is|has\s+been)\s+(?:now\s+)?(?:done|complete|completed|verified|finished)\b/,
  /\ball\s+acceptance\s+criteria\s+(?:have\s+)?passed\b/i,
  /\bready\s+for\s+production\b/i,
  /\bready\s+to\s+ship\b/i,
  /\b(?:done|complete|completed|finished)\s+and\s+(?:verified|complete|completed|finished|done)\b/i,
];

// The compact completion card ships with every factory checkout, plugin build, and scaffolded or
// onboarded project (context-install), so this pointer resolves wherever the blocker runs.
export const COMPLETION_CARD = '.forge/context/rules/completion-claims.md';

export function checkMessage(value) {
  const message = String(value ?? '').replace(/[`*_~>#[\](){}|]/g, '').replace(/\s+/g, ' ');
  for (const pattern of FORBIDDEN) {
    const match = message.match(pattern);
    if (match) return {
      allowed: false,
      match: match[0],
      reason: `Unsupported absolute completion claim ("${match[0]}"). Report frozen scope, exact SHA/environment, passed denominators, and known gaps instead.`,
    };
  }
  return { allowed: true };
}

function checkStructuredStatus(value) {
  const message = String(value ?? '');
  const first = checkMessage(message);
  if (!first.allowed) return first;
  const required = [
    ['State', /(?:^|\n)State:\s*(?:implemented|locally_verified|ci_verified|deployed_unverified|production_verified|authority_blocked)\s*(?:\n|$)/i],
    ['Frozen scope', /(?:^|\n)Frozen scope:\s*\S.+/i],
    ['Exact commit/environment', /(?:^|\n)Exact commit\/environment:\s*[0-9a-f]{40}\s*\/\s*\S.+/i],
    ['Passed denominator', /(?:^|\n)Passed:\s*.*\b\d+\/\d+\b/i],
    ['Not verified', /(?:^|\n)Not verified:\s*\S.+/i],
    ['Known gaps', /(?:^|\n)Known gaps:\s*\S.+/i],
    ['Independent review', /(?:^|\n)Independent review:\s*\S.+/i],
    ['Human release approval', /(?:^|\n)Human release approval:\s*\S.+/i],
    ['Evidence manifest', /(?:^|\n)Evidence manifest:\s*\S.+/i],
  ];
  const missing = required.filter(([, pattern]) => !pattern.test(message)).map(([label]) => label);
  if (missing.length) return {
    allowed: false,
    match: 'unstructured status',
    reason: `Completion status is missing required evidence fields: ${missing.join(', ')}.`,
  };
  return { allowed: true };
}

function usageFailure(message) {
  console.error(`ERROR: ${message}`);
  console.error('Usage: block-unverified-claims.mjs <commit-message-file> | --check <text> | --text <text> | --commits <git-range>');
  process.exit(2);
}

function reject(message, label) {
  if (!String(message ?? '').trim()) usageFailure(`${label} is empty`);
  const result = checkMessage(message);
  if (!result.allowed) {
    console.error('\n[VIBEPROMPTRIG COMPLETION CLAIM BLOCKED]');
    console.error(result.reason);
    console.error(`See ${COMPLETION_CARD}\n`);
    process.exit(1);
  }
}

function main(argv) {
  if (argv.length === 1 && !argv[0].startsWith('--')) {
    if (!existsSync(argv[0])) usageFailure(`commit message file does not exist: ${argv[0]}`);
    reject(readFileSync(argv[0], 'utf8'), 'commit message');
    return;
  }
  if (argv.length === 2 && (argv[0] === '--check' || argv[0] === '--text')) {
    const value = argv[1];
    if (!String(value ?? '').trim()) usageFailure(`${argv[0]} is empty`);
    const result = checkStructuredStatus(value);
    if (!result.allowed) {
      console.error('\n[VIBEPROMPTRIG COMPLETION CLAIM BLOCKED]');
      console.error(result.reason);
      console.error(`See ${COMPLETION_CARD}\n`);
      process.exit(1);
    }
    return;
  }
  if (argv.length === 2 && argv[0] === '--commits') {
    let log;
    try { log = execFileSync('git', ['log', '--format=%B%x00', argv[1]], { encoding: 'utf8' }); }
    catch (error) { usageFailure(`unable to read commit range ${argv[1]}: ${error instanceof Error ? error.message : String(error)}`); }
    const messages = log.split('\0').filter((entry) => entry.trim());
    if (messages.length === 0) usageFailure(`commit range contains no messages: ${argv[1]}`);
    for (const message of messages) reject(message, `commit in ${argv[1]}`);
    return;
  }
  usageFailure('unsupported or incomplete arguments');
}

// Node resolves symlinks for import.meta.url, while argv may retain the alias (for example
// macOS /var versus /private/var). Compare canonical paths so direct invocation cannot bypass checks.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
