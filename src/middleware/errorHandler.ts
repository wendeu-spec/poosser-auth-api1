import type { NextFunction, Request, Response } from "express";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { resolveLocale, t } from "../i18n/index.js";

/**
 * Gestionnaire d'erreurs central. Toute erreur applicative (AppError) est
 * traduite en réponse JSON propre avec un message localisé et jamais de détail
 * interne. Toute erreur NON prévue (bug, exception inattendue) devient un
 * 500 générique côté client, mais est journalisée en entier côté serveur pour
 * investigation — jamais renvoyée telle quelle au client.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const locale = resolveLocale(req);

  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error({ err, path: req.path }, "Erreur applicative serveur");
    }
    return res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: t(locale, err.code),
        ...(err.details ? { details: err.details } : {}),
      },
    });
  }

  logger.error({ err, path: req.path }, "Erreur non gérée");
  return res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: t(locale, "INTERNAL_ERROR") },
  });
}
