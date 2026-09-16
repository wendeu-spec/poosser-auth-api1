import type { PoolClient } from "pg";
import { pool, withTransaction } from "../db/pool.js";
import { hashShortSecret } from "../lib/crypto.js";
import { Errors } from "../lib/errors.js";
import { upsertDevice, type DeviceInput } from "./deviceService.js";
import { createSession, type SessionTokens } from "./sessionService.js";
import { logSecurityEvent } from "./securityEventService.js";

export interface UserRow {
  id: string;
  phone_e164: string;
  status: "active" | "suspended" | "deleted";
  pin_hash: string | null;
  pin_failed_attempts: number;
  pin_locked_until: Date | null;
  created_at: Date;
}

export interface PublicUser {
  id: string;
  phone: string;
  firstName: string;
  lastName: string;
  displayName: string | null;
  email: string | null;
  profileType: string;
  locale: string;
  createdAt: string;
}

export async function findUserByPhone(phoneE164: string): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>(`SELECT * FROM users WHERE phone_e164 = $1`, [phoneE164]);
  return rows[0] ?? null;
}

export async function findUserById(userId: string): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [userId]);
  return rows[0] ?? null;
}

export async function getPublicUser(
  userId: string,
  client: PoolClient | typeof pool = pool,
): Promise<PublicUser | null> {
  const { rows } = await client.query(
    `
    SELECT u.id, u.phone_e164, u.created_at,
           p.first_name, p.last_name, p.display_name, p.email, p.profile_type_code, p.locale
    FROM users u
    JOIN user_profiles p ON p.user_id = u.id
    WHERE u.id = $1
    `,
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    phone: row.phone_e164,
    firstName: row.first_name,
    lastName: row.last_name,
    displayName: row.display_name,
    email: row.email,
    profileType: row.profile_type_code,
    locale: row.locale,
    createdAt: row.created_at.toISOString(),
  };
}

export interface RegisterInput {
  phoneE164: string;
  firstName: string;
  lastName: string;
  displayName?: string;
  email?: string;
  profileTypeCode: string;
  pin: string;
  device: DeviceInput;
  ip: string | null;
}

export interface RegisterResult {
  user: PublicUser;
  tokens: SessionTokens;
}

/**
 * Toute la création de compte est une seule transaction SQL : soit tout est
 * créé (utilisateur, profil, appareil principal, session), soit rien ne l'est.
 */
export async function registerUser(input: RegisterInput): Promise<RegisterResult> {
  const existing = await findUserByPhone(input.phoneE164);
  if (existing) throw Errors.phoneAlreadyRegistered();

  const profileTypeCheck = await pool.query<{ code: string }>(
    `SELECT code FROM profile_types WHERE code = $1 AND is_active = true`,
    [input.profileTypeCode],
  );
  if (!profileTypeCheck.rows[0]) {
    throw Errors.validation({ field: "profileTypeCode" });
  }

  const pinHash = await hashShortSecret(input.pin);

  return withTransaction(async (client: PoolClient) => {
    const userResult = await client.query<{ id: string }>(
      `
      INSERT INTO users (phone_e164, phone_verified_at, pin_hash, pin_algo, pin_updated_at)
      VALUES ($1, now(), $2, 'argon2id', now())
      RETURNING id
      `,
      [input.phoneE164, pinHash],
    );
    const userId = userResult.rows[0]!.id;

    await client.query(
      `
      INSERT INTO user_profiles (user_id, first_name, last_name, display_name, email, profile_type_code)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        userId,
        input.firstName,
        input.lastName,
        input.displayName ?? null,
        input.email ?? null,
        input.profileTypeCode,
      ],
    );

    const { device } = await upsertDevice(client, userId, input.device, input.ip, true);
    const tokens = await createSession(client, userId, device.id);

    await logSecurityEvent(
      {
        userId,
        deviceId: device.id,
        type: "account_created",
        ip: input.ip,
      },
      client,
    );
    await logSecurityEvent(
      {
        userId,
        deviceId: device.id,
        type: "login_success",
        ip: input.ip,
        metadata: { via: "registration" },
      },
      client,
    );

    const user = await getPublicUser(userId, client);
    if (!user) {
      // Ne devrait jamais arriver : on vient d'insérer user + profil dans la
      // même transaction. Si ça arrive quand même, on préfère un échec net
      // (et un rollback de toute la transaction) à un `!` silencieux.
      throw new Error("[registerUser] utilisateur introuvable juste après sa création");
    }
    return { user, tokens };
  });
}
