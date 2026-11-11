import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { getPrismaClient } from '../../infrastructure/database';
import { getEnv } from '../../config/env';

const env = getEnv();
const logger = pino({ level: env.LOG_LEVEL });

export interface PackageSeed {
  code: string;
  name: string;
  description: string;
  credits: bigint;
  pricePkr: number;
  priceUsd: number;
  validityDays: number;
  sortOrder: number;
}

export const CANONICAL_PACKAGES: PackageSeed[] = [
  {
    code: 'AI_TOKENS_1M',
    name: 'AI Lite Token Pack (1M Credits)',
    description: '1,000,000 AI compute credits. Ideal for quiz generation, lesson planning, and student chat.',
    credits: 1_000_000n,
    pricePkr: 500,
    priceUsd: 1.7857,
    validityDays: 0, // Non-expiring
    sortOrder: 1,
  },
  {
    code: 'AI_TOKENS_5M',
    name: 'AI Plus Token Pack (5M Credits)',
    description: '5,000,000 AI compute credits. High-volume document analysis, RAG textbook search, and bulk generation.',
    credits: 5_000_000n,
    pricePkr: 2000,
    priceUsd: 7.1428,
    validityDays: 0,
    sortOrder: 2,
  },
  {
    code: 'AI_TOKENS_10M',
    name: 'AI Enterprise Token Pack (10M Credits)',
    description: '10,000,000 AI compute credits. Campus-wide intelligence, automated grading, and department-wide RAG.',
    credits: 10_000_000n,
    pricePkr: 3500,
    priceUsd: 12.5000,
    validityDays: 0,
    sortOrder: 3,
  },
];

export class PackageService {
  private prisma: PrismaClient;

  constructor(prismaClient?: PrismaClient) {
    this.prisma = prismaClient || getPrismaClient();
  }

  /**
   * Seed or synchronize canonical AI credit packages.
   */
  public async seedDefaultPackages(): Promise<number> {
    let seededCount = 0;

    for (const pkg of CANONICAL_PACKAGES) {
      await this.prisma.aIAddonPackage.upsert({
        where: { code: pkg.code },
        update: {
          name: pkg.name,
          description: pkg.description,
          credits: pkg.credits,
          pricePkr: pkg.pricePkr,
          priceUsd: pkg.priceUsd,
          validityDays: pkg.validityDays,
          sortOrder: pkg.sortOrder,
          isActive: true,
        },
        create: {
          code: pkg.code,
          name: pkg.name,
          description: pkg.description,
          credits: pkg.credits,
          pricePkr: pkg.pricePkr,
          priceUsd: pkg.priceUsd,
          validityDays: pkg.validityDays,
          sortOrder: pkg.sortOrder,
          isActive: true,
        },
      });
      seededCount++;
    }

    logger.info({ seededCount }, 'Canonical AI credit packages seeded successfully');
    return seededCount;
  }

  /**
   * List all active credit packages for college checkout.
   */
  public async listActivePackages() {
    return await this.prisma.aIAddonPackage.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        credits: true,
        pricePkr: true,
        priceUsd: true,
        validityDays: true,
        sortOrder: true,
      },
    });
  }

  /**
   * Get package by code or ID.
   */
  public async getPackage(identifier: string) {
    return await this.prisma.aIAddonPackage.findFirst({
      where: {
        OR: [{ id: identifier }, { code: identifier }],
      },
    });
  }
}
