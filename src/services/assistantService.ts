import { env } from "../config/env.js";
import { checkRateLimit } from "./rateLimiter.js";
import { assistantProvider } from "./assistant/index.js";
import { Errors } from "../lib/errors.js";

export interface AskAssistantResult {
  // "llm" : réponse produite par le fournisseur configuré (ex: Claude).
  // "fallback" : aucun LLM n'a répondu (mode console, clé absente, ou erreur
  // du fournisseur) — le client doit utiliser son moteur local existant.
  source: "llm" | "fallback";
  answer: string | null;
}

/**
 * Point d'entrée métier de l'Assistant IA. Applique la même limite de
 * fréquence par utilisateur que partout ailleurs dans le projet
 * (RATE_LIMIT_* configurable, jamais codé en dur) puis délègue au fournisseur
 * actif. Ne renvoie jamais d'erreur côté LLM lui-même : un souci du
 * fournisseur se traduit par `source: "fallback"`, jamais par une exception
 * qui casserait le chat pour l'utilisateur.
 */
export async function askAssistant(
  userId: string,
  question: string,
  context: unknown,
): Promise<AskAssistantResult> {
  const limit = await checkRateLimit(
    `assistant:user:${userId}`,
    env.RATE_LIMIT_ASSISTANT_PER_USER,
    env.RATE_LIMIT_ASSISTANT_PER_USER_WINDOW_SECONDS,
  );
  if (!limit.allowed) {
    throw Errors.rateLimited(limit.retryAfterSeconds);
  }

  const result = await assistantProvider.ask(question, context);
  if (!result) {
    return { source: "fallback", answer: null };
  }
  return { source: "llm", answer: result.answer };
}
