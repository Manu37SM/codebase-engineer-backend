import {
  AIProviderError,
  type AICompletionRequest,
  type AICompletionResult,
  type AIModelInfo,
  type AIProvider,
  type AIProviderStatus,
} from "../types.js";
import { estimateTokens as estimateTokensShared } from "../../tokenEstimate.js";

export interface OpenAICompatibleConfig {
  /** e.g. "https://api.openai.com/v1", or a local server's OpenAI-compatible base URL. */
  baseUrl: string;
  /** Optional — many local servers (Ollama's OpenAI-compat endpoint, LM Studio) don't require one. */
  apiKey?: string | null;
  model: string;
  /** Milliseconds. Defaults to 30s — this is a live network call, not a background job. */
  timeoutMs?: number;
}

/**
 * Talks to any server implementing the OpenAI Chat Completions API shape
 * (`GET {baseUrl}/models`, `POST {baseUrl}/chat/completions`) — this covers
 * OpenAI itself and the many local/self-hosted servers (Ollama, LM Studio,
 * vLLM, etc.) that expose an OpenAI-compatible surface, without needing a
 * separate adapter per vendor.
 */
export function createOpenAICompatibleProvider(config: OpenAICompatibleConfig): AIProvider {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? 30_000;

  function headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (config.apiKey) h["Authorization"] = `Bearer ${config.apiKey}`;
    return h;
  }

  async function doFetch(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${baseUrl}${path}`, { ...init, headers: headers(), signal: controller.signal });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new AIProviderError(`Request to ${path} timed out after ${timeoutMs}ms`, "unreachable");
      }
      throw new AIProviderError(
        `Could not reach ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
        "unreachable"
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function classifyAndThrow(res: Response, path: string): Promise<never> {
    const bodyText = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new AIProviderError(`Authentication failed calling ${path} (HTTP ${res.status})`, "auth_error");
    }
    if (res.status === 429) {
      throw new AIProviderError(`Rate limited calling ${path} (HTTP ${res.status})`, "rate_limited");
    }
    throw new AIProviderError(
      `${path} returned HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 300)}` : ""}`,
      "unreachable"
    );
  }

  return {
    id: "openai-compatible",
    displayName: "OpenAI-compatible",

    async listModels(): Promise<AIModelInfo[]> {
      const res = await doFetch("/models", { method: "GET" });
      if (!res.ok) await classifyAndThrow(res, "/models");
      const body = (await res.json()) as { data?: { id: string; context_window?: number }[] };
      if (!Array.isArray(body.data)) {
        throw new AIProviderError("/models response did not include a data array", "unreachable");
      }
      return body.data.map((m) => ({ id: m.id, contextWindow: m.context_window ?? null }));
    },

    async complete(request: AICompletionRequest): Promise<AICompletionResult> {
      const res = await doFetch("/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: config.model,
          messages: request.messages,
          max_tokens: request.maxTokens,
          temperature: request.temperature,
        }),
      });
      if (!res.ok) await classifyAndThrow(res, "/chat/completions");
      const body = (await res.json()) as {
        model?: string;
        choices?: { message?: { content?: string }; finish_reason?: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = body.choices?.[0];
      if (!choice?.message?.content) {
        throw new AIProviderError(
          "/chat/completions response did not include a message with content",
          "unreachable"
        );
      }
      return {
        content: choice.message.content,
        model: body.model ?? config.model,
        finishReason: choice.finish_reason ?? null,
        usage: {
          promptTokens: body.usage?.prompt_tokens ?? null,
          completionTokens: body.usage?.completion_tokens ?? null,
        },
      };
    },

    // See ai/tokenEstimate.ts for why this is a documented approximation,
    // not a real per-model tokenizer.
    estimateTokens(text: string): number {
      return estimateTokensShared(text);
    },

    async checkStatus(): Promise<AIProviderStatus> {
      const checkedAt = new Date().toISOString();
      try {
        await this.listModels();
        return { status: "reachable", detail: null, checkedAt };
      } catch (err) {
        if (err instanceof AIProviderError) {
          return { status: err.kind, detail: err.message, checkedAt };
        }
        return {
          status: "unreachable",
          detail: err instanceof Error ? err.message : String(err),
          checkedAt,
        };
      }
    },
  };
}
