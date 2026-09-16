import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool, withTransaction } from "../db/pool.js";
import { env } from "../config/env.js";
import { generateOpaqueToken, hashOpaqueToken } from "../lib/crypto.js";
import { signAccessToken } from "../lib/jwt.js";
import { logSecurityEvent } from "./securityEventService.js";
import { Errors } from "../lib/errors.js";

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface SessionRow {
  id: string;
  user_id: string;
  device_id: string;
  refresh_token_hash: string;
  refresh_token_family: string;
  status: "active" | "revoked" | "reused_detected";
  expires_at: Date;
}

/** Crée une toute nouvelle session (nouvelle famille de rotation). */
export async function createSession(
  client: PoolClient | typeof pool,
  userId: string,
  deviceId: string,
): Promise<SessionTokens> {
  const family = randomUUID();
  return issueSessionInFamily(client, userId, deviceId, family);
}

async function issueSessionInFamily(
  client: PoolClient | typeof pool,
  userId: string,
  deviceId: string,
  family: string,
): Promise<SessionTokens> {
  const refreshToken = generateOpaqueToken();
  const refreshTokenHash = hashOpaqueToken(refreshToken);
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_SECONDS * 1000);

  const { rows } = await client.query<{ id: string }>(
    `
    INSERT INTO sessions (user_id, device_id, refresh_token_hash, refresh_token_family, expires_at)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
    `,
    [userId, deviceId, refreshTokenHash, family, expiresAt],
  );
  const sessionId = rows[0]!.id;

  const accessToken = signAccessToken({ sub: userId, deviceId, sessionId });

  return { accessToken, refreshToken, expiresIn: env.JWT_ACCESS_TTL_SECONDS };
}

type RotateOutcome =
  | { kind: "ok"; tokens: SessionTokens }
  | { kind: "invalid" }
  | { kind: "reuse" };

/**
 * Rafraîchit une session : rotation obligatoire + détection de réutilisation.
 * Voir docs/ARCHITECTURE.md §4 pour la logique complète.
 *
 * IMPORTANT : en cas de réutilisation détectée, la révocation de toute la
 * famille de sessions (et la journalisation de l'événement) doit être
 * COMMITÉE, pas annulée. `withTransaction` fait un ROLLBACK dès qu'une
 * exception traverse son callback — si on levait `Errors.refreshReuseDetected()`
 * *à l'intérieur* de la transaction, le ROLLBACK annulerait la révocation
 * qu'on vient d'écrire, et un attaquant en possession de l'ancien refresh
 * token pourrait continuer à faire tourner indéfiniment les tokens de la
 * famille malgré la détection. On calcule donc un résultat neutre à
 * l'intérieur de la transaction (qui se commite toujours normalement), et on
 * ne lève l'erreur qu'après, une fois le commit effectué.
 */
export async function rotateSession(
  refreshToken: string,
  requestIp: string | null,
): Promise<SessionTokens> {
  const hash = hashOpaqueToken(refreshToken);

  const outcome = await withTransaction<RotateOutcome>(async (client) => {
    const { rows } = await client.query<SessionRow>(
      `SELECT * FROM sessions WHERE refresh_token_hash = $1 FOR UPDATE`,
      [hash],
    );
    const session = rows[0];

    if (!session) {
      return { kind: "invalid" };
    }

    if (session.status === "revoked" || session.status === "reused_detected") {
      // Un token déjà tourné (ou déjà marqué comme réutilisé) est présenté à nouveau :
      // c'est le signal classique de vol de refresh token. On révoque toute la
      // famille immédiatement, sur toute la lignée, pas seulement cette session.
      await client.query(
        `
        UPDATE sessions
        SET status = 'reused_detected', revoked_at = COALESCE(revoked_at, now()),
            revoked_reason = 'refresh_reuse_detected'
        WHERE refresh_token_family = $1 AND status = 'active'
        `,
        [session.refresh_token_family],
      );
      await logSecurityEvent(
        {
          userId: session.user_id,
          deviceId: session.device_id,
          type: "refresh_reuse_detected",
          severity: "critical",
          ip: requestIp,
          metadata: { sessionFamily: session.refresh_token_family },
        },
        client,
      );
      return { kind: "reuse" };
    }

    if (session.expires_at.getTime() < Date.now()) {
      return { kind: "invalid" };
    }

    await client.query(
      `UPDATE sessions SET status = 'revoked', rotated_at = now(), revoked_reason = 'rotated'
       WHERE id = $1`,
      [session.id],
    );

    const tokens = await issueSessionInFamily(client, session.user_id, session.device_id, session.refresh_token_family);
    return { kind: "ok", tokens };
  });

  if (outcome.kind === "invalid") throw Errors.refreshInvalid();
  if (outcome.kind === "reuse") throw Errors.refreshReuseDetected();
  return outcome.tokens;
}

/** /auth/logout : révoque uniquement la session correspondant à ce refresh token. */
export async function revokeSessionByRefreshToken(refreshToken: string, userId: string): Promise<void> {
  const hash = hashOpaqueToken(refreshToken);
  await pool.query(
    `
    UPDATE sessions SET status = 'revoked', revoked_at = now(), revoked_reason = 'logout'
    WHERE refresh_token_hash = $1 AND user_id = $2 AND status = 'active'
    `,
    [hash, userId],
  );
}

/** /auth/logout-all : révoque toutes les sessions actives de l'utilisateur. */
export async function revokeAllSessions(client: PoolClient | typeof pool, userId: string): Promise<void> {
  await client.query(
    `
    UPDATE sessions SET status = 'revoked', revoked_at = now(), revoked_reason = 'global_logout'
    WHERE user_id = $1 AND status = 'active'
    `,
    [userId],
  );
}
