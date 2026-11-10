# Workforce quickstart: one bounded build-review-repair loop

This guide runs one finite loop on a disposable project: your existing Claude
Code cloud session proposes the change, your signed-in Codex CLI reviews it, your
own checks gate each candidate, and review feedback drives up to two repairs.
You use only the commands below; no source editing, no relaying review or
repair messages between chats.

It does not install anything, create a schedule or service, enroll a real
project, read credential files, or fall back to another provider. Every run is
started by you, bounded by limits you pass, and ends on its own.

## 1. Check the host

The loop is supported only on this exact route. Anything else is refused.

| Requirement | How to check |
| --- | --- |
| Windows 10 or 11 (native process fences) | `[Environment]::OSVersion` |
| Node.js 24 or newer | `node --version` |
| Git for Windows at `C:\Program Files\Git` | `Test-Path 'C:\Program Files\Git\cmd\git.exe'` |
| .NET Framework compiler (builds the process-fence helper) | `Test-Path "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"` |
| Claude Code CLI signed in, with the `--cloud` option | `claude auth status` shows `"loggedIn": true`; `claude --help` lists `--cloud` |
| Codex CLI signed in | `codex login status` shows `Logged in` |
| An existing Claude cloud session, Idle | see "Prepare the cloud session" below |

Sign in through each CLI's own login screen. This entry point only runs those
two status commands. If `claude --help` does not list `--cloud`, update Claude
Code first: the loop sends each prompt with `claude -p ... --cloud <session>`.

### Prepare the cloud session

The builder is a Claude Code cloud session that already exists; `create` does not
make one. Do this once per project, before `create`:

