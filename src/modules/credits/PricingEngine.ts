/**
 * PricingEngine.ts — Centralized Mathematical Pricing & Margin Calculator
 * ─────────────────────────────────────────────────────────────────────────────
 * Base currency: US Dollar Micro-USD ($0.000001 USD = 1 μUSD).
 * Customer Credits: 1 Credit = 1 μUSD of base compute entitlement.
 * Prohibits per-token rounding; evaluates exact request aggregate floating-point
 * USD cost before converting to integer micro-USD.
 */

export interface ModelPricingRates {
  modelKey: string;
  version: number;
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
}

export interface PricingCalculationResult {
  rawCostUsd: number;                   // Exact continuous floating-point cost in USD
  providerCostMicros: bigint;           // Integer micro-USD ($0.000001 USD per unit)
  customerCreditsDebited: bigint;       // Final debited credits with markup and floor applied
  pricingVersion: number;
  modelKey: string;
}

export class PricingEngine {
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
    // Round mathematically (0.5 rounds up)
    const providerCostMicrosNum = Math.round(totalCostUsd * 1_000_000);
    const providerCostMicros = BigInt(providerCostMicrosNum);

    // Compute Customer Credits with commercial markup
    const markedUpCreditsNum = Math.ceil(providerCostMicrosNum * markup);
    let customerCreditsDebited = BigInt(markedUpCreditsNum);

    // Apply minimum billable credit floor
    if (customerCreditsDebited < minCredits && totalCostUsd > 0) {
      customerCreditsDebited = minCredits;
    }

    return {
      rawCostUsd: totalCostUsd,
      providerCostMicros,
      customerCreditsDebited,
      pricingVersion: rates.version,
      modelKey: rates.modelKey,
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
