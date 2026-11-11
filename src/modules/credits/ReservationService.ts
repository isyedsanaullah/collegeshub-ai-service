import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import pino from 'pino';
import { getPrismaClient } from '../../infrastructure/database';
import { getEnv } from '../../config/env';
import {
  InsufficientCreditsError,
  WalletNotFoundError,
  WalletSuspendedError,
} from './errors';

const env = getEnv();
const logger = pino({ level: env.LOG_LEVEL });

export interface ReservationParams {
  collegeId: string;
  requestId: string;
  estimatedCredits: bigint;
  ttlSeconds?: number;
}

export interface ReservationResult {
  reservationId: string;
  collegeId: string;
  walletId: string;
  requestId: string;
  reservedCredits: bigint;
  expiresAt: Date;
}

export class ReservationService {
  private prisma: PrismaClient;

  constructor(prismaClient?: PrismaClient) {
    this.prisma = prismaClient || getPrismaClient();
  }

  /**
   * Acquire atomic pre-flight credit reservation.
   * Locks the CollegeAIWallet and active AICreditGrants with PostgreSQL row-level locks
   * (SELECT ... FOR UPDATE) to guarantee non-negative balances under concurrent requests.
   */
  public async reserveCredits(params: ReservationParams): Promise<ReservationResult> {
    const { collegeId, requestId, estimatedCredits, ttlSeconds = 300 } = params;

    if (estimatedCredits <= 0n) {
      throw new Error('estimatedCredits must be greater than zero');
    }

    return await this.prisma.$transaction(
      async (tx) => {
        // 1. Acquire row-level lock on the College AI Wallet
        const wallets: Array<{
          id: string;
          collegeId: string;
          balance: bigint;
          reservedBalance: bigint;
          status: string;
        }> = await tx.$queryRaw`
          SELECT id, "collegeId", balance, "reservedBalance", status
          FROM "CollegeAIWallet"
          WHERE "collegeId" = ${collegeId}
          FOR UPDATE;
        `;

        const wallet = wallets[0];
        if (!wallet) {
          throw new WalletNotFoundError(collegeId);
        }

        if (wallet.status !== 'ACTIVE') {
          throw new WalletSuspendedError(collegeId, wallet.status);
        }

        // 2. Validate unreserved balance ceiling
        const availableBalance = wallet.balance - wallet.reservedBalance;
        if (availableBalance < estimatedCredits) {
          logger.warn(
            { collegeId, availableBalance: availableBalance.toString(), estimatedCredits: estimatedCredits.toString() },
            'Credit reservation rejected: Insufficient available unreserved balance'
          );
          throw new InsufficientCreditsError(availableBalance, estimatedCredits);
        }

        // 3. Acquire row-level locks on active grants in deterministic order (FEFO order + ID)
        // Prevents deadlocks across concurrent requests accessing the same college wallet
        await tx.$queryRaw`
          SELECT id, "remainingAmount", "expiresAt"
          FROM "AICreditGrant"
          WHERE "collegeId" = ${collegeId} AND "remainingAmount" > 0
          ORDER BY "expiresAt" ASC NULLS LAST, id ASC
          FOR UPDATE;
        `;

        // 4. Create the explicit AIReservation record
        const reservationId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

        await tx.aIReservation.create({
          data: {
            id: reservationId,
            collegeId,
            walletId: wallet.id,
            requestId,
            status: 'HELD',
            reservedCredits: estimatedCredits,
            settledCredits: 0n,
            expiresAt,
          },
        });

        // 5. Increment wallet reserved balance atomically
        await tx.$executeRaw`
          UPDATE "CollegeAIWallet"
          SET "reservedBalance" = "reservedBalance" + ${estimatedCredits},
              "updatedAt" = NOW()
          WHERE id = ${wallet.id};
        `;

        logger.debug(
          { reservationId, collegeId, requestId, reservedCredits: estimatedCredits.toString() },
          'Credit reservation held successfully'
        );

        return {
          reservationId,
          collegeId,
          walletId: wallet.id,
          requestId,
          reservedCredits: estimatedCredits,
          expiresAt,
        };
      },
      {
        isolationLevel: 'ReadCommitted',
        timeout: 10000, // 10s maximum transaction wait
      }
    );
  }
}

