import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";

export interface DeviceInput {
  fingerprint: string;
  name: string;
  platform: "android" | "ios" | "web" | "other";
}

export interface DeviceRow {
  id: string;
  user_id: string;
  device_fingerprint: string;
  name: string;
  platform: string;
  status: "active" | "revoked";
  is_primary: boolean;
  last_seen_at: Date | null;
  last_ip: string | null;
  created_at: Date;
  revoked_at: Date | null;
}

/**
 * Trouve ou crée l'appareil pour cet utilisateur. Retourne `isNew: true` la
 * première fois qu'une empreinte est vue pour ce compte — c'est ce signal que
 * riskService et /auth/login utilisent pour déclencher l'événement "new_device"
 * (§8 du cahier des charges).
 */
export async function upsertDevice(
  client: PoolClient | typeof pool,
  userId: string,
  input: DeviceInput,
  ip: string | null,
  makePrimary = false,
): Promise<{ device: DeviceRow; isNew: boolean }> {
  const existing = await client.query<DeviceRow>(
    `SELECT * FROM devices WHERE user_id = $1 AND device_fingerprint = $2`,
    [userId, input.fingerprint],
  );

  if (existing.rows[0]) {
    const updated = await client.query<DeviceRow>(
      `
      UPDATE devices
      SET last_seen_at = now(), last_ip = $3, status = 'active', revoked_at = NULL,
          name = $4, platform = $5
      WHERE id = $1 AND user_id = $2
      RETURNING *
      `,
      [existing.rows[0].id, userId, ip, input.name, input.platform],
    );
    return { device: updated.rows[0]!, isNew: false };
  }

  const created = await client.query<DeviceRow>(
    `
    INSERT INTO devices (user_id, device_fingerprint, name, platform, is_primary, last_seen_at, last_ip)
    VALUES ($1, $2, $3, $4, $5, now(), $6)
    RETURNING *
    `,
    [userId, input.fingerprint, input.name, input.platform, makePrimary, ip],
  );
  return { device: created.rows[0]!, isNew: true };
}

export async function listDevices(userId: string): Promise<DeviceRow[]> {
  const { rows } = await pool.query<DeviceRow>(
    `SELECT * FROM devices WHERE user_id = $1 ORDER BY is_primary DESC, last_seen_at DESC NULLS LAST`,
    [userId],
  );
  return rows;
}

export async function getDeviceForUser(userId: string, deviceId: string): Promise<DeviceRow | null> {
  const { rows } = await pool.query<DeviceRow>(
    `SELECT * FROM devices WHERE id = $1 AND user_id = $2`,
    [deviceId, userId],
  );
  return rows[0] ?? null;
}

export async function revokeDevice(client: PoolClient | typeof pool, deviceId: string): Promise<void> {
  await client.query(
    `UPDATE devices SET status = 'revoked', revoked_at = now() WHERE id = $1`,
    [deviceId],
  );
  await client.query(
    `UPDATE sessions SET status = 'revoked', revoked_at = now(), revoked_reason = 'device_revoked'
     WHERE device_id = $1 AND status = 'active'`,
    [deviceId],
  );
}

export async function revokeOtherDevices(
  client: PoolClient | typeof pool,
  userId: string,
  currentDeviceId: string,
): Promise<number> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM devices WHERE user_id = $1 AND id != $2 AND status = 'active'`,
    [userId, currentDeviceId],
  );
  for (const row of rows) {
    await revokeDevice(client, row.id);
  }
  return rows.length;
}

export async function revokeAllDevices(client: PoolClient | typeof pool, userId: string): Promise<number> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM devices WHERE user_id = $1 AND status = 'active'`,
    [userId],
  );
  for (const row of rows) {
    await revokeDevice(client, row.id);
  }
  return rows.length;
}
