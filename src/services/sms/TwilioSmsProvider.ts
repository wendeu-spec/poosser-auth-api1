import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import type { SmsProvider } from "./SmsProvider.js";

/**
 * Adaptateur Twilio, alternative si vous préférez ce fournisseur (couverture
 * mondiale plus large mais généralement plus coûteux sur les numéros africains
 * qu'Africa's Talking/Termii). Même remarque que l'adaptateur Africa's Talking :
 * nécessite de vraies clés pour fonctionner réellement.
 */
export class TwilioSmsProvider implements SmsProvider {
  constructor() {
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
      throw new Error(
        "SMS_PROVIDER=twilio mais TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN sont vides. " +
          "Renseignez de vraies clés dans .env ou repassez SMS_PROVIDER=console.",
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
        ? `POOSSER: your verification code is ${code}. Never share it.`
        : `POOSSER: your account recovery code is ${code}. Never share it.`;

    const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
    const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64");

    const body = new URLSearchParams({
      To: phoneE164,
      MessagingServiceSid: env.TWILIO_VERIFY_SERVICE_SID || "",
      Body: message,
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!response.ok) {
      logger.error({ status: response.status, phoneE164 }, "[TwilioSmsProvider] échec d'envoi");
      throw new Error("SMS_SEND_FAILED");
    }
  }
}
