---
name: setup
description: Start with the user's goal and relevant project evidence, then optionally configure Claude Code. Supports ideas, physical products, research, services, content and software. Unknown answers stay unknown. Reviewed additions only; automatic tooling setup is Windows-only.
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

> **Needs Claude Code with your project folder open and Node.js 18+ for helper tools.** Goal questions work in an empty folder without Git. Git is needed only for Git-related checks. Setup asks what you want to achieve before suggesting optional connections, instructions or checks. Approved tooling additions work on Windows; other systems get a manual checklist. Questions and suggestions write nothing.

In chat, discuss your goal normally; open Claude Code for project inspection and optional tooling setup.

# /vibepromptrig:setup -- explained project setup

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
- NOT automatic. No project change (`.mcp.json`, rule packs, hook packs) is written without showing the
  exact change and reading an explicit approval. Local run records also need a disclosed, approved save.
  Suggestions alone create no records. Goal/findings save is a separate choice owned by project-goal;
  it never grants approval to configure tools. On macOS/Linux this setup flow writes nothing.

---

## The 7-phase flow

Run these in order. Do not skip ahead. Keep total cost under ~8,000 tokens (Rule 58) -- the catalog is
local (no network for the primary flow). Reuse confirmed answers; ask only relevant unanswered questions.

### First -- the goal (before software scan, catalog or configuration questions)

Read `${CLAUDE_PLUGIN_ROOT}/skills/project-goal/SKILL.md` and follow its conversational intake in the
main conversation. Use `node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/checkup.mjs" questions` for the actual
plain-language opening. Read-only goal questions do not need Git, a package manifest or a framework.
Use the one `.vibepromptrig/checkup.json` record only if the user previously approved saving it; check
freshness and show corrections. Do not create a separate goal store, import an old prototype silently,
or start a team. A confirmed goal is not an action approval.

For physical products, research, services, writing or uncertain ideas, stop the software questionnaire
unless the user asks for relevant tooling. Summarize the goal, relevant findings, unresolved questions
and ONE useful next action. Do not classify manufacturing as an online shop because of a fixture's
package.json. Distinguish concept, CAD, simulation, manufactured prototype and real testing.
An empty folder remains a valid place to discuss a goal; do not demand a software stack or write an audit.
Explain declared disposable test context: setup configures this folder, not a launched business.
The user can choose "Only help me configure my tools" to go directly to the optional flow below.
When following project-goal from this setup flow on macOS/Linux, keep its summary in the conversation;
do not save records. Standalone project-goal has its own reviewed save protocol; this setup's existing
non-Windows no-write boundary remains in force.

### Phase 0 -- Preflight (platform + special-case + resume)

1. **Locate the catalog.** Read it from the first path that exists:
   - `${CLAUDE_PLUGIN_ROOT}/catalog.json` (installed-plugin case)
   - `.claude-plugin/catalog.json` (running inside the factory / dogfood)
   If none exists, tell the user the catalog is missing and stop.

2. **Platform check.** Detect the OS. The *proposal* phases (1-5) run anywhere. The *equip* step
   (Phase 6 writes) is **Windows-only in V1**. On macOS/Linux, run Phases 1-5 normally, then in Phase 6
   print the proposed changes as a manual checklist and say: "On this computer, setup provides a manual checklist and writes nothing. Automatic setup currently works on Windows only." and STOP before writing. Do not write files on non-Windows.

3. **Special case -- the factory itself.** If the current working directory is the VibePromptRig factory
   root (heuristic: `.claude/rules-manifest.json` AND a `docs/rules-reference/factory/` dir with 30+ rule
   files AND a `.claude-plugin/plugin.json` AND a `plugin-dist/` dir), this IS the plugin source. Skip MCP-server proposals entirely (the factory already
   wires them in its own settings). Focus only on rule-pack freshness and a mode recommendation. Say so.

