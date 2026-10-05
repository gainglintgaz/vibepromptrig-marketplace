// Local (Ollama / llama.cpp) provider -- STUB. Not enabled in v5.0. Throws loudly;
// no silent fallback (A4). Arch 9d7294c.
import type { CompletionRequest, CompletionResult, Provider } from "../types.js";

export class LocalProvider implements Provider {
  readonly name = "local" as const;
  async complete(_req: CompletionRequest): Promise<CompletionResult> {
    throw new Error("local provider not enabled in v5.0 (stub). Wire lib/router/providers/local.ts to enable.");
  }
}
