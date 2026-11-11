import { Router, Request, Response } from 'express';
import pino from 'pino';
import { verifyServiceAssertion } from '../security/verifyServiceAssertion';
import { FinancialAnalyticsService } from '../modules/analytics/FinancialAnalyticsService';
import { getPrismaClient } from '../infrastructure/database';
import { getEnv } from '../config/env';

const router = Router();
const env = getEnv();
const logger = pino({ level: env.LOG_LEVEL });
const prisma = getPrismaClient();
const analyticsService = new FinancialAnalyticsService(prisma);

/**
 * GET /internal/v1/wallet/summary
 * Real-time balance and usage view for the authenticated college.
 */
router.get('/summary', verifyServiceAssertion, async (req: Request, res: Response): Promise<void> => {
  const tenantContext = req.tenantContext!;

  try {
    const summary = await analyticsService.getCollegeUsageSummary(tenantContext.collegeId);
    res.status(200).json({
      success: true,
      collegeId: tenantContext.collegeId,
      summary,
    });
  } catch (err: any) {
    logger.error({ err: err.message, collegeId: tenantContext.collegeId }, 'Failed to fetch wallet summary');
    res.status(500).json({
      success: false,
      error: 'WALLET_SUMMARY_FAILED',
      message: err.message,
    });
  }
});

/**
 * GET /internal/v1/wallet/grants
 * Active grants in FEFO order with expiry countdowns.
 */
router.get('/grants', verifyServiceAssertion, async (req: Request, res: Response): Promise<void> => {
  const tenantContext = req.tenantContext!;

  try {
    const wallet = await prisma.collegeAIWallet.findUnique({
      where: { collegeId: tenantContext.collegeId },
      include: {
        grants: {
          where: { remainingAmount: { gt: 0 } },
          orderBy: [{ expiresAt: 'asc' }],
        },
      },
    });

    const grants = (wallet?.grants || []).map((g) => ({
      id: g.id,
      source: g.source,
      originalAmount: g.originalAmount.toString(),
      remainingAmount: g.remainingAmount.toString(),
      billingCycle: g.billingCycle,
      expiresAt: g.expiresAt,
      isNonExpiring: g.expiresAt === null,
      createdAt: g.createdAt,
    }));

    res.status(200).json({
      success: true,
      collegeId: tenantContext.collegeId,
      grants,
      count: grants.length,
    });
  } catch (err: any) {
    logger.error({ err: err.message, collegeId: tenantContext.collegeId }, 'Failed to fetch wallet grants');
    res.status(500).json({
      success: false,
      error: 'WALLET_GRANTS_FAILED',
      message: err.message,
    });
  }
});

/**
 * GET /internal/v1/wallet/ledger
 * Paginated ledger transactions audit log.
 */
router.get('/ledger', verifyServiceAssertion, async (req: Request, res: Response): Promise<void> => {
  const tenantContext = req.tenantContext!;
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
  const skip = (page - 1) * limit;

  try {
    const [entries, totalCount] = await Promise.all([
      prisma.aICreditLedgerEntry.findMany({
        where: { collegeId: tenantContext.collegeId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.aICreditLedgerEntry.count({
        where: { collegeId: tenantContext.collegeId },
      }),
    ]);

    const formattedEntries = entries.map((e) => ({
      id: e.id,
      type: e.type,
      amount: e.amount.toString(),
      balanceAfter: e.balanceAfter.toString(),
      description: e.description,
      requestId: e.requestId,
      metadata: e.metadata,
      createdAt: e.createdAt,
    }));

    res.status(200).json({
      success: true,
      collegeId: tenantContext.collegeId,
      entries: formattedEntries,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
      },
    });
  } catch (err: any) {
    logger.error({ err: err.message, collegeId: tenantContext.collegeId }, 'Failed to fetch wallet ledger');
    res.status(500).json({
      success: false,
      error: 'WALLET_LEDGER_FAILED',
      message: err.message,
    });
  }
});

export default router;
