#!/usr/bin/env node
// post-session-enforcer.mjs -- Node twin of post-session-enforcer.ps1 (cross-platform port P2, T2).
// Stop hook: writes SESSION_DEBRIEF.md, idempotently appends session commits to CHANGELOG.md, bumps
// the canonical VERSION.md patch. Stop-hook stdout stays empty: Claude Code treats non-JSON
// prose as an invalid hook protocol response, while SESSION_DEBRIEF.md holds the human debrief.
//
// IDEMPOTENCY (the load-bearing property -- "a 2nd Stop leaves CHANGELOG/VERSION byte-clean"):
//   - CHANGELOG dedup key is the short SHA suffix "(<sha>)"; a commit already present is never
//     re-appended. Housekeeping commits (chore(changelog|version|session|debrief|dist|metrics) OR
//     commits touching ONLY auto-artifacts) are never logged, so committing the changelog itself
//     does not re-dirty the tree.
//   - VERSION bumps ONLY when newEntries.length > 0. A 2nd Stop with no new commits -> newEntries
//     empty -> no changelog write, no version bump. SESSION_DEBRIEF.md is overwritten (not appended).
//
// Dependency-free, node:path throughout, Node>=18.

import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { resolveFactoryRoot, finishHook, projectWritesAllowed } from './hook-lib.mjs';

const HOOK = 'post-session-enforcer';
const here = dirname(fileURLToPath(import.meta.url));
const { factoryRoot, defer } = resolveFactoryRoot(here);
if (defer) process.exit(0); // plugin copy in a factory session -> repo-local copy does the work
// Installed plugin copies write SESSION_DEBRIEF/CHANGELOG/VERSION only with the project's consent.
if (!projectWritesAllowed(here, process.cwd())) finishHook(factoryRoot, HOOK, 0);

try {
  const cwd = process.cwd();
  const git = (args) => { try { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); return r.status === 0 ? (r.stdout || '') : ''; } catch { return ''; } };
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

  if (git(['rev-parse', '--is-inside-work-tree']).trim() !== 'true') {
    finishHook(factoryRoot, HOOK, 0);
  }

  const sinceD = new Date(Date.now() - 2 * 3600 * 1000);
  const since = `${sinceD.getFullYear()}-${pad(sinceD.getMonth() + 1)}-${pad(sinceD.getDate())}T${pad(sinceD.getHours())}:${pad(sinceD.getMinutes())}:${pad(sinceD.getSeconds())}`;

  const recentCommits = git(['log', '--oneline', `--since=${since}`]).split(/\r?\n/).filter((l) => l.trim());
  const commitCount = recentCommits.length;
  let diffStat = git(['diff', '--stat', `HEAD~${Math.max(commitCount, 1)}..HEAD`]).replace(/\s+$/, '');
  if (!diffStat) diffStat = 'No changes detected';

  // tracking-file staleness (mtime-based, advisory only -- the debrief is overwritten each run)
  const staleFiles = [];
  for (const f of ['CURRENT_SPRINT.md', 'V1_FEATURE_BACKLOG.md', 'errors-fixed.json', 'golden-paths.md']) {
    const fp = join(cwd, f);
    if (existsSync(fp)) {
      const daysSince = Math.floor((Date.now() - statSync(fp).mtimeMs) / 86400000);
      if (daysSince > 3) staleFiles.push(`  - ${f} (last updated ${daysSince} days ago)`);
    }
  }
  const commitList = commitCount ? recentCommits.join('\n') : 'No commits this session';
  const staleSection = staleFiles.length ? `STALE files (not updated in 3+ days):\n${staleFiles.join('\n')}` : 'All tracking files are current.';

  const debrief = `# Session Debrief — ${timestamp}\n\n## Commits This Session (${commitCount})\n${commitList}\n\n## Files Changed\n${diffStat}\n\n## Tracking File Status\n${staleSection}\n\n## Action Items\n- [ ] Review commits above — any bugs fixed? Add to errors-fixed.json\n- [ ] Any new patterns? Add to golden-paths.md\n- [ ] Update CURRENT_SPRINT.md with task statuses\n- [ ] Any lessons learned? Suggest additions to lessons.md\n`;
  writeFileSync(join(cwd, 'SESSION_DEBRIEF.md'), debrief);

  // ---- Auto-changelog (dedup by short SHA; skip housekeeping) ----
  let newEntries = [];
  if (commitCount > 0) {
    const autoArtifacts = ['CHANGELOG.md', 'VERSION.md', 'SESSION_DEBRIEF.md'];
    const rawLog = git(['log', `--since=${since}`, '--pretty=format:%h%x09%s']);
    for (const line of rawLog.split(/\r?\n/)) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const sha = line.slice(0, tab).trim();
      const subject = line.slice(tab + 1).trim();
      if (!sha || !subject) continue;
      if (/^chore\((changelog|version|session|debrief|dist|metrics)\)/.test(subject)) continue;
      const touched = git(['show', '--name-only', '--pretty=format:', sha]).split(/\r?\n/).filter((x) => x);
      if (touched.length > 0 && touched.every((t) => autoArtifacts.includes(t))) continue;
      newEntries.push({ sha, subject });
    }

    let existing = existsSync(join(cwd, 'CHANGELOG.md')) ? readFileSync(join(cwd, 'CHANGELOG.md'), 'utf8') : '';
    newEntries = newEntries.filter((e) => existing.indexOf(`(${e.sha})`) < 0); // SHA = idempotency key

    if (newEntries.length > 0) {
      const dateHeader = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const newLines = newEntries.map((e) => `- ${e.subject} (${e.sha})`).join('\n') + '\n';
      const headerRe = new RegExp(`^## ${dateHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*\\r?$`, 'm');
      const hm = existing.match(headerRe);
      if (hm) {
        let insertAt = existing.indexOf('\n', hm.index);
        insertAt = insertAt < 0 ? existing.length : insertAt + 1;
        existing = existing.slice(0, insertAt) + newLines + existing.slice(insertAt);
      } else {
        const block = `## ${dateHeader}\n${newLines}\n`;
        if (!existing) existing = `# Changelog\n\n${block}`;
        else {
          const tm = existing.match(/^# [^\r\n]+\r?\n(\r?\n)?/); // \A in the .ps1: start-of-string title
          if (tm && tm.index === 0) existing = existing.slice(0, tm[0].length) + block + existing.slice(tm[0].length);
          else existing = `# Changelog\n\n${block}${existing}`;
        }
      }
      writeFileSync(join(cwd, 'CHANGELOG.md'), existing);
    }
  }

  // ---- Version bump: canonical "**Current version:** X.Y.Z" patch only, only when new entries landed ----
  const versionPath = join(cwd, 'VERSION.md');
  if (existsSync(versionPath) && newEntries.length > 0) {
    let vContent = readFileSync(versionPath, 'utf8');
    const cv = vContent.match(/^(\*\*Current version:\*\*\s+)(\d+)\.(\d+)\.(\d+)/m);
    if (cv) {
      const newVersion = `${cv[2]}.${cv[3]}.${parseInt(cv[4], 10) + 1}`;
      const semStart = cv.index + cv[1].length;
      const semLen = cv[0].length - cv[1].length;
      vContent = vContent.slice(0, semStart) + newVersion + vContent.slice(semStart + semLen);
      writeFileSync(versionPath, vContent);
    }
  }

} catch { /* fail-open */ }

finishHook(factoryRoot, HOOK, 0);
