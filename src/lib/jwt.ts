import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

/**
 * Trois familles de JWT, trois secrets distincts (défense en profondeur : la
 * fuite d'un secret ne compromet qu'un seul type de jeton). Aucun de ces
 * tokens n'est un "token permanent" — chacun a une expiration courte.
 */

export interface AccessTokenClaims {
  sub: string; // userId
  deviceId: string;
  sessionId: string;
}

export function signAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL_SECONDS,
    algorithm: "HS256",
  });
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ["HS256"] }) as AccessTokenClaims &
    jwt.JwtPayload;
}

export interface OtpTicketClaims {
  phone: string;
  purpose: "registration" | "account_recovery";
  jti: string; // identifiant unique du ticket, pour empêcher un rejeu même dans sa fenêtre de validité
}

export function signOtpTicket(claims: OtpTicketClaims): string {
  return jwt.sign(claims, env.JWT_OTP_TICKET_SECRET, {
    expiresIn: env.OTP_TICKET_TTL_SECONDS,
    algorithm: "HS256",
  });
}

export function verifyOtpTicket(token: string): OtpTicketClaims {
  return jwt.verify(token, env.JWT_OTP_TICKET_SECRET, { algorithms: ["HS256"] }) as OtpTicketClaims &
    jwt.JwtPayload;
}

export interface StepUpClaims {
  sub: string; // userId
  deviceId: string;
  amr: string[]; // méthodes utilisées pour atteindre ce niveau, ex: ["transaction_pin"]
}

export function signStepUpToken(claims: StepUpClaims): string {
  return jwt.sign(claims, env.JWT_STEPUP_SECRET, {
    expiresIn: env.JWT_STEPUP_TTL_SECONDS,
    algorithm: "HS256",
  });
}

export function verifyStepUpToken(token: string): StepUpClaims {
  return jwt.verify(token, env.JWT_STEPUP_SECRET, { algorithms: ["HS256"] }) as StepUpClaims &
    jwt.JwtPayload;
}
