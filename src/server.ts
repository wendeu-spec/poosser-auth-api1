import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { runMigrations } from "./db/migrate.js";

async function main() {
  await runMigrations();
  const app = createApp();
  app.listen(env.PORT, () => {
    logger.info(`POOSSER Auth API démarrée sur le port ${env.PORT} (${env.NODE_ENV})`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Échec du démarrage du serveur :", err);
  process.exit(1);
});
