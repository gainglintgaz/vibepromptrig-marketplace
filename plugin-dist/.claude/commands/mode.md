---
description: One-word operating mode -- lean | balanced | max -- over the existing profile system. Flips the rules/agents/budget bundle in a single move (the "how heavy is my system" dial). No arg = show current mode + the 3-dial explainer.
argument-hint: [lean | balanced | max]
allowed-tools: Bash(powershell *)
---

# /mode -- the operating-mode dial (lean | balanced | max)

A one-word shortcut over the existing profile system. It REUSES `forge profile set` (do not
reimplement profile switching) -- so it really swaps the tier-filtered rule set (`AGENTS-<x>.md`
-> `AGENTS.md`), the enabled agents, and the token budgets. This is the PERSISTENT "how heavy is
my system" dial -- it stays until you change it.

**Arg:** $ARGUMENTS

## Mode -> profile map (data-driven; edit this table, not the profile internals)

| `/mode <x>` | Profile preset | What you feel | Budgets (session / monthly) |
|---|---|---|---|
| `lean`     | `indie-free` | "Don't burn credits / don't hit limits every hour." Essential rules only, minimal agents, smallest budget, aggressive compaction. | ~50K / ~500K tokens |
| `balanced` | `solo-pro`   | The middle. Standard rules, a couple of agents, moderate budget. | ~150K / ~3M tokens |
| `max`      | `senior-dev` | Full rules, all agents, biggest budget. Tolerate the burn for maximum capability. | ~300K / ~9M tokens |

## What to do

1. **Parse the arg.** Normalize to lower-case. Accept `lean`/`balanced`/`max`. If the arg is empty,
   go to "No arg" below. If it's anything else (typo / unknown), DO NOT guess -- print the table
   above + "Unknown mode '<arg>'. Pick lean, balanced, or max." and stop.

2. **Switch (only for a valid mode).** Map the mode to its preset and run, via Bash:
   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/forge.ps1 profile set <preset>`
   (lean->indie-free, balanced->solo-pro, max->senior-dev).

3. **Prove it applied (the golden habit -- never claim without showing).** Then run:
   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/forge.ps1 profile show --terse`
   and show the output. Confirm in plain English, e.g. for lean:
   "Switched to **lean** mode (profile indie-free): essential rules only, minimal agents,
   ~50K session budget. This burns the least and is least likely to hit limits. It's persistent
   until you run /mode again." Adjust the numbers/wording per the mode actually set.

4. **No arg -- show current mode + the 3 dials.** Read the current profile:
   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/forge.ps1 profile get profile`
   Map the profile back to a mode name (indie-free=lean, solo-pro=balanced, senior-dev=max; any
   other profile = "custom"). Then print:

   ```
   Current mode: <lean|balanced|max|custom> (profile <name>)

   The 3 independent dials (combine them per task):
     1. Mode / profile (PERSISTENT)  -- /mode lean|balanced|max  -- how heavy is my system
                                         (which rules/agents load + the token budget).
     2. Effort (PER TASK)            -- /effort low|medium|high|ultra -- how hard it thinks on
                                         THIS task + whether dynamic workflows fire.
     3. Autonomy (PER TASK)          -- plan mode / accept-edits / auto -- how much it does
                                         before asking you.

   Change mode:   /mode lean | /mode balanced | /mode max
   Fine-tune:     forge config set <field> <value>  (11 individual knobs)
   Full guide:    docs/rules-reference/factory/gear-shift.md  "Operating modes and gear selection"
   ```

## Rules
- REUSE `forge profile set` -- never reimplement the preset copy or the AGENTS-swap (VIBE Rule 16).
- The mode is PERSISTENT (stored in `.forge/profile.json`); say so, so the user isn't surprised.
- ASCII only. Relay the script output as-is. No new entity / money / AI call.
