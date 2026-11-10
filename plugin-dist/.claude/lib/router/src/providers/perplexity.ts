// Perplexity provider -- LIVE + NET-NEW (v5.0 provider expansion). OpenAI-compatible wire format via
// the `openai` SDK pointed at api.perplexity.ai. Reads PERPLEXITY_API_KEY from env (A10). Used by the
// research_cited task category (cited web/market research). NOTE: Perplexity also charges per-request
// search fees on top of token pricing -- the model-router cost map models token pricing only, so cost
// for Perplexity is a documented undercount (see docs/architecture/provider-expansion.md SS2.5).
// Arch 9d7294c (extends).
import { OpenAICompatibleProvider } from "./openai-compatible.js";

export class PerplexityProvider extends OpenAICompatibleProvider {
  readonly name = "perplexity" as const;
  protected readonly envKeyName = "PERPLEXITY_API_KEY";
  protected readonly baseURL = "https://api.perplexity.ai";
}
