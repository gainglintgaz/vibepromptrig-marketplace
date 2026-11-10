// Anthropic provider -- LIVE. Wraps @anthropic-ai/sdk. Reads ANTHROPIC_API_KEY from env
// (never from config; A10). v5.0 Sprint 1 Commit 3. Arch 9d7294c.
import Anthropic from "@anthropic-ai/sdk";
import type { CompletionRequest, CompletionResult, Provider } from "../types.js";
import { anthropicSystemBlocks } from "../cache.js";

export class AnthropicProvider implements Provider {
  readonly name = "anthropic" as const;

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        "ANTHROPIC_API_KEY not set. The router resolves providers as code (A1), but an " +
          "actual completion requires the key in env (A10: secrets from env, never config).",
      );
    }
    const client = new Anthropic({ apiKey: key });
    const system = anthropicSystemBlocks(req);
    const resp = await client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens ?? 1024,
      system: system as Anthropic.TextBlockParam[] | undefined,
      messages: [{ role: "user", content: req.prompt }],
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return {
      text,
      model: resp.model,
      provider: this.name,
      tokensIn: resp.usage.input_tokens,
      tokensOut: resp.usage.output_tokens,
    };
  }
}
