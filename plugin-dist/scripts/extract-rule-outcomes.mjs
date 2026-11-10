#!/usr/bin/env node
// extract-rule-outcomes.mjs -- Node twin of extract-rule-outcomes.ps1 (cross-platform port for the
// OS-native local scheduler). Reads git log across the factory + project repos, finds commits tagged
// [rule: RULE-ID] (+ optional [outcome: PREVENTED|MISSED]) in the body, aggregates per-rule
// catches/misses, computes effectiveness = catches / (catches + misses), appends an `outcome_scan`
// event to factory_metrics.jsonl, and (by DEFAULT -- so the arg-less cron works) writes
// docs/factory-effectiveness.md. This is the local, scriptable MEASUREMENT half of audit 3.3; the
// outcome-tracker AGENT layers interpretation/proposals on top when cloud Routines exist.
//
// Usage: node scripts/extract-rule-outcomes.mjs [--since="30 days ago"] [--json] [--no-report]
//
// Tag conventions (commit BODY, not subject):
//   [rule: VIBE-35] / [rule: vibe-standard]   -- a rule this commit upholds/fixes (multiple allowed)
//   [outcome: PREVENTED]  -- the rule caught this bug class at design time (default)
//   [outcome: MISSED]     -- the rule SHOULD have caught it but didn't (candidate for strengthening)

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { appendJsonl, utcStamp } from './hooks/hook-lib.mjs';

function optValue(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

const here = dirname(fileURLToPath(import.meta.url));
const factoryRoot = process.env.VIBE_ROOT || dirname(here);
const since = optValue('since', '30 days ago');
const jsonMode = process.argv.includes('--json');
const writeReport = !process.argv.includes('--no-report'); // DEFAULT ON (arg-less cron writes the report)
const metricsPath = join(factoryRoot, 'factory_metrics.jsonl');
const reportPath = join(factoryRoot, 'docs', 'factory-effectiveness.md');

function isRepo(dir) {
  return existsSync(join(dir, '.git'));
}

// Repos: factory + projects/<name>/.git + explicitly configured project roots.
function discoverRepos() {
  const repos = [];
  if (isRepo(factoryRoot)) repos.push(factoryRoot);
  const projectsDir = join(factoryRoot, 'projects');
  if (existsSync(projectsDir)) {
    let entries = [];
    try { entries = readdirSync(projectsDir, { withFileTypes: true }); } catch { /* ignore */ }
    for (const e of entries) if (e.isDirectory() && isRepo(join(projectsDir, e.name))) repos.push(join(projectsDir, e.name));
  }
  const configPath = join(factoryRoot, '.forge', 'agent-configs', 'synthesizer.json');
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    for (const project of Array.isArray(config?.config?.projects) ? config.config.projects : []) {
      if (typeof project === 'string' && isAbsolute(project) && isRepo(project)) repos.push(project);
    }
  }
  return [...new Set(repos.map((repo) => resolve(repo)))];
}

const SEP = '===COMMIT-VIBEPROMPTRIG===';
const END = '===END-VIBEPROMPTRIG===';
const RULE_TAG = /\[rule:\s*([a-z0-9\-_]+(?:[:.][a-z0-9\-_]+)?)\]/gi;

