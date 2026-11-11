import jwt from 'jsonwebtoken';
import { verifyServiceAssertion } from '../src/security/verifyServiceAssertion';

// Mock Redis client for deterministic testing
const mockRedisSet = jest.fn();
const mockRedisGet = jest.fn();
const mockRedisConnect = jest.fn();

jest.mock('../src/infrastructure/redis', () => ({
  getRedisClient: () => ({
    status: 'ready',
    connect: mockRedisConnect,
    set: mockRedisSet,
    get: mockRedisGet,
  }),
}));

// Set test environment secret
process.env.INTERNAL_SERVICE_SECRET = 'test-secret-at-least-32-characters-long!!';
process.env.INTERNAL_SERVICE_ISSUER = 'collegeshub-core';
process.env.INTERNAL_SERVICE_AUDIENCE = 'collegeshub-ai';
process.env.AI_DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.MASTER_ENCRYPTION_KEY = '12345678901234567890123456789012';

describe('verifyServiceAssertion Middleware Tests (Fail-Closed & Replay)', () => {
  const secret = process.env.INTERNAL_SERVICE_SECRET!;

  function createMockReqRes(assertionHeader?: string) {
    const req: any = {
      headers: {},
      log: {
        warn: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
      },
    };

    if (assertionHeader) {
      req.headers['x-collegeshub-assertion'] = assertionHeader;
    }

    const res: any = {};
    res.statusCode = 200;
    res.jsonBody = null;
    res.status = jest.fn().mockImplementation((code: number) => {
      res.statusCode = code;
      return res;
    });
    res.json = jest.fn().mockImplementation((body: any) => {
      res.jsonBody = body;
      return res;
    });

    const next = jest.fn();

    return { req, res, next };
  }

  function signAssertion(payload: any, options: any = {}) {
    return jwt.sign(
      {
        iss: 'collegeshub-core',
        aud: 'collegeshub-ai',
        sub: 'user-uuid-1',
        collegeId: 'college-uuid-1',
        role: 'student',
        planId: 'standard',
        jti: 'nonce-uuid-' + Math.random(),
        ...payload,
      },
      secret,
      { expiresIn: '60s', ...options }
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisSet.mockResolvedValue('OK');
    mockRedisGet.mockResolvedValue(null);
  });

  test('Rejects with 401 when header is missing', async () => {
    const { req, res, next } = createMockReqRes();
    await verifyServiceAssertion(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.jsonBody.error).toBe('MISSING_SERVICE_ASSERTION');
    expect(next).not.toHaveBeenCalled();
  });

  test('Rejects with 401 when signature is invalid', async () => {
    const tampered = signAssertion({}) + 'tamper';
    const { req, res, next } = createMockReqRes(tampered);

    await verifyServiceAssertion(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.jsonBody.error).toBe('INVALID_SERVICE_ASSERTION');
    expect(next).not.toHaveBeenCalled();
  });

  test('Rejects with 401 when assertion is expired', async () => {
    const expiredToken = jwt.sign(
      {
        iss: 'collegeshub-core',
        aud: 'collegeshub-ai',
        sub: 'user-uuid-1',
        collegeId: 'college-uuid-1',
        role: 'student',
        jti: 'expired-nonce',
      },
      secret,
      { expiresIn: '-5s' }
    );

    const { req, res, next } = createMockReqRes(expiredToken);
    await verifyServiceAssertion(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.jsonBody.error).toBe('INVALID_SERVICE_ASSERTION');
    expect(next).not.toHaveBeenCalled();
  });

  test('Accepts valid assertion and stamps tenantContext', async () => {
    const validToken = signAssertion({ sub: 'student-99', collegeId: 'college-42', role: 'student' });
    const { req, res, next } = createMockReqRes(validToken);

    await verifyServiceAssertion(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.tenantContext).toBeDefined();
    expect(req.tenantContext.userId).toBe('student-99');
    expect(req.tenantContext.collegeId).toBe('college-42');
    expect(req.tenantContext.role).toBe('student');
    expect(mockRedisSet).toHaveBeenCalledWith(expect.stringContaining('nonce:'), '1', 'EX', 60, 'NX');
  });

  test('Blocks replay attack when nonce has already been consumed (Redis returns null)', async () => {
    mockRedisSet.mockResolvedValue(null); // Key already exists

    const token = signAssertion({ jti: 'replayed-nonce' });
    const { req, res, next } = createMockReqRes(token);

    await verifyServiceAssertion(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.jsonBody.error).toBe('REPLAY_ATTACK_DETECTED');
    expect(next).not.toHaveBeenCalled();
  });

  test('Rejects with 403 when college status is SUSPENDED in Redis', async () => {
    mockRedisGet.mockResolvedValue('SUSPENDED');

    const token = signAssertion({ collegeId: 'suspended-college-1' });
    const { req, res, next } = createMockReqRes(token);

    await verifyServiceAssertion(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.jsonBody.error).toBe('TENANT_SUSPENDED');
    expect(next).not.toHaveBeenCalled();
  });

  test('Fail-Closed: Rejects with 503 when Redis throws an unexpected error', async () => {
    mockRedisSet.mockRejectedValue(new Error('Redis cluster connection refused'));

    const token = signAssertion({});
    const { req, res, next } = createMockReqRes(token);

    await verifyServiceAssertion(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.jsonBody.error).toBe('SECURITY_SUBSYSTEM_OFFLINE');
    expect(next).not.toHaveBeenCalled();
  });
});
