import { Router, Request, Response } from 'express';
import pino from 'pino';
import { verifyServiceAssertion } from '../security/verifyServiceAssertion';
import { CredentialVault } from '../security/CredentialVault';
import { ModelRegistryService } from '../modules/models/ModelRegistryService';
import { getPrismaClient } from '../infrastructure/database';
import { getEnv } from '../config/env';

const router = Router();
const env = getEnv();
const logger = pino({ level: env.LOG_LEVEL });
const prisma = getPrismaClient();
const modelRegistry = new ModelRegistryService(prisma);

// Super Admin access gate middleware
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
 * POST /internal/v1/admin/kill-switch
 * Global emergency AI circuit breaker / kill switch.
 */
router.post('/kill-switch', verifyServiceAssertion, requireSuperAdmin, async (req: Request, res: Response): Promise<void> => {
  const { enabled, reason } = req.body;

  try {
    const setting = await prisma.globalAISetting.upsert({
      where: { key: 'GLOBAL_AI_KILL_SWITCH' },
      update: {
        value: { enabled: Boolean(enabled), reason: reason || 'Super Admin manual override', updatedAt: new Date().toISOString() },
        updatedByUserId: req.tenantContext!.userId,
      },
      create: {
        key: 'GLOBAL_AI_KILL_SWITCH',
        value: { enabled: Boolean(enabled), reason: reason || 'Super Admin manual override', updatedAt: new Date().toISOString() },
        updatedByUserId: req.tenantContext!.userId,
      },
    });

    res.status(200).json({
      success: true,
      killSwitch: setting.value,
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed to toggle global AI kill switch');
    res.status(500).json({
      success: false,
      error: 'KILL_SWITCH_UPDATE_FAILED',
      message: err.message,
    });
  }
});

/**
 * POST /internal/v1/admin/credentials
 * Save provider credential with AES-256-GCM envelope encryption.
 */
router.post('/credentials', verifyServiceAssertion, requireSuperAdmin, async (req: Request, res: Response): Promise<void> => {
  const { provider, apiKey, isPrimary = true } = req.body;

  if (!provider || !apiKey) {
    res.status(400).json({
      success: false,
      error: 'MISSING_PARAMS',
      message: 'provider and apiKey are required',
    });
    return;
  }

  try {
    const encrypted = CredentialVault.encrypt(apiKey, 1);
    const [, iv, authTag, encryptedKey] = encrypted.split(':');

    // Deactivate previous primary keys if new one is primary
    if (isPrimary) {
      await prisma.providerCredential.updateMany({
        where: { provider, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    const keyHint = apiKey.length > 8 ? `...${apiKey.slice(-4)}` : '...****';

    const cred = await prisma.providerCredential.create({
      data: {
        provider,
        keyHint,
        keyVersion: 1,
        iv,
        authTag,
        encryptedKey,
        isPrimary,
        isActive: true,
      },
    });

    res.status(200).json({
      success: true,
      credentialId: cred.id,
      provider: cred.provider,
      keyVersion: cred.keyVersion,
      isPrimary: cred.isPrimary,
      createdAt: cred.createdAt,
    });
  } catch (err: any) {
    logger.error({ err: err.message, provider }, 'Failed to save provider credential');
    res.status(500).json({
      success: false,
      error: 'CREDENTIAL_SAVE_FAILED',
      message: err.message,
    });
  }
});

/**
 * GET /internal/v1/admin/models
 * List registered models and active pricing versions.
 */
router.get('/models', verifyServiceAssertion, requireSuperAdmin, async (_req: Request, res: Response): Promise<void> => {
  try {
    const models = await prisma.modelDefinition.findMany({
      include: {
        pricingHistory: {
          orderBy: { version: 'desc' },
        },
      },
      orderBy: { modelKey: 'asc' },
    });

    res.status(200).json({
      success: true,
      models,
      count: models.length,
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed to fetch models');
    res.status(500).json({
      success: false,
      error: 'FETCH_MODELS_FAILED',
      message: err.message,
    });
  }
});

export default router;
