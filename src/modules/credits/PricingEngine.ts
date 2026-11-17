/**
 * PricingEngine.ts — Centralized Mathematical Pricing & Margin Calculator
 * ─────────────────────────────────────────────────────────────────────────────
 * Base currency: US Dollar Micro-USD ($0.000001 USD = 1 μUSD).
 * Customer Credits: 1 Credit = 1 μUSD of base compute entitlement.
 * Prohibits per-token rounding; evaluates exact request aggregate floating-point
 * USD cost before converting to integer micro-USD.
 */

export type ModelWeightClass = 'lite' | 'standard' | 'advanced';

export const HAIKU_TOKEN_WEIGHTS: Record<ModelWeightClass, number> = {
  lite: 1,
  standard: 20,
  advanced: 40,
};

export interface ModelPricingRates {
  modelKey: string;
  version: number;
  weightClass?: ModelWeightClass;
  inputPricePerMillionUsd: number;      // E.g., 0.075 for Gemini 2.0 Flash
  outputPricePerMillionUsd: number;     // E.g., 0.300 for Gemini 2.0 Flash
  cachedInputPricePerMillionUsd?: number;// E.g., 0.01875
  reasoningPricePerMillionUsd?: number;  // E.g., 0.600 for OpenAI o3-mini
  embeddingPricePerMillionUsd?: number;  // E.g., 0.020 for text-embedding-004
  imagePricePerUnitUsd?: number;         // E.g., 0.001315 per vision image
}

export interface UsageMetrics {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  embeddingTokens?: number;
  imageUnits?: number;
}

export interface PricingEngineOptions {
  commercialMarkupMultiplier?: number;  // Default: 1.0 (markup baked into package PKR retail price)
  minimumBillableCredits?: number;      // Default: 10 credits minimum per execution
  threePlanMode?: boolean;              // Overrides process.env.THREE_PLAN_MODE for deterministic tests
}

export interface PricingCalculationResult {
  rawCostUsd: number;                   // Exact continuous floating-point cost in USD
  providerCostMicros: bigint;           // Integer micro-USD ($0.000001 USD per unit)
  customerCreditsDebited: bigint;       // Final debited credits with markup/weights and floor applied
  pricingVersion: number;
  modelKey: string;
  weightClass?: ModelWeightClass;
  tokenWeightMultiplier?: number;
}

