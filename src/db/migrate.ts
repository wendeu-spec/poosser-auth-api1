import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

/**
 * Runner de migration minimal et transparent : exécute chaque fichier
 * migrations/*.sql, dans l'ordre du nom de fichier, une seule fois, en
 * transaction. L'historique est gardé dans `schema_migrations`.
 *
 * Volontairement pas de dépendance externe pour ça : c'est un besoin simple,
 * et un outil maison de 60 lignes est plus facile à auditer qu'une dépendance
 * tierce pour un projet dont la sécurité est justement l'objet.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function appliedMigrations(): Promise<Set<string>> {
  const { rows } = await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations");
  return new Set(rows.map((r) => r.filename));
}

export async function runMigrations() {
  await ensureMigrationsTable();
  const already = await appliedMigrations();

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let appliedCount = 0;
  for (const file of files) {
    if (already.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      // eslint-disable-next-line no-console
      console.log(`[migrate] appliqué : ${file}`);
      appliedCount += 1;
    } catch (err) {
      await client.query("ROLLBACK");
      // eslint-disable-next-line no-console
      console.error(`[migrate] échec sur ${file}`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  if (appliedCount === 0) {
    // eslint-disable-next-line no-console
    console.log("[migrate] rien à appliquer, schéma déjà à jour.");
  } else {
    // eslint-disable-next-line no-console
    console.log(`[migrate] ${appliedCount} migration(s) appliquée(s).`);
  }
}

// Exécution directe : `npm run migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
      return pool.end();
    });
}
