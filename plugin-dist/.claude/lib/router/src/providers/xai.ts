// Grok / xAI provider -- LIVE (v5.0 provider expansion). OpenAI-compatible wire format via the
// `openai` SDK pointed at api.x.ai. Reads XAI_API_KEY from env (A10). Replaces the inline throwing
// stub that previously lived in router.ts. Arch 9d7294c (extends).
import { OpenAICompatibleProvider } from "./openai-compatible.js";

export class XaiProvider extends OpenAICompatibleProvider {
  readonly name = "xai" as const;
  protected readonly envKeyName = "XAI_API_KEY";
  protected readonly baseURL = "https://api.x.ai/v1";
}
