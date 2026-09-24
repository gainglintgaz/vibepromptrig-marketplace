// ship-execute.mjs -- Code -> Test -> Review for an already-approved kickoff.
//
// Planner (Stage 1 of /ship) still runs LIVE, in the foreground, dispatched directly by the
// conductor session -- NOT inside this workflow. Reason: the Bridge-Brief approval gate needs
// a human to see the plan and type "build approved" before anything else happens, and a
// background Workflow has no built-in way to pause mid-script and wait for that. So the split
// is at the ORCHESTRATION level, not inside one script: `/ship` dispatches Planner as a normal
// foreground Agent() call exactly as it always has; once a kickoff exists (and, for Bridge-
// Brief-class work, only once "build approved" is recorded), the conductor invokes THIS
// workflow for the rest of the pipeline (Stages 2-4), which has no further human checkpoint
// until the final PASS/HOLD verdict.
//
// SECURITY / SAFETY NOTES (read before touching this file):
//
// 1. APPROVAL GATE (mechanical, fail-closed): the conductor MUST pass `approved: true` in args
//    for any kickoff that Planner marked Bridge-Brief-class. This workflow verifies it before
//    dispatching Coder -- it does NOT re-derive whether approval was needed (it has no
//    filesystem access to read the kickoff itself), so the conductor is still the trust
//    boundary for THAT judgment call. What this gate closes: a caller cannot accidentally
//    invoke this workflow and have it silently execute writes with no approval signal at all --
//    the field must be explicitly true. A caller that lies about `approved` is a conductor bug,
//    not something this script can detect from inside a filesystem-less sandbox.
//
// 2. CONCURRENCY LOCK (best-effort -- CONFIRMED NECESSARY for the workflow path): a
//    hostile-architect stress-test on this file's first version found a CRITICAL gap -- two
//    concurrent ship-execute runs had no isolation and no lock, so they could interleave commits
//    on the same tree. Build #2 added `isolation: worktree` to coder.md's frontmatter, which
//    isolates a Coder dispatched via the Task path (the normal /ship Planner->Coder). BUT a
//    read-only probe (2026-07-09, run wf_22b05e01) CONFIRMED that frontmatter isolation does NOT
//    propagate to a Coder dispatched from INSIDE a workflow via agent({agentType:'coder'}): the
//    probe Coder reported its working tree as the MAIN repo (the factory root, on branch
//    master), not an isolated worktree. So the workflow Coder writes to the main tree, and
//    this lock is the REAL (and only) concurrency protection for the workflow path -- KEPT, not
//    removed. It correctly lives in the main tree (.claude/.ship-execute.lock), where a second
//    ship-execute run's Coder -- also in the main tree -- can see it. This script has NO
//    filesystem access itself (Workflow tool constraint), so the lock is enforced by instructing
//    the FIRST Coder to check-and-create it, released in a script-level try/finally. It is weaker
//    than a real mutex (depends on the dispatched agent following the instruction) and it guards
//    ONLY against a second SHIP-EXECUTE run -- NOT against other agents/sessions editing the main
//    tree concurrently. So: do not run /ship's Stage 2-4 while anything else may be editing this
//    tree.
//    NOT SOLVED (deferred, needs its own architect-probe -- do NOT naively bolt on): true
//    worktree isolation for the workflow path. Passing isolation:'worktree' as a call-level opt
//    on each coder() dispatch is NOT a safe one-liner, because this workflow dispatches the Coder
//    multiple times (initial + retries) and the Tester/Reviewer must SEE the Coder's committed
//    work -- a fresh per-call worktree would break the retry hand-off and the Tester's view of
//    the commits. Isolating a multi-dispatch pipeline is a real coordination design, not a flag.
//    If this workflow is ever wired to a non-interactive trigger (cron, /loop, a webhook), solve
//    that first.
//
// Faithfully implements ship.md's existing stage rules as deterministic control flow instead
// of conductor-narrated prose:
//   - Stage 3 (Test): RED -> one Coder retry with the exact failing tests -> re-test. Still
//     RED -> STOP (3-prompt-revert: don't spiral).
//   - Stage 4 (Review): HOLD -> one Coder retry with the named blockers -> re-test AND
//     re-review (ship.md: "loop the named blockers back to the Coder ONCE, then re-run Tester
//     + Reviewer"). Still HOLD -> STOP.
//   - EDGE CASE ship.md doesn't explicitly address, decided here: if the review-driven fix
//     causes the re-test to come back RED, that is also treated as blocked rather than
//     silently re-reviewing code with failing tests. Flagged explicitly in the return value
//     (`blockedReason: 'review-fix-broke-tests'`) so this design decision is visible, not
//     silently baked in.
//
// Structured verdicts (TEST_SCHEMA / REVIEW_SCHEMA) replace the conductor having to read and
// correctly interpret free-text GREEN/RED or PASS/HOLD prose -- agent() with a schema forces
// the dispatched Tester/Reviewer subagent to call StructuredOutput, so `result.verdict` is a
// guaranteed-shape value, not a parse. `failing_tests` / `blockers` are REQUIRED (not optional)
// specifically so a retry prompt never has to interpolate `JSON.stringify(undefined)` (the
// literal string "undefined") -- an adversarial review caught this as a real bug in the first
// version of this script, where an omitted array silently produced a blind, wasted retry.
//
// No filesystem/Node API access in this script body (Workflow tool constraint) -- kickoffPath
// is a STRING passed into each dispatched agent's prompt; the agent itself (which has normal
// Read/Glob/Bash tool access) reads the file. This script only orchestrates. Because of this,
// the CONDUCTOR (not this script) is responsible for verifying kickoffPath actually exists
// before invoking this workflow -- ship.md now says so explicitly.

