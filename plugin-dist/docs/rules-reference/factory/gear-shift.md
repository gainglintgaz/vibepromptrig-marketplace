---
tier: essential
required: true
profiles: [indie-free, solo-pro, senior-dev, agency, enterprise]
enforcement_tier: 2
load_bearing: true
enforcement_ref: ".claude/lib/router/src/budget.ts checkAndReserve (per-task USD cap ONLY; the per-session cap declared in .claude/model-router.json hard_caps is NOT yet enforced) + auto-route protocol (this file)"
---

# gear-shift.md -- The Gear Shifter (per-task model + effort routing)

> **Authority:** Auto-loaded global rule. Applies to every VibePromptRig session.
> **Created:** 2026-07-05. **Last refreshed:** 2026-07-08 (Fable-5 first-class seat + alias set +
> effort tier names + ultracode mode; de-hardcoded prices; corrected per-session-cap enforcement claim).
> **Purpose:** Stop burning tokens/credits by matching the MODEL and the EFFORT to the
> task in front of you. This is the live-seat companion to `model-router.json` (which
> routes programmatic/subagent API calls): this rule routes the seat you drive AND tells
> the main session when to delegate.
> **enforcement_tier:** 2 (process / behavioral). No new mechanical gate; the backstop is
> the router's hard **per-task** USD cap (`checkAndReserve` in `.claude/lib/router/src/budget.ts`,
> which refuses a call whose estimate exceeds the cap BEFORE dispatch) plus the auto-route
> protocol below. The **per-session** cap in `model-router.json` `hard_caps` is declared but
> NOT yet enforced (route() has no session identity -- tracked follow-up), so treat it as a
> ceiling you watch by hand, not one the code stops for you.
> **Price source of truth:** `.claude/model-router.json` (never hardcode prices here; that
> file is refreshed by the tech-radar agent). This file holds the DECISION, not the numbers.

---

## The two-question shift (keep this in your head)

1. **Mechanical or judgment?** Mechanical (rename, format, grep, boilerplate, apply a known
   pattern) -> Haiku, low effort. Real judgment -> Sonnet and up.
2. **What is the cost of being wrong?** High (money, architecture, security, ambiguous spec,
   a decision many files depend on) -> Opus, high+ effort. Low -> stay cheap.

**Reflex:** default to the LOWEST gear that can do the job. If it fails twice, upshift --
do not grind (the 3-prompt-revert rule, applied to gears).
**Effort != model:** you can run Opus at low effort. Match effort to how much THINKING the
task needs, separately from which model. High effort on a trivial edit is the #1 silent waste.

---

## Use each model when

- **Haiku** -- quick, simple jobs you want done fast and cheap. Cheapest tier.
- **Sonnet** -- your everyday driver for writing and editing real code.
- **Opus** -- a hard call that's expensive to get wrong.
- **Fable 5** -- the biggest, longest, or hardest job you've got. Priciest tier.

> **Prices live in `model-router.json`, not here** (per the header rule -- tech-radar refreshes
> the live $/Mtok in its `models` block). Relative order, cheap -> dear: **Haiku < Sonnet < Opus
> < Fable 5.** When you need the actual number for a budget call, read `.claude/model-router.json`;
> never quote a price from memory or from this file.

## The gears, by workflow phase

| Phase | Cheaper | Go-to (start here) | Escalate |
|---|---|---|---|
| Plan / architect / probe / design / think | Sonnet - medium | **Opus - high** (`think hard`) | Opus - max (`ultrathink`); -> Fable if it stalls |
| Work / code / build | Haiku - low | **Sonnet - medium** | Opus - medium (`/fast`); -> high if gnarly / novel |
| Test / audit / bugs / fix / security / safety | Sonnet - medium | **Opus - high** (`think hard`) | Fable - xhigh (deep forensic / whole-system security audit) |

Plan and Security are the only two lanes where max effort (`ultrathink`) earns its price.
In the Build lane, keep effort low unless the logic gets hairy -- over-thinking routine
code is the biggest silent token drain.

---

## Fable 5, effort by effort

