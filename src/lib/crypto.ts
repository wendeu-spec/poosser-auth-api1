import argon2 from "argon2";
import { randomBytes, randomInt, createHash, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";

/**
 * Hache un secret court choisi par un humain (PIN de connexion, PIN
 * transactionnel, code OTP) avec Argon2id et des paramètres renforcés par
 * rapport à la base OWASP générique — voir docs/ARCHITECTURE.md §5 pour la
 * justification (un PIN à 6 chiffres n'a que 1 000 000 de valeurs possibles).
 */
export async function hashShortSecret(secret: string): Promise<string> {
  return argon2.hash(secret, {
    type: argon2.argon2id,
    memoryCost: env.ARGON2_PIN_MEMORY_KB,
    timeCost: env.ARGON2_PIN_TIME_COST,
    parallelism: env.ARGON2_PIN_PARALLELISM,
  });
}

export async function verifyShortSecret(hash: string, secret: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, secret);
  } catch {
    // Un hash malformé ne doit jamais faire planter l'appelant — seulement échouer.
    return false;
  }
}

/**
 * Hash Argon2id "factice" utilisé quand un compte n'existe pas, pour que le
 * temps de calcul de /auth/login soit similaire que le numéro existe ou non
 * (contre-mesure basique à l'énumération de comptes par timing). Généré une
 * seule fois au démarrage du process à partir d'une valeur fixe non secrète :
 * ce n'est pas un secret, seulement un leurre de calcul.
 */
let dummyHashPromise: Promise<string> | null = null;
export function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashShortSecret("000000-dummy-timing-safety-000000");
  }
  return dummyHashPromise;
}

/** Génère un code OTP à N chiffres avec un générateur cryptographiquement sûr. */
export function generateOtpCode(length = env.OTP_LENGTH): string {
  const min = 10 ** (length - 1);
  const max = 10 ** length - 1;
  return String(randomInt(min, max + 1)).padStart(length, "0");
}

/** Génère un refresh token opaque à haute entropie (256 bits). */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Hash rapide (SHA-256) pour les secrets à haute entropie générés aléatoirement
 * (refresh tokens). Volontairement PAS Argon2id ici : Argon2id protège contre le
 * brute-force d'un secret à faible entropie choisi par un humain, ce qui n'est
 * pas le problème d'un token aléatoire de 256 bits — un hash rapide comparé en
 * temps constant est le choix correct et documenté (docs/ARCHITECTURE.md §4).
 */
export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Motifs de PIN triviaux explicitement rejetés (§4 du cahier des charges). */
export function isWeakPin(pin: string): boolean {
  if (!/^\d{6}$/.test(pin)) return true;

  const allSameDigit = /^(\d)\1{5}$/.test(pin); // 000000, 111111, ...
  if (allSameDigit) return true;

  const digits = pin.split("").map(Number);
  const isStrictlyIncreasing = digits.every((d, i) => i === 0 || d === digits[i - 1]! + 1);
  const isStrictlyDecreasing = digits.every((d, i) => i === 0 || d === digits[i - 1]! - 1);
  if (isStrictlyIncreasing || isStrictlyDecreasing) return true; // 123456, 654321

  const KNOWN_WEAK = new Set([
    "000000", "111111", "222222", "333333", "444444", "555555",
    "666666", "777777", "888888", "999999", "123456", "654321",
    "012345", "543210", "121212", "112233", "010101", "101010",
  ]);
  if (KNOWN_WEAK.has(pin)) return true;

  return false;
}
