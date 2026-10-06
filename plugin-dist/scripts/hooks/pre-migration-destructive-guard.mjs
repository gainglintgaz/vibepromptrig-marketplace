#!/usr/bin/env node
// pre-migration-destructive-guard.mjs
//
// PreToolUse hook (matcher ^mcp__.+__apply_migration$ -- any MCP server's apply_migration tool,
// e.g. mcp__supabase__apply_migration and mcp__plugin_supabase_supabase__apply_migration) -- blocks Supabase
// apply_migration calls with selected destructive SQL patterns. Node twin of
// pre-migration-destructive-guard.ps1 (cross-platform port P2, T1a).
// Scans EVERY string field of tool_input (SQL may arrive via query/sql/name).
// Byte-identical behavior: exit 0 = allow, exit 2 = block (stderr). An empty or non-JSON hook envelope
// exits 0 (there is no SQL to judge).
// Dependency-free (Node stdlib only), Node >= 18.
//
// FAIL CLOSED for the listed patterns and tokenization failures (owner policy, PR #37).
// This selective scanner prints review steps when it blocks. It does not prove other SQL safe. Blocked:
//   - destructive statements: DROP TABLE, TRUNCATE, ALTER TABLE ... DROP, DROP POLICY/INDEX/SCHEMA/DATABASE;
//   - DELETE FROM and UPDATE without a WHERE in the statement's own top-level scope. A WHERE inside a
//     USING/FROM/SET subquery, in RETURNING, or in a surrounding CTE does not count;
//   - dynamic SQL, whose text no scanner can see: PL/pgSQL EXECUTE of a string, variable or
//     string-built statement, format(), dblink()/dblink_exec(). EXECUTE FUNCTION|PROCEDURE (trigger
//     actions) and EXECUTE ON / "EXECUTE," (privileges) are not dynamic SQL;
//   - unparseable SQL: a literal, quoted identifier, block comment or dollar-quoted body the payload never
//     closes, or an internal error while judging the SQL.
// Other SQL shapes may pass; database authorization, restorable backups and human review remain necessary.

import process from 'node:process';
import { deferToLocalHook } from './hook-lib.mjs';

deferToLocalHook(import.meta.url, 'PreToolUse', '^mcp__.+__apply_migration$');

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

// PostgreSQL block comments nest. A dollar-body closing tag ends scanning inside that body.
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

// The SQL with comments and '...', E'...', "..." contents blanked (same length, newlines kept), so their
// keywords and semicolons are neither matched nor treated as statement ends. Plain '...' treats a
// backslash literally (PostgreSQL standard_conforming_strings), so it never swallows following SQL.
// $tag$...$tag$ bodies stay visible and are scanned as SQL (DO blocks and function bodies run); a quote
// or comment opened inside one ends at its closing tag. Nested /* */ stays masked.
// Sets `unterminated` when the payload ends inside a literal, identifier, comment or dollar body.
let unterminated = false;
function sqlCode(sql) {
  const closers = [];
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const top = closers[closers.length - 1];
    if (top && sql.startsWith(top, i)) { closers.pop(); out += ' '.repeat(top.length); i += top.length; continue; }
    const c = sql[i], n = sql[i + 1], prev = sql[i - 1] || '';
    let j = -1;
    let open = false;
    if (c === '-' && n === '-') { j = sql.indexOf('\n', i); if (j < 0) j = sql.length; }
    else if (c === '/' && n === '*') {
      const { end, open: unclosed } = scanBlockComment(sql, i, top);
      if (unclosed) unterminated = true;
      out += sql.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    else if (c === "'" || c === '"' || ((c === 'E' || c === 'e') && n === "'" && !/\w/.test(prev))) {
      const esc = c !== "'" && c !== '"';
      const q = esc ? "'" : c;
      let k = i + (esc ? 2 : 1);
      while (k < sql.length) {
        if (esc && sql[k] === '\\') { k += 2; continue; }
        if (sql[k] === q) { if (sql[k + 1] === q) { k += 2; continue; } break; }
        k++;
      }
      open = k >= sql.length;
      j = Math.min(k + 1, sql.length);
    } else if (c === '$' && !/[\w$]/.test(prev)) {
      const m = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 64));
      if (m) { closers.push(m[0]); out += ' '.repeat(m[0].length); i += m[0].length; continue; }
    }
    if (j < 0) { out += c; i++; continue; }
    const k = top ? sql.indexOf(top, i) : -1;
    if (open && k < 0) unterminated = true;
    const stop = k >= 0 && k < j ? k : j;
    out += sql.slice(i, stop).replace(/[^\n]/g, ' ');
    i = stop;
  }
  if (closers.length) unterminated = true;
  return out;
}

