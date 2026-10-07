import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import type { AssistantAnswer, AssistantProvider } from "./AssistantProvider.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ANSWER_TOKENS = 400;

const SYSTEM_PROMPT = `Tu es l'assistant financier intégré à POOSSER, une application de gestion de finances personnelles ("Où va mon argent") utilisée par de jeunes cadres en Afrique et en Europe.

Règles impératives :
- Réponds toujours en français, de façon concise (3 à 5 phrases maximum), concrète et bienveillante.
- Tu reçois un contexte JSON déjà calculé à partir des données réelles du compte (solde, budgets par catégorie, épargne, tontines, planner, score de santé...) : appuie-toi UNIQUEMENT sur ces chiffres, ne jamais en inventer ou en supposer d'autres.
- Si le contexte ne contient pas l'information nécessaire pour répondre, dis-le clairement plutôt que de deviner.
- Tu ne donnes jamais de conseil d'investissement ou fiscal personnalisé, et tu rappelles que tu n'es pas un conseiller agréé si la question s'y apparente.
- Tu ne demandes jamais de données sensibles (mot de passe, code PIN, numéro de carte).`;

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
}

/**
 * Appelle l'API Claude (Anthropic) directement en HTTP — pas de SDK ajouté
 * pour une seule requête texte, cohérent avec le reste du projet qui préfère
 * peu de dépendances. Toute erreur (réseau, clé invalide, timeout, réponse
 * inattendue) est journalisée puis absorbée en retournant `null` : jamais de
 * crash du endpoint, jamais d'utilisateur bloqué sans réponse.
 */
export class AnthropicAssistantProvider implements AssistantProvider {
  async ask(question: string, context: unknown): Promise<AssistantAnswer | null> {
    if (!env.ANTHROPIC_API_KEY) {
      logger.warn(
        "[AnthropicAssistantProvider] AI_PROVIDER=anthropic mais ANTHROPIC_API_KEY est absent — repli sur le moteur local",
      );
      return null;
    }

    try {
      const res = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": ANTHROPIC_API_VERSION,
        },
        body: JSON.stringify({
          model: env.ANTHROPIC_MODEL,
          max_tokens: MAX_ANSWER_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: `Contexte financier (JSON, déjà calculé côté client) :\n${JSON.stringify(context)}\n\nQuestion de l'utilisateur : ${question}`,
            },
          ],
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!res.ok) {
        logger.error(
          { status: res.status },
          "[AnthropicAssistantProvider] réponse non-OK de l'API Anthropic — repli sur le moteur local",
        );
        return null;
      }

      const data = (await res.json()) as AnthropicMessagesResponse;
      const text = data.content?.find((block) => block.type === "text")?.text?.trim();
      if (!text) {
        logger.error("[AnthropicAssistantProvider] réponse Anthropic sans texte exploitable — repli sur le moteur local");
        return null;
      }

      return { source: "llm", answer: text };
    } catch (err) {
      logger.error({ err }, "[AnthropicAssistantProvider] échec d'appel à l'API Anthropic — repli sur le moteur local");
      return null;
    }
  }
}