function scanRepo(repo, agg) {
  // maxBuffer must be large: git log with full bodies over a wide window easily exceeds the 1MB
  // spawnSync default, and a truncated buffer silently drops commits (incl. possibly tagged ones).
  const res = spawnSync('git', ['-C', repo, 'log', `--since=${since}`, `--pretty=format:${SEP}%n%H%n%ad%n%s%n%b%n${END}`, '--date=short'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (res.status !== 0 || !res.stdout) return;
  for (const raw of res.stdout.split(SEP)) {
    const clean = raw.replace(END, '').trim();
    if (!clean) continue;
    const lines = clean.split(/\r?\n/);
    if (lines.length < 3) continue;
    const sha = lines[0].trim();
    const date = (lines[1] || '').trim();
    const subj = (lines[2] || '').trim();
    const body = lines.slice(3).join('\n').trim();
    if (sha.length < 7) continue;
    agg.commitCount += 1;

    const tags = [...body.matchAll(RULE_TAG)];
    if (tags.length === 0) continue;
    agg.taggedCount += 1;
    const outcome = /\[outcome:\s*MISSED\]/i.test(body) ? 'MISSED' : 'PREVENTED';
    for (const m of tags) {
      const ruleId = m[1].toLowerCase();
      const b = (agg.rules[ruleId] ||= { total: 0, catches: 0, misses: 0, commits: [] });
      b.total += 1;
      if (outcome === 'MISSED') b.misses += 1; else b.catches += 1;
      b.commits.push({ sha: sha.slice(0, 7), date, repo: repo.split(/[\\/]/).pop(), subject: subj });
    }
  }
}

function main() {
  const repos = discoverRepos();
  const agg = { commitCount: 0, taggedCount: 0, rules: {} };
  for (const r of repos) scanRepo(r, agg);

  const rulesData = Object.keys(agg.rules).sort().map((k) => {
    const b = agg.rules[k];
    const denom = b.catches + b.misses;
    const eff = denom === 0 ? 0 : Math.round((b.catches / denom) * 1000) / 1000;
    return { rule: k, invocations: b.total, catches: b.catches, misses: b.misses, effectiveness: eff, commits: b.commits };
  });
  const byInvocations = rulesData.slice().sort((a, b) => b.invocations - a.invocations);

  if (jsonMode) {
    process.stdout.write(JSON.stringify({
      ts: utcStamp(), since, repos_scanned: repos.length, commits_total: agg.commitCount,
      commits_tagged: agg.taggedCount, rules: rulesData,
    }) + '\n');
    return;
  }

  // Always append the scan summary to factory_metrics.jsonl (never throws).
  appendJsonl(metricsPath, {
    ts: utcStamp(), event: 'outcome_scan', since, repos_scanned: repos.length,
    commits_total: agg.commitCount, commits_tagged: agg.taggedCount, rules_with_data: rulesData.length,
    top_rules: byInvocations.slice(0, 5).map((r) => ({ rule: r.rule, invocations: r.invocations, effectiveness: r.effectiveness })),
  });

  const cov = agg.commitCount > 0 ? Math.round((agg.taggedCount / agg.commitCount) * 1000) / 10 : 0;
  process.stdout.write(`\n==== Outcome scan (since ${since}) ====\n  Repos scanned : ${repos.length}\n  Commits seen  : ${agg.commitCount}\n  Tagged commits: ${agg.taggedCount} (${cov}% coverage)\n  Rules w/ data : ${rulesData.length}\n`);
  for (const r of byInvocations.slice(0, 10)) process.stdout.write(`    ${r.rule.padEnd(30)}  invocations=${String(r.invocations).padStart(3)}  effectiveness=${r.effectiveness}\n`);

  if (!writeReport) { process.stdout.write('\n(--no-report: docs/factory-effectiveness.md not written)\n'); return; }

  const now = new Date().toISOString().slice(0, 10);
  let report = `# Factory effectiveness report

> _Generated: ${now} from git log across ${repos.length} repos, window: ${since}._
> _Source: scripts/extract-rule-outcomes.mjs (Node twin of the .ps1)._

## Coverage

- Repos scanned: ${repos.length}
- Commits in window: ${agg.commitCount}
- Commits tagged with [rule: X]: ${agg.taggedCount}
- Tag coverage: ${cov}%

${cov < 5 ? '> **Tag coverage is low.** Effectiveness needs `[rule:]`/`[outcome:]` tags on commits that uphold or fix a rule -- see "How to tag" below. Until coverage rises, the per-rule table stays sparse and the architect-first 0.9 effectiveness target has no data.\n' : ''}
## Per-rule outcomes

| Rule | Invocations | Catches | Misses | Effectiveness |
|---|---:|---:|---:|---:|
`;
  if (rulesData.length === 0) {
    report += '| _(no tagged commits in window)_ |  |  |  |  |\n';
  } else {
    for (const r of byInvocations) report += `| \`${r.rule}\` | ${r.invocations} | ${r.catches} | ${r.misses} | ${r.effectiveness} |\n`;
  }
  report += `

## How to tag commits

Add to the commit body (not the subject):

\`\`\`
fix(api): handle null tenant on lookup

[rule: VIBE-35]
[outcome: PREVENTED]
\`\`\`

- \`[rule: VIBE-35]\` -- the rule that prevented worse / drove this fix (multiple allowed: \`[rule: VIBE-2] [rule: VIBE-44]\`)
- \`[outcome: PREVENTED]\` -- the rule caught this class of bug at design time (default)
- \`[outcome: MISSED]\` -- the rule SHOULD have caught it but didn't -- candidate for strengthening

## Caveats

- Low effectiveness = the rule is invoked but not catching the bug -- candidate for strengthening.
- High invocations + high effectiveness = the rule is earning its token cost.
- Zero invocations may mean untriggered (not ineffective) -- reviewed at the quarterly rule-decay scan.
- This report is descriptive, not prescriptive -- proposing rule changes is the synthesizer's job.
`;

  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, report, 'utf8');
  process.stdout.write(`\n[OK] Wrote ${reportPath}\n`);
}

main();
