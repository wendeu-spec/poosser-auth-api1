import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fiabilité de l'envoi SMS via Africa's Talking (maj36).
 *
 * Le défaut corrigé : l'adaptateur considérait l'envoi réussi dès que la
 * requête HTTP aboutissait. Or l'API répond HTTP 200 même quand le message
 * est REFUSÉ — crédit épuisé, sender ID non approuvé, numéro invalide. Le
 * vrai résultat est un `statusCode` par destinataire, dans le corps.
 *
 * Conséquence : POOSSER annonçait « code envoyé » pendant que rien ne
 * partait. L'utilisateur attendait devant l'écran de saisie du code, et
 * aucun journal ne disait pourquoi. Ces tests verrouillent chacun des cas
 * qu'Africa's Talking documente.
 *
 * Aucune requête réelle n'est faite : `fetch` est remplacé.
 */

const ENV_SMS = {
  SMS_PROVIDER: "africastalking",
  AFRICASTALKING_USERNAME: "poosser-test",
  AFRICASTALKING_API_KEY: "cle-de-test",
  AFRICASTALKING_SENDER_ID: "POOSSER",
};

async function chargerProvider() {
  // Le module de configuration lit process.env à l'import : il faut donc
  // réinitialiser le cache des modules après avoir posé les variables.
  vi.resetModules();
  const { AfricasTalkingSmsProvider } = await import("../src/services/sms/AfricasTalkingSmsProvider.js");
  return new AfricasTalkingSmsProvider();
}

/** Le provider ET le logger du MÊME registre : après vi.resetModules(), un
 *  import séparé donnerait une autre instance, qu'espionner ne servirait à
 *  rien. */
async function chargerProviderEtLogger() {
  vi.resetModules();
  const [{ AfricasTalkingSmsProvider }, { logger }] = await Promise.all([
    import("../src/services/sms/AfricasTalkingSmsProvider.js"),
    import("../src/lib/logger.js"),
  ]);
  return { provider: new AfricasTalkingSmsProvider(), logger };
}

/** Le message tel qu'il part réellement : le corps est encodé en formulaire,
 *  où les espaces deviennent des « + ». */
function messageEnvoye(appel: { mock: { calls: unknown[][] } }) {
  const options = appel.mock.calls[0]![1] as RequestInit;
  return new URLSearchParams(options.body!.toString()).get("message") ?? "";
}

/** Réponse d'Africa's Talking : HTTP 200, avec le vrai résultat dedans. */
function reponse(statusCode: number, status = "Success") {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      SMSMessageData: {
        Message: "Sent to 1/1 Total Cost: XAF 18.0000",
        Recipients: [{ statusCode, number: "+237690000000", status, cost: "XAF 18.0000" }],
      },
    }),
  } as unknown as Response;
}

let envOriginal: NodeJS.ProcessEnv;

beforeEach(() => {
  envOriginal = { ...process.env };
  Object.assign(process.env, ENV_SMS);
});

afterEach(() => {
  process.env = envOriginal;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ce qui part vraiment", () => {
  it("accepte les trois statuts qui veulent dire « parti »", async () => {
    for (const statusCode of [100, 101, 102]) {
      vi.stubGlobal("fetch", vi.fn(async () => reponse(statusCode)));
      const provider = await chargerProvider();
      await expect(provider.sendOtp("+237690000000", "123456", "registration")).resolves.toBeUndefined();
    }
  });

  it("envoie bien le numéro, le sender ID et le code au fournisseur", async () => {
    const appel = vi.fn(async () => reponse(101));
    vi.stubGlobal("fetch", appel);
    const provider = await chargerProvider();
    await provider.sendOtp("+237690000000", "123456", "registration");

    expect(appel).toHaveBeenCalledTimes(1);
    const [url, options] = appel.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/version1/messaging");
    const corps = (options.body as URLSearchParams).toString();
    expect(corps).toContain("to=%2B237690000000");
    expect(corps).toContain("from=POOSSER");
    expect(decodeURIComponent(corps)).toContain("123456");
    // Un délai maximum est posé : sans lui, un fournisseur muet suspend
    // l'inscription jusqu'à l'abandon.
    expect(options.signal).toBeDefined();
  });

  it("annonce une durée d'expiration chiffrée, pas « quelques minutes »", async () => {
    const appel = vi.fn(async () => reponse(101));
    vi.stubGlobal("fetch", appel);
    const provider = await chargerProvider();
    await provider.sendOtp("+237690000000", "123456", "registration");
    const message = messageEnvoye(appel as never);
    expect(message).toMatch(/expire dans \d+ minutes/);
    expect(message).not.toContain("quelques minutes");
  });
});

