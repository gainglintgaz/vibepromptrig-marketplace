---
name: setup
description: Project-aware outfitting for Claude Code. Scans the current project's stack, asks 5 fixed questions, matches a curated catalog, and proposes up to 5 relevant MCP servers + rule packs. After explicit approval it writes .mcp.json entries and copies rule packs -- rollback manifest FIRST, idempotent re-runs, local-only audit log, no remote telemetry. Windows-only equip step (V1). Use when a developer wants their Claude Code tooling configured for THIS project.
allowed-tools:
  - Read
  - Glob
  - Grep
  - Write
  - Edit
  - Bash
  - AskUserQuestion
disable-model-invocation: true
---

# /vibepromptrig:setup -- AI-assisted per-project outfitting

> **Authority:** Implements `docs/architecture/equip-discovery.md` (APPROVED 2026-06-10, all 7 assumptions).
> **Companion:** `/vibepromptrig:mcp-advisor` (live registry search for anything the catalog misses).
> **Hard rules this skill obeys:** writes a rollback manifest BEFORE any change; never claims an MCP
> server is "verified active" (only "written to .mcp.json"); skip-with-warning on rule-pack conflict,
> never overwrite; no remote telemetry -- every artifact stays in the target project's `.claude/`.

## What this skill is NOT

- NOT a live MCP registry browser. It reads a static curated catalog. For misses -> `/vibepromptrig:mcp-advisor`.
- NOT a project scaffolder. It configures Claude Code tooling only -- it never touches application code,
  dependencies, or schema.
- NOT a substitute for `/architect-probe`. Setup is a configuration decision; architect-probe is a build
  decision. Never trigger the architect-probe flow from here.
- NOT automatic. Nothing is written without showing the exact change and reading an explicit approval.

---

## The 7-phase flow

Run these in order. Do not skip ahead. Keep total cost under ~8,000 tokens (Rule 58) -- the catalog is
local (no network for the primary flow) and the interview is 5 fixed questions, not freeform chat.

### Phase 0 -- Preflight (platform + special-case + resume)

1. **Locate the catalog.** Read it from the first path that exists:
   - `${CLAUDE_PLUGIN_ROOT}/catalog.json` (installed-plugin case)
   - `.claude-plugin/catalog.json` (running inside the factory / dogfood)
   - `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/catalog.json` (fallback)
   If none exists, tell the user the catalog is missing and stop.

2. **Platform check.** Detect the OS. The *proposal* phases (1-5) run anywhere. The *equip* step
   (Phase 6 writes) is **Windows-only in V1**. On macOS/Linux, run Phases 1-5 normally, then in Phase 6
   print the proposed changes as a manual checklist and say: "Automated equip is Windows-only in V1 --
   here are the exact changes to apply by hand," and STOP before writing. Do not write files on non-Windows.

3. **Special case -- the factory itself.** If the current working directory is the VibePromptRig factory
   root (heuristic: `.claude/rules-manifest.json` AND a `docs/rules-reference/factory/` dir with 30+ rule
   files AND a `.claude-plugin/plugin.json` AND a `plugin-dist/` dir), this IS the plugin source. Skip MCP-server proposals entirely (the factory already
   wires them in its own settings). Focus only on rule-pack freshness and a mode recommendation. Say so.

4. **Resume check.** Read `.claude/setup-manifest.json` if it exists.
   - If it shows a prior completed run: this is a re-run -> Phase 3 proposes only the DELTA (items not
     already in the manifest).
   - If it shows an incomplete/partial run (a run started but no completion record): offer
     "Last run was incomplete. Resume from checkpoint or start fresh?" and act on the answer.
   - If absent: this is a first run -> show the first-run disclaimer in Phase 2.

### Phase 1 -- Stack scan (read-only)

Use Glob + Read + Grep only. Do NOT read any `.env*` file (secrets-handling.md -- read `.env.example`
if you need to know expected vars, never the real file). Gather:

- Package manifests: `package.json` (deps + devDeps), `requirements.txt`, `pyproject.toml`, `go.mod`,
  `Cargo.toml`, `Gemfile`.
- Framework/deploy signals: `next.config.*`, `vercel.json`, `.vercel/`, `wrangler.toml`/`wrangler.jsonc`,
  `netlify.toml`, `Dockerfile`, `railway.toml`, `fly.toml`.
