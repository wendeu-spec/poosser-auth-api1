import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { env } from "../config/env.js";
import { generateOtpCode, hashShortSecret, verifyShortSecret } from "../lib/crypto.js";
import { signOtpTicket, verifyOtpTicket, type OtpTicketClaims } from "../lib/jwt.js";
import { checkRateLimit } from "./rateLimiter.js";
import { smsProvider } from "./sms/index.js";
import { logSecurityEvent } from "./securityEventService.js";
import { Errors } from "../lib/errors.js";

export type OtpPurpose = "registration" | "account_recovery";

export interface RequestOtpResult {
  expiresInSeconds: number;
  retryAfterSeconds: number;
}

/**
 * Demande l'envoi d'un OTP. La réponse retournée est TOUJOURS de la même forme,
 * que le numéro soit déjà enregistré ou non, et qu'un SMS ait été effectivement
 * envoyé ou non — c'est la contre-mesure principale contre l'énumération de
 * comptes sur ce endpoint (§2 et §18 du cahier des charges).
 */
export async function requestOtp(
  phoneE164: string,
  purpose: OtpPurpose,
  ip: string | null,
  userAgent: string | null,
): Promise<RequestOtpResult> {
  const perPhone = await checkRateLimit(
    `otp_request:phone:${purpose}:${phoneE164}`,
    env.RATE_LIMIT_OTP_REQUEST_PER_PHONE,
    env.RATE_LIMIT_OTP_REQUEST_PER_PHONE_WINDOW_SECONDS,
  );
  const cooldown = await checkRateLimit(
    `otp_resend_cooldown:${purpose}:${phoneE164}`,
    1,
    env.RATE_LIMIT_OTP_RESEND_COOLDOWN_SECONDS,
  );
  const perIp = ip
    ? await checkRateLimit(
        `otp_request:ip:${ip}`,
        env.RATE_LIMIT_OTP_REQUEST_PER_IP,
        env.RATE_LIMIT_OTP_REQUEST_PER_IP_WINDOW_SECONDS,
      )
    : { allowed: true, retryAfterSeconds: 0, remaining: 0 };

  if (!perPhone.allowed || !cooldown.allowed || !perIp.allowed) {
    const retryAfterSeconds = Math.max(perPhone.retryAfterSeconds, cooldown.retryAfterSeconds, perIp.retryAfterSeconds);
    throw Errors.rateLimited(retryAfterSeconds);
  }

  let shouldActuallySend = true;
  if (purpose === "account_recovery") {
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM users WHERE phone_e164 = $1`, [
      phoneE164,
    ]);
    shouldActuallySend = rows.length > 0;
    // Si le compte n'existe pas, on ne fait RIEN d'observable de plus : pas de SMS,
    // pas de ligne otp_challenges, mais une réponse strictement identique plus bas.
  }

  if (shouldActuallySend) {
    // Invalide tout challenge encore actif pour ce couple (téléphone, motif) : un
    // seul OTP valable à la fois.
    await pool.query(
      `UPDATE otp_challenges SET consumed_at = now() WHERE phone_e164 = $1 AND purpose = $2 AND consumed_at IS NULL`,
      [phoneE164, purpose],
    );

    const code = generateOtpCode();
    const codeHash = await hashShortSecret(code);
    const expiresAt = new Date(Date.now() + env.OTP_TTL_SECONDS * 1000);

    await pool.query(
      `
      INSERT INTO otp_challenges (phone_e164, purpose, code_hash, max_attempts, expires_at, request_ip, request_user_agent)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [phoneE164, purpose, codeHash, env.OTP_MAX_ATTEMPTS, expiresAt, ip, userAgent],
    );

    await smsProvider.sendOtp(phoneE164, code, purpose);
    await logSecurityEvent({ type: "otp_requested", ip, userAgent, metadata: { purpose } });
  }

  return {
    expiresInSeconds: env.OTP_TTL_SECONDS,
    retryAfterSeconds: env.RATE_LIMIT_OTP_RESEND_COOLDOWN_SECONDS,
  };
}

