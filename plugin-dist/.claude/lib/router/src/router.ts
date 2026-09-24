// route() -- the single AI provider entry point (arch SS5.2). Resolves provider+model per
// task-category from customer provider-prefs FIRST then model-router.json (A2 merge-by-task),
// enforces an ATOMIC budget check-and-reserve BEFORE dispatch (A9 + Bug-2 fix), dispatches to the
// provider wrapper, ALWAYS logs ai_call provenance even when the echoed model id is unknown (A8 +
// Bug-1 fix), and never silently re-routes on a provider error or an unwired provider (A4).
// v5.0 provider expansion. Arch 9d7294c (extends).
import { randomUUID } from "node:crypto";
import type { Provider, CompletionResult, RouteArgs, ProviderName } from "./types.js";
import {
  loadModelRouter,
  costCentsResolved,
  providerForModel,
  factoryRoot,
  type ModelRouter,
} from "./model-router.js";
import {
  checkAndReserve,
  commitReservation,
  closeReservation,
  metricsPathFor,
  budgetLedgerPathFor,
} from "./budget.js";
import { hashConfig, logAiCall } from "./provenance.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAIProvider } from "./providers/openai.js";
import { GeminiProvider } from "./providers/gemini.js";
import { XaiProvider } from "./providers/xai.js";
import { PerplexityProvider } from "./providers/perplexity.js";
import { LocalProvider } from "./providers/local.js";

const PROVIDERS: Record<ProviderName, Provider> = {
  anthropic: new AnthropicProvider(),
  openai: new OpenAIProvider(),
  google: new GeminiProvider(),
  xai: new XaiProvider(),
  perplexity: new PerplexityProvider(),
  local: new LocalProvider(), // out of scope -- stays a throwing stub (wired:false everywhere)
};

/** Pick the model for a task category: customer prefs FIRST, then factory default. */
export function selectModel(
  router: ModelRouter,
  taskCategory: string,
  providerPrefs?: Record<string, { preferred?: string[] }>,
): string {
  const custom = providerPrefs?.[taskCategory]?.preferred;
  if (custom && custom.length > 0) return custom[0]!;
  const dflt = router.task_categories[taskCategory]?.preferred;
  if (dflt && dflt.length > 0) return dflt[0]!;
  throw new Error(`ROUTER ERROR: no model for task category '${taskCategory}' in prefs or model-router.json`);
}

export interface RouteResult extends CompletionResult {
  costCents: number;
  costEstimated: boolean;
  /**
   * F6 -- true when the ACTUAL settled cost exceeded the per-task cap. The cap gates the pre-dispatch
   * ESTIMATE (checkAndReserve); a caller that under-estimates (low estimatedCents + large maxTokens)
   * can still settle above it. We do NOT throw post-dispatch (spend already happened, Bug-1) -- we
   * flag it here + warn to stderr so the overage is observable and never presented as within-cap.
   */
  costOverPerTaskCap: boolean;
  configHash: string;
  spentBeforeCents: number;
}

