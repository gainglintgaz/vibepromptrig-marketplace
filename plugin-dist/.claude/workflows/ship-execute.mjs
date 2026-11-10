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
//   - Stage 4 (Review): HOLD -> ROOT-CAUSE STAGE FIRST (VF-T19): a read-only `diagnostician`
//     (never the author) traces the failure at the review's frozen head, explains why the
//     author's tests passed, audits every analogous site and names red-first tests. The repair
//     is REFUSED unless that diagnosis matches the reviewed head ("no-root-cause") and
//     completes every mandatory section ("incomplete-root-cause"); "defer" stops the run. Only then
//     one Coder retry, which must add the red-first tests before the fix (refused as
//     "probes-not-imported" for missing names, "probes-not-verified" without independent
//     Tester evidence at the pre-fix review head) -> re-test AND re-review. Still HOLD -> STOP with a
//     /second-look recommendation; never a third Coder pass. The gate logic is the pure
//     function `rootCauseGate` below, unit-tested in scripts/tests/ship-root-cause.test.mjs.
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
    { title: 'Diagnose' },
  ],
}

// Cap on free-text strings interpolated into an agent prompt -- an unbounded taskDescription or
// a huge Coder checkpoint has no natural ceiling otherwise (VIBE Rule 58, hard token budgets).
// The independent Tester's required test specifications stay complete so no probe is omitted.
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
    red_tests_added: {
      type: 'array',
      items: { type: 'string' },
      description: 'Root-cause retry only: the red-first test names you added (and saw fail) BEFORE the fix, one per required red-first test. Empty array on a first pass.',
    },
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
  required: ['verdict', 'head_sha', 'blockers', 'summary'],
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'HOLD'] },
    head_sha: { type: 'string', description: 'REQUIRED: full `git rev-parse HEAD` of the tree you reviewed (the frozen head the root-cause stage must diagnose).' },
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
          probe: { type: 'string', description: 'The exact command, input or test that demonstrates the blocker, when you have one. The root-cause stage treats it as the specification.' },
        },
      },
    },
    summary: { type: 'string' },
  },
}

// Only the review-driven retry needs historical red-first evidence. Ordinary test dispatches
// retain TEST_SCHEMA; a GREEN suite alone does not prove the retry imported regression probes.
const PROBE_TEST_SCHEMA = {
  ...TEST_SCHEMA,
  required: [...TEST_SCHEMA.required, 'probe_results'],
  properties: {
    ...TEST_SCHEMA.properties,
    probe_results: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['name', 'exists_in_tree', 'failed_on_pre_fix_head'],
        properties: {
          name: { type: 'string' },
          exists_in_tree: { type: 'boolean' },
          failed_on_pre_fix_head: { type: 'boolean', description: 'True only after independently running this test against the frozen review head, before the implementation commit, and observing its specified failure.' },
        },
      },
    },
  },
}

const DIAGNOSIS_SCHEMA = {
  type: 'object',
  required: ['head_sha', 'root_cause_path', 'failure_path', 'why_tests_passed', 'sites', 'minimal_design', 'ranked_alternatives', 'red_first_tests', 'claims', 'evidence_limits', 'recommended_action', 'confidence', 'summary'],
  properties: {
    head_sha: { type: 'string', description: 'The `git rev-parse HEAD` you diagnosed. Empty string if HEAD did not match the review head or you authored the commits.' },
    root_cause_path: { type: 'string', description: 'Repo-relative path of the ROOT-CAUSE.md you wrote.' },
    failure_path: { type: 'array', items: { type: 'string' }, description: 'Line-level failure path, one `file:line` step per item.' },
    why_tests_passed: { type: 'string' },
    sites: {
      type: 'array',
      items: {
        type: 'object',
        required: ['location', 'same_defect', 'note'],
        properties: { location: { type: 'string' }, same_defect: { type: 'string', enum: ['yes', 'no', 'unknown'] }, note: { type: 'string' } },
      },
    },
    red_first_tests: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'asserts', 'derived_from'],
        properties: { name: { type: 'string' }, asserts: { type: 'string' }, derived_from: { type: 'string', minLength: 1 } },
      },
    },
    minimal_design: {
      type: 'object',
      required: ['summary', 'files'],
      properties: { summary: { type: 'string', minLength: 1 }, files: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } } },
    },
    ranked_alternatives: {
      type: 'array',
      minItems: 2,
      description: 'Ranked in order of preference; at least one action must be defer, with costs and revisit conditions in its summary.',
      items: {
        type: 'object',
        required: ['action', 'summary'],
        properties: { action: { type: 'string', minLength: 1 }, summary: { type: 'string', minLength: 1 } },
      },
    },
    claims: {
      type: 'array',
      minItems: 1,
      description: 'Every claim in ROOT-CAUSE.md, with its confidence tag; include command or line evidence in VERIFIED claim text.',
      items: {
        type: 'object',
        required: ['claim', 'tag'],
        properties: { claim: { type: 'string', minLength: 1 }, tag: { type: 'string', enum: ['VERIFIED', 'HYPOTHESIS'] } },
      },
    },
    evidence_limits: { type: 'string', minLength: 1, description: 'What could not be checked and why; explicitly state none if there are no known limits.' },
    recommended_action: { type: 'string', enum: ['repair', 'defer'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    summary: { type: 'string' },
  },
}

