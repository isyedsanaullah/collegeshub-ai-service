import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import pino from 'pino';
import { getPrismaClient } from '../../infrastructure/database';
import { getEnv } from '../../config/env';

const env = getEnv();
const logger = pino({ level: env.LOG_LEVEL });

export interface PurchaseApprovalPayload {
  purchaseRequestId: string;
  collegeId: string;
  credits: bigint;
  packageCode: string;
  amountPkr: number;
  receiptNumber?: string;
  approvedByUserId?: string;
  transactionReference?: string;
}

export interface PurchaseAllocationResult {
  status: 'SUCCESS' | 'ALREADY_ALLOCATED';
  grantId: string;
  collegeId: string;
  credits: bigint;
  balanceAfter: bigint;
  receiptNumber?: string;
}

export class PurchaseAllocationService {
  private prisma: PrismaClient;

  constructor(prismaClient?: PrismaClient) {
    this.prisma = prismaClient || getPrismaClient();
  }

  /**
   * Allocate approved add-on credits to a college wallet.
   * Enforces strict idempotency: if purchaseRequestId was already allocated,
   * returns the existing grant without minting duplicate credits.
   */
  public async allocateApprovedPurchase(payload: PurchaseApprovalPayload): Promise<PurchaseAllocationResult> {
    const {
      purchaseRequestId,
      collegeId,
      credits,
      packageCode,
      amountPkr,
      receiptNumber,
      approvedByUserId,
      transactionReference,
    } = payload;

    if (!purchaseRequestId || !collegeId || credits <= 0n) {
      throw new Error('Invalid purchase allocation parameters: purchaseRequestId, collegeId, and credits > 0 are required');
    }

    // 1. Pre-check idempotency outside transaction
    const existingGrant = await this.prisma.aICreditGrant.findUnique({
      where: { purchaseRequestId },
    });

    if (existingGrant) {
      logger.info(
        { purchaseRequestId, collegeId, grantId: existingGrant.id },
        'Purchase was already allocated; returning existing grant idempotently'
      );

      const wallet = await this.prisma.collegeAIWallet.findUnique({
        where: { collegeId },
      });

      return {
        status: 'ALREADY_ALLOCATED',
        grantId: existingGrant.id,
        collegeId,
        credits: existingGrant.originalAmount,
        balanceAfter: wallet ? wallet.balance : existingGrant.remainingAmount,
        receiptNumber,
      };
    }

    // 2. Execute atomic allocation transaction
    return await this.prisma.$transaction(
      async (tx) => {
        // Double check idempotency under transaction
        const existingInTx = await tx.aICreditGrant.findUnique({
          where: { purchaseRequestId },
        });

        if (existingInTx) {
          const wallet = await tx.collegeAIWallet.findUnique({ where: { collegeId } });
          return {
            status: 'ALREADY_ALLOCATED',
            grantId: existingInTx.id,
            collegeId,
            credits: existingInTx.originalAmount,
            balanceAfter: wallet ? wallet.balance : existingInTx.remainingAmount,
            receiptNumber,
          };
        }

        // Lock or create the college AI wallet
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

        // Lock wallet record FOR UPDATE
        await tx.$queryRaw`
          SELECT id FROM "CollegeAIWallet"
          WHERE id = ${wallet.id}
          FOR UPDATE;
        `;

        // Create the non-expiring paid credit grant
        const grantId = crypto.randomUUID();
        const grant = await tx.aICreditGrant.create({
          data: {
            id: grantId,
            walletId: wallet.id,
            collegeId,
            source: 'PURCHASED',
            originalAmount: credits,
            remainingAmount: credits,
            purchaseRequestId,
            expiresAt: null, // Non-expiring purchased credits
            reason: `Paid add-on purchase approved (${packageCode}, Receipt: ${receiptNumber || 'N/A'})`,
            createdByUserId: approvedByUserId || 'system',
          },
        });

        // Atomically update wallet balance
        const newBalance = wallet.balance + credits;
        const newTotalAllocated = wallet.totalAllocated + credits;

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
            requestId: purchaseRequestId,
            type: 'GRANT_PURCHASED',
            amount: credits,
            balanceAfter: newBalance,
            description: `Allocated ${credits.toString()} credits for approved purchase ${receiptNumber || purchaseRequestId}`,
            metadata: {
              purchaseRequestId,
              packageCode,
              amountPkr,
              receiptNumber,
              transactionReference,
              approvedByUserId,
            },
          },
        });

        logger.info(
          {
            purchaseRequestId,
            collegeId,
            credits: credits.toString(),
            grantId: grant.id,
            newBalance: newBalance.toString(),
            receiptNumber,
          },
          'Approved purchase allocated to college wallet successfully'
        );

        return {
          status: 'SUCCESS',
          grantId: grant.id,
          collegeId,
          credits,
          balanceAfter: newBalance,
          receiptNumber,
        };
      },
      {
        isolationLevel: 'ReadCommitted',
        timeout: 10000,
      }
    );
  }
}
