import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getEnv } from '../config/env';
import { getRedisClient } from '../infrastructure/redis';

export interface VerifiedTenantContext {
  userId: string;
  collegeId: string;
  role: 'student' | 'teacher' | 'admin' | 'superAdmin' | 'principal';
  planId: string;
  collegeVersion: number;
  jti: string;
}

declare global {
  namespace Express {
    interface Request {
      tenantContext?: VerifiedTenantContext;
    }
  }
}

interface DecodedAssertionPayload {
  iss: string;
  aud: string;
  sub: string;
  collegeId: string;
  role: 'student' | 'teacher' | 'admin' | 'superAdmin' | 'principal';
  planId: string;
  collegeVersion?: number;
  jti: string;
  iat: number;
  exp: number;
}

/**
 * Middleware: Verify S2S Assertion & Prevent Nonce Replay (Fail-Closed)
 */
export async function verifyServiceAssertion(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const env = getEnv();
  const rawHeader = req.headers['x-collegeshub-assertion'];

  if (!rawHeader || typeof rawHeader !== 'string') {
    res.status(401).json({
      success: false,
      error: 'MISSING_SERVICE_ASSERTION',
      message: 'Internal service assertion header (X-Collegeshub-Assertion) is required',
    });
    return;
  }

  let decoded: DecodedAssertionPayload;

  try {
    decoded = jwt.verify(rawHeader, env.INTERNAL_SERVICE_SECRET, {
      algorithms: ['HS256'],
      issuer: env.INTERNAL_SERVICE_ISSUER,
      audience: env.INTERNAL_SERVICE_AUDIENCE,
      clockTolerance: 5,
    }) as DecodedAssertionPayload;
  } catch (err: any) {
    res.status(401).json({
      success: false,
      error: 'INVALID_SERVICE_ASSERTION',
      message: err.message || 'Service assertion validation failed',
    });
    return;
  }

  // Mandatory Claims Validation
  if (!decoded.sub || !decoded.collegeId || !decoded.role || !decoded.jti) {
    res.status(401).json({
      success: false,
      error: 'MALFORMED_ASSERTION_CLAIMS',
      message: 'Assertion is missing required claims (sub, collegeId, role, jti)',
    });
    return;
  }

  // Nonce Replay Check with Fail-Closed Behavior
  try {
    const redis = getRedisClient();
    if (redis.status === 'wait') {
      await redis.connect();
    }

    const nonceKey = `nonce:${decoded.jti}`;
    // Atomically set key only if it does not already exist, expiring in 60s
    const acquired = await redis.set(nonceKey, '1', 'EX', 60, 'NX');

    if (acquired !== 'OK') {
      req.log.warn({ jti: decoded.jti, collegeId: decoded.collegeId }, 'Replay attack blocked');
      res.status(401).json({
        success: false,
        error: 'REPLAY_ATTACK_DETECTED',
        message: 'Assertion nonce has already been consumed',
      });
      return;
    }

    // Fast Tenant Revocation Check
    const statusKey = `college:status:${decoded.collegeId}`;
    const collegeStatus = await redis.get(statusKey);
    if (collegeStatus === 'SUSPENDED') {
      res.status(403).json({
        success: false,
        error: 'TENANT_SUSPENDED',
        message: 'AI access for this college is currently suspended',
      });
      return;
    }
  } catch (err: any) {
    // Fail-Closed Policy: If security subsystem is down, reject request
    req.log.error({ err: err.message }, 'Security subsystem failure during nonce verification');
    res.status(503).json({
      success: false,
      error: 'SECURITY_SUBSYSTEM_OFFLINE',
      message: 'Unable to verify assertion replay state at this time',
    });
    return;
  }

  // Stamp verified context into request
  req.tenantContext = {
    userId: decoded.sub,
    collegeId: decoded.collegeId,
    role: decoded.role,
    planId: decoded.planId || 'starter',
    collegeVersion: decoded.collegeVersion || 1,
    jti: decoded.jti,
  };

  next();
}
