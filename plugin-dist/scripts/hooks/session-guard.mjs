#!/usr/bin/env node
// session-guard.mjs
//
// One-writer-per-repo guard -- Node twin of session-guard.ps1 (cross-platform port P2, T1).
// Byte-faithful behavior: advisory heartbeat lockfile (atomic tmp + rename), 15-min
// staleness with clock-skew handling, exit-2 ONLY on the interactive commit/push block,
// dual-signal ownership, degraded mode (no identity -> never claim, never block).
// Spec: docs/v5.0/one-writer-guard-spec.md. Build: docs/architecture/one-writer-guard.md.
//
// Events (passed as `-Event <x>` to match the existing settings.json invocation):
//   start      SessionStart      claim lock or print LOUD advisory (exit 0 always)
//   prewrite   PreToolUse(Bash)  owner refresh; foreign fresh + git commit/push +
//                                INTERACTIVE -> exit 2; headless/unsure -> warn (exit 0)
//   heartbeat  UserPromptSubmit  refresh heartbeat (silent -- stdout becomes context)
//   stop       Stop              release lock if owned
//
// Dependency-free (Node stdlib only), Node >= 18. MUST never crash the tool loop: every
// path exits 0 except the deliberate interactive commit/push block (exit 2).

import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import process from 'node:process';

// Kill-switch (arch assumption 9): never block when disabled.
if (process.env.VIBE_HOOKS_DISABLE) process.exit(0);

const here = dirname(fileURLToPath(import.meta.url));

// ---- event arg (-Event start | --event start) ----
function getEvent() {
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if ((a[i] === '-Event' || a[i] === '--event') && i + 1 < a.length) return a[i + 1];
  }
  return 'start';
}
const EVENT = getEvent();

// ---- stdin ----
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(Buffer.concat(chunks)); };
    try {
      process.stdin.on('data', (c) => chunks.push(c));
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
      if (process.stdin.isTTY) finish();
    } catch { finish(); }
  });
}

function readHookInput(raw) {
  let text = raw.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // tolerate UTF-8 BOM
  text = text.trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// ---- helpers (1:1 with session-guard.ps1) ----
function getProjectDir(hook) {
  const env = process.env.CLAUDE_PROJECT_DIR;
  if (env && existsSync(env)) return env;
  if (hook && hook.cwd && existsSync(String(hook.cwd))) return String(hook.cwd);
  return dirname(dirname(here));
}
function getLockPath(projectDir) { return join(projectDir, '.claude', '.session-lock.json'); }

function readLock(path) {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    if (!raw || !raw.trim()) return null;
    const lock = JSON.parse(raw);
    if (!lock || !lock.session_id) return null; // corrupt/foreign shape = absent
    return lock;
  } catch { return null; }
}

function getStaleMinutes() {
  let m = 15;
  const e = process.env.SESSION_GUARD_STALE_MINUTES;
  if (e && /^\d+$/.test(e)) { m = parseInt(e, 10); if (m < 1) m = 1; }
  return m;
}

function testLockFresh(lock, staleMinutes) {
  if (!lock || !lock.heartbeat_at) return false;
  const hb = Date.parse(String(lock.heartbeat_at));
  if (Number.isNaN(hb)) return false; // unparseable = stale
  let age = (Date.now() - hb) / 60000; // minutes
  // Far-future heartbeat (more than one stale-window ahead) = corrupt/tampered -> STALE.
  if (age < -1 * staleMinutes) return false;
  // Small negative skew (NTP resync after sleep) tolerated as fresh-now:
  if (age < 0) age = 0;
  return age <= staleMinutes;
}

function getLastSeenSeconds(lock) {
  const hb = Date.parse(String(lock.heartbeat_at));
  if (Number.isNaN(hb)) return -1;
  let s = Math.floor((Date.now() - hb) / 1000);
  if (s < 0) s = 0;
  return s;
}

function getMySessionIds(hook) {
  // CLAUDE_CODE_SESSION_ID (env, process-lifetime) goes FIRST -- writeLock() uses
  // myIds[0] as the durable identity it stamps into the lock. Some entrypoints
  // (observed: claude-desktop) mint a NEW hook.session_id on every SessionStart:resume
  // within one continuous human conversation, while the env var stays fixed for the
  // life of that conversation. Storing the volatile hook.session_id as canonical meant
  // writeLock() stamped a throwaway id every time, so no later event -- including the
  // UserPromptSubmit heartbeat refresh -- could ever match ownership again: heartbeat_at
  // froze at whatever `start` last wrote, and every subsequent resume saw a "foreign"
  // lock that was actually the same session. Root-caused 2026-08-01 on example-wellness-app:
  // three SessionStart:resume events in one conversation produced three distinct
  // lock.session_id values, none matching the (confirmed stable, via scratchpad-dir
  // correlation) CLAUDE_CODE_SESSION_ID. hook.session_id is still included second, so
  // entrypoints where only it is stable (or where env is absent) keep matching too.
  const ids = [];
  if (process.env.CLAUDE_CODE_SESSION_ID) ids.push(String(process.env.CLAUDE_CODE_SESSION_ID));
  if (hook && hook.session_id) ids.push(String(hook.session_id));
  return [...new Set(ids.filter((x) => x && x.trim()))];
}

function testIsOwner(lock, myIds) {
  if (!lock || !lock.session_id) return false;
  if (!myIds || myIds.length === 0) return false;
  return myIds.some((id) => String(lock.session_id) === id);
}

