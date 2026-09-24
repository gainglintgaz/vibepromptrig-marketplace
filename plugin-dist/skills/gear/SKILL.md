---
name: gear
description: Advises which Claude model + reasoning effort fits a task, scored against gear-shift.md's plan/build/test lanes and model-router.json's live task categories + hard caps. Read-only -- outputs the exact /model command, optional /fast, and think-keyword to type. Never switches the model itself.
allowed-tools:
  - Read
  - Bash(node scripts/log-gear-reco.mjs *)
arguments:
  - name: task_description
    description: "Free-text description of the task you're about to do (e.g. 'refactor the auth module', 'write a migration for the orders table', 'security audit the webhook handler')."
    required: false
---

# /gear -- the gear-shifter advisor

A thin, read-only lookup over `docs/rules-reference/factory/gear-shift.md` (the decision table) and
`.claude/model-router.json` (the live price/category source of truth). It tells you which
seat to drive for the task in front of you. It does **not** run `/model`, does **not**
dispatch an agent, and does **not** touch any file -- the user's keystroke is the only thing
that actually changes the seat.

**Arg:** `$ARGUMENTS` -- the task description. If empty, ask: "What are you about to do?
(one sentence is enough)" and wait for the answer before proceeding.

## Step 1 -- Read the live sources (every invocation, never from memory)

Resolve each source under `${CLAUDE_PLUGIN_ROOT}` first (installed plugin -- the build packages
exactly these two files), then the factory root (dogfood case). Never read them from the current
project; an adopted project does not carry them.

1. Read `${CLAUDE_PLUGIN_ROOT}/docs/rules-reference/factory/gear-shift.md` (factory:
   `docs/rules-reference/factory/gear-shift.md`) in full -- it is short and is the decision table.
2. Read `${CLAUDE_PLUGIN_ROOT}/.claude/model-router.json` (factory: `.claude/model-router.json`)
   -- specifically `models`, `task_categories`, and `hard_caps`. **Never quote a price or model id from memory or from this skill file --
   always re-read the JSON**, since tech-radar refreshes it and a stale price recommendation
   is worse than none.

If either file is missing, say so and stop -- do not guess at the gear-shift table.

## Step 2 -- Classify the task

Answer the two questions from gear-shift.md's "two-question shift" for the task in
`$ARGUMENTS`:

1. **Mechanical or judgment?** Rename / reformat / grep / boilerplate / apply an already-
   established pattern = mechanical. Anything requiring a real design or correctness call =
   judgment.
2. **Cost of being wrong?** High = touches money, architecture, security, an ambiguous spec,
   or a decision many files/people depend on. Low = easily reverted, narrow blast radius.

Then place the task in one lane from gear-shift.md's phase table:

| Lane | Signals in the task description |
|---|---|
| **Plan** (architect / probe / design / think) | "design", "architecture", "should we", "plan", "how should this work", new entity/feature/table, ambiguous spec |
| **Build** (work / code / implement) | "implement", "add", "fix this one thing", "write the function/component", a scoped code change with a known shape |
| **Test/Security** (audit / bugs / fix / security / safety) | "test", "audit", "security review", "why is this broken", "find the bug", "is this safe" |

If the task genuinely spans lanes (e.g. "design and build X"), split it into phases and give
one recommendation per phase -- do not average into a single mushy answer (per VIBE Rule 59,
surface the distinction rather than blur it).

## Step 3 -- Map to a recommendation

Use gear-shift.md's table for the identified lane, then adjust within that lane using the
Step 2 answers -- the reflex is **the lowest gear that can do the job**:

- Lane **Plan**: cheaper end is Sonnet-medium; go-to is **Opus-high** (`think hard`);
  escalate to Opus-max (`ultrathink`) only if the task is genuinely the hardest/most
  ambiguous thing in front of the user today, or to Fable (see Step 4) if it stalls there.
- Lane **Build**: cheaper end is Haiku-low; go-to is **Sonnet-medium**; escalate to
  Opus-medium (`/fast`) for gnarly/novel work, Opus-high only if it keeps fighting back.
- Lane **Test/Security**: cheaper end is Sonnet-medium; go-to is **Opus-high**
  (`think hard`); escalate to Fable-xhigh only for a genuinely deep forensic / whole-system
  security pass.

Effort is independent of model -- do not default to high effort just because the model is
expensive, and do not skip effort just because the model is cheap. A mechanical rename on
Opus should still run at low/plain effort; a genuinely hard judgment call on Sonnet may
still warrant `think hard`.