1M context - frontier tier - **reserve for the genuinely biggest/hardest work.** As of the
2026-07-08 refresh, Fable 5 is a **first-class seat** (`/model fable`) AND a subagent-dispatch
target (router category `deep_program`) -- it is no longer subagent-only. A single full-context
call is the most expensive thing you can run and approaches the `per_task_usd` cap in
`model-router.json` `hard_caps` (read the live number there, don't assume it), so reach for it
only when the work is truly the largest or deepest you have.

| Effort | Use it for |
|---|---|
| low | Skim a huge codebase and summarize what it does. |
| medium | Carry a long, many-step job through to the end in one go. |
| high | Solve a hard problem that touches your whole app at once. |
| xhigh | Build a whole complex system in one shot. |
| max | Your single hardest, deepest job -- a full top-to-bottom plan, audit, or rebuild. |

Fable's whole point is SIZE and DEPTH -- every gear is a big or hard job. It is the priciest
model, so only reach for it when the work is genuinely the biggest or hardest you have.

---

## Seat controls (what you type)

### Model seat (`/model <name>`)

`/model` takes a built-in alias or a full model id (per Claude Code's model-config docs). The
aliases you'll actually use:

- `/model haiku` - `/model sonnet` - `/model opus` -- the three everyday seats.
- `/model fable` -- Fable 5, now a REAL seat (no longer subagent-only). Your hardest / longest work.
- `/model best` -- resolves to Fable 5 where your org has access, otherwise the latest Opus.
  The "just give me the top seat" alias.
- `/model opusplan` -- hybrid: uses Opus while you're in plan mode, then auto-switches to Sonnet
  for execution. Cheap way to get flagship planning without paying Opus rates through the whole build.
- `/model default` -- clears any override, reverts to your account's recommended model
  (Opus 4.8 on this account type).
- `sonnet[1m]` / `opus[1m]` -- the `[1m]` **suffix** (not a standalone alias) selects the
  1M-token-context variant for very long sessions. It's a no-op when the alias already resolves
  to a native-1M model (Sonnet 5 already carries 1M), and it composes with opusplan as `opusplan[1m]`.

`/model` also **saves** your pick as the default for new sessions (Claude Code v2.1.153+), so a
one-off heavy seat sticks until you change it back -- switch down when the heavy work is done.

### Speed

- `/fast` -- Opus with faster output, same model/brain (Opus 4.8 / 4.7 only; it does NOT drop to a
  smaller model). A good default for the Build lane.

### Effort (type the keyword into your prompt -- independent of the model)

Five effort tiers, cheapest to deepest, each with the think-keyword that triggers it:

| Tier | Think-keyword | Reach for it when |
|---|---|---|
| `low` | (plain -- no keyword) | mechanical / quick edits |
| `medium` | `think` | standard build + edit work |
| `high` | `think hard` | real judgment (also the DEFAULT effort on Sonnet 5 / Opus 4.8 / Fable 5) |
| `xhigh` | `think harder` | hardest planning / whole-system reasoning |
| `max` | `ultrathink` | your single deepest job of the day |

Because default effort is already `high` on the current flagship seats, "plain" buys solid
thinking on its own -- add a keyword only when the task genuinely needs MORE, or drop to a
cheaper seat when it needs less. High effort on a trivial edit is pure waste.

### Ultracode (fleet mode -- a dial ABOVE the single seat)

Effort tunes ONE seat's thinking depth. **ultracode** is the orthogonal dial: it turns on
multi-agent **Workflow** orchestration as the default for substantive work -- fan-out finders,
adversarial verifiers, synthesis passes -- trading tokens for thoroughness and confidence. Two
ways it engages:

- Put the word `ultracode` in a single prompt -> that one turn opts into a Workflow.
- Session-level ultracode ON (a system-reminder confirms it) -> standing opt-in: author + run a
  workflow for every substantive task by default, with token cost NOT a constraint; go solo only
  on trivial mechanical edits or conversational turns.

Reach for ultracode when the work genuinely wants the whole fleet -- broad audits, migrations,
exhaustive multi-angle review. Do NOT reach for it on a scoped single-file edit: a fan-out would
just fragment coherent work and burn budget. Think of it as the top of the gear stack --
Haiku/low ... Opus/max ... then ultracode when one seat simply isn't enough hands.

---

## Auto-route protocol (what the main session does, every session)

The expensive Opus seat is for judgment, planning, and synthesis. Keep it lean:

- Dispatch mechanical / bulk / parallel work to the cheapest sufficient subagent -- Haiku/low
  for file sweeps and greps, Sonnet for edits and tests, Opus/high or Fable for the hard core.
- Use the Agent / Workflow `model` + `effort` params to set each subagent's gear explicitly.
  This is the one lever the session controls directly -- the main `/model` is the user's keystroke.
- Announce the gear when it matters ("dispatching this sweep on Haiku/low to save budget").
- Respect the router's hard caps in `model-router.json` `hard_caps`: `per_task_usd` IS enforced
  pre-dispatch (`checkAndReserve` refuses a call whose estimate exceeds it), but `per_session_usd`
  is declared and NOT yet enforced in code (route() has no session identity -- tracked follow-up),
  so watch the session ceiling by hand. Never silently overrun -- surface the breach (VIBE Rule 21 + 58).
- Cross-provider work (Gemini vision, Grok X-data, Perplexity cited research) never touches the
  seat -- route it through the matching router category via a subagent.

---

## Cross-references

| File | Relationship |
|---|---|
| `model-router.json` | The transmission: model catalog, **live prices (the source of truth -- never duplicated here)**, task categories, hard USD caps. This rule is the driver's cheat-card + delegation habit; that file is the price/routing source. |
| `.claude/lib/router/src/budget.ts` | Where the per-task cap is actually enforced (`checkAndReserve`). The per-session cap is not enforced here yet -- see the header + auto-route protocol. |
| `vibe-standard.md` Rules 20/21/58 | Model for judgment only; hard token budgets; surface the breach, don't overrun. |
| `wired-not-orphaned.md` | The auto-route protocol is a standing behavioral commitment, not a one-off. |

---

*The point: the lowest gear that does the job, every time. Upshift only when the task fights back.*
