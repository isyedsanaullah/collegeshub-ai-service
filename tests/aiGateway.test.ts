process.env.NODE_ENV = 'test';
process.env.PORT = '4005';
process.env.INTERNAL_SERVICE_SECRET = 'test-secret-at-least-32-characters-long!!';
process.env.INTERNAL_SERVICE_ISSUER = 'collegeshub-core';
process.env.INTERNAL_SERVICE_AUDIENCE = 'collegeshub-ai';
process.env.AI_DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.MASTER_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.OPENROUTER_API_KEY = 'test-openrouter-key';

// Mock Redis client for deterministic testing
const mockRedisSet = jest.fn().mockResolvedValue('OK');
const mockRedisGet = jest.fn().mockResolvedValue(null);
const mockRedisConnect = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/infrastructure/redis', () => ({
  getRedisClient: () => ({
    status: 'ready',
    connect: mockRedisConnect,
    set: mockRedisSet,
    get: mockRedisGet,
  }),
}));

import request from 'supertest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import app from '../src/server';
import { ModelRegistryService, CANONICAL_MODELS } from '../src/modules/models/ModelRegistryService';
import { ModelRouter } from '../src/modules/routing/ModelRouter';
import { CredentialVault } from '../src/security/CredentialVault';

// Helper to generate valid S2S assertion
function generateAssertion(payloadOverrides: Record<string, any> = {}) {
  const secret = process.env.INTERNAL_SERVICE_SECRET!;
  const payload = {
    sub: 'user-test-123',
    collegeId: 'college-test-456',
    role: 'admin',
    planId: 'premium',
    collegeVersion: 1,
    jti: crypto.randomUUID(),
    ...payloadOverrides,
  };

  return jwt.sign(payload, secret, {
    algorithm: 'HS256',
    issuer: process.env.INTERNAL_SERVICE_ISSUER || 'collegeshub-core',
    audience: process.env.INTERNAL_SERVICE_AUDIENCE || 'collegeshub-ai',
    expiresIn: '60s',
  });
}

describe('Phase 4: AI Gateway, Providers & Metering Tests', () => {
  let mockPrisma: any;
  let modelRegistry: ModelRegistryService;
  let modelRouter: ModelRouter;

  beforeEach(() => {
    mockRedisSet.mockResolvedValue('OK');
    mockRedisGet.mockResolvedValue(null);

    mockPrisma = {
      modelDefinition: {
        upsert: jest.fn().mockResolvedValue({ id: 'mod-1' }),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      aIModelPricing: {
        upsert: jest.fn().mockResolvedValue({ id: 'prc-1' }),
        findFirst: jest.fn().mockResolvedValue(null), // trigger canonical fallback
      },
      providerCredential: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };

    modelRegistry = new ModelRegistryService(mockPrisma);
    modelRouter = new ModelRouter(mockPrisma);
  });

  describe('ModelRegistryService', () => {
    it('seeds canonical models and pricing versions', async () => {
      const seeded = await modelRegistry.seedDefaultModels();
      expect(seeded).toBe(CANONICAL_MODELS.length);
      expect(mockPrisma.modelDefinition.upsert).toHaveBeenCalledTimes(CANONICAL_MODELS.length);
      expect(mockPrisma.aIModelPricing.upsert).toHaveBeenCalledTimes(CANONICAL_MODELS.length);
    });

    it('returns canonical active pricing when database row is not present', async () => {
      const rates = await modelRegistry.getActivePricing('gemini-2.0-flash');
      expect(rates.modelKey).toBe('gemini-2.0-flash');
      expect(rates.inputPricePerMillionUsd).toBe(0.075);
      expect(rates.outputPricePerMillionUsd).toBe(0.300);
      expect(rates.cachedInputPricePerMillionUsd).toBe(0.01875);
    });

    it('returns custom database pricing when available', async () => {
      mockPrisma.aIModelPricing.findFirst.mockResolvedValueOnce({
        modelKey: 'gemini-2.0-flash',
        version: 3,
        inputPricePerMillionUsd: 0.080,
        outputPricePerMillionUsd: 0.320,
        cachedInputPricePerMillionUsd: 0.020,
        reasoningPricePerMillionUsd: 0,
      });

      const rates = await modelRegistry.getActivePricing('gemini-2.0-flash');
      expect(rates.version).toBe(3);
      expect(rates.inputPricePerMillionUsd).toBe(0.080);
      expect(rates.outputPricePerMillionUsd).toBe(0.320);
    });
  });

  describe('ModelRouter', () => {
    it('identifies provider correctly from modelKey', () => {
      expect(modelRouter.getProviderForModel('gemini-2.0-flash')).toBe('gemini');
      expect(modelRouter.getProviderForModel('text-embedding-004')).toBe('gemini');
      expect(modelRouter.getProviderForModel('gpt-4o-mini')).toBe('openai');
      expect(modelRouter.getProviderForModel('o1-preview')).toBe('openai');
      expect(modelRouter.getProviderForModel('deepseek/deepseek-chat')).toBe('openrouter');
      expect(modelRouter.getProviderForModel('anthropic/claude-3.5-sonnet')).toBe('openrouter');
    });

    it('resolves routes for canonical platform features', async () => {
      const rawSecret = 'test-gemini-key';
      const encrypted = CredentialVault.encrypt(rawSecret);
      const [, iv, authTag, encryptedKey] = encrypted.split(':');

      mockPrisma.providerCredential.findFirst.mockResolvedValue({
        provider: 'gemini',
        keyVersion: 1,
        iv,
        authTag,
        encryptedKey,
        isActive: true,
      });

      const chatRoute = await modelRouter.resolveRoute('ai-chat');
      expect(chatRoute.modelKey).toBe('gemini-2.0-flash');
      expect(chatRoute.provider).toBe('gemini');
      expect(chatRoute.apiKey).toBe('test-gemini-key');

      const quizRoute = await modelRouter.resolveRoute('quiz-generator');
      expect(quizRoute.modelKey).toBe('gemini-2.0-flash');
      expect(quizRoute.fallbackModelKey).toBe('gpt-4o-mini');
    });

    it('decrypts encrypted database provider credential when present', async () => {
      const rawSecret = 'sk-prod-db-gemini-key-999';
      const encrypted = CredentialVault.encrypt(rawSecret);
      const [, iv, authTag, encryptedKey] = encrypted.split(':');

      mockPrisma.providerCredential.findFirst.mockResolvedValueOnce({
        provider: 'gemini',
        keyVersion: 1,
        iv,
        authTag,
        encryptedKey,
        isActive: true,
      });

      const apiKey = await modelRouter.getApiKey('gemini');
      expect(apiKey).toBe(rawSecret);
    });
  });

  describe('Chat Endpoints Integration', () => {
    it('rejects unauthenticated requests without S2S assertion', async () => {
      const res = await request(app)
        .post('/internal/v1/chat/completions')
        .send({
          featureKey: 'ai-chat',
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('MISSING_SERVICE_ASSERTION');
    });

    it('rejects requests with empty messages array', async () => {
      const token = generateAssertion();
      const res = await request(app)
        .post('/internal/v1/chat/completions')
        .set('x-collegeshub-assertion', token)
        .send({
          featureKey: 'ai-chat',
          messages: [],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_MESSAGES');
    });
  });
});
