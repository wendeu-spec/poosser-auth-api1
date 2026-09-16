/**
 * Erreurs applicatives typées. Chaque erreur porte un code stable (utilisé par le
 * client pour se brancher dessus) et un statut HTTP — le message affiché à
 * l'utilisateur est résolu séparément via i18n (voir src/i18n), jamais construit
 * ici avec des détails internes.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, statusCode: number, details?: Record<string, unknown>) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.name = "AppError";
  }
}

export const Errors = {
  validation: (details?: Record<string, unknown>) => new AppError("VALIDATION_ERROR", 400, details),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError("RATE_LIMITED", 429, { retryAfterSeconds }),
  otpInvalid: () => new AppError("OTP_INVALID", 400),
  otpTicketInvalid: () => new AppError("OTP_TICKET_INVALID", 400),
  phoneAlreadyRegistered: () => new AppError("PHONE_ALREADY_REGISTERED", 409),
  pinTooWeak: () => new AppError("PIN_TOO_WEAK", 400),
  invalidCredentials: () => new AppError("INVALID_CREDENTIALS", 401),
  accountLocked: (retryAfterSeconds: number) =>
    new AppError("ACCOUNT_LOCKED", 423, { retryAfterSeconds }),
  refreshInvalid: () => new AppError("REFRESH_INVALID", 401),
  refreshReuseDetected: () => new AppError("REFRESH_REUSE_DETECTED", 401),
  deviceNotFound: () => new AppError("DEVICE_NOT_FOUND", 404),
  transactionPinNotSet: () => new AppError("TRANSACTION_PIN_NOT_SET", 400),
  unauthorized: () => new AppError("UNAUTHORIZED", 401),
  forbidden: () => new AppError("FORBIDDEN", 403),
  internal: () => new AppError("INTERNAL_ERROR", 500),

  // Ressources métier (transactions, budget, épargne, tontine, planner) —
  // chaque ressource a son propre code 404 pour rester cohérent avec le style
  // déjà en place (deviceNotFound) plutôt qu'un NOT_FOUND générique.
  transactionNotFound: () => new AppError("TRANSACTION_NOT_FOUND", 404),
  budgetNotFound: () => new AppError("BUDGET_NOT_FOUND", 404),
  savingsGoalNotFound: () => new AppError("SAVINGS_GOAL_NOT_FOUND", 404),
  tontineNotFound: () => new AppError("TONTINE_NOT_FOUND", 404),
  tontineMemberNotFound: () => new AppError("TONTINE_MEMBER_NOT_FOUND", 404),
  plannerEventNotFound: () => new AppError("PLANNER_EVENT_NOT_FOUND", 404),
  tontineRoundNotReady: () => new AppError("TONTINE_ROUND_NOT_READY", 409),
};