export class PricingEngine {
  public static resolveWeightClass(modelKey: string, explicit?: ModelWeightClass): ModelWeightClass {
    if (explicit && HAIKU_TOKEN_WEIGHTS[explicit]) return explicit;
    const key = String(modelKey || '').toLowerCase();
    if (key.includes('opus') || key.includes('o1') || key.includes('o3')) return 'advanced';
    if (key.includes('sonnet') || (key.includes('gpt-4o') && !key.includes('mini')) || key.includes('2.5-pro') || key.includes('1.5-pro')) {
      return 'standard';
    }
    return 'lite';
  }
  /**
   * Calculate exact provider compute cost and customer credit debit.
   */
  public static calculateUsage(
    metrics: UsageMetrics,
    rates: ModelPricingRates,
    options: PricingEngineOptions = {}
  ): PricingCalculationResult {
    const {
      promptTokens = 0,
      completionTokens = 0,
      cachedTokens = 0,
      reasoningTokens = 0,
      embeddingTokens = 0,
      imageUnits = 0,
    } = metrics;

    const markup = options.commercialMarkupMultiplier ?? 1.0;
    const minCredits = BigInt(options.minimumBillableCredits ?? 10);

    // Continuous floating-point USD accumulation
    let totalCostUsd = 0;

    if (promptTokens > 0) {
      totalCostUsd += (promptTokens * rates.inputPricePerMillionUsd) / 1_000_000;
    }

    if (completionTokens > 0) {
      totalCostUsd += (completionTokens * rates.outputPricePerMillionUsd) / 1_000_000;
    }

    if (cachedTokens > 0 && rates.cachedInputPricePerMillionUsd) {
      totalCostUsd += (cachedTokens * rates.cachedInputPricePerMillionUsd) / 1_000_000;
    }

    if (reasoningTokens > 0 && rates.reasoningPricePerMillionUsd) {
      totalCostUsd += (reasoningTokens * rates.reasoningPricePerMillionUsd) / 1_000_000;
    }

    if (embeddingTokens > 0 && rates.embeddingPricePerMillionUsd) {
      totalCostUsd += (embeddingTokens * rates.embeddingPricePerMillionUsd) / 1_000_000;
    }

    if (imageUnits > 0 && rates.imagePricePerUnitUsd) {
      totalCostUsd += imageUnits * rates.imagePricePerUnitUsd;
    }

    // Convert exact USD cost to integer Micro-USD ($0.000001 USD)
    // Round mathematically (0.5 rounds up) — always tracked internally for SuperAdmin margin analytics.
    const providerCostMicrosNum = Math.round(totalCostUsd * 1_000_000);
    const providerCostMicros = BigInt(providerCostMicrosNum);

    const threePlan = options.threePlanMode ?? (process.env.THREE_PLAN_MODE === 'true');
    const weightClass = PricingEngine.resolveWeightClass(rates.modelKey, rates.weightClass);
    const weightMultiplier = threePlan ? HAIKU_TOKEN_WEIGHTS[weightClass] : 1;

    let customerCreditsDebited: bigint;
    if (threePlan) {
      // Three-Plan mode: decouple customer credits (Haiku-equivalent token weights 1x/20x/40x) from provider μUSD
      const billableTokens =
        Math.max(0, promptTokens) +
        Math.max(0, completionTokens) +
        Math.max(0, cachedTokens) +
        Math.max(0, reasoningTokens) +
        Math.max(0, embeddingTokens);
      const imageEquivalentTokens = Math.max(0, imageUnits) * 1000;
      const weightedCredits = Math.ceil((billableTokens + imageEquivalentTokens) * weightMultiplier * markup);
      customerCreditsDebited = BigInt(weightedCredits);
      if (customerCreditsDebited < minCredits && (billableTokens > 0 || imageUnits > 0)) {
        customerCreditsDebited = minCredits;
      }
    } else {
      // Legacy mode: 1 Credit = 1 μUSD
      const markedUpCreditsNum = Math.ceil(providerCostMicrosNum * markup);
      customerCreditsDebited = BigInt(markedUpCreditsNum);
      if (customerCreditsDebited < minCredits && totalCostUsd > 0) {
        customerCreditsDebited = minCredits;
      }
    }

    return {
      rawCostUsd: totalCostUsd,
      providerCostMicros,
      customerCreditsDebited,
      pricingVersion: rates.version,
      modelKey: rates.modelKey,
      weightClass,
      tokenWeightMultiplier: weightMultiplier,
    };
  }

  /**
   * Compute gross profit and margin percentage from commercial retail revenue and provider cost.
   *
   * @param revenuePkr Retail package price paid in PKR
   * @param providerCostMicros Total provider compute consumed in Micro-USD
   * @param usdToPkrExchangeRate Current USD to PKR exchange rate (e.g., 280)
   */
  public static calculateGrossMargin(
    revenuePkr: number,
    providerCostMicros: bigint,
    usdToPkrExchangeRate: number = 280
  ): { revenueUsd: number; providerCostUsd: number; grossProfitUsd: number; grossMarginPercent: number } {
    const revenueUsd = revenuePkr / usdToPkrExchangeRate;
    const providerCostUsd = Number(providerCostMicros) / 1_000_000;
    const grossProfitUsd = revenueUsd - providerCostUsd;
    const grossMarginPercent = revenueUsd > 0 ? (grossProfitUsd / revenueUsd) * 100 : 0;

    return {
      revenueUsd,
      providerCostUsd,
      grossProfitUsd,
      grossMarginPercent: Math.round(grossMarginPercent * 100) / 100, // 2 decimal places
    };
  }
}