export const meta = {
  name: 'ship-execute',
  description: 'Runs Code -> Test -> Review for an already-approved /ship kickoff (Planner runs separately, live, before this).',
  phases: [
    { title: 'Code' },
    { title: 'Test' },
    { title: 'Review' },
  ],
}

// Cap on any single string interpolated into an agent prompt -- an unbounded taskDescription or
// a huge Coder checkpoint has no natural ceiling otherwise (VIBE Rule 21, hard token budgets).
const MAX_INTERP_CHARS = 4000
function clip(s) {
  if (typeof s !== 'string') return s
  return s.length > MAX_INTERP_CHARS ? `${s.slice(0, MAX_INTERP_CHARS)}\n...[truncated, ${s.length} chars total]` : s
}
function clipJson(obj) {
  return clip(JSON.stringify(obj))
}

const CODER_SCHEMA = {
  type: 'object',
  required: ['locked', 'commits', 'changed_files', 'out_of_scope', 'checkpoint_summary'],
  properties: {
    locked: { type: 'boolean', description: 'true ONLY if the lock-check step found an existing, fresh lock and stopped without making any change -- see the lock protocol in the dispatch prompt' },
    lock_info: { type: 'string', description: 'If locked=true, whatever the existing lock file contained (raw text is fine)' },
    commits: { type: 'array', items: { type: 'string' }, description: 'Git commit SHAs created this stage (empty array if locked=true)' },
    changed_files: { type: 'array', items: { type: 'string' } },
    out_of_scope: { type: 'array', items: { type: 'string' }, description: 'Things deliberately left out of scope' },
    watch_items: { type: 'array', items: { type: 'string' }, description: 'Things Tester/Reviewer should scrutinize' },
    type_check: { type: 'string', enum: ['pass', 'fail', 'n/a'] },
    checkpoint_summary: { type: 'string', description: 'One-paragraph human-readable summary' },
  },
}

const TEST_SCHEMA = {
  type: 'object',
  required: ['verdict', 'failing_tests', 'summary'],
  properties: {
    verdict: { type: 'string', enum: ['GREEN', 'RED'] },
    failing_tests: {
      type: 'array',
      description: 'REQUIRED (empty array when GREEN) -- a RED verdict with this omitted would make the retry prompt interpolate the literal word "undefined"; always populate, even if summary also explains it.',
      items: {
        type: 'object',
        required: ['name', 'reason'],
        properties: { name: { type: 'string' }, reason: { type: 'string' } },
      },
    },
    db_roundtrip_verified: { type: 'string', enum: ['pass', 'fail', 'n/a'] },
    summary: { type: 'string' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['verdict', 'blockers', 'summary'],
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'HOLD'] },
    blockers: {
      type: 'array',
      description: 'REQUIRED (empty array when PASS) -- a HOLD verdict with this omitted would make the retry prompt interpolate the literal word "undefined"; always populate, even if summary also explains it.',
      items: {
        type: 'object',
        required: ['description', 'severity'],
        properties: {
          description: { type: 'string' },
          file: { type: 'string' },
          severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
        },
      },
    },
    summary: { type: 'string' },
  },
}

