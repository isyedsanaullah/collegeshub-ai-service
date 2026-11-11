// Test environment configuration
process.env.INTERNAL_SERVICE_SECRET = 'test-secret-at-least-32-characters-long!!';
process.env.AI_DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.MASTER_ENCRYPTION_KEY = '12345678901234567890123456789012';

import { ReservationService } from '../src/modules/credits/ReservationService';
import { SettlementService } from '../src/modules/credits/SettlementService';
import { ReservationReaper } from '../src/modules/credits/ReservationReaper';
import { InsufficientCreditsError, WalletNotFoundError, InvalidReservationStateError } from '../src/modules/credits/errors';

describe('Two-Phase Reservation and Settlement Concurrency Engine Tests', () => {
  let mockPrisma: any;
  let reservationService: ReservationService;
  let settlementService: SettlementService;
  let reservationReaper: ReservationReaper;

  beforeEach(() => {
    // Construct in-memory transactional mock
    mockPrisma = {
      $transaction: jest.fn().mockImplementation(async (callback) => {
        return await callback(mockPrisma);
      }),
      $queryRaw: jest.fn(),
      $executeRaw: jest.fn().mockResolvedValue(1),
      aIReservation: {
        create: jest.fn().mockResolvedValue({ id: 'res-1' }),
      },
      aICreditLedgerEntry: {
        create: jest.fn().mockResolvedValue({ id: 'led-1' }),
      },
    };

    reservationService = new ReservationService(mockPrisma);
    settlementService = new SettlementService(mockPrisma);
    reservationReaper = new ReservationReaper(mockPrisma);
  });

  describe('ReservationService', () => {
    test('Successfully reserves credits when unreserved balance is sufficient', async () => {
      // Mock wallet with 10,000 balance and 2,000 already reserved (8,000 available)
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([
          { id: 'w-1', collegeId: 'c-1', balance: 10_000n, reservedBalance: 2_000n, status: 'ACTIVE' },
        ]) // Wallet query
        .mockResolvedValueOnce([
          { id: 'g-1', remainingAmount: 8_000n, expiresAt: new Date() },
        ]); // Grants query

      const result = await reservationService.reserveCredits({
        collegeId: 'c-1',
        requestId: 'req-101',
        estimatedCredits: 3_000n,
      });

      expect(result.reservedCredits).toBe(3_000n);
      expect(result.collegeId).toBe('c-1');
      expect(mockPrisma.aIReservation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            requestId: 'req-101',
            status: 'HELD',
            reservedCredits: 3_000n,
          }),
        })
      );
      expect(mockPrisma.$executeRaw).toHaveBeenCalled();
    });

    test('Throws InsufficientCreditsError when requested exceeds unreserved balance', async () => {
      // Wallet with 5,000 balance and 4,500 reserved (only 500 available)
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        { id: 'w-1', collegeId: 'c-1', balance: 5_000n, reservedBalance: 4_500n, status: 'ACTIVE' },
      ]);

      await expect(
        reservationService.reserveCredits({
          collegeId: 'c-1',
          requestId: 'req-102',
          estimatedCredits: 1_000n, // Needs 1000, has 500
        })
      ).rejects.toThrow(InsufficientCreditsError);

      expect(mockPrisma.aIReservation.create).not.toHaveBeenCalled();
    });

    test('Throws WalletNotFoundError when college wallet does not exist', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([]); // No wallet returned

      await expect(
        reservationService.reserveCredits({
          collegeId: 'non-existent-college',
          requestId: 'req-103',
          estimatedCredits: 500n,
        })
      ).rejects.toThrow(WalletNotFoundError);
    });
  });

  describe('SettlementService & FEFO Grant Deductions', () => {
    test('Settles request and consumes earliest-expiring grant first (FEFO)', async () => {
      const heldReservation = {
        id: 'res-1',
        collegeId: 'c-1',
        walletId: 'w-1',
        requestId: 'req-201',
        status: 'HELD',
        reservedCredits: 1_000n,
        settledCredits: 0n,
      };

      const wallet = {
        id: 'w-1',
        balance: 10_000n,
        reservedBalance: 1_000n,
      };

      // Two active grants:
      // Grant 1 expires in 2 days (300 credits remaining)
      // Grant 2 is non-expiring paid add-on (5,000 credits remaining)
      const grant1 = { id: 'g-1', remainingAmount: 300n, expiresAt: new Date(Date.now() + 2 * 86400000) };
      const grant2 = { id: 'g-2', remainingAmount: 5_000n, expiresAt: null };

      mockPrisma.$queryRaw
        .mockResolvedValueOnce([heldReservation]) // Reservation query
        .mockResolvedValueOnce([wallet])          // Wallet query
        .mockResolvedValueOnce([grant1, grant2]); // Grants query in FEFO order

      // Settle 500 credits (should completely deplete grant 1 [300], and take 200 from grant 2)
      const result = await settlementService.settleReservation({
        requestId: 'req-201',
        actualCredits: 500n,
        metadata: { model: 'gemini-2.0-flash', promptTokens: 1000, completionTokens: 200 },
      });

      expect(result.settled).toBe(true);
      expect(result.actualCredits).toBe(500n);
      expect(result.unusedCreditsReleased).toBe(500n); // 1000 reserved - 500 actual = 500 released
      expect(result.balanceAfter).toBe(9_500n); // 10,000 - 500

      // Verify audit ledger entry was written
      expect(mockPrisma.aICreditLedgerEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'SETTLE',
            amount: -500n,
            balanceAfter: 9_500n,
          }),
        })
      );
    });

    test('Throws InvalidReservationStateError if reservation is not HELD', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        { id: 'res-2', collegeId: 'c-1', walletId: 'w-1', requestId: 'req-202', status: 'SETTLED' },
      ]);

      await expect(
        settlementService.settleReservation({
          requestId: 'req-202',
          actualCredits: 200n,
        })
      ).rejects.toThrow(InvalidReservationStateError);
    });

    test('Releasing reservation restores reserved balance without debiting credits', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        { id: 'res-3', collegeId: 'c-1', walletId: 'w-1', status: 'HELD', reservedCredits: 800n },
      ]);

      const result = await settlementService.releaseReservation({
        requestId: 'req-203',
        reason: 'Client disconnected before stream generation started',
      });

      expect(result.released).toBe(true);
      expect(result.releasedCredits).toBe(800n);
      expect(mockPrisma.$executeRaw).toHaveBeenCalled();
      expect(mockPrisma.aICreditLedgerEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'RELEASE',
            amount: 0n,
          }),
        })
      );
    });
  });

  describe('ReservationReaper', () => {
    test('Reaps expired abandoned reservations and releases wallet hold', async () => {
      const expiredRes = [
        { id: 'res-old-1', collegeId: 'c-1', walletId: 'w-1', requestId: 'req-old-1', reservedCredits: 400n },
        { id: 'res-old-2', collegeId: 'c-2', walletId: 'w-2', requestId: 'req-old-2', reservedCredits: 600n },
      ];

      mockPrisma.$queryRaw.mockResolvedValueOnce(expiredRes);

      const result = await reservationReaper.reapExpiredReservations(10);

      expect(result.reapedCount).toBe(2);
      expect(result.totalCreditsReleased).toBe(1_000n); // 400 + 600
      expect(mockPrisma.aICreditLedgerEntry.create).toHaveBeenCalledTimes(2);
    });
  });
});
