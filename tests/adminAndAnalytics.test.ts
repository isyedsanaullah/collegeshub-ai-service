process.env.NODE_ENV = 'test';
process.env.PORT = '4005';
process.env.INTERNAL_SERVICE_SECRET = 'test-secret-at-least-32-characters-long!!';
process.env.INTERNAL_SERVICE_ISSUER = 'collegeshub-core';
process.env.INTERNAL_SERVICE_AUDIENCE = 'collegeshub-ai';
process.env.AI_DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.MASTER_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

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

const mockPrisma: any = {
  aIRequestLog: {
    aggregate: jest.fn().mockResolvedValue({
      _sum: {
        creditsDebited: 1_000_000n,
        providerCostMicros: 120_000n, // $0.12 USD
      },
    }),
  },
  aICreditPurchaseRequest: {
    aggregate: jest.fn().mockResolvedValue({
      _sum: {
        credits: 1_000_000n,
        amountPkr: 500, // 500 PKR / 280 ≈ $1.7857 USD
      },
    }),
  },
  collegeAIWallet: {
    count: jest.fn().mockResolvedValue(12),
    findUnique: jest.fn().mockResolvedValue({
      id: 'w-1',
      collegeId: 'college-test-456',
      balance: 850_000n,
      reservedBalance: 50_000n,
      totalAllocated: 1_000_000n,
      totalConsumed: 150_000n,
      status: 'ACTIVE',
      grants: [
        {
          id: 'g-1',
          source: 'SUBSCRIPTION',
          originalAmount: 1_000_000n,
          remainingAmount: 850_000n,
          billingCycle: '2026-11',
          expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // 3 days
          createdAt: new Date(),
        },
      ],
    }),
  },
  aICreditLedgerEntry: {
    findMany: jest.fn().mockResolvedValue([
      {
        id: 'led-1',
        type: 'SETTLE',
        amount: -150n,
        balanceAfter: 850_000n,
        description: 'AI chat streaming settlement',
        requestId: 'req-1',
        metadata: null,
        createdAt: new Date(),
      },
    ]),
    count: jest.fn().mockResolvedValue(1),
  },
  globalAISetting: {
    upsert: jest.fn().mockResolvedValue({
      key: 'GLOBAL_AI_KILL_SWITCH',
      value: { enabled: true, reason: 'Maintenance' },
    }),
  },
  providerCredential: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    create: jest.fn().mockResolvedValue({
      id: 'cred-1',
      provider: 'gemini',
      keyHint: '...1234',
      keyVersion: 1,
      isPrimary: true,
      createdAt: new Date(),
    }),
  },
  modelDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { modelKey: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', pricingHistory: [] },
    ]),
  },
};

jest.mock('../src/infrastructure/database', () => ({
  getPrismaClient: () => mockPrisma,
  isDatabaseHealthy: jest.fn().mockResolvedValue(true),
}));

import request from 'supertest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import app from '../src/server';
import { FinancialAnalyticsService } from '../src/modules/analytics/FinancialAnalyticsService';

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

describe('Phase 7: Administration, College Dashboards & Analytics Tests', () => {
  let analyticsService: FinancialAnalyticsService;

  beforeEach(() => {
    analyticsService = new FinancialAnalyticsService(mockPrisma);
  });

  describe('FinancialAnalyticsService Gross Compute Margin', () => {
    it('calculates platform revenue, provider cost, and gross compute margin % correctly', async () => {
      const summary = await analyticsService.getPlatformFinancialSummary();

      expect(summary.activeCollegesCount).toBe(12);
      expect(summary.totalProviderCostUsd).toBe(0.12);
      expect(summary.totalRevenueUsd).toBeCloseTo(1.79, 1);
      // Compute cost $0.12 vs revenue $1.7857 => ~93.28% margin
      expect(summary.grossComputeMarginPercent).toBeGreaterThan(90);
    });

    it('calculates college usage summary and identifies expiring grants', async () => {
      const summary = await analyticsService.getCollegeUsageSummary('college-test-456');

      expect(summary.walletBalance).toBe('850000');
      expect(summary.activeGrantsCount).toBe(1);
      expect(summary.expiringSoonCredits).toBe('850000');
    });
  });

  describe('Wallet Routes', () => {
    it('returns wallet summary for authenticated college', async () => {
      const token = generateAssertion({ role: 'admin' });
      const res = await request(app)
        .get('/internal/v1/wallet/summary')
        .set('x-collegeshub-assertion', token);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.collegeId).toBe('college-test-456');
    });

    it('returns active grants list for authenticated college', async () => {
      const token = generateAssertion({ role: 'admin' });
      const res = await request(app)
        .get('/internal/v1/wallet/grants')
        .set('x-collegeshub-assertion', token);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.grants)).toBe(true);
    });

    it('returns paginated ledger audit entries for authenticated college', async () => {
      const token = generateAssertion({ role: 'admin' });
      const res = await request(app)
        .get('/internal/v1/wallet/ledger?page=1&limit=10')
        .set('x-collegeshub-assertion', token);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.entries)).toBe(true);
      expect(res.body.pagination.totalCount).toBe(1);
    });
  });

  describe('Admin Control & Role Security', () => {
    it('rejects kill-switch requests from regular admin role (403 Forbidden)', async () => {
      const token = generateAssertion({ role: 'admin' });
      const res = await request(app)
        .post('/internal/v1/admin/kill-switch')
        .set('x-collegeshub-assertion', token)
        .send({ enabled: true });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('SUPER_ADMIN_REQUIRED');
    });

    it('allows kill-switch requests from superAdmin role', async () => {
      const token = generateAssertion({ role: 'superAdmin' });
      const res = await request(app)
        .post('/internal/v1/admin/kill-switch')
        .set('x-collegeshub-assertion', token)
        .send({ enabled: true, reason: 'Emergency security audit' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('allows superAdmin to save encrypted provider credential in vault', async () => {
      const token = generateAssertion({ role: 'superAdmin' });
      const res = await request(app)
        .post('/internal/v1/admin/credentials')
        .set('x-collegeshub-assertion', token)
        .send({
          provider: 'gemini',
          apiKey: 'sk-test-live-gemini-key-1234',
          isPrimary: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.provider).toBe('gemini');
    });

    it('allows superAdmin to retrieve platform financial summary', async () => {
      const token = generateAssertion({ role: 'superAdmin' });
      const res = await request(app)
        .get('/internal/v1/analytics/summary')
        .set('x-collegeshub-assertion', token);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.summary).toBeDefined();
    });
  });
});