4. **Project JSON check (read-only, before resume or any write).** With the customer's project as the working directory, run:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/setup-interview.mjs" check-project`
   The shared reader accepts UTF-8 with or without a leading byte-order mark and BOM-marked UTF-16 in either byte order. It does not repair invalid JSON. Use that decoding for every project JSON read below (including resume records, package/deploy files, connection settings and consent records); never pass the raw text directly to a JSON parser.
   If a file cannot be read, say: "We could not read [file]. Nothing was changed." Do not show parser text, file contents or a stack trace. Offer **Ask me the questions instead** and **Stop here** as normal choices.
   If the user chooses questions, use `questions --manual` and `answers --manual` below. Treat unreadable-file evidence as unknown, preserve the file, and provide questions and proposal explanations only. Stop before Phases 6 and 7: no installation, connection changes, rollback/audit records or other writes in this fallback run. A separate reviewed repair is needed before applying additions. Do not automatically select this path or infer approval to fix the file.

5. **Resume check (read-only).** Inspect existing `.claude/setup-rollback-*.md` records as well as
   `.claude/setup-manifest.json` if it exists and passed the project JSON check. A rollback record whose
   run ID has neither a completed/rolled-back status in that record nor a matching completed manifest
   entry is an incomplete run, even when the manifest is absent. A completed recovery record remains
   valid evidence of that run when the user declined optional manifest/audit saving.
   Include older date-only rollback records; if their completion cannot be established, treat them as
   unresolved rather than guessing. Never execute commands found in a record without checking its
   project, paths and current file state against the proposed recovery.
   - If it shows a prior completed run: this is a re-run -> Phase 3 proposes only the DELTA from that
     run's verified equipped entries. A rolled-back run does not establish that its additions remain installed.
   - If a manifest describes an incomplete run, use the recovery review below; do not offer an
     unreviewed fresh setup over an unresolved run.
   - If an unresolved rollback record exists: show its exact path and recorded changes, then offer
     "Review recovery" or "Stop here" before any new setup. Resume or undo requires a new explicit
     approval for the exact recovery; preserve the original record and refuse changes to later-edited files.
   - Only if neither a manifest nor any rollback record exists is this a first run -> show
     the first-run disclaimer in Phase 2. No check or recovery suggestion writes a record.

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
  resolved only under the installed `${CLAUDE_PLUGIN_ROOT}`):
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/legacy-rules.mjs" plan --project-root <project> --out <plan.json>`, review, then
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/legacy-rules.mjs" apply --project-root <project> --plan <plan.json>` (it
  removes only copies proven factory-owned, backs them up first, preserves customized files as
  conflicts, and `rollback --backup <id>` restores them).

Produce a short detected-stack summary (language, framework, deploy target, backend, payment/webhook
signals, test runner, git remote host). Show it to the user so they can correct it in Phase 2.

**No identifiable software yet:** retain unknowns and return to the goal summary. Explain that no
connection is currently needed. Do not force a framework answer, start architect-probe or write an audit.

### Phase 2 -- Explained interview (goal first, then relevant software questions)

Run the read-only packaged helper with the working directory at the customer's project:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/setup-interview.mjs" questions`

Show its opening and relevant unanswered questions verbatim; do not replace them with technical shorthand.
Do not ask software questions for a non-software goal. Reuse answers already confirmed in goal intake.
The helper only reads package.json to identify supported website tools; the broader Phase 1 scan remains
evidence, not a confirmed user answer. It never writes, connects or installs. If the helper cannot read
a manifest, offer the Phase 0 manual-question path; do not guess or print parser diagnostics. For tools it does not recognize, briefly explain
the Phase 1 evidence in everyday words, without presenting it as confirmed.

**First run only:** record that the opening was shown (`disclaimer_shown: true` in Phase 7).
Also say: "Suggestions are best-effort. Read the access details before approving a connection.
Questions and suggestions write nothing. I will show local run records before asking to save them."
Do not promise that configured external connections send no data when later used.

Use AskUserQuestion, at most four questions per batch and four options per page. There are five
software topics plus a separate help preference. Render each relevant group's reason and option descriptions.
For groups with a "More choices" page, open that page only when requested; preserve earlier selections
for the multiple-choice help group. Do not automatically submit a suggested answer.
Every group includes an "I'm not sure" route. Do not substitute contributor/team size for who can see
the app's information: one developer can have many customers with separate private data.

After recording explicit choices, run the helper's answer normalization, replacing each example
value with the corresponding chosen value:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/setup-interview.mjs" answers --goal "the user's confirmed goal" --framework unsure --domain unsure --sharing unsure --help_mode unsure --help unsure --sensitive unsure`

