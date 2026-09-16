import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import type { SmsProvider } from "./SmsProvider.js";

/**
 * Adaptateur Africa's Talking (https://africastalking.com/), pertinent pour une
 * couverture SMS large en Afrique. Structurellement complet et prêt à l'usage,
 * mais nécessite de vraies clés d'API (AFRICASTALKING_USERNAME /
 * AFRICASTALKING_API_KEY dans .env) pour envoyer de vrais SMS — sans ces clés,
 * il refuse explicitement de démarrer plutôt que d'échouer silencieusement.
 */
export class AfricasTalkingSmsProvider implements SmsProvider {
  constructor() {
    if (!env.AFRICASTALKING_USERNAME || !env.AFRICASTALKING_API_KEY) {
      throw new Error(
        "SMS_PROVIDER=africastalking mais AFRICASTALKING_USERNAME / AFRICASTALKING_API_KEY " +
          "sont vides. Renseignez de vraies clés dans .env ou repassez SMS_PROVIDER=console.",
      );
    }
  }

  async sendOtp(
    phoneE164: string,
    code: string,
    purpose: "registration" | "account_recovery",
  ): Promise<void> {
    const message =
      purpose === "registration"
        ? `POOSSER : votre code de vérification est ${code}. Il expire dans quelques minutes. Ne le partagez jamais.`
        : `POOSSER : votre code de récupération de compte est ${code}. Ne le partagez jamais.`;

    const body = new URLSearchParams({
      username: env.AFRICASTALKING_USERNAME,
      to: phoneE164,
      message,
      ...(env.AFRICASTALKING_SENDER_ID ? { from: env.AFRICASTALKING_SENDER_ID } : {}),
    });

    const response = await fetch("https://api.africastalking.com/version1/messaging", {
      method: "POST",
      headers: {
        apiKey: env.AFRICASTALKING_API_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });

    if (!response.ok) {
      // On ne journalise jamais le corps de la requête (contient le code) : uniquement
      // le statut HTTP, pour diagnostiquer une panne fournisseur sans fuite de secret.
      logger.error({ status: response.status, phoneE164 }, "[AfricasTalkingSmsProvider] échec d'envoi");
      throw new Error("SMS_SEND_FAILED");
    }
  }
}
