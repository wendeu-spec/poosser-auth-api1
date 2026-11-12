import type { NextFunction, Request, Response } from "express";
import { checkRateLimit } from "../services/rateLimiter.js";
import { Errors } from "../lib/errors.js";

/**
 * Filet de sécurité générique par IP, appliqué à toutes les routes /auth/*, en
 * complément (pas en remplacement) des limites plus fines par téléphone déjà
 * appliquées dans les services (otpService, login...). Objectif : blunt une
 * attaque volumétrique basique avant même qu'elle n'atteigne la logique métier.
 */
//
// `scope` sépare les compteurs : avant, /auth (60/min) et /api (300/min)
// partageaient la même clé « global:ip:<ip> », si bien que les appels /api
// d'un usage normal (une quinzaine à chaque ouverture de l'application)
// épuisaient la limite de /auth et faisaient refuser /auth/refresh — donc la
// reconnexion automatique et le renouvellement de session.
export function globalIpRateLimit(scope: string, limit: number, windowSeconds: number) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const ip = req.ip ?? "unknown";
    const result = await checkRateLimit(`global:${scope}:ip:${ip}`, limit, windowSeconds);
    if (!result.allowed) {
      return next(Errors.rateLimited(result.retryAfterSeconds));
    }
    next();
  };
}