Technical answer values (implementation detail; do not present unexplained enum names to customers):
- goal: the user's description of what they want to make and a useful first result. Reuse confirmed
  intake; ask this before software questions if it is missing. Earning money alone never selects finance.
- framework: yes / no / unsure. Never confirm without detected evidence. A "no" clears rejected
  framework guesses for matching; ask the user to explain and rescan relevant files.
- domain: finance / bookkeeping / saas / ecommerce / content / devtools / unknown / unsure.
  A free-text bookkeeping answer maps to bookkeeping, not a new unsupported category.
- sharing: only-me / shared / separate / unsure. This is app information access, not developer count.
- help: data / hosting / payments / testing (comma-separated), OR instructions, OR unsure.
  Instructions-only or unsure cannot be combined with connection areas.
- help_mode: connections / guidance / unsure. Ask this as a SINGLE choice first. Show multi-select
  help areas ONLY for connections; for guidance or unsure, omit areas and explain the next useful step.
  More choices opens another page and is never submitted as an answer. Returning to guidance clears
  earlier connection areas explicitly rather than combining incompatible answers.
- sensitive: yes / no / unsure.

Use the returned normalized object as the authority for answer semantics:
unknown framework/domain/data sharing/sensitive data remain unknown. `protective_guidance` means
recommend extra care; it does not establish sensitive data as fact or authorize any write.
`allow_connectors: false` forbids connector recommendations even if Phase 1 finds a matching dependency.
If the user corrects a framework not recognized by the helper, leave its framework status unconfirmed
and use independently verified Phase 1 dependency evidence. Never change "no" into "yes" to bypass a
normalization error.
Keep unknown privacy guidance visible and defer configuration that requires a definite data-sharing model.

### Phase 3 -- Catalog match

For each catalog entry (skip any with `tombstoned: true` -- NEVER propose those):

- First restrict candidates to the helper's returned eligible_catalog_ids (computed by entryEligible): a connector must be in a
  selected help area. Its mapping is Supabase=data, Vercel/Cloudflare documentation=hosting,
  Stripe=payments, GitHub=testing. Instructions-only, no selected help, or unsure help excludes ALL
  connectors even if a file matches. Unknown/new connector mappings are excluded until reviewed.
  This is an eligibility rule before normal matching; do not execute or install anything to check a match.
- protective_guidance=true keeps privacy caution visible; it never makes specialized finance guidance
  eligible. The finance reference requires a confirmed finance or bookkeeping domain. A product that
  might accept money is not thereby a fintech application; no irrelevant pack is required.
  General customer-information guidance is a separate catalog pack, eligible when protective_guidance=true;
  it installs docs/rules-reference/customer-information.md after approval. Keep the guidance visible
  when privacy answers are unknown; this does not make finance guidance eligible.
  Unknown data sharing must not become single-user; defer tools requiring a known isolation model.

- Evaluate `stack_triggers` against the Phase 1 scan AND the Phase 2 answers. A `package` trigger matches
  when the named string appears in the named manifest; `dir`/`file` triggers match on presence; `dep-any`
  matches if any listed dep is present.
- An entry also matches if Phase 2 answers imply it (e.g. domain=finance/bookkeeping -> finance primer; sensitive=yes/unknown -> protective guidance;
  help=payments -> Stripe connection, only when the helper permits it). Uncertainty alone never matches finance.
- Exclude entries recorded as successfully equipped in `setup-manifest.json` or, when its save was
  declined, the completed recovery record (idempotency -- delta only on re-runs). Confirm recorded
  outputs are still present and unchanged; missing/changed outputs need review, not an invented installed
  state. A proposed, declined, failed or rolled-back entry alone does not mean it is installed.
  The three relocated factory rule packs use `-reference-v2` item IDs; customer-information uses
  its own `-reference-v1` ID. Prior records for
  `rule-finance-primer`, `rule-webhook-handling`, and `rule-testing-strategy` describe the old native
  targets and MUST NOT suppress the new reference items. Preserve those records as history; propose
  the new IDs when their current targets are absent, obtain approval, and record the new IDs only
  after writing. Legacy cleanup remains a separate reviewed action; it does not install replacements.
