import { logger } from "../../lib/logger.js";
import type { AssistantAnswer, AssistantProvider } from "./AssistantProvider.js";

/**
 * Fournisseur de développement : n'appelle AUCUN service externe. Il
 * journalise la question dans les logs serveur (jamais dans la réponse HTTP)
 * et retourne systématiquement `null`, ce qui signale au client de répondre
 * avec son moteur local existant — même principe que ConsoleSmsProvider.
 *
 * Ce n'est pas un mock de sécurité : l'authentification, la limitation de
 * requêtes et la validation du corps de requête restent strictement
 * identiques à ce qu'elles seraient avec un vrai fournisseur — seule l'étape
 * "appel effectif au LLM" est remplacée par un log serveur, en attendant une
 * vraie clé d'API.
 */
export class ConsoleAssistantProvider implements AssistantProvider {
  async ask(question: string): Promise<AssistantAnswer | null> {
    logger.info(
      { questionDevOnly: question },
      "[ConsoleAssistantProvider] AI_PROVIDER=console — aucun LLM appelé, le client utilise son moteur local",
    );
    return null;
  }
}
