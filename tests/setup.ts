import { config as loadEnv } from "dotenv";
import path from "node:path";
import { vi } from "vitest";

// Charge .env.test AVANT que quoi que ce soit d'autre importe src/config/env.ts
// (qui valide process.env dès son import). override:true pour ne pas dépendre
// de l'ordre si un .env générique traîne aussi.
loadEnv({ path: path.resolve(process.cwd(), ".env.test"), override: true });

if (process.env["NODE_ENV"] !== "test") {
  // Filet de sécurité : on ne veut JAMAIS faire tourner cette suite (qui vide
  // des tables) contre autre chose que la base de test.
  throw new Error(
    `[tests/setup] NODE_ENV=${process.env["NODE_ENV"]} — la suite de tests exige NODE_ENV=test (voir .env.test). Abandon.`,
  );
}
if (!/poosser_auth_test/.test(process.env["DATABASE_URL"] ?? "")) {
  throw new Error(
    "[tests/setup] DATABASE_URL ne pointe pas vers une base *_test — abandon pour éviter de vider une base réelle.",
  );
}

/**
 * On ne mocke qu'UNE seule chose : la frontière d'envoi de SMS. C'est
 * exactement pour ça que SmsProvider est une interface swappable (voir
 * src/services/sms/) — un test automatisé ne peut pas recevoir un vrai SMS.
 * Tout le reste (hachage, base de données, JWT, rate limiting, verrouillage,
 * etc.) tourne en vrai, sans mock, contre la vraie base Postgres de test.
 */
const sentOtps = vi.hoisted(() => new Map<string, string>());
export { sentOtps };

vi.mock("../src/services/sms/index.js", () => ({
  smsProvider: {
    sendOtp: async (phoneE164: string, code: string) => {
      sentOtps.set(phoneE164, code);
    },
  },
}));
