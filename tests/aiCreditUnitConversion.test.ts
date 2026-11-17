import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  convertMicroUsdToHaikuCredits,
  runAiCreditUnitConversion,
} from '../scripts/convert_ai_credit_units';
import { runAiCreditUnitRollback } from '../scripts/rollback_ai_credit_units';

describe('T2.1b AI Credit Unit Conversion & 24h Rollback', () => {
  test('Preserves dollar value via ceil(old / 0.18) and supports <24h coordinated rollback', async () => {
    // $40 old Enterprise balance ($40 = 40M μUSD) -> ceil(40M / 0.18) = 222,222,223 Haiku credits
    expect(convertMicroUsdToHaikuCredits(40_000_000n)).toBe(222_222_223n);
    expect(convertMicroUsdToHaikuCredits(1_000_000n)).toBe(5_555_556n);

    const wallets: Record<string, any> = {
      'w-1': { id: 'w-1', collegeId: 'c-ent', balance: 40_000_000n, reservedBalance: 0n },
    };
    const grants: Record<string, any> = {
      'g-1': { id: 'g-1', walletId: 'w-1', originalAmount: 40_000_000n, remainingAmount: 40_000_000n },
    };
    const ledger: any[] = [];

    const mockPrisma: any = {
      collegeAIWallet: {
        findMany: async () => [{ ...wallets['w-1'], grants: [{ ...grants['g-1'] }] }],
        update: async ({ where, data }: any) => { Object.assign(wallets[where.id], data); },
      },
      aICreditGrant: {
        update: async ({ where, data }: any) => { Object.assign(grants[where.id], data); },
      },
      aICreditLedgerEntry: {
        create: async ({ data }: any) => { ledger.push(data); },
      },
      $transaction: async (fn: any) => await fn(mockPrisma),
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't21b-'));
    const now = new Date('2026-11-18T00:00:00.000Z');

    try {
      const conv = await runAiCreditUnitConversion({ prisma: mockPrisma, dryRun: false, snapshotDir: tmpDir, now });
      expect(conv.walletCount).toBe(1);
      expect(wallets['w-1'].balance).toBe(222_222_223n);
      expect(grants['g-1'].remainingAmount).toBe(222_222_223n);

      // Expired rollback >24h blocked
      await expect(
        runAiCreditUnitRollback({
          snapshotFile: conv.snapshotFile!,
          prisma: mockPrisma,
          now: new Date(now.getTime() + 26 * 3600 * 1000),
        })
      ).rejects.toThrow(/elapsed/i);

      // Rollback within 24h restores true 40M balance
      const rb = await runAiCreditUnitRollback({
        snapshotFile: conv.snapshotFile!,
        prisma: mockPrisma,
        now: new Date(now.getTime() + 2 * 3600 * 1000),
      });
      expect(rb.rolledBack).toBe(true);
      expect(wallets['w-1'].balance).toBe(40_000_000n);
      expect(grants['g-1'].remainingAmount).toBe(40_000_000n);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
