// dispatch-lib.mjs -- `forge dispatch` worker launcher (HH-ORCH-03 step B). Zero AI inside.
// Justified: launches the locally installed claude/codex CLIs against coord-state/1 tasks; no MCP server or Skill dispatches headless workers under a code-enforced authorization ceiling and budget.
//
// What this protects: no task runs twice, no worker runs without a lane grant from the owner's
// authorization file, the code ceiling (NEVER_GRANTABLE) can never be granted, budgets are charged
// conservatively and unknown usage is never zero, and the owner can stop everything.
// What it does NOT protect: the unelevated Codex sandbox cannot deny reads by absolute path, so a
// Codex worker could read a file such as the root checkout's .env (P1 known gap). The dispatcher
// refuses to launch into a worktree that contains .env* files, which narrows but does not close it.

import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import * as S from './state-lib.mjs';
import { validatePortfolio, inspectRoot as inspectPortfolioRoot } from './portfolio-policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const WORKER_SCRIPT = join(here, 'dispatch-worker.mjs');
export const RUN_LOCK_STALE_MS = 25 * 60_000;
// Worker actions the authorization file may grant. Everything else is refused; NEVER_GRANTABLE is refused even if listed.
export const GRANTABLE = Object.freeze(['read', 'edit-owned-paths', 'run-tests', 'local-commit']);
export const DEFAULT_WORKER_ACTIONS = Object.freeze(['read']);
// Finding 19 (owner-approved disable): worker-written checks run only inside an enforced isolation
// boundary. None exists yet (HH-ORCH-04 S4), so run-tests stays grantable in the file but every
// unattended dispatch that needs it is refused. A tool allowlist or a prompt is not an OS sandbox.
export const DISABLED_ACTIONS = Object.freeze({ 'run-tests': 'run-tests is disabled for unattended workers until an enforced isolated check runner exists (HH-ORCH-04 S4); run those checks supervised' });
export const DEFAULT_PORTFOLIO_TIMEZONE = 'America/New_York';
// Review delta finding 5b: a worker that may edit files can also execute what it wrote (Codex runs
// commands inside its own sandbox, which bounds writes and network but not reads). Until HH-ORCH-04 S4
// provides an enforced isolation boundary, unattended edit workers are refused. Production has no
// switch for this; only tests pass allowEditWorkers to exercise the gated path.
export const EDIT_DISABLED_REASON = 'edit-owned-paths is disabled for unattended workers until an enforced isolation boundary exists (HH-ORCH-04 S4): a worker that can edit can execute its own code';
export const RESULT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['status', 'summary', 'commits', 'checks', 'gaps'],
  properties: {
    status: { type: 'string', enum: ['done', 'blocked'] },
    summary: { type: 'string' },
    commits: { type: 'array', items: { type: 'string' } },
    checks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'passed', 'total'], properties: { name: { type: 'string' }, passed: { type: 'integer' }, total: { type: 'integer' } } } },
    gaps: { type: 'array', items: { type: 'string' } },
  },
});

const fail = (code, message, details) => { throw new S.StateError(code, message, details); };

// ---------------------------------------------------------------------------- locations
export function runtimeDir(env = process.env) {
  if (env.VF_RUNTIME_DIR) return resolve(env.VF_RUNTIME_DIR);
  const base = env.LOCALAPPDATA || join(homedir(), '.local', 'share');
  return join(base, 'VibePromptRig', 'runtime');
}
export function authDir(env = process.env) {
  return env.VF_AUTH_DIR ? resolve(env.VF_AUTH_DIR) : join(homedir(), '.vibepromptrig', 'authorizations');
}
export const stopFile = (rt) => join(rt, 'STOP');

// ---------------------------------------------------------------------------- config
// Project config: <stateRoot>/.forge/dispatch.json. No secrets; caps and CLI paths only.
export function loadConfig(stateRoot) {
  const p = join(stateRoot, '.forge', 'dispatch.json');
  if (!existsSync(p)) fail('NO_CONFIG', `dispatch config missing: ${p}`);
  const c = JSON.parse(readFileSync(p, 'utf8'));
  const errors = [];
  if (!c.project) errors.push('project required');
  if (!Number.isFinite(c.dailyCapMinutes) || c.dailyCapMinutes <= 0) errors.push('dailyCapMinutes must be a positive number (no built-in default)');
  if (!c.timezone) errors.push('timezone required (for example America/New_York)');
  if (!Number.isInteger(c.maxWorkers) || c.maxWorkers < 1) errors.push('maxWorkers must be a positive integer');
  if (!c.worktreesRoot) errors.push('worktreesRoot required');
  if (!c.baseRef) errors.push('baseRef required (for example origin/main)');
  if (!c.agents || typeof c.agents !== 'object') errors.push('agents map required');
  for (const [name, a] of Object.entries(c.agents || {})) {
    if (!['claude-code', 'codex'].includes(a.kind)) errors.push(`agent ${name}: kind must be claude-code or codex`);
    if (!Array.isArray(a.command) || !a.command.length) errors.push(`agent ${name}: command must be a non-empty array (absolute path resolved at config time)`);
    if (a.kind === 'codex' && !['unelevated', 'elevated', 'mxc'].includes(a.sandboxMode)) errors.push(`agent ${name}: sandboxMode must be unelevated, elevated or mxc (no fallback)`);
  }
  if (errors.length) fail('BAD_CONFIG', `dispatch config invalid:\n  - ${errors.join('\n  - ')}`);
  return { testCommands: [], portfolioCapMinutes: null, ...c };
}