// Same parseArgs pattern as the sibling workflows (migration.mjs, factory-audit.mjs) --
// VIBE Rule 6 (consistency over creativity) + Rule 5 (no silent failures): a fat-fingered args
// string must be VISIBLE via log(), not silently discarded or hard-crashed on.
function parseArgs(a) {
  if (a == null) return {}
  if (typeof a === 'object') return a
  try {
    return JSON.parse(a)
  } catch (e) {
    log('ship-execute: WARNING -- args was not valid JSON; cannot proceed without kickoffPath.')
    return {}
  }
}
const opts = parseArgs(args)
const taskDescription = opts.taskDescription || null
const kickoffPath = opts.kickoffPath || null
const approved = opts.approved === true

if (!kickoffPath) {
  throw new Error('ship-execute requires args.kickoffPath -- run Planner (Stage 1) first, verify the path exists, and pass it here.')
}
if (!approved) {
  // Fail-closed: the conductor must explicitly say this kickoff is cleared to execute. This is
  // the mechanical half of the approval gate -- see the file-header SECURITY note. A missing or
  // false `approved` is treated identically (no partial trust) so a caller can't get through by
  // omission.
  throw new Error("ship-execute requires args.approved === true -- for Bridge-Brief-class kickoffs this means the founder's recorded \"build approved\" (or an explicit deltas-approval); for a plain kickoff it still means the conductor has decided Stage 2 may proceed. Never default this to true.")
}

const LOCK_CHECK_INSTRUCTION = `
LOCK PROTOCOL (do this FIRST, before reading or touching anything else):
1. Check whether .claude/.ship-execute.lock exists.
2. If it exists AND its "acquired_at" timestamp is less than 30 minutes old: STOP immediately.
   Do not read the kickoff, do not touch any other file. Return locked=true, lock_info set to
   the file's raw contents, and empty arrays for commits/changed_files/out_of_scope. Nothing
   else in this instruction applies.
3. Otherwise (no lock file, or it is 30+ minutes old / stale): create/overwrite
   .claude/.ship-execute.lock with a JSON object {"kickoffPath": "${kickoffPath}",
   "acquired_at": "<current ISO timestamp from \`date -u +%Y-%m-%dT%H:%M:%SZ\`>"}. Then proceed
   with the rest of this instruction normally, with locked=false.
This is a best-effort cooperative lock (documented as such in this workflow's source) -- follow
it exactly, do not skip it, do not "optimize" it away even if it seems unlikely another run is
active.`

function coderPrompt(instruction, includeLockCheck) {
  const lock = includeLockCheck ? LOCK_CHECK_INSTRUCTION : ''
  return `Implement the kickoff at ${kickoffPath}. Task: ${clip(taskDescription) || '(see kickoff)'}.${lock}\n\n${instruction}`
}

function assertAgentResult(result, stageLabel) {
  if (result == null) {
    throw new Error(`ship-execute: the ${stageLabel} dispatch returned no result (agent errored or was skipped) -- stopping rather than proceeding on missing data.`)
  }
  return result
}

