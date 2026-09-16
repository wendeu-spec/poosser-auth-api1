import { env } from "../../config/env.js";
import type { SmsProvider } from "./SmsProvider.js";
import { ConsoleSmsProvider } from "./ConsoleSmsProvider.js";
import { AfricasTalkingSmsProvider } from "./AfricasTalkingSmsProvider.js";
import { TwilioSmsProvider } from "./TwilioSmsProvider.js";

/**
 * Point d'entrée unique : le reste de l'application importe `smsProvider` d'ici
 * et ne sait jamais quelle implémentation concrète tourne derrière.
 */
function buildSmsProvider(): SmsProvider {
  switch (env.SMS_PROVIDER) {
    case "africastalking":
      return new AfricasTalkingSmsProvider();
    case "twilio":
      return new TwilioSmsProvider();
    case "console":
    default:
      return new ConsoleSmsProvider();
  }
}

export const smsProvider: SmsProvider = buildSmsProvider();
export type { SmsProvider } from "./SmsProvider.js";
