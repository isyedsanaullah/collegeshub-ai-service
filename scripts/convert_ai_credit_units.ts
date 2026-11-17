/**
 * T2.1b — Stage 3 Atomic AI Credit Unit Conversion (Micro-USD -> Haiku Token Credits)
 *
 * Converts CollegeAIWallet & active AICreditGrant balances from micro-USD ($1/1M)
 * to Haiku-token credits ($0.18/1M) via ceil(old / 0.18) atomically alongside THREE_PLAN_MODE=true,
 * writing a snapshot file for coordinated 24-hour rollback.
 *
 * Usage:
 *   npx tsx scripts/convert_ai_credit_units.ts --dry-run
 *   npx tsx scripts/convert_ai_credit_units.ts --apply
 */

import fs from 'fs';
import path from 'path';
import { getPrismaClient } from '../src/infrastructure/database';

export const MICRO_USD_PER_HAIKU_MILLION = 0.18;
export const ROLLBACK_WINDOW_HOURS = 24;

export function convertMicroUsdToHaikuCredits(oldCredits: bigint): bigint {
  if (oldCredits <= 0n) return 0n;
  // Exact integer ceiling without float drift beyond 53-bit safe range: ceil(old * 100 / 18)
  return (oldCredits * 100n + 17n) / 18n;
}

export interface WalletConversionSnapshotEntry {
  walletId: string;
  collegeId: string;
  oldBalance: string;
  newBalance: string;
  oldReservedBalance: string;
  newReservedBalance: string;
  grants: Array<{
    grantId: string;
    oldOriginalAmount: string;
    newOriginalAmount: string;
    oldRemainingAmount: string;
    newRemainingAmount: string;
  }>;
}

export async function runAiCreditUnitConversion({
  prisma = getPrismaClient(),
  dryRun = true,
  snapshotDir = path.join(process.cwd(), 'backups'),
  now = new Date(),
}: {
  prisma?: any;
  dryRun?: boolean;
  snapshotDir?: string;
  now?: Date;
} = {}) {
  const wallets = await prisma.collegeAIWallet.findMany({
    include: { grants: true },
  });

  const entries: WalletConversionSnapshotEntry[] = wallets.map((w: any) => {
    const oldBalance = BigInt(w.balance || 0);
    const oldReserved = BigInt(w.reservedBalance || 0);
    return {
      walletId: w.id,
      collegeId: w.collegeId,
      oldBalance: oldBalance.toString(),
      newBalance: convertMicroUsdToHaikuCredits(oldBalance).toString(),
      oldReservedBalance: oldReserved.toString(),
      newReservedBalance: convertMicroUsdToHaikuCredits(oldReserved).toString(),
      grants: (w.grants || []).map((g: any) => {
        const oldOrig = BigInt(g.originalAmount || 0);
        const oldRem = BigInt(g.remainingAmount || 0);
        return {
          grantId: g.id,
          oldOriginalAmount: oldOrig.toString(),
          newOriginalAmount: convertMicroUsdToHaikuCredits(oldOrig).toString(),
          oldRemainingAmount: oldRem.toString(),
          newRemainingAmount: convertMicroUsdToHaikuCredits(oldRem).toString(),
        };
      }),
    };
  });

  const snapshot = {
    version: 'T2.1b-v1',
    convertedAt: now.toISOString(),
    rollbackExpiresAt: new Date(now.getTime() + ROLLBACK_WINDOW_HOURS * 3600 * 1000).toISOString(),
    divisor: MICRO_USD_PER_HAIKU_MILLION,
    dryRun,
    walletCount: entries.length,
    entries,
  };

  let snapshotFile: string | null = null;
  if (!dryRun) {
    if (!fs.existsSync(snapshotDir)) fs.mkdirSync(snapshotDir, { recursive: true });
    snapshotFile = path.join(snapshotDir, `ai_credit_conversion_${now.getTime()}.json`);
    fs.writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2), 'utf8');

    await prisma.$transaction(async (tx: any) => {
      for (const entry of entries) {
        const delta = BigInt(entry.newBalance) - BigInt(entry.oldBalance);
        await tx.collegeAIWallet.update({
          where: { id: entry.walletId },
          data: {
            balance: BigInt(entry.newBalance),
            reservedBalance: BigInt(entry.newReservedBalance),
          },
        });
        for (const g of entry.grants) {
          await tx.aICreditGrant.update({
            where: { id: g.grantId },
            data: {
              originalAmount: BigInt(g.newOriginalAmount),
              remainingAmount: BigInt(g.newRemainingAmount),
            },
          });
        }
        if (delta !== 0n) {
          await tx.aICreditLedgerEntry.create({
            data: {
              collegeId: entry.collegeId,
              walletId: entry.walletId,
              type: 'MANUAL_ADJUSTMENT',
              amount: delta,
              balanceAfter: BigInt(entry.newBalance),
              description: 'T2.1b Micro-USD to Haiku-token credit unit conversion (ceil(old / 0.18))',
              metadata: { reason: 'THREE_PLAN_MODE_CUTOVER', divisor: MICRO_USD_PER_HAIKU_MILLION },
            },
          });
        }
      }
    });
  }

  return { ...snapshot, snapshotFile };
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  runAiCreditUnitConversion({ dryRun: !apply })
    .then((res) => {
      console.log(JSON.stringify(res, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error('[convert_ai_credit_units] Error:', err);
      process.exit(1);
    });
}
