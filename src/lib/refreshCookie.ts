import type { Request, Response } from "express";
import { env } from "../config/env.js";

/**
 * « Rester connecté sur cet appareil » : le refresh token est confié au
 * navigateur dans un cookie, jamais au code JavaScript de la page.
 *
 *   - HttpOnly : illisible par JavaScript, donc hors de portée d'un script
 *     injecté (XSS) — contrairement à un stockage localStorage ;
 *   - Secure (en production) : jamais transmis hors HTTPS ;
 *   - SameSite=Strict : jamais envoyé par une page d'un autre site, ce qui
 *     ferme la porte aux requêtes forgées (CSRF) vers /auth/refresh ;
 *   - Path=/auth : envoyé uniquement aux routes d'authentification, pas aux
 *     appels /api/* ;
 *   - durée = REFRESH_TOKEN_TTL_SECONDS (30 jours par défaut), glissante : chaque
 *     rafraîchissement fait tourner le token et repousse l'échéance.
 *
 * La rotation et la détection de réutilisation restent celles de
 * sessionService.rotateSession : un cookie volé puis rejoué révoque toute la
 * famille de sessions, exactement comme un refresh token transmis dans le corps.
 */
export const REFRESH_COOKIE_NAME = "poosser_rt";
const COOKIE_PATH = "/auth";

function cookieOptions() {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: COOKIE_PATH,
  };
}

export function readRefreshCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== REFRESH_COOKIE_NAME) continue;
    try {
      const value = decodeURIComponent(part.slice(eq + 1).trim());
      return value.length >= 10 ? value : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function setRefreshCookie(res: Response, refreshToken: string): void {
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, { ...cookieOptions(), maxAge: env.REFRESH_TOKEN_TTL_SECONDS * 1000 });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, cookieOptions());
}