// <root-cause-gate> -- VF-T19. Pure (no I/O, no workflow globals) so scripts/tests/ship-root-cause
// .test.mjs can load exactly this block; keep it self-contained between the two markers.
// rootCauseGate returns { ok: true } or { ok: false, reason } where reason is the blockedReason.
function rootCauseGate(review, diagnosis) {
  if (!diagnosis || typeof diagnosis !== 'object') return { ok: false, reason: 'no-root-cause' }
  const reviewed = typeof review?.head_sha === 'string' ? review.head_sha.trim() : ''
  const diagnosed = typeof diagnosis.head_sha === 'string' ? diagnosis.head_sha.trim() : ''
  if (!reviewed || !diagnosed || reviewed !== diagnosed) return { ok: false, reason: 'no-root-cause' }
  if (typeof diagnosis.root_cause_path !== 'string' || !diagnosis.root_cause_path.trim()) return { ok: false, reason: 'no-root-cause' }
  // Validate every mandatory document section even if a caller bypasses schema validation.
  const text = (s) => typeof s === 'string' && s.trim().length > 0
  const list = (a, valid) => Array.isArray(a) && a.length > 0 && a.every(valid)
  if (!list(diagnosis.failure_path, text)
    || !text(diagnosis.why_tests_passed)
    || !list(diagnosis.sites, (s) => text(s?.location) && ['yes', 'no', 'unknown'].includes(s?.same_defect) && text(s?.note))
    || !text(diagnosis.minimal_design?.summary) || !list(diagnosis.minimal_design?.files, text)
    || !list(diagnosis.ranked_alternatives, (a) => text(a?.action) && text(a?.summary))
    || diagnosis.ranked_alternatives.length < 2 || !diagnosis.ranked_alternatives.some((a) => a.action === 'defer')
    || !list(diagnosis.red_first_tests, (t) => text(t?.name) && text(t?.asserts) && text(t?.derived_from))
    || !list(diagnosis.claims, (c) => text(c?.claim) && ['VERIFIED', 'HYPOTHESIS'].includes(c?.tag))
    || !text(diagnosis.evidence_limits)
    || !['repair', 'defer'].includes(diagnosis.recommended_action)
    || !['high', 'medium', 'low'].includes(diagnosis.confidence) || !text(diagnosis.summary)) {
    return { ok: false, reason: 'incomplete-root-cause' }
  }
  if (diagnosis.recommended_action === 'defer') return { ok: false, reason: 'root-cause-recommends-defer' }
  return { ok: true }
}

// Probe-import check: every red-first test the diagnosis named must appear, by name, among the
// tests the retry reports adding. Names are compared case- and whitespace-insensitively; a
// duplicate or an unrelated name never stands in for a missing one.
function normalizeTestName(name) {
  return typeof name === 'string' ? name.trim().toLowerCase().replace(/\s+/g, ' ') : ''
}
function probesImported(diagnosis, coder) {
  const required = Array.isArray(diagnosis?.red_first_tests) ? diagnosis.red_first_tests.map((t) => normalizeTestName(t?.name)).filter(Boolean) : []
  if (required.length === 0 || new Set(required).size !== required.length) return false
  const added = new Set((Array.isArray(coder?.red_tests_added) ? coder.red_tests_added : []).map(normalizeTestName).filter(Boolean))
  return required.every((name) => added.has(name))
}

// Coder names are only an import claim. The independent Tester must verify each required
// identity, existence and historical failure. Missing/malformed/conflicting evidence fails closed.
function probesVerified(diagnosis, test) {
  const required = Array.isArray(diagnosis?.red_first_tests) ? diagnosis.red_first_tests.map((t) => normalizeTestName(t?.name)) : []
  const evidence = Array.isArray(test?.probe_results) ? test.probe_results : []
  return required.length > 0 && new Set(required).size === required.length && required.every((name) => {
    const matches = evidence.filter((p) => normalizeTestName(p?.name) === name)
    return name && matches.length > 0 && matches.every((p) => p.exists_in_tree === true && p.failed_on_pre_fix_head === true)
  })
}

