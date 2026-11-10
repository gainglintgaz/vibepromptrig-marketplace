#!/usr/bin/env node
// dispatch-worker.mjs -- detached wrapper for one worker run (HH-ORCH-03 step B).
// Runs spec.argv with the task pack on stdin, writes stdout/stderr to files, kills the whole
// process tree at the timebox, and records exact start/exit times in exit.json so the next
// dispatch pass can settle the budget. It never retries and never touches STATE.json.
//
// Process tree: on Windows `taskkill /T /F`; elsewhere the CLI runs in its own process group
// (detached), which gets SIGTERM and then SIGKILL after 5 s (review P1). exit.json is written only
// after both output files have flushed (review P2), so a valid result is never truncated.
import { createReadStream, createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const startedAt = new Date().toISOString();
const write = (data) => writeFileSync(join(spec.outDir, 'exit.json'), JSON.stringify({ runId: spec.runId, wrapperPid: process.pid, startedAt, ...data }, null, 2));
write({ state: 'running' });

const posix = process.platform !== 'win32';
let child;
try {
  child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, detached: posix });
} catch (e) {
  write({ state: 'exited', exitAt: new Date().toISOString(), exitCode: null, timedOut: false, error: `spawn failed: ${e.message}` });
  process.exit(1);
}
const outFile = createWriteStream(join(spec.outDir, 'stdout.txt'));
const errFile = createWriteStream(join(spec.outDir, 'stderr.txt'));
child.stdout.pipe(outFile);
child.stderr.pipe(errFile);
const flushed = Promise.all([outFile, errFile].map((s) => new Promise((res) => { s.on('finish', res); s.on('error', res); })));
if (spec.stdinFile) createReadStream(spec.stdinFile).pipe(child.stdin); else child.stdin.end();

function killTree() {
  if (!posix) { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); return; }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* group already gone */ }
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ } }, 5000).unref();
}

let timedOut = false;
const timer = setTimeout(() => { timedOut = true; killTree(); }, Math.max(0.01, Number(spec.timeboxMin)) * 60_000); // fractional minutes only occur in tests

let done = false;
async function finish(exitCode, error) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  await flushed;
  write({ state: 'exited', exitAt: new Date().toISOString(), exitCode, timedOut, ...(error ? { error } : {}) });
  process.exit(error ? 1 : 0);
}
child.on('error', (e) => { finish(null, `worker error: ${e.message}`); });
child.on('close', (code) => { finish(code, null); });
