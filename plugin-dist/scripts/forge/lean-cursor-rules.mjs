#!/usr/bin/env node
// lean-cursor-rules.mjs -- demote bloated alwaysApply .mdc rules to Agent-Requested mode.
// Replaces the 5 essential rules with lean templates when available. cursor-forge-adopt.md C3.

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { ESSENTIAL_RULES } from './target-cursor.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const factoryRoot = process.env.VIBE_ROOT || dirname(dirname(here));

function parseArgs(argv) {
  let path = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--path' || argv[i] === '-path') path = argv[++i];
  }
  return { path: path || process.cwd() };
}

function patchFrontmatter(content, { alwaysApply, description }) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return content;
  const lines = m[1].split(/\r?\n/).filter((l) => !/^\s*alwaysApply:/.test(l));
  lines.push(`alwaysApply: ${alwaysApply}`);
  if (description && !lines.some((l) => /^\s*description:/.test(l))) {
    lines.unshift(`description: ${description}`);
  }
  return `---\n${lines.join('\n')}\n---\n${m[2]}`;
}

function main() {
  const { path: projectRoot } = parseArgs(process.argv.slice(2));
  const rulesDir = join(projectRoot, '.cursor', 'rules');
  const leanDir = join(factoryRoot, 'scripts', 'templates', 'cursor', 'rules');
  if (!existsSync(rulesDir)) {
    process.stderr.write(`No .cursor/rules at ${projectRoot}\n`);
    process.exit(1);
  }
  let lean = 0;
  let demoted = 0;
  for (const name of readdirSync(rulesDir).filter((f) => f.endsWith('.mdc'))) {
    const disk = join(rulesDir, name);
    const leanTpl = join(leanDir, name);
    if (ESSENTIAL_RULES.has(name) && existsSync(leanTpl)) {
      writeFileSync(disk, readFileSync(leanTpl, 'utf8'), 'utf8');
      lean++;
      continue;
    }
    const content = readFileSync(disk, 'utf8');
    const title = content.match(/^#\s+(.+)$/m);
    const desc = (title ? title[1].trim() : name.replace('.mdc', '')).replace(/"/g, "'");
    const patched = patchFrontmatter(content, { alwaysApply: false, description: desc });
    if (patched !== content) {
      writeFileSync(disk, patched, 'utf8');
      demoted++;
    }
  }
  process.stdout.write(`lean-cursor-rules: ${lean} essential (lean), ${demoted} demoted to Agent-Requested\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
