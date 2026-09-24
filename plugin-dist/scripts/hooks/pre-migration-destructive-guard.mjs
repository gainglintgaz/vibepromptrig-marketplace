#!/usr/bin/env node
// pre-migration-destructive-guard.mjs
//
// PreToolUse hook (matcher mcp__31fc416e*apply_migration) -- blocks Supabase
// apply_migration calls containing destructive SQL. Node twin of
// pre-migration-destructive-guard.ps1 (cross-platform port P2, T1a).
// Scans EVERY string field of tool_input (SQL may arrive via query/sql/name).
// Byte-identical behavior: exit 0 = allow, exit 2 = block (stderr). Fail-open on error.
// Dependency-free (Node stdlib only), Node >= 18.

import process from 'node:process';

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
if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
text = text.trim();
if (!text) process.exit(0);

let hook;
try { hook = JSON.parse(text); } catch { process.exit(0); }
if (!hook) process.exit(0);

// Gather all string fields from tool_input (migrations pass SQL via 'query' or 'sql').
let sqlText = '';
if (hook.tool_input && typeof hook.tool_input === 'object') {
  for (const v of Object.values(hook.tool_input)) {
    if (typeof v === 'string') sqlText += '\n' + v;
  }
}
if (!sqlText) process.exit(0);

let destructive = false;
let pattern = '';
if (/\bDROP\s+TABLE\b/i.test(sqlText)) { destructive = true; pattern = 'DROP TABLE'; }
else if (/\bTRUNCATE\b/i.test(sqlText)) { destructive = true; pattern = 'TRUNCATE'; }
else if (/\bALTER\s+TABLE\b.*\bDROP\b/i.test(sqlText)) { destructive = true; pattern = 'ALTER TABLE...DROP'; }
else if (/\bDELETE\s+FROM\b/i.test(sqlText) && !/\bWHERE\b/i.test(sqlText)) { destructive = true; pattern = 'DELETE FROM (no WHERE)'; }
else if (/\bDROP\s+(POLICY|INDEX|SCHEMA|DATABASE)\b/i.test(sqlText)) { destructive = true; pattern = 'DROP POLICY/INDEX/SCHEMA/DATABASE'; }

if (destructive) {
  process.stderr.write(`[BLOCKED] Destructive migration detected: ${pattern}\n`);
  process.stderr.write('          1. Run backup-check skill first\n');
  process.stderr.write('          2. Diff against current schema and surface to the project owner\n');
  process.stderr.write('          3. Confirm dev project (not prod) before re-trying\n');
  process.stderr.write('          See data-protection.md SS3 destructive-op gate.\n');
  process.exit(2);
}

process.exit(0);
