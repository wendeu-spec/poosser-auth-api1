import request from "supertest";
import { pool } from "../src/db/pool.js";
import { createApp } from "../src/app.js";
import { sentOtps } from "./setup.js";

export { sentOtps };

export const app = createApp();

/**
 * Vide toutes les tables "de données" entre deux tests pour une isolation
 * complète, sans jamais toucher aux tables de référence/schéma
 * (profile_types, schema_migrations). RESTART IDENTITY + CASCADE pour repartir
 * sur des séquences propres et suivre les FK.
 */
export async function resetDb(): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      used_otp_tickets,
      security_events,
      login_attempts,
      rate_limit_buckets,
      sessions,
      transaction_credentials,
      devices,
      otp_challenges,
      user_profiles,
      users,
      transactions,
      budgets,
      savings_goals,
      tontine_round_history,
      tontine_contributions,
      tontine_members,
      tontines,
      planner_events
    RESTART IDENTITY CASCADE
  `);
  sentOtps.clear();
}

export async function closeDb(): Promise<void> {
  await pool.end();
}

let phoneCounter = 0;
/**
 * Numéro camerounais valide (format E.164) unique par appel, pour éviter toute
 * collision entre tests. Un numéro mobile camerounais a 9 chiffres après
 * l'indicatif 237 et commence par 6 (237 6XXXXXXXX) — un simple compteur trop
 * court donnerait un numéro syntaxiquement invalide que normalizePhone()
 * rejetterait avant même d'atteindre la logique testée.
 */
export function freshPhone(): string {
  phoneCounter += 1;
  const suffix = String(phoneCounter).padStart(8, "0");
  return `+2376${suffix}`;
}

export function freshFingerprint(label = "device"): string {
  return `${label}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

export const VALID_DEVICE = (name = "Test Device", fingerprint = freshFingerprint()) => ({
  fingerprint,
  name,
  platform: "web" as const,
});

/**
 * Cycle complet request-otp -> verify-otp -> register, en lisant le code OTP
 * directement depuis la capture de tests/setup.ts (jamais depuis un vrai SMS).
 * Retourne le payload complet de /auth/register (user + tokens) ainsi que le
 * numéro et le PIN utilisés, pour que les tests puissent enchaîner un login.
 */
export async function registerFreshUser(opts?: {
  phone?: string;
  pin?: string;
  device?: { fingerprint: string; name: string; platform: "android" | "ios" | "web" | "other" };
  profileTypeCode?: string;
}) {
  const phone = opts?.phone ?? freshPhone();
  const pin = opts?.pin ?? "482913";
  const device = opts?.device ?? VALID_DEVICE();

  await request(app).post("/auth/request-otp").send({ phone, purpose: "registration" }).expect(200);
  const code = sentOtps.get(phone);
  if (!code) throw new Error(`[tests] Aucun OTP capturé pour ${phone}`);

  const verifyRes = await request(app)
    .post("/auth/verify-otp")
    .send({ phone, purpose: "registration", code })
    .expect(200);

  const registerRes = await request(app)
    .post("/auth/register")
    .send({
      otpVerificationTicket: verifyRes.body.otpVerificationTicket,
      firstName: "Yannis",
      lastName: "Test",
      profileTypeCode: opts?.profileTypeCode ?? "salarie",
      pin,
      pinConfirmation: pin,
      device,
    })
    .expect(201);

  return { phone, pin, device, body: registerRes.body as { user: any; accessToken: string; refreshToken: string; expiresIn: number } };
}

export async function requestOtpAndGetCode(phone: string, purpose: "registration" | "account_recovery") {
  await request(app).post("/auth/request-otp").send({ phone, purpose }).expect(200);
  const code = sentOtps.get(phone);
  if (!code) throw new Error(`[tests] Aucun OTP capturé pour ${phone} (${purpose})`);
  return code;
}
