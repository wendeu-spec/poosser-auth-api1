import { Pool, types } from "pg";
import { env } from "../config/env.js";

/**
 * Par défaut, `pg` convertit les colonnes de type DATE (oid 1082) en objets
 * JavaScript Date construits en heure locale du serveur. Une fois renvoyés au
 * client via `res.json()`, ces objets se sérialisent en horodatage ISO complet
 * ("2026-09-17T00:00:00.000Z") au lieu de la simple date ("2026-09-17")
 * attendue par `dateSchema` (voir validators/businessSchemas.ts) — un
 * aller-retour API (ex. Phase 2 : lire un planner_event puis créer la
 * transaction correspondante avec sa date) casse alors la validation malgré
 * des données correctes. On force donc le parseur à renvoyer la chaîne brute
 * "AAAA-MM-JJ" telle que PostgreSQL l'envoie, sans passer par un objet Date.
 */
types.setTypeParser(1082 /* date */, (value) => value);

/**
 * Pool de connexions PostgreSQL partagé par toute l'application. Un seul pool,
 * réutilisé — jamais de `new Pool()` ailleurs dans le code.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on("error", (err) => {
  // Une erreur sur une connexion inactive du pool ne doit jamais faire planter
  // tout le process — on la journalise et on laisse le pool la remplacer.
  // eslint-disable-next-line no-console
  console.error("[db] Erreur inattendue sur une connexion inactive du pool", err);
});

export async function withTransaction<T>(
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