// Where the conductor saves the blocked result so /second-look has a review_path to read.
function reviewArtifactPath(review) {
  const head = typeof review?.head_sha === 'string' ? review.head_sha.trim() : ''
  return `docs/diagnosis/${head ? head.slice(0, 12) : 'unknown-head'}/REVIEW.json`
}
// </root-cause-gate>

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
    log(`Review HOLD (${review.blockers.length} blockers) -- root-cause stage before any repair (VF-T19)`)
    phase('Diagnose')
    const diagnosis = assertAgentResult(
      await agent(
        `Diagnose the Reviewer HOLD for the kickoff at ${kickoffPath} BEFORE any repair. You did not write this code. Frozen review head: ${clip(review.head_sha)}. Reviewer blockers (each probe is the specification): ${clipJson(review.blockers)}. Reviewer summary: ${clip(review.summary)}. Write ROOT-CAUSE.md per your agent contract and return the structured result.`,
        { agentType: 'diagnostician', phase: 'Diagnose', schema: DIAGNOSIS_SCHEMA }
      ),
      'Diagnostician'
    )
    const gate = rootCauseGate(review, diagnosis)
    if (!gate.ok) {
      log(`Repair refused: ${gate.reason} -- no Coder retry without a matching non-author root cause`)
      const artifact = reviewArtifactPath(review)
      return { status: 'blocked', stage: 'diagnose', blockedReason: gate.reason, kickoffPath, coder, test, review, diagnosis, reviewArtifactPath: artifact, recommendation: gate.reason === 'root-cause-recommends-defer' ? `owner decides: accept the deferral recorded in ROOT-CAUSE.md or overrule it (save this result as ${artifact} first)` : `save this result as ${artifact}, then run /second-look ${artifact} before any repair` }
    }
    phase('Code')
    coder = assertAgentResult(
      await agent(
        coderPrompt(`The Reviewer HOLD-blocked this work and a separate diagnostician traced the root cause (${diagnosis.root_cause_path}). Read it first. FIRST add these red-first tests and confirm each FAILS on the frozen pre-fix review head ${clip(review.head_sha)}, before changing any implementation: ${clipJson(diagnosis.red_first_tests)}. Commit the tests separately BEFORE the implementation commit so the Tester can independently replay them against that pre-fix head. THEN implement the minimal design from ROOT-CAUSE.md so they pass, covering every class-audit site marked same_defect=yes: ${clipJson(diagnosis.sites)}. Fix nothing else. Report every red-first test you added in red_tests_added. Original blockers: ${clipJson(review.blockers)}. Prior checkpoint: ${clipJson(coder)}`, false),
        { agentType: 'coder', phase: 'Code', schema: CODER_SCHEMA }
      ),
      'retry Coder (root-cause repair)'
    )
    if (!probesImported(diagnosis, coder)) {
      log('Repair refused: the retry did not add the red-first tests from the root cause -- stopping before re-review')
      return { status: 'blocked', stage: 'code', blockedReason: 'probes-not-imported', kickoffPath, coder, test, review, diagnosis }
    }
    test = assertAgentResult(
      await agent(
        `Re-verify the Coder's review-driven fix against the kickoff at ${kickoffPath}. Independently verify ALL diagnosis red_first_tests: ${JSON.stringify(diagnosis.red_first_tests)}. Frozen pre-fix head: ${clip(review.head_sha)} (the reviewed head BEFORE the implementation commit). Coder's checkpoint: ${clipJson(coder)}. Do not trust red_tests_added or the Coder's claimed red run. Locate each required test in the repaired tree and replay the test additions, without the implementation changes, against that exact pre-fix SHA in an isolated temporary tree; never reset or edit the working source tree. Run each test and observe its specified assertion fail, not a setup/import error. Return probe_results per required test: {name, exists_in_tree, failed_on_pre_fix_head}. Missing tests, an unobserved failure, unavailable historical replay or ambiguous evidence must return false, never infer success from a GREEN repaired suite. Also run the affected suite on the repaired tree and return GREEN/RED as usual.`,
        { agentType: 'tester', phase: 'Test', schema: PROBE_TEST_SCHEMA }
      ),
      'retry Tester (post-review-fix)'
    )
    if (!probesVerified(diagnosis, test)) {
      log('Repair refused: independent Tester evidence did not verify every red-first probe')
      return { status: 'blocked', stage: 'test', blockedReason: 'probes-not-verified', kickoffPath, coder, test, review, diagnosis }
    }
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
      log('Still HOLD after the root-cause repair -- stopping; never a third Coder pass')
      const artifact = reviewArtifactPath(review)
      return { status: 'blocked', stage: 'review', blockedReason: 'still-hold-after-retry', kickoffPath, coder, test, review, diagnosis, reviewArtifactPath: artifact, recommendation: `save this result as ${artifact}, then run /second-look ${artifact} with at least two different tools and reconcile in COMPARE.md before any further repair` }
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
