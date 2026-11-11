import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).default('10001'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Service-to-Service Security
  INTERNAL_SERVICE_SECRET: z.string().min(32, 'INTERNAL_SERVICE_SECRET must be at least 32 characters'),
  INTERNAL_SERVICE_ISSUER: z.string().default('collegeshub-core'),
  INTERNAL_SERVICE_AUDIENCE: z.string().default('collegeshub-ai'),

  // Credential Encryption
  MASTER_ENCRYPTION_KEY: z.string().min(32, 'MASTER_ENCRYPTION_KEY must be a 32-byte string'),

  // Database
  AI_DATABASE_URL: z.string().url('AI_DATABASE_URL must be a valid connection string'),
  AI_DATABASE_DIRECT_URL: z.string().url().optional(),
  DB_POOL_MAX: z.string().transform(Number).default('10'),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Cloudflare R2
  R2_ACCOUNT_ID: z.string().optional(),
  R2_BUCKET_NAME: z.string().optional(),
  R2_ENDPOINT: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_REGION: z.string().default('auto'),

  // Fallback API Keys
  GEMINI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  // Global Caps
  GLOBAL_DAILY_BUDGET_USD: z.string().transform(Number).default('100'),
  GLOBAL_MONTHLY_BUDGET_USD: z.string().transform(Number).default('2500'),
  KILL_SWITCH_ACTIVE: z.string().transform((val) => val === 'true').default('false'),
});

export type EnvConfig = z.infer<typeof envSchema>;

let parsedEnv: EnvConfig;

export function getEnv(): EnvConfig {
  if (!parsedEnv) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      console.error('❌ Invalid AI Microservice environment variables:', result.error.format());
      throw new Error('Invalid environment configuration');
    }
    parsedEnv = result.data;
  }
  return parsedEnv;
}

