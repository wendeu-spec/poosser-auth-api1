import pino from "pino";
import { env } from "../config/env.js";

/**
 * Logger central. La liste `redact` est une seconde ligne de défense : même si
 * un développeur passe accidentellement un objet contenant `pin`/`otp`/`token`
 * à `logger.info(...)`, pino remplace la valeur par "[Redacted]" plutôt que de
 * l'écrire en clair. La vraie règle reste néanmoins de ne JAMAIS construire un
 * objet de log contenant ces champs — voir docs/SECURITY_REPORT.md.
 */
export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : env.NODE_ENV === "production" ? "info" : "debug",
  redact: {
    paths: [
      "pin",
      "*.pin",
      "newPin",
      "*.newPin",
      "currentPin",
      "*.currentPin",
      "pinConfirmation",
      "*.pinConfirmation",
      "transactionPin",
      "*.transactionPin",
      "newTransactionPin",
      "*.newTransactionPin",
      "currentTransactionPin",
      "*.currentTransactionPin",
      "code",
      "*.code",
      "otp",
      "*.otp",
      "password",
      "*.password",
      "accessToken",
      "*.accessToken",
      "refreshToken",
      "*.refreshToken",
      "otpVerificationTicket",
      "*.otpVerificationTicket",
      "stepUpToken",
      "*.stepUpToken",
      "req.headers.authorization",
    ],
    censor: "[Redacted]",
  },
});
