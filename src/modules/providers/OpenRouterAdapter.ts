import {
  AIProviderAdapter,
  AIExecutionRequest,
  AIExecutionResponse,
  AIStreamChunk,
} from './types';

export class OpenRouterAdapter implements AIProviderAdapter {
  public readonly providerName = 'openrouter' as const;

  public async generate(request: AIExecutionRequest, apiKey: string): Promise<AIExecutionResponse> {
    const { modelKey, messages, temperature = 0.7, maxTokens = 2048, abortSignal } = request;

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://collegeshub.org',
        'X-Title': 'Collegeshub AI Service',
      },
      body: JSON.stringify({
        model: modelKey,
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
      signal: abortSignal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`OpenRouter API error ${res.status}: ${errBody}`);
    }

    const json = (await res.json()) as any;
    const text = json.choices?.[0]?.message?.content || '';
    const usage = json.usage || {};

    return {
      text,
      usage: {
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0,
      },
      modelKey,
    };
  }

  public async *stream(request: AIExecutionRequest, apiKey: string): AsyncIterable<AIStreamChunk> {
    const { modelKey, messages, temperature = 0.7, maxTokens = 2048, abortSignal } = request;

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://collegeshub.org',
        'X-Title': 'Collegeshub AI Service',
      },
      body: JSON.stringify({
        model: modelKey,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: abortSignal,
    });

    if (!res.ok || !res.body) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`OpenRouter streaming error ${res.status}: ${errBody}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let finalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let fullText = '';

    try {
      while (true) {
        if (abortSignal?.aborted) break;

        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (trimmed === 'data: [DONE]') continue;

          if (trimmed.startsWith('data: ')) {
            try {
              const data = JSON.parse(trimmed.slice(6));
              const delta = data.choices?.[0]?.delta?.content || '';
              if (delta) {
                fullText += delta;
                yield { text: delta, done: false };
              }
              if (data.usage) {
                finalUsage = {
                  promptTokens: data.usage.prompt_tokens || 0,
                  completionTokens: data.usage.completion_tokens || 0,
                  totalTokens: data.usage.total_tokens || 0,
                };
              }
            } catch {
              // Ignore parse error on partial chunks
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (finalUsage.totalTokens === 0) {
      finalUsage.promptTokens = Math.ceil(messages.map((m) => m.content).join(' ').length / 4);
      finalUsage.completionTokens = Math.ceil(fullText.length / 4);
      finalUsage.totalTokens = finalUsage.promptTokens + finalUsage.completionTokens;
    }

    yield { text: '', done: true, usage: finalUsage };
  }
}
