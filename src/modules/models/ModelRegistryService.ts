import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { getPrismaClient } from '../../infrastructure/database';
import { getEnv } from '../../config/env';
import { ModelPricingRates } from '../credits/PricingEngine';

const env = getEnv();
const logger = pino({ level: env.LOG_LEVEL });

export interface CanonicalModelSeed {
  modelKey: string;
  provider: 'gemini' | 'openai' | 'openrouter';
  name: string;
  capabilities: string[];
  contextWindow: number;
  maxOutputTokens: number;
  rates: {
    inputPricePerMillionUsd: number;
    outputPricePerMillionUsd: number;
    cachedInputPricePerMillionUsd?: number;
    reasoningPricePerMillionUsd?: number;
  };
}

export const CANONICAL_MODELS: CanonicalModelSeed[] = [
  {
    modelKey: 'gemini-2.0-flash',
    provider: 'gemini',
    name: 'Google Gemini 2.0 Flash',
    capabilities: ['chat', 'stream', 'vision', 'json'],
    contextWindow: 1_048_576,
    maxOutputTokens: 8_192,
    rates: {
      inputPricePerMillionUsd: 0.075,
      outputPricePerMillionUsd: 0.300,
      cachedInputPricePerMillionUsd: 0.01875,
    },
  },
  {
    modelKey: 'gemini-2.5-flash-lite',
    provider: 'gemini',
    name: 'Google Gemini 2.5 Flash Lite',
    capabilities: ['chat', 'stream', 'json'],
    contextWindow: 1_048_576,
    maxOutputTokens: 4_096,
    rates: {
      inputPricePerMillionUsd: 0.050,
      outputPricePerMillionUsd: 0.200,
    },
  },
  {
    modelKey: 'gemini-1.5-pro',
    provider: 'gemini',
    name: 'Google Gemini 1.5 Pro',
    capabilities: ['chat', 'stream', 'vision', 'reasoning', 'json'],
    contextWindow: 2_097_152,
    maxOutputTokens: 8_192,
    rates: {
      inputPricePerMillionUsd: 1.250,
      outputPricePerMillionUsd: 5.000,
    },
  },
  {
    modelKey: 'deepseek/deepseek-chat',
    provider: 'openrouter',
    name: 'DeepSeek V3 (via OpenRouter)',
    capabilities: ['chat', 'stream', 'json'],
    contextWindow: 64_000,
    maxOutputTokens: 8_192,
    rates: {
      inputPricePerMillionUsd: 0.140,
      outputPricePerMillionUsd: 0.280,
    },
  },
  {
    modelKey: 'gpt-4o-mini',
    provider: 'openai',
    name: 'OpenAI GPT-4o-mini',
    capabilities: ['chat', 'stream', 'vision', 'json'],
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    rates: {
      inputPricePerMillionUsd: 0.150,
      outputPricePerMillionUsd: 0.600,
    },
  },
  {
    modelKey: 'text-embedding-004',
    provider: 'gemini',
    name: 'Google Text Embedding 004',
    capabilities: ['embeddings'],
    contextWindow: 2_048,
    maxOutputTokens: 0,
    rates: {
      inputPricePerMillionUsd: 0.020,
      outputPricePerMillionUsd: 0.000,
    },
  },
];

export class ModelRegistryService {
  private prisma: PrismaClient;

  constructor(prismaClient?: PrismaClient) {
    this.prisma = prismaClient || getPrismaClient();
  }

  /**
   * Seed canonical model definitions and versioned pricing records.
   */
  public async seedDefaultModels(): Promise<number> {
    let count = 0;

    for (const model of CANONICAL_MODELS) {
      await this.prisma.modelDefinition.upsert({
        where: { modelKey: model.modelKey },
        update: {
          name: model.name,
          provider: model.provider,
          capabilities: model.capabilities,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          isActive: true,
        },
        create: {
          modelKey: model.modelKey,
          name: model.name,
          provider: model.provider,
          capabilities: model.capabilities,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          isActive: true,
        },
      });

      // Seed version 1 pricing
      await this.prisma.aIModelPricing.upsert({
        where: {
          modelKey_version: {
            modelKey: model.modelKey,
            version: 1,
          },
        },
        update: {
          inputPricePerMillionUsd: model.rates.inputPricePerMillionUsd,
          outputPricePerMillionUsd: model.rates.outputPricePerMillionUsd,
          cachedInputPricePerMillionUsd: model.rates.cachedInputPricePerMillionUsd || 0,
          reasoningPricePerMillionUsd: model.rates.reasoningPricePerMillionUsd || 0,
        },
        create: {
          modelKey: model.modelKey,
          version: 1,
          inputPricePerMillionUsd: model.rates.inputPricePerMillionUsd,
          outputPricePerMillionUsd: model.rates.outputPricePerMillionUsd,
          cachedInputPricePerMillionUsd: model.rates.cachedInputPricePerMillionUsd || 0,
          reasoningPricePerMillionUsd: model.rates.reasoningPricePerMillionUsd || 0,
        },
      });

      count++;
    }

    logger.info({ count }, 'Canonical AI models and pricing seeded successfully');
    return count;
  }

  /**
   * Retrieve active pricing rates for a model.
   * Falls back to canonical in-memory rates if DB row is not yet initialized.
   */
  public async getActivePricing(modelKey: string): Promise<ModelPricingRates> {
    const canonical = CANONICAL_MODELS.find((m) => m.modelKey === modelKey);

    try {
      const pricing = await this.prisma.aIModelPricing.findFirst({
        where: { modelKey, effectiveTo: null },
        orderBy: { version: 'desc' },
      });

      if (pricing) {
        return {
          modelKey: pricing.modelKey,
          version: pricing.version,
          inputPricePerMillionUsd: Number(pricing.inputPricePerMillionUsd),
          outputPricePerMillionUsd: Number(pricing.outputPricePerMillionUsd),
          cachedInputPricePerMillionUsd: Number(pricing.cachedInputPricePerMillionUsd),
          reasoningPricePerMillionUsd: Number(pricing.reasoningPricePerMillionUsd),
        };
      }
    } catch {
      // Fallback
    }

    if (canonical) {
      return {
        modelKey: canonical.modelKey,
        version: 1,
        inputPricePerMillionUsd: canonical.rates.inputPricePerMillionUsd,
        outputPricePerMillionUsd: canonical.rates.outputPricePerMillionUsd,
        cachedInputPricePerMillionUsd: canonical.rates.cachedInputPricePerMillionUsd,
        reasoningPricePerMillionUsd: canonical.rates.reasoningPricePerMillionUsd,
      };
    }

    // Default ultra-safe fallback
    return {
      modelKey,
      version: 1,
      inputPricePerMillionUsd: 0.10,
      outputPricePerMillionUsd: 0.40,
    };
  }
}