export async function route(args: RouteArgs): Promise<RouteResult> {
  const root = factoryRoot(args.factoryRoot);
  const router = loadModelRouter(root);
  const providers = args.providersOverride ? { ...PROVIDERS, ...args.providersOverride } : PROVIDERS;

  // 1. Resolve provider + model (code, zero tokens -- A1/A2).
  const model = selectModel(router, args.taskCategory, args.providerPrefs);
  const provider = providerForModel(router, model);

  // 1b. Wired-flag gate (A4): a selected model whose provider is not wired throws -- it must NEVER
  //     silently re-route to a different provider. The `fallback` arrays are human hints, not runtime.
  const providerCfg = router.providers[provider];
  if (!providerCfg || providerCfg.wired !== true) {
    throw new Error(
      `ROUTER ERROR: provider '${provider}' not wired (model '${model}'). No silent reroute (A4). ` +
        `Set providers.${provider}.wired=true in model-router.json after wiring providers/${provider}.ts.`,
    );
  }

  // 2. Config-run provenance hash (A8).
  const configHash = args.configHash ?? hashConfig(args.resolvedConfig ?? {});

  // 3. ATOMIC budget check-and-reserve BEFORE dispatch (A9 + Bug-2). Cap = min(agent budget, per-task).
  //    The gate reserves against the DEDICATED budget ledger (F3); the ai_call PROVENANCE row (step 5)
  //    goes to factory_metrics for the cost MCP.
  const metricsPath = metricsPathFor(root, args.metricsPath);
  const ledgerPath = budgetLedgerPathFor(root, args.budgetLedgerPath);
  const factoryPerTaskCents = router.hard_caps.per_task_usd * 100;
  const customPerTask = args.providerPrefs?.[args.taskCategory]?.max_cost_per_task_cents;
  // Effective per-task ceiling = factory hard cap, LOWERED (never raised) by a customer override.
  const perTaskCapCents = Math.min(factoryPerTaskCents, customPerTask ?? factoryPerTaskCents);
  // An unestimated call reserves exactly the per-task cap (so it can never blow the cap silently).
  const estimated = args.estimatedCents ?? perTaskCapCents;
  const monthlyCap = args.budgetCentsPerMonth ?? Number.POSITIVE_INFINITY;
  const reservationId = randomUUID();
  const spentBefore = await checkAndReserve({
    capCents: monthlyCap,
    estimatedCents: estimated,
    perTaskCapCents, // F1: hard per-call ceiling, enforced even when no monthly cap is passed
    ledgerPath,
    reservationId,
    agent: args.agent,
  });

  // 4. Dispatch. Provider throws -> propagate (A4, no fallback) AND release the reservation so a
  //    failed call doesn't permanently consume budget.
  let result: CompletionResult;
  try {
    result = await providers[provider].complete({
      model,
      prompt: args.prompt,
      system: args.system,
      maxTokens: args.maxTokens,
      cacheHint: args.cacheHint ?? "system",
    });
  } catch (err) {
    closeReservation(ledgerPath, reservationId); // release the held estimate (F3 ledger)
    throw err;
  }

  // 5. Resilient cost (Bug-1: never throws post-dispatch). Settle the reservation FIRST with the ACTUAL
  //    cost (the ledger is the budget source of truth; commit cancels the reservation by id -- this is
  //    the reconciliation that closes the crash-between-states MEDIUM). THEN write ai_call provenance
  //    to factory_metrics best-effort -- a provenance-write failure must NOT throw post-dispatch (Bug-1).
  const { cents, estimated: costEstimated } = costCentsResolved(
    router,
    result.model,
    model,
    result.tokensIn,
    result.tokensOut,
  );
  // F6: the per-task cap gates the pre-dispatch ESTIMATE, not actual settled cost. If a caller
  // under-estimated (low estimatedCents + large maxTokens), the call can settle over the cap. Don't
  // throw (spend already happened -- Bug-1); flag + warn so the overage is observable, never silent.
  const costOverPerTaskCap = cents > perTaskCapCents;
  if (costOverPerTaskCap) {
    process.stderr.write(
      `BUDGET WARN (per-task): ${args.agent ?? "agent"} call settled at ${cents.toFixed(2)}c, OVER the ` +
        `per-task cap ${perTaskCapCents.toFixed(2)}c. Spend already occurred (not refunded); the per-task ` +
        `cap gates the pre-dispatch estimate, not actual cost. Pass a realistic estimatedCents or a ` +
        `smaller maxTokens to keep calls within the cap.\n`,
    );
  }
  commitReservation(ledgerPath, { reservationId, costCents: cents, agent: args.agent });
  try {
    logAiCall(metricsPath, {
      config_hash: configHash,
      provider: result.provider,
      model: result.model,
      task_category: args.taskCategory,
      tokens_in: result.tokensIn,
      tokens_out: result.tokensOut,
      cost_cents: cents,
      cost_estimated: costEstimated,
      agent: args.agent ?? "unknown",
      agent_version: args.agentVersion ?? "unknown",
    });
  } catch (e) {
    // spend already committed to the ledger (gate stays correct); only provenance is best-effort.
    process.stderr.write(
      `ai_call provenance write failed (spend already committed to budget ledger): ${(e as Error).message}\n`,
    );
  }

  return { ...result, costCents: cents, costEstimated, costOverPerTaskCap, configHash, spentBeforeCents: spentBefore };
}
