# @vibepromptrig/router

v5.0 provider abstraction (arch `9d7294c`, `docs/architecture/v5.0-sprint-1-override-layer.md` + parent `v5.0-customer-configurable-agents.md` §5).

The single AI provider entry point. Agents call `route()` instead of importing a provider SDK
directly, so providers are swappable per task-category + per customer without code changes.

## API

```ts
import { route } from "@vibepromptrig/router";

const result = await route({
  taskCategory: "agent_dispatch",   // one of the 9 stable categories
  prompt: "...",
  system: "...",
  resolvedConfig: customerResolvedConfig, // hashed for A8 provenance
  providerPrefs,                    // customer .forge/provider-prefs.json task_categories (checked FIRST)
  budgetCentsPerMonth: 200,         // A9 hard cap
  agent: "synthesizer",
  agentVersion: "1.0.0",
});
```

## What it does (per call)

1. **Resolve** provider+model per task-category: customer `provider-prefs` FIRST, then factory `model-router.json` (A2 merge-by-task). Pure code, zero tokens (A1).
2. **Budget hard-stop (A9)**: checks month-to-date `ai_call` spend in `factory_metrics.jsonl` BEFORE dispatch. Refuses to dispatch past cap -- throws `BudgetExceededError`, never silent overrun.
3. **Dispatch**: `anthropic` is live (`@anthropic-ai/sdk`, key from `ANTHROPIC_API_KEY` env only -- A10). `openai` / `gemini` / `local` / `xai` are stubs that throw `not enabled in v5.0` (no silent fallback -- A4).
4. **Provenance (A8)**: logs `event=ai_call` to `factory_metrics.jsonl` with SHA-256 config hash + provider + model + tokens + cost_cents + agent + agent_version.

## Build / test

```
npm install
npm run typecheck   # tsc --noEmit -- must be clean
npm run build       # tsc -> dist/
npm test            # node --test dist/  (8 checks; no API key needed)
```

The test harness proves A9 (throws pre-dispatch), the stubs (throw), A8 (logged shape),
hash determinism, and A2 model selection. It does NOT assert a live Anthropic completion --
that needs a real `ANTHROPIC_API_KEY` to demonstrate end-to-end and is intentionally not faked.

## Markdown agents

Markdown agents (e.g. `synthesizer`) have no compiler, so they cannot literally
`import { route }`. Their `.md` "Provider routing" section documents the `route()` contract --
the faithful markdown equivalent of the §5.3 code pattern. A future sprint that gives agents a
TS execution runner will call `route()` directly.
