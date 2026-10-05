---
tier: essential
required: true
profiles: [indie-free, solo-pro, senior-dev, agency, enterprise]
enforcement_tier: 1
load_bearing: true
enforcement_ref: "scripts/hooks/pre-bash-destructive-sql-guard.ps1 + scripts/hooks/pre-migration-destructive-guard.ps1"
---

# data-protection.md — Production Data Protection Rules

> **Authority:** Auto-loaded global rule. Applies to every VibePromptRig project.
> **Last updated:** 2026-04-27
> **Source incident:** PocketOS / Cursor / Railway 2026-04 — AI agent deleted production database in 9 seconds via blanket-permission token. Same architectural pattern existed in Example Finance App until this rule shipped.
> **Project-level overrides:** `<project>/.claude/rules/data-protection.md` may add stricter constraints; never relax these.

---

## §1 — The threat model (what we're protecting against)

1. **AI agent destroys production data** via reasoning error + admin-scoped MCP token + no confirmation step (PocketOS class).
2. **Stale token leak** — token granted broad scope, agent uses for unrelated destructive op (Railway CLI token had volumeDelete authority).
3. **Backup-in-same-blast-radius** — platform-managed snapshots stored alongside live data; both die together.
4. **Migration goes wrong on prod** — DDL applied without dev test; data destruction discovered after rollback window expires.
5. **Recovery is theoretical** — backups exist on paper but never restore-tested; turn out to be unusable when needed.

Each of these is a real failure mode in 2026. Mitigations below are non-negotiable.

---

## §2 — Mandatory architecture (every project from day 1)

### §2.1 Two-environment minimum

```
<project>-prod    Supabase project (live users only)
<project>-dev     Supabase project (everything else: testing, agent work, migrations)
```

- AI agents work on `dev` by default. Prod requires user manual flag.
- Migrations applied to dev → tested → promoted to prod via PR review.
- Production tokens NEVER stored in agent-accessible `.env` files in dev worktrees.

### §2.2 Two independent backup paths

**Path 1: Platform-managed PITR (Point-In-Time Recovery)**
- Supabase Pro tier required ($25/mo).
- 7-day rollback to any second.

**Path 2: Off-platform `pg_dump` daily**
- Different vendor (Backblaze B2 / S3 / GCS).
- Different blast radius — survives if Supabase is wiped.
- Cost: ~$5/mo for 100GB.
- Schedule: 3am daily via cron.

**Both paths required.** Single-path = no path.

### §2.3 Restore tested quarterly

Documented restore drill every 90 days:

```
1. Pull yesterday's off-platform backup
2. Restore to a fresh staging Supabase project
3. Run integrity checks: row counts, FK validity, RLS policies present
4. Document time-to-restore
5. Update STATUS_REPORT.md with drill result
```

**A backup not test-restored is not a backup.**

---

## §3 — Token scope (every project)

### §3.1 Token tiers

```
read-schema          → list_tables, list_extensions  (safe; no data)
read-data-dev        → SELECT only on dev project
read-data-prod       → SELECT only on prod project (rare; exports/audits)
apply-migration-dev  → DDL on dev project only
apply-migration-prod → DDL on prod project; user-flag required, expires 1h
service-role-prod    → never accessible to AI agent
```

### §3.2 What AI agents may have

