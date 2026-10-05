// Prompt caching. Anthropic native (cache_control on the system block). Other providers
// get manual/no-op handling until wired (arch SS5.2). v5.0 Sprint 1 Commit 3. Arch 9d7294c.
import type { CompletionRequest } from "./types.js";

/** Anthropic cache_control block for a system prompt, when cacheHint === "system". */
export function anthropicSystemBlocks(req: CompletionRequest): Array<Record<string, unknown>> | undefined {
  if (!req.system) return undefined;
  if (req.cacheHint === "system") {
    return [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }];
  }
  return [{ type: "text", text: req.system }];
}
