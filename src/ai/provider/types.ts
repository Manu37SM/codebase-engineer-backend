
export interface AIProvider {
  readonly id: string; 
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

  detail: string | null;
  checkedAt: string;
}

export class AIProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: AIProviderStatusKind
  ) {
    super(message);
    this.name = "AIProviderError";
  }
}
