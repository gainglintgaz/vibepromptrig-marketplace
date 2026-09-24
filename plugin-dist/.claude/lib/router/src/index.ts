// Public API for @vibepromptrig/router. Agents import { route } from here (arch SS5.3).
// v5.0 Sprint 1 Commit 3. Arch 9d7294c.
export { route, selectModel } from "./router.js";
export type { RouteResult } from "./router.js";
export {
  monthToDateCents,
  committedAndReservedCents,
  checkAndReserve,
  commitReservation,
  closeReservation,
  metricsPathFor,
  budgetLedgerPathFor,
  BudgetExceededError,
} from "./budget.js";
export { hashConfig, logAiCall } from "./provenance.js";
export type { AiCallEvent } from "./provenance.js";
export { loadModelRouter, costCents, costCentsResolved, providerForModel, factoryRoot } from "./model-router.js";
export { TASK_CATEGORIES, isTaskCategory } from "./schemas/task-categories.js";
export type { TaskCategory } from "./schemas/task-categories.js";
export type {
  RouteArgs,
  CompletionRequest,
  CompletionResult,
  Provider,
  ProviderName,
  TaskOverride,
} from "./types.js";
