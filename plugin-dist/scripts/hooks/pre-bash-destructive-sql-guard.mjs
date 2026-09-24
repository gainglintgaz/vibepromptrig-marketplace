#!/usr/bin/env node
// pre-bash-destructive-sql-guard.mjs
//
// PreToolUse(Bash) hook -- blocks Bash commands containing destructive SQL.
// Node twin of pre-bash-destructive-sql-guard.ps1 (cross-platform port P2, T1a).
// Byte-identical behavior: reads the Claude Code hook envelope from stdin, exits 0 =
// allow, exit 2 = block (message to stderr). Fail-open on any error (parity with PS).
//
// Dependency-free (Node stdlib only), Node >= 18. Runs identically on Win/macOS/Linux.

import process from 'node:process';

// Kill-switch (cross-platform-port.md assumption 9): never block when disabled.
if (process.env.VIBE_HOOKS_DISABLE) process.exit(0);

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

const raw = await readStdin();
let text = raw.toString('utf8');
if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // tolerate UTF-8 BOM on stdin
text = text.trim();
if (!text) process.exit(0);

let hook;
try { hook = JSON.parse(text); } catch { process.exit(0); }
if (!hook || typeof hook !== 'object') process.exit(0);
if (hook.tool_name !== 'Bash') process.exit(0);

const cmd = hook.tool_input && typeof hook.tool_input.command === 'string' ? hook.tool_input.command : '';
if (!cmd) process.exit(0);

// Destructive SQL patterns. DELETE FROM without WHERE is destructive; with WHERE it is OK.
let destructive = false;
if (/\bDROP\s+TABLE\b/i.test(cmd)) destructive = true;
if (/\bTRUNCATE\b/i.test(cmd)) destructive = true;
if (/\bALTER\s+TABLE\b.*\bDROP\b/i.test(cmd)) destructive = true;
if (/\bDELETE\s+FROM\b/i.test(cmd) && !/\bWHERE\b/i.test(cmd)) destructive = true;
if (/\bDROP\s+(POLICY|INDEX|SCHEMA|DATABASE)\b/i.test(cmd)) destructive = true;

if (destructive) {
  process.stderr.write('[BLOCKED] Destructive SQL detected in bash command.\n');
  process.stderr.write('          Surface to the project owner for explicit approval before executing.\n');
  process.stderr.write('          See data-protection.md SS3 destructive-op gate.\n');
  process.exit(2);
}

process.exit(0);
