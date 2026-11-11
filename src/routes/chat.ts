import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import pino from 'pino';
import { verifyServiceAssertion } from '../security/verifyServiceAssertion';
import { ModelRouter } from '../modules/routing/ModelRouter';
import { ModelRegistryService } from '../modules/models/ModelRegistryService';
import { PricingEngine } from '../modules/credits/PricingEngine';
import { ReservationService } from '../modules/credits/ReservationService';
import { SettlementService } from '../modules/credits/SettlementService';
import { getEnv } from '../config/env';

const router = Router();
const env = getEnv();
const logger = pino({ level: env.LOG_LEVEL });

const modelRouter = new ModelRouter();
const modelRegistry = new ModelRegistryService();
const reservationService = new ReservationService();
const settlementService = new SettlementService();

/**
 * POST /internal/v1/chat/stream
 * Metered streaming chat endpoint with pre-flight reservation, client abort detection,
 * and post-execution FEFO settlement.
 */
router.post('/stream', verifyServiceAssertion, async (req: Request, res: Response): Promise<void> => {
  const tenantContext = req.tenantContext!;
  const correlationId = (req.headers['x-request-id'] as string) || crypto.randomUUID();
  const {
    featureKey = 'ai-chat',
    messages = [],
    temperature = 0.7,
    maxTokens = 2048,
  } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({
      success: false,
      error: 'INVALID_MESSAGES',
      message: 'messages array is required and must not be empty',
    });
    return;
  }

  // 1. Resolve model route
  let route;
  try {
    route = await modelRouter.resolveRoute(featureKey);
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'ROUTE_RESOLUTION_FAILED',
      message: err.message,
    });
    return;
  }

  // 2. Fetch active model pricing rates
  const rates = await modelRegistry.getActivePricing(route.modelKey);

  // 3. Estimate maximum token cost for pre-flight reservation hold
  // Estimate prompt tokens roughly (1 token ≈ 4 characters) + max completion tokens ceiling
  const rawPromptChars = messages.map((m: any) => m.content || '').join(' ').length;
  const estimatedPromptTokens = Math.max(100, Math.ceil(rawPromptChars / 4));
  const estimatedCeilingResult = PricingEngine.calculateUsage(
    {
      promptTokens: estimatedPromptTokens,
      completionTokens: maxTokens,
    },
    rates
  );

  // 4. Acquire Two-Phase Pre-Flight Reservation Hold
  try {
    await reservationService.reserveCredits({
      collegeId: tenantContext.collegeId,
      requestId: correlationId,
      estimatedCredits: estimatedCeilingResult.customerCreditsDebited,
      ttlSeconds: 300,
    });
  } catch (err: any) {
    if (err.name === 'InsufficientCreditsError') {
      res.status(422).json({
        success: false,
        error: 'INSUFFICIENT_AI_CREDITS',
        message: err.message,
        details: err.details,
      });
      return;
    }
    res.status(err.status || 500).json({
      success: false,
      error: err.code || 'RESERVATION_FAILED',
      message: err.message,
    });
    return;
  }

  // 5. Initialize SSE Stream Headers
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Request-Id', correlationId);
  res.flushHeaders?.();

  // 6. Setup Upstream Abort Controller & Disconnect Listener
  const abortController = new AbortController();
  let streamEndedNormally = false;
  let partialDeliveredText = '';

  req.on('close', async () => {
    if (!res.writableEnded && !streamEndedNormally) {
      abortController.abort();
      logger.warn(
        { correlationId, collegeId: tenantContext.collegeId },
        'Client disconnected mid-stream; settling partial delivered tokens'
      );

      // Estimate tokens delivered up to abort
      const partialCompletionTokens = Math.ceil(partialDeliveredText.length / 4);
      const partialPricing = PricingEngine.calculateUsage(
        { promptTokens: estimatedPromptTokens, completionTokens: partialCompletionTokens },
        rates
      );

      try {
        await settlementService.settleReservation({
          requestId: correlationId,
          actualCredits: partialPricing.customerCreditsDebited,
          metadata: {
            reason: 'CLIENT_DISCONNECTED_MID_STREAM',
            partialCompletionTokens,
            estimatedPromptTokens,
            modelKey: route.modelKey,
          },
        });
      } catch (settleErr: any) {
        logger.error({ settleErr: settleErr.message, correlationId }, 'Failed to settle partial stream on client disconnect');
      }
    }
  });

  // 7. Execute Streaming Ingress Loop
  try {
    const stream = route.adapter.stream(
      {
        modelKey: route.modelKey,
        messages,
        temperature,
        maxTokens,
        abortSignal: abortController.signal,
      },
      route.apiKey
    );

    let finalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    for await (const chunk of stream) {
      if (abortController.signal.aborted) break;

      if (chunk.text) {
        partialDeliveredText += chunk.text;
        res.write(`data: ${JSON.stringify({ text: chunk.text, done: false })}\n\n`);
      }

      if (chunk.done && chunk.usage) {
        finalUsage = chunk.usage;
      }
    }

    streamEndedNormally = true;

    // 8. Calculate Final Exact Usage & Settle
    const finalPricing = PricingEngine.calculateUsage(finalUsage, rates);

    const settlement = await settlementService.settleReservation({
      requestId: correlationId,
      actualCredits: finalPricing.customerCreditsDebited,
      metadata: {
        modelKey: route.modelKey,
        provider: route.provider,
        pricingVersion: rates.version,
        promptTokens: finalUsage.promptTokens,
        completionTokens: finalUsage.completionTokens,
        totalTokens: finalUsage.totalTokens,
        rawCostUsd: finalPricing.rawCostUsd,
      },
    });

    // 9. Flush Terminal Done Event with Usage Metrics
    res.write(
      `data: ${JSON.stringify({
        text: '',
        done: true,
        usage: finalUsage,
        creditsDebited: settlement.actualCredits.toString(),
        balanceAfter: settlement.balanceAfter.toString(),
        unusedHoldReleased: settlement.unusedCreditsReleased.toString(),
      })}\n\n`
    );
    res.end();
  } catch (execErr: any) {
    if (!res.writableEnded) {
      logger.error({ execErr: execErr.message, correlationId }, 'Streaming execution failure; releasing reservation hold');
      await settlementService.releaseReservation({
        requestId: correlationId,
        reason: execErr.message || 'Upstream provider failure during streaming',
      }).catch(() => {});

      res.write(`data: ${JSON.stringify({ text: `AI Service Error: ${execErr.message}`, done: true, error: true })}\n\n`);
      res.end();
    }
  }
});

