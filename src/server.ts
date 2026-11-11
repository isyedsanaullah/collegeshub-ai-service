import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pino from 'pino';
import pinoHttp from 'pino-http';
import crypto from 'crypto';
import { getEnv } from './config/env';
import { isDatabaseHealthy } from './infrastructure/database';
import { isRedisHealthy } from './infrastructure/redis';
import { verifyServiceAssertion } from './security/verifyServiceAssertion';
import eventsRouter from './routes/events';
import packagesRouter from './routes/packages';
import chatRouter from './routes/chat';

const env = getEnv();
const logger = pino({ level: env.LOG_LEVEL });

const app = express();

// Security & Parsing
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Correlation ID & Structured Logging
app.use((req: Request, res: Response, next: NextFunction) => {
  const correlationId = (req.headers['x-request-id'] as string) || crypto.randomUUID();
  req.headers['x-request-id'] = correlationId;
  res.setHeader('X-Request-Id', correlationId);
  next();
});

app.use(
  pinoHttp({
    logger,
    customProps: (req) => ({
      requestId: req.headers['x-request-id'],
    }),
  })
);

// Liveness Probe (Does not touch external dependencies)
app.get('/health/liveness', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'UP', timestamp: new Date().toISOString() });
});

// Readiness Probe (Pings database & Redis)
app.get('/health/readiness', async (_req: Request, res: Response) => {
  const dbOk = await isDatabaseHealthy();
  const redisOk = await isRedisHealthy();

  const isReady = dbOk && redisOk;
  const statusCode = isReady ? 200 : 503;

  res.status(statusCode).json({
    status: isReady ? 'READY' : 'DEGRADED',
    service: 'collegeshub-ai-service',
    checks: {
      database: dbOk ? 'HEALTHY' : 'UNREACHABLE',
      redis: redisOk ? 'HEALTHY' : 'UNREACHABLE',
    },
    timestamp: new Date().toISOString(),
  });
});

// Internal Verified Ping Endpoint (Validates S2S Assertion Pipeline)
app.get('/internal/v1/ping', verifyServiceAssertion, (req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: 'Internal S2S assertion verified successfully',
    tenantContext: req.tenantContext,
    timestamp: new Date().toISOString(),
  });
});

// Internal Transactional Event, Package & Chat Routes
app.use('/internal/v1/events', eventsRouter);
app.use('/internal/v1/packages', packagesRouter);
app.use('/internal/v1/chat', chatRouter);

// Centralized Error Handler
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  req.log.error({ err }, 'Unhandled exception in AI microservice');
  res.status(500).json({
    success: false,
    error: 'INTERNAL_SERVER_ERROR',
    message: env.NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message,
    requestId: req.headers['x-request-id'],
  });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(env.PORT, () => {
    logger.info(`🚀 Collegeshub AI Service running on port ${env.PORT} in ${env.NODE_ENV} mode`);
  });
}

export default app;