function getAgentLabel() {
  const ep = process.env.CLAUDE_CODE_ENTRYPOINT;
  if (!ep) return 'unknown';
  if (/^cli$/.test(ep)) return 'interactive-cli';
  if (/^print$/.test(ep)) return 'headless-print';
  if (/^sdk/.test(ep)) return 'headless-sdk';
  return String(ep);
}
function testInteractive() { return process.env.CLAUDE_CODE_ENTRYPOINT === 'cli'; }

function writeLock(path, sessionId, startedAt) {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    if (!startedAt) startedAt = now;
    const lock = {
      session_id: sessionId,
      agent: getAgentLabel(),
      pid: process.pid,
      host: process.env.COMPUTERNAME || os.hostname() || '',
      started_at: startedAt,
      heartbeat_at: now,
      intent: 'building',
    };
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(lock));
    renameSync(tmp, path); // atomic on same volume (Win + POSIX)
  } catch { /* never crash the tool loop */ }
}
function removeLock(path) { try { rmSync(path, { force: true }); } catch { /* ignore */ } }

// git invocation with optional global flags, then commit|push|add as the subcommand.
// (?![\w-]) excludes hyphenated plumbing subcommands (commit-graph, commit-tree, push-options).
const GIT_PREFIX = String.raw`\bgit(\.exe)?\b(\s+(-C\s+("[^"]*"|'[^']*'|\S+)|--no-pager|-c\s+\S+|--git-dir=\S+|--work-tree=\S+))*\s+`;
function testGitCommitPush(cmd) { return new RegExp(GIT_PREFIX + String.raw`(commit|push)(?![\w-])`, 'i').test(cmd); }
function testGitStageOrSync(cmd) {
  if (new RegExp(GIT_PREFIX + String.raw`add(?![\w-])`, 'i').test(cmd)) return true;
  return /sync-rules/i.test(cmd);
}

function out(line) { process.stdout.write(line + '\n'); }
function err(line) { process.stderr.write(line + '\n'); }

// ---- main ----
const raw = await readStdin();
try {
  const hook = readHookInput(raw);
  const projectDir = getProjectDir(hook);
  const lockPath = getLockPath(projectDir);
  const staleMin = getStaleMinutes();
  const myIds = getMySessionIds(hook);
  const lock = readLock(lockPath);
  const fresh = testLockFresh(lock, staleMin);
  const owner = testIsOwner(lock, myIds);
  const haveIdentity = myIds.length > 0;

  if (EVENT === 'start') {
    if (!haveIdentity) process.exit(0);
    if (!lock || !fresh || owner) {
      const startedAt = (owner && lock && lock.started_at) ? String(lock.started_at) : null;
      writeLock(lockPath, myIds[0], startedAt);
      process.exit(0);
    }
    const seen = getLastSeenSeconds(lock);
    out('[SESSION GUARD] Another active session appears to be building in this repo:');
    out(`  agent=${lock.agent}  started=${lock.started_at}  last-seen=${seen}s ago  pid=${lock.pid}  host=${lock.host}`);
    out('Two writers in one working tree corrupt commits (2026-06-01 incident -- docs/v5.0/one-writer-guard-spec.md SS1).');
    out('Options:');
    out('  (a) let that session finish before writing here');
    out('  (b) use a separate git worktree: git worktree add ../vf-<name> <branch>  (VIBE Rule 28)');
    out(`  (c) if that session is dead, the lock auto-releases after ${staleMin} minutes`);
    out('Recommendation: treat this session as READ-ONLY until the lock clears.');
    out('git commit / git push here will be BLOCKED while the other session is live (interactive sessions only; headless sessions warn instead).');
    process.exit(0);
  }

  if (EVENT === 'prewrite') {
    if (!hook || hook.tool_name !== 'Bash') process.exit(0);
    const cmd = hook.tool_input && hook.tool_input.command ? String(hook.tool_input.command) : '';
    if (!cmd) process.exit(0);
    if (!haveIdentity) process.exit(0);

    if (!lock || !fresh) { writeLock(lockPath, myIds[0], null); process.exit(0); }
    if (owner) { writeLock(lockPath, myIds[0], lock.started_at ? String(lock.started_at) : null); process.exit(0); }

    const seen = getLastSeenSeconds(lock);
    if (testGitCommitPush(cmd)) {
      if (testInteractive()) {
        err('[SESSION GUARD] BLOCKED: git commit/push while another session holds the build lock.');
        err(`  owner agent=${lock.agent}  last-seen=${seen}s ago  (lock: .claude\\.session-lock.json)`);
        err('  Resolve: wait for the other session, use a git worktree (VIBE Rule 28),');
        err(`  or if that session is dead the lock auto-releases after ${staleMin} min.`);
        process.exit(2);
      } else {
        err(`[SESSION GUARD] WARNING: another builder session is active (last-seen ${seen}s ago); commit/push may collide. Headless session -- warn only, not blocked.`);
        process.exit(0);
      }
    }
    if (testGitStageOrSync(cmd)) {
      err(`[SESSION GUARD] WARNING: another builder session is active (last-seen ${seen}s ago); your staged changes may be swept into its commit. See SessionStart notice.`);
      process.exit(0);
    }
    process.exit(0);
  }

  if (EVENT === 'heartbeat') {
    if (!haveIdentity) process.exit(0);
    if (!lock || !fresh) { writeLock(lockPath, myIds[0], null); process.exit(0); }
    if (owner) writeLock(lockPath, myIds[0], lock.started_at ? String(lock.started_at) : null);
    process.exit(0);
  }

  if (EVENT === 'stop') {
    if (owner) removeLock(lockPath);
    process.exit(0);
  }

  process.exit(0);
} catch {
  process.exit(0);
}
