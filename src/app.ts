import path from "node:path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { logger } from "./lib/logger.js";
import { corsAllowedOrigins } from "./config/env.js";
import { authRouter } from "./routes/auth.js";
import { businessRouter } from "./routes/business.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { globalIpRateLimit } from "./middleware/rateLimit.js";

// Dossier des fichiers statiques (PWA installable : manifest, service worker,
// icônes, et le prototype front-end lui-même) — servi tel quel sous /app.
// process.cwd() plutôt que __dirname : quelle que soit la profondeur de
// dist/ après compilation TypeScript, le process est toujours lancé depuis
// la racine du dépôt (voir "start" dans package.json), où vit public/.
const PUBLIC_DIR = path.join(process.cwd(), "public", "app");

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(
    helmet({
      // La CSP stricte par défaut de helmet (aucun script/style inline,
      // aucune source externe) casserait /app/* : le prototype front-end est
      // un unique fichier HTML avec son JS/CSS inline et 3 bibliothèques
      // chargées depuis cdnjs.cloudflare.com (export PDF/Excel). Les routes
      // JSON (/auth, /api) ne sont pas affectées par ces directives.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          fontSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          manifestSrc: ["'self'"],
          workerSrc: ["'self'"],
        },
      },
    }),
  );
  app.use(
    cors({
      origin: corsAllowedOrigins.length ? corsAllowedOrigins : false,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "32kb" })); // ni un payload d'auth ni une écriture métier n'a besoin d'être plus gros
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/health" } }));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  // PWA installable : prototype front-end + manifest/service worker/icônes,
  // servis tels quels sous /app. index.html gère lui-même la navigation
  // interne (SPA à une seule page) ; aucune route serveur supplémentaire
  // n'est nécessaire au-delà des fichiers statiques.
  app.use("/app", express.static(PUBLIC_DIR, { extensions: ["html"] }));
  app.get("/", (_req, res) => res.redirect("/app/"));

  // Filet anti-abus générique avant toute route /auth/* (60 requêtes/minute/IP) —
  // les limites plus fines par téléphone sont gérées dans les services eux-mêmes.
  app.use("/auth", globalIpRateLimit(60, 60));
  app.use("/auth", authRouter);

  // Les routes métier exigent déjà un access token (requireAccessToken, monté
  // dans businessRouter) — un filet IP générique reste utile en plus, plus
  // large que celui d'auth car un usage normal de l'app peut légitimement
  // faire plus d'appels (liste des transactions, du planner, etc.).
  app.use("/api", globalIpRateLimit(300, 60));
  app.use("/api", businessRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Not found" } });
  });

  app.use(errorHandler);

  return app;
}
