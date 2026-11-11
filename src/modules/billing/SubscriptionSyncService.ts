import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import pino from 'pino';
import { getPrismaClient } from '../../infrastructure/database';
import { getEnv } from '../../config/env';

const env = getEnv();
const logger = pino({ level: env.LOG_LEVEL });

/**
 * Standard Monthly Plan AI Credit Allowances
 * Mapped to Academix planConstants.js PLAN_LIMITS
 */
export const PLAN_MONTHLY_CREDITS: Record<string, bigint> = {
  starter: 0n,
  basic: 0n,
  standard: 1_000_000n,    // 1 Million Credits
  premium: 5_000_000n,     // 5 Million Credits
  enterprise: 40_000_000n, // 40 Million Credits
};

export interface SubscriptionSyncPayload {
  collegeId: string;
  planId: string;
  billingCycle: string; // E.g., "2026-11"
  periodStart: Date;
  periodEnd: Date;
  reason?: string;
}

export interface SubscriptionSyncResult {
  status: 'SUCCESS' | 'ALREADY_SYNCED' | 'NO_ALLOWANCE';
  grantId?: string;
  collegeId: string;
  planId: string;
  billingCycle: string;
  creditsGranted: bigint;
  expiresAt?: Date;
}

export class SubscriptionSyncService {
  private prisma: PrismaClient;

  constructor(prismaClient?: PrismaClient) {
    this.prisma = prismaClient || getPrismaClient();
  }

  /**
   * Allocate monthly subscription AI credits for a billing cycle.
   * Guarantees that each college receives exactly one grant per billing cycle.
   */
  public async syncMonthlyPlanGrant(payload: SubscriptionSyncPayload): Promise<SubscriptionSyncResult> {
    const { collegeId, planId, billingCycle, periodEnd, reason } = payload;
    const normalizedPlan = (planId || 'starter').toLowerCase();
    const monthlyAllowance = PLAN_MONTHLY_CREDITS[normalizedPlan] || 0n;

    if (monthlyAllowance <= 0n) {
      logger.info({ collegeId, planId }, 'No AI credit allowance for starter/basic plan');
      return {
        status: 'NO_ALLOWANCE',
        collegeId,
        planId,
        billingCycle,
        creditsGranted: 0n,
      };
    }

    // 1. Check idempotency: Has a grant already been issued for this college and cycle?
    const existingGrant = await this.prisma.aICreditGrant.findFirst({
      where: {
        collegeId,
        billingCycle,
        source: 'SUBSCRIPTION',
      },
    });

    if (existingGrant) {
      logger.info(
        { collegeId, billingCycle, grantId: existingGrant.id },
        'Monthly subscription grant was already allocated for this cycle'
      );
      return {
        status: 'ALREADY_SYNCED',
        grantId: existingGrant.id,
        collegeId,
        planId,
        billingCycle,
        creditsGranted: existingGrant.originalAmount,
        expiresAt: existingGrant.expiresAt || undefined,
      };
    }

    // 2. Execute atomic grant creation and wallet balance update
    return await this.prisma.$transaction(
      async (tx) => {
        // Double-check under transaction
        const existingInTx = await tx.aICreditGrant.findFirst({
          where: { collegeId, billingCycle, source: 'SUBSCRIPTION' },
        });

        if (existingInTx) {
          return {
            status: 'ALREADY_SYNCED',
            grantId: existingInTx.id,
            collegeId,
            planId,
            billingCycle,
            creditsGranted: existingInTx.originalAmount,
            expiresAt: existingInTx.expiresAt || undefined,
          };
        }

        // Lock or create wallet
        let wallet = await tx.collegeAIWallet.findUnique({
          where: { collegeId },
        });

        if (!wallet) {
          wallet = await tx.collegeAIWallet.create({
            data: {
              collegeId,
              balance: 0n,
              reservedBalance: 0n,
              totalAllocated: 0n,
              totalConsumed: 0n,
              status: 'ACTIVE',
            },
          });
        }

        await tx.$queryRaw`
          SELECT id FROM "CollegeAIWallet"
          WHERE id = ${wallet.id}
          FOR UPDATE;
        `;

        // Create the expiring subscription grant
        const grantId = crypto.randomUUID();
        const grant = await tx.aICreditGrant.create({
          data: {
            id: grantId,
            walletId: wallet.id,
            collegeId,
            source: 'SUBSCRIPTION',
            originalAmount: monthlyAllowance,
            remainingAmount: monthlyAllowance,
            billingCycle,
            expiresAt: periodEnd, // Expires at the end of the billing cycle
            reason: reason || `Monthly subscription allowance for ${normalizedPlan} plan (${billingCycle})`,
            createdByUserId: 'system-subscription-worker',
          },
        });

        const newBalance = wallet.balance + monthlyAllowance;
        const newTotalAllocated = wallet.totalAllocated + monthlyAllowance;

        await tx.$executeRaw`
          UPDATE "CollegeAIWallet"
          SET balance = ${newBalance},
              "totalAllocated" = ${newTotalAllocated},
              "updatedAt" = NOW()
          WHERE id = ${wallet.id};
        `;

        // Record immutable ledger entry
        const ledgerId = crypto.randomUUID();
        await tx.aICreditLedgerEntry.create({
          data: {
            id: ledgerId,
            collegeId,
            walletId: wallet.id,
            grantId: grant.id,
            requestId: `sub-${collegeId}-${billingCycle}`,
            type: 'GRANT_SUBSCRIPTION',
            amount: monthlyAllowance,
            balanceAfter: newBalance,
            description: `Allocated monthly ${monthlyAllowance.toString()} credits for ${normalizedPlan} (${billingCycle})`,
            metadata: {
              planId: normalizedPlan,
              billingCycle,
              periodEnd: periodEnd.toISOString(),
            },
          },
        });

        logger.info(
          {
            collegeId,
            planId: normalizedPlan,
            billingCycle,
            creditsGranted: monthlyAllowance.toString(),
            grantId: grant.id,
            newBalance: newBalance.toString(),
          },
          'Monthly subscription grant allocated successfully'
        );

        return {
          status: 'SUCCESS',
          grantId: grant.id,
          collegeId,
          planId: normalizedPlan,
          billingCycle,
          creditsGranted: monthlyAllowance,
          expiresAt: periodEnd,
        };
      },
      {
        isolationLevel: 'ReadCommitted',
        timeout: 10000,
      }
    );
  }
}

