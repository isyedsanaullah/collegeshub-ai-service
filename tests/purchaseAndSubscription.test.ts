// Test environment configuration
process.env.INTERNAL_SERVICE_SECRET = 'test-secret-at-least-32-characters-long!!';
process.env.AI_DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.MASTER_ENCRYPTION_KEY = '12345678901234567890123456789012';

import { PackageService, CANONICAL_PACKAGES } from '../src/modules/purchases/PackageService';
import { PurchaseAllocationService } from '../src/modules/purchases/PurchaseAllocationService';
import { SubscriptionSyncService } from '../src/modules/billing/SubscriptionSyncService';

describe('Phase 3: Purchase & Subscription Lifecycle Tests', () => {
  let mockPrisma: any;
  let packageService: PackageService;
  let purchaseAllocationService: PurchaseAllocationService;
  let subscriptionSyncService: SubscriptionSyncService;

  beforeEach(() => {
    mockPrisma = {
      $transaction: jest.fn().mockImplementation(async (callback) => {
        return await callback(mockPrisma);
      }),
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'w-1' }]),
      $executeRaw: jest.fn().mockResolvedValue(1),
      aIAddonPackage: {
        upsert: jest.fn().mockResolvedValue({ id: 'pkg-1' }),
        findMany: jest.fn().mockResolvedValue(CANONICAL_PACKAGES.map((p, i) => ({ id: `p-${i}`, ...p }))),
        findFirst: jest.fn().mockResolvedValue({ id: 'p-1', ...CANONICAL_PACKAGES[0] }),
      },
      aICreditGrant: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'grant-mock-1', ...data })),
      },
      collegeAIWallet: {
        findUnique: jest.fn(),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'w-1', ...data })),
      },
      aICreditLedgerEntry: {
        create: jest.fn().mockResolvedValue({ id: 'ledger-mock-1' }),
      },
    };

    packageService = new PackageService(mockPrisma);
    purchaseAllocationService = new PurchaseAllocationService(mockPrisma);
    subscriptionSyncService = new SubscriptionSyncService(mockPrisma);
  });

  describe('PackageService', () => {
    test('Seeds canonical packages successfully', async () => {
      const count = await packageService.seedDefaultPackages();
      expect(count).toBe(3);
      expect(mockPrisma.aIAddonPackage.upsert).toHaveBeenCalledTimes(3);
    });

    test('Lists active packages', async () => {
      const packages = await packageService.listActivePackages();
      expect(packages.length).toBe(3);
      expect(packages[0].code).toBe('AI_TOKENS_1M');
    });
  });

  describe('PurchaseAllocationService & Idempotency', () => {
    test('Allocates approved purchase credits into college wallet and writes ledger', async () => {
      mockPrisma.aICreditGrant.findUnique.mockResolvedValueOnce(null); // Not already granted
      mockPrisma.collegeAIWallet.findUnique.mockResolvedValueOnce({
        id: 'w-1',
        collegeId: 'c-1',
        balance: 10_000n,
        totalAllocated: 10_000n,
      });

      const result = await purchaseAllocationService.allocateApprovedPurchase({
        purchaseRequestId: 'pr-1001',
        collegeId: 'c-1',
        credits: 1_000_000n,
        packageCode: 'AI_TOKENS_1M',
        amountPkr: 500,
        receiptNumber: 'RCP-2026-00042',
        approvedByUserId: 'admin-super-1',
      });

      expect(result.status).toBe('SUCCESS');
      expect(result.credits).toBe(1_000_000n);
      expect(result.balanceAfter).toBe(1_010_000n);
      expect(mockPrisma.aICreditGrant.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            source: 'PURCHASED',
            originalAmount: 1_000_000n,
            expiresAt: null, // Purchased credits do not expire!
            purchaseRequestId: 'pr-1001',
          }),
        })
      );
      expect(mockPrisma.aICreditLedgerEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'GRANT_PURCHASED',
            amount: 1_000_000n,
          }),
        })
      );
    });

    test('Strict Idempotency: Returns existing grant without minting duplicate credits on repeated approval', async () => {
      // Simulate existing grant found
      mockPrisma.aICreditGrant.findUnique.mockResolvedValueOnce({
        id: 'existing-grant-99',
        purchaseRequestId: 'pr-1001',
        originalAmount: 1_000_000n,
        remainingAmount: 1_000_000n,
      });
      mockPrisma.collegeAIWallet.findUnique.mockResolvedValueOnce({
        id: 'w-1',
        collegeId: 'c-1',
        balance: 1_010_000n,
      });

      const result = await purchaseAllocationService.allocateApprovedPurchase({
        purchaseRequestId: 'pr-1001',
        collegeId: 'c-1',
        credits: 1_000_000n,
        packageCode: 'AI_TOKENS_1M',
        amountPkr: 500,
      });

      expect(result.status).toBe('ALREADY_ALLOCATED');
      expect(result.grantId).toBe('existing-grant-99');
      // No duplicate credit creation should occur
      expect(mockPrisma.aICreditGrant.create).not.toHaveBeenCalled();
      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
    });
  });

  describe('SubscriptionSyncService & Monthly Allowances', () => {
    test('Starter plan receives no monthly AI allowance', async () => {
      const result = await subscriptionSyncService.syncMonthlyPlanGrant({
        collegeId: 'c-starter',
        planId: 'starter',
        billingCycle: '2026-11',
        periodStart: new Date(),
        periodEnd: new Date(Date.now() + 30 * 86400000),
      });

      expect(result.status).toBe('NO_ALLOWANCE');
      expect(result.creditsGranted).toBe(0n);
      expect(mockPrisma.aICreditGrant.create).not.toHaveBeenCalled();
    });

    test('Standard plan receives 1,000,000 monthly credits expiring at periodEnd', async () => {
      mockPrisma.aICreditGrant.findFirst.mockResolvedValueOnce(null); // Not already synced
      mockPrisma.collegeAIWallet.findUnique.mockResolvedValueOnce({
        id: 'w-standard',
        collegeId: 'c-standard',
        balance: 0n,
        totalAllocated: 0n,
      });

      const periodEnd = new Date(Date.now() + 30 * 86400000);
      const result = await subscriptionSyncService.syncMonthlyPlanGrant({
        collegeId: 'c-standard',
        planId: 'standard',
        billingCycle: '2026-11',
        periodStart: new Date(),
        periodEnd,
      });

      expect(result.status).toBe('SUCCESS');
      expect(result.creditsGranted).toBe(1_000_000n);
      expect(result.expiresAt).toEqual(periodEnd);

      expect(mockPrisma.aICreditGrant.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            source: 'SUBSCRIPTION',
            originalAmount: 1_000_000n,
            expiresAt: periodEnd,
            billingCycle: '2026-11',
          }),
        })
      );
    });

    test('Premium plan receives 5,000,000 monthly credits', async () => {
      mockPrisma.aICreditGrant.findFirst.mockResolvedValueOnce(null);
      mockPrisma.collegeAIWallet.findUnique.mockResolvedValueOnce({
        id: 'w-premium',
        collegeId: 'c-prem',
        balance: 0n,
        totalAllocated: 0n,
      });

      const result = await subscriptionSyncService.syncMonthlyPlanGrant({
        collegeId: 'c-prem',
        planId: 'premium',
        billingCycle: '2026-11',
        periodStart: new Date(),
        periodEnd: new Date(Date.now() + 30 * 86400000),
      });

      expect(result.status).toBe('SUCCESS');
      expect(result.creditsGranted).toBe(5_000_000n);
    });

    test('Enterprise plan receives 40,000,000 monthly credits', async () => {
      mockPrisma.aICreditGrant.findFirst.mockResolvedValueOnce(null);
      mockPrisma.collegeAIWallet.findUnique.mockResolvedValueOnce({
        id: 'w-ent',
        collegeId: 'c-ent',
        balance: 0n,
        totalAllocated: 0n,
      });

      const result = await subscriptionSyncService.syncMonthlyPlanGrant({
        collegeId: 'c-ent',
        planId: 'enterprise',
        billingCycle: '2026-11',
        periodStart: new Date(),
        periodEnd: new Date(Date.now() + 30 * 86400000),
      });

      expect(result.status).toBe('SUCCESS');
      expect(result.creditsGranted).toBe(40_000_000n);
    });

    test('Idempotency: Re-syncing the same billing cycle returns ALREADY_SYNCED without duplicate grant', async () => {
      mockPrisma.aICreditGrant.findFirst.mockResolvedValueOnce({
        id: 'grant-existing-cycle',
        collegeId: 'c-standard',
        billingCycle: '2026-11',
        originalAmount: 1_000_000n,
      });

      const result = await subscriptionSyncService.syncMonthlyPlanGrant({
        collegeId: 'c-standard',
        planId: 'standard',
        billingCycle: '2026-11',
        periodStart: new Date(),
        periodEnd: new Date(Date.now() + 30 * 86400000),
      });

      expect(result.status).toBe('ALREADY_SYNCED');
      expect(result.grantId).toBe('grant-existing-cycle');
      expect(mockPrisma.aICreditGrant.create).not.toHaveBeenCalled();
    });
  });
});
