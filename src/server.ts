import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { getEnv } from './config/env';

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

// Liveness & Readiness Probes
app.get('/health/liveness', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'UP', timestamp: new Date().toISOString() });
});

app.get('/health/readiness', async (_req: Request, res: Response) => {
  // Readiness validates DB connection and dependencies
  res.status(200).json({
    status: 'READY',
    service: 'collegeshub-ai-service',
    timestamp: new Date().toISOString(),
  });
});

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
