import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { getPrismaClient } from '../../infrastructure/database';
import { getEnv } from '../../config/env';
import { CredentialVault } from '../../security/CredentialVault';
import { AIProviderAdapter } from '../providers/types';
import { GeminiAdapter } from '../providers/GeminiAdapter';
import { OpenRouterAdapter } from '../providers/OpenRouterAdapter';
import { OpenAIAdapter } from '../providers/OpenAIAdapter';

const env = getEnv();
const logger = pino({ level: env.LOG_LEVEL });

export interface ResolvedRoute {
  featureKey: string;
  modelKey: string;
  fallbackModelKey?: string;
  provider: 'gemini' | 'openai' | 'openrouter';
  adapter: AIProviderAdapter;
  apiKey: string;
}

export class ModelRouter {
  private prisma: PrismaClient;
  private geminiAdapter: GeminiAdapter;
  private openRouterAdapter: OpenRouterAdapter;
  private openAIAdapter: OpenAIAdapter;

  constructor(prismaClient?: PrismaClient) {
    this.prisma = prismaClient || getPrismaClient();
    this.geminiAdapter = new GeminiAdapter();
    this.openRouterAdapter = new OpenRouterAdapter();
    this.openAIAdapter = new OpenAIAdapter();
  }

  /**
   * Determine the provider from the modelKey.
   */
  public getProviderForModel(modelKey: string): 'gemini' | 'openai' | 'openrouter' {
    if (modelKey.startsWith('gemini') || modelKey.includes('embedding')) return 'gemini';
    if (modelKey.startsWith('gpt') || modelKey.startsWith('o1') || modelKey.startsWith('o3')) return 'openai';
    return 'openrouter';
  }

  /**
   * Get the provider adapter instance.
   */
  public getAdapter(provider: 'gemini' | 'openai' | 'openrouter'): AIProviderAdapter {
    switch (provider) {
      case 'gemini':
        return this.geminiAdapter;
      case 'openai':
        return this.openAIAdapter;
      case 'openrouter':
        return this.openRouterAdapter;
    }
  }

  /**
   * Retrieve the active decrypted API key for a provider.
   * Checks database credentials first; falls back to environment variables.
   */
  public async getApiKey(provider: 'gemini' | 'openai' | 'openrouter'): Promise<string> {
    try {
      const cred = await this.prisma.providerCredential.findFirst({
        where: { provider, isActive: true },
        orderBy: [{ isPrimary: 'desc' }, { updatedAt: 'desc' }],
      });

      if (cred) {
        // Construct serialized envelope string
        const serialized = `v${cred.keyVersion}:${cred.iv}:${cred.authTag}:${cred.encryptedKey}`;
        return CredentialVault.decrypt(serialized);
      }
    } catch (err: any) {
      logger.warn({ provider, err: err.message }, 'Failed to decrypt provider credential from database; using env fallback');
    }

    // Environment fallback
    switch (provider) {
      case 'gemini':
        return env.GEMINI_API_KEY || '';
      case 'openai':
        return env.OPENAI_API_KEY || '';
      case 'openrouter':
        return env.OPENROUTER_API_KEY || '';
    }
  }

  /**
   * Resolve execution route for a given feature key.
   */
  public async resolveRoute(featureKey: string): Promise<ResolvedRoute> {
    // Feature default routes
    const featureDefaults: Record<string, { model: string; fallback?: string }> = {
      'ai-chat': { model: 'gemini-2.0-flash', fallback: 'deepseek/deepseek-chat' },
      'student-tutor': { model: 'gemini-2.5-flash-lite', fallback: 'gemini-2.0-flash' },
      'quiz-generator': { model: 'gemini-2.0-flash', fallback: 'gpt-4o-mini' },
      'lesson-planner': { model: 'gemini-2.5-flash-lite', fallback: 'gemini-2.0-flash' },
      'document-rag': { model: 'gemini-2.0-flash', fallback: 'gpt-4o-mini' },
      'vision-ocr': { model: 'gemini-2.0-flash', fallback: 'gpt-4o-mini' },
    };

    const route = featureDefaults[featureKey] || { model: 'gemini-2.0-flash', fallback: 'deepseek/deepseek-chat' };
    const provider = this.getProviderForModel(route.model);
    const adapter = this.getAdapter(provider);
    const apiKey = await this.getApiKey(provider);

    if (!apiKey) {
      throw new Error(`No active API key configured for provider '${provider}' to execute feature '${featureKey}'`);
    }

    return {
      featureKey,
      modelKey: route.model,
      fallbackModelKey: route.fallback,
      provider,
      adapter,
      apiKey,
    };
  }
}

