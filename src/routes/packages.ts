import { Router, Request, Response } from 'express';
import { PackageService } from '../modules/purchases/PackageService';
import { verifyServiceAssertion } from '../security/verifyServiceAssertion';

const router = Router();
const packageService = new PackageService();

/**
 * GET /internal/v1/packages
 * List available AI credit add-on packages.
 */
router.get('/', verifyServiceAssertion, async (_req: Request, res: Response): Promise<void> => {
  try {
    const packages = await packageService.listActivePackages();
    res.status(200).json({
      success: true,
      packages: packages.map((p) => ({
        ...p,
        credits: p.credits.toString(),
      })),
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'PACKAGE_FETCH_FAILED',
      message: err.message,
    });
  }
});

export default router;