// True when `stmt` (masked SQL starting at DELETE/UPDATE) has a WHERE at its own parenthesis depth
// before the statement closes (a ')' below its starting depth ends a DELETE/UPDATE nested in a CTE).
function hasTopLevelWhere(stmt) {
  let depth = 0;
  for (const m of stmt.matchAll(/[()]|\bWHERE\b/gi)) {
    if (m[0] === '(') depth++;
    else if (m[0] === ')') { if (--depth < 0) return false; }
    else if (depth === 0) return true;
  }
  return false;
}

// UPDATE as a statement: not a trigger event, privilege, row lock, FK action or ON CONFLICT DO UPDATE.
const UPDATE_STATEMENT = /(?<!\b(?:DO|FOR|KEY|BEFORE|AFTER|OR|OF|ON|GRANT|REVOKE)\s*)(?<!,\s*)\bUPDATE\b(?!\s+(?:ON|OF)\b)[^;]*/gi;
const DYNAMIC_SQL = /\bEXECUTE\b(?!\s+(?:FUNCTION|PROCEDURE|ON)\b)(?!\s*,)|\bformat\s*\(|\bdblink(?:_exec)?\s*\(/i;

let pattern = '';
try {
  const code = sqlCode(sqlText);
  // WHERE is judged per statement on its masked text: a WHERE in a comment, literal, quoted identifier or
  // $$ text is not a clause, and neither is one in a subquery or in another statement.
  const unscoped = (re) => [...code.matchAll(re)].some((m) => !hasTopLevelWhere(maskSql(sqlText.slice(m.index, m.index + m[0].length))));
  if (unterminated) pattern = 'unparseable SQL (a literal, quoted identifier, comment or dollar-quoted body is never closed)';
  else if (/\bDROP\s+TABLE\b/i.test(code)) pattern = 'DROP TABLE';
  else if (/\bTRUNCATE\b/i.test(code)) pattern = 'TRUNCATE';
  // [^;]* spans line breaks (multiline ALTER TABLE ... DROP COLUMN) but stops at the statement end.
  else if (/\bALTER\s+TABLE\b[^;]*\bDROP\b/i.test(code)) pattern = 'ALTER TABLE...DROP';
  else if (unscoped(/\bDELETE\s+FROM\b[^;]*/gi)) pattern = 'DELETE without a top-level WHERE';
  else if (unscoped(UPDATE_STATEMENT)) pattern = 'UPDATE without a top-level WHERE';
  else if (/\bDROP\s+(POLICY|INDEX|SCHEMA|DATABASE)\b/i.test(code)) pattern = 'DROP POLICY/INDEX/SCHEMA/DATABASE';
  else if (DYNAMIC_SQL.test(code)) pattern = 'dynamic SQL (EXECUTE, format() or dblink): the statement text cannot be checked';
} catch {
  pattern = 'unparseable SQL (the guard could not judge it)';
}

if (pattern) {
  process.stderr.write(`[BLOCKED] Destructive migration detected: ${pattern}\n`);
  process.stderr.write('          This guard screens selected patterns and blocks unparseable SQL; exit 0 is not a safety verdict.\n');
  process.stderr.write('          1. Confirm a restorable backup exists from the last 24h (platform PITR or an off-platform pg_dump)\n');
  process.stderr.write('          2. Diff against current schema and surface each destructive op to the project owner\n');
  process.stderr.write('          3. Confirm dev project (not prod) and get explicit confirmation before any separate retry; this hook has no confirmation input\n');
  process.stderr.write('          See docs/rules-reference/factory/data-protection.md §4 (destructive operation gate) and §8 (self-check).\n');
  process.exit(2);
}

process.exit(0);
