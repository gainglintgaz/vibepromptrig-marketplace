# Bounded workforce coordination

These APIs let an already authorized host coordinate disposable proposal, check,
review and repair tasks. Loading the package does not start a worker, connect an
account, enroll a project, install a service or schedule a job.

## What the host supplies

The attended/automatic cloud-loop route requires Node.js 24 or newer and Windows
native process fences. Older Node versions are refused before opening the loop.
The standard plugin hooks' Node.js 18 minimum does not cover this optional route.

1. Sign in through each provider's own interface. Keep credentials in its native
   credential store. Supply an authentication path only where the adapter accepts
   one; never put tokens in prompts, project files or a shared configuration.
2. Complete provider consent and native permission screens yourself. Browser
   Remote Control can require one-time human onboarding. A public environment
   without interactive onboarding needs a separately qualified CLI, SDK or queue
   relay. A browser acknowledgment does not prove repository access or review.
3. Select a disposable project, exact file scope, candidate, provider session,
   budget and expiry. Existing S7 admission remains authoritative. Host callbacks
   are executable trusted code; a JSON field cannot grant permission.
4. Supply an actual result observer and independently selected checks. Provider
   prose is data. Accept only bound results and candidate-specific checks/reviews.
   Unsupported routes stay unavailable instead of silently switching providers.

## Automatic cloud-loop progression

Use `scripts/forge/attended-cloud-loop.mjs` to create the authorized loop with
`projectBinding: {tenantId, projectId}`. Retain its returned root and the existing
cloud session ID. Close the setup handle, then register that loop with
`openAutomaticCloudCoordinator` from
`scripts/forge/automatic-cloud-coordinator.mjs`:

```js
const coordinator = await openAutomaticCloudCoordinator({
  projects: registrations, // existing root/session plus trusted host callbacks
  maxActions: 24,
});
try {
  const result = await coordinator.run({
    events: completionHints, // optional async iterable supplied by the host
    intervalMs: 1000,
    maxPasses: 16,
    signal: abortController.signal,
  });
  // Inspect each project's verdict and checks, not just result.state.
} finally {
  await coordinator.close();
}
```

Each registration contains `tenantId`, `projectId`, `root`, `sessionId` and `host`.
`host` provides `attest`, `observe` and `checks`. IDs must be explicit. Duplicate
sessions and overlapping roots are refused before any loop opens. Existing
loops without project bindings must not be silently relabeled.

A completion hint contains `eventId`, `tenantId`, `projectId`, `sessionId`,
`requestId`, `inputSha` and `generation`, all matching the saved request. A hint
wakes reconciliation; it cannot supply authority, commands or replacement files.
Timed reconciliation also observes saved requests, so a missing hint does not
hide pending work. Repeated hints do not resubmit completed requests. A project
with an unavailable provider does not prevent another project from advancing.

This is a finite in-process run. The host owns when it invokes the API and reads
its result. No operating-system schedule or always-running service is created.
Existing deadlines, generation limits and financial holds still apply.

## Results and recovery

- `terminal`: every registered loop reached a terminal phase. Inspect each
  verdict: a terminal BLOCKED result is not PASS.
- `bounded`: the run reached its configured pass limit. Preserve roots and request
  identities; another authorized invocation can reconcile the same saved work.
- `held`: no safe progress is currently available. Read each project's concrete
  code. Do not delete a lock or invent evidence to clear it.
- `event-source-held`: the supplied event source failed. The coordinator can be
  closed or reconciled again; repair the source or use bounded reconciliation.
- `stopped`: the host's abort signal ended the pump between passes. This does not
  prove that a remote model or its descendants stopped.

After a restart, reopen the same registered roots. Unknown submissions and
interrupted mutations remain held instead of being replayed. A check interrupted
by process termination retains its operation lock. Another independent project
can still continue. Provider-specific recovery must positively identify the
original owner/request; never release an unrelated lock or charge.

`eventSource: close-unconfirmed` reports an unconfirmed event-iterator shutdown.
It is not a provider cancellation receipt. Likewise, process exit, final model
text, provider turn cancellation and financial settlement are different evidence.

## Provider boundaries

The cloud loop uses the existing Claude cloud proposal and independent Codex
review interfaces. Its observer still depends on a qualified host observation
route. Native provider adapters expose their own capability and failure states;
preparation or initialization alone must not be called successful execution.

