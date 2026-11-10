#!/usr/bin/env node
// Node >=18. No dependencies. Age is the .git entry's modification age, not a deletion gate.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

function git(root, args, allowFalse = false) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.error || (result.status !== 0 && !(allowFalse && result.status === 1))) {
    throw new Error(`git ${args[0]} failed (exit ${result.status}): ${result.error?.message || result.stderr.trim()}`);
  }
  return result;
}

function contains(parent, child) {
  const rel = relative(parent, child);
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

function existingPath(path) {
  try { return realpathSync(path); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
}

function originRepo(origin) {
  try {
    const url = new URL(origin);
    if (!['https:', 'http:', 'ssh:'].includes(url.protocol)) return null;
    const repo = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
    return /^[\w.-]+\/[\w.-]+$/.test(repo) ? `${url.hostname}/${repo}` : null;
  } catch {
    const scp = origin.match(/^git@([\w.-]+):([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
    return scp ? `${scp[1]}/${scp[2]}` : null;
  }
}

function trunkRef(root) {
  const symbolic = git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], true).stdout.trim();
  const candidates = [...new Set([symbolic, 'refs/remotes/origin/main', 'refs/remotes/origin/master'].filter(Boolean))];
  for (const ref of candidates) {
    if (!ref.startsWith('refs/remotes/origin/')) continue;
    if (git(root, ['show-ref', '--verify', '--quiet', ref], true).status === 0) return ref.replace('refs/remotes/', '');
  }
  throw new Error('No supported remote trunk ref; fetch origin and set origin/HEAD');
}

function changedPathsEqual(root, head, base, paths) {
  // Stay well below Windows' 32767 UTF-16-unit limit, including quoting and fixed arguments.
  let batch = [], size = 0;
  const quiet = () => git(root, ['diff', '--quiet', head, base, '--', ...batch], true).status === 0;
  for (const path of paths) {
    const spec = `:(literal)${path}`, cost = spec.length * 2 + 4;
    if (cost > 8000) throw new Error('Changed path exceeds the safe command-line budget');
    if (size + cost > 8000) { if (!quiet()) return false; batch = []; size = 0; }
    batch.push(spec); size += cost;
  }
  return batch.length > 0 && quiet();
}

// Exported injection point lets fixture tests exercise the full CLI without GitHub access.
export function run({ gh = spawnSync } = {}) {
  let root = process.cwd();
  let apply = false;
  let mode;
  let allowGithub = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1] && !args[i + 1].startsWith('--')) root = args[++i];
    else if (args[i] === '--github') allowGithub = true;
    else if (args[i] === '--apply' || args[i] === '--dry-run') {
      if (mode && mode !== args[i]) throw new Error('Choose --apply or --dry-run, not both');
      mode = args[i]; apply = mode === '--apply';
    } else if (args[i] === '--help') {
      console.log('Usage: node scripts/worktree-retire.mjs [--root <path>] [--dry-run | --apply] [--github]\nDry-run is the default. Clean excludes tracked, untracked AND ignored changes. Resolves local origin/HEAD, origin/main, then origin/master; fetch before review.\n--github explicitly permits authenticated GitHub lookup, including disclosure of local branch names. Offline equality is evidence only; exact HEAD merge proof is required to retire. Configured state apply is refused until a shared lease-writer lock protocol is available.');
      return;
    } else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  root = realpathSync(git(resolve(root), ['rev-parse', '--show-toplevel']).stdout.trim());
  const cwd = realpathSync(process.cwd());
  const trunk = trunkRef(root);
  const base = git(root, ['rev-parse', '--verify', `${trunk}^{commit}`]).stdout.trim();
  console.log(`Trunk ref: ${trunk}`);
  const records = git(root, ['worktree', 'list', '--porcelain', '-z']).stdout.split('\0\0').filter(Boolean);
  const entries = records.map(record => {
    const fields = Object.fromEntries(record.split('\0').filter(Boolean).map(line => {
      const space = line.indexOf(' ');
      return space < 0 ? [line, true] : [line.slice(0, space), line.slice(space + 1)];
    }));
    return { path: fields.worktree, branch: fields.branch?.replace(/^refs\/heads\//, '') || '(detached)', fields };
  });
  const repo = allowGithub ? originRepo(git(root, ['config', '--get', 'remote.origin.url'], true).stdout.trim()) : null;
  const prCache = new Map();
  function mergedRule(head, branch) {
    if (git(root, ['merge-base', '--is-ancestor', head, base], true).status === 0) return 'ancestor';
    let prs = null;
    if (allowGithub && repo && branch !== '(detached)') {
      if (!prCache.has(branch)) {
        const result = gh('gh', ['pr', 'list', '--repo', repo, '--head', branch, '--base', trunk.slice('origin/'.length),
          '--state', 'merged', '--limit', '1000', '--json', 'headRefOid'], { encoding: 'utf8', timeout: 30000 });
        if (!result.error && result.status === 0) {
          const parsed = JSON.parse(result.stdout);
          if (!Array.isArray(parsed) || parsed.some(pr => typeof pr.headRefOid !== 'string')) throw new Error('Invalid merged PR response');
          prCache.set(branch, parsed);
        } else {
          prCache.set(branch, null);
          allowGithub = false;
          console.log('GitHub unavailable; further lookups disabled for this run');
        }
      }
      prs = prCache.get(branch);
    }
    if (prs !== null) return prs.some(pr => pr.headRefOid === head) ? 'merged PR exact HEAD' : null;
    // Offline fallback compares BOTH sides of renames/deletions with literal pathspecs.
    const fork = git(root, ['merge-base', head, base]).stdout.trim();
    const paths = git(root, ['diff', '--name-only', '--no-renames', '-z', fork, head]).stdout.split('\0').filter(Boolean);
    if (!paths.length) return null;
    return changedPathsEqual(root, head, base, paths)
      ? 'offline changed-path equality' : null;
  }
  const lexicalKey = path => resolve(path.replaceAll('\\', '/')).replaceAll('\\', '/').toLowerCase();
  const canonicalPaths = entries.filter(entry => !entry.fields.prunable).map(entry => existingPath(entry.path)).filter(Boolean);
  function pathKey(path) {
    // Use the listed spelling for case-insensitive lease paths on case-sensitive hosts.
    const listed = canonicalPaths.find(candidate => lexicalKey(candidate) === lexicalKey(path));
    return realpathSync(listed || path.replaceAll('\\', '/')).replaceAll('\\', '/').toLowerCase();
  }
  const stateRoot = process.env.VF_STATE_ROOT;
  if (!stateRoot) console.log('lease check skipped: VF_STATE_ROOT unset');
  function leaseReason(path) {
    if (!stateRoot) return null;
    const state = JSON.parse(readFileSync(join(stateRoot, 'STATE.json'), 'utf8'));
    if (!Array.isArray(state.tasks)) throw new Error('Invalid STATE.json: tasks must be an array');
    for (const task of state.tasks) {
      if (!task.lease) continue;
      const { by, until, worktree } = task.lease;
      if (typeof by !== 'string' || typeof task.id !== 'string' || typeof worktree !== 'string' ||
          typeof until !== 'string' || !Number.isFinite(Date.parse(until))) throw new Error('Invalid STATE.json task lease');
      if (Date.parse(until) <= Date.now()) continue;
      let key;
      try { key = pathKey(isAbsolute(worktree.replaceAll('\\', '/')) ? worktree : join(stateRoot, worktree)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (key === pathKey(path)) return `leased by ${by} for ${task.id}; release via forge state`;
    }
    return null;
  }
  function inspect(entry, index) {
    // Git may retain registrations for directories that no longer exist. Never prune them here.
    const path = entry.fields.prunable ? null : existingPath(entry.path);
    if (!path) return { path: entry.path, branch: entry.branch, merged: null, rule: null, clean: null,
      ageDays: null, reason: 'prunable (directory missing)' };
    const head = git(path, ['rev-parse', 'HEAD']).stdout.trim();
    const rule = mergedRule(head, entry.branch);
    const merged = rule === 'ancestor' || rule === 'merged PR exact HEAD';
    const clean = !git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored', '--ignore-submodules=none']).stdout;
    const ageDays = Math.max(0, Math.floor((Date.now() - statSync(join(path, '.git')).mtimeMs) / 86400000));
    const reason = leaseReason(path) || (index === 0 ? 'main worktree' : path === root || contains(path, cwd) ? 'current worktree'
      : entry.fields.locked ? 'locked worktree' : entry.fields.prunable ? 'prunable worktree'
        : rule === 'offline changed-path equality' ? 'offline HEAD not proven merged'
          : !merged ? 'unmerged' : !clean ? 'dirty (including untracked/ignored files)'
            : apply && stateRoot ? 'state lock protocol unavailable; retirement refused' : null);
    return { path: entry.path, branch: entry.branch, merged, rule, clean, ageDays, reason };
  }
  // Inspect every candidate before making any change. Any Git error aborts the batch.
  const rows = entries.map(inspect);
  console.table(rows.map(row => ({ path: row.path, branch: row.branch,
    [`merged into ${trunk}`]: row.merged === null ? 'unknown' : row.merged ? 'yes' : 'no',
    clean: row.clean === null ? 'unknown' : row.clean ? 'yes' : 'no',
    'merge rule': row.rule || 'none',
    'age days': row.ageDays, verdict: row.reason ? `skip: ${row.reason}` : apply ? 'retire' : 'would retire' })));
  console.log(`Summary: ${rows.length} worktrees; ${rows.filter(row => !row.reason).length} ${apply ? 'retire' : 'would retire'}; ${rows.filter(row => row.reason).length} skipped`);
  if (!apply) return;
  const evidence = join(root, '.forge', 'evidence');
  mkdirSync(evidence, { recursive: true });
  const receiptPath = join(evidence, `worktree-retire-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.json`);
  const receipt = { timestamp: new Date().toISOString(), root, base: trunk, baseCommit: base,
    removed: [], skipped: rows.map(row => ({ path: row.path, reason: row.reason || 'pending' })) };
  const save = () => writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  save(); // Fail before deletion if evidence cannot be written.
  try {
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].reason) continue;
      // Recheck immediately before removal; never force Git past its own safety checks.
      const fresh = inspect(entries[i], i);
      const skipped = receipt.skipped.find(row => row.path === fresh.path);
      if (fresh.reason) { skipped.reason = fresh.reason; save(); continue; }
      skipped.reason = 'removal attempted; outcome unconfirmed';
      save();
      git(root, ['worktree', 'remove', '--', fresh.path]);
      receipt.removed.push({ path: fresh.path });
      receipt.skipped = receipt.skipped.filter(row => row.path !== fresh.path);
      save();
    }
  } catch (error) {
    receipt.error = error.message;
    for (const row of receipt.skipped) if (row.reason === 'pending') row.reason = 'aborted after error';
    save();
    throw error;
  } finally { console.log(`Receipt: ${receiptPath}`); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { run(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
