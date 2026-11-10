#!/usr/bin/env node
// pre-bash-destructive-sql-guard.mjs
//
// PreToolUse(Bash) hook -- screens Bash commands for selected destructive SQL patterns.
// Node twin of pre-bash-destructive-sql-guard.ps1 (cross-platform port P2, T1a).
// Byte-identical behavior: reads the Claude Code hook envelope from stdin, exits 0 =
// allow, exit 2 = block (message to stderr). An empty or non-JSON envelope exits 0 (parity with PS).
//
// FAIL CLOSED for the listed patterns (owner policy, PR #37). This selective scanner prints
// review steps when it blocks; it does not prove other SQL safe. Within SQL client input: DROP TABLE, TRUNCATE, ALTER TABLE ... DROP,
// DROP POLICY/INDEX/SCHEMA/DATABASE, and DELETE FROM / UPDATE ... SET without a WHERE in the statement's own
// top-level scope (a WHERE inside a USING/FROM/SET subquery or a CTE does not count). Blocked when the command
// carries SQL (psql, pgcli, supabase db, sqlite3, mysql, duckdb): dynamic SQL -- EXECUTE of a string, variable
// or string-built statement, format(), dblink()/dblink_exec(), psql \gexec -- whose text cannot be checked.
// EXECUTE FUNCTION|PROCEDURE and EXECUTE ON (privileges) are not dynamic SQL. Shell
// quoting is removed before screening inline SQL, stdin, and explicit local .sql files. Shell
// wrappers and command substitutions are inspected without executing them. Other command arguments
// are text, not SQL. Unknown SQL inputs fail closed; this is a bounded shell scanner, not a shell
// interpreter. Database authorization, restorable backups and human review remain necessary.
//
// Dependency-free (Node stdlib only), Node >= 18. Runs identically on Win/macOS/Linux.