describe("ce qui est refusé malgré un HTTP 200", () => {
  // Chacun de ces cas arrivait AUPARAVANT comme un succès.
  const refus: Array<[number, string]> = [
    [405, "InsufficientBalance"],
    [402, "InvalidSenderId"],
    [403, "InvalidPhoneNumber"],
    [406, "UserInBlacklist"],
    [409, "DoNotDisturbRejection"],
    [407, "CouldNotRoute"],
    [502, "RejectedByGateway"],
    [500, "InternalServerError"],
  ];

  for (const [statusCode, label] of refus) {
    it(`échoue sur ${statusCode} ${label}`, async () => {
      vi.stubGlobal("fetch", vi.fn(async () => reponse(statusCode, label)));
      const provider = await chargerProvider();
      await expect(provider.sendOtp("+237690000000", "123456", "registration")).rejects.toMatchObject({
        code: "SMS_SEND_FAILED",
      });
    });
  }

  it("échoue aussi sur un statut inconnu plutôt que de le prendre pour un succès", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reponse(999, "Inconnu")));
    const provider = await chargerProvider();
    await expect(provider.sendOtp("+237690000000", "123456", "registration")).rejects.toMatchObject({
      code: "SMS_SEND_FAILED",
    });
  });
});

describe("les pannes franches", () => {
  it("échoue quand la réponse HTTP est en erreur", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401 }) as unknown as Response));
    const provider = await chargerProvider();
    await expect(provider.sendOtp("+237690000000", "123456", "registration")).rejects.toMatchObject({
      code: "SMS_SEND_FAILED",
    });
  });

  it("échoue quand le fournisseur ne répond pas du tout", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fetch failed"); }));
    const provider = await chargerProvider();
    await expect(provider.sendOtp("+237690000000", "123456", "registration")).rejects.toMatchObject({
      code: "SMS_SEND_FAILED",
    });
  });

  it("échoue quand la réponse n'est pas du JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200, json: async () => { throw new Error("pas du JSON"); },
    }) as unknown as Response));
    const provider = await chargerProvider();
    await expect(provider.sendOtp("+237690000000", "123456", "registration")).rejects.toMatchObject({
      code: "SMS_SEND_FAILED",
    });
  });

  it("échoue quand aucun destinataire n'est traité — nom d'utilisateur ou clé refusés", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ SMSMessageData: { Message: "Invalid credentials", Recipients: [] } }),
    }) as unknown as Response));
    const provider = await chargerProvider();
    await expect(provider.sendOtp("+237690000000", "123456", "registration")).rejects.toMatchObject({
      code: "SMS_SEND_FAILED",
    });
  });
});

describe("le code ne fuit jamais dans les journaux", () => {
  it("un refus ne journalise ni le code ni le message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reponse(405, "InsufficientBalance")));
    const { provider, logger } = await chargerProviderEtLogger();
    const espion = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    await expect(provider.sendOtp("+237690000000", "999111", "registration")).rejects.toThrow();

    const journalise = JSON.stringify(espion.mock.calls);
    expect(journalise).not.toContain("999111");
    expect(journalise).not.toContain("votre code de vérification");
    // En revanche il DIT quoi faire : c'est tout l'intérêt.
    expect(journalise).toMatch(/Crédit|crédit/);
  });
});

describe("configuration", () => {
  it("refuse de démarrer sans clés plutôt que d'échouer en silence", async () => {
    process.env.AFRICASTALKING_API_KEY = "";
    vi.resetModules();
    const { AfricasTalkingSmsProvider } = await import("../src/services/sms/AfricasTalkingSmsProvider.js");
    expect(() => new AfricasTalkingSmsProvider()).toThrow(/AFRICASTALKING_USERNAME/);
  });

  it("permet de viser le bac à sable sans toucher au code", async () => {
    process.env.AFRICASTALKING_BASE_URL = "https://api.sandbox.africastalking.com";
    const appel = vi.fn(async () => reponse(101));
    vi.stubGlobal("fetch", appel);
    const provider = await chargerProvider();
    await provider.sendOtp("+237690000000", "123456", "registration");
    expect((appel.mock.calls[0] as unknown as [string])[0]).toContain("api.sandbox.africastalking.com");
  });
});
