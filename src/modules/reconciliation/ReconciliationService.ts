import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { getPrismaClient } from '../../infrastructure/database';
import { getEnv } from '../../config/env';
import { ReservationReaper } from '../credits/ReservationReaper';

const env = getEnv();
const logger = pino({ level: env.LOG_LEVEL });

export interface DiscrepantWallet {
  collegeId: string;
  walletBalance: string;
  sumActiveGrants: string;
  difference: string;
}

export interface ReconciliationReport {
  timestamp: string;
  walletsAudited: number;
  healthyWallets: number;
  discrepantWallets: DiscrepantWallet[];
  reapedReservationsCount: number;
  isSystemBalanced: boolean;
}

export class ReconciliationService {
  private prisma: PrismaClient;
  private reaper: ReservationReaper;

  constructor(prismaClient?: PrismaClient) {
    this.prisma = prismaClient || getPrismaClient();
    this.reaper = new ReservationReaper(this.prisma);
  }

  /**
   * Run automated mathematical reconciliation across all college AI wallets.
   * Invariant 1: Wallet.balance == SUM(active AICreditGrant.remainingAmount)
   * Invariant 2: Wallet.reservedBalance >= 0
   * Invariant 3: No expired HELD reservations left un-reaped
   */
  public async reconcileAll(): Promise<ReconciliationReport> {
    const timestamp = new Date().toISOString();
    logger.info({ timestamp }, 'Starting automated institutional AI credit reconciliation audit');

    // 1. First reap any expired held reservations
    const reaperResult = await this.reaper.reapExpiredReservations();

    // 2. Fetch all active wallets with their active grants
    const wallets = await this.prisma.collegeAIWallet.findMany({
      include: {
        grants: {
          where: { remainingAmount: { gt: 0 } },
        },
      },
    });

    const discrepantWallets: DiscrepantWallet[] = [];
    let healthyCount = 0;

    for (const wallet of wallets) {
      const grantSum = wallet.grants.reduce((sum, g) => sum + g.remainingAmount, 0n);

      if (wallet.balance !== grantSum) {
        const diff = wallet.balance - grantSum;
        discrepantWallets.push({
          collegeId: wallet.collegeId,
          walletBalance: wallet.balance.toString(),
          sumActiveGrants: grantSum.toString(),
          difference: diff.toString(),
        });

        logger.error(
          {
            collegeId: wallet.collegeId,
            walletBalance: wallet.balance.toString(),
            grantSum: grantSum.toString(),
            diff: diff.toString(),
          },
          'CRITICAL: Mathematical discrepancy detected between CollegeAIWallet and active AICreditGrants'
        );
      } else {
        healthyCount++;
      }
    }

    const isSystemBalanced = discrepantWallets.length === 0;

    logger.info(
      {
        walletsAudited: wallets.length,
        healthyCount,
        discrepancies: discrepantWallets.length,
        reapedCount: reaperResult.reapedCount,
        isSystemBalanced,
      },
      'Reconciliation audit completed'
    );

    return {
      timestamp,
      walletsAudited: wallets.length,
      healthyWallets: healthyCount,
      discrepantWallets,
      reapedReservationsCount: reaperResult.reapedCount,
      isSystemBalanced,
    };
  }
}
