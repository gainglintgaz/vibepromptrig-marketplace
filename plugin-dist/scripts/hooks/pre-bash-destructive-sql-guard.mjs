#!/usr/bin/env node
// pre-bash-destructive-sql-guard.mjs
//
// PreToolUse(Bash) hook -- screens Bash commands for selected destructive SQL patterns.
// Node twin of pre-bash-destructive-sql-guard.ps1 (cross-platform port P2, T1a).
// Byte-identical behavior: reads the Claude Code hook envelope from stdin, exits 0 =
// allow, exit 2 = block (message to stderr). An empty or non-JSON envelope exits 0 (parity with PS).
//
// FAIL CLOSED for the listed patterns (owner policy, PR #37). This selective scanner prints
// review steps when it blocks; it does not prove other SQL safe. Blocked anywhere in the command: DROP TABLE, TRUNCATE, ALTER TABLE ... DROP,
// DROP POLICY/INDEX/SCHEMA/DATABASE, and DELETE FROM / UPDATE ... SET without a WHERE in the statement's own
// top-level scope (a WHERE inside a USING/FROM/SET subquery or a CTE does not count). Blocked when the command
// carries SQL (psql, pgcli, supabase db, a DO block or plpgsql): dynamic SQL -- EXECUTE of a string, variable
// or string-built statement, format(), dblink()/dblink_exec(), psql \gexec -- whose text cannot be checked.
// EXECUTE FUNCTION|PROCEDURE and EXECUTE ON (privileges) are not dynamic SQL. The SQL sits inside shell
// quoting here, so it is not tokenized: the checks read the raw command and can miss other shapes.
// SQL in a file (psql -f) is out of this guard's sight. Database authorization, restorable backups
// and human review remain necessary.
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

// PostgreSQL block comments nest; WHERE judgement must hide the whole comment.
function scanBlockComment(sql, start, boundary = '') {
  let depth = 1;
  let i = start + 2;
  while (i < sql.length) {
    if (boundary && sql.startsWith(boundary, i)) return { end: i, open: false };
    if (sql.startsWith('/*', i)) { depth++; i += 2; continue; }
    if (sql.startsWith('*/', i)) {
      depth--;
      i += 2;
      if (depth === 0) return { end: i, open: false };
      continue;
    }
    i++;
  }
  return { end: sql.length, open: true };
}

// WHERE judgement masks comments, quoted text and dollar bodies without exposing nested contents.
// Ordinary strings assume standard_conforming_strings=on; only E/e strings escape backslashes.
const MASK_TOKEN = /--[^\n]*|(?<![\w$])[Ee]'(?:[^'\\]|\\[\s\S]|'')*(?:'|$)|'(?:[^']|'')*(?:'|$)|"(?:[^"]|"")*(?:"|$)|\$([A-Za-z_]\w*|)\$[\s\S]*?(?:\$\1\$|$)/y;
function maskSql(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s.startsWith('/*', i)) {
      const { end } = scanBlockComment(s, i);
      out += s.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    MASK_TOKEN.lastIndex = i;
    const token = MASK_TOKEN.exec(s);
    if (token) {
      out += token[0].replace(/[^\n]/g, ' ');
      i += token[0].length;
    } else {
      out += s[i++];
    }
  }
  return out;
}

// True when `stmt` (masked, starting at DELETE/UPDATE) has a WHERE at its own parenthesis depth before
// the statement closes (a ')' below its starting depth ends a DELETE/UPDATE nested in a CTE).
function hasTopLevelWhere(stmt) {
  let depth = 0;
  for (const m of stmt.matchAll(/[()]|\bWHERE\b/gi)) {
    if (m[0] === '(') depth++;
    else if (m[0] === ')') { if (--depth < 0) return false; }
    else if (depth === 0) return true;
  }
  return false;
}
// WHERE is judged per statement: a WHERE elsewhere in the command must not qualify an unscoped one.
const unscoped = (re) => (cmd.match(re) || []).some((st) => !hasTopLevelWhere(maskSql(st)));

// UPDATE ... SET as a statement (shell words like `apt-get update` have no SET); not ON CONFLICT DO UPDATE.
const UPDATE_STATEMENT = /(?<!\b(?:DO|FOR|KEY|BEFORE|AFTER|OR|OF|ON|GRANT|REVOKE)\s*)(?<!,\s*)\bUPDATE\s+(?:ONLY\s+)?\S+(?:\s+(?:AS\s+)?\S+)?\s+SET\b[^;]*/gi;
const SQL_CONTEXT = /\b(?:psql|pgcli|plpgsql)\b|\bsupabase\s+db\b|\bDO\s+(?:\$|E?')/i;
const DYNAMIC_SQL = /\bEXECUTE\b(?!\s+(?:FUNCTION|PROCEDURE|ON)\b)(?!\s*,)|\bformat\s*\(|\bdblink(?:_exec)?\s*\(|\\gexec\b/i;

let destructive = false;
try {
  if (/\bDROP\s+TABLE\b/i.test(cmd)) destructive = true;
  if (/\bTRUNCATE\b/i.test(cmd)) destructive = true;
  // Statement-agnostic on purpose: in a shell command the SQL sits inside shell quoting, so a ';' inside a
  // SQL literal or comment cannot be told from a statement end. Any DROP after ALTER TABLE blocks.
  if (/\bALTER\s+TABLE\b[\s\S]*\bDROP\b/i.test(cmd)) destructive = true;
  if (unscoped(/\bDELETE\s+FROM\b[^;]*/gi)) destructive = true;
  if (unscoped(UPDATE_STATEMENT)) destructive = true;
  if (/\bDROP\s+(POLICY|INDEX|SCHEMA|DATABASE)\b/i.test(cmd)) destructive = true;
  if (SQL_CONTEXT.test(cmd) && DYNAMIC_SQL.test(cmd)) destructive = true;
} catch {
  destructive = true;
}

if (destructive) {
  process.stderr.write('[BLOCKED] Destructive SQL detected in bash command.\n');
  process.stderr.write('          This guard screens selected patterns; exit 0 is not a safety verdict.\n');
  process.stderr.write('          Surface to the project owner and get explicit confirmation before a separate retry; this hook has no confirmation input.\n');
  process.stderr.write('          See data-protection.md SS4 destructive-op gate.\n');
  process.exit(2);
}

process.exit(0);
