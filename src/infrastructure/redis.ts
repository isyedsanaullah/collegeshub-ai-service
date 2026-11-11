import Redis from 'ioredis';
import pino from 'pino';
import { getEnv } from '../config/env';

const env = getEnv();
const logger = pino({ level: env.LOG_LEVEL });

let redisClient: Redis | null = null;
let isConnected = false;

export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        const delay = Math.min(times * 100, 3000);
        return delay;
      },
      lazyConnect: true,
      enableOfflineQueue: false, // Fail fast rather than buffer unbounded commands
    });

    redisClient.on('connect', () => {
      isConnected = true;
      logger.info('Connected to Redis cluster / instance');
    });

    redisClient.on('error', (err) => {
      isConnected = false;
      logger.error({ err: err.message }, 'Redis connection error in AI Microservice');
    });

    redisClient.on('close', () => {
      isConnected = false;
      logger.warn('Redis connection closed');
    });
  }

  return redisClient;
}

export async function isRedisHealthy(): Promise<boolean> {
  try {
    const client = getRedisClient();
    if (client.status === 'wait') {
      await client.connect();
    }
    const pong = await client.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