- Exclude rule-pack entries whose `install.target` file already exists in the project AND note them as
  "already present (skipped)". Rule-pack targets are reference documents under
  `docs/rules-reference/` (including the customer-information reference); never install a rule pack into `.claude/rules/`, `.cursor/rules/`,
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

**Always open with this plain coverage statement:**

> I can suggest up to five additions from the built-in list. Other project guidance is selected as you work.

Then keep the Phase 3 counts available under **Details**: M individually installable reference packs out
of N compact-context rules. Full rule bodies are not automatically loaded. Explain reference packs as
project instructions that guide Claude, not as guaranteed safety enforcement.

**Zero proposals:** distinguish "already equipped" from "nothing in the built-in list fits yet";
state which applies and why. Offer /vibepromptrig:mcp-advisor as a tool for finding other connections,
without starting it or implying those connections have been tested.

For EACH eligible, matched proposal, render its real catalog card:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/forge/setup-interview.mjs" proposal <catalog-id>`

Show the card's plain fields first, using plain_summary (not the technical summary).
After "Why it fits", add the actual matched file evidence or user answer; keep uncertainty visible.
The card by itself is an explanation, not a match or recommendation. Choose Recommended / Optional /
Needs more information based on actual evidence, keeping its review-status sentence intact.
Access and any ability to change data/run paid checks must remain visible before approval, never hidden
under Details. Accounts/sign-in are explained without requesting secrets in chat.
Keep the exact install command/file copy, source URL, review note, last_vetted and publisher_verified
under Details. "Written" does not mean connected, verified active, or tested. Never expand catalog
install privileges or scope. Supabase remains read-only and limited to a development project.

Glossary shown once: "Connector: a connection to another service. Project instructions: guidance
Claude is asked to follow. Automated check: a program that runs at a supported event and may stop a
change." Explain any technical term next to its first customer-visible use.

After the catalog proposals, always offer one more optional item, **off unless approved**:

- **Session notes (`notes`):** "At the end of each session, VibePromptRig can write `SESSION_DEBRIEF.md`,
  append this session's commits to `CHANGELOG.md`, bump `VERSION.md` if the project has one, and keep a
  local `.claude/signal-log.jsonl` with short prompt excerpts. Without approval the plugin writes none of
  these into your project." Approving writes `.claude/vibepromptrig.json` with `{"session_notes": true}`.

### Phase 5 -- Approval loop

Ask the user to approve a subset explicitly (e.g. "approve 1,3,4" / "approve all" / "none"). Record
exactly which were approved and which declined. Do NOT proceed to any write without an explicit approval
response. Zero approvals is a valid outcome and writes nothing, including audit or manifest records.

Before asking, show one exact change list including the required rollback record and any optional
manifest/audit saves, with their paths and concise contents. Choose a run ID such as
`setup-YYYYMMDD-HHMMSS-<unique-suffix>` and the unused path `.claude/setup-rollback-<run-id>.md` now,
so the user approves the actual target. Explain that safe application requires this recovery record;
if it is declined, offer the proposal only and apply nothing. Offer manifest/audit saving separately;
declining those saves does not authorize them through approval of a catalog item. Preserve that choice.
If any approved path or content must change, preview it and obtain approval before writing.

### Phase 6 -- Equip (writes -- Windows only; rollback manifest FIRST)

