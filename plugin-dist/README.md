# VibePromptRig

VibePromptRig is a Claude Code plugin with reusable workflows for clarifying a project goal, planning a change, setting up tools, reviewing, and verifying work. It adds 19 skills, 3 commands, 15 specialist agents, 4 workflows, safety hooks, compact rule cards, and the `forge` command-line tools.

It is built for **Claude Code** (the terminal, the IDE extensions, and the desktop app's Code tab). Most of it reads and writes files in your project folder and runs Node.js scripts, so it needs a terminal session with a project open.

**Which version this describes.** This README describes VibePromptRig 5.2.0, the version in this source's `.claude-plugin/plugin.json`. Check the version you have with `claude plugin list`. To upgrade from an earlier version, run `claude plugin marketplace update vibepromptrig`, then `claude plugin update vibepromptrig@vibepromptrig`. 5.2.0 has not been submitted to Anthropic's plugin directory.

## Requirements

- Claude Code with plugin support, Git, and Node.js 18 or newer. Node.js 18 covers the hooks, the `/vibepromptrig:setup` helpers and the `forge` tools.
- The optional workforce coordination route (see below) also needs Windows and Node.js 24 or newer. It refuses older Node.js versions before opening a loop. Node.js 18 is not enough for it, and it is supported only on Windows. It also requires a signed-in Codex CLI, an existing Claude cloud session, Git for Windows and the .NET Framework `csc` compiler; see the [quickstart prerequisites](docs/tutorials/workforce-quickstart.md#1-check-the-host).
- Shell for the commands in this README and [INSTALL.md](INSTALL.md): on Windows, Windows PowerShell 5.1 (`powershell`) or PowerShell 7 (`pwsh`); on macOS and Linux, bash or zsh. The `claude plugin` commands are the same in every shell. Bash variable syntax such as `${NAME}` does not work in PowerShell, so use the PowerShell blocks where both are shown.

## Install and first run

Follow these steps in this order. Each step says what it writes.

1. **Install.** With the default user scope, this writes only inside your Claude configuration folder (the marketplace copy, the plugin cache and Claude Code's plugin settings), not to your project. These lines are the same in PowerShell and bash:

   ```text
   claude plugin marketplace add gainglintgaz/vibepromptrig-marketplace
   claude plugin install vibepromptrig@vibepromptrig
   claude plugin list
   ```

   Check the version that `claude plugin list` reports (see "Which version this describes" above).

2. **Restart Claude Code and open your own project folder.** This saves nothing into your project by default. The plugin's SessionStart hook claims a session lock in the OS temp folder (`vibepromptrig-session-locks/`); the lock is kept inside the project (`.claude/.session-lock.json`) only if the project has consent (`.claude/vibepromptrig.json` with session notes approved). See [What writes where](#what-writes-where).

3. **Run `/vibepromptrig:setup`.** It starts with what you want to achieve, what you already have, a useful first result and your limits. Ideas, physical products, research, services, writing and software all fit; an empty folder does not need Git or a software framework. It summarizes one next step before asking about relevant optional tools. For software tooling it can propose up to five connections, instruction packs or automated checks. Questions and suggestions write nothing. Each change needs your approval, and setup writes an undo record (`.claude/setup-rollback-<run-id>.md`) before the first change. Claude follows these setup steps as written instructions; no separate program enforces the undo-record order, so check the undo record before you rely on it. Setup's local `.claude/setup-audit.jsonl` and `.claude/setup-manifest.json` records also need a disclosed, approved save. On macOS and Linux, tooling setup prints a manual checklist and writes nothing.

4. **Optional: initialize `forge` project state.** Setup does not need this step, and the hooks, goal, checkup and handoff flows work without it. Run it only if you want a per-project `forge` profile, editable routine, cockpit and budget settings, or the compact instruction entry files. It is a separate command you run yourself. It writes `.forge/` state and instruction files such as `AGENTS.md` and `.claude/CLAUDE.md`, refuses to replace instruction files you already have, and keeps an undo record. [INSTALL.md](INSTALL.md#initialize-forge-project-state-optional) gives the exact PowerShell and bash commands and the full file list.

[INSTALL.md](INSTALL.md) also covers updates, local checkouts, removal and undo.

`/vibepromptrig:project-goal`, `/vibepromptrig:checkup` and `/vibepromptrig:truth-audit` share an optional local `.vibepromptrig/checkup.json` summary. Checkup compares supported documented command and path claims with current files, offline; a declared test is not a passed test, and an offline merge claim remains unverified. Saving needs review and explicit approval; it adds exact-byte undo metadata under `.vibepromptrig/backups/` and refuses stale changes. It never starts a build, connection, research session or agent team automatically. No raw transcript is retained. Other claims and actual runtime outcomes still need evidence.

## Continue and maintain a project

`/vibepromptrig:project-author` drafts one project-specific skill, agent or section of project instructions
from files you choose. It prefers existing tools, shows the draft and permissions, and saves only after
your approval. A saved draft still needs a real Claude Code trial to check when it activates and whether
it helps. `/vibepromptrig:refresh-context` proposes small, evidence-linked corrections to supported wrong
command or path claims found by checkup. It preserves surrounding custom text and refuses uncertain findings.

`/vibepromptrig:handoff` previews a short where-we-left-off note; `/vibepromptrig:resume` checks it against
current scoped files and Git state before suggesting a next step. Resume never runs that step or renews
old permissions. `/vibepromptrig:import-history` previews a bounded local Git history using commit IDs and
dates, without author identities, messages, changes or invented lessons. No network import runs.

Previews write nothing. Approved saves may create `.vibepromptrig/handoff.json`,
`.vibepromptrig/history.json`, the exact reviewed native Markdown target and recovery records under
`.vibepromptrig/backups/`. These optional records are not automatically ignored by Git: without the offered .gitignore entry, `git add -A` can include them in a commit. Keep context and backup contents private by reviewing that entry before saving. Reviewed saves are tied to this project
folder, refuse stale sources and targets, and support exact undo that preserves later edits. A crash
keeps its recovery record and lock for review; it does not silently retry. Native permission controls
remain authoritative. These new flows have local fixture coverage; signed-in usability is pending.

## What writes where

Previews, initialization, temporary locks and saved notes are different kinds of writes:

| Kind | When it happens | Where it writes |
| --- | --- | --- |
| Questions, suggestions and previews themselves (setup, checkup, handoff, resume, import-history) | Every time | Nothing is saved by these operations. Hooks running in the same session still refresh the session lock and, only with consent, write session notes, as the rows below describe |
| Plugin installation | `claude plugin install` or `update` | Your Claude configuration folder (marketplace copy, plugin cache and plugin settings, with the default user scope); nothing in your project |
| Session lock (hooks) | Every Claude Code session | The OS temp folder (`vibepromptrig-session-locks/`); inside the project (`.claude/.session-lock.json`) only with project consent. Normally released when the session stops |
| Initialization (optional) | Only when you run the `forge` initializer | `.forge/` profile and state, compact instruction and context files, and an undo record; see [INSTALL.md](INSTALL.md#initialize-forge-project-state-optional) |
| Setup additions (Windows) | Each change you approve | The undo record first, then the approved `.mcp.json` entries or packs; setup records only with an approved save |
| Saved project notes (optional) | Each reviewed save you approve | `.vibepromptrig/checkup.json`, `handoff.json`, `history.json`, a reviewed Markdown target, and undo records in `.vibepromptrig/backups/` |
| Session notes (optional) | When a session stops or a prompt is sent, only after you opt in | `SESSION_DEBRIEF.md`, a `CHANGELOG.md` entry, `VERSION.md` and `PENDING_APPROVALS.md` in the project; the `.claude/signal-log.jsonl` prompt log also needs an operator ledger. See the hook table below |
| Operator ledger | Only when `VIBE_ROOT` names a VibePromptRig source checkout | Inside that checkout; see [What the hooks do](#what-the-hooks-do) |

## Optional workforce coordination (preview, Windows only)

VibePromptRig 5.2.0 also ships host APIs that let an already authorized operator coordinate a Claude build, an independent Codex review, a repair and the results on a disposable project. The JavaScript host APIs also have a command-line entry point, `scripts/forge/workforce-entry.mjs`. Installing the plugin does not start a worker, connect an account, enroll a project, install a service or schedule a job. They need Windows and Node.js 24 or newer. This route is a preview: its live recovery behavior with real providers is still being tested.

| Route | 5.2.0 status | What the evidence covers |
| --- | --- | --- |
| Claude cloud build, independent Codex review, repair, results (`scripts/forge/attended-cloud-loop.mjs`) | Supported, attended | A bounded attended trial with real Claude and Codex sessions on a disposable project passed. You sign in, give consent and supply trusted host callbacks. Each loop allows at most three builds and three reviews, up to 4 active minutes per turn, and expires after 25 minutes. Not unattended operation |
| Finite automatic coordinator (`scripts/forge/automatic-cloud-coordinator.mjs`) | Included as a finite run the host starts and stops; real-provider recovery PENDING | Local tests with simulated providers. Recovery with real Claude and Codex across two projects (coordinator restart, repeated or missed completion, unavailable provider, no duplicate submission) is PENDING until the live recovery test runs. It creates no schedule or background service |
| Grok native headless proposal (`grokHeadless`) | Experimental, opt-in | Returns one scoped proposal only; it does not apply it or join the cloud loop. Cancellation and termination of child processes are not established |
| Grok ACP route (`grokAcp`) | Unsupported | Hosts must refuse it until native evidence exists |
| Cursor, Antigravity | Unsupported | Task submission, result retrieval and cancellation are not established |
| Dot, Meta Muse, Grok Bot | Unsupported | The package has no integration for them; any use is manual and outside the plugin |

Follow the [workforce quickstart](docs/tutorials/workforce-quickstart.md) to run this route, and use the [workforce guide](docs/tutorials/workforce.md) for result states, recovery and provider boundaries.

## Stop, undo and recovery

**Plugin and hooks.** The plugin starts no background service; its hooks run only during a Claude Code session. To stop the blocking guards and the session lock, start Claude Code from a shell where `VIBE_HOOKS_DISABLE=1` is set (PowerShell: `$env:VIBE_HOOKS_DISABLE = '1'` before `claude`). `claude plugin disable vibepromptrig@vibepromptrig` turns the plugin off without removing it. Uninstalling does not reverse project changes: setup changes are undone with the undo record setup wrote, initialization with the rollback command in [INSTALL.md](INSTALL.md#initialize-forge-project-state-optional), and reviewed saves with their exact undo.

**Workforce runs.** The host's abort signal ends the coordinator between passes (result `stopped`); then close it. That stops local coordination only. It does not prove that a remote Claude or Codex session, or anything it started, has stopped, and neither does closing a window or ending the Node.js process. Check and stop each provider session in that provider's own interface. VibePromptRig cannot see or settle provider billing: loop results report the financial duration as held, which is not a settled charge, so check usage in each provider's account. After a restart, reopen the same registered roots; unknown submissions and interrupted operations are designed to stay held instead of being replayed. That recovery behavior is covered only by simulated-provider tests; with real providers it is PENDING until the live recovery test runs. Never delete a lock or receipt to clear a hold. For evidence, keep each loop's root folder (its checkpoint and review records) and the returned result, and read each project's verdict and checks. Provider prose, final model text and process exit are not evidence of completion, cancellation or settlement.

## Where it works

What each surface loads follows Anthropic's plugin platform matrix. Only Claude Code has been tested with VibePromptRig.

| Surface | What loads | What works |
| --- | --- | --- |
| Claude Code | Skills, commands, agents, hooks | Local Windows fixture coverage. Historical signed-in evidence covers 5.1.5; 5.1.12 BOM and current 5.2.0 signed-in acceptance remain pending. |
| Cowork | Skills, commands, agents, hooks | Not tested. The skills expect a local project folder, Node.js, and Git. |
| Chat (claude.ai web, desktop, mobile) | Skills; commands load as skills | Agents and hooks are ignored, so no hook guard runs in chat. Every skill and command needs a terminal and a project folder; each one says so and asks you to switch to Claude Code. |

**Operating systems.** The hooks and `forge` tools run on Windows, macOS, and Ubuntu; their tests run on all three. `/vibepromptrig:setup` proposes changes on all three, but its automated write step runs only on Windows today. On macOS and Ubuntu it prints the exact changes as a checklist for you to apply. The optional workforce coordination route is supported only on Windows.

## What the hooks do

The plugin registers 13 hook handlers. Each runs `node` on a script inside the plugin (`${CLAUDE_PLUGIN_ROOT}/scripts/hooks/`). None of them opens a network connection or sends data off your machine; a few print a short note into the session. A guard that blocks a tool call exits with code 2 and explains why; every other hook fails open. Set the environment variable `VIBE_HOOKS_DISABLE=1` to turn off the blocking guards and the session lock.

SQL string scanning assumes PostgreSQL's default `standard_conforming_strings=on`: ordinary strings keep backslashes literal; `E`-prefixed strings use backslash escapes. The guards do not inspect the database session setting.

Two switches control files the hooks write:

- **Project consent** is the file `.claude/vibepromptrig.json` with `{"session_notes": true}` in your project. `/vibepromptrig:setup` creates it only if you approve session notes. Without it, no hook writes into your project.
- **Operator ledger** (`factory_metrics.jsonl`: one line per run of the capture hooks `post-session-enforcer.mjs`, `session-budget-tracker.mjs`, `signal-batch-analyzer.mjs`, and `signal-classifier-tier1.mjs`, plus session summaries; the guards and `session-guard.mjs` do not write to it) is written only when the environment variable `VIBE_ROOT` names a VibePromptRig source checkout, and only inside that checkout. Customers normally do not set it; without it, no ledger is written.

<!-- hook-disclosure:start -->
| Event | Matcher | Runs | Reads | Writes (where) | Network | Consent needed |
| --- | --- | --- | --- | --- | --- | --- |
| PreToolUse | `Bash` | `pre-bash-destructive-sql-guard.mjs` | SQL input to `psql`, `pgcli`, `mysql`, `sqlite3`, `duckdb`, `supabase db/migration`, `prisma db execute`, and `pg_restore`, including shell wrappers, command substitutions, pipes, heredocs and explicit local `.sql` input files (up to 1 MiB) | Nothing. Fails closed on selected SQL patterns, malformed SQL and unknown SQL inputs (including missing/unreadable/non-SQL files and opaque migration/restore invocations); prints review steps with no confirmation input. Screens `DROP TABLE`, `TRUNCATE`, `ALTER TABLE ... DROP`, `DROP POLICY/INDEX/SCHEMA/DATABASE`, `DELETE FROM` or `UPDATE ... SET` without a top-level `WHERE` (subqueries/CTEs do not count), and dynamic SQL (`EXECUTE`, `format()`, `dblink`, `\gexec`). Other commands' messages, search patterns, paths and fixture heredocs are ignored; executable substitutions remain screened. The bounded scanner never runs the inspected command or expands variables; passing does not prove arbitrary SQL safe | None | None |
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
