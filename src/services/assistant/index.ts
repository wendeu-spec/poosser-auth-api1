import { env } from "../../config/env.js";
import type { AssistantProvider } from "./AssistantProvider.js";
import { ConsoleAssistantProvider } from "./ConsoleAssistantProvider.js";
import { AnthropicAssistantProvider } from "./AnthropicAssistantProvider.js";

/**
 * Point d'entrée unique : le reste de l'application importe `assistantProvider`
 * d'ici et ne sait jamais quelle implémentation concrète tourne derrière —
 * même principe que services/sms/index.ts.
 */
function buildAssistantProvider(): AssistantProvider {
  switch (env.AI_PROVIDER) {
    case "anthropic":
      return new AnthropicAssistantProvider();
    case "console":
    default:
      return new ConsoleAssistantProvider();
  }
}

export const assistantProvider: AssistantProvider = buildAssistantProvider();
export type { AssistantProvider, AssistantAnswer } from "./AssistantProvider.js";
