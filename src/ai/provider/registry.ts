import { createOpenAICompatibleProvider } from "./adapters/openaiCompatible.js";
import type { AIProvider } from "./types.js";

export interface ProviderConfig {
  kind: string;
  baseUrl: string | null;
  model: string | null;
  apiKey: string | null;
}

export const SUPPORTED_PROVIDER_KINDS = ["openai-compatible"] as const;

export function createProvider(config: ProviderConfig): AIProvider {
  if (!config.baseUrl) {
    throw new Error("Provider configuration is missing a base URL");
  }
  if (!config.model) {
    throw new Error("Provider configuration is missing a model");
  }

  switch (config.kind) {
    case "openai-compatible":
      return createOpenAICompatibleProvider({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
      });
    default:
      throw new Error(
        `Provider kind "${config.kind}" is not yet supported — only ${SUPPORTED_PROVIDER_KINDS.join(", ")} ${
          SUPPORTED_PROVIDER_KINDS.length === 1 ? "is" : "are"
        } implemented.`
      );
  }
}