Grok's native proposal route is opt-in through `invokeAttendedNative` with
`provider: 'grok'` and `grokHeadless: true`. Supply an absolute native executable,
native `authPath`, empty disposable worktree, separate evidence root, UUID
invocation/session identities, prompt, exact `scopePaths`, and trusted
`beforeInput` and `qualifyNative` callbacks. The host must inspect the exact frozen
launch environment and attest its binary/policy hashes, managed-only hook policy,
and empty MCP, plugin and project-instruction inventories. Qualification does not
replace S7 admission. `beforeInput` must confirm that admission before launch.

The project and evidence roots must be disjoint. Admission receives
`beforeInput(event, {signal})`; if cancellation is requested, the host must finish
its authoritative cleanup and settle with `{cancelled: true, evidenceRef}`.
An ignored abort or an unconfirmed late result remains `GROK_ADMISSION_UNCERTAIN`
with durable operation/financial holds and no prompt launch. Reusing that
invocation cannot resend it. The host must reconcile its original admission;
do not delete the receipt or treat a callback timeout as confirmed cleanup.

This route isolates the provider's home, disables its tools, subagents and web
search, and limits the invocation to one turn. A matching session, `end_turn`,
exit zero and a valid scoped proposal are required for completion. It returns a
proposal; it does not apply that proposal or enroll Grok in the cloud-loop
coordinator. Reusing an invocation identity refuses a new submission. Timeout
keeps STOP unknown and the financial hold intact; cancellation and descendant
termination have not been established by the successful proposal trial.

The separate `grokAcp: true` route requires additional native evidence of an empty
effective tool registry. Protocol simulation is not native qualification; the
host must refuse this route until that evidence exists.

Cursor, Antigravity and other integrations must separately establish task
submission, bound result retrieval and completion/cancellation behavior before
being enabled by a host. MCP access to a backend does not itself provide a worker
lifecycle or automatically coordinate other providers. Keep one dispatch owner
for each project and session; reuse S7 admission and receipts rather than creating
another competing queue.

Runtime identities, account paths, device names, actual sessions, private project
roots and saved consent belong to the host's private state. This package contains
no operator-specific account defaults. Installation, publication and real-project
activation are separate release decisions after an accepted disposable proof.

## Provider capability matrix

The table below reflects current capability and verification status across supported
and candidate provider routes. Implementations must distinguish specified designs,
implemented code, and verified proofs at a pinned SHA.

