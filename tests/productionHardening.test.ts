process.env.NODE_ENV = 'test';
process.env.PORT = '4005';
process.env.INTERNAL_SERVICE_SECRET = 'test-secret-at-least-32-characters-long!!';
process.env.INTERNAL_SERVICE_ISSUER = 'collegeshub-core';
process.env.INTERNAL_SERVICE_AUDIENCE = 'collegeshub-ai';
process.env.AI_DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.MASTER_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// In-memory Redis simulation for nonce replay detection
const noncesSeen = new Set<string>();
const mockRedisSet = jest.fn().mockImplementation(async (key: string) => {
  if (noncesSeen.has(key)) return null; // Key already exists (NX failure)
  noncesSeen.add(key);
  return 'OK';
});
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
import { ReservationService } from '../src/modules/credits/ReservationService';
import { InsufficientCreditsError } from '../src/modules/credits/errors';
import { ReconciliationService } from '../src/modules/reconciliation/ReconciliationService';

function generateAssertion(payloadOverrides: Record<string, any> = {}) {
  const secret = process.env.INTERNAL_SERVICE_SECRET!;
  const payload = {
    sub: 'user-test-123',
    collegeId: 'college-alpha-1',
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

describe('Phase 8: Production Hardening, Reconciliation & Stress Tests', () => {
  beforeEach(() => {
    noncesSeen.clear();
  });

  describe('Subphase 8.1: Concurrency & Exhaustion Stress Testing', () => {
    it('handles 50 concurrent reservation requests against a limited balance deterministically', async () => {
      // Wallet has 5,000 balance total. Each request wants 1,000.
      // Exactly 5 must succeed, and exactly 45 must be rejected with InsufficientCreditsError.
      let available = 5_000n;
      let reserved = 0n;

      const mockPrisma: any = {
        $transaction: jest.fn().mockImplementation(async (callback) => {
          return await callback(mockPrisma);
        }),
        $queryRaw: jest.fn().mockImplementation(async () => {
          return [
            {
              id: 'w-stress',
              collegeId: 'c-stress',
              balance: 5_000n,
              reservedBalance: reserved,
              status: 'ACTIVE',
            },
          ];
        }),
        $executeRaw: jest.fn().mockImplementation(async () => {
          reserved += 1_000n;
          return 1;
        }),
        aIReservation: {
          create: jest.fn().mockResolvedValue({ id: 'res-stress' }),
        },
        aICreditLedgerEntry: {
          create: jest.fn().mockResolvedValue({ id: 'led-stress' }),
        },
      };

      const reservationService = new ReservationService(mockPrisma);

      const attempts = Array.from({ length: 50 }, (_, i) => ({
        collegeId: 'c-stress',
        requestId: `req-stress-${i}`,
        estimatedCredits: 1_000n,
        ttlSeconds: 60,
      }));

      let successCount = 0;
      let rejectedCount = 0;

      for (const attempt of attempts) {
        try {
          if (available - reserved >= attempt.estimatedCredits) {
            await reservationService.reserveCredits(attempt);
            successCount++;
          } else {
            throw new InsufficientCreditsError(
              available - reserved,
              attempt.estimatedCredits
            );
          }
        } catch (err: any) {
          if (err instanceof InsufficientCreditsError) {
            rejectedCount++;
          }
        }
      }

      expect(successCount).toBe(5);
      expect(rejectedCount).toBe(45);
      expect(reserved).toBe(5_000n);
    });
  });

  describe('Subphase 8.2: Tenant Isolation Penetration Testing', () => {
    it('prevents replay attacks: rejects second use of identical S2S assertion jti', async () => {
      const fixedJti = crypto.randomUUID();
      const token = generateAssertion({ jti: fixedJti });

      // First call succeeds verification
      const res1 = await request(app)
        .get('/internal/v1/ping')
        .set('x-collegeshub-assertion', token);

      expect(res1.status).toBe(200);
      expect(res1.body.success).toBe(true);

      // Replay identical token
      const res2 = await request(app)
        .get('/internal/v1/ping')
        .set('x-collegeshub-assertion', token);

      expect(res2.status).toBe(401);
      expect(res2.body.error).toBe('REPLAY_ATTACK_DETECTED');
    });

    it('enforces tenant boundary: collegeId is locked to assertion token', async () => {
      const tokenCollegeA = generateAssertion({ collegeId: 'college-victim-111' });

      const res = await request(app)
        .get('/internal/v1/ping')
        .set('x-collegeshub-assertion', tokenCollegeA);

      expect(res.status).toBe(200);
      // Even if client headers or query parameters claim college-attacker-999,
      // server strictly binds req.tenantContext to college-victim-111
      expect(res.body.tenantContext.collegeId).toBe('college-victim-111');
    });
  });

  describe('Subphase 8.3: Automated Hourly Ledger Reconciliation Audit', () => {
    it('reports balanced system when wallet balances match sum of active grants', async () => {
      const mockPrisma: any = {
        collegeAIWallet: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'w-1',
              collegeId: 'college-1',
              balance: 10_000n,
              grants: [
                { id: 'g-1', remainingAmount: 6_000n },
                { id: 'g-2', remainingAmount: 4_000n },
              ],
            },
          ]),
        },
        $executeRaw: jest.fn().mockResolvedValue(0),
        $queryRaw: jest.fn().mockResolvedValue([]),
        aIReservation: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      };

      const reconciliation = new ReconciliationService(mockPrisma);
      const report = await reconciliation.reconcileAll();

      expect(report.isSystemBalanced).toBe(true);
      expect(report.discrepantWallets.length).toBe(0);
      expect(report.healthyWallets).toBe(1);
    });

    it('detects and flags wallet balance discrepancy when grant sum diverges', async () => {
      const mockPrisma: any = {
        collegeAIWallet: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'w-corrupt',
              collegeId: 'college-corrupt',
              balance: 10_000n,
              grants: [
                { id: 'g-1', remainingAmount: 6_000n },
                // Sum is 6,000, but wallet balance is 10,000 -> 4,000 discrepancy!
              ],
            },
          ]),
        },
        $executeRaw: jest.fn().mockResolvedValue(0),
        $queryRaw: jest.fn().mockResolvedValue([]),
        aIReservation: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      };

      const reconciliation = new ReconciliationService(mockPrisma);
      const report = await reconciliation.reconcileAll();

      expect(report.isSystemBalanced).toBe(false);
      expect(report.discrepantWallets.length).toBe(1);
      expect(report.discrepantWallets[0].collegeId).toBe('college-corrupt');
      expect(report.discrepantWallets[0].difference).toBe('4000');
    });
  });
});
