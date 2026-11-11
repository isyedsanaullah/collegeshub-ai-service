import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { getPrismaClient } from '../../infrastructure/database';
import { getEnv } from '../../config/env';

const env = getEnv();
const logger = pino({ level: env.LOG_LEVEL });

export interface FinancialSummary {
  totalCustomerCreditsDebited: string;
  totalCustomerCreditsAllocated: string;
  totalProviderCostUsd: number;
  totalRevenueUsd: number;
  grossComputeMarginPercent: number;
  activeCollegesCount: number;
}

export interface CollegeUsageSummary {
  collegeId: string;
  walletBalance: string;
  reservedBalance: string;
  totalAllocated: string;
  totalConsumed: string;
  status: string;
  activeGrantsCount: number;
  expiringSoonCredits: string;
}

export class FinancialAnalyticsService {
  private prisma: PrismaClient;

  constructor(prismaClient?: PrismaClient) {
    this.prisma = prismaClient || getPrismaClient();
  }

  /**
   * Calculate institutional AI compute metrics and platform gross margin.
   */
  public async getPlatformFinancialSummary(): Promise<FinancialSummary> {
    // 1. Sum up all completed AI requests
    const requestStats = await this.prisma.aIRequestLog.aggregate({
      where: { status: 'SUCCESS' },
      _sum: {
        creditsDebited: true,
        providerCostMicros: true,
      },
    });

    const totalCreditsDebited = requestStats._sum.creditsDebited || 0n;
    const totalCostMicros = requestStats._sum.providerCostMicros || 0n;
    const totalProviderCostUsd = Number(totalCostMicros) / 1_000_000;

    // 2. Sum up all fulfilled add-on purchases
    const purchaseStats = await this.prisma.aICreditPurchaseRequest.aggregate({
      where: { allocationStatus: 'FULFILLED' },
      _sum: {
        credits: true,
        amountPkr: true,
      },
    });

    const totalPurchasedCredits = purchaseStats._sum.credits || 0n;
    const totalPkr = purchaseStats._sum.amountPkr || 0;
    // 1 USD ≈ 280 PKR
    const totalRevenueUsd = totalPkr / 280;

    // Gross Compute Margin = ((Revenue - ComputeCost) / Revenue) * 100
    let grossComputeMarginPercent = 0;
    if (totalRevenueUsd > 0) {
      grossComputeMarginPercent = ((totalRevenueUsd - totalProviderCostUsd) / totalRevenueUsd) * 100;
      grossComputeMarginPercent = Math.round(grossComputeMarginPercent * 100) / 100;
    } else if (totalProviderCostUsd === 0) {
      grossComputeMarginPercent = 100;
    }

    // 3. Count active college AI wallets
    const activeCollegesCount = await this.prisma.collegeAIWallet.count({
      where: { status: 'ACTIVE' },
    });

    return {
      totalCustomerCreditsDebited: totalCreditsDebited.toString(),
      totalCustomerCreditsAllocated: totalPurchasedCredits.toString(),
      totalProviderCostUsd: Math.round(totalProviderCostUsd * 10000) / 10000,
      totalRevenueUsd: Math.round(totalRevenueUsd * 100) / 100,
      grossComputeMarginPercent,
      activeCollegesCount,
    };
  }

  /**
   * Retrieve wallet summary and credit breakdown for a specific college.
   */
  public async getCollegeUsageSummary(collegeId: string): Promise<CollegeUsageSummary> {
    const wallet = await this.prisma.collegeAIWallet.findUnique({
      where: { collegeId },
      include: {
        grants: {
          where: { remainingAmount: { gt: 0 } },
          orderBy: [{ expiresAt: 'asc' }],
        },
      },
    });

    if (!wallet) {
      return {
        collegeId,
        walletBalance: '0',
        reservedBalance: '0',
        totalAllocated: '0',
        totalConsumed: '0',
        status: 'UNINITIALIZED',
        activeGrantsCount: 0,
        expiringSoonCredits: '0',
      };
    }

    const now = new Date();
    const in7Days = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const expiringSoon = wallet.grants
      .filter((g) => g.expiresAt && g.expiresAt > now && g.expiresAt <= in7Days)
      .reduce((acc, g) => acc + g.remainingAmount, 0n);

    return {
      collegeId,
      walletBalance: wallet.balance.toString(),
      reservedBalance: wallet.reservedBalance.toString(),
      totalAllocated: wallet.totalAllocated.toString(),
      totalConsumed: wallet.totalConsumed.toString(),
      status: wallet.status,
      activeGrantsCount: wallet.grants.length,
      expiringSoonCredits: expiringSoon.toString(),
    };
  }
}