// ---------------------------------------------------------------------------- authorization
// S3: a project name becomes a file name, so it is a strict identifier: no separators, dots, drive
// colons, NULs or Windows device names (a plain `con.json` is still the console device on Windows).
export const AUTH_PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DEVICE_NAME_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
export function assertProjectName(project) {
  if (typeof project !== 'string' || !AUTH_PROJECT_RE.test(project) || DEVICE_NAME_RE.test(project)) {
    fail('BAD_PROJECT', `invalid project name ${JSON.stringify(String(project).slice(0, 80))}: use 1-64 letters, digits, '_' or '-', starting with a letter or digit, and not a device name`);
  }
  return project;
}
export function authPath(project, env = process.env) { return join(authDir(env), `${assertProjectName(project)}.json`); }
// A link at the authorization path could point the owner's confirmation at bytes elsewhere.
// S3 repair F2: only a missing entry (ENOENT) is "absent". Links, non-files and inspection failures are
// refused, never reported as absence (existsSync follows links, so a dangling link looked absent).
export function inspectAuthEntry(p) {
  let st;
  try { st = lstatSync(p); }
  catch (e) { if (e.code === 'ENOENT') return 'absent'; fail('BAD_AUTH', `cannot inspect authorization path ${p}: ${e.code || e.message}`); }
  if (st.isSymbolicLink()) fail('BAD_AUTH', `authorization path is a link, which is refused: ${p}`);
  if (!st.isFile()) fail('BAD_AUTH', `authorization path is not a regular file: ${p}`);
  return 'file';
}
export function isLink(p) {
  try { return lstatSync(p).isSymbolicLink(); }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

export function readAuthorization(project, env = process.env) {
  const p = authPath(project, env);
  if (inspectAuthEntry(p) === 'absent') return { present: false, path: p, sha256: null, grants: [], revoked: true };
  const raw = readFileSync(p);
  const sha256 = createHash('sha256').update(raw).digest('hex');
  let doc;
  try { doc = JSON.parse(raw.toString('utf8').replace(/^﻿/, '')); } catch (e) { fail('BAD_AUTH', `authorization file is not valid JSON: ${e.message}`); }
  const grants = [];
  for (const g of doc.grants || []) {
    if (!g || g.revoked) continue;
    const actions = (g.actions || []).filter((a) => GRANTABLE.includes(a)); // ceiling: never-grantable and unknown actions are dropped
    grants.push({ lane: g.lane, actions, grantedBy: g.grantedBy || null, grantedAt: g.grantedAt || null, ignored: (g.actions || []).filter((a) => !GRANTABLE.includes(a)) });
  }
  return { present: true, path: p, sha256, revoked: doc.revoked === true, draft: doc.draft === true, grants };
}

// Lane grant check. Returns the granted action list or a refusal reason.
export function grantFor(auth, task, { allowEditWorkers = false } = {}) {
  if (!auth.present) return { ok: false, reason: `no authorization file at ${auth.path}` };
  if (auth.revoked) return { ok: false, reason: 'authorization file is revoked' };
  if (auth.draft) return { ok: false, reason: 'authorization file is still a DRAFT (the owner removes "draft" and confirms it)' };
  const g = auth.grants.find((x) => x.lane === task.lane);
  if (!g) return { ok: false, reason: `lane ${task.lane} has no grant` };
  const needed = (task.workerActions && task.workerActions.length ? task.workerActions : DEFAULT_WORKER_ACTIONS);
  for (const a of needed) if (S.NEVER_GRANTABLE.includes(a)) return { ok: false, reason: `task asks for never-grantable ${a}` };
  for (const a of needed) if (DISABLED_ACTIONS[a]) return { ok: false, reason: DISABLED_ACTIONS[a] };
  if (needed.includes('edit-owned-paths') && !allowEditWorkers) return { ok: false, reason: EDIT_DISABLED_REASON };
  const missing = needed.filter((a) => !g.actions.includes(a));
  if (missing.length) return { ok: false, reason: `lane ${task.lane} grant lacks ${missing.join(', ')}` };
  return { ok: true, actions: needed };
}

export function renderAuthorizationMd(auth, project) {
  const lines = [`# Worker authorizations: ${project}`, '', `Source: ${auth.path}`, `SHA-256: ${auth.sha256 ?? 'none'}`, `Revoked: ${auth.revoked}`, '',
    'Never grantable, whatever this file says: ' + S.NEVER_GRANTABLE.join(', ') + '.', '', '| Lane | Actions | Granted by | Granted at | Ignored (not grantable) |', '|---|---|---|---|---|'];
  for (const g of auth.grants) lines.push(`| ${g.lane} | ${g.actions.join(', ')} | ${g.grantedBy ?? ''} | ${g.grantedAt ?? ''} | ${g.ignored.join(', ')} |`);
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------- permissions per CLI
// Claude: tool allow/deny lists. Codex: OS sandbox mode + profile. Both derive from granted actions only.
export function claudePermissions(actions, task, cfg, env = process.env) {
  const allow = [], deny = [
    'Bash(git push:*)', 'Bash(gh:*)', 'Bash(curl:*)', 'Bash(wget:*)', 'Bash(schtasks:*)', 'Bash(crontab:*)',
    'Bash(npm install:*)', 'Bash(npx supabase:*)', 'Bash(supabase:*)', 'WebFetch', 'WebSearch',
    'Read(**/.env)', 'Read(**/.env.*)', 'Read(**/*.env)',
  ];
  const ad = authDir(env).replace(/\\/g, '/');
  for (const tool of ['Read', 'Edit', 'Write']) deny.push(`${tool}(${ad}/**)`);
  if (actions.includes('read')) allow.push('Read', 'Glob', 'Grep');
  if (actions.includes('edit-owned-paths')) for (const p of task.paths || []) allow.push(`Edit(${p})`, `Write(${p})`);
  if (actions.includes('run-tests')) for (const t of cfg.testCommands || []) allow.push(`Bash(${t}:*)`);
  if (actions.includes('local-commit')) allow.push('Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git add:*)', 'Bash(git commit:*)');
  return { allow, deny };
}
export function codexSandbox(actions) {
  const writes = actions.includes('edit-owned-paths');
  return { sandbox: writes ? 'workspace-write' : 'read-only', profile: writes ? ':workspace' : ':read-only' };
}

export function buildCommand({ agentCfg, actions, task, cfg, worktree, resultFile, schemaFile, env = process.env }) {
  if (agentCfg.kind === 'claude-code') {
    const perm = claudePermissions(actions, task, cfg, env);
    return { argv: [...agentCfg.command, '-p', '--output-format', 'json', '--permission-mode', 'dontAsk', '--allowedTools', ...perm.allow, '--disallowedTools', ...perm.deny], cwd: worktree, resultMode: 'claude-json', perm };
  }
  const sb = codexSandbox(actions);
  return {
    argv: [...agentCfg.command, 'exec', '-C', worktree, '-s', sb.sandbox, '-c', `windows.sandbox="${agentCfg.sandboxMode}"`, '--output-schema', schemaFile, '-o', resultFile, '-'],
    cwd: worktree, resultMode: 'codex-file', sandbox: sb,
  };
}

// ---------------------------------------------------------------------------- CLI resolution
// Resolve an agent CLI once, at config time, to an absolute command that spawns without a shell
// (P2: PATH and auth inside scheduled runs). Windows npm shims (.cmd) cannot be spawned without a
// shell, and a shell would also re-interpret worker arguments, so the shim's Node entry is used.
export function resolveAgentCommand(kind, { env = process.env } = {}) {
  const exe = kind === 'codex' ? 'codex' : 'claude';
  const pathExt = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of String(env.PATH || env.Path || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)) {
    for (const ext of pathExt) {
      const candidate = join(dir, exe + ext);
      if (!existsSync(candidate)) continue;
      if (/\.exe$/i.test(candidate) || (process.platform !== 'win32' && ext === '')) return [resolve(candidate)];
      if (/\.cmd$/i.test(candidate)) {
        const js = kind === 'codex' ? join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
        if (existsSync(js)) return [process.execPath, resolve(js)];
      }
    }
  }
  fail('NO_CLI', `${exe} was not found on PATH as a directly spawnable executable`);
}

// ---------------------------------------------------------------------------- preflight (no model calls)
export function preflight(agentCfg, { run = spawnSync } = {}) {
  const opts = { encoding: 'utf8', windowsHide: true, timeout: 60_000 };
  const [cmd, ...pre] = agentCfg.command;
  if (agentCfg.kind === 'codex') {
    const login = run(cmd, [...pre, 'login', 'status'], opts);
    if (login.status !== 0 || !/logged in/i.test(`${login.stdout}${login.stderr}`)) return { ok: false, reason: `codex login status: ${`${login.stdout}${login.stderr}`.trim() || `exit ${login.status}`}` };
    const sb = run(cmd, [...pre, '-c', `windows.sandbox="${agentCfg.sandboxMode}"`, 'sandbox', '-P', ':read-only', '--', ...(process.platform === 'win32' ? ['cmd.exe', '/d', '/c', 'echo', 'OK'] : ['sh', '-c', 'echo OK'])], opts);
    if (sb.status !== 0 || !/OK/.test(sb.stdout || '')) return { ok: false, reason: `codex sandbox preflight (${agentCfg.sandboxMode}) failed: ${`${sb.stdout}${sb.stderr}`.trim().slice(0, 300)}` };
    return { ok: true, mode: agentCfg.sandboxMode };
  }
  const st = run(cmd, [...pre, 'auth', 'status'], opts);
  let logged = false;
  try { logged = JSON.parse(st.stdout || '{}').loggedIn === true; } catch { logged = /"loggedIn":\s*true/.test(st.stdout || ''); }
  if (st.status !== 0 || !logged) return { ok: false, reason: 'claude auth status: not logged in (run `claude auth login` or `/login` in an interactive claude)' };
  return { ok: true };
}

// ---------------------------------------------------------------------------- process liveness
export function processStartMs(pid, { run = spawnSync, platform = process.platform } = {}) {
  if (platform === 'win32') {
    const r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    const t = Date.parse((r.stdout || '').trim());
    return Number.isFinite(t) ? t : null;
  }
  const id = Number(pid);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  let r;
  try {
    r = run('ps', ['-o', 'lstart=', '-p', String(id)], { encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' }, timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 1024 });
  } catch { return null; }
  if (r.error || r.status !== 0 || r.signal) return null;
  // lstart has no zone or subsecond precision. Force UTC at the query and parse it explicitly;
  // this diagnostic timestamp is not a native process-handle capability or exact stop proof.
  const m = String(r.stdout || '').trim().match(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/);
  if (!m) return null;
  const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(m[2]);
  const [day, hour, minute, second, year] = m.slice(3).map(Number);
  const t = Date.UTC(year, month, day, hour, minute, second);
  const d = new Date(t);
  return t > 0 && d.getUTCFullYear() === year && d.getUTCMonth() === month && d.getUTCDate() === day
    && d.getUTCHours() === hour && d.getUTCMinutes() === minute && d.getUTCSeconds() === second
    && ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()] === m[1] ? t : null;
}
// Review delta finding 3: find a worker wrapper by the spec file on its command line, for a run whose
// PID was never saved and whose wrapper has not written exit.json yet. Returns {pid, startedMs}, or null
// when no such process exists; throws when the process table cannot be read (unknown liveness).
export function findWrapper(specFile, { run = spawnSync } = {}) {
  const needle = String(specFile).replace(/\\/g, '/').toLowerCase();
  if (process.platform === 'win32') {
    const ps = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.CreationDate.ToUniversalTime().ToString('o'), $_.CommandLine }";
    const r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    if (r.status !== 0) throw new Error(`process table unreadable: ${(r.stderr || '').trim().slice(0, 200)}`);
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const [pid, start, ...cmd] = line.split('|');
      if (pid && cmd.join('|').replace(/\\/g, '/').toLowerCase().includes(needle)) return { pid: Number(pid), startedMs: Date.parse(start) || null };
    }
    return null;
  }
  const r = run('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('process table unreadable');
  for (const line of String(r.stdout || '').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (m && m[2].replace(/\\/g, '/').toLowerCase().includes(needle)) return { pid: Number(m[1]), startedMs: processStartMs(Number(m[1])) };
  }
  return null;
}

// Lock recovery needs positive death evidence; failed identity lookup is not death.
export function processLiveness({ pid, startedAtMs }, { probe = (p) => process.kill(p, 0), startOf = processStartMs } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: 'unknown', reason: 'invalid PID' };
  try { probe(pid); }
  catch (e) { return e.code === 'ESRCH' ? { state: 'dead', reason: 'PID absent' } : { state: 'unknown', reason: 'PID lookup unavailable' }; }
  let start;
  try { start = startOf(pid); } catch { return { state: 'unknown', reason: 'process identity lookup failed' }; }
  if (!Number.isFinite(start) || !Number.isFinite(startedAtMs) || start <= 0 || startedAtMs <= 0) return { state: 'unknown', reason: 'process identity unavailable' };
  return Math.abs(start - startedAtMs) < 10_000 ? { state: 'live' } : { state: 'dead', reason: 'PID reused' };
}