If Step 2 says **mechanical + low cost-of-wrong**, pull the recommendation down a gear from
the lane's "go-to" regardless of lane (e.g. a mechanical Plan-lane task like "list the files
that would need to change" doesn't need Opus-high). If Step 2 says **judgment + high
cost-of-wrong**, do not recommend below the lane's go-to gear even if the task sounds small.

## Step 4 -- Fable 5 check (rare)

Only surface Fable 5 as the recommendation if the task is genuinely the biggest or hardest
thing in front of the user right now (whole-codebase synthesis, a problem that touches the
entire app at once, a full top-to-bottom rebuild/audit) -- per gear-shift.md, Fable's whole
point is size and depth, and it is dispatched as a subagent / via the router's `deep_program`
category, not a `/model` seat toggle. If you recommend it, read the current
`hard_caps.per_task_usd` from model-router.json and mention it plainly, e.g. "a full-context
Fable call costs roughly $X per the live router config -- that's within/near the $Y per-task
cap."

## Step 5 -- Delegation check (optional second recommendation)

If the task looks like something that should be handed to a subagent rather than run in the
live seat -- bulk/parallel/mechanical work, or a cross-provider job (vision/OCR, X data,
cited research) -- name which `model-router.json` `task_categories` entry fits
(`code_build`, `architecture`, `quick_edit`, `data_qa`, `agent_dispatch`, `vision_ocr`,
`x_data`, `research`, `research_cited`, `marketing_copy`, `deep_program`) and report the
`preferred` model that category resolves to **today**, read live from the JSON. This is a
second, optional line -- the primary answer is always the seat recommendation from Step 3.
There is no dedicated audit/security-review category today -- for a Test/Security-lane task
that doesn't cleanly map to one of the 11, say "N/A" plainly rather than forcing a fit.

## Step 6 -- Output

Keep it short. Structure:

```
Task: <one-line restatement of $ARGUMENTS>
Lane: Plan | Build | Test/Security  (+ note if split into phases)
Mechanical or judgment: <answer>          Cost of being wrong: <answer>

Recommended seat: <Model> - <effort word: plain|think|think hard|think harder|ultrathink>
Commands to type:
  /model <haiku|sonnet|opus>
  <think hard | ultrathink | ... -- omit if plain>
  (optional) /fast -- if the recommendation is Opus-medium in the Build lane

Delegate instead? <task_category> -> <model, read live from model-router.json> (only if Step 5 applies)

Why: <one sentence tying the lane + Step 2 answers to the pick>
```

## Step 7 -- Log the recommendation (telemetry -- audit 3.5)

After presenting the recommendation, log it so "is gear advice followed / did it save money?"
becomes answerable (it used to be zero-telemetry). Run exactly this one command -- the ONLY write
this skill performs -- filling in the values you just recommended:

```
node scripts/log-gear-reco.mjs --lane=<plan|build|test> --model=<haiku|sonnet|opus|fable> --effort=<low|medium|high|xhigh|max> [--category=<router_category>] [--fast] --task="<the task in <=120 chars>"
```

It appends one `{event:"gear_reco"}` line to `factory_metrics.jsonl`. The statusline
(`statusline-gear.mjs`) separately samples the ACTUAL model/effort on change (`gear_actual`), and
the outcome-tracker joins the two monthly -> follow-rate + cost delta -> evidence to tune
gear-shift.md's lane defaults. If the command fails (e.g. node absent), skip it silently -- never
let telemetry block or delay the advice.

## Rules

- **Advisory only** (one exception: the Step 7 telemetry line). Never call `/model`, never
  dispatch an Agent/Workflow, never edit a *deliverable* file. The single `node
  scripts/log-gear-reco.mjs` call in Step 7 is observability, not a deliverable edit -- the
  advisory output and the user's environment stay untouched otherwise.
- **Never hardcode a price or model id in your reasoning** -- always re-read
  `model-router.json` this invocation; it is refreshed by the tech-radar agent and a stale
  number is a worse answer than "let me check."
- If `$ARGUMENTS` is missing or too vague to classify (e.g. "help"), ask one clarifying
  question rather than guessing a lane.
- Fable 5 is a subagent dispatch, never a `/model` recommendation -- say so explicitly if it
  comes up, per gear-shift.md's own "not a seat toggle" note.
- This is a lookup, not a report -- resist the urge to explain gear-shift.md's whole
  philosophy back to the user every time. One short block per Step 6 is the deliverable.
