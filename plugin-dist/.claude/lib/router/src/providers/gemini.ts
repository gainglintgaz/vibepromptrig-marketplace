// Google Gemini provider -- LIVE (v5.0 provider expansion). Wraps @google/genai (its own wire
// format). Reads GEMINI_API_KEY from env (A10). System prompt -> systemInstruction; usage tokens from
// usageMetadata. Throws loudly on error; no silent fallback (A4). Arch 9d7294c (extends).
import { GoogleGenAI } from "@google/genai";
import type { CompletionRequest, CompletionResult, Provider } from "../types.js";

export class GeminiProvider implements Provider {
  readonly name = "google" as const;

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error(
        "GEMINI_API_KEY not set. The router resolves providers as code (A1), but an actual " +
          "completion requires the key in env (A10: secrets from env, never config).",
      );
    }
    const ai = new GoogleGenAI({ apiKey: key });
    const resp = await ai.models.generateContent({
      model: req.model,
      contents: req.prompt,
      config: {
        ...(req.system ? { systemInstruction: req.system } : {}),
        maxOutputTokens: req.maxTokens ?? 1024,
      },
    });
    const um = resp.usageMetadata;
    return {
      text: resp.text ?? "",
      model: resp.modelVersion ?? req.model, // provider-echoed id; fall back to requested
      provider: this.name,
      tokensIn: um?.promptTokenCount ?? 0,
      tokensOut: um?.candidatesTokenCount ?? 0,
    };
  }
}
