// OpenAI provider -- LIVE (v5.0 provider expansion). Thin subclass of the OpenAI-compatible base.
// Reads OPENAI_API_KEY from env (A10). Uses max_completion_tokens (reasoning-class models reject
// max_tokens). Arch 9d7294c (extends).
import { OpenAICompatibleProvider } from "./openai-compatible.js";

export class OpenAIProvider extends OpenAICompatibleProvider {
  readonly name = "openai" as const;
  protected readonly envKeyName = "OPENAI_API_KEY";
  protected readonly tokenParam = "max_completion_tokens" as const;
}
