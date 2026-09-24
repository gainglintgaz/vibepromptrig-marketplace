// Shared base for OpenAI-wire-format providers: OpenAI, xAI (Grok), Perplexity. Uses the `openai`
// SDK with a per-subclass baseURL + envKeyName + name. Reads the key from env ONLY (A10); throws
// loudly on error and NEVER silent-fallbacks to another provider (A4). v5.0 provider expansion.
// Arch 9d7294c (extends).
import OpenAI from "openai";
import type { CompletionRequest, CompletionResult, Provider, ProviderName } from "../types.js";

export abstract class OpenAICompatibleProvider implements Provider {
  abstract readonly name: ProviderName;
  /** The env var holding this provider's API key (A10: env only, never config). */
  protected abstract readonly envKeyName: string;
  /** Override for non-OpenAI hosts (xAI, Perplexity). Undefined => OpenAI default base. */
  protected readonly baseURL: string | undefined = undefined;
  /**
   * OpenAI reasoning-class models reject `max_tokens` and require `max_completion_tokens`;
   * xAI + Perplexity use the older `max_tokens`. Subclasses set the right one.
   */
  protected readonly tokenParam: "max_tokens" | "max_completion_tokens" = "max_tokens";

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const key = process.env[this.envKeyName];
    if (!key) {
      throw new Error(
        `${this.envKeyName} not set. The router resolves providers as code (A1), but an actual ` +
          `completion requires the key in env (A10: secrets from env, never config).`,
      );
    }
    const client = new OpenAI(this.baseURL ? { apiKey: key, baseURL: this.baseURL } : { apiKey: key });

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push({ role: "user", content: req.prompt });

    // Build params with the provider-correct token-limit key, then cast for the SDK call.
    const params: Record<string, unknown> = { model: req.model, messages };
    params[this.tokenParam] = req.maxTokens ?? 1024;

    const resp = (await client.chat.completions.create(
      params as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    )) as OpenAI.Chat.ChatCompletion;

    const content = resp.choices?.[0]?.message?.content;
    return {
      text: typeof content === "string" ? content : "",
      model: resp.model, // provider-echoed id (may be a dated snapshot -> Bug-1 cost path handles it)
      provider: this.name,
      tokensIn: resp.usage?.prompt_tokens ?? 0,
      tokensOut: resp.usage?.completion_tokens ?? 0,
    };
  }
}
