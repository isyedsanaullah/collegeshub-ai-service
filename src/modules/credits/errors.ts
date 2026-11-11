/**
 * errors.ts — Domain Financial & Concurrency Errors
 * ─────────────────────────────────────────────────────────────────────────────
 * Machine-readable, structured financial error types.
 */

export class FinancialError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly details?: Record<string, unknown>;

  constructor(message: string, code: string, status: number = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = 'FinancialError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class InsufficientCreditsError extends FinancialError {
  constructor(available: bigint, requested: bigint) {
    super(
      `Insufficient AI credits: Available balance is ${available.toString()}, but ${requested.toString()} credits were requested.`,
      'INSUFFICIENT_AI_CREDITS',
      422,
      { available: available.toString(), requested: requested.toString() }
    );
    this.name = 'InsufficientCreditsError';
  }
}

export class WalletNotFoundError extends FinancialError {
  constructor(collegeId: string) {
    super(`AI wallet not found for college ${collegeId}`, 'WALLET_NOT_FOUND', 404, { collegeId });
    this.name = 'WalletNotFoundError';
  }
}

export class WalletSuspendedError extends FinancialError {
  constructor(collegeId: string, status: string) {
    super(
      `AI wallet for college ${collegeId} is ${status}. Transactions are blocked.`,
      'WALLET_SUSPENDED',
      403,
      { collegeId, status }
    );
    this.name = 'WalletSuspendedError';
  }
}

export class ReservationNotFoundError extends FinancialError {
  constructor(requestId: string) {
    super(`Reservation not found for requestId: ${requestId}`, 'RESERVATION_NOT_FOUND', 404, { requestId });
    this.name = 'ReservationNotFoundError';
  }
}

export class InvalidReservationStateError extends FinancialError {
  constructor(requestId: string, currentStatus: string) {
    super(
      `Cannot settle reservation for requestId ${requestId}. Current status is ${currentStatus} (expected 'HELD').`,
      'INVALID_RESERVATION_STATE',
      409,
      { requestId, currentStatus }
    );
    this.name = 'InvalidReservationStateError';
  }
}

