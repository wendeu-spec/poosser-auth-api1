import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";
import { logger } from "../lib/logger.js";

export type SecurityEventType =
  | "login_success"
  | "login_failed"
  | "otp_requested"
  | "otp_invalid"
  | "otp_expired"
  | "pin_incorrect"
  | "pin_changed"
  | "account_created"
  | "account_recovered"
  | "account_locked_temporarily"
  | "new_device"
  | "device_revoked"
  | "logout"
  | "global_logout"
  | "refresh_reuse_detected"
  | "suspicious_attempt"
  | "step_up_granted"
  | "step_up_denied"
  | "transaction_pin_set";

export type SecuritySeverity = "info" | "warning" | "critical";

const FORBIDDEN_METADATA_KEYS = new Set([
  "pin",
  "newpin",
  "currentpin",
  "pinconfirmation",
  "transactionpin",
  "newtransactionpin",
  "currenttransactionpin",
  "code",
  "otp",
  "password",
  "accesstoken",
  "refreshtoken",
  "otpverificationticket",
  "stepuptoken",
]);

/**
 * Garde-fou : même si un appelant construit `metadata` par erreur avec un champ
 * sensible, cette fonction le retire avant l'écriture en base. La vraie règle
 * reste de ne jamais y mettre de secret — ceci est un filet de sécurité, pas une
 * autorisation implicite d'y passer n'importe quoi.
 */
function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (FORBIDDEN_METADATA_KEYS.has(key.toLowerCase())) {
      logger.warn({ key }, "[securityEventService] champ sensible retiré des metadata d'un événement");
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

export interface LogSecurityEventParams {
  userId?: string | null;
  deviceId?: string | null;
  type: SecurityEventType;
  severity?: SecuritySeverity;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * `client` permet de journaliser un événement DANS la même transaction que
 * l'opération qui le déclenche (ex. création de compte). C'est indispensable
 * quand l'événement référence une ligne (ex. users.id) qui n'est pas encore
 * committée : une requête passant par le pool partagé utiliserait une autre
 * connexion et ne verrait pas cette ligne, provoquant une violation de clé
 * étrangère. Par défaut on utilise le pool partagé (cas hors transaction).
 */
export async function logSecurityEvent(
  params: LogSecurityEventParams,
  client: PoolClient | typeof pool = pool,
): Promise<void> {
  const metadata = sanitizeMetadata(params.metadata ?? {});
  await client.query(
    `
    INSERT INTO security_events (user_id, device_id, event_type, severity, ip, user_agent, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      params.userId ?? null,
      params.deviceId ?? null,
      params.type,
      params.severity ?? "info",
      params.ip ?? null,
      params.userAgent ?? null,
      JSON.stringify(metadata),
    ],
  );
}

export interface SecurityEventRow {
  id: string;
  event_type: SecurityEventType;
  severity: SecuritySeverity;
  device_name: string | null;
  created_at: Date;
}

export async function listSecurityEvents(
  userId: string,
  limit: number,
  before?: string,
): Promise<SecurityEventRow[]> {
  const { rows } = await pool.query<SecurityEventRow>(
    `
    SELECT se.id, se.event_type, se.severity, d.name AS device_name, se.created_at
    FROM security_events se
    LEFT JOIN devices d ON d.id = se.device_id
    WHERE se.user_id = $1
      AND ($2::uuid IS NULL OR se.created_at < (SELECT created_at FROM security_events WHERE id = $2))
    ORDER BY se.created_at DESC
    LIMIT $3
    `,
    [userId, before ?? null, limit],
  );
  return rows;
}