By default, AI session has access to:
- `read-schema` (any project)
- `read-data-dev` (current project's dev)
- `apply-migration-dev` (current project's dev)

**Prod tier tokens require explicit user flag** in the session, e.g., "OK to apply this to prod." User flag expires after the immediate operation; does NOT persist for subsequent operations.

### §3.3 Token rotation

Rotate any token an LLM has seen the value of:
- After every production migration session
- After any token appears in a `cat .env` or `echo $TOKEN` in transcripts
- Quarterly minimum regardless

---

## §4 — Destructive operation gate

### §4.1 Pre-commit hook (every project with the `.githooks` pack installed)

> **Scope:** this hook lives in the tracked `.githooks` pack and fires only where a project has wired `core.hooksPath` to `.githooks` -- installed by `scaffold-new-project.ps1` / `onboard-existing-project.ps1 -Force` / `/setup`'s `hook-precommit-gates`, and NOT by a plugin update. Where the hook is absent, the surviving Tier-2 control is the §4.2 AI-side confirmation gate (the agent must diff + surface destructive ops + wait for explicit confirmation before any `apply_migration`).

Block commits whose SQL files in `supabase/migrations/` contain any of:

- `DROP TABLE` (any case)
- `DROP COLUMN`
- `ALTER TABLE ... DROP`
- `TRUNCATE`
- `DELETE FROM <table>` without `WHERE`
- `RESET ROLE`
- `DROP POLICY`
- `DROP INDEX`

**Unless** commit body contains `[approved-destructive]` flag with one-line reason.

### §4.2 Migration confirmation gate (AI side)

Before any `apply_migration` call to MCP, AI must:

1. Diff the SQL against current schema (use `list_tables` + `list_extensions`).
2. Surface to user any destructive operations explicitly:
   ```
   This migration includes:
     - DROP TABLE legacy_foo (will delete N rows)
     - DROP COLUMN bar.baz (will lose data type X)
   Confirm before I apply? [yes / no / show-me-data-first]
   ```
3. Wait for explicit user confirmation. **Never proceed silently.**

### §4.3 Post-migration advisor scan (mandatory)

**Rule (added 2026-05-13, PENDING_APPROVALS #15, Example Bookkeeping App harvest):** After every `apply_migration` call via the Supabase MCP, run `get_advisors` BEFORE the next task. Surface any new security advisories, missing RLS, or index gaps the migration introduced. Log the advisor output in the migration commit body.

- Cost: $0 — `get_advisors` is a free MCP call
- Catches: tables created without RLS, missing indexes on FK columns, function search_path issues, broken policy definitions
- Failure mode this prevents: a migration that adds a table without RLS isn't caught until a manual audit 3 sessions later (Example Bookkeeping App incident — confirmed class-of-bug recurrence)

```
Step 1: apply_migration succeeds
Step 2: get_advisors immediately
Step 3: If any new advisory: surface + fix BEFORE moving on (don't queue)
Step 4: Commit body: "Applied migration X. Advisors clean ✓"
        — or list the new findings explicitly
```

**Tripwire:** any commit modifying `supabase/migrations/*.sql` whose message does NOT contain `Advisors:` (clean or finding-list) is incomplete. Pre-commit hook can enforce: `grep -E "Advisors: (clean|" $COMMIT_MSG_FILE`.

### §4.4 Audit log

Every DDL/DML invoked from MCP logs to `admin_audit_log`:

```sql
CREATE TABLE admin_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operation TEXT NOT NULL,
    sql_hash TEXT NOT NULL,
    sql_preview TEXT NOT NULL,         -- first 200 chars
    project_id TEXT NOT NULL,
    token_fingerprint TEXT NOT NULL,
    invoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Daily review: any unexpected operation → investigate.

---

## §5 — Recovery SLA (every project must publish)

```
Tier 1 — Cold restore from off-platform backup
  Time-to-data-back: < 4 hours
  Data freshness: yesterday's snapshot (max 24h loss)

Tier 2 — Warm restore via Supabase PITR
  Time-to-data-back: < 30 minutes
  Data freshness: any point in last 7 days (max 0 loss within window)

Tier 3 — Live failover (NOT IMPLEMENTED YET)
  V2+ goal: replicated standby
```

Each project's `README.md` declares its current tier.

---

## §6 — Feature deletion rule (cross-project, promoted from Example Finance App 2026-04-23)

User-facing components are user trust. **Never delete a component because it appears hardcoded, fabricated, or unused.**

### §6.1 Forbidden

```
git rm src/features/SomeCard.tsx           ❌
git rm src/components/SomeWidget.tsx       ❌
```

…without explicit user approval logged in commit body.

### §6.2 Required instead

If you find a component that displays fake/hardcoded data:

1. **Restore-in-place with real data backing.** Wire the component to a real helper.
2. **If real data isn't available yet**, gate behind a sparse-data check (per global §7) — render an empty state, NOT delete.
3. **If the component is truly orphaned**, ask the project owner: "Component X is unused. Delete or archive?"

### §6.3 Tripwire (in every project that has the `.githooks` pack installed)

> **Scope:** same install dependency as §4.1 -- this tripwire fires only where the `.githooks` pack is wired (scaffold/onboard/`/setup`, not a plugin update). Where it is absent, the surviving process rule is §6.1 itself (never delete a user-facing component without explicit user approval logged in the commit body) -- a Tier-2 expectation the agent honors regardless of the hook.

```bash
# Block commits that delete files in user-facing dirs without approval flag
git diff --cached --diff-filter=D --name-only | grep -E "src/(features|components|pages)/" \
  && grep -q "\[approved-deletion\]" "$(git rev-parse --show-toplevel)/.git/COMMIT_EDITMSG" \
  || (echo "Component deletion requires [approved-deletion] flag in commit body"; exit 1)
```

### §6.4 Lesson context

April 2026: AI agent identified 22 components on Example Finance App as "fake" (rendered hardcoded numbers) and deleted them. the project owner pushed back: most were real components that just needed sparse-data gates added. Restoration cost ~6 hours. The mistake was deletion-as-default; the rule is gate-as-default.

---

## §7 — Sandboxing trajectory (each project sets its own pace)

**Current default (2026-04-27):** Claude Code default sandbox + manual oversight.

**Target by V2 launch of each project:**

- Docker container for autonomous agent runs (factory dispatch scripts run inside containers, not directly on host)
- mitmproxy intercepting outbound API calls; whitelist of allowed destinations
- Per-operation MCP tokens (not service-role admin)
- Production secrets never mounted into agent worktree during dev

**Eval queue (2026-Q3):**
- NVIDIA OpenShell (`github.com/NVIDIA/OpenShell`)
- Apple Containers
- Vercel Sandbox

Each project's CURRENT_SPRINT.md notes its sandboxing tier; V2 readiness check requires the target be met.

---

## §8 — Self-check (every session, every destructive operation)

Before any DDL or destructive DML, AI runs this checklist:

```
□ Project ID confirmed — is this dev or prod?
□ SQL diffed against current schema?
□ Destructive ops surfaced to user explicitly?
□ User has confirmed THIS specific change in THIS session?
□ Off-platform backup exists from < 24h ago?
□ Audit log entry will be written?
```

If ANY answer is no → STOP. Surface to user. Do not proceed.

---

## §9 — Recovery runbook (when prod data destruction happens)

If catastrophic data loss occurs:

1. **STOP all AI sessions** touching the affected project. Revoke all admin tokens.
2. **Notify the project owner** within 5 minutes via SMS + Discord/Slack.
3. **Determine scope:** what was deleted, when, by whom (which token).
4. **Path 2 first (off-platform):** restore from yesterday's pg_dump to staging. Validate.
5. **Path 1 (PITR):** if more recent state needed and within 7-day window, use Supabase PITR.
6. **Document:** post-incident report with root cause, what should have prevented it, what rule needs to change.
7. **Update this file** with the new rule.

---

## §10 — When AI is uncertain about destructiveness

Default to "this might delete data" unless certain otherwise. Examples of operations AI must always confirm:

- Any `DROP`, `TRUNCATE`, `DELETE FROM`, `ALTER ... DROP`
- Bulk `UPDATE` without explicit `WHERE` matching expected row count
- `RESET` of any RLS policy
- Removing index that backs a unique constraint
- Schema migration that recasts column type with potential data loss
- Anything inside a transaction the AI didn't write personally

When in doubt: ASK BEFORE EXECUTING. Always.

---

*Tripwire compliance: pre-commit hook, MCP wrapper, audit log, restore drill. All four required. Project READMEs declare tier compliance.*