| Provider / Surface | Role & Route | Status | Supported Operations | Boundaries & Refusals | Cancellation / STOP Proof |
|---|---|---|---|---|---|
| **Claude Code (Cloud)** | Proposal generator (`attended-cloud.mjs` / `attended-cloud-loop.mjs`) | Live loop verified on PR118; code inclusion refreshed at `d0bf057` | Turn preparation, prompt submission to pre-existing session ID, status observation (`cloudTurnStatus`), result consumption (`consumeCloudTurn`), session lock recovery (`recoverCloudSessionLock`). | Pre-existing session binding required (`session_[A-Za-z0-9]{1,100}`); Node 24 and Windows native fences required for attended loop (`NODE_24_REQUIRED_FOR_CLOUD_LOOP`). No cloud session create/close APIs exist. | `host.observe` receives a pointer without an AbortSignal; its timeout races the callback without cancelling it (`attended-cloud.mjs:261`). Coordinator `AbortSignal` ends reconciliation pump between passes; loop `AbortSignal` belongs to `host.checks` (`attended-cloud-loop.mjs:146`). Remote provider turn cancellation remains **unverified**. |
| **Codex** | Independent reviewer & repair generator | Verified at `d0bf057` | Candidate-bound review (`PASS` / `CHANGES_REQUESTED`), generation-bound repair prompt creation. | One review per candidate; candidate hash mismatch immediately refuses review or consume. | In-process execution bounded by host timeouts. |
| **Grok (Headless Native)** | Tool-free single-turn proposer (`grokHeadless: true`) | Single-turn proposal verified at `d0bf057` | Single-turn proposal generation in empty worktree; returns scoped patch proposal. | Disjoint project/evidence roots; single-turn only; managed hook policy (`nonManagedHooks.enabled=false`); empty MCP inventory. | Child process kill at `d0bf057` is root-only (`child.kill()`). Windows Job Object helper (`owned-job.cs`) integration is candidate `0ba4a0a` in a separate worktree and remains unaccepted. Remote compute cancellation, descendant termination, and financial settlement remain **unverified**. |
| **Grok (ACP)** | Agent Client Protocol runner (`grokAcp: true`) | Refused / Held | Protocol initialization specified. | Refused until native evidence of an empty effective tool registry is supplied. | Unverified. |
| **Antigravity (Attended UI)** | Interactive chat & continuation (`Antigravity.exe`) | Partially Qualified (Attended messaging only); file write/coding **unqualified** | User-attended chat message submission and same-session continuation (`VPR-ANTIGRAVITY-20261013-A/B`). | Cross-project messaging refused (`cross-project messaging is not allowed: sender project does not match recipient project`) for tested sender/target pair. File writes blocked by session `Request Review` tool policy (synthetic write probe produced no file; pre-existing transcript and unchanged README were historical evidence). Headless batch execution unsupported in GUI CLI. Python SDK not importable in tested interpreter (`ModuleNotFoundError`). | Local UI Cancel button stops token stream. External OS process termination and remote provider-side compute cancellation remain **unverified**. |
| **Cursor** | IDE-assisted proposer | Blocked / Held | CLI invocation specified. | Blocked on inherited-hook isolation. Refused until clean execution environment or native hook isolation is proven. | Unverified. |
| **Resource MCPs** (GitHub, Cloudflare, Supabase) | Tool & context providers | Implemented | Read/write repository metadata, PR status, Edge/Queue bindings, database queries. | Resource access only. MCP tools do not provide worker process lifecycle, task queues, or cross-provider scheduling. | Governed by individual API call timeouts; not an agent lifecycle handle. |

> [!NOTE]
> The automated two-project recovery proof exercised real Windows process termination,
> child relaunches, and SQLite journal locks using **simulated providers**. The earlier
> Claude-cloud/Codex build-review-repair cycle is a separate proof on live providers.
> Grok's native proposal completion is a single-turn result proof, not full cancellation proof.

## Specified route failure taxonomy and coordinator error handling

The coordinator loop (`automatic-cloud-coordinator.mjs`) uses a fixed timer interval
(`intervalMs`, default 1000ms) with `setTimeout` to pace reconciliation passes; it does
**not** implement exponential backoff.

### Runtime Machine Codes vs. Specified Taxonomy

The runtime emits exact machine codes across its modules:
- **Coordinator:** Emits result states (`terminal`, `held`, `bounded`, `stopped`, `event-source-held`),
  pass action records (`submit`, `observe`, `advance`, `status`), and rejection codes
  (`COORDINATOR_SCOPE`, `SIMULATION_LABEL_REQUIRED`, `PROJECT_REGISTRATION`, `HOST_CALLBACKS_REQUIRED`,
  `UNSAFE_ROOT`, `PROJECT_OVERLAP`, `PROJECT_CHANGED`, `EVENT_BINDING`, `COORDINATOR_CLOSED`,
  `COORDINATOR_BUSY`, `EVENT_SOURCE`, `COORDINATOR_CLOSE_HELD`).
- **Attended Cloud / Loop:** Emits observation states (`OBSERVATION_TIMEOUT`, `OBSERVATION_REFUSED`,
  `STOP_UNOBSERVED`, `OBSERVATION_CONFLICT`), submission codes (`SUBMISSION_UNKNOWN`, `SUBMITTED_PENDING`,
  `SUBMISSION_REQUIRED`, `SUBMIT_ACK_BINDING`, `SUBMIT_ACK_URL`, `SUBMIT_ACK_INVALID`), session locks
  (`SESSION_LOCK_HELD`, `SESSION_HELD`, `SESSION_LOCK_CHANGED`, `OWNER_EXIT_UNCONFIRMED`, `CONSUME_CONFLICT`,
  `CLOUD_RESULT_HELD`, `RESULT_CHANGED`), checks and loop lifecycle codes (`CHECKS_TIMEOUT`, `CHECKS_BINDING`,
  `CHECKS_SUMMARY`, `CHECKS_FAILED`, `PASS_WITH_FAILED_CHECKS`, `LOOP_LOCK_HELD`, `STALE_HANDLE`,
  `WORKTREE_CHANGED`, `LOOP_EXPIRED`, `LOOP_CLOSED`), and operation uncertainty codes derived when interrupted
  during an operation from operation names `prepare`/`materialize`/`checks`/`result`/`review`/`verdict`/`consume`/`finish`:
  `UNCERTAIN_PREPARE`, `UNCERTAIN_MATERIALIZE`, `UNCERTAIN_CHECKS`, `UNCERTAIN_RESULT`, `UNCERTAIN_REVIEW`,
  `UNCERTAIN_VERDICT`, `UNCERTAIN_CONSUME`, `UNCERTAIN_FINISH` (`attended-cloud-loop.mjs:82,92,98,128–184`).
  (Note: `PROVIDER_UNAVAILABLE` is a host-supplied code recognized and preserved by the runtime at
  `attended-cloud.mjs:265` and `attended-cloud-loop.mjs:85`, but the runtime never detects or emits it).
