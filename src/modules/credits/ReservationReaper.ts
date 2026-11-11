import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import pino from 'pino';
import { getPrismaClient } from '../../infrastructure/database';
import { getEnv } from '../../config/env';

const env = getEnv();
const logger = pino({ level: env.LOG_LEVEL });

export interface ReaperResult {
  reapedCount: number;
  totalCreditsReleased: bigint;
  reservationIds: string[];
}

export class ReservationReaper {
  private prisma: PrismaClient;

  constructor(prismaClient?: PrismaClient) {
    this.prisma = prismaClient || getPrismaClient();
  }

  /**
   * Sweep and release abandoned reservations that exceeded their expiration window.
   * Safe for multi-instance deployment via FOR UPDATE SKIP LOCKED.
   */
  public async reapExpiredReservations(batchSize: number = 50): Promise<ReaperResult> {
    const reapedIds: string[] = [];
    let totalCreditsReleased = 0n;

    try {
      // Find and claim expired reservations that are still held
      await this.prisma.$transaction(
        async (tx) => {
          const expiredReservations: Array<{
            id: string;
            collegeId: string;
            walletId: string;
            requestId: string;
            reservedCredits: bigint;
          }> = await tx.$queryRaw`
            SELECT id, "collegeId", "walletId", "requestId", "reservedCredits"
            FROM "AIReservation"
            WHERE status = 'HELD' AND "expiresAt" < NOW()
            ORDER BY "expiresAt" ASC
            LIMIT ${batchSize}
            FOR UPDATE SKIP LOCKED;
          `;

          if (expiredReservations.length === 0) {
            return;
          }

          for (const res of expiredReservations) {
            // Restore wallet reserved balance
            await tx.$executeRaw`
              UPDATE "CollegeAIWallet"
              SET "reservedBalance" = GREATEST(0::bigint, "reservedBalance" - ${res.reservedCredits}),
                  "updatedAt" = NOW()
              WHERE id = ${res.walletId};
            `;

            // Mark reservation EXPIRED
            await tx.$executeRaw`
              UPDATE "AIReservation"
              SET status = 'EXPIRED',
                  "releasedAt" = NOW(),
                  "updatedAt" = NOW()
              WHERE id = ${res.id};
            `;

            // Write ledger audit record
            await tx.aICreditLedgerEntry.create({
              data: {
                id: crypto.randomUUID(),
                collegeId: res.collegeId,
                walletId: res.walletId,
                requestId: res.requestId,
                type: 'RESERVATION_EXPIRED_RELEASE',
                amount: 0n,
                balanceAfter: 0n,
                description: `Reaped abandoned reservation for request ${res.requestId} (${res.reservedCredits.toString()} credits released)`,
                metadata: {
                  reservationId: res.id,
                  reapedAt: new Date().toISOString(),
                  releasedCredits: res.reservedCredits.toString(),
                },
              },
            });

            reapedIds.push(res.id);
            totalCreditsReleased += res.reservedCredits;
          }
        },
        {
          isolationLevel: 'ReadCommitted',
          timeout: 15000,
        }
      );

      if (reapedIds.length > 0) {
        logger.warn(
          { reapedCount: reapedIds.length, totalCreditsReleased: totalCreditsReleased.toString() },
          'Reaped expired reservations and restored wallet reserved balances'
        );
      }
    } catch (err: any) {
      logger.error({ err: err.message }, 'Error occurred during reservation reaper sweep');
    }

    return {
      reapedCount: reapedIds.length,
      totalCreditsReleased,
      reservationIds: reapedIds,
    };
  }
}
