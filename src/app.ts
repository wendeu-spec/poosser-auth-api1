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

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    cors({
      origin: corsAllowedOrigins.length ? corsAllowedOrigins : false,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "32kb" })); // ni un payload d'auth ni une écriture métier n'a besoin d'être plus gros
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/health" } }));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

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
