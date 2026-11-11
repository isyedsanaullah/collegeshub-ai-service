import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  AIProviderAdapter,
  AIExecutionRequest,
  AIExecutionResponse,
  AIStreamChunk,
} from './types';

export class GeminiAdapter implements AIProviderAdapter {
  public readonly providerName = 'gemini' as const;

  public async generate(request: AIExecutionRequest, apiKey: string): Promise<AIExecutionResponse> {
    const genAI = new GoogleGenerativeAI(apiKey);
    const { modelKey, messages, temperature = 0.7, maxTokens = 2048 } = request;

    const systemMsg = messages.find((m) => m.role === 'system');
    const userAndAssistantMsgs = messages.filter((m) => m.role !== 'system');

    const model = genAI.getGenerativeModel({
      model: modelKey,
      systemInstruction: systemMsg ? systemMsg.content : undefined,
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
      },
    });

    const contents = userAndAssistantMsgs.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const result = await model.generateContent({ contents });
    const response = result.response;
    const usage = response.usageMetadata;

    return {
      text: response.text(),
      usage: {
        promptTokens: usage?.promptTokenCount || 0,
        completionTokens: usage?.candidatesTokenCount || 0,
        cachedTokens: usage?.cachedContentTokenCount || 0,
        totalTokens: usage?.totalTokenCount || 0,
      },
      modelKey,
    };
  }

  public async *stream(request: AIExecutionRequest, apiKey: string): AsyncIterable<AIStreamChunk> {
    const genAI = new GoogleGenerativeAI(apiKey);
    const { modelKey, messages, temperature = 0.7, maxTokens = 2048, abortSignal } = request;

    const systemMsg = messages.find((m) => m.role === 'system');
    const userAndAssistantMsgs = messages.filter((m) => m.role !== 'system');

    const model = genAI.getGenerativeModel({
      model: modelKey,
      systemInstruction: systemMsg ? systemMsg.content : undefined,
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
      },
    });

    const contents = userAndAssistantMsgs.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const result = await model.generateContentStream({ contents }, { signal: abortSignal });

    let fullText = '';
    for await (const chunk of result.stream) {
      if (abortSignal?.aborted) {
        break;
      }
      const text = chunk.text();
      if (text) {
        fullText += text;
        yield { text, done: false };
      }
    }

    const response = await result.response;
    const usage = response.usageMetadata;

    yield {
      text: '',
      done: true,
      usage: {
        promptTokens: usage?.promptTokenCount || Math.ceil(messages.map(m => m.content).join(' ').length / 4),
        completionTokens: usage?.candidatesTokenCount || Math.ceil(fullText.length / 4),
        cachedTokens: usage?.cachedContentTokenCount || 0,
        totalTokens: usage?.totalTokenCount || 0,
      },
    };
  }
}
