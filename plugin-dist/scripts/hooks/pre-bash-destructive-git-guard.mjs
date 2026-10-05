#!/usr/bin/env node
// pre-bash-destructive-git-guard.mjs
//
// PreToolUse(Bash) hook -- blocks Bash commands containing destructive git operations.
// Node twin of pre-bash-destructive-git-guard.ps1 (cross-platform port P2, T1a).
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
if (!hook || hook.tool_name !== 'Bash') process.exit(0);

const cmd = hook.tool_input && typeof hook.tool_input.command === 'string' ? hook.tool_input.command : '';
if (!cmd) process.exit(0);

let blocked = false;
let reason = '';

if (/\bgit\s+push\s+(-{1,2}f(orce)?|--force-with-lease)\b/i.test(cmd) && /\b(main|master)\b/i.test(cmd)) {
  blocked = true;
  reason = 'git push --force on main/master';
} else if (/\bgit\s+reset\s+--hard\b/i.test(cmd)) {
  blocked = true;
  reason = 'git reset --hard (use git stash or git revert instead)';
} else if (/\bgit\s+clean\s+-f/i.test(cmd)) {
  blocked = true;
  reason = 'git clean -f (destructive)';
} else if (/\bgit\s+branch\b/.test(cmd) && (/(^|\s)-D(\s|$)/.test(cmd) || /--force\b/.test(cmd))) {
  // Case-sensitive -D check (was /i, which false-matched safe lowercase -d --
  // git's own merge-verified delete). --force also catches --delete --force.
  blocked = true;
  reason = 'git branch -D / --delete --force (force-delete)';
}

if (blocked) {
  process.stderr.write(`[BLOCKED] Destructive git operation: ${reason}\n`);
  process.stderr.write('          Get explicit approval from the project owner before retrying.\n');
  process.exit(2);
}

process.exit(0);
