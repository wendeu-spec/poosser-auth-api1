import { pool } from "../db/pool.js";
import { env } from "../config/env.js";
import { hashShortSecret, verifyShortSecret, getDummyHash, isWeakPin } from "../lib/crypto.js";
import { Errors } from "../lib/errors.js";
import { logSecurityEvent } from "./securityEventService.js";

export function assertPinStrength(pin: string, confirmation: string): void {
  if (pin !== confirmation) throw Errors.validation({ field: "pin", reason: "mismatch" });
  if (isWeakPin(pin)) throw Errors.pinTooWeak();
}

/**
 * Vérifie le PIN de connexion, avec verrouillage temporaire après plusieurs
 * échecs (§4 et §5 du cahier des charges) et une comparaison à temps constant
 * même quand le compte n'existe pas (voir getDummyHash).
 */
export async function verifyLoginPin(
  userId: string | null,
  pinHash: string | null,
  pinFailedAttempts: number,
  pinLockedUntil: Date | null,
  pin: string,
  ip: string | null,
): Promise<boolean> {
  if (userId && pinLockedUntil && pinLockedUntil.getTime() > Date.now()) {
    const retryAfterSeconds = Math.ceil((pinLockedUntil.getTime() - Date.now()) / 1000);
    throw Errors.accountLocked(retryAfterSeconds);
  }

  const hashToCheck = pinHash ?? (await getDummyHash());
  const isValid = pinHash ? await verifyShortSecret(hashToCheck, pin) : false;

  if (!userId) {
    // Compte inexistant : on a quand même fait un verify() ci-dessus pour le
    // temps de calcul, mais il n'y a rien d'autre à faire ici.
    return false;
  }

  if (isValid) {
    await pool.query(`UPDATE users SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = $1`, [
      userId,
    ]);
    return true;
  }

  const newAttempts = pinFailedAttempts + 1;
  if (newAttempts >= env.RATE_LIMIT_LOGIN_PER_PHONE) {
    const lockedUntil = new Date(Date.now() + env.ACCOUNT_LOCK_DURATION_SECONDS * 1000);
    await pool.query(
      `UPDATE users SET pin_failed_attempts = 0, pin_locked_until = $2 WHERE id = $1`,
      [userId, lockedUntil],
    );
    await logSecurityEvent({
      userId,
      type: "account_locked_temporarily",
      severity: "warning",
      ip,
      metadata: { durationSeconds: env.ACCOUNT_LOCK_DURATION_SECONDS },
    });
  } else {
    await pool.query(`UPDATE users SET pin_failed_attempts = $2 WHERE id = $1`, [userId, newAttempts]);
  }

  await logSecurityEvent({ userId, type: "pin_incorrect", severity: "warning", ip });
  return false;
}

export async function setLoginPin(userId: string, pin: string): Promise<void> {
  const hash = await hashShortSecret(pin);
  await pool.query(
    `UPDATE users SET pin_hash = $2, pin_algo = 'argon2id', pin_updated_at = now(),
       pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = $1`,
    [userId, hash],
  );
}

// ---------------------------------------------------------------------------
// PIN transactionnel — table et cycle de vie DISTINCTS du PIN de connexion.
// ---------------------------------------------------------------------------

interface TransactionCredentialsRow {
  pin_hash: string;
  failed_attempts: number;
  locked_until: Date | null;
}

export async function getTransactionCredentials(userId: string): Promise<TransactionCredentialsRow | null> {
  const { rows } = await pool.query<TransactionCredentialsRow>(
    `SELECT pin_hash, failed_attempts, locked_until FROM transaction_credentials WHERE user_id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

export async function setTransactionPin(userId: string, pin: string): Promise<void> {
  const hash = await hashShortSecret(pin);
  await pool.query(
    `
    INSERT INTO transaction_credentials (user_id, pin_hash)
    VALUES ($1, $2)
    ON CONFLICT (user_id)
    DO UPDATE SET pin_hash = $2, updated_at = now(), failed_attempts = 0, locked_until = NULL
    `,
    [userId, hash],
  );
  await logSecurityEvent({ userId, type: "transaction_pin_set" });
}

export async function verifyTransactionPin(userId: string, pin: string, ip: string | null): Promise<boolean> {
  const creds = await getTransactionCredentials(userId);
  if (!creds) throw Errors.transactionPinNotSet();

  if (creds.locked_until && creds.locked_until.getTime() > Date.now()) {
    const retryAfterSeconds = Math.ceil((creds.locked_until.getTime() - Date.now()) / 1000);
    throw Errors.accountLocked(retryAfterSeconds);
  }

  const isValid = await verifyShortSecret(creds.pin_hash, pin);
  if (isValid) {
    await pool.query(
      `UPDATE transaction_credentials SET failed_attempts = 0, locked_until = NULL WHERE user_id = $1`,
      [userId],
    );
    await logSecurityEvent({ userId, type: "step_up_granted", ip, metadata: { amr: "transaction_pin" } });
    return true;
  }

  const newAttempts = creds.failed_attempts + 1;
  if (newAttempts >= env.RATE_LIMIT_LOGIN_PER_PHONE) {
    const lockedUntil = new Date(Date.now() + env.ACCOUNT_LOCK_DURATION_SECONDS * 1000);
    await pool.query(
      `UPDATE transaction_credentials SET failed_attempts = 0, locked_until = $2 WHERE user_id = $1`,
      [userId, lockedUntil],
    );
  } else {
    await pool.query(`UPDATE transaction_credentials SET failed_attempts = $2 WHERE user_id = $1`, [
      userId,
      newAttempts,
    ]);
  }
  await logSecurityEvent({ userId, type: "step_up_denied", severity: "warning", ip });
  return false;
}