import process from 'node:process';
import { readFileSync, statSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { deferToLocalHook } from './hook-lib.mjs';

deferToLocalHook(import.meta.url, 'PreToolUse', 'Bash');

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

// Bounded shell lexer: quote removal, command boundaries, redirections, heredocs and substitutions.
// It NEVER runs a command or expands environment variables. Substitutions execute even in text-only
// arguments, so collect those separately; single-quoted arguments/heredocs suppress expansion.
function shellTokens(source) {
  const tokens = [], nested = [], pending = [];
  let i = 0;
  function substitution(start, backtick = false) {
    let j = start, depth = 1, quote = '';
    while (j < source.length) {
      const c = source[j];
      if (c === '\\' && quote !== "'") { j += 2; continue; }
      if (backtick && c === '`') break;
      if (!backtick) {
        if (quote) { if (c === quote) quote = ''; }
        else if (c === '"' || c === "'") quote = c;
        else if (c === '(') depth++;
        else if (c === ')' && --depth === 0) break;
      }
      j++;
    }
    nested.push(source.slice(start, j));
    i = Math.min(j + 1, source.length);
  }
  while (i < source.length) {
    if (source[i] === '\\' && source[i + 1] === '\n') { i += 2; continue; }
    if (source[i] === '\n') {
      tokens.push({ op: ';' }); i++;
      for (const redir of pending.splice(0)) {
        const delimiter = redir.delimiter;
        let body = '', closed = false;
        while (i < source.length) {
          const end = source.indexOf('\n', i);
          const next = end < 0 ? source.length : end;
          let line = source.slice(i, next).replace(/\r$/, '');
          if (redir.op === '<<-') line = line.replace(/^\t+/, '');
          i = end < 0 ? source.length : end + 1;
          if (line === delimiter) { closed = true; break; }
          body += line + '\n';
        }
        redir.body = body;
        redir.unknown = !closed;
        if (!redir.quoted) {
          // An unquoted heredoc expands even inside SQL's single quotes. Treat its entire
          // body like a double-quoted shell word solely to discover executable expansions.
          const expansions = shellTokens('"' + body.replace(/"/g, '\\"') + '"');
          nested.push(...expansions.nested);
          redir.unknown ||= expansions.tokens.some(t => t.dynamic || t.unknown);
        }
      }
      continue;
    }
    if (/\s/.test(source[i])) { i++; continue; }
    if (source[i] === '#') { while (i < source.length && source[i] !== '\n') i++; continue; }
    const operator = /^(?:<<<|<<-|<<|>>|&&|\|\||\|&|[;|&()<>])/.exec(source.slice(i));
    if (operator) { tokens.push({ op: operator[0] }); i += operator[0].length; continue; }
    let value = '', quote = '', quoted = false, dynamic = false;
    while (i < source.length) {
      const c = source[i];
      if (!quote && (/[\s;|&()<>]/.test(c))) break;
      if (c === quote) { quote = ''; i++; continue; }
      // ANSI-C words require shell escape decoding; classify them as unreadable input.
      if (!quote && source.startsWith("$'", i)) dynamic = true;
      if (!quote && (c === "'" || c === '"')) { quote = c; quoted = true; i++; continue; }
      if (c === '\\' && quote !== "'") {
        const next = source[i + 1];
        if (!quote || /["\\$`\n]/.test(next || '')) {
          if (next !== '\n') value += next || '';
          i += next ? 2 : 1; continue;
        }
      }
      if (quote !== "'" && source.startsWith('$(', i)) {
        dynamic = true; value += '${substitution}'; substitution(i + 2); continue;
      }
      if (quote !== "'" && c === '`') {
        dynamic = true; value += '${substitution}'; substitution(i + 1, true); continue;
      }
      // Named, positional and special shell parameters are all unreadable input. SQL dollar
      // quoting must itself be shell-quoted/escaped, as in a quoted heredoc or single-quoted arg.
      if (quote !== "'" && c === '$' && /^\$[\w{@*?!$#-]/.test(source.slice(i))) dynamic = true;
      value += c; i++;
    }
    const token = { value, quoted, dynamic, unknown: !!quote };
    tokens.push(token);
    const previous = tokens[tokens.length - 2];
    if (previous && ['<<', '<<-'].includes(previous.op)) {
      previous.delimiter = value; previous.quoted = quoted; pending.push(previous);
    }
  }
  for (const redir of pending) redir.unknown = true;
  return { tokens, nested };
}

// Only explicitly supplied, bounded local SQL files are read. Never read environment/credential
// files or resolve shell variables. Missing/non-SQL/large input is an unknown SQL payload and blocks.
// A directory change can select a different relative input. Never inspect the wrong file.
function sqlFile(token, cwdUnknown = false) {
  if (!token || token.dynamic || token.unknown || !/\.sql$/i.test(token.value)) throw Error('unknown SQL file');
  if (cwdUnknown && !isAbsolute(token.value)) throw Error('unknown SQL working directory');
  const path = resolve(hook.cwd || process.cwd(), token.value);
  if (!statSync(path).isFile() || statSync(path).size > 1024 * 1024) throw Error('unknown SQL file');
  return readFileSync(path, 'utf8');
}
function literal(token) {
  if (!token || token.dynamic || token.unknown) throw Error('unknown SQL text');
  return token.value;
}
const executableName = (word) => (word || '').replace(/\\/g, '/').split('/').pop().replace(/\.exe$/i, '').toLowerCase();
// GNU env -S splits argv, not shell syntax. Never re-lex its operators as commands.
function envSplitWords(source) {
  const words = [];
  let value = '', quote = '', started = false, i = 0;
  const flush = () => { if (started) words.push({ value, quoted: true }); value = ''; started = false; };
  while (i < source.length) {
    const c = source[i++];
    if (!quote && /[ \t\n\v\f\r]/.test(c)) { flush(); continue; }
    if (!quote && c === '#' && !started) break;
    if (c === quote) { quote = ''; continue; }
    if (!quote && (c === "'" || c === '"')) { quote = c; started = true; continue; }
    if (c === '\\') {
      const escape = source[i];
      if (quote === "'" && !['\\', "'"].includes(escape)) { value += c; started = true; continue; }
      if (escape === undefined) throw Error('incomplete env split escape');
      i++;
      if (escape === 'c') {
        if (quote) throw Error('invalid quoted env terminator');
        break;
      }
      if (escape === '_') {
        if (quote === '"') { value += ' '; started = true; } else flush();
        continue;
      }
      const escapes = { f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '#': '#', '$': '$' };
      if (!Object.hasOwn(escapes, escape)) throw Error('unknown env split escape');
      value += escapes[escape]; started = true; continue;
    }
    if (c === '$' && quote !== "'") throw Error('unknown env split expansion');
    value += c; started = true;
  }
  if (quote) throw Error('unclosed env split quote');
  flush();
  return words;
}
function commandParts(tokens) {
  const words = [], inputs = [];
  let cwdUnknown = false, isolated = false, splits = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (['<', '<<', '<<-', '<<<', '>', '>>'].includes(token.op)) {
      const target = tokens[++i];
      if (token.op.startsWith('<')) inputs.push({ ...token, target });
    } else if (token.value !== undefined) words.push(token);
  }
  while (words[0]) {
    if (/^(?:[A-Za-z_]\w*=|(?:if|then|else|elif|do|!|\{|\})$)/.test(words[0].value)) { words.shift(); continue; }
    const launcher = executableName(words[0].value);
    if (!['sudo', 'env', 'command', 'exec', 'npx', 'npm', 'time'].includes(launcher)) break;
    if (launcher === 'npm' && words[1]?.value !== 'exec') break;
    if (['sudo', 'env', 'npx', 'npm'].includes(launcher)) isolated = true;
    words.shift();
    if (launcher === 'npm') words.shift();
    while (words[0]?.value.startsWith('-')) {
      const flagToken = words.shift();
      const flag = flagToken.value;
      const split = token => {
        const payload = literal(token);
        const quote = word => "'" + literal(word).replace(/'/g, "'\\''") + "'";
        return { words: [], inputs, cwdUnknown, isolated, shell: [payload, ...words.map(quote)].join(' ') };
      };
      const splitEnv = token => {
        if (++splits > 12) throw Error('env split nesting limit');
        words.unshift(...envSplitWords(literal(token)));
      };
      if (launcher === 'env' && flag.startsWith('--split-string=')) {
        splitEnv({ ...flagToken, value: flag.slice('--split-string='.length) }); continue;
      }
      // Wrapper short options may be grouped; a value option owns the remaining suffix.
      if (['env', 'sudo'].includes(launcher) && /^-[^-]/.test(flag)) {
        const valueFlags = launcher === 'env' ? 'uCS' : 'acCDgphRrtTUu';
        const booleanFlags = launcher === 'env' ? 'i0v' : 'AbBEHeikKlnNPsSVv';
        for (let j = 1; j < flag.length; j++) {
          const option = flag[j];
          if (launcher === 'sudo' && option === 'i') cwdUnknown = true;
          if (valueFlags.includes(option)) {
            const value = j + 1 < flag.length ? { ...flagToken, value: flag.slice(j + 1) } : words.shift();
            if ((launcher === 'env' && option === 'C') || (launcher === 'sudo' && 'DR'.includes(option))) cwdUnknown = true;
            if (launcher === 'env' && option === 'S') { splitEnv(value); break; }
            if (launcher === 'sudo' && option === 'h' && !value) break;
            if (!value) throw Error('missing wrapper option value');
            break;
          }
          if (!booleanFlags.includes(option)) throw Error('unknown wrapper option');
        }
        continue;
      }
      if (launcher === 'sudo' && flag === '--login') cwdUnknown = true;
      if ((launcher === 'env' && /^(?:-C|--chdir(?:=|$))/.test(flag)) ||
          (launcher === 'sudo' && /^(?:-D|--chdir(?:=|$))/.test(flag))) cwdUnknown = true;
      if (launcher === 'env' && flag === '--split-string') { splitEnv(words.shift()); continue; }
      if (launcher === 'npx' && ['-c', '--call'].includes(flag)) {
        return split(words.shift());
      }
      const valueFlags = launcher === 'sudo' ? ['-u', '-g', '-h', '-p', '-D', '--user', '--group', '--host', '--prompt', '--chdir']
        : launcher === 'env' ? ['-u', '--unset', '-C', '--chdir']
        : launcher === 'time' ? ['-f', '--format', '-o', '--output']
        : ['npx', 'npm'].includes(launcher) ? ['-p', '--package', '--cache', '--prefix', '--registry'] : [];
      if (valueFlags.includes(flag)) words.shift();
      if (flag === '--') break;
    }
  }
  return { words, inputs, cwdUnknown, isolated };
}
function stdinText(part, upstream) {
  if (part.inputs.length) return part.inputs.map((input) => {
    if (input.unknown) throw Error('unknown heredoc');
    if (input.op === '<') return sqlFile(input.target, part.inputCwdUnknown);
    if (input.op === '<<<') return literal(input.target);
    if (typeof input.body !== 'string') throw Error('unknown heredoc body');
    return input.body;
  }).join('\n');
  if (!upstream) return null;
  const name = executableName(upstream.words[0]?.value);
  const args = upstream.words.slice(1);
  if (name === 'cat') {
    if (args.length) return args.filter(t => t.value !== '--').map(t => sqlFile(t, upstream.cwdUnknown)).join('\n');
    const text = stdinText(upstream, upstream.upstream);
    if (text !== null) return text;
  }
  const decode = text => {
    if (/\\(?![nrt\\])/.test(text)) throw Error('unknown producer escape');
    return text.replace(/\\([nrt\\])/g, (_, escape) => ({ n: '\n', r: '\r', t: '\t', '\\': '\\' })[escape]);
  };
  if (name === 'echo') {
    const text = args.filter(t => !/^-[neE]+$/.test(t.value)).map(literal).join(' ');
    return args.some(t => /^-[nE]*e[nE]*$/.test(t.value)) ? decode(text) : text;
  }
  if (name === 'printf') {
    const values = args.map(literal);
    const format = values.shift();
    if (format === undefined || /%(?!%|s|b)/.test(format)) throw Error('unknown printf input');
    const rendered = [];
    do {
      rendered.push(decode(format).replace(/%%|%[sb]/g, match => {
        if (match === '%%') return '%';
        const value = values.shift() || '';
        return match === '%b' ? decode(value) : value;
      }));
    } while (values.length && /%[sb]/.test(format));
    return rendered.join('');
  }
  throw Error('unknown SQL stdin producer');
}

function sqlInputs(source, depth = 0, inheritedCwdUnknown = false) {
  if (depth > 12) throw Error('shell nesting limit');
  const { tokens, nested } = shellTokens(source);
  const nestedCwdUnknown = inheritedCwdUnknown || tokens.some(t => ['cd', 'pushd', 'popd'].includes(t.value));
  const sql = nested.flatMap(text => sqlInputs(text, depth + 1, nestedCwdUnknown));
  let group = [], upstream = null;
  let shellCwdUnknown = inheritedCwdUnknown;
  function consume(pipe) {
    const part = commandParts(group); group = [];
    part.upstream = upstream;
    part.inputCwdUnknown = shellCwdUnknown;
    part.cwdUnknown ||= shellCwdUnknown;
    const { words } = part;
    if (part.shell !== undefined) sql.push(...sqlInputs(part.shell, depth + 1, part.cwdUnknown));
    const name = executableName(words[0]?.value);
    const args = words.slice(1);
    if (!part.isolated && ['cd', 'pushd', 'popd'].includes(name)) shellCwdUnknown = true;
    if (['bash', 'sh', 'zsh', 'dash', 'pwsh', 'powershell'].includes(name)) {
      const index = args.findIndex(t => /^-(?:[a-z]*c|command)$/i.test(t.value));
      if (index >= 0) sql.push(...sqlInputs(literal(args[index + 1]), depth + 1, part.cwdUnknown));
    }
    const toolArgs = [...args];
    while (toolArgs[0]?.value.startsWith('-')) {
      const flag = toolArgs.shift().value;
      if (['--workdir', '--project-id', '--config', '--schema'].includes(flag)) toolArgs.shift();
    }
    const supabase = name === 'supabase' && ['db', 'migration'].includes(toolArgs[0]?.value);
    const prisma = name === 'prisma' && toolArgs[0]?.value === 'db' && toolArgs[1]?.value === 'execute';
    const client = ['psql', 'pgcli', 'mysql', 'sqlite3', 'duckdb', 'pg_restore'].includes(name) || supabase || prisma;
    if (client) {
      let found = false;
      const add = text => sql.push({ text, mysql: name === 'mysql', client: name });
      const positions = [];
      for (let i = 0; i < args.length; i++) {
        // MySQL accepts underscores and dashes interchangeably in long option names.
        const rawArg = args[i].value;
        const arg = name === 'mysql' && rawArg.startsWith('--')
          ? rawArg.replace(/^[^=]+/, option => option.replace(/_/g, '-')) : rawArg;
        if (arg === '--') { positions.push(...args.slice(i + 1)); break; }
        // Grouped psql flags: the first value option consumes the suffix or next word.
        if (name === 'psql' && /^-[^-]/.test(arg)) {
          for (let j = 1; j < arg.length; j++) {
            const flag = arg[j];
            if ('cfdhFLopPRTUv'.includes(flag)) {
              const input = j + 1 < arg.length ? { ...args[i], value: arg.slice(j + 1) } : args[++i];
              if (flag === 'c' || flag === 'f') { add(flag === 'f' ? sqlFile(input, part.cwdUnknown) : literal(input)); found = true; }
              break;
            }
            if (!'aAbeEHlnqsStwWxXz01V?'.includes(flag)) throw Error('unknown psql option');
          }
          continue;
        }
        if (name === 'mysql' && /^-[^-]/.test(arg)) {
          for (let j = 1; j < arg.length; j++) {
            const flag = arg[j];
            if ('DehPuS'.includes(flag)) {
              const input = j + 1 < arg.length ? { ...args[i], value: rawArg.slice(j + 1) } : args[++i];
              if (flag === 'e') { add(literal(input)); found = true; }
              break;
            }
            // A short password is optional and must be attached, never the next word.
            if (flag === 'p') break;
            if (!'ABbCcEfGHiInNqrsstvVwW'.includes(flag)) throw Error('unknown mysql option');
          }
          continue;
        }
        const inline = arg !== '-cmd' && /^(?:--(?:command|execute|sql|query|cmd|init-command|init-command-add)=|-[ce](?=.+))([\s\S]*)$/.exec(arg);
        const file = /^(?:--file=|-f(?=.+))([\s\S]*)$/.exec(arg);
        if (inline || file) {
          const input = { ...args[i], value: (inline || file)[1] };
          add(file ? sqlFile(input, part.cwdUnknown) : literal(input)); found = true;
        } else if (['-c', '-e', '-cmd', '--command', '--execute', '--sql', '--query', '--cmd', '--init-command', '--init-command-add'].includes(arg)) {
          add(literal(args[++i])); found = true;
        } else if (['-f', '--file', '-init'].includes(arg)) {
          add(sqlFile(args[++i], part.cwdUnknown)); found = true;
        } else if (['psql', 'mysql'].includes(name) && arg.startsWith('--')) {
          // Exact metadata names only: getopt clients may execute abbreviated options.
          const option = arg.split('=', 1)[0];
          const valueOptions = name === 'psql'
            ? ['--dbname', '--host', '--port', '--username', '--set', '--variable', '--output', '--field-separator', '--record-separator', '--log-file', '--pset', '--table-attr']
            : ['--database', '--host', '--port', '--user', '--socket', '--default-character-set', '--connect-timeout', '--protocol', '--bind-address', '--ssl-mode', '--ssl-ca', '--ssl-capath', '--ssl-cert', '--ssl-key', '--ssl-cipher', '--tls-version', '--character-sets-dir', '--compression-algorithms', '--default-auth', '--histignore', '--max-allowed-packet', '--max-join-size', '--net-buffer-length', '--plugin-dir', '--prompt', '--select-limit', '--server-public-key-path', '--shared-memory-base-name', '--ssl-crl', '--ssl-crlpath', '--ssl-fips-mode', '--ssl-session-data', '--tee', '--tls-ciphersuites', '--tls-sni-servername', '--zstd-compression-level'];
          const flagOptions = name === 'psql'
            ? ['--password', '--no-password', '--no-psqlrc', '--no-readline', '--no-align', '--html', '--list', '--quiet', '--single-line', '--single-step', '--single-transaction', '--tuples-only', '--csv', '--expanded', '--echo-all', '--echo-errors', '--echo-queries', '--echo-hidden', '--field-separator-zero', '--record-separator-zero', '--help', '--version']
            : ['--password', '--password1', '--password2', '--password3', '--skip-password', '--no-defaults', '--batch', '--column-names', '--skip-column-names', '--comments', '--skip-comments', '--compress', '--force', '--html', '--line-numbers', '--skip-line-numbers', '--local-infile', '--named-commands', '--no-beep', '--no-auto-rehash', '--skip-auto-rehash', '--one-database', '--quick', '--raw', '--reconnect', '--skip-reconnect', '--safe-updates', '--silent', '--table', '--unbuffered', '--vertical', '--xml', '--binary-mode', '--show-warnings', '--verbose', '--help', '--version', '--auto-rehash', '--auto-vertical-output', '--binary-as-hex', '--column-type-info', '--commands', '--connect-expired-password', '--debug', '--debug-check', '--debug-info', '--enable-cleartext-plugin', '--get-server-public-key', '--i-am-a-dummy', '--pager', '--pipe', '--print-defaults', '--sigint-ignore', '--skip-pager', '--skip-system-command', '--ssl-session-data-continue-on-failed-reuse', '--system-command', '--wait'];
          if (valueOptions.includes(option)) {
            if (!arg.includes('=')) { if (!args[++i]) throw Error('missing client option value'); }
          } else if (!flagOptions.includes(option) && !(name === 'mysql' && flagOptions.includes(option.replace(/^--(?:skip|disable|enable)-/, '--')))) throw Error('unknown SQL client option');
          // Password prompts/optional attached values never consume the following option.
        } else if (arg.startsWith('-')) {
          // Option values are connection metadata/pathnames, never inline SQL.
          if (['-d', '-h', '-p', '-U', '-u', '-P', '-v', '-o', '--dbname', '--host', '--port', '--username', '--database', '--password', '--set', '--output'].includes(arg)) i++;
        } else positions.push(args[i]);
      }
      // sqlite3/duckdb take a database path then positional SQL; mysql/psql positional values
      // are connection metadata. Do not screen paths or database names for SQL keywords.
      if (['sqlite3', 'duckdb'].includes(name) && positions.length > 1) {
        positions.slice(1).map(literal).forEach(add); found = true;
      }
      const stdin = stdinText(part, upstream);
      if (stdin !== null) { add(stdin); found = true; }
      // Migration/restore commands execute opaque files or scripts, rather than inline SQL.
      if (!found && (supabase || prisma || name === 'pg_restore')) throw Error('opaque SQL execution');
    }
    upstream = pipe ? part : null;
  }
  for (const token of tokens) {
    if (token.op && [';', '&&', '||', '|', '|&', '&', '(', ')'].includes(token.op)) consume(['|', '|&'].includes(token.op));
    else group.push(token);
  }
  consume(false);
  return sql;
}

// MySQL # comments cannot supply WHERE. Executable comments are opaque SQL and block.
// Preserve literal text for the existing conservative destructive-keyword screen.
function mysqlSql(source) {
  let out = '', i = 0;
  while (i < source.length) {
    if (source[i] === '#' || (source.startsWith('--', i) && /\s/.test(source[i + 2] || ' '))) {
      const end = source.indexOf('\n', i), next = end < 0 ? source.length : end;
      out += source.slice(i, next).replace(/[^\n]/g, ' '); i = next; continue;
    }
    if (source.startsWith('/*!', i)) throw Error('opaque MySQL executable comment');
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw Error('unclosed SQL comment');
      out += source.slice(i, end + 2).replace(/[^\n]/g, ' '); i = end + 2; continue;
    }
    if (source[i] === '"' || source[i] === "'" || source.charCodeAt(i) === 96) {
      const quote = source[i], start = i++;
      let closed = false;
      while (i < source.length) {
        // SQL modes alter escapes. Without server mode, do not infer trustworthy scope.
        if (source.charCodeAt(i) === 92) throw Error('unknown MySQL string escape');
        if (source[i++] === quote) {
          if (source[i] === quote) { i++; continue; }
          closed = true; break;
        }
      }
      if (!closed) throw Error('unclosed SQL quote');
      out += source.slice(start, i);
      continue;
    }
    out += source[i++];
  }
  return out;
}

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

// Quote removal can reveal malformed SQL (e.g. a shell-consumed backslash in an E string).
// Such input cannot supply a trustworthy WHERE clause. Retain PR #44's nested-comment depth.
function validateSql(sql) {
  for (let i = 0; i < sql.length;) {
    if (sql.startsWith('/*', i)) {
      const comment = scanBlockComment(sql, i);
      if (comment.open) throw Error('unclosed SQL comment');
      i = comment.end; continue;
    }
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i); i = end < 0 ? sql.length : end + 1; continue;
    }
    const dollar = /^\$([A-Za-z_]\w*|)\$/.exec(sql.slice(i));
    if (dollar) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length);
      if (end < 0) throw Error('unclosed SQL dollar body');
      i = end + dollar[0].length; continue;
    }
    const escape = /[Ee]/.test(sql[i]) && sql[i + 1] === "'" && !/[\w$]/.test(sql[i - 1] || '');
    if (escape || sql[i] === "'" || sql[i] === '"') {
      if (escape) i++;
      const quote = sql[i++];
      let closed = false;
      while (i < sql.length) {
        if (escape && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; }
          i++; closed = true; break;
        }
        i++;
      }
      if (!closed) throw Error('unclosed SQL quote');
      continue;
    }
    i++;
  }
}

// WHERE judgement masks comments, quoted text and dollar bodies without exposing nested contents.
// Ordinary strings assume standard_conforming_strings=on; only E/e strings escape backslashes.
const MASK_TOKEN = /--[^\n]*|(?<![\w$])[Ee]'(?:[^'\\]|\\[\s\S]|'')*(?:'|$)|'(?:[^']|'')*(?:'|$)|"(?:[^"]|"")*(?:"|$)|\$([A-Za-z_]\w*|)\$[\s\S]*?(?:\$\1\$|$)/y;
function maskSql(s, mysql = false) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s.startsWith('/*', i)) {
      const { end } = scanBlockComment(s, i);
      out += s.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    if (mysql && s.charCodeAt(i) === 96) {
      let end = i + 1;
      while (end < s.length) {
        if (s.charCodeAt(end++) === 96) {
          if (s.charCodeAt(end) === 96) { end++; continue; }
          break;
        }
      }
      out += s.slice(i, end).replace(/[^\n]/g, ' '); i = end; continue;
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
const unscoped = (sql, re, mysql = false) => (sql.match(re) || []).some((st) => !hasTopLevelWhere(maskSql(st, mysql)));

// UPDATE ... SET as a statement (shell words like `apt-get update` have no SET); not ON CONFLICT DO UPDATE.
const UPDATE_STATEMENT = /(?<!\b(?:DO|FOR|KEY|BEFORE|AFTER|OR|OF|ON|GRANT|REVOKE)\s*)(?<!,\s*)\bUPDATE\s+(?:ONLY\s+)?\S+(?:\s+(?:AS\s+)?\S+)?\s+SET\b[^;]*/gi;
const DYNAMIC_SQL = /\bEXECUTE\b(?!\s+(?:FUNCTION|PROCEDURE|ON)\b)(?!\s*,)|\bformat\s*\(|\bdblink(?:_exec)?\s*\(|\\gexec\b/i;

let destructive = false;
try {
  for (const input of sqlInputs(cmd)) {
    const sql = input.mysql ? mysqlSql(input.text) : input.text;
    const visible = maskSql(sql, input.mysql);
    // Include commands recursively load unchecked files; refuse them rather than guessing.
    if (/\\(?:i|ir)\b/i.test(visible)) throw Error('opaque psql include');
    if (input.mysql && (/(?:^|[;\n])\s*source\b/i.test(visible) || /\\\./.test(visible))) throw Error('opaque MySQL include');
    if (['sqlite3', 'duckdb'].includes(input.client) && /^\s*\.[A-Za-z]/m.test(visible)) throw Error('opaque client meta-command');
    validateSql(sql);
    if (/\bDROP\s+TABLE\b/i.test(sql)) destructive = true;
    if (/\bTRUNCATE\b/i.test(sql)) destructive = true;
    // Retain the conservative PR #44 rule: any DROP after ALTER TABLE within this SQL input
    // blocks, even across quoted/commented semicolons or nested PostgreSQL block comments.
    if (/\bALTER\s+TABLE\b[\s\S]*\bDROP\b/i.test(sql)) destructive = true;
    if (unscoped(sql, /\bDELETE\s+FROM\b[^;]*/gi, input.mysql)) destructive = true;
    if (unscoped(sql, UPDATE_STATEMENT, input.mysql)) destructive = true;
    if (/\bDROP\s+(POLICY|INDEX|SCHEMA|DATABASE)\b/i.test(sql)) destructive = true;
    if (DYNAMIC_SQL.test(sql)) destructive = true;
  }
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
