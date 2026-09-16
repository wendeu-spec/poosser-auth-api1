import { pool } from "../db/pool.js";

/**
 * Limiteur de débit générique à fenêtre fixe, adossé à `rate_limit_buckets`.
 * Remplace Redis (absent de cet environnement) derrière une interface simple ;
 * migrer vers Redis plus tard = ré-implémenter cette seule fonction.
 *
 * `key` doit déjà encoder toute la dimension voulue, ex:
 *   "otp_request:phone:+237670000000"
 *   "login:ip:41.202.13.5"
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const now = new Date();
  const windowStartMs = Math.floor(now.getTime() / (windowSeconds * 1000)) * (windowSeconds * 1000);
  const windowStart = new Date(windowStartMs);

  const { rows } = await pool.query<{ count: number }>(
    `
    INSERT INTO rate_limit_buckets (key, window_start, count)
    VALUES ($1, $2, 1)
    ON CONFLICT (key, window_start)
    DO UPDATE SET count = rate_limit_buckets.count + 1
    RETURNING count;
    `,
    [key, windowStart],
  );

  const count = rows[0]!.count;
  const windowEndMs = windowStartMs + windowSeconds * 1000;
  const retryAfterSeconds = Math.max(0, Math.ceil((windowEndMs - now.getTime()) / 1000));

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds,
  };
}

/** Vérifie une limite sans la consommer (utile pour un cooldown de renvoi). */
export async function peekRateLimit(key: string, windowSeconds: number): Promise<number> {
  const now = new Date();
  const windowStartMs = Math.floor(now.getTime() / (windowSeconds * 1000)) * (windowSeconds * 1000);
  const windowStart = new Date(windowStartMs);

  const { rows } = await pool.query<{ count: number }>(
    `SELECT count FROM rate_limit_buckets WHERE key = $1 AND window_start = $2`,
    [key, windowStart],
  );
  return rows[0]?.count ?? 0;
}

/** Tâche de maintenance : purge les fenêtres plus vieilles que `olderThanSeconds`. */
export async function pruneRateLimitBuckets(olderThanSeconds: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanSeconds * 1000);
  const { rowCount } = await pool.query(`DELETE FROM rate_limit_buckets WHERE window_start < $1`, [
    cutoff,
  ]);
  return rowCount ?? 0;
}
