// A8 -- config-run provenance. Every route() call logs event=ai_call to factory_metrics
// with the resolved-config hash (SHA-256) + provider + model + tokens + cost + agent +
// agent_version. Answers the 30-second "which config produced this output" test. Arch 9d7294c.
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

/** Deterministic SHA-256 of a resolved config object (stable key ordering). */
export function hashConfig(config: unknown): string {
  return createHash("sha256").update(stableStringify(config)).digest("hex");
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

export interface AiCallEvent {
  config_hash: string;
  provider: string;
  model: string;
  task_category: string;
  tokens_in: number;
  tokens_out: number;
  cost_cents: number;
  agent: string;
  agent_version: string;
  /**
   * True when cost_cents was derived from a fallback/zero because the provider-echoed model id was
   * unknown to model-router.json (Bug-1 fix). Keeps the dashboard cost MCP honest -- an estimated
   * cost is never presented as exact (data-citizenship). Defaults false.
   */
  cost_estimated?: boolean;
}

/** Append one ai_call line to factory_metrics.jsonl. Returns the full logged record. */
export function logAiCall(metricsPath: string, ev: AiCallEvent, now?: Date): Record<string, unknown> {
  const record: Record<string, unknown> = {
    ts: (now ?? new Date()).toISOString(),
    event: "ai_call",
    ...ev,
    cost_estimated: ev.cost_estimated ?? false, // always present + honest, even for legacy callers
  };
  appendFileSync(metricsPath, JSON.stringify(record) + "\n", "utf8");
  return record;
}
