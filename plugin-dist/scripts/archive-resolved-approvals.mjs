#!/usr/bin/env node
// archive-resolved-approvals.mjs -- move RESOLVED PENDING_APPROVALS.md entries older than N days
// into PENDING_APPROVALS_ARCHIVE.md, keeping the live file to the genuinely-open queue (audit 3.4).
//
// DRY-RUN BY DEFAULT (prints what it WOULD move); pass --apply to actually move. The weekly sweep
// runs this in dry-run and surfaces the candidate count -- it deliberately does NOT --apply headlessly,
// because the open/resolved call is a heuristic over hand-written markdown and a wrong archive would
// silently drop an OPEN item from the review file. A human runs --apply after eyeballing the list.
// Safe by construction: only DATED "## " entries classified resolved (open===false) by
// pending-summary.mjs are eligible; meta sections, undated headings, and anything still open are never
// touched. The live file is git-tracked, so an --apply is reversible.
//
// Usage: node scripts/archive-resolved-approvals.mjs [--apply] [--older-than=30] [pending-path]

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { parseBlocks, classifyBlock } from './lib/pending-summary.mjs';

function argValue(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

const here = dirname(fileURLToPath(import.meta.url));
const apply = process.argv.includes('--apply');
const olderThan = parseInt(argValue('older-than', '30'), 10);
const pathArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const pendingPath = pathArg || join(here, '..', 'PENDING_APPROVALS.md');
const archivePath = join(dirname(pendingPath), 'PENDING_APPROVALS_ARCHIVE.md');

/** Return {candidates, scanned} without mutating anything -- reused by the weekly sweep. */
export function findArchivable(pending, nowMs, olderThanDays = 30) {
  const { preamble, blocks } = parseBlocks(pending);
  const archive = [];
  const keep = [];
  for (const b of blocks) {
    const c = classifyBlock(b, nowMs);
    if (c && !c.open && c.ageDays >= olderThanDays) archive.push({ b, c });
    else keep.push(b);
  }
  return { preamble, keep, archive, scanned: blocks.length };
}

function main() {
  if (!existsSync(pendingPath)) {
    process.stderr.write(`archive-resolved-approvals: not found: ${pendingPath}\n`);
    process.exit(1);
  }
  const now = Date.now();
  const original = readFileSync(pendingPath, 'utf8');
  const { preamble, keep, archive, scanned } = findArchivable(original, now, olderThan);

  if (archive.length === 0) {
    process.stdout.write(`No resolved entries older than ${olderThan}d to archive (${scanned} entries scanned).\n`);
    return;
  }

  process.stdout.write(`${apply ? 'ARCHIVING' : 'DRY-RUN -- would archive'} ${archive.length} resolved entr${archive.length === 1 ? 'y' : 'ies'} older than ${olderThan}d:\n`);
  for (const { c } of archive) process.stdout.write(`  - [${c.tag}] ${c.ageDays}d (${c.pri})\n`);

  if (!apply) {
    process.stdout.write('\nRe-run with --apply to move them into PENDING_APPROVALS_ARCHIVE.md (review the git diff before committing).\n');
    return;
  }

  // Rebuild the live file: preamble + kept blocks verbatim, normalized to a single trailing newline.
  const rebuilt = [...preamble, ...keep.flatMap((b) => b.raw)].join('\n').replace(/\n*$/, '') + '\n';
  const stamp = new Date().toISOString().slice(0, 10);
  if (!existsSync(archivePath)) {
    writeFileSync(archivePath, '# PENDING_APPROVALS -- Archive\n\n> Resolved entries moved out of PENDING_APPROVALS.md to keep the live queue lean.\n> Auto-appended by scripts/archive-resolved-approvals.mjs.\n', 'utf8');
  }
  const chunk = `\n<!-- archived ${stamp} by archive-resolved-approvals.mjs -->\n${archive.map(({ b }) => b.raw.join('\n')).join('\n')}\n`;
  appendFileSync(archivePath, chunk, 'utf8');
  writeFileSync(pendingPath, rebuilt, 'utf8');
  process.stdout.write(`\nMoved ${archive.length} entr${archive.length === 1 ? 'y' : 'ies'} to ${archivePath}. Live file now holds ${keep.length} entries. Review the diff before committing.\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
