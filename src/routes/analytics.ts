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

const requireSuperAdmin = (req: Request, res: Response, next: Function) => {
  const tenantContext = req.tenantContext;
  if (!tenantContext || tenantContext.role !== 'superAdmin') {
    res.status(403).json({
      success: false,
      error: 'SUPER_ADMIN_REQUIRED',
      message: 'This endpoint requires superAdmin role privileges',
    });
    return;
  }
  next();
};

/**
 * GET /internal/v1/analytics/summary
 * Platform gross compute margin and token analytics.
 */
router.get('/summary', verifyServiceAssertion, requireSuperAdmin, async (_req: Request, res: Response): Promise<void> => {
  try {
    const summary = await analyticsService.getPlatformFinancialSummary();
    res.status(200).json({
      success: true,
      summary,
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed to compute financial summary');
    res.status(500).json({
      success: false,
      error: 'ANALYTICS_FAILED',
      message: err.message,
    });
  }
});

/**
 * GET /internal/v1/analytics/college/:collegeId
 * Single college usage and financial telemetry.
 */
router.get('/college/:collegeId', verifyServiceAssertion, requireSuperAdmin, async (req: Request, res: Response): Promise<void> => {
  const collegeId = String(req.params.collegeId);

  try {
    const summary = await analyticsService.getCollegeUsageSummary(collegeId);
    res.status(200).json({
      success: true,
      collegeId,
      summary,
    });
  } catch (err: any) {
    logger.error({ err: err.message, collegeId }, 'Failed to fetch college usage telemetry');
    res.status(500).json({
      success: false,
      error: 'COLLEGE_ANALYTICS_FAILED',
      message: err.message,
    });
  }
});

export default router;
