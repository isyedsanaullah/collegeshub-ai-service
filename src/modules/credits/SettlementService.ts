import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import pino from 'pino';
import { getPrismaClient } from '../../infrastructure/database';
import { getEnv } from '../../config/env';
import {
  ReservationNotFoundError,
  InvalidReservationStateError,
  WalletNotFoundError,
} from './errors';

const env = getEnv();
const logger = pino({ level: env.LOG_LEVEL });

export interface SettlementParams {
  requestId: string;
  actualCredits: bigint;
  metadata?: Record<string, unknown>;
}

export interface SettlementResult {
  settled: boolean;
  reservationId: string;
  collegeId: string;
  actualCredits: bigint;
  balanceAfter: bigint;
  unusedCreditsReleased: bigint;
  settledAt: Date;
}

export interface ReleaseParams {
  requestId: string;
  reason: string;
}

export class SettlementService {
  private prisma: PrismaClient;

  constructor(prismaClient?: PrismaClient) {
    this.prisma = prismaClient || getPrismaClient();
  }

  /**
   * Settle an active credit reservation.
   * Atomically executes FEFO grant deductions, decrements wallet balance and reserved balance,
   * updates the reservation state to 'SETTLED', and writes an immutable ledger entry.
   */
  public async settleReservation(params: SettlementParams): Promise<SettlementResult> {
    const { requestId, actualCredits, metadata = {} } = params;

    if (actualCredits < 0n) {
      throw new Error('actualCredits cannot be negative');
    }

    return await this.prisma.$transaction(
      async (tx) => {
        // 1. Lock and retrieve the reservation row
        const reservations: Array<{
          id: string;
          collegeId: string;
          walletId: string;
          requestId: string;
          status: string;
          reservedCredits: bigint;
          settledCredits: bigint;
        }> = await tx.$queryRaw`
          SELECT id, "collegeId", "walletId", "requestId", status, "reservedCredits", "settledCredits"
          FROM "AIReservation"
          WHERE "requestId" = ${requestId}
          FOR UPDATE;
        `;

        const reservation = reservations[0];
        if (!reservation) {
          throw new ReservationNotFoundError(requestId);
        }

        if (reservation.status !== 'HELD') {
          throw new InvalidReservationStateError(requestId, reservation.status);
        }

        // 2. Lock the associated wallet
        const wallets: Array<{
          id: string;
          balance: bigint;
          reservedBalance: bigint;
        }> = await tx.$queryRaw`
          SELECT id, balance, "reservedBalance"
          FROM "CollegeAIWallet"
          WHERE id = ${reservation.walletId}
          FOR UPDATE;
        `;

        const wallet = wallets[0];
        if (!wallet) {
          throw new WalletNotFoundError(reservation.collegeId);
        }

        // 3. Lock active grants in deterministic FEFO order (expiring first, then oldest)
        const grants: Array<{
          id: string;
          remainingAmount: bigint;
          expiresAt: Date | null;
        }> = await tx.$queryRaw`
          SELECT id, "remainingAmount", "expiresAt"
          FROM "AICreditGrant"
          WHERE "collegeId" = ${reservation.collegeId} AND "remainingAmount" > 0
          ORDER BY "expiresAt" ASC NULLS LAST, id ASC
          FOR UPDATE;
        `;

        // 4. Execute FEFO grant deductions
        let remainingToDeduct = actualCredits;
        const grantDeductionSnapshots: Array<{ grantId: string; deducted: string; remaining: string }> = [];

        for (const grant of grants) {
          if (remainingToDeduct <= 0n) break;

          const deductFromGrant = remainingToDeduct < grant.remainingAmount ? remainingToDeduct : grant.remainingAmount;
          const newRemaining = grant.remainingAmount - deductFromGrant;

          await tx.$executeRaw`
            UPDATE "AICreditGrant"
            SET "remainingAmount" = ${newRemaining},
                "updatedAt" = NOW()
            WHERE id = ${grant.id};
          `;

          grantDeductionSnapshots.push({
            grantId: grant.id,
            deducted: deductFromGrant.toString(),
            remaining: newRemaining.toString(),
          });

          remainingToDeduct -= deductFromGrant;
        }

        // 5. Update wallet balance & release the reservation ceiling
        const newBalance = wallet.balance - actualCredits;
        const reservedBalanceToRelease = reservation.reservedCredits;
        const newReservedBalance = wallet.reservedBalance > reservedBalanceToRelease
          ? wallet.reservedBalance - reservedBalanceToRelease
          : 0n;

        await tx.$executeRaw`
          UPDATE "CollegeAIWallet"
          SET balance = ${newBalance},
              "reservedBalance" = ${newReservedBalance},
              "totalConsumed" = "totalConsumed" + ${actualCredits},
              "updatedAt" = NOW()
          WHERE id = ${wallet.id};
        `;

        // 6. Transition reservation to SETTLED
        const settledAt = new Date();
        await tx.$executeRaw`
          UPDATE "AIReservation"
          SET status = 'SETTLED',
              "settledCredits" = ${actualCredits},
              "settledAt" = ${settledAt},
              "updatedAt" = NOW()
          WHERE id = ${reservation.id};
        `;

        // 7. Write immutable audit ledger entry
        const ledgerId = crypto.randomUUID();
        const unusedCreditsReleased = reservation.reservedCredits > actualCredits
          ? reservation.reservedCredits - actualCredits
          : 0n;

        await tx.aICreditLedgerEntry.create({
          data: {
            id: ledgerId,
            collegeId: reservation.collegeId,
            walletId: wallet.id,
            requestId,
            type: 'SETTLE',
            amount: -actualCredits,
            balanceAfter: newBalance,
            description: `Settled AI execution for request ${requestId} (${actualCredits.toString()} credits debited)`,
            metadata: {
              ...metadata,
              reservationId: reservation.id,
              reservedCredits: reservation.reservedCredits.toString(),
              actualCredits: actualCredits.toString(),
              unusedCreditsReleased: unusedCreditsReleased.toString(),
              grantDeductions: grantDeductionSnapshots,
            },
          },
        });

        logger.info(
          {
            requestId,
            collegeId: reservation.collegeId,
            actualCredits: actualCredits.toString(),
            unusedCreditsReleased: unusedCreditsReleased.toString(),
            newBalance: newBalance.toString(),
          },
          'AI credit reservation settled successfully'
        );

        return {
          settled: true,
          reservationId: reservation.id,
          collegeId: reservation.collegeId,
          actualCredits,
          balanceAfter: newBalance,
          unusedCreditsReleased,
          settledAt,
        };
      },
      {
        isolationLevel: 'ReadCommitted',
        timeout: 10000,
      }
    );
  }

