/**
 * Abstraction du fournisseur de modèle de langage pour l'Assistant IA. Toute la
 * logique métier (assistantService, routes) ne connaît que cette interface —
 * jamais un SDK ou une API HTTP de fournisseur spécifique. Changer de
 * fournisseur = écrire une nouvelle classe ici et changer AI_PROVIDER dans
 * .env, sans toucher au reste de l'application (même principe que
 * services/sms/SmsProvider.ts).
 */
export interface AssistantAnswer {
  source: "llm";
  answer: string;
}

export interface AssistantProvider {
  /**
   * Retourne `null` quand ce fournisseur ne peut pas produire de réponse (mode
   * "console", clé absente, ou erreur/indisponibilité de l'API externe) — le
   * client bascule alors sans accroc sur son moteur à mots-clés local
   * (answerQuestion() dans public/app/index.html). Ne lève jamais : un souci
   * côté LLM ne doit jamais empêcher l'utilisateur d'obtenir une réponse.
   */
  ask(question: string, context: unknown): Promise<AssistantAnswer | null>;
}
