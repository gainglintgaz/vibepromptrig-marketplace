// adopt-shared.mjs -- shared helpers for forge adopt targets (walk, wiring, rel paths).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

export const DRIFT_TO_VERDICT = { absent: 'ADD', unchanged: 'KEEP', upgrade: 'UPGRADE', diverged: 'DIVERGED' };
export const VERDICT_ORDER = ['ADD', 'UPGRADE', 'DIVERGED', 'MISWIRED', 'KEEP'];

export function relPosix(root, abs) { return relative(root, abs).split(sep).join('/'); }

export function walkFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

export function listArtifactsUnder(factoryRoot, relDir, { extFilter = null } = {}) {
  const abs = join(factoryRoot, ...relDir.split('/'));
  const out = [];
  for (const f of walkFiles(abs)) {
    const relPath = relPosix(factoryRoot, f);
    if (extFilter && !relPath.toLowerCase().endsWith(extFilter)) continue;
    out.push({ relPath, content: readFileSync(f, 'utf8') });
  }
  return out;
}

export function gitConfigHooksPath(projectRoot) {
  const r = spawnSync('git', ['-C', projectRoot, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}

export function checkGitHooksWiring(projectRoot, factoryRoot, nextId) {
  const items = [];
  const isGit = existsSync(join(projectRoot, '.git'));
  if (!isGit) {
    items.push({ id: nextId(), relPath: '(repo)', verdict: 'MISWIRED', kind: 'MECHANICAL',
      note: 'Not a git repository -- no recovery floor for --apply. Run `git init` before applying.' });
    return items;
  }
  const ghPresent = existsSync(join(projectRoot, '.githooks'));
  const huskyPresent = existsSync(join(projectRoot, '.husky'));
  const hooksPath = gitConfigHooksPath(projectRoot);
  const factoryHooks = existsSync(join(factoryRoot, 'scripts', 'templates', 'shared', '.githooks'));
  if (ghPresent && hooksPath !== '.githooks') {
    items.push({ id: nextId(), relPath: '.githooks/', verdict: 'MISWIRED', kind: 'MECHANICAL',
      note: `.githooks/ present but core.hooksPath is '${hooksPath || '(unset)'}' -- gates are INERT until it points at .githooks.` });
  }
  if (huskyPresent && hooksPath !== '.githooks') {
    items.push({ id: nextId(), relPath: '.husky/', verdict: 'MISWIRED', kind: 'MECHANICAL',
      note: '.husky/ detected -- adopt will NOT hijack core.hooksPath; merge .githooks gates into .husky/ manually.' });
  }
  if (!ghPresent && !huskyPresent && factoryHooks) {
    items.push({ id: nextId(), relPath: '.githooks/', verdict: 'ADD', kind: 'MECHANICAL',
      note: 'Factory ships the .githooks gate pack; this project has none. --apply can add + wire it.' });
  }
  return items;
}

export function summarize(items) {
  const summary = {};
  for (const v of VERDICT_ORDER) summary[v] = items.filter((i) => i.verdict === v).length;
  return summary;
}
