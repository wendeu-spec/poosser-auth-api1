/**
 * Abstraction du fournisseur SMS. Toute la logique métier (otpService, routes)
 * ne connaît que cette interface — jamais un SDK ou une API HTTP de fournisseur
 * spécifique. Changer de fournisseur = écrire une nouvelle classe ici et changer
 * SMS_PROVIDER dans .env, sans toucher au reste de l'application.
 */
export interface SmsProvider {
  sendOtp(phoneE164: string, code: string, purpose: "registration" | "account_recovery"): Promise<void>;
}
