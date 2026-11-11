import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import pino from 'pino';
import { getEnv } from '../config/env';

const env = getEnv();
const logger = pino({ level: env.LOG_LEVEL });

let prismaClient: PrismaClient | null = null;
let pool: Pool | null = null;

export function getPrismaClient(): PrismaClient {
  if (!prismaClient) {
    const isSsl = env.AI_DATABASE_URL.includes('sslmode=require') ||
                  env.AI_DATABASE_URL.includes('neon.tech') ||
                  env.AI_DATABASE_URL.includes('render.com');

    pool = new Pool({
      connectionString: env.AI_DATABASE_URL,
      max: env.DB_POOL_MAX,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: isSsl ? { rejectUnauthorized: false } : undefined,
    });

    pool.on('error', (err) => {
      logger.error({ err: err.message }, 'Unexpected PostgreSQL pool error in AI microservice');
    });

    const adapter = new PrismaPg(pool);
    prismaClient = new PrismaClient({ adapter });

    logger.info('Prisma Client initialized with PostgreSQL driver adapter pool');
  }

  return prismaClient;
}

export async function isDatabaseHealthy(): Promise<boolean> {
  try {
    const prisma = getPrismaClient();
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