  /**
   * Release an active reservation without debiting credits (e.g. on provider error before stream).
   */
  public async releaseReservation(params: ReleaseParams): Promise<{ released: boolean; releasedCredits: bigint }> {
    const { requestId, reason } = params;

    return await this.prisma.$transaction(
      async (tx) => {
        const reservations: Array<{
          id: string;
          collegeId: string;
          walletId: string;
          status: string;
          reservedCredits: bigint;
        }> = await tx.$queryRaw`
          SELECT id, "collegeId", "walletId", status, "reservedCredits"
          FROM "AIReservation"
          WHERE "requestId" = ${requestId}
          FOR UPDATE;
        `;

        const reservation = reservations[0];
        if (!reservation) {
          throw new ReservationNotFoundError(requestId);
        }

        if (reservation.status !== 'HELD') {
          return { released: false, releasedCredits: 0n };
        }

        // Release reservation ceiling from wallet
        await tx.$executeRaw`
          UPDATE "CollegeAIWallet"
          SET "reservedBalance" = GREATEST(0::bigint, "reservedBalance" - ${reservation.reservedCredits}),
              "updatedAt" = NOW()
          WHERE id = ${reservation.walletId};
        `;

        const releasedAt = new Date();
        await tx.$executeRaw`
          UPDATE "AIReservation"
          SET status = 'RELEASED',
              "releasedAt" = ${releasedAt},
              "updatedAt" = NOW()
          WHERE id = ${reservation.id};
        `;

        // Write audit entry
        await tx.aICreditLedgerEntry.create({
          data: {
            id: crypto.randomUUID(),
            collegeId: reservation.collegeId,
            walletId: reservation.walletId,
            requestId,
            type: 'RELEASE',
            amount: 0n,
            balanceAfter: 0n, // Audited as release without balance change
            description: `Released unconsumed reservation for ${requestId}: ${reason}`,
            metadata: {
              reservationId: reservation.id,
              releasedCredits: reservation.reservedCredits.toString(),
              reason,
            },
          },
        });

        logger.info(
          { requestId, collegeId: reservation.collegeId, releasedCredits: reservation.reservedCredits.toString() },
          'AI credit reservation released successfully'
        );

        return { released: true, releasedCredits: reservation.reservedCredits };
      },
      {
        isolationLevel: 'ReadCommitted',
        timeout: 10000,
      }
    );
  }
}

