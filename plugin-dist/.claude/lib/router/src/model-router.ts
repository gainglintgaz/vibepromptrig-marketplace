// Loads + queries the factory default .claude/model-router.json. Arch 9d7294c.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderName } from "./types.js";

export interface ModelInfo {
  provider: ProviderName;
  in_usd_mtok: number;
  out_usd_mtok: number;
}

export interface ModelRouter {
  hard_caps: { per_task_usd: number; per_session_usd: number };
  providers: Record<string, { env_key: string; wired: boolean }>;
  models: Record<string, ModelInfo>;
  task_categories: Record<string, { preferred: string[]; fallback?: string[] }>;
}

export function factoryRoot(override?: string): string {
  return override || process.env.VIBEPROMPTRIG_FACTORY_ROOT || process.cwd();
}

export function loadModelRouter(root?: string): ModelRouter {
  const path = join(factoryRoot(root), ".claude", "model-router.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`ROUTER ERROR: cannot read model-router.json at ${path}: ${(e as Error).message}`);
  }
  let parsed: ModelRouter;
  try {
    parsed = JSON.parse(raw) as ModelRouter;
  } catch (e) {
    throw new Error(`ROUTER ERROR: model-router.json is not valid JSON: ${(e as Error).message}`);
  }
  if (!parsed.models || !parsed.task_categories) {
    throw new Error("ROUTER ERROR: model-router.json missing 'models' or 'task_categories'");
  }
  return parsed;
}

/** Cost in cents for a completion, from model-router pricing. Fails loud on unknown model. */
export function costCents(router: ModelRouter, model: string, tokensIn: number, tokensOut: number): number {
  const m = router.models[model];
  if (!m) {
    throw new Error(`ROUTER ERROR: unknown model '${model}' -- not in model-router.json models map`);
  }
  const usd = (tokensIn / 1_000_000) * m.in_usd_mtok + (tokensOut / 1_000_000) * m.out_usd_mtok;
  return Math.round(usd * 100 * 100) / 100; // cents, 2dp
}

export function providerForModel(router: ModelRouter, model: string): ProviderName {
  const m = router.models[model];
  if (!m) {
    throw new Error(`ROUTER ERROR: unknown model '${model}' -- cannot determine provider`);
  }
  return m.provider;
}

/**
 * Resilient POST-dispatch cost resolution (Bug-1 fix). NEVER throws: a completed paid dispatch must
 * always be logged. Tries the provider-echoed model id; falls back to the requested id (proven to
 * exist pre-dispatch); else records 0 and flags estimated. Keep `costCents` strict for any
 * pre-dispatch use -- this loosening applies ONLY after spend has occurred.
 */
export function costCentsResolved(
  router: ModelRouter,
  echoedModel: string,
  requestedModel: string,
  tokensIn: number,
  tokensOut: number,
): { cents: number; estimated: boolean } {
  // Bug-1 (HIGH F2) -- invalid usage guard, BEFORE any arithmetic and independent of the model id.
  // Real SDKs can return undefined/NaN usage on some error/stream paths; a provider/proxy could emit
  // negatives. NaN would serialize to null and be silently dropped by the budget+cost accounting
  // (`typeof c === "number"` is false for null) -> a REAL paid call recorded as 0c with
  // cost_estimated:FALSE (presented as exact). A negative would UNDERFLOW the running total. Both are
  // the dangerous undercount direction. Treat any non-finite/negative usage as estimated-0 (never
  // fabricate a clamped cost from garbage usage), flagged so the dashboard never shows it as exact.
  if (
    !Number.isFinite(tokensIn) ||
    !Number.isFinite(tokensOut) ||
    tokensIn < 0 ||
    tokensOut < 0
  ) {
    process.stderr.write(
      `cost: invalid usage tokens (in=${String(tokensIn)} out=${String(tokensOut)}) for ` +
        `'${echoedModel}' -- logged at estimated cost 0 (cost_estimated:true)\n`,
    );
    return { cents: 0, estimated: true };
  }
  const m = router.models[echoedModel] ?? router.models[requestedModel];
  if (!m) {
    // Surface, don't swallow: a silent unknown is future cost drift.
    process.stderr.write(
      `cost: unknown model '${echoedModel}' (requested '${requestedModel}') -- logged at estimated ` +
        `cost 0, refresh model-router.json\n`,
    );
    return { cents: 0, estimated: true };
  }
  const usd = (tokensIn / 1_000_000) * m.in_usd_mtok + (tokensOut / 1_000_000) * m.out_usd_mtok;
  const cents = Math.round(usd * 100 * 100) / 100;
  // estimated when the echoed id was unknown and we fell back to the requested id's pricing.
  return { cents, estimated: !router.models[echoedModel] };
}
