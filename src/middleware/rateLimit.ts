import type { NextFunction, Request, Response } from "express";
import { checkRateLimit } from "../services/rateLimiter.js";
import { Errors } from "../lib/errors.js";

/**
 * Filet de sécurité générique par IP, appliqué à toutes les routes /auth/*, en
 * complément (pas en remplacement) des limites plus fines par téléphone déjà
 * appliquées dans les services (otpService, login...). Objectif : blunt une
 * attaque volumétrique basique avant même qu'elle n'atteigne la logique métier.
 */
export function globalIpRateLimit(limit: number, windowSeconds: number) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const ip = req.ip ?? "unknown";
    const result = await checkRateLimit(`global:ip:${ip}`, limit, windowSeconds);
    if (!result.allowed) {
      return next(Errors.rateLimited(result.retryAfterSeconds));
    }
    next();
  };
}