- **Attended Native / Grok:** Emits actual execution and protocol codes: `GROK_TIMEOUT`, `GROK_EXIT`,
  `GROK_TURN_REFUSED`, `GROK_PROPOSAL_INVALID`, `GROK_SPAWN`, `GROK_ADMISSION_UNCERTAIN`, `GROK_HOST_REFUSED`,
  `GROK_SESSION_MISMATCH`, `GROK_OUTPUT_LIMIT`, `GROK_PROTOCOL`, `GROK_SESSION`, `GROK_IO`, `GROK_PROMPT_CHANGED`,
  `GROK_ENVELOPE`, `GROK_CANCEL_UNCONFIRMED`, `GROK_CLOSE_UNCONFIRMED`, `GROK_PROVIDER_REFUSED`, `GROK_COMPLETE`
  (`attended-grok.mjs:132–193`).

Higher-level route handling uses the following **specified / proposed user-facing taxonomy**
to categorize and recover from provider failure modes:

### 1. `NATIVE_CONSENT_REQUIRED` (Specified vocabulary)
- **Condition:** The provider surface requires interactive terms of service, security notice,
  or data-use consent (e.g. Antigravity Remote Control first-use security dialog or
  interaction-sharing toggle).
- **Behavior:** The coordinator halts dispatch to that provider and marks the loop held.
  It must **never** simulate UI clicks, accept terms, or toggle privacy settings in the background.
- **Recovery:** The human operator opens the native provider interface, reviews the notice,
  and grants or declines consent interactively. Once confirmed, the operator restarts the loop.
  For unattended server environments, unattended execution must use a separately qualified
  headless CLI/SDK or queue relay; missing routes must refuse clearly.

### 2. `AUTHENTICATION_EXPIRED` (Specified vocabulary)
- **Condition:** Provider native credentials or session tokens have expired or become invalid.
- **Behavior:** The host refuses dispatch immediately. It must never search for or read
  secret-bearing files to bypass native authentication.
- **Recovery:** The operator executes the native provider login command in their own shell.
  The coordinator is then reinvoked.

### 3. `PROVIDER_UNAVAILABLE` (Host-supplied code recognized by runtime)
- **Condition:** The host observer encounters a transient failure (such as a network drop, HTTP 5xx response, or provider downtime during observation) and explicitly maps/throws `{code: 'PROVIDER_UNAVAILABLE'}`. The runtime does not inspect network errors or HTTP 5xx responses itself; attributing and mapping transient conditions to `PROVIDER_UNAVAILABLE` is strictly the host's responsibility.
- **Behavior:** Cloud observation preserves the host-supplied code `PROVIDER_UNAVAILABLE` in `observation-held.json` (`attended-cloud.mjs:265`); the runtime recognizes and keeps it, but never detects or emits `PROVIDER_UNAVAILABLE` on its own. It does not become `STOP_UNOBSERVED` (`STOP_UNOBSERVED` specifically rejects present non-final or non-idle observations, `attended-cloud.mjs:221`). The coordinator marks the project held with code `PROVIDER_UNAVAILABLE` (recognized as eligible for re-observation per `attended-cloud-loop.mjs:85`) and continues independent registered projects without deadlock. Any other thrown observer error is held under its own valid code (if matching `id()`, e.g. `ECONNRESET`) or as `OBSERVATION_REFUSED` (`attended-cloud.mjs:265`), neither of which is in the re-observe allow-list (`attended-cloud-loop.mjs:85`), so `canObserve` remains false and it is not re-observed automatically.
- **Recovery:** [PENDING G3 (real providers)] Bounded timed reconciliation automatically re-observes the held request on subsequent passes using `intervalMs` pacing without resubmitting the build only when the held code is in `['OBSERVATION_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'STOP_UNOBSERVED']`. Requests held under any other observer error code or `OBSERVATION_REFUSED` require operator intervention and are not re-observed automatically.

