/**
 * The provider-agnostic interface every AI adapter implements. Business
 * logic (future `backend/src/ai/workflows/`, Phase 13+) depends only on
 * this interface, never on a concrete vendor SDK — see docs/AI_MODE.md §2.
 */
export interface AIProvider {
  readonly id: string; // e.g. "openai-compatible"
  readonly displayName: string;
  listModels(): Promise<AIModelInfo[]>;
  complete(request: AICompletionRequest): Promise<AICompletionResult>;
  estimateTokens(text: string): number;
  checkStatus(): Promise<AIProviderStatus>;
}

export interface AIModelInfo {
  id: string;
  contextWindow: number | null;
}

export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AICompletionRequest {
  messages: AIMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface AICompletionResult {
  content: string;
  model: string;
  finishReason: string | null;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
  };
}

export type AIProviderStatusKind = "reachable" | "auth_error" | "rate_limited" | "unreachable";

export interface AIProviderStatus {
  status: AIProviderStatusKind;
  /** Human-readable detail — e.g. the HTTP status text, or a network error message. Never includes the API key. */
  detail: string | null;
  checkedAt: string;
}

/** Thrown by an adapter when a request to the provider fails, carrying enough detail to classify the failure without re-parsing HTTP internals at the call site. */
export class AIProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: AIProviderStatusKind
  ) {
    super(message);
    this.name = "AIProviderError";
  }
}
