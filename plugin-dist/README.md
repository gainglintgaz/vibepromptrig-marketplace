# VibePromptRig

VibePromptRig is a Claude Code plugin with reusable workflows for AI-assisted software development: planning a change, setting up a project, implementing, reviewing, and verifying that the work holds up. It adds 9 skills, 3 commands, 14 specialist agents, 4 workflows, safety hooks, compact rule cards, and the `forge` command-line tools.

It is built for **Claude Code** (the terminal, the IDE extensions, and the desktop app's Code tab). Most of it reads and writes files in your project folder and runs Node.js scripts, so it needs a terminal session with a project open.

## Install and first run

You need Claude Code with plugin support, Git, and Node.js 18 or newer.

```bash
claude plugin marketplace add gainglintgaz/vibepromptrig-marketplace
claude plugin install vibepromptrig@vibepromptrig
```

Restart Claude Code, open your own project, and run `/vibepromptrig:setup`. It scans the project, asks five questions, and proposes up to five MCP servers, rule packs, and hook packs. It changes nothing in your project (MCP entries, rule packs, hook packs) until you approve each item, and it writes a rollback file before the first approved change. On Windows it also keeps its own local record of the run, even when you approve nothing: an audit line in `.claude/setup-audit.jsonl`, plus `.claude/setup-manifest.json` when the run reaches its last step. Neither is sent anywhere. On macOS and Linux it writes no files at all and prints the changes as a checklist to apply by hand. [INSTALL.md](INSTALL.md) covers updates, local checkouts, and removal.

## Where it works

What each surface loads follows Anthropic's plugin platform matrix. Only Claude Code has been tested with VibePromptRig.

| Surface | What loads | What works |
| --- | --- | --- |
| Claude Code | Skills, commands, agents, hooks | Everything in this README. Tested on Windows; the last signed-in `/vibepromptrig:setup` run was on release 5.1.5. |
| Cowork | Skills, commands, agents, hooks | Not tested. The skills expect a local project folder, Node.js, and Git. |
| Chat (claude.ai web, desktop, mobile) | Skills; commands load as skills | Agents and hooks are ignored, so no hook guard runs in chat. Every skill and command needs a terminal and a project folder; each one says so and asks you to switch to Claude Code. |

**Operating systems.** The hooks and `forge` tools run on Windows, macOS, and Ubuntu; their tests run on all three. `/vibepromptrig:setup` proposes changes on all three, but its automated write step runs only on Windows today. On macOS and Ubuntu it prints the exact changes as a checklist for you to apply.

## What the hooks do

The plugin registers 13 hook handlers. Each runs `node` on a script inside the plugin (`${CLAUDE_PLUGIN_ROOT}/scripts/hooks/`). None of them opens a network connection or sends data off your machine; a few print a short note into the session. A guard that blocks a tool call exits with code 2 and explains why; every other hook fails open. Set the environment variable `VIBE_HOOKS_DISABLE=1` to turn off the blocking guards and the session lock.

SQL string scanning assumes PostgreSQL's default `standard_conforming_strings=on`: ordinary strings keep backslashes literal; `E`-prefixed strings use backslash escapes. The guards do not inspect the database session setting.

Two switches control files the hooks write:

- **Project consent** is the file `.claude/vibepromptrig.json` with `{"session_notes": true}` in your project. `/vibepromptrig:setup` creates it only if you approve session notes. Without it, no hook writes into your project.
- **Operator ledger** (`factory_metrics.jsonl`: one line per run of the capture hooks `post-session-enforcer.mjs`, `session-budget-tracker.mjs`, `signal-batch-analyzer.mjs`, and `signal-classifier-tier1.mjs`, plus session summaries; the guards and `session-guard.mjs` do not write to it) is written only when the environment variable `VIBE_ROOT` names a VibePromptRig source checkout, and only inside that checkout. Customers normally do not set it; without it, no ledger is written.

<!-- hook-disclosure:start -->
| Event | Matcher | Runs | Reads | Writes (where) | Network | Consent needed |
| --- | --- | --- | --- | --- | --- | --- |
| PreToolUse | `Bash` | `pre-bash-destructive-sql-guard.mjs` | The shell command Claude is about to run | Nothing. Fails closed on these selected inline SQL patterns and prints review steps, with no confirmation input; passing does not prove SQL safe. Screens `DROP TABLE`, `TRUNCATE`, `ALTER TABLE ... DROP`, `DROP POLICY/INDEX/SCHEMA/DATABASE`, `DELETE FROM` or `UPDATE ... SET` without a top-level `WHERE` (one inside a subquery or CTE does not count), and, in a command that runs SQL (`psql`, `supabase db`, a `DO` block), dynamic SQL (`EXECUTE`, `format()`, `dblink`, `\gexec`) | None | None |
| PreToolUse | `Bash` | `pre-bash-destructive-git-guard.mjs` | The shell command Claude is about to run | Nothing. Blocks command text containing `git push` immediately followed by `-f`, `--force`, or `--force-with-lease` and a `main` or `master` word. A force flag after the remote or branch (for example, `git push origin main --force`) is not recognized. Also blocks `git reset --hard`, `git clean -f`, and `git branch -D` | None | None |
| PreToolUse | `Bash` | `session-guard.mjs -Event prewrite` | The shell command; the session lock file | Refreshes this session's lock. Without consent the lock lives in the OS temp folder (`vibepromptrig-session-locks/`); with consent, in `.claude/.session-lock.json`. Blocks `git commit` or `git push` for callers identified as interactive CLI (`cli`) while another session holds a fresh lock on the same project. Desktop, SDK and unknown entrypoints warn only; the lock owner need not be interactive | None | None; consent only moves the lock into the project |
| PreToolUse | `^mcp__.+__apply_migration$` | `pre-migration-destructive-guard.mjs` | The text fields of an MCP `apply_migration` call (for example Supabase's) | Nothing. Fails closed on listed patterns and SQL it cannot tokenize; prints review steps but has no confirmation input. Screens selected DROP, TRUNCATE, ALTER TABLE ... DROP, unqualified DELETE/UPDATE and dynamic SQL patterns (`EXECUTE` of a string or variable, `format()`, `dblink`), plus SQL it cannot tokenize (a literal, quoted identifier, comment or `$$` body that never closes). `EXECUTE FUNCTION` in triggers and `GRANT EXECUTE` are allowed. Passing does not prove arbitrary SQL safe; database authorization, restorable backups and human review remain necessary | None | None |
| PreToolUse | `Write` | `pre-write-mcp-advisor.mjs` | The path and content of a file Claude is about to write | Nothing. Screens new files and replacements of existing files. Blocks a Write payload of 20+ nonblank lines under `scripts/`, `lib/`, `.claude/agents/` or `.claude/skills/` that looks like it re-implements an existing MCP server or skill, unless the file contains a `Justified:` line | None | None |
| SessionStart | `(any)` | `session-guard.mjs -Event start` | The project folder path; the session lock file | Claims the session lock (OS temp folder, or `.claude/.session-lock.json` with consent) or prints a warning that another session holds it | None | None; consent only moves the lock into the project |
| Stop | `(any)` | `post-session-enforcer.mjs` | Recent commits and diff stats from local `git log` and `git diff`; modification times of tracking files | With consent: `SESSION_DEBRIEF.md`, a `CHANGELOG.md` entry, and `VERSION.md` in the project. With an operator ledger: a line in its `factory_metrics.jsonl` | None (runs the local `git` program only) | Project consent |
| Stop | `(any)` | `signal-batch-analyzer.mjs` | The project's `.claude/signal-log.jsonl` | With consent: a summary in `SESSION_DEBRIEF.md` and suggestions in `PENDING_APPROVALS.md` in the project. With an operator ledger: a line in its `factory_metrics.jsonl` | None | Project consent |
| Stop | `(any)` | `session-budget-tracker.mjs` | Token counts from this session's transcript file; the project's `.forge/profile.json` if present | With an operator ledger: a session summary in its `factory_metrics.jsonl`. Nothing in the project | None | Operator ledger only |
| Stop | `(any)` | `session-guard.mjs -Event stop` | The session lock file | Releases the lock this session holds | None | None |
| UserPromptSubmit | `(any)` | `signal-classifier-tier1.mjs` | Your prompt text, matched against the ledger's signal list | With consent and an operator ledger: a line in the project's `.claude/signal-log.jsonl` with the matched signals and a 200-character excerpt after scrubbing (the excerpt is dropped if it looks like a secret). May print a short signal note, such as a security reminder, into the session. With an operator ledger: a line in its `factory_metrics.jsonl` | None | Project consent and operator ledger |
| UserPromptSubmit | `(any)` | `session-budget-tracker.mjs` | Token counts from this session's transcript file; the project's `.forge/profile.json` if present | Nothing in the project. May print a budget notice into the session at 80% and 100% of the session budget. With an operator ledger: a line in its `factory_metrics.jsonl` | None | None; ledger lines need an operator ledger |
| UserPromptSubmit | `(any)` | `session-guard.mjs -Event heartbeat` | The session lock file | Refreshes this session's lock | None | None; consent only moves the lock into the project |
<!-- hook-disclosure:end -->

Portal note: hooks that run Node.js files from a repository subfolder are held for an Anthropic reviewer. That is expected for this plugin.

## Other things it runs or reads

- **Web access by agents and skills you invoke.** The `mcp-advisor`, `tech-radar`, `planner`, `marketer`, and `hostile-architect` agents and the `architect-probe` skill can use Claude Code's own web search and fetch tools. They do so only when you run them, and Claude Code asks for permission as usual.
- **Optional model router, not wired.** `.claude/lib/router/` is TypeScript source for an optional multi-provider router. It ships uncompiled, without dependencies, and no hook, skill, command, or agent runs it. If you build and run it yourself, it reads `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `PERPLEXITY_API_KEY`, and `XAI_API_KEY` from your environment and sends prompts to those providers. The plugin never asks for these keys.
- **Backup scripts you run yourself.** `scripts/pg-dump-offsite.mjs`, `scripts/restore-drill.mjs`, and `scripts/custody-storage.mjs` read database and storage connection settings from environment variables that you name in their configuration. No hook, skill, or command runs them.
- **MCP servers proposed by `/vibepromptrig:setup`.** Setup can add entries to your project's `.mcp.json` after you approve them. Those servers are third-party services. Stripe, Supabase and Vercel are hosted servers that sign you in through your browser (OAuth), Supabase read-only and scoped to a development project; GitHub uses a token you supply; the one `npx` package is pinned to an exact version. Setup shows each command before you approve it.

## What is in the package

| Path | Purpose |
| --- | --- |
| `skills/`, `commands/`, `agents/`, `workflows/` | Claude Code entry points |
| `hooks/hooks.json`, `scripts/` | The hooks above, the `forge` tools, and supporting scripts |
| `.forge/context/`, `.claude/rules-manifest.json` | Compact rule cards and the rule manifest |
| `docs/` | The safeguards reference and five reference rules used by packaged tools |
| `catalog.json` | The curated catalog `/vibepromptrig:setup` reads |
| `INSTALL.md`, `LICENSE` | Installation guide and license |

Examples in the shipped rules and templates use anonymized project names. They are teaching examples, not customer case studies.

## License

MIT. Copyright (c) 2026 gainglintgaz. See [LICENSE](LICENSE).

The code-of-conduct template (`scripts/templates/public/CODE_OF_CONDUCT.md`) adapts Contributor Covenant 2.1 by Coraline Ada Ehmke under CC BY 4.0; that file keeps its attribution and license link. External packages named in dependency manifests are not bundled and keep their own licenses.