### 4. `DUPLICATE_COMPLETION` (Specified vocabulary, implemented in loop phase check)
- **Condition:** An external completion notification or event arrives for a request or phase
  that has already been observed or advanced.
- **Behavior:** The coordinator validates the event route `(tenantId, projectId, sessionId, requestId, inputSha, generation)`
  against persisted loop state. If the persisted phase has already advanced, the duplicate
  hint is safely discarded as an idempotent no-op.
- **Recovery:** No operator action required.

### 5. `MISSED_NOTIFICATION` (Specified vocabulary, implemented in durable state scan)
- **Condition:** An external webhook, event stream, or completion hint was dropped or delayed.
- **Behavior:** The coordinator does not rely exclusively on push hints. Each reconciliation
  pass scans registered durable loops for pending unobserved work.
- **Recovery:** Automatic reconciliation detects the completed cloud request and advances
  the loop phase without requiring an event re-delivery.

### 6. `UNCERTAIN_SUBMISSION` (Specified vocabulary, implemented via `SUBMISSION_UNKNOWN`)
- **Condition:** Connection failure, timeout, or coordinator crash occurs while transmitting
  a prompt or mutation before an authoritative receipt is saved.
- **Behavior:** If the cloud turn remains in `prepared` state when pending, loop status records
  `SUBMISSION_UNKNOWN`, or preserves the held code `c.code` (`attended-cloud-loop.mjs:86`).
  (Interrupted loop operations derive `UNCERTAIN_<OPERATION>`, e.g. `UNCERTAIN_PREPARE` or
  `UNCERTAIN_MATERIALIZE`; there is no `UNCERTAIN_SUBMIT` operation code). It retains operation
  and financial locks and refuses automatic resubmission.
- **Recovery:** The host must inspect the provider's native state to verify whether the
  task was received. If unreceived, the lock is cleared through an explicit reconciliation
  step; if received, the existing request identity is bound and observed.

### 7. `UNCONFIRMED_STOP` (Specified vocabulary, mapped to `stop: 'unknown'`)
- **Condition:** Host requests abort or terminates a local worker process, but the remote
  model provider has not confirmed termination of server-side inference or child tasks.
- **Behavior:** The record marks `stop: 'unknown'` and retains the project's financial
  hold. Local process termination (such as `child.kill()` or future Job Object kill) is
  recorded as local process stop, not remote provider cancellation.
- **Recovery:** The operator or reconciliation process checks provider billing and session
  status before releasing the financial reservation.

### 8. `UNSETTLED_COSTS` (Specified vocabulary, mapped to `financial: 'held'`)
- **Condition:** Task execution ended abruptly, or provider usage metrics have not been
  reported by the remote API.
- **Behavior:** The coordinator retains financial budget reservations (`financial: 'held'`) for the session.
- **Recovery:** Budget is settled only after final billing receipts or usage logs are retrieved.

## Attended vs unattended execution and onboarding

Antigravity Remote Control and similar browser or desktop transports require interactive
one-time human onboarding. The operator must personally configure device authorization,
review data sharing choices, and accept security boundaries.

Automated pipelines must respect these boundaries:
- **No Private Data in Defaults:** Never commit developer usernames, machine hostnames,
  local Windows filesystem paths, or active conversation IDs to public repository documentation
  or package templates. Use generic placeholders like `<project-root>`, `<session-id>`,
  or `<tenant-id>`.
- **Unattended Environments:** In headless CI or daemon environments where interactive UI
  consent cannot be provided, providers requiring attended UI interaction must refuse
  cleanly with a consent-required error. They must not attempt background UI automation
  or headless workarounds unless a separately qualified CLI, Python SDK, or queue relay
  is officially supported and installed.


