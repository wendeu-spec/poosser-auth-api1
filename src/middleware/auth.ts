import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken, verifyStepUpToken } from "../lib/jwt.js";
import { pool } from "../db/pool.js";
import { Errors } from "../lib/errors.js";

export interface AuthContext {
  userId: string;
  deviceId: string;
  sessionId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      stepUp?: { amr: string[] };
    }
  }
}

/**
 * Exige un access token valide. Vérifie la signature/expiration JWT (rapide,
 * sans base de données) PUIS confirme que la session associée est toujours
 * active en base — sans cette seconde vérification, révoquer un appareil ne
 * prendrait effet qu'à l'expiration naturelle du token (jusqu'à 15 min plus
 * tard), ce qui contredit l'exigence d'invalidation immédiate des sessions
 * révoquées (§7 du cahier des charges).
 */
export async function requireAccessToken(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return next(Errors.unauthorized());
  }
  const token = header.slice("Bearer ".length);

  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch {
    return next(Errors.unauthorized());
  }

  const { rows } = await pool.query<{ status: string }>(
    `SELECT status FROM sessions WHERE id = $1 AND user_id = $2 AND device_id = $3`,
    [claims.sessionId, claims.sub, claims.deviceId],
  );
  if (!rows[0] || rows[0].status !== "active") {
    return next(Errors.unauthorized());
  }

  req.auth = { userId: claims.sub, deviceId: claims.deviceId, sessionId: claims.sessionId };
  next();
}

/**
 * Exige, EN PLUS d'un access token valide, un step-up token valide couvrant au
 * moins les méthodes listées. Prépare le Niveau 2/3 du §11 du cahier des
 * charges sans qu'aucun endpoint financier n'existe encore — le middleware est
 * réutilisable tel quel le jour où ils seront ajoutés.
 */
export function requireStepUp(requiredAmr: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers["x-step-up-token"];
    if (typeof header !== "string") return next(Errors.forbidden());

    let claims;
    try {
      claims = verifyStepUpToken(header);
    } catch {
      return next(Errors.forbidden());
    }

    if (!req.auth || claims.sub !== req.auth.userId || claims.deviceId !== req.auth.deviceId) {
      return next(Errors.forbidden());
    }

    const hasAllMethods = requiredAmr.every((m) => claims.amr.includes(m));
    if (!hasAllMethods) return next(Errors.forbidden());

    req.stepUp = { amr: claims.amr };
    next();
  };
}
