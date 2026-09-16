import { pool } from "../db/pool.js";

export interface RiskAssessment {
  isNewDevice: boolean;
  recentFailedAttempts: number;
  level: "normal" | "notify" | "heightened";
  reasons: string[];
}

/**
 * Évaluation de risque volontairement simple et honnête pour un MVP : calculée
 * à partir de signaux réels déjà en base (aucune valeur simulée), mais sans
 * réputation IP ni géolocalisation — ces signaux sont explicitement hors
 * périmètre pour l'instant (§8 : "ne pas considérer une IP ou une géoloc comme
 * une preuve absolue d'identité"). Le schéma (`security_events.metadata` en
 * JSONB) permet d'enrichir ce service plus tard sans migration.
 */
export async function assessLoginRisk(
  phoneE164: string,
  ip: string | null,
  isNewDevice: boolean,
): Promise<RiskAssessment> {
  const { rows } = await pool.query<{ count: string }>(
    `
    SELECT count(*) FROM login_attempts
    WHERE phone_e164 = $1 AND success = false AND created_at > now() - interval '15 minutes'
    `,
    [phoneE164],
  );
  const recentFailedAttempts = Number(rows[0]?.count ?? 0);

  const reasons: string[] = [];
  if (isNewDevice) reasons.push("new_device");
  if (recentFailedAttempts >= 3) reasons.push("recent_failed_attempts");

  let level: RiskAssessment["level"] = "normal";
  if (recentFailedAttempts >= 3) level = "heightened";
  else if (isNewDevice) level = "notify";

  return { isNewDevice, recentFailedAttempts, level, reasons };
}
