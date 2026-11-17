/**
 * T2.1b — 24-Hour Snapshot Rollback for AI Credit Unit Conversion
 *
 * Usage:
 *   npx tsx scripts/rollback_ai_credit_units.ts --snapshot backups/ai_credit_conversion_<ts>.json
 */

import fs from 'fs';
import { getPrismaClient } from '../src/infrastructure/database';
import { ROLLBACK_WINDOW_HOURS } from './convert_ai_credit_units';

export async function runAiCreditUnitRollback({
  snapshotFile,
  prisma = getPrismaClient(),
  force = false,
  now = new Date(),
}: {
  snapshotFile: string;
  prisma?: any;
  force?: boolean;
  now?: Date;
}) {
  const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  const convertedAt = new Date(snapshot.convertedAt);
  const elapsedHours = (now.getTime() - convertedAt.getTime()) / (3600 * 1000);

  if (elapsedHours > ROLLBACK_WINDOW_HOURS && !force) {
    throw Object.assign(
      new Error(`Snapshot rollback window (${ROLLBACK_WINDOW_HOURS}h) has elapsed (${elapsedHours.toFixed(1)}h). Use forward fixes or pass force=true explicitly.`),
      { code: 'ROLLBACK_WINDOW_EXPIRED' }
    );
  }

  await prisma.$transaction(async (tx: any) => {
    for (const entry of snapshot.entries || []) {
      const oldBal = BigInt(entry.oldBalance);
      const newBal = BigInt(entry.newBalance);
      const delta = oldBal - newBal;

      await tx.collegeAIWallet.update({
        where: { id: entry.walletId },
        data: {
          balance: oldBal,
          reservedBalance: BigInt(entry.oldReservedBalance),
        },
      });
      for (const g of entry.grants || []) {
        await tx.aICreditGrant.update({
          where: { id: g.grantId },
          data: {
            originalAmount: BigInt(g.oldOriginalAmount),
            remainingAmount: BigInt(g.oldRemainingAmount),
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
            balanceAfter: oldBal,
            description: 'T2.1b Snapshot Rollback restoring legacy Micro-USD wallet credits',
            metadata: { reason: 'THREE_PLAN_MODE_ROLLBACK', snapshotFile },
          },
        });
      }
    }
  });

  return {
    rolledBack: true,
    restoredWallets: (snapshot.entries || []).length,
    elapsedHours: Math.round(elapsedHours * 100) / 100,
  };
}

if (require.main === module) {
  const snapIdx = process.argv.indexOf('--snapshot');
  const snapshotFile = snapIdx !== -1 ? process.argv[snapIdx + 1] : '';
  const force = process.argv.includes('--force');
  if (!snapshotFile) {
    console.error('Usage: npx tsx scripts/rollback_ai_credit_units.ts --snapshot <path>');
    process.exit(1);
  }
  runAiCreditUnitRollback({ snapshotFile, force })
    .then((res) => {
      console.log(JSON.stringify(res, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error('[rollback_ai_credit_units] Error:', err);
      process.exit(1);
    });
}