// Alive means the PID exists AND its start time matches the recorded one (PID reuse safe).
export function isAlive({ pid, startedAtMs }, { startOf = processStartMs } = {}) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  const s = startOf(pid);
  if (s === null) return false;
  return !startedAtMs || Math.abs(s - startedAtMs) < 10_000;
}
// Success means the process is gone afterwards: taskkill can exit non-zero when a child exits
// mid-kill even though the tree is dead, and can exit zero before the process has fully ended.
export function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
  else { try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone: verified below */ } } }
  const gone = () => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } };
  const until = Date.now() + 5000;
  while (!gone() && Date.now() < until) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},100)']);
  return gone();
}

// ---------------------------------------------------------------------------- ledger (node:sqlite, decision D-RT1)
async function sqliteModule() {
  const original = process.emitWarning;
  process.emitWarning = (w, ...a) => (String(w?.message ?? w).includes('SQLite') ? undefined : original.call(process, w, ...a));
  try { return await import('node:sqlite'); }
  catch (e) { fail('NO_SQLITE', `node:sqlite failed to load (${e.message}); dispatch needs Node >= 22.13; BLOCKED by design, no fallback store`); }
  finally { process.emitWarning = original; }
}
// Dry runs, status and the coordinator read a temporary snapshot and never write the runtime folder.
// Findings 11/13: the old code copied ledger.db and its -wal file separately, which can tear if a
// checkpoint runs between the two copies. Now:
//  - a WAL file exists (a writer is or was active): SQLite's online backup API takes a transactionally
//    consistent snapshot through a read-only connection; -wal/-shm already exist, so nothing new is made;
//  - no WAL file (quiet ledger): in WAL mode the main file changes only during a checkpoint, which needs
//    a WAL file, so the main file is copied and the copy is accepted only if the WAL is still absent and
//    the main file's size and mtime are unchanged afterwards (retried, then BUSY).
export async function openLedgerCopy(rt, { attempts = 5 } = {}) {
  const mod = await sqliteModule();
  const tmp = mkdtempSync(join(tmpdir(), 'vf-ledger-'));
  const snap = join(tmp, 'ledger.db');
  const src = join(rt, 'ledger.db'), wal = join(rt, 'ledger.db-wal');
  let method = 'empty';
  try {
    if (existsSync(src)) {
      for (let i = 0; ; i += 1) {
        if (existsSync(wal)) {
          const ro = new mod.DatabaseSync(src, { readOnly: true });
          try { await mod.backup(ro, snap); } finally { ro.close(); }
          method = 'backup-api';
          break;
        }
        const before = statSync(src);
        copyFileSync(src, snap);
        const after = statSync(src);
        if (!existsSync(wal) && before.size === after.size && before.mtimeMs === after.mtimeMs) { method = 'quiet-copy-verified'; break; }
        rmSync(snap, { force: true });
        if (i + 1 >= attempts) fail('LEDGER_BUSY', 'could not take a consistent ledger snapshot; retry');
      }
    }
  } catch (e) { rmSync(tmp, { recursive: true, force: true }); throw e; }
  const db = new mod.DatabaseSync(snap);
  initLedger(db);
  db.snapshotMethod = method;
  const close = db.close.bind(db);
  db.close = () => { close(); rmSync(tmp, { recursive: true, force: true }); };
  return db;
}
export async function openLedger(rt) {
  mkdirSync(rt, { recursive: true });
  const mod = await sqliteModule();
  const db = new mod.DatabaseSync(join(rt, 'ledger.db'));
  initLedger(db);
  return db;
}
function initLedger(db) {
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, project TEXT NOT NULL, task TEXT NOT NULL, agent TEXT NOT NULL, worktree TEXT NOT NULL,
      pid INTEGER, started_at TEXT NOT NULL, started_ms INTEGER NOT NULL, timebox_min INTEGER NOT NULL,
      status TEXT NOT NULL, exit_at TEXT, exit_code INTEGER, charged_min REAL, charge_basis TEXT,
      cost_usd REAL, cost_basis TEXT, result_path TEXT, sandbox_mode TEXT, day TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS one_running_per_task ON runs(project, task) WHERE status = 'running';
    CREATE TABLE IF NOT EXISTS auth_hashes (project TEXT NOT NULL, sha256 TEXT NOT NULL, seen_at TEXT NOT NULL, confirmed_at TEXT, PRIMARY KEY (project, sha256));
    CREATE TABLE IF NOT EXISTS preflights (project TEXT NOT NULL, agent TEXT NOT NULL, at TEXT NOT NULL, ok INTEGER NOT NULL, detail TEXT);`);
  const cols = db.prepare('PRAGMA table_info(runs)').all().map((c) => c.name);
  if (!cols.includes('actions')) db.exec('ALTER TABLE runs ADD COLUMN actions TEXT');
  if (!cols.includes('base_sha')) db.exec('ALTER TABLE runs ADD COLUMN base_sha TEXT'); // finding 6: pinned at launch
}

// Budget admission uses the same strict enrollment decision as the shadow caller.
// Missing policy fields, refused entries or an empty portfolio grant no budget or slots.
export function readPortfolio(rt) {
  const p = join(rt, 'portfolio.json');
  const present = existsSync(p);
  let doc = null;
  if (present) { try { doc = JSON.parse(readFileSync(p, 'utf8')); } catch { /* invalid policy, no fallback */ } }
  const result = validatePortfolio(doc);
  const errors = [...result.errors, ...result.refused.map(e => `entry #${e.index + 1}: ${e.reason}`)];
  if (!result.entries.length) errors.push('at least one explicit project enrollment is required');
  for (const field of ['capMinutes', 'maxWorkers', 'timezone']) {
    if (result.policy[field] === null) errors.push(`${field} is required for budget admission`);
  }
  const valid = errors.length === 0;
  return { path: p, present, valid, errors, entries: result.entries, version: result.policy.version,
    capMinutes: valid ? result.policy.capMinutes : null,
    maxWorkers: valid ? result.policy.maxWorkers : null,
    timezone: valid ? result.policy.timezone : null };
}
export function dayKey(ms, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

// Conservative elapsed-time charging. Running workers count at their full reserved timebox.
export function usedMinutes(db, { project = null, day }) {
  const rows = project
    ? db.prepare('SELECT id,status,timebox_min,charged_min FROM runs WHERE project=? AND day=?').all(project,day)
    : db.prepare('SELECT id,status,timebox_min,charged_min FROM runs WHERE day=?').all(day);
  const claims=hasRelay(db)?(project?db.prepare('SELECT * FROM relay_claims WHERE project=?').all(project):db.prepare('SELECT * FROM relay_claims').all()):[];
  const byRun=new Map(claims.filter(r=>r.run_id).map(r=>[r.run_id,r]));
  const legacy=rows.reduce((sum,r)=>{
    const claim=byRun.get(r.id);
    // Ownership is independent of settled financial usage. Unknown usage keeps
    // the full cap; a trusted settlement records actual usage, including overruns.
    if(claim&&claim.financial_held===0&&claim.financial_proof)return sum+Number(claim.charged_min);
    return sum+(['running','relay_running','relay_unknown'].includes(r.status)?Math.max(r.timebox_min,Number(r.charged_min??r.timebox_min)):Number(r.charged_min??r.timebox_min));
  },0);
  const pending=claims.reduce((sum,r)=>sum+(!r.run_id?(r.financial_held?r.cap:(r.day===day?Number(r.charged_min??r.cap):0)):(r.financial_held&&r.day!==day?r.cap:0)),0);
  return legacy+pending;
}

// ---------------------------------------------------------------------------- run lock
// One dispatch run per project at a time (F5 shape: wx lockfile, stale after 25 min). Async-safe:
// the lock is released only after fn's promise settles.
export async function withRunLock(rt, project, fn, { now = () => Date.now() } = {}) {
  const lp = join(rt, `${project}.run.lock`);
  mkdirSync(rt, { recursive: true });
  let fd;
  try { fd = openSync(lp, 'wx'); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let h = null; try { h = JSON.parse(readFileSync(lp, 'utf8')); } catch { h = null; }
    const started = Date.parse(h?.startedAt) || statSync(lp).mtimeMs;
    if (now() - started < RUN_LOCK_STALE_MS) return { skipped: true, reason: `another dispatch run holds the lock (pid ${h?.pid ?? '?'})` };
    rmSync(lp, { force: true });
    fd = openSync(lp, 'wx');
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date(now()).toISOString() }));
    closeSync(fd); fd = undefined;
    return await fn();
  } finally { if (fd !== undefined) closeSync(fd); rmSync(lp, { force: true }); }
}

