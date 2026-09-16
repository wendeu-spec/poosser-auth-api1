import "dotenv/config";
import { z } from "zod";

/**
 * Toute la configuration passe par ici. Rien n'est codé en dur ailleurs dans
 * l'application : chaque secret, chaque limite, chaque durée de vie vient de
 * l'environnement, validé au démarrage (on préfère planter tôt et clairement
 * plutôt que de tourner avec une config invalide).
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1, "DATABASE_URL est requis"),
  DATABASE_SSL: z.coerce.boolean().default(false),

  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET doit faire au moins 32 caractères"),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),

  JWT_OTP_TICKET_SECRET: z.string().min(32),
  OTP_TICKET_TTL_SECONDS: z.coerce.number().int().positive().default(600),

  JWT_STEPUP_SECRET: z.string().min(32),
  JWT_STEPUP_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),

  ARGON2_PIN_MEMORY_KB: z.coerce.number().int().positive().default(65536),
  ARGON2_PIN_TIME_COST: z.coerce.number().int().positive().default(3),
  ARGON2_PIN_PARALLELISM: z.coerce.number().int().positive().default(1),

  OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  SMS_PROVIDER: z.enum(["console", "africastalking", "twilio"]).default("console"),
  AFRICASTALKING_USERNAME: z.string().optional().default(""),
  AFRICASTALKING_API_KEY: z.string().optional().default(""),
  AFRICASTALKING_SENDER_ID: z.string().optional().default(""),
  TWILIO_ACCOUNT_SID: z.string().optional().default(""),
  TWILIO_AUTH_TOKEN: z.string().optional().default(""),
  TWILIO_VERIFY_SERVICE_SID: z.string().optional().default(""),

  RATE_LIMIT_OTP_REQUEST_PER_PHONE: z.coerce.number().int().positive().default(3),
  RATE_LIMIT_OTP_REQUEST_PER_PHONE_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
  RATE_LIMIT_OTP_REQUEST_PER_IP: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_OTP_REQUEST_PER_IP_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),
  RATE_LIMIT_OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),

  RATE_LIMIT_OTP_VERIFY_PER_PHONE: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_OTP_VERIFY_PER_PHONE_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),

  RATE_LIMIT_LOGIN_PER_PHONE: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_LOGIN_PER_PHONE_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
  RATE_LIMIT_LOGIN_PER_IP: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_LOGIN_PER_IP_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
  ACCOUNT_LOCK_DURATION_SECONDS: z.coerce.number().int().positive().default(900),

  RATE_LIMIT_RECOVERY_PER_PHONE: z.coerce.number().int().positive().default(3),
  RATE_LIMIT_RECOVERY_PER_PHONE_WINDOW_SECONDS: z.coerce.number().int().positive().default(86400),

  RATE_LIMIT_CHANGE_PIN_PER_USER: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_CHANGE_PIN_PER_USER_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),

  DEFAULT_PHONE_COUNTRY: z.string().length(2).default("CM"),
  DEFAULT_LOCALE: z.enum(["fr", "en"]).default("fr"),
  CORS_ALLOWED_ORIGINS: z.string().default(""),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("[config] Variables d'environnement invalides :", parsed.error.flatten().fieldErrors);
  throw new Error("Configuration invalide — voir .env.example");
}

export const env = parsed.data;

export const corsAllowedOrigins = env.CORS_ALLOWED_ORIGINS.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