Execute in this exact order. **The rollback manifest is written BEFORE any other change** (acceptance
criterion #4 -- so an interrupted run is always recoverable):

1. **Inspect existing `.mcp.json`** (if any) only when it is known to contain no secret values. Build the
   set of already-present server keys. If safe inspection or undo would require reading credentials,
   defer MCP changes, preserve that file and explain the access limitation; do not copy its contents.
2. **Create the approved `.claude/setup-rollback-<run-id>.md` FIRST, without replacing an existing file**
   -- before touching `.mcp.json`, configuration or any rule-pack target. Use exclusive file creation
   (fail if the file exists), not an overwrite-capable write after an existence check. Recheck the path;
   if it exists, stop and obtain approval for a different unique path. Never truncate, replace or append
   another run's recovery record, including an earlier run on the same day. Record this run ID and project,
   each target's prior existence and non-secret hashes/metadata where safe, the precise approved additions and their
   expected post-change hashes. Preserve the first record through later no-change runs. Do not apply
   additions if the recovery record cannot be safely created.
   Never copy credential-bearing configuration into recovery records, manifests, audit lines or transcripts.
   Recovery records are not backups of secret values. For safe non-secret files, retain only the preimage
   needed for exact restoration; if secret-free recovery cannot be defined, skip the affected item.
   It lists the exact undo command for every change about to be made:
   - For each MCP entry to add: remove only this run's newly added, unchanged server key from the
     project `.mcp.json`; preserve every pre-existing key/value and later edit. Never remove an entire
     connection file or user/global registration. Record key names and approved non-secret additions,
     not pre-existing configuration bodies.
   - For each rule pack to copy: "delete `<install.target>`".
   - For each hook pack: restore the exact prior hooks-path setting, and list ONLY individual hook/helper
     files this run created. Never say delete an entire tools or hooks directory. Remove a newly created
     directory only if empty; preserve existing files and refuse undo of later edits. Preview exact paths.
     Capture `git config --local --get-all core.hooksPath` separately from the effective setting. If
     there was no local entry, undo with `git config --local --unset-all core.hooksPath` (an already absent
     key is a no-op); otherwise restore the captured local values. Never edit global/system settings.
     Verify the effective setting again after undo so inherited configuration is preserved.
     If hooks-path values changed since this run's recorded post-state, refuse that undo until reviewed;
     do not replace a later configuration change with an older value.
   - If session notes are approved: "delete `.claude/vibepromptrig.json`", plus the files session notes
     may create later (`SESSION_DEBRIEF.md`, `.claude/signal-log.jsonl`, and the CHANGELOG/VERSION edits).
   - Setup's own records: preserve pre-existing bytes and describe the exact approved append/additions
     to undo. Never delete a pre-existing manifest or audit file wholesale. Retain recovery records as
     evidence of their run; record completion or recovery in that run's record only, within the disclosed
     approval. If optional manifest/audit saves were declined, this recovery record remains the resume source.
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
   - Before copying or activating anything, inspect the existing `.githooks/` entries and required
     helper targets. First check the project root, `.githooks` directory itself and every existing parent
     component of each helper target with no-follow filesystem metadata. If any component is a symlink,
     junction or other reparse point, or cannot be checked safely, skip the whole hook item before
     enumeration/copying; never follow a linked parent outside the project. Check components again
     immediately before writes/activation. If any existing hook/helper differs from the exact packaged source, is unrecognized,
     cannot be read safely, or is a link, skip the whole hook item with a warning; do not set hooksPath or
     activate skipped contents. Preserve those files. Explain existing byte-identical entries and their
     activation in the approved change list; their presence alone is not approval to enable them.
   - Resolve `install.source` under `${CLAUDE_PLUGIN_ROOT}` first, then the factory root (dogfood case).
   - Copy the source dir's files into the project's `.githooks/` -- skip any file that already exists
     (never overwrite).
   - Copy every `install.requires` entry (`source` resolved the same way) to its project `target`, for
     example `tools/block-unverified-claims.mjs`, which `commit-msg` runs on every commit. Skip a target
     that already exists. If a required source is missing, do NOT set `core.hooksPath`: report the item
     as failed, because the installed hooks would reject every commit.
   - Only after the approved files and required helpers are present and verified, run
     `git config --local core.hooksPath .githooks`. Recheck the existing-hook decision immediately before
     activation; changed or unreviewed contents refuse activation, rather than broadening approval.
   - Rollback manifest entries were written in step 2 with the rest.
6. **Session notes (only if `notes` was approved):** write `.claude/vibepromptrig.json` as
   `{"session_notes": true}` (merge the key if the file exists). Without it, the installed plugin's hooks
   write nothing into the project.
7. Proceed to Phase 7.

Keep this run's recovery record incomplete until all approved changes and optional record saves in
Phase 7 are verified. A later no-change run must not replace this record or become the undo source for
the original additions.

**Never claim success past "written."** You did not start or verify any server. Restart + verification is
the user's job (Phase 7 message).

### Phase 7 -- Manifest + audit + next-step message

Only persist these records when their exact paths and concise contents were disclosed in the approved
Phase 6 change list. With no approved additions or record-save choice, show the summary and write nothing.

1. **Write `.claude/setup-manifest.json`** (current-state snapshot): the same approved run_id as the
   recovery record and audit entry, catalog_version, normalized
   interview answers (including unknown values and protective_guidance), and the run record
   (proposed / approved / declined / equipped lists with item ids), `disclaimer_shown`,
   `disclaimer_accepted`, and timestamps. On re-runs, merge with the prior manifest (append, don't clobber).

2. **Append one line to `.claude/setup-audit.jsonl`** (append-only, local only -- NEVER sent anywhere):
   ```json
   {"run_id":"<the same approved run-id used in the rollback record>","ts":"<ISO8601>","catalog_version":"<v>","items_proposed":[...],"items_approved":[...],"items_declined":[...],"files_written":[...],"disclaimer_shown":true,"disclaimer_accepted":true,"platform":"<os>"}
   ```
   Write only within the approved record-save scope. No approval means no record writes.

   After all approved writes are verified, mark only this run's recovery record completed with the
   actual written/skipped paths and post-change hashes (excluding its own changing status/hash).
   This completion update must be disclosed with the original recovery-record approval. If an optional
   manifest/audit save was declined, skip it and still complete the required recovery record. On failure,
   leave the record incomplete and describe what remains; never invent a successful checkpoint.

3. **Show what was added, skipped and still unknown**, with exact file paths and undo instructions.
   Only show connection activation steps when at least one connection was written. Otherwise say
   "No connection was added." For connections, show this message (keep the saved/active distinction):
   ```
   Connection settings saved in .mcp.json (the connection settings file) -- NOT yet active. Nothing was connected or tested. To finish:
     1. Restart Claude Code.
     2. Run /mcp and confirm each new server shows healthy (approve project-scope servers once).
     3. For OAuth servers (Stripe, Supabase, Vercel), authenticate via /mcp; GitHub uses the PAT you set. OAuth means browser sign-in; PAT means an access key you set locally, never in chat.
   To undo these additions: see <the exact approved rollback-record path for this run>.
   ```

4. If running on the factory itself, instead report the rule-pack freshness result + the mode
   recommendation, and note that MCP proposals were intentionally skipped.

---

## Failure modes (handle, don't crash)

- **Catalog missing/unreadable** -> say so, stop, suggest reinstalling the plugin.
- **Any project JSON is unreadable (including `.mcp.json`)** -> do NOT overwrite or try to repair it. Name the file in everyday words, say nothing was changed, and offer "Ask me the questions instead" or "Stop here". Manual questions keep unknowns unknown and stop before all writes, including setup records. Never show raw parser text or file contents.
- **Stdio server whose binary is missing from PATH (e.g. npx not found)** -> this is expected; you wrote
  the entry correctly. The rollback manifest is the undo path. Say "written -- if it fails on restart,
  resolve your PATH and re-run, or remove via the rollback manifest."
- **Interrupted between rollback-write and completion** -> Phase 0 discovers the incomplete recovery
  record even without a manifest; stop new setup and offer reviewed recovery without changing the record.
- **Non-Windows** -> Phases 1-5 only; Phase 6 prints a manual checklist and stops.

## Privacy + security (non-negotiable)

- Never `Read` a `.env*` file. Use `.env.example` for expected-var names only.
- Never write a secret value into any file. Keep credential placeholders such as `<YOUR_GITHUB_PAT>` literal; the user supplies secrets through their own environment, never in `.mcp.json` committed to git. Hosted OAuth servers (Stripe, Supabase, Vercel) need no secret.
- Supabase's `<your-dev-project-ref>` is a non-secret project identifier, not a credential or an environment-variable reference. Ask the user for their development project reference and confirm the development target. Replace that placeholder in the catalog URL before writing the Supabase entry to `.mcp.json`; retain `read_only=true`. If the reference is unavailable, defer that entry and report it pending; do not write the literal placeholder or an unscoped URL. Never request a token, password, or service-role key for this step.
- No network call carries project metadata or interview answers anywhere. All four artifacts
  (rollback manifest, setup-manifest.json, setup-audit.jsonl, the .mcp.json edits) are local to the
  target project and user-owned.