// ---------------------------------------------------------------------------- results
export function parseResult(mode, outText, resultFileText) {
  let candidate = null, cost = null;
  if (mode === 'codex-file') candidate = resultFileText;
  else {
    let outer;
    try { outer = JSON.parse(outText); } catch { return { ok: false, reason: 'claude output is not JSON' }; }
    const text = String(outer.result ?? '');
    const fence = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].pop();
    candidate = fence ? fence[1] : text;
    cost = Number.isFinite(outer.total_cost_usd) ? outer.total_cost_usd : null;
  }
  let r;
  try { r = JSON.parse(String(candidate ?? '').trim()); } catch { return { ok: false, reason: 'structured result missing or not JSON' }; }
  const bad = [];
  if (!['done', 'blocked'].includes(r?.status)) bad.push('status');
  if (typeof r?.summary !== 'string') bad.push('summary');
  if (!Array.isArray(r?.commits)) bad.push('commits');
  if (!Array.isArray(r?.checks) || r.checks.some((c) => !c || typeof c.name !== 'string' || !Number.isInteger(c.passed) || !Number.isInteger(c.total) || c.total < 1 || c.passed < 0 || c.passed > c.total)) bad.push('checks (each needs 0 <= passed <= total, total >= 1)');
  if (!Array.isArray(r?.gaps)) bad.push('gaps');
  if (bad.length) return { ok: false, reason: `structured result invalid: ${bad.join(', ')}` };
  return { ok: true, result: r, costUsd: cost };
}

