import OpenAI from 'openai';
import {
  AIProviderAdapter,
  AIExecutionRequest,
  AIExecutionResponse,
  AIStreamChunk,
} from './types';

export class OpenAIAdapter implements AIProviderAdapter {
  public readonly providerName = 'openai' as const;

  public async generate(request: AIExecutionRequest, apiKey: string): Promise<AIExecutionResponse> {
    const openai = new OpenAI({ apiKey });
    const { modelKey, messages, temperature = 0.7, maxTokens = 2048, abortSignal } = request;

    const response = await openai.chat.completions.create(
      {
        model: modelKey,
        messages: messages as any,
        temperature,
        max_tokens: maxTokens,
      },
      { signal: abortSignal }
    );

    const text = response.choices[0]?.message?.content || '';
    const usage = response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    return {
      text,
      usage: {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
      },
      modelKey,
    };
  }

  public async *stream(request: AIExecutionRequest, apiKey: string): AsyncIterable<AIStreamChunk> {
    const openai = new OpenAI({ apiKey });
    const { modelKey, messages, temperature = 0.7, maxTokens = 2048, abortSignal } = request;

    const stream = await openai.chat.completions.create(
      {
        model: modelKey,
        messages: messages as any,
        temperature,
        max_tokens: maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: abortSignal }
    );

    let fullText = '';
    let finalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    for await (const chunk of stream) {
      if (abortSignal?.aborted) break;

      const delta = chunk.choices[0]?.delta?.content || '';
      if (delta) {
        fullText += delta;
        yield { text: delta, done: false };
      }

      if (chunk.usage) {
        finalUsage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
        };
      }
    }

    if (finalUsage.totalTokens === 0) {
      finalUsage.promptTokens = Math.ceil(messages.map((m) => m.content).join(' ').length / 4);
      finalUsage.completionTokens = Math.ceil(fullText.length / 4);
      finalUsage.totalTokens = finalUsage.promptTokens + finalUsage.completionTokens;
    }

    yield { text: '', done: true, usage: finalUsage };
  }
}