1. Open [claude.ai/code](https://claude.ai/code), signed in to the same account
   that `claude auth status` reports, and start a session. Any repository and
   environment you are offered will do: the loop puts the brief, acceptance and
   source inside its prompt and tells the session that its own checkout is
   unrelated. If it asks for a first message, a short one such as `ready` is fine.
2. Copy the session ID: the `session_...` part of the page address. For example,
   `https://claude.ai/code/session_ABC123` gives `session_ABC123`. Use a
   different session for each project; `create` refuses one that is already
   registered.
3. Check that the session page opens and that the session is Idle (it has
   finished replying). Do not use that session for anything else while its loop
   runs: the receipt in step 5 must be the loop's own reply.

`create` checks the ID's format, not whether the session exists, so step 3 is the
only readiness check.

The ordinary plugin hooks need only Node.js 18. Node.js 24 is required only for
this optional workforce route.

All commands below are PowerShell. Set two variables first. To find the installed
plugin folder for `$Vpr`, follow [INSTALL's folder lookup instructions](../../INSTALL.md#initialize-forge-project-state-optional).

```powershell
# Folder that contains scripts\forge\workforce-entry.mjs: your VibePromptRig
# checkout, or the installed plugin folder that ships the same scripts.
$Vpr   = 'C:\path\to\vibepromptrig'
# Your private host state. Keep it outside every project folder.
$State = "$env:LOCALAPPDATA\vpr-workforce\state"
Test-Path "$Vpr\scripts\forge\workforce-entry.mjs"   # must print True
```

## 2. Prepare a disposable project

Use a throwaway folder, never a real project. Layout:

```text
my-disposable\
  brief.md          what to build (the entry adds a fixed reply-format note)
  acceptance.md     how the result is judged
  src\              1 to 3 flat files, each at most 4096 bytes; the only files the loop may change
  checks\           1 to 5 *.test.mjs files: your own tests, run against each candidate
```

Example:

```powershell
$Project = "$env:USERPROFILE\vpr-disposable\report"
New-Item -ItemType Directory -Force "$Project\src","$Project\checks" | Out-Null
Set-Content "$Project\brief.md" 'Make the exported report equal 2.'
Set-Content "$Project\acceptance.md" 'AC1: src/report.mjs exports const report equal to 2.'
Set-Content "$Project\src\report.mjs" 'export const report = 0;'
@'
import test from 'node:test';
import assert from 'node:assert/strict';
import {report} from '../src/report.mjs';
test('report is 2', () => assert.equal(report, 2));
'@ | Set-Content "$Project\checks\report.test.mjs"
```

Checks import the candidate through `../src/...`. They run with Node's
permission model, which allows only file reads and blocks child processes. That
is not a network sandbox, so keep the project disposable. The brief,
acceptance and source together must fit the 8192-byte cloud prompt; larger
inputs are refused before anything starts.

## 3. Create the loop

`create` usually takes one to two minutes with no output while it checks sign-ins
and builds the process-fence helper. That is normal. On a very busy PC it can take
up to about 10 minutes before it answers (see below).

```powershell
node "$Vpr\scripts\forge\workforce-entry.mjs" create `
  --state $State --project $Project `
  --tenant my-tenant --project-id report `
  --builder claude-cloud --builder-session session_XXXXXXXX `
  --reviewer codex `
  --consent bounded-provider-use
```

`create` contacts no model and prints one JSON object when it finishes. It first
runs the two sign-in status commands and waits up to 5 minutes for each, because a
busy PC can take minutes to answer them. It then copies `src\` into a fresh Git
worktree under `%TEMP%\vpr-s7-attended-*`, freezes your `checks\`, and saves a
registration under `$State\registrations\`. Your project folder is only read.
The output gives the loop `root`, `worktree`, `observationInbox` and
`expiresBy`.

Each loop checks a 25-minute lifetime before starting operations, across all
generations. Once that lifetime expires, new operations are refused; this does
not guarantee that an operation already started, the local process, or a
submitted cloud turn has ended. Run it soon. To register another project, repeat
`create` with a different project folder, project ID and Claude cloud session.

`--consent bounded-provider-use` must be typed on every `create` and `run`. A
consent value in a file, an environment variable or a registration is ignored.

## 4. Run it

```powershell
$Expires = (Get-Date).ToUniversalTime().AddMinutes(20).ToString('o')
node "$Vpr\scripts\forge\workforce-entry.mjs" run `
  --state $State --consent bounded-provider-use `
  --max-actions 24 --max-passes 64 --interval-ms 5000 --expires-at $Expires
```

All three limits are required: at most `--max-actions` loop operations per
pass, at most `--max-passes` passes, and a stop at `--expires-at` (no more than
25 minutes away). That stop is a timer checked between passes: a pass already
running finishes its operations, and on a busy PC a late timer can let one more
pass start shortly after that time. Separately, the loop checks its 25-minute
lifetime before starting operations and refuses new operations once it expires.
This is not a guaranteed termination time for work already started.
`--interval-ms` (10 to 30000,
default 5000) is the wait between passes. `run` repeats the two sign-in checks
before its first pass; on a busy PC they use part of the time before `--expires-at`. If that
time runs out during the checks, `run` reports `state: stopped` (by `expiry`)
and starts no pass; set a new `--expires-at` and run again.

`run` keeps this PowerShell window busy until it stops; call it terminal A and
leave it running. The first pass submits the build prompt to your Claude cloud
session. Do step 5 in a second PowerShell window, terminal B.

## 5. Record the cloud result

The package has no supported way to read a Claude cloud reply back, so you
provide the observation. Open the session at `https://claude.ai/code/<session>`.
When the reply has finished and the session is Idle, copy the JSON reply and
save it as a receipt while `run` is still active in terminal A.

Run these commands in terminal B. Variables do not carry over between windows,
so set `$State` there to the same value you used in terminal A. The receipt goes
in the `observationInbox` folder that `create` printed: `$State\observations\`
followed by your `--tenant` and `--project-id` joined by a dot (`my-tenant.report`
in this example).

```powershell
$State = "$env:LOCALAPPDATA\vpr-workforce\state"     # same value as in terminal A
$reply = Get-Clipboard -Raw | ConvertFrom-Json        # the exact JSON reply
$receipt = [ordered]@{
  sessionId = $reply.sessionId; requestId = $reply.requestId; inputSha = $reply.inputSha
  files = @($reply.files); final = $true; idle = $true
  observedAt = (Get-Date).ToUniversalTime().ToString('o')
}
$receipt | ConvertTo-Json -Depth 6 |
  Set-Content -Encoding utf8 "$State\observations\my-tenant.report\$($reply.requestId).json"
```

Set `final` and `idle` only after you have seen both. The next pass reads the
receipt and checks that its session, request and input match the saved request.
It also requires `observedAt` to be under 55 seconds old. An older receipt
leaves the project waiting (`observer: RECEIPT_STALE`); save a fresh one. Fields
other than those seven are ignored.

The loop then commits the candidate in its own worktree and runs your checks.
It asks Codex for an independent review. On `CHANGES_REQUESTED`, the review is
sent back to Claude as the repair brief, with no relay from you, and you record
the next reply the same way. The loop stops at PASS, BLOCKED or the third
generation.

If you run your own browser automation, it can write the same receipt. The
receipt route is the observation boundary; a missing receipt is never invented.

## 6. Read the results

`run` prints a JSON report and saves a copy under `$State\runs\`. The top-level
`state` is one of:

| State | Meaning |
| --- | --- |
| `terminal` | Every project finished. Read each verdict: a finished BLOCKED is not PASS. |
| `bounded` | Pass limit reached. Run again (fresh `--expires-at`) to continue the same saved work. |
| `held` | No safe progress. Read each project's `code`; do not delete locks or invent evidence. |
| `stopped` | You or `--expires-at` stopped it. See step 7. |

For each project, read `phase`, `code`, `verdict`, and `checks`
(`passed`, `evidenceRef`, `summary`). `history` holds one entry per generation
with its candidate commit, verdict and checks. Full check output is in
`$State\checks\<tenant>.<project>\<evidenceRef>.json`. Review evidence is under
the loop `root` in `cloud-loop\reviews\`. `financial` is always `held`: the
entry does not measure or settle provider charges.

Common project codes:

| Code | Meaning |
| --- | --- |
| `PROVIDER_UNAVAILABLE` with `observer: RECEIPT_MISSING` / `RECEIPT_STALE` / `RECEIPT_UNREADABLE` | Waiting for a fresh, readable receipt (step 5). |
| `STOP_UNOBSERVED` | The receipt did not say both final and Idle. Still observable. |
| `OBSERVATION_BINDING`, `OBSERVATION_STALE`, `PROPOSAL_REFUSED`, `OBSERVATION_CONFLICT` | A receipt was refused for good: wrong IDs, outside the time window, files outside `src\` scope, or a conflicting second result. Held. |
| `CHECKS_FAILED` | Your checks failed. Review still runs; its verdict decides repair. |
| `PASS_WITH_FAILED_CHECKS` | Codex said PASS but your checks failed. Held, never accepted. |
| `REPAIR_LIMIT` | Still CHANGES_REQUESTED after three generations. |
| `CLOUD_PROMPT_LIMIT` | Source plus feedback no longer fits the cloud prompt. Held. |
| `HOST_ADMISSION_FAILED` | The host refused or timed out admitting the build just before submit (`launchAttempted: false`). No model was contacted and nothing was charged. Held for good; start again as in "After a permanent hold" below. |
| `LOOP_EXPIRED` | The 25-minute lifetime ended. Held for good; start again as in "After a permanent hold" below. |
| `UNCERTAIN_PREPARE`, `UNCERTAIN_MATERIALIZE`, `UNCERTAIN_CHECKS`, `UNCERTAIN_RESULT`, `UNCERTAIN_REVIEW`, `UNCERTAIN_VERDICT`, `UNCERTAIN_CONSUME`, `UNCERTAIN_FINISH` | That operation was interrupted. Held and never replayed. |
| `SUBMISSION_UNKNOWN` | A submit started but its outcome was not recorded. Never resent. |
| `LOOP_LOCK_HELD`, `SESSION_LOCK_HELD` | A killed process left its lock. Do not delete it. |
| `LOOP_BINDING`, `PROJECT_CHANGED` | The saved loop does not match this registration or mode. Held. |

To read the saved state, run
`node "$Vpr\scripts\forge\workforce-entry.mjs" status --state $State`.
It does not submit, observe, run checks or advance any loop, but it briefly
reopens each loop (the same local drive checks and process-fence helper that
`run` uses). On a heavily loaded PC, `status` can therefore itself report a
project as `held` with a code such as `UNSAFE_ROOT` or `UNKNOWN`. That result is
not saved into the loop; run `status` again when the PC is quieter.

## 7. Stop, and what stop means

Press Ctrl+C once to request a stop before the next pass. The current pass can
continue, including starting additional operations or provider requests.
Individual operation timeouts are not a maximum time to stop the run. Windows
also delivers Ctrl+C to any `claude` or `codex` process the run started in the
same console window, so a submit or review can end early and be held without
retry. Later operations in the same pass can still start their own processes.
If the run returns `state: stopped`, the report shows:

```json
"stop": {"by": "operator", "localProcess": "stopped between passes",
         "remoteCancellation": "not requested", "remoteCancellationConfirmed": false}
```

`by` is `expiry` when `--expires-at` stopped it. In both cases only the local
coordinator stopped. **The entry point never requests or confirms remote
cancellation.** A Claude cloud turn already submitted keeps running in the
cloud. Stop it yourself in claude.ai/code if you need to. Usage and charges are
not settled.

A second Ctrl+C ends the process at once. The interrupted operation is then
held as `UNCERTAIN_*` or `LOOP_LOCK_HELD`, and a `claude` or `codex` child
process can outlive it. Check Task Manager. Closing the window is the same as a
second Ctrl+C.

## 8. Recover after a restart

Run the same `run` command again with a new `--expires-at`. The coordinator
reopens every registered loop from its saved checkpoints:

- A build that was already submitted is observed again and **never resent**.
  Save a fresh receipt for the same `requestId`.
- A finished project is not run again, and repeated runs do not repeat reviews.
- An interrupted operation stays held (`UNCERTAIN_*`, `SUBMISSION_UNKNOWN`,
  lock codes). The entry has no override; it never releases a lock or a charge
  it cannot prove belongs to that loop.
- One held project does not stop another registered project from advancing.

### After a permanent hold

First tell a temporary hold from a permanent one.

- **Temporary (keep the same state):** the loop could not be reopened for this
  one `run` or `status`, and nothing was saved into it. The project's `code` or
  `error` is a setup code such as `UNSAFE_STATE_PATH`, `UNSAFE_ROOT`, `UNKNOWN`,
  `PROJECT_OPERATION_HELD` or `PROJECT_STATUS_HELD`. Wait until the PC
  is quieter and run the same command again with the same `--state`. The next
  invocation reopens the loop from its saved checkpoints and continues it. Do
  not start a new state folder for this; that would abandon a resumable request.
- **Permanent (needs a new state):** the project can never advance in this
  state. This comes in two kinds:
  - *Recorded holds.* The loop or its cloud request wrote the outcome to disk:
    `HOST_ADMISSION_FAILED`, `SUBMISSION_UNKNOWN`, `UNCERTAIN_*`, the
    refused-receipt codes, `PASS_WITH_FAILED_CHECKS` and `CLOUD_PROMPT_LIMIT`.
    A finished project, including one ending in `REPAIR_LIMIT`, also does not
    run again.
  - *Refusals that are not recorded.* `LOOP_EXPIRED`, `LOOP_LOCK_HELD`,
    `SESSION_LOCK_HELD`, `LOOP_BINDING` and `PROJECT_CHANGED` are raised when
    a command reopens or acts on the loop. They are not written into the loop,
    so `status` may not show the expiry or lock refusals. For example, an
    expired loop can still read as its last saved phase with no code, and
    `status` does not check for a leftover lock. Treat the project's `code` or
    `error` in the latest `run` report as the answer. The reported `expiresBy`
    is only an estimate; a `LOOP_EXPIRED` refusal is the real proof that a
    loop's lifetime has ended.

The waiting codes (`PROVIDER_UNAVAILABLE`, `STOP_UNOBSERVED`,
`OBSERVATION_TIMEOUT`) are neither: save a fresh receipt (step 5).

For a permanent hold there is no command to retire or reset a registration,
and `create` in the same `--state` refuses
`PROJECT_OVERLAP` for any project folder, project ID or Claude cloud session
already registered there, held or not.

To try the same project again, use a new state folder:

1. If the hold came after a submit (`SUBMISSION_UNKNOWN`, `UNCERTAIN_*`, lock
   codes), open the session in claude.ai/code and wait until it is Idle, or stop
   the turn there. After `HOST_ADMISSION_FAILED` nothing was sent.
2. Leave the old state folder as it is. Do not delete or edit it; it is the
   record of what happened.
3. Create and run with a new folder:

```powershell
$State = "$env:LOCALAPPDATA\vpr-workforce\state-2"
node "$Vpr\scripts\forge\workforce-entry.mjs" create `
  --state $State --project $Project `
  --tenant my-tenant --project-id report `
  --builder claude-cloud --builder-session session_XXXXXXXX `
  --reviewer codex `
  --consent bounded-provider-use
```

Then continue from step 4 with the new `$State`. Each `create` makes a new loop
folder, so nothing from the held loop, including its locks, carries over.

## Refusals

These are reported as `{"ok": false, "refused": "<CODE>"}` with exit code 2,
before any model is contacted:

| Code | Cause |
| --- | --- |
| `NODE_24_REQUIRED` | Node.js below 24. |
| `WINDOWS_REQUIRED` | Not Windows. The workforce route has no other host yet. |
| `PROVIDER_UNSUPPORTED` | `--builder` other than `claude-cloud` or `--reviewer` other than `codex`. Grok, Cursor, Antigravity and others are not substituted. |
| `PROVIDER_COMMAND_UNAVAILABLE` | `claude` or `codex` is not on `PATH`. |
| `PROVIDER_NOT_SIGNED_IN` | `claude auth status` or `codex login status` does not report a signed-in account, or did not answer within 5 minutes. Run both commands yourself; if they show you signed in, run the same `create` again when the PC is quieter. |
| `CONSENT_REQUIRED` | `--consent bounded-provider-use` missing or different. |
| `SESSION_UNBOUND` | `--builder-session` missing or not a `session_...` ID. |
| `PROJECT_OVERLAP` | The project folder overlaps another registered project or the state folder, or reuses a registered tenant/project key (case-insensitive) or cloud session. |
| `PROJECT_LAYOUT`, `PROJECT_CHECKS_REQUIRED` | `src\` or `checks\` does not match step 2. |
| `LIMITS_REQUIRED`, `LIMITS_INVALID`, `EXPIRY_INVALID` | A run limit is missing, out of range, or the expiry is past or more than 25 minutes away. |
| `NO_REGISTERED_PROJECTS` | Nothing has been created in `--state`. |
| `COORDINATOR_SCOPE` | Creation would exceed the coordinator's 16-project limit, or `--max-actions` is smaller than the number of registered projects. |
| `UNSAFE_STATE_PATH`, `UNSAFE_ROOT`, `UNKNOWN` | Setup could not confirm a folder is on a local drive (a drive check that times out on a busy PC is retried once before refusing) or could not start the process-fence helper. From `create`, nothing was registered; run the same `create` again, ideally when the PC is quieter. |
| `COMMAND_REQUIRED`, `ARGUMENT_REFUSED`, `PATH_REQUIRED`, `PROJECT_NOT_FOUND`, `STATE_NOT_FOUND`, `PROJECT_BINDING` | Unknown command or flag, a repeated flag, a missing folder, or a tenant/project ID that is not 1 to 64 letters, digits, `_` or `-`, or is a reserved Windows device name. |

One setup failure has no public code. When the broker's own drive check on its
loop folders fails (internally `UNSAFE_FIXTURE_ROOT`, for the same busy-PC
reason), the entry receives an error without a code. `create` then prints
`{"ok": false, "refused": "ENTRY_FAILED"}` and exits with code 1, not 2. Treat
it like the row above: nothing was registered, so run the same `create` again
when the PC is quieter. During `run` or `status` the same failure shows as the
temporary project code `PROJECT_OPERATION_HELD` or `PROJECT_STATUS_HELD` (see
"After a permanent hold").

## What is and is not proven

The automated test drives the real loop, broker, coordinator and this entry's
callbacks with simulated Claude and Codex transports. Simulated transport is
accepted only from test code. A loop created that way is refused by the public
command (`LOOP_BINDING`). A real-provider run of this entry point is a separate
acceptance step that has not been performed yet. Provider turn cancellation,
financial settlement, and hosts other than Windows remain unproven.
