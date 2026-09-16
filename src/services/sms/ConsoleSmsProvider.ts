import { logger } from "../../lib/logger.js";
import type { SmsProvider } from "./SmsProvider.js";

/**
 * Fournisseur de développement : n'envoie AUCUN SMS réel. Il journalise le code
 * dans les logs du serveur (jamais côté client, jamais dans la réponse HTTP) pour
 * permettre de développer et tester le parcours complet sans compte SMS payant.
 *
 * Ce n'est pas un mock de sécurité : le reste du parcours (hachage, expiration,
 * limitation de tentatives, rate limiting) est strictement identique à ce qu'il
 * serait avec un vrai fournisseur — seule l'étape "envoi effectif du SMS" est
 * remplacée par un log serveur, en attendant de vraies clés d'API.
 */
export class ConsoleSmsProvider implements SmsProvider {
  async sendOtp(
    phoneE164: string,
    code: string,
    purpose: "registration" | "account_recovery",
  ): Promise<void> {
    logger.warn(
      { phoneE164, purpose, otpDevOnly: code },
      "[ConsoleSmsProvider] SMS_PROVIDER=console — aucun SMS réel envoyé, code affiché ici uniquement pour le développement",
    );
  }
}