// ---------------------------------------------------------------------------- worktree
export function envFilesUnder(dir, limit = 20000) {
  const found = [], stack = [dir];
  let seen = 0;
  while (stack.length && seen < limit) {
    const d = stack.pop();
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      seen += 1;
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (S.isEnvPath(e.name)) found.push(p);
    }
  }
  return found;
}

export function ensureWorktree({ stateRoot, cfg, task, git = spawnSync }) {
  const name = String(task.id).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  const wt = join(cfg.worktreesRoot, `${cfg.project}-${name}`);
  const branch = task.branch || `${task.owner === 'codex' ? 'codex' : 'claude'}/${name}`;
  const g = (dir, args) => git('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
  if (!existsSync(wt)) {
    const r = g(stateRoot, ['-c', 'core.longpaths=true', 'worktree', 'add', '-b', branch, wt, cfg.baseRef]);
    if (r.status !== 0) fail('WORKTREE_FAILED', `git worktree add failed: ${(r.stderr || '').trim()}`);
    return { worktree: wt, branch };
  }
  const top = g(wt, ['rev-parse', '--show-toplevel']), common = g(wt, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const rootCommon = g(stateRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']), cur = g(wt, ['branch', '--show-current']);
  const same = (a, b) => S.pathKey(a) === S.pathKey(b);
  if (top.status !== 0 || !same(top.stdout.trim(), wt)) fail('WORKTREE_MISMATCH', `${wt} exists but is not a git worktree root`);
  if (common.status !== 0 || rootCommon.status !== 0 || !same(common.stdout.trim(), rootCommon.stdout.trim())) fail('WORKTREE_MISMATCH', `${wt} belongs to a different repository than ${stateRoot}`);
  if (cur.stdout.trim() !== branch) fail('WORKTREE_MISMATCH', `${wt} is on branch ${cur.stdout.trim() || '(detached)'}, expected ${branch}`);
  return { worktree: wt, branch };
}

// ---------------------------------------------------------------------------- owned-path gate
// Every file a worker changed (committed since the base pinned at launch, staged, unstaged or untracked)
// must be inside the task's owned paths. Code enforces the lane; the prompt only describes it.
// Finding 6: the base is the full SHA recorded at launch, never a ref resolved at collection.
// Finding 8: --no-renames, so a rename is a deletion of the old path plus an addition of the new one.
// Finding 12: -z output, so quoted or unusual file names are read exactly.
export function changedFiles(worktree, baseSha, git = spawnSync) {
  if (!/^[0-9a-f]{40}$/.test(String(baseSha || ''))) fail('NO_BASE', `no base SHA pinned for ${worktree}; refusing to guess the comparison point`);
  const g = (args) => git('git', ['-C', worktree, ...args], { encoding: 'utf8', windowsHide: true });
  const tracked = g(['diff', '--name-only', '--no-renames', '-z', baseSha]);
  const untracked = g(['ls-files', '-z', '--others', '--exclude-standard']);
  if (tracked.status !== 0 || untracked.status !== 0) fail('GIT_FAILED', `git could not list changes in ${worktree}: ${(tracked.stderr || untracked.stderr || '').trim()}`);
  const items = (t) => t.stdout.split('\0').filter(Boolean);
  return { base: baseSha, files: [...new Set([...items(tracked), ...items(untracked)])] };
}

// The base a run is measured against: where the worktree's HEAD meets cfg.baseRef at launch.
export function baseShaAtLaunch(worktree, baseRef, git = spawnSync) {
  const r = git('git', ['-C', worktree, 'merge-base', 'HEAD', baseRef], { encoding: 'utf8', windowsHide: true });
  const sha = r.status === 0 ? r.stdout.trim() : '';
  if (!/^[0-9a-f]{40}$/.test(sha)) fail('NO_BASE', `cannot find merge-base of HEAD and ${baseRef} in ${worktree}: ${(r.stderr || '').trim()}`);
  return sha;
}

// True when the worktree has staged, unstaged or untracked changes.
export function hasUncommitted(worktree, git = spawnSync) {
  const st = git('git', ['-C', worktree, 'status', '--porcelain', '-z'], { encoding: 'utf8', windowsHide: true });
  if (st.status !== 0) fail('GIT_FAILED', `git status failed in ${worktree}`);
  return Boolean(st.stdout.replace(/\0/g, '').trim());
}

// ---------------------------------------------------------------------------- log
export function log(rt, project, line) {
  mkdirSync(rt, { recursive: true });
  appendFileSync(join(rt, 'dispatch.log'), `${new Date().toISOString()} [${project}] ${line}\n`);
}

// ---------------------------------------------------------------------------- launch (detached wrapper)
export function launchWorker({ rt, cfg, task, agentName, agentCfg, actions, worktree, packFile, spawnImpl = spawn, now = Date.now(), env = process.env }) {
  const runId = `${task.id}-${now}`;
  const outDir = join(rt, 'runs', cfg.project, runId);
  mkdirSync(outDir, { recursive: true });
  const schemaFile = join(outDir, 'result.schema.json');
  writeFileSync(schemaFile, JSON.stringify(RESULT_SCHEMA));
  const resultFile = join(outDir, 'result.json');
  const cmd = buildCommand({ agentCfg, actions, task, cfg, worktree, resultFile, schemaFile, env });
  const spec = { runId, argv: cmd.argv, cwd: cmd.cwd, stdinFile: packFile, timeboxMin: task.timeboxMin || cfg.defaultTimeboxMin || 30, outDir, resultMode: cmd.resultMode };
  const specFile = join(outDir, 'spec.json');
  writeFileSync(specFile, JSON.stringify(spec, null, 2));
  const child = spawnImpl(process.execPath, [WORKER_SCRIPT, specFile], { detached: true, stdio: 'ignore', windowsHide: true, cwd: worktree });
  const startedMs = Date.now();
  child.unref?.();
  return { runId, pid: child.pid, startedMs, outDir, spec, cmd };
}

// S7-D ledger primitives only. Trusted controller calls these inside its native
// fence. No CLI/caller admits relay work until dispatcher and phase wiring lands.
const relayTransactions=new WeakSet();
const relayId=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
const relayFail=code=>{throw Object.assign(new Error(code),{code});};
const hasRelay=db=>!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='relay_claims'").get();
function relayWrite(db){if(!relayTransactions.has(db))relayFail('RELAY_TRANSACTION_REQUIRED');}
export function initRelayAccounting(db){db.exec(`PRAGMA synchronous=FULL;
 CREATE TABLE IF NOT EXISTS relay_grants(ref TEXT PRIMARY KEY,epoch TEXT NOT NULL,cap REAL NOT NULL,expires_ms INTEGER NOT NULL,authority_ref TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS relay_claims(claim_id TEXT PRIMARY KEY,intent_key TEXT UNIQUE NOT NULL,intent TEXT NOT NULL,project TEXT NOT NULL,task TEXT NOT NULL,phase TEXT NOT NULL,agent TEXT NOT NULL,binding TEXT NOT NULL,worktree TEXT NOT NULL,input_sha TEXT NOT NULL,cap REAL NOT NULL,grant_ref TEXT NOT NULL,epoch TEXT NOT NULL,generation TEXT NOT NULL,day TEXT NOT NULL,reserved_ms INTEGER NOT NULL,start_before INTEGER NOT NULL,outer_stop INTEGER NOT NULL,status TEXT NOT NULL,capacity_held INTEGER NOT NULL,task_held INTEGER NOT NULL,financial_held INTEGER NOT NULL,delivery_state TEXT NOT NULL,run_id TEXT,charged_min REAL,capacity_proof TEXT,task_proof TEXT,financial_proof TEXT);
 CREATE UNIQUE INDEX IF NOT EXISTS relay_one_task ON relay_claims(project,task) WHERE task_held=1;
 CREATE UNIQUE INDEX IF NOT EXISTS relay_one_worktree ON relay_claims(worktree) WHERE capacity_held=1;`);}
export function relayTransaction(db,fn){db.exec('BEGIN IMMEDIATE');relayTransactions.add(db);try{const r=fn();if(r&&typeof r.then==='function')relayFail('RELAY_SYNC_TRANSACTION');db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}finally{relayTransactions.delete(db);}}
export function recordRelayGrant(db,g){relayWrite(db);if(!g||Object.keys(g).sort().join(',')!=='authorityRef,cap,epoch,expiresAt,ref'||![g.ref,g.epoch,g.authorityRef].every(relayId)||!Number.isFinite(g.cap)||g.cap<=0||!Number.isSafeInteger(g.expiresAt))relayFail('RELAY_GRANT');const old=db.prepare('SELECT * FROM relay_grants WHERE ref=?').get(g.ref);if(old){if(old.epoch!==g.epoch||old.cap!==g.cap||old.expires_ms!==g.expiresAt||old.authority_ref!==g.authorityRef)relayFail('RELAY_GRANT_CONFLICT');return old;}db.prepare('INSERT INTO relay_grants VALUES(?,?,?,?,?)').run(g.ref,g.epoch,g.cap,g.expiresAt,g.authorityRef);return g;}
export function relayHolds(db,{project=null}={}){if(!hasRelay(db))return [];return project?db.prepare('SELECT * FROM relay_claims WHERE project=? AND (capacity_held=1 OR task_held=1 OR financial_held=1)').all(project):db.prepare('SELECT * FROM relay_claims WHERE capacity_held=1 OR task_held=1 OR financial_held=1').all();}
function relayClaim(db,id){const r=db.prepare('SELECT * FROM relay_claims WHERE claim_id=?').get(id);if(!r)relayFail('RELAY_CLAIM_MISSING');return r;}
export function reserveRelayClaim(db,c,limits){relayWrite(db);const names=['claimId','key','project','task','phase','agent','binding','worktree','inputSha','scopePaths','cap','grantRef','epoch','generation','day','now','startBefore','outerStop'];if(!c||Object.keys(c).length!==names.length||names.some(k=>!Object.hasOwn(c,k))||![c.claimId,c.project,c.task,c.agent,c.binding,c.grantRef,c.epoch].every(relayId)||!['build','review'].includes(c.phase)||!/^[a-f0-9]{64}$/.test(c.key)||!/^[a-f0-9]{40}$/.test(c.inputSha)||!/^(0|[1-9][0-9]*)$/.test(c.generation)||!/^\d{4}-\d\d-\d\d$/.test(c.day)||![c.now,c.startBefore,c.outerStop].every(Number.isSafeInteger)||c.now>=c.startBefore||c.startBefore>c.outerStop||!Number.isFinite(c.cap)||c.cap<=0||c.cap>240||!Array.isArray(c.scopePaths)||c.scopePaths.length>100||c.scopePaths.some(p=>typeof p!=='string'||p.length>512))relayFail('RELAY_CLAIM');
 if(!limits||!['projectCap','portfolioCap'].every(k=>Number.isFinite(limits[k])&&limits[k]>0)||!['projectSlots','portfolioSlots'].every(k=>Number.isInteger(limits[k])&&limits[k]>=1&&limits[k]<=16))relayFail('RELAY_LIMITS');
 const root=relayRoot(c.worktree);const intent=JSON.stringify([c.key,c.project,c.task,c.phase,c.agent,c.binding,root,c.inputSha,c.scopePaths,c.cap,c.grantRef,c.epoch,c.generation,c.startBefore,c.outerStop]);const old=db.prepare('SELECT * FROM relay_claims WHERE claim_id=? OR intent_key=?').get(c.claimId,c.key);if(old){if(old.intent!==intent)relayFail('RELAY_INTENT_CONFLICT');return old;}
 const grant=db.prepare('SELECT * FROM relay_grants WHERE ref=?').get(c.grantRef);if(!grant||grant.epoch!==c.epoch||c.now>=grant.expires_ms||c.outerStop>grant.expires_ms)relayFail('RELAY_GRANT');
 const holds=relayHolds(db),native=db.prepare("SELECT * FROM runs WHERE status='running'").all();
 if(holds.some(r=>r.task_held&&r.project===c.project&&r.task===c.task)||native.some(r=>r.project===c.project&&r.task===c.task)||[...holds.filter(r=>r.capacity_held),...native].some(r=>relayRootOverlap(root,r.worktree)))relayFail('RELAY_RESOURCE_HELD');
 const capacity=[...holds.filter(r=>r.capacity_held),...native];if(capacity.length>=limits.portfolioSlots||capacity.filter(r=>r.project===c.project).length>=limits.projectSlots)relayFail('RELAY_CAPACITY_HELD');
 const grantUsed=db.prepare('SELECT coalesce(sum(CASE WHEN financial_held=1 THEN cap ELSE coalesce(charged_min,cap) END),0) n FROM relay_claims WHERE grant_ref=?').get(c.grantRef).n;
 if(grantUsed+c.cap>grant.cap||usedMinutes(db,{day:c.day,project:c.project})+c.cap>limits.projectCap||usedMinutes(db,{day:c.day})+c.cap>limits.portfolioCap)relayFail('RELAY_BUDGET');
 db.prepare("INSERT INTO relay_claims(claim_id,intent_key,intent,project,task,phase,agent,binding,worktree,input_sha,cap,grant_ref,epoch,generation,day,reserved_ms,start_before,outer_stop,status,capacity_held,task_held,financial_held,delivery_state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',1,1,1,'unsent')").run(c.claimId,c.key,intent,c.project,c.task,c.phase,c.agent,c.binding,root,c.inputSha,c.cap,c.grantRef,c.epoch,c.generation,c.day,c.now,c.startBefore,c.outerStop);return relayClaim(db,c.claimId);
}
function relayRoot(p){const r=inspectPortfolioRoot(p);if(r.reason)relayFail('RELAY_WORKTREE');return r.canonical;}
function relayRootOverlap(a,b){try{const root=relayRoot(b),r=relative(a,root),back=relative(root,a);return r===''||(r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r))||(back!=='..'&&!back.startsWith('..'+sep)&&!isAbsolute(back));}catch{relayFail('RELAY_RESOURCE_HELD');}}
export function startRelayClaim(db,id,{now,binding,epoch,generation}){relayWrite(db);const r=relayClaim(db,id);if(r.binding!==binding||r.epoch!==epoch||r.generation!==generation)relayFail('RELAY_BINDING');if(r.run_id)return db.prepare('SELECT * FROM runs WHERE id=?').get(r.run_id);const grant=db.prepare('SELECT * FROM relay_grants WHERE ref=?').get(r.grant_ref);if(r.status!=='pending'||!Number.isSafeInteger(now)||now<r.reserved_ms||now>=Math.min(r.start_before,r.outer_stop,grant.expires_ms))relayFail('RELAY_WINDOW_HELD');const runId=r.task+'-'+now;db.prepare("INSERT INTO runs(id,project,task,agent,worktree,pid,started_at,started_ms,timebox_min,status,day,base_sha,charge_basis) VALUES(?,?,?,?,?,NULL,?,?,?,'relay_running',?,?,'manual cap reserved')").run(runId,r.project,r.task,r.agent,r.worktree,new Date(now).toISOString(),now,r.cap,r.day,r.input_sha);db.prepare("UPDATE relay_claims SET status='running',run_id=?,delivery_state='observed' WHERE claim_id=?").run(runId,id);return db.prepare('SELECT * FROM runs WHERE id=?').get(runId);}
export function noteRelayDelivery(db,id,state){relayWrite(db);if(!['unknown','observed'].includes(state))relayFail('RELAY_DELIVERY');const r=relayClaim(db,id);if(!['pending','running','unknown'].includes(r.status))relayFail('RELAY_DELIVERY');db.prepare('UPDATE relay_claims SET delivery_state=? WHERE claim_id=?').run(state,id);}
// Exact target API for attended control. Caller must hold relayTransaction and
// its native fence; deadlines come from the trusted broker, never request timestamps.
export function expireRelayClaim(db,target){
 relayWrite(db);
 const keys=['project','claimId','key','epoch','generation','now'];
 if(!target||Object.keys(target).length!==keys.length||keys.some(k=>!Object.hasOwn(target,k))||!Number.isSafeInteger(target.now))relayFail('RELAY_EXPIRY_TARGET');
 const r=relayClaim(db,target.claimId);
 if(r.project!==target.project||r.intent_key!==target.key||r.epoch!==target.epoch||r.generation!==target.generation)relayFail('RELAY_EXPIRY_TARGET');
 if(target.now<(r.run_id?r.outer_stop:r.start_before))relayFail('RELAY_EXPIRY_EARLY');
 if(r.status==='expired')return r;
 if(!['pending','running','unknown'].includes(r.status))relayFail('RELAY_EXPIRY_STATE');
 if(r.status==='pending'&&r.delivery_state==='unsent'&&!r.run_id)
  db.prepare("UPDATE relay_claims SET status='expired',capacity_held=0,task_held=0,financial_held=0,charged_min=0 WHERE claim_id=?").run(r.claim_id);
 else{
  db.prepare("UPDATE relay_claims SET status='unknown' WHERE claim_id=?").run(r.claim_id);
  if(r.run_id)db.prepare("UPDATE runs SET status='relay_unknown',charged_min=CASE WHEN charged_min IS NULL OR charged_min<timebox_min THEN timebox_min ELSE charged_min END,charge_basis='unknown manual duration; full cap held' WHERE id=?").run(r.run_id);
 }
 return relayClaim(db,r.claim_id);
}
export function expireRelayClaims(db,now){relayWrite(db);if(!Number.isSafeInteger(now))relayFail('RELAY_CLOCK');for(const r of relayHolds(db)){if(r.status==='pending'&&now>=r.start_before){if(r.delivery_state==='unsent')db.prepare("UPDATE relay_claims SET status='expired',capacity_held=0,task_held=0,financial_held=0,charged_min=0 WHERE claim_id=?").run(r.claim_id);else db.prepare("UPDATE relay_claims SET status='unknown' WHERE claim_id=?").run(r.claim_id);}else if(r.status==='running'&&now>=r.outer_stop){db.prepare("UPDATE relay_claims SET status='unknown' WHERE claim_id=?").run(r.claim_id);db.prepare("UPDATE runs SET status='relay_unknown',charged_min=timebox_min,charge_basis='unknown manual duration; full cap held' WHERE id=?").run(r.run_id);}}}
export function settleRelayClaim(db,id,{capacityProof=null,taskProof=null,financialProof=null,minutes=null}){relayWrite(db);const r=relayClaim(db,id);if([capacityProof,taskProof,financialProof].some(x=>x!==null&&!relayId(x))||financialProof!==null&&(!Number.isFinite(minutes)||minutes<0)||taskProof!==null&&capacityProof===null)relayFail('RELAY_RELEASE_PROOF');const capacity=capacityProof?0:r.capacity_held,task=taskProof?0:r.task_held,financial=financialProof?0:r.financial_held,charged=financialProof?minutes:(r.charged_min??r.cap);if(r.financial_proof&&financialProof&&(r.financial_proof!==financialProof||r.charged_min!==minutes))relayFail('RELAY_SETTLEMENT_CONFLICT');db.prepare("UPDATE relay_claims SET status=?,capacity_held=?,task_held=?,financial_held=?,charged_min=?,capacity_proof=coalesce(capacity_proof,?),task_proof=coalesce(task_proof,?),financial_proof=coalesce(financial_proof,?) WHERE claim_id=?").run(task?'unknown':'complete',capacity,task,financial,charged,capacityProof,taskProof,financialProof,id);if(r.run_id)db.prepare('UPDATE runs SET status=?,charged_min=?,charge_basis=? WHERE id=?').run(task?'relay_unknown':'relay_complete',charged,financialProof?'trusted financial observation':'unknown; full cap retained',r.run_id);return relayClaim(db,id);}

// Query only: a manual claim has no native PID and must never enter native collection.
export function dispatchHolds(db,{project=null}={}) {
  const native=project?db.prepare("SELECT * FROM runs WHERE project=? AND status='running'").all(project):db.prepare("SELECT * FROM runs WHERE status='running'").all();
  const manual=relayHolds(db,{project});
  return {capacity:native.length+manual.filter(r=>r.capacity_held).length,
    taskIds:[...new Set([...native.map(r=>r.task),...manual.filter(r=>r.task_held).map(r=>r.task)])],
    manual:manual.map(r=>({claimId:r.claim_id,task:r.task,agent:r.agent,status:r.status,runId:r.run_id,capacityHeld:!!r.capacity_held,taskHeld:!!r.task_held,financialHeld:!!r.financial_held,stop:'owner confirmation required'}))};
}
