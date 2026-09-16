import { parsePhoneNumberFromString } from "libphonenumber-js";
import { env } from "../config/env.js";

/**
 * Normalise un numéro de téléphone en E.164 (+237670000000).
 *
 * IMPORTANT : `DEFAULT_PHONE_COUNTRY` (CM par défaut) n'est utilisé QUE comme
 * indice pour interpréter un numéro saisi sans indicatif international (ex.
 * "670000000" tapé par un utilisateur au Cameroun). Un numéro déjà présenté au
 * format international (+225xxxxxxxxxx, +33xxxxxxxxx, ...) est toujours reconnu
 * tel quel, quel que soit ce défaut. L'architecture ne suppose jamais que
 * l'utilisateur est camerounais.
 */
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const parsed = parsePhoneNumberFromString(trimmed, env.DEFAULT_PHONE_COUNTRY as never);
  if (!parsed || !parsed.isValid()) return null;

  return parsed.number; // toujours au format E.164, ex: "+237670000000"
}
