// Shared types for the v5.0 provider router. Arch 9d7294c.
import type { TaskCategory } from "./schemas/task-categories.js";

export type ProviderName = "anthropic" | "openai" | "google" | "xai" | "perplexity" | "local";

/** A single AI completion request, provider-agnostic. */
export interface CompletionRequest {
  model: string;
  prompt: string;
  system?: string;
  maxTokens?: number;
  /** Anthropic native prompt-cache hint target. */
  cacheHint?: "system" | "none";
}

/** A provider-agnostic completion result. */
export interface CompletionResult {
  text: string;
  model: string;
  provider: ProviderName;
  tokensIn: number;
  tokensOut: number;
}

/** A provider wrapper. Anthropic is live; others throw "not enabled in v5.0". */
export interface Provider {
  readonly name: ProviderName;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

/** Per-task customer override (subset of provider-prefs.schema.json). */
export interface TaskOverride {
  preferred?: string[];
  max_cost_per_task_cents?: number;
}

/** The arguments to route(). */
export interface RouteArgs {
  taskCategory: TaskCategory;
  prompt: string;
  system?: string;
  maxTokens?: number;
  cacheHint?: "system" | "none";
  /** The fully-resolved config object for this run (hashed for A8 provenance). */
  resolvedConfig?: unknown;
  /** Pre-computed config hash; if absent, derived from resolvedConfig. */
  configHash?: string;
  /** Customer provider-prefs.task_categories (Layer 3), checked FIRST. */
  providerPrefs?: Record<string, TaskOverride>;
  /** Hard budget cap for this agent, cents/month (A9). */
  budgetCentsPerMonth?: number;
  /** Estimated cost of THIS call, cents -- checked against remaining budget BEFORE dispatch. */
  estimatedCents?: number;
  agent?: string;
  agentVersion?: string;
  /** Override factory root (defaults to env VIBEPROMPTRIG_FACTORY_ROOT or cwd). */
  factoryRoot?: string;
  /** Override the factory_metrics provenance path (tests pass a temp file). */
  metricsPath?: string;
  /** Override the dedicated budget-ledger path (tests pass a temp file; defaults to .forge/budget-ledger.jsonl). */
  budgetLedgerPath?: string;
  /**
   * Test-only DI seam: override the provider wrappers for THIS call (defaults to the module
   * PROVIDERS map). Used by the Bug-1 / Bug-2 tests to inject a fake Provider so no real key or
   * spend is needed. Production callers leave this undefined.
   */
  providersOverride?: Partial<Record<ProviderName, Provider>>;
}