- Backend signals: a `supabase/` dir, `prisma/`, `drizzle.config.*`, `.git/config` (read the remote host).
- Tooling: test runners (`vitest`/`jest`/`@playwright/test`/`pytest`).
- Legacy factory rule copies: any `.md` under `.claude/rules/` or `.mdc` under `.cursor/rules/` other than
  `vf-context-core.*`. Older VibePromptRig installs copied full factory rules there (they load every
  session). Do NOT delete or edit them; in Phase 4 recommend the reviewed, backup-first cleanup (script
  resolved under `${CLAUDE_PLUGIN_ROOT}` first, then the factory root):
  `node <root>/scripts/forge/legacy-rules.mjs plan --project-root <project> --out <plan.json>`, review, then
  `node <root>/scripts/forge/legacy-rules.mjs apply --project-root <project> --plan <plan.json>` (it
  removes only copies proven factory-owned, backs them up first, preserves customized files as
  conflicts, and `rollback --backup <id>` restores them).

Produce a short detected-stack summary (language, framework, deploy target, backend, payment/webhook
signals, test runner, git remote host). Show it to the user so they can correct it in Phase 2.

**Empty-scaffold detection (VRA friction #3 / VIBE Rule 56):** the project is an EMPTY SCAFFOLD when
the scan finds NO package manifest, NO `src/` (or `app/`) directory, and NO framework/deploy/backend
signal -- only scaffold furniture (tracking files, `.claude/`, `.githooks/`, README). In that case do
NOT proceed to the Phase 2 stack question ("what stack is this?" has no honest answer yet -- asking a
beginner to pre-declare an undecided stack is the personal-pipeline anti-pattern Rule 56 forbids).
Branch idea-first instead:

> No stack here yet -- this looks like a fresh scaffold, so configuring tooling now would be guessing.
> The right first step is idea-first: tell me what you're trying to build and run /architect-probe --
> it produces the architecture AND the stack choice with reasoning. Re-run /setup after that and I'll
> equip the project to match.
> (Already know your stack? Name it now and I'll proceed with that as the Phase 2 answer.)

If the user names a stack, continue to Phase 2 with Q1 pre-answered. Otherwise STOP after writing the
Phase 7 audit line (`items_proposed: []`, note `empty_scaffold: true`). Do NOT run the architect-probe
flow from inside /setup (see "What this skill is NOT") -- recommend it and end.

### Phase 2 -- First-run disclaimer + the 5 fixed interview questions

**First run only:** show this disclaimer verbatim and record that it was shown (Phase 7 writes
`disclaimer_shown: true` to the manifest):

> VibePromptRig /setup recommendations are best-effort. Verify any MCP server before installing,
> especially those with network or filesystem-write access. You are responsible for what runs in your
> Claude Code session. This skill stores no data remotely -- every record stays in this project's
> `.claude/` folder.

Then ask the **5 fixed questions** (use `AskUserQuestion`, max 4 per batch -> 2 batches). These are
HARDCODED -- do not improvise extra discovery questions. Pre-fill best-guess defaults from the Phase 1
scan so the user usually just confirms.

1. **Primary language / stack?** (confirm the scan: "Detected <X> -- correct?")
2. **What domain is this project?** finance/fintech | SaaS/B2B | bookkeeping/accounting | e-commerce |
   content/marketing | dev tooling | other.
3. **Tenancy / team size?** solo project | small team | multi-tenant SaaS (gates multi-tenant rule packs).
4. **Which surfaces do you want help wiring?** database/backend | deployment | payments | CI/testing |
   just the rules, no MCP servers.
5. **Does this project handle money, PII, or regulated data?** yes | no (gates the safety rule packs:
   finance primer, data-protection, webhook-handling).

### Phase 3 -- Catalog match

For each catalog entry (skip any with `tombstoned: true` -- NEVER propose those):

- Evaluate `stack_triggers` against the Phase 1 scan AND the Phase 2 answers. A `package` trigger matches
  when the named string appears in the named manifest; `dir`/`file` triggers match on presence; `dep-any`
  matches if any listed dep is present.
- An entry also matches if Phase 2 answers imply it (e.g. domain=finance -> finance primer; "handles
  money"=yes -> webhook-handling + data-protection; surface=payments -> Stripe MCP).
- Exclude entries already recorded in `setup-manifest.json` (idempotency -- delta only on re-runs).
  The three relocated rule packs use new `-reference-v2` item IDs. Prior records for
  `rule-finance-primer`, `rule-webhook-handling`, and `rule-testing-strategy` describe the old native
  targets and MUST NOT suppress the new reference items. Preserve those records as history; propose
  the new IDs when their current targets are absent, obtain approval, and record the new IDs only
  after writing. Legacy cleanup remains a separate reviewed action; it does not install replacements.
- Exclude rule-pack entries whose `install.target` file already exists in the project AND note them as
  "already present (skipped)". Rule-pack targets are reference documents under
  `docs/rules-reference/factory/`; never install a rule pack into `.claude/rules/`, `.cursor/rules/`,
  `.agents/rules/` or `.agent/rules/` (native autoload directories).

Rank survivors by `confidence` (high > medium > low). **Hard cap: 5 proposals per run.** If more than 5
match, propose the top 5 and tell the user the rest are "also available -- run /setup again."

If a previously-installed item (in the manifest) is now `tombstoned` in the catalog, surface a WARNING:
"X was installed by a previous /setup run and is now marked insecure -- remove it: <command>."

**Coverage honesty (compute at runtime -- never hardcode the numbers):** count M = non-tombstoned
`kind: rule-pack` entries in the catalog, and N = entries in the `rules` array of the compact rule
manifest (`${CLAUDE_PLUGIN_ROOT}/.claude/rules-manifest.json`, falling back to the factory root's
`.claude/rules-manifest.json`). Phase 4 MUST state this gap -- see below. (VRA friction #2: the catalog
exposed 3 of 39 rules and /setup looked empty without explaining why.)

### Phase 4 -- Proposal

**Always open with the coverage statement** (using the Phase 3 runtime counts, plain English):

> Heads-up on scope: this catalog exposes M individually-installable rule packs out of the N rules
> in the factory's compact rule manifest. The other N-M rules are not missing -- the compact context
> selects their short rule cards by task intent and path; full rule bodies are never auto-loaded.
> The catalog lists the few worth copying into a project as reference documents. For MCP
> servers/tools the catalog misses, use /vibepromptrig:mcp-advisor.

**Zero-proposals case:** if nothing matched (common right after a full-plugin install, where every
rule pack is "already present"), do NOT end flat. Say explicitly WHICH of the two reasons applies --
"already equipped" (matched items all present/in manifest) vs "catalog gap" (nothing matched your
stack) -- include the coverage statement above, and point to /vibepromptrig:mcp-advisor for live
registry search.

Present the (max 5) proposals. For EACH, show in plain English:

- **What it does** (one sentence from `summary`).
- **Why it fits THIS project** (`why_it_fits` + which trigger matched).
- **Permissions** (`known_permissions` -- spell out network / filesystem-write / secrets-access).
- **The exact install command or file copy** that will be written (`install.command` or
  `install.target` <- `install.source`).
- **Source + vetting status** (`source_url`, `verified_against` + `last_vetted`, and `publisher_verified`
  -- if false, say "not yet personally vetted by VibePromptRig; confirm at the source URL before approving").
- If an item needs a key the user may not have yet (e.g. Stripe), say so: "requires a Stripe account --
  skip if you're not using Stripe."

### Phase 5 -- Approval loop

Ask the user to approve a subset explicitly (e.g. "approve 1,3,4" / "approve all" / "none"). Record
exactly which were approved and which declined. Do NOT proceed to any write without an explicit approval
response. Zero approvals is a valid outcome -- still write the audit entry in Phase 7.

### Phase 6 -- Equip (writes -- Windows only; rollback manifest FIRST)

Execute in this exact order. **The rollback manifest is written BEFORE any other change** (acceptance
criterion #4 -- so an interrupted run is always recoverable):

1. **Read existing `.mcp.json`** (if any) at project root. Build the set of already-present server keys.
2. **Write `.claude/setup-rollback-YYYYMMDD.md` FIRST** -- before touching `.mcp.json` or any rule-pack target.
   It lists the exact undo command for every change about to be made:
   - For each MCP entry to add: `claude mcp remove <name>` (or "delete the \"<name>\" key from .mcp.json").
   - For each rule pack to copy: "delete `<install.target>`".
   Date the file with today's date (get it from the environment, ASCII only, PowerShell-safe).
3. **MCP entries:** for each approved MCP item, if its server key is already in `.mcp.json`, skip it
   (idempotency); otherwise add the equivalent entry to `.mcp.json` (create the file with
   `{ "mcpServers": { ... } }` if absent). Write the JSON entry directly -- do NOT execute
   `claude mcp add`, and do NOT run, start, or verify the server. The catalog `install.command` is the
   user-facing reference; you produce the matching `.mcp.json` entry.
4. **Rule packs:** for each approved rule-pack item, if the target file already exists -> skip-with-warning
   (never overwrite). If `install.target` starts with `.claude/rules/`, `.cursor/rules/`, `.agents/rules/`
   or `.agent/rules/`, refuse that item (a catalog error: full rule bodies never go into native autoload).
   Otherwise resolve `install.source` under `${CLAUDE_PLUGIN_ROOT}` first, then the factory root
   (dogfood case) -- never from the adopted project -- validate it has valid frontmatter, and copy it to
   `install.target`.
5. **Hook packs (kind=hook, e.g. hook-precommit-gates):** for each approved hook item:
   - Run `git config --get core.hooksPath`. If it returns anything other than empty or `.githooks`
     -> skip-with-warning (an existing hooks setup like husky is NEVER clobbered; tell the user to
     merge the gates manually).
   - Resolve `install.source` under `${CLAUDE_PLUGIN_ROOT}` first, then the factory root (dogfood case).
   - Copy the source dir's files into the project's `.githooks/` -- skip any file that already exists
     (never overwrite).
   - Run `git config core.hooksPath .githooks`.
   - Rollback manifest entries (written in step 2 with the rest): `git config --unset core.hooksPath`
     and "delete `.githooks/`".
6. Proceed to Phase 7.

**Never claim success past "written."** You did not start or verify any server. Restart + verification is
the user's job (Phase 7 message).

### Phase 7 -- Manifest + audit + next-step message

1. **Write `.claude/setup-manifest.json`** (current-state snapshot): catalog_version, the run record
   (proposed / approved / declined / equipped lists with item ids), `disclaimer_shown`,
   `disclaimer_accepted`, and timestamps. On re-runs, merge with the prior manifest (append, don't clobber).

2. **Append one line to `.claude/setup-audit.jsonl`** (append-only, local only -- NEVER sent anywhere):
   ```json
   {"run_id":"setup-YYYYMMDD-HHMMSS","ts":"<ISO8601>","catalog_version":"<v>","items_proposed":[...],"items_approved":[...],"items_declined":[...],"files_written":[...],"disclaimer_shown":true,"disclaimer_accepted":true,"platform":"<os>"}
   ```
   Write this even when 0 items were approved (acceptance criterion #5).

3. **Show the next-step message** (do not paraphrase the verified/active distinction):
   ```
   Written to .mcp.json -- NOT yet active. To finish:
     1. Restart Claude Code.
     2. Run /mcp and confirm each new server shows healthy (approve project-scope servers once).
     3. For OAuth servers (Vercel, GitHub), authenticate via /mcp.
   Rollback any time: see .claude/setup-rollback-YYYYMMDD.md
   ```

4. If running on the factory itself, instead report the rule-pack freshness result + the mode
   recommendation, and note that MCP proposals were intentionally skipped.

---

## Failure modes (handle, don't crash)

- **Catalog missing/unreadable** -> say so, stop, suggest reinstalling the plugin.
- **`.mcp.json` exists but is malformed JSON** -> do NOT overwrite. Surface the parse error and ask the
  user to fix or confirm before any write.
- **Stdio server whose binary is missing from PATH (e.g. npx not found)** -> this is expected; you wrote
  the entry correctly. The rollback manifest is the undo path. Say "written -- if it fails on restart,
  resolve your PATH and re-run, or remove via the rollback manifest."
- **Interrupted between rollback-write and completion** -> the rollback manifest already exists; the next
  run's Phase 0 resume check detects the partial state.
- **Non-Windows** -> Phases 1-5 only; Phase 6 prints a manual checklist and stops.

## Privacy + security (non-negotiable)

- Never `Read` a `.env*` file. Use `.env.example` for expected-var names only.
- Never write a secret value into any file. The catalog commands carry placeholders
  (`<YOUR_GITHUB_PAT>`, `<STRIPE_RESTRICTED_KEY>`) -- keep them as placeholders; the user fills real
  values in their own env, never in `.mcp.json` committed to git.
- No network call carries project metadata or interview answers anywhere. All four artifacts
  (rollback manifest, setup-manifest.json, setup-audit.jsonl, the .mcp.json edits) are local to the
  target project and user-owned.
