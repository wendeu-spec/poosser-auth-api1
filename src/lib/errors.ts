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
  projectNotFound: () => new AppError("PROJECT_NOT_FOUND", 404),
  rubriqueNotFound: () => new AppError("RUBRIQUE_NOT_FOUND", 404),
  savingsGoalNotFound: () => new AppError("SAVINGS_GOAL_NOT_FOUND", 404),
  tontineNotFound: () => new AppError("TONTINE_NOT_FOUND", 404),
  tontineMemberNotFound: () => new AppError("TONTINE_MEMBER_NOT_FOUND", 404),
  plannerEventNotFound: () => new AppError("PLANNER_EVENT_NOT_FOUND", 404),
  tontineRoundNotReady: () => new AppError("TONTINE_ROUND_NOT_READY", 409),
  // Tontine adossée à un compte réel (voir migrations/034). La cagnotte d'une
  // tontine n'est pas un compte dans lequel on puise : elle ne peut être ni la
  // source d'une cotisation ni la destination d'un encaissement.
  tontineAccountNotUsable: () => new AppError("TONTINE_ACCOUNT_NOT_USABLE", 409),

  // Caisse de secours (voir migrations/035_tontine_caisse.sql).
  tontineNotConfigured: () => new AppError("TONTINE_NOT_CONFIGURED", 409),
  tontineNotCollector: () => new AppError("TONTINE_NOT_COLLECTOR", 409),
  caisseMovementNotFound: () => new AppError("CAISSE_MOVEMENT_NOT_FOUND", 404),
  // `details` porte ce que la caisse détient, pour dire combien est possible
  // plutôt que de refuser sans expliquer.
  caisseEmpty: (details: Record<string, unknown>) => new AppError("CAISSE_INSUFFICIENT", 409, details),
  transactionIsTontineMovement: () => new AppError("TRANSACTION_IS_TONTINE_MOVEMENT", 409),
  transferBacksTontine: () => new AppError("TRANSFER_BACKS_TONTINE", 409),
  transactionFavoriteNotFound: () => new AppError("TRANSACTION_FAVORITE_NOT_FOUND", 404),
  categoryNotFound: () => new AppError("CATEGORY_NOT_FOUND", 404),
  categoryAlreadyExists: () => new AppError("CATEGORY_ALREADY_EXISTS", 409),
  budgetProposalNotFound: () => new AppError("BUDGET_PROPOSAL_NOT_FOUND", 404),

  // Comptes et virements (voir migrations/029_accounts_transfers.sql).
  accountNotFound: () => new AppError("ACCOUNT_NOT_FOUND", 404),
  accountNameTaken: () => new AppError("ACCOUNT_NAME_TAKEN", 409),
  accountInUse: () => new AppError("ACCOUNT_IN_USE", 409),
  accountArchived: () => new AppError("ACCOUNT_ARCHIVED", 409),
  accountLastActive: () => new AppError("ACCOUNT_LAST_ACTIVE", 409),
  transferNotFound: () => new AppError("TRANSFER_NOT_FOUND", 404),
  transferBacksSavings: () => new AppError("TRANSFER_BACKS_SAVINGS", 409),

  // Épargne adossée à un compte réel (voir migrations/033 et
  // savingsGoalService). Les `details` portent le solde et la part déjà
  // réservée, pour que l'app dise « il ne reste que X sur ce compte » plutôt
  // qu'un refus sec.
  savingsExceedsAccount: (details: Record<string, unknown>) => new AppError("SAVINGS_EXCEEDS_ACCOUNT", 409, details),
  savingsGoalAccountMissing: () => new AppError("SAVINGS_GOAL_ACCOUNT_MISSING", 409),
  savingsWithdrawalTooLarge: (details: Record<string, unknown>) =>
    new AppError("SAVINGS_WITHDRAWAL_TOO_LARGE", 409, details),
  transactionLinkedToTransfer: () => new AppError("TRANSACTION_LINKED_TO_TRANSFER", 409),
  transactionIsFee: () => new AppError("TRANSACTION_IS_FEE", 409),

  // Formules d'abonnement (voir src/services/entitlementService.ts). Les
  // `details` nomment la formule qui lèverait la limite, pour que l'app
  // propose une sortie plutôt qu'un mur.
  planLimitReached: (details: Record<string, unknown>) => new AppError("PLAN_LIMIT_REACHED", 403, details),
  planFeatureRequired: (details: Record<string, unknown>) => new AppError("PLAN_FEATURE_REQUIRED", 403, details),
  planQuotaExhausted: (details: Record<string, unknown>) => new AppError("PLAN_QUOTA_EXHAUSTED", 403, details),
};