/**
 * POST /internal/v1/chat/completions
 * Unary non-streaming chat endpoint with pre-flight reservation hold and final FEFO settlement.
 */
router.post('/completions', verifyServiceAssertion, async (req: Request, res: Response): Promise<void> => {
  const tenantContext = req.tenantContext!;
  const correlationId = (req.headers['x-request-id'] as string) || crypto.randomUUID();
  const {
    featureKey = 'ai-chat',
    messages = [],
    temperature = 0.7,
    maxTokens = 2048,
  } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({
      success: false,
      error: 'INVALID_MESSAGES',
      message: 'messages array is required and must not be empty',
    });
    return;
  }

  // 1. Resolve model route
  let route;
  try {
    route = await modelRouter.resolveRoute(featureKey);
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'ROUTE_RESOLUTION_FAILED',
      message: err.message,
    });
    return;
  }

  // 2. Fetch active model pricing rates
  const rates = await modelRegistry.getActivePricing(route.modelKey);

  // 3. Estimate maximum token cost for pre-flight reservation hold
  const rawPromptChars = messages.map((m: any) => m.content || '').join(' ').length;
  const estimatedPromptTokens = Math.max(100, Math.ceil(rawPromptChars / 4));
  const estimatedCeilingResult = PricingEngine.calculateUsage(
    {
      promptTokens: estimatedPromptTokens,
      completionTokens: maxTokens,
    },
    rates
  );

  // 4. Acquire Two-Phase Pre-Flight Reservation Hold
  try {
    await reservationService.reserveCredits({
      collegeId: tenantContext.collegeId,
      requestId: correlationId,
      estimatedCredits: estimatedCeilingResult.customerCreditsDebited,
      ttlSeconds: 300,
    });
  } catch (err: any) {
    if (err.name === 'InsufficientCreditsError') {
      res.status(422).json({
        success: false,
        error: 'INSUFFICIENT_AI_CREDITS',
        message: err.message,
        details: err.details,
      });
      return;
    }
    res.status(err.status || 500).json({
      success: false,
      error: err.code || 'RESERVATION_FAILED',
      message: err.message,
    });
    return;
  }

  // 5. Execute Non-Streaming Completion with Upstream Provider
  try {
    const result = await route.adapter.generate(
      {
        modelKey: route.modelKey,
        messages,
        temperature,
        maxTokens,
      },
      route.apiKey
    );

    // 6. Calculate Final Usage & Settle
    const finalPricing = PricingEngine.calculateUsage(result.usage, rates);

    const settlement = await settlementService.settleReservation({
      requestId: correlationId,
      actualCredits: finalPricing.customerCreditsDebited,
      metadata: {
        modelKey: route.modelKey,
        provider: route.provider,
        pricingVersion: rates.version,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens,
        rawCostUsd: finalPricing.rawCostUsd,
      },
    });

    res.status(200).json({
      success: true,
      text: result.text,
      usage: result.usage,
      modelKey: route.modelKey,
      provider: route.provider,
      creditsDebited: settlement.actualCredits.toString(),
      balanceAfter: settlement.balanceAfter.toString(),
      unusedHoldReleased: settlement.unusedCreditsReleased.toString(),
    });
  } catch (execErr: any) {
    logger.error({ execErr: execErr.message, correlationId }, 'Unary execution failure; releasing reservation hold');
    await settlementService.releaseReservation({
      requestId: correlationId,
      reason: execErr.message || 'Upstream provider failure during unary generation',
    }).catch(() => {});

    res.status(502).json({
      success: false,
      error: 'UPSTREAM_PROVIDER_ERROR',
      message: execErr.message || 'Error occurred communicating with upstream AI provider',
    });
  }
});

export default router;