export interface VerifyOtpResult {
  otpVerificationTicket: string;
  expiresInSeconds: number;
}

export async function verifyOtp(
  phoneE164: string,
  purpose: OtpPurpose,
  code: string,
  ip: string | null,
): Promise<VerifyOtpResult> {
  const perPhone = await checkRateLimit(
    `otp_verify:phone:${purpose}:${phoneE164}`,
    env.RATE_LIMIT_OTP_VERIFY_PER_PHONE,
    env.RATE_LIMIT_OTP_VERIFY_PER_PHONE_WINDOW_SECONDS,
  );
  if (!perPhone.allowed) {
    throw Errors.rateLimited(perPhone.retryAfterSeconds);
  }

  const { rows } = await pool.query<{
    id: string;
    code_hash: string;
    attempts: number;
    max_attempts: number;
    expires_at: Date;
  }>(
    `
    SELECT id, code_hash, attempts, max_attempts, expires_at
    FROM otp_challenges
    WHERE phone_e164 = $1 AND purpose = $2 AND consumed_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [phoneE164, purpose],
  );
  const challenge = rows[0];

  if (!challenge) {
    await logSecurityEvent({ type: "otp_invalid", ip, metadata: { purpose, reason: "no_active_challenge" } });
    throw Errors.otpInvalid();
  }

  if (challenge.expires_at.getTime() < Date.now()) {
    await logSecurityEvent({ type: "otp_expired", ip, metadata: { purpose } });
    throw Errors.otpInvalid();
  }

  if (challenge.attempts >= challenge.max_attempts) {
    await logSecurityEvent({ type: "otp_invalid", ip, metadata: { purpose, reason: "max_attempts_reached" } });
    throw Errors.otpInvalid();
  }

  const isValid = await verifyShortSecret(challenge.code_hash, code);
  if (!isValid) {
    await pool.query(`UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1`, [challenge.id]);
    await logSecurityEvent({ type: "otp_invalid", ip, metadata: { purpose, reason: "wrong_code" } });
    throw Errors.otpInvalid();
  }

  await pool.query(`UPDATE otp_challenges SET consumed_at = now() WHERE id = $1`, [challenge.id]);

  const ticket = signOtpTicket({ phone: phoneE164, purpose, jti: randomUUID() });
  return { otpVerificationTicket: ticket, expiresInSeconds: env.OTP_TICKET_TTL_SECONDS };
}

/**
 * Valide un otpVerificationTicket ET le marque comme utilisé de façon atomique
 * (INSERT ... ON CONFLICT DO NOTHING dans used_otp_tickets). Un ticket ne peut
 * donc jamais servir deux fois, même s'il est encore dans sa fenêtre de validité
 * JWT — cf. migrations/013_used_otp_tickets.sql pour la justification.
 */
export async function consumeOtpTicket(
  ticket: string,
  expectedPurpose: OtpPurpose,
): Promise<OtpTicketClaims> {
  let claims: OtpTicketClaims;
  try {
    claims = verifyOtpTicket(ticket);
  } catch {
    throw Errors.otpTicketInvalid();
  }

  if (claims.purpose !== expectedPurpose) {
    throw Errors.otpTicketInvalid();
  }

  const expiresAt = new Date(Date.now() + env.OTP_TICKET_TTL_SECONDS * 1000);
  const { rowCount } = await pool.query(
    `INSERT INTO used_otp_tickets (jti, expires_at) VALUES ($1, $2) ON CONFLICT (jti) DO NOTHING`,
    [claims.jti, expiresAt],
  );
  if (rowCount === 0) {
    // jti déjà présent : ce ticket a déjà été consommé une première fois.
    throw Errors.otpTicketInvalid();
  }

  return claims;
}
