import { PricingEngine, ModelPricingRates } from '../src/modules/credits/PricingEngine';

describe('PricingEngine Unit Tests', () => {
  const geminiFlashRates: ModelPricingRates = {
    modelKey: 'gemini-2.0-flash',
    version: 1,
    inputPricePerMillionUsd: 0.075,
    outputPricePerMillionUsd: 0.300,
    cachedInputPricePerMillionUsd: 0.01875,
  };

  const gpt4oMiniRates: ModelPricingRates = {
    modelKey: 'gpt-4o-mini',
    version: 1,
    inputPricePerMillionUsd: 0.150,
    outputPricePerMillionUsd: 0.600,
  };

  test('Gemini 2.0 Flash: 1,200 input, 350 output produces exact 195 micro-USD', () => {
    // Math: (1200 * 0.075 + 350 * 0.300) / 1,000,000 = (90 + 105) / 1,000,000 = $0.000195 USD
    // In micro-USD: 195 μUSD = 195 Credits
    const result = PricingEngine.calculateUsage(
      { promptTokens: 1200, completionTokens: 350 },
      geminiFlashRates
    );

    expect(result.rawCostUsd).toBeCloseTo(0.000195, 8);
    expect(result.providerCostMicros).toBe(195n);
    expect(result.customerCreditsDebited).toBe(195n);
  });

  test('Gemini 2.0 Flash: 100 input, 25 output produces exact 15 micro-USD', () => {
    // Math: (100 * 0.075 + 25 * 0.300) / 1,000,000 = (7.5 + 7.5) / 1,000,000 = $0.000015 USD
    // In micro-USD: 15 μUSD = 15 Credits
    const result = PricingEngine.calculateUsage(
      { promptTokens: 100, completionTokens: 25 },
      geminiFlashRates
    );

    expect(result.rawCostUsd).toBeCloseTo(0.000015, 8);
    expect(result.providerCostMicros).toBe(15n);
    expect(result.customerCreditsDebited).toBe(15n);
  });

  test('Enforces minimum billable credit floor for tiny requests', () => {
    // Math: 10 input, 2 output = $0.00000135 USD = 1 micro-USD
    // With minimum floor = 10 credits:
    const result = PricingEngine.calculateUsage(
      { promptTokens: 10, completionTokens: 2 },
      geminiFlashRates,
      { minimumBillableCredits: 10 }
    );

    expect(result.providerCostMicros).toBe(1n);
    expect(result.customerCreditsDebited).toBe(10n);
  });

  test('Calculates commercial markup multiplier correctly', () => {
    // Base cost: 195 micro-USD
    // Markup 1.5x (50% markup): 195 * 1.5 = 292.5 -> ceil = 293 credits
    const result = PricingEngine.calculateUsage(
      { promptTokens: 1200, completionTokens: 350 },
      geminiFlashRates,
      { commercialMarkupMultiplier: 1.5 }
    );

    expect(result.providerCostMicros).toBe(195n);
    expect(result.customerCreditsDebited).toBe(293n);
  });

  test('Calculates cached and reasoning tokens', () => {
    const o3Rates: ModelPricingRates = {
      modelKey: 'o3-mini',
      version: 1,
      inputPricePerMillionUsd: 1.10,
      outputPricePerMillionUsd: 4.40,
      reasoningPricePerMillionUsd: 4.40,
    };

    // 1000 prompt tokens ($0.0011) + 500 reasoning tokens ($0.0022) + 200 output tokens ($0.00088)
    // Total: $0.00418 USD = 4180 micro-USD
    const result = PricingEngine.calculateUsage(
      { promptTokens: 1000, reasoningTokens: 500, completionTokens: 200 },
      o3Rates
    );

    expect(result.rawCostUsd).toBeCloseTo(0.00418, 8);
    expect(result.providerCostMicros).toBe(4180n);
  });

  test('Gross margin proof: 500 PKR @ 280 PKR/USD with 625,000 micro-USD compute = 65.0% margin', () => {
    const margin = PricingEngine.calculateGrossMargin(500, 625_000n, 280);

    // Revenue: 500 / 280 = $1.7857 USD
    // Provider Cost: 625,000 μUSD = $0.6250 USD
    // Profit: $1.7857 - $0.6250 = $1.1607 USD
    // Margin: 1.1607 / 1.7857 = 65.0%
    expect(margin.revenueUsd).toBeCloseTo(1.7857, 4);
    expect(margin.providerCostUsd).toBeCloseTo(0.625, 4);
    expect(margin.grossMarginPercent).toBe(65.0);
  });

  test('Gross margin proof: 500 PKR @ 280 PKR/USD with 120,000 micro-USD Flash compute = 93.28% margin', () => {
    const margin = PricingEngine.calculateGrossMargin(500, 120_000n, 280);

    // Revenue: 500 / 280 = $1.7857 USD
    // Provider Cost: 120,000 μUSD = $0.1200 USD
    // Profit: $1.7857 - $0.1200 = $1.6657 USD
    // Margin: 1.6657 / 1.7857 = 93.28%
    expect(margin.grossMarginPercent).toBe(93.28);
  });
});
