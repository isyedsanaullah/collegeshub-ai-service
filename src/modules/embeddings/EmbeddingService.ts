import { GoogleGenerativeAI } from '@google/generative-ai';
import pino from 'pino';
import { getEnv } from '../../config/env';
import { ModelRouter } from '../routing/ModelRouter';

const env = getEnv();
const logger = pino({ level: env.LOG_LEVEL });

export interface EmbeddingResult {
  embedding: number[];
  dimensions: number;
}

export class EmbeddingService {
  private modelRouter: ModelRouter;

  constructor(modelRouter?: ModelRouter) {
    this.modelRouter = modelRouter || new ModelRouter();
  }

  /**
   * Embed a single string using Google text-embedding-004.
   * Returns a 768-dimensional float array.
   */
  public async embedQuery(text: string): Promise<number[]> {
    if (!text || !text.trim()) {
      throw new Error('Cannot generate embedding for empty text');
    }

    const apiKey = await this.modelRouter.getApiKey('gemini');
    if (!apiKey) {
      throw new Error('Gemini API key is not configured for embedding generation');
    }

    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: 'text-embedding-004' });

      const result = await model.embedContent(text.trim());
      const values = result.embedding.values;

      if (!values || values.length === 0) {
        throw new Error('Embedding service returned empty vector');
      }

      return values;
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed to generate embedding for query');
      throw new Error(`Embedding generation failed: ${err.message}`);
    }
  }

  /**
   * Batch embed multiple chunks.
   */
  public async batchEmbed(texts: string[], batchSize: number = 20): Promise<number[][]> {
    if (!Array.isArray(texts) || texts.length === 0) return [];

    const apiKey = await this.modelRouter.getApiKey('gemini');
    if (!apiKey) {
      throw new Error('Gemini API key is not configured for batch embedding generation');
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'text-embedding-004' });
    const allEmbeddings: number[][] = [];

    // Process in batches to prevent API rate limits / payload size limits
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      try {
        const result = await model.batchEmbedContents({
          requests: batch.map((t) => ({
            content: { role: 'user', parts: [{ text: t }] },
          })),
        });

        const batchValues = result.embeddings.map((e) => e.values);
        allEmbeddings.push(...batchValues);
      } catch (err: any) {
        logger.error({ err: err.message, batchIndex: i }, 'Batch embedding chunk failure; falling back to individual embeds');
        // Fallback to sequential individual embeds for this batch
        for (const t of batch) {
          const single = await this.embedQuery(t);
          allEmbeddings.push(single);
        }
      }
    }

    return allEmbeddings;
  }
}
