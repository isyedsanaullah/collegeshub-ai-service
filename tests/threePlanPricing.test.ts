import { PricingEngine, ModelPricingRates } from '../src/modules/credits/PricingEngine';
import { getPlanMonthlyCredits, SubscriptionSyncService } from '../src/modules/billing/SubscriptionSyncService';
import { getCanonicalPackages, PackageService } from '../src/modules/purchases/PackageService';

describe('Three-Plan AI Pricing & Package Tests (T2.1)', () => {
  test('Haiku-token weight classes (1x / 20x / 40x) decoupled from providerCostMicros under threePlanMode', () => {
    const haikuFlash: ModelPricingRates = {
      modelKey: 'gemini-2.0-flash',
      version: 2,
      weightClass: 'lite',
      inputPricePerMillionUsd: 0.075,
      outputPricePerMillionUsd: 0.300,
    };
    const sonnetPro: ModelPricingRates = {
      modelKey: 'claude-3.5-sonnet',
      version: 2,
      weightClass: 'standard',
      inputPricePerMillionUsd: 3.0,
      outputPricePerMillionUsd: 15.0,
    };
    const opusReasoning: ModelPricingRates = {
      modelKey: 'claude-3-opus',
      version: 2,
      weightClass: 'advanced',
      inputPricePerMillionUsd: 15.0,
      outputPricePerMillionUsd: 75.0,
    };

    const r1 = PricingEngine.calculateUsage(
      { promptTokens: 1000, completionTokens: 200 },
      haikuFlash,
      { threePlanMode: true }
    );
    expect(r1.tokenWeightMultiplier).toBe(1);
    expect(r1.customerCreditsDebited).toBe(1200n);
    expect(r1.providerCostMicros).toBe(135n);

    const r2 = PricingEngine.calculateUsage(
      { promptTokens: 100, completionTokens: 50 },
      sonnetPro,
      { threePlanMode: true }
    );
    expect(r2.tokenWeightMultiplier).toBe(20);
    expect(r2.customerCreditsDebited).toBe(3000n);

    const r3 = PricingEngine.calculateUsage(
      { promptTokens: 100, completionTokens: 50 },
      opusReasoning,
      { threePlanMode: true }
    );
    expect(r3.tokenWeightMultiplier).toBe(40);
    expect(r3.customerCreditsDebited).toBe(6000n);
  });

  test('Three-plan monthly credit grants and packages', () => {
    expect(getPlanMonthlyCredits('starter', true)).toBe(0n);
    expect(getPlanMonthlyCredits('standard', true)).toBe(1_000_000n);
    expect(getPlanMonthlyCredits('premium', true)).toBe(20_000_000n);

    const pkgs = getCanonicalPackages(true);
    expect(pkgs.map(p => p.code)).toEqual(['AI_TOKENS_1M', 'AI_TOKENS_5M']);
    expect(pkgs.find(p => p.code === 'AI_TOKENS_5M')?.pricePkr).toBe(1800);
  });
});