let lockAcquired = false
try {
  phase('Code')
  let coder = assertAgentResult(
    await agent(
      coderPrompt('Follow the kickoff exactly, one commit per step, additive-first.', true),
      { agentType: 'coder', phase: 'Code', schema: CODER_SCHEMA }
    ),
    'initial Coder'
  )

  if (coder.locked) {
    log(`Existing ship-execute lock detected (${coder.lock_info || 'no detail'}) -- another run appears in progress. Stopping without making any change.`)
    return { status: 'blocked', stage: 'lock', blockedReason: 'concurrent-run-detected', kickoffPath, lockInfo: coder.lock_info }
  }
  lockAcquired = true

  phase('Test')
  let test = assertAgentResult(
    await agent(
      `Verify the Coder's changes against the kickoff at ${kickoffPath}. Coder's checkpoint: ${clipJson(coder)}`,
      { agentType: 'tester', phase: 'Test', schema: TEST_SCHEMA }
    ),
    'initial Tester'
  )

  if (test.verdict === 'RED') {
    log(`Tests RED (${test.failing_tests.length} failing) -- one Coder retry per ship.md's 3-prompt-revert discipline`)
    coder = assertAgentResult(
      await agent(
        coderPrompt(`The prior attempt has failing tests. Fix ONLY these, nothing else: ${clipJson(test.failing_tests)}. Prior checkpoint: ${clipJson(coder)}`, false),
        { agentType: 'coder', phase: 'Code', schema: CODER_SCHEMA }
      ),
      'retry Coder (test-fix)'
    )
    test = assertAgentResult(
      await agent(
        `Re-verify the Coder's fix against the kickoff at ${kickoffPath}. Coder's checkpoint: ${clipJson(coder)}`,
        { agentType: 'tester', phase: 'Test', schema: TEST_SCHEMA }
      ),
      'retry Tester'
    )
    if (test.verdict === 'RED') {
      log('Still RED after one retry -- stopping per ship.md (do not spiral)')
      return { status: 'blocked', stage: 'test', blockedReason: 'still-red-after-retry', kickoffPath, coder, test }
    }
  }

  phase('Review')
  let review = assertAgentResult(
    await agent(
      `Adversarially review the commit range for the kickoff at ${kickoffPath} against the project's full Definition-of-Done. Coder's checkpoint: ${clipJson(coder)}. Tests: GREEN.`,
      { agentType: 'reviewer', phase: 'Review', schema: REVIEW_SCHEMA }
    ),
    'initial Reviewer'
  )

  if (review.verdict === 'HOLD') {
    log(`Review HOLD (${review.blockers.length} blockers) -- one Coder retry, then re-run Tester + Reviewer per ship.md`)
    coder = assertAgentResult(
      await agent(
        coderPrompt(`The Reviewer HOLD-blocked this work. Fix ONLY these blockers, nothing else: ${clipJson(review.blockers)}. Prior checkpoint: ${clipJson(coder)}`, false),
        { agentType: 'coder', phase: 'Code', schema: CODER_SCHEMA }
      ),
      'retry Coder (review-fix)'
    )
    test = assertAgentResult(
      await agent(
        `Re-verify the Coder's review-driven fix against the kickoff at ${kickoffPath}. Coder's checkpoint: ${clipJson(coder)}`,
        { agentType: 'tester', phase: 'Test', schema: TEST_SCHEMA }
      ),
      'retry Tester (post-review-fix)'
    )
    if (test.verdict === 'RED') {
      // Edge case ship.md doesn't cover: the review-driven fix broke a test. Treat as blocked
      // rather than silently re-reviewing code known to fail tests.
      log('Review-driven fix broke a test -- stopping (edge case ship.md does not name; see file header)')
      return { status: 'blocked', stage: 'test', blockedReason: 'review-fix-broke-tests', kickoffPath, coder, test, review }
    }
    review = assertAgentResult(
      await agent(
        `Re-review the commit range for the kickoff at ${kickoffPath} after the fix. Coder's checkpoint: ${clipJson(coder)}. Tests: GREEN.`,
        { agentType: 'reviewer', phase: 'Review', schema: REVIEW_SCHEMA }
      ),
      'retry Reviewer'
    )
    if (review.verdict === 'HOLD') {
      log('Still HOLD after one retry -- stopping per ship.md (do not spiral)')
      return { status: 'blocked', stage: 'review', blockedReason: 'still-hold-after-retry', kickoffPath, coder, test, review }
    }
  }

  log('PASS -- ready to merge')
  return { status: 'ready-to-merge', kickoffPath, coder, test, review }
} finally {
  if (lockAcquired) {
    // Best-effort release regardless of how the try block exited (return or throw). If this
    // dispatch itself fails, the lock's own 30-minute staleness window (see LOCK_CHECK_INSTRUCTION)
    // is the backstop, not a second retry here -- keep cleanup simple and non-blocking.
    await agent(
      'Delete .claude/.ship-execute.lock if it exists (release the ship-execute concurrency lock). This is cleanup only -- report done in one sentence, no schema needed.',
      { agentType: 'coder', phase: 'Code' }
    ).catch(() => {})
  }
}
