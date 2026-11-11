import { Router, Request, Response } from 'express';
import { verifyServiceAssertion } from '../security/verifyServiceAssertion';
import { PurchaseAllocationService } from '../modules/purchases/PurchaseAllocationService';
import { SubscriptionSyncService } from '../modules/billing/SubscriptionSyncService';
import { getPrismaClient } from '../infrastructure/database';
import { getRedisClient } from '../infrastructure/redis';

const router = Router();
const purchaseAllocationService = new PurchaseAllocationService();
const subscriptionSyncService = new SubscriptionSyncService();

/**
 * POST /internal/v1/events/dispatch
 * Central internal webhook endpoint for asynchronous outbox events dispatched by main backend.
 * Protected by S2S assertion and idempotency key.
 */
router.post('/dispatch', verifyServiceAssertion, async (req: Request, res: Response): Promise<void> => {
  const { eventId, eventType, collegeId, payload } = req.body;

  if (!eventId || !eventType) {
    res.status(400).json({
      success: false,
      error: 'MISSING_EVENT_METADATA',
      message: 'eventId and eventType are required for outbox dispatch',
    });
    return;
  }

  try {
    switch (eventType) {
      case 'AI_PURCHASE_APPROVED': {
        const result = await purchaseAllocationService.allocateApprovedPurchase({
          purchaseRequestId: payload.purchaseRequestId || eventId,
          collegeId: collegeId || payload.collegeId,
          credits: BigInt(payload.credits),
          packageCode: payload.packageCode,
          amountPkr: payload.amountPkr,
          receiptNumber: payload.receiptNumber,
          approvedByUserId: payload.approvedByUserId,
          transactionReference: payload.transactionReference,
        });

        res.status(200).json({
          success: true,
          eventType,
          eventId,
          ...result,
          credits: result.credits.toString(),
          balanceAfter: result.balanceAfter.toString(),
        });
        return;
      }

      case 'AI_SUBSCRIPTION_SYNC': {
        const result = await subscriptionSyncService.syncMonthlyPlanGrant({
          collegeId: collegeId || payload.collegeId,
          planId: payload.planId,
          billingCycle: payload.billingCycle,
          periodStart: new Date(payload.periodStart),
          periodEnd: new Date(payload.periodEnd),
          reason: payload.reason,
        });

        res.status(200).json({
          success: true,
          eventType,
          eventId,
          ...result,
          creditsGranted: result.creditsGranted.toString(),
        });
        return;
      }

      case 'COLLEGE_AI_SUSPENDED': {
        const prisma = getPrismaClient();
        const redis = getRedisClient();

        await prisma.collegeAIWallet.updateMany({
          where: { collegeId },
          data: { status: 'SUSPENDED' },
        });

        // Set fast revocation flag in Redis
        if (redis.status === 'ready') {
          await redis.set(`college:status:${collegeId}`, 'SUSPENDED', 'EX', 86400);
        }

        res.status(200).json({
          success: true,
          eventType,
          eventId,
          status: 'SUSPENDED',
          collegeId,
        });
        return;
      }

      case 'COLLEGE_AI_REACTIVATED': {
        const prisma = getPrismaClient();
        const redis = getRedisClient();

        await prisma.collegeAIWallet.updateMany({
          where: { collegeId },
          data: { status: 'ACTIVE' },
        });

        if (redis.status === 'ready') {
          await redis.del(`college:status:${collegeId}`);
        }

        res.status(200).json({
          success: true,
          eventType,
          eventId,
          status: 'ACTIVE',
          collegeId,
        });
        return;
      }

      default:
        res.status(400).json({
          success: false,
          error: 'UNKNOWN_EVENT_TYPE',
          message: `Unrecognized eventType: ${eventType}`,
        });
        return;
    }
  } catch (err: any) {
    req.log.error({ err: err.message, eventId, eventType }, 'Failed to process outbox event');
    res.status(500).json({
      success: false,
      error: 'EVENT_PROCESSING_FAILED',
      message: err.message,
    });
  }
});

export default router;

