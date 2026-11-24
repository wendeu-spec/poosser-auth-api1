import { env } from "../../config/env.js";
import { Errors } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import type { SmsProvider } from "./SmsProvider.js";

/**
 * Adaptateur Africa's Talking (https://africastalking.com/).
 *
 * POURQUOI CE FICHIER A ÉTÉ REPRIS (maj36)
 *
 * La première version considérait l'envoi réussi dès que la requête HTTP
 * aboutissait. C'est faux, et dangereusement : l'API répond HTTP 200 même
 * quand le message est REFUSÉ. Le vrai résultat est un `statusCode` par
 * destinataire dans le corps de la réponse.
 *
 * Conséquence du défaut : crédit épuisé, et POOSSER annonçait « code
 * envoyé ». L'utilisateur attendait un SMS qui ne viendrait jamais, et rien
 * dans les journaux ne disait pourquoi. Une panne silencieuse, c'est-à-dire
 * la pire sorte.
 *
 * Désormais : on lit le statusCode, on échoue franchement quand le message
 * n'est pas parti, et on écrit dans les journaux de quoi diagnostiquer —
 * jamais le code lui-même.
 */

/**
 * Codes de retour par destinataire, d'après la documentation d'Africa's
 * Talking. Seuls les trois premiers veulent dire que le message est pris en
 * charge ; tous les autres arrivent dans une réponse HTTP parfaitement
 * normale.
 */
const STATUS_LABELS: Record<number, string> = {
  100: "Processed",
  101: "Sent",
  102: "Queued",
  401: "RiskHold",
  402: "InvalidSenderId",
  403: "InvalidPhoneNumber",
  404: "UnsupportedNumberType",
  405: "InsufficientBalance",
  406: "UserInBlacklist",
  407: "CouldNotRoute",
  409: "DoNotDisturbRejection",
  500: "InternalServerError",
  501: "GatewayError",
  502: "RejectedByGateway",
};

/** 100 Processed, 101 Sent, 102 Queued : le message est parti ou va partir. */
const STATUS_ACCEPTES = new Set([100, 101, 102]);

/**
 * Ce qui demande une action de l'exploitant, pas de l'utilisateur. Ces
 * cas-là sont journalisés en `error` plutôt qu'en `warn` : ils n'ont rien
 * d'accidentel et bloquent TOUTES les inscriptions tant qu'ils durent.
 */
const STATUS_A_CORRIGER: Record<number, string> = {
  402: "Le sender ID n'est pas approuvé par Africa's Talking — vérifiez le dossier KYC.",
  405: "Crédit Africa's Talking épuisé : plus aucun SMS ne part. Rechargez le compte.",
};

interface RecipientResult {
  statusCode?: number;
  status?: string;
  number?: string;
  cost?: string;
}

export class AfricasTalkingSmsProvider implements SmsProvider {
  constructor() {
    if (!env.AFRICASTALKING_USERNAME || !env.AFRICASTALKING_API_KEY) {
      throw new Error(
        "SMS_PROVIDER=africastalking mais AFRICASTALKING_USERNAME / AFRICASTALKING_API_KEY " +
          "sont vides. Renseignez de vraies clés dans .env ou repassez SMS_PROVIDER=console.",
      );
    }
  }

  async sendOtp(
    phoneE164: string,
    code: string,
    purpose: "registration" | "account_recovery",
  ): Promise<void> {
    // Durée annoncée tirée de la configuration réelle : « quelques minutes »
    // n'aide personne à savoir s'il faut attendre ou redemander un code.
    const minutes = Math.max(1, Math.round(env.OTP_TTL_SECONDS / 60));
    const message =
      purpose === "registration"
        ? `POOSSER : votre code de vérification est ${code}. Il expire dans ${minutes} minutes. Ne le partagez jamais.`
        : `POOSSER : votre code de récupération de compte est ${code}. Il expire dans ${minutes} minutes. Ne le partagez jamais.`;

    const body = new URLSearchParams({
      username: env.AFRICASTALKING_USERNAME,
      to: phoneE164,
      message,
      ...(env.AFRICASTALKING_SENDER_ID ? { from: env.AFRICASTALKING_SENDER_ID } : {}),
    });

    let response: Response;
    try {
      response = await fetch(`${env.AFRICASTALKING_BASE_URL}/version1/messaging`, {
        method: "POST",
        headers: {
          apiKey: env.AFRICASTALKING_API_KEY,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
        // Sans délai maximum, un fournisseur qui ne répond pas laisse
        // l'inscription suspendue jusqu'à l'abandon de l'utilisateur.
        signal: AbortSignal.timeout(env.AFRICASTALKING_TIMEOUT_MS),
      });
    } catch (err) {
      // Réseau coupé, DNS, délai dépassé. On ne journalise jamais le corps de
      // la requête : il contient le code.
      logger.error(
        { phoneE164, raison: (err as Error).name || "network_error" },
        "[AfricasTalkingSmsProvider] le fournisseur n'a pas répondu",
      );
      throw Errors.smsSendFailed();
    }

    if (!response.ok) {
      logger.error(
        { status: response.status, phoneE164 },
        "[AfricasTalkingSmsProvider] réponse HTTP en erreur",
      );
      throw Errors.smsSendFailed();
    }

    // ---- Le vrai résultat est ICI, pas dans le statut HTTP ----
    let payload: { SMSMessageData?: { Message?: string; Recipients?: RecipientResult[] } };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      logger.error({ phoneE164 }, "[AfricasTalkingSmsProvider] réponse illisible (JSON attendu)");
      throw Errors.smsSendFailed();
    }

    const recipients = payload.SMSMessageData?.Recipients ?? [];
    if (!recipients.length) {
      // Aucun destinataire traité : le plus souvent un nom d'utilisateur ou
      // une clé d'API refusés. Le résumé textuel d'Africa's Talking le dit.
      logger.error(
        { phoneE164, resume: payload.SMSMessageData?.Message },
        "[AfricasTalkingSmsProvider] aucun destinataire traité",
      );
      throw Errors.smsSendFailed();
    }

    const resultat = recipients[0]!;
    const statusCode = Number(resultat.statusCode);
    if (!STATUS_ACCEPTES.has(statusCode)) {
      const label = STATUS_LABELS[statusCode] ?? "statut inconnu";
      const aCorriger = STATUS_A_CORRIGER[statusCode];
      logger.error(
        { phoneE164, statusCode, label, status: resultat.status },
        aCorriger
          ? `[AfricasTalkingSmsProvider] ENVOI BLOQUÉ — ${aCorriger}`
          : `[AfricasTalkingSmsProvider] message refusé (${label})`,
      );
      throw Errors.smsSendFailed();
    }

    logger.info(
      { phoneE164, statusCode, label: STATUS_LABELS[statusCode], cost: resultat.cost },
      "[AfricasTalkingSmsProvider] message accepté par le fournisseur",
    );
  }
}
