export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIExecutionRequest {
  modelKey: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  abortSignal?: AbortSignal;
}

export interface TokenUsageMetadata {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
}

export interface AIStreamChunk {
  text: string;
  done: boolean;
  usage?: TokenUsageMetadata;
}

export interface AIExecutionResponse {
  text: string;
  usage: TokenUsageMetadata;
  modelKey: string;
}

export interface AIProviderAdapter {
  providerName: 'gemini' | 'openai' | 'openrouter';
  generate(request: AIExecutionRequest, apiKey: string): Promise<AIExecutionResponse>;
  stream(request: AIExecutionRequest, apiKey: string): AsyncIterable<AIStreamChunk>;
}
