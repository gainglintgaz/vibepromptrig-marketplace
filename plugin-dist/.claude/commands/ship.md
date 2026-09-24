---
description: Run the 4-agent ship pipeline (Planner → Coder → Tester → Reviewer) on a task, with a founder-approval gate for Bridge-Brief-class work. Stage 1 (Plan) runs live so you can approve Bridge-Brief-class work; Stages 2-4 (Code/Test/Review) run as one background workflow with the loop-until-green discipline built in as code, not conductor memory.
argument-hint: <one-line task description>
allowed-tools: Task, Workflow, Read, Glob, Grep, Bash(git *)
---

# /ship — 4-agent pipeline

Orchestrate a task end-to-end through four specialist subagents, each on the right model
(flagship for judgment, mid-tier for execution). You (the main session) are the conductor for
Stage 1 only; Stages 2-4 run as a single background Workflow
(`.claude/workflows/ship-execute.mjs`) so their per-stage output doesn't fill your context and
the retry-once-then-stop rules are enforced as deterministic code, not prose you have to
remember to follow. You do NOT write code yourself — that's the Coder's job, either way.

**Isolation status (confirmed 2026-07-09):** the two dispatch paths behave *differently*, and
this was probe-verified, not assumed:
- **Task path** (the normal `/ship` Planner→Coder, and any `Task(subagent_type:"coder")`): the
  Coder's `isolation: worktree` frontmatter (coder.md, Build #2) applies — it runs in a fresh
  git worktree per run. A fresh worktree only sees **committed** content, so the kickoff must be
  committed before the Coder can read it; the Stage 1 Planner now does this
  (`docs: kickoff for <slug>`), which is why the "verify kickoffPath exists" step below is really
  "verify it's committed."
- **Workflow path** (Stages 2-4 via `ship-execute.mjs`'s `agent({agentType:"coder"})`):
  frontmatter isolation does **NOT** propagate here — a read-only probe confirmed the
  workflow-dispatched Coder runs in the **main tree**, not an isolated worktree. So the workflow
  keeps a best-effort cooperative lock (see the SECURITY notes atop ship-execute.mjs) as the
  real, and only, concurrency protection for this path. That lock guards against a **second
  `ship-execute` run** — it does NOT guard against other agents/sessions editing the tree. So do
  not invoke Stages 2-4 while any other agent (or another `/ship`) may be editing this tree.
  Full worktree isolation for the workflow path is a deferred design task (a multi-dispatch
  pipeline can't just take a per-call `isolation` flag without breaking the retry + Tester
  hand-off — see the ship-execute.mjs header).

**Task:** $ARGUMENTS

## Budget + routing

- Per-task target ≈ 4k output / per-session ≈ 30k (surface a breach; never silently overrun).
  This budget is easier to hold now: only Stage 1's output lands in your context directly;
  Stages 2-4's four-agent worth of prose stays inside the workflow's own execution.
- Stage models + effort (via each agent's frontmatter, per gear-shift.md's lane defaults):
  Planner = opus/high, Coder = sonnet/medium, Tester = sonnet/medium, Reviewer = opus/high.
  The cheap stages do the volume; the flagship stages do the thinking. Each stage's frontmatter
  also carries a `router_category:` pointing at the matching model-router.json task_category
  (architecture / code_build / data_qa) -- if tech-radar changes a category's preferred model,
  the linked agent frontmatter is the place to revisit, not this comment.

## Pipeline

### Stage 1 — Plan (live, foreground -- unchanged from before)
Dispatch `Task(subagent_type: "planner")` with the task. The Planner returns EITHER:
- **⛔ Bridge-Brief-class** → a brief was written. **STOP. Show the founder the brief path and
  require them to type "build approved" (or "build approved with deltas: …") before Stage 2.**
  Do not proceed on your own.
- **Kickoff ready** → a `docs/specs/<slug>/kickoff.md` path + paste-ready block. Proceed.

Relay the plan to the human. Checkpoint: "Plan ready: <path>. Proceeding to Code/Test/Review."

**Why Stage 1 stays live and isn't folded into the workflow:** a background Workflow has no
built-in way to pause mid-script and wait for your typed "build approved" — so the split has to
happen at the orchestration level (two separate dispatches), not inside one script. This is a
deliberate design decision, not an oversight; see the header comment in ship-execute.mjs.

### Stages 2-4 — Code, Test, Review (one background Workflow call)
Before invoking, **verify `kickoffPath` actually exists** (`Read` or `Glob` it) — the workflow
has no filesystem access of its own to check this, so a typo'd or stale path would otherwise
reach the Coder as a bare task description with no real plan behind it (exactly the silent-
assumption failure architect-first.md exists to prevent). Only if (kickoff exists) AND (no
pending Bridge-Brief approval, or approval was given), invoke:

```
Workflow({ name: "ship-execute", args: { taskDescription: <the task>, kickoffPath: <the kickoff path from Stage 1>, approved: true } })
```

`approved: true` is REQUIRED and is not a formality — the workflow fails closed (throws,
nothing runs) without it. Only pass it once you have actually confirmed: for a plain kickoff,
that you've decided Stage 2 may proceed; for a Bridge-Brief-class kickoff, that the founder's
"build approved" (or "build approved with deltas: …") is recorded. Never pass `true`
automatically or by default.

This runs Code → Test → Review as one background job. Internally it enforces exactly what this
file used to describe in prose: Tester RED → one Coder retry → re-test, still RED → stop;
Reviewer HOLD → one Coder retry → re-test AND re-review, still HOLD → stop. You get a single
result back when it completes — no need to relay each stage individually.

**On completion, report to the human based on the workflow's returned `status`:**
- `status: "ready-to-merge"` → PASS. Report: ready to push/merge (the human decides — you don't
  auto-push unless they asked). Include `result.coder.checkpoint_summary` +
  `result.review.summary`.
- `status: "blocked"` → surface `result.stage` + `result.blockedReason` + the relevant verdict
  object (`result.test` or `result.review`) to the human plainly. Do NOT retry again yourself —
  the workflow already used its one retry per ship.md's 3-prompt-revert discipline. Ask the
  human how they want to proceed. `result.stage === "lock"` specifically means another
  ship-execute run appears to already be in flight (`result.lockInfo` has what it found) —
  don't retry at all until you've confirmed the other run actually finished.

## Conductor rules

- Checkpoint after Stage 1, then again once the workflow completes (one line each: what
  finished, what's next). If you can't write a clean checkpoint, stop.
- The Bridge-Brief approval gate is hard — never invoke the Stage 2-4 workflow for a
  Bridge-Brief-class feature without the founder's recorded "build approved".
- Never push to main / deploy / flip production flags unless the human explicitly said so.
- If the project has its own `.claude/agents/{planner,coder,tester,reviewer}.md`, those
  (project-local) win over the factory defaults — they read the project's own rules at runtime.
  The workflow's `agentType:` dispatches resolve through the same agent registry, so
  project-local overrides apply there too, automatically.
