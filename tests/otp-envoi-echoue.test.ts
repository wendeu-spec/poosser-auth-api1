import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * Ce que POOSSER répond quand le SMS ne part pas (maj36).
 *
 * Deux exigences qui se contredisent, et qu'il faut tenir ensemble :
 *
 *   1. À L'INSCRIPTION, l'échec doit remonter. Sans cela l'utilisateur reste
 *      devant « saisissez votre code » à attendre un SMS qui ne viendra
 *      jamais — c'est le défaut que maj36 corrige.
 *
 *   2. À LA RÉCUPÉRATION DE COMPTE, l'échec ne doit RIEN changer à la
 *      réponse. Ce chemin répond volontairement la même chose que le compte
 *      existe ou non (voir otpService.requestOtp). Si une panne d'envoi
 *      faisait sortir une erreur, il suffirait d'attendre une panne pour
 *      découvrir quels numéros ont un compte chez POOSSER.
 *
 * Le harnais de tests (tests/setup.ts) mocke déjà la frontière d'envoi pour
 * capturer les codes. On ne la remplace pas : on la REPREND, en gardant la
 * capture et en ajoutant de quoi provoquer une panne à volonté.
 */

const envoi = vi.hoisted(() => ({ echoue: false, appels: 0 }));

vi.mock("../src/services/sms/index.js", () => ({
  smsProvider: {
    sendOtp: async (phoneE164: string, code: string) => {
      envoi.appels++;
      if (envoi.echoue) {
        const { Errors } = await import("../src/lib/errors.js");
        throw Errors.smsSendFailed();
      }
      const { sentOtps } = await import("./setup.js");
      sentOtps.set(phoneE164, code);
    },
  },
}));

const { app, resetDb, registerFreshUser } = await import("./helpers.js");

beforeEach(async () => {
  await resetDb();
  envoi.echoue = false;
  envoi.appels = 0;
});

const demanderCode = (phone: string, purpose: "registration" | "account_recovery") =>
  request(app).post("/auth/request-otp").send({ phone, purpose });

const numeroNeuf = () => "+2376" + String(Math.floor(10_000_000 + Math.random() * 89_999_999));

describe("à l'inscription, l'échec remonte", () => {
  it("répond SMS_SEND_FAILED au lieu d'annoncer un code envoyé", async () => {
    envoi.echoue = true;
    const res = await demanderCode(numeroNeuf(), "registration").expect(502);
    expect(res.body.error.code).toBe("SMS_SEND_FAILED");
  });

  it("et répond normalement quand l'envoi passe", async () => {
    const res = await demanderCode(numeroNeuf(), "registration").expect(200);
    expect(res.body.expiresInSeconds).toBeGreaterThan(0);
    expect(envoi.appels).toBe(1);
  });
});

describe("à la récupération, l'échec ne révèle rien", () => {
  it("répond EXACTEMENT comme pour un numéro inconnu, panne d'envoi comprise", async () => {
    const { phone } = await registerFreshUser();
    const inconnu = numeroNeuf();

    // L'envoi tombe en panne pour tout le monde.
    envoi.echoue = true;
    envoi.appels = 0;

    const surCompteExistant = await demanderCode(phone, "account_recovery");
    const surNumeroInconnu = await demanderCode(inconnu, "account_recovery");

    // Même statut, même corps : rien ne distingue les deux.
    expect(surCompteExistant.status).toBe(200);
    expect(surNumeroInconnu.status).toBe(200);
    expect(surCompteExistant.body).toEqual(surNumeroInconnu.body);

    // Preuve que la panne a bien eu lieu : l'envoi n'a été tenté QUE pour le
    // compte existant, et il a échoué — sans que la réponse le trahisse.
    expect(envoi.appels).toBe(1);
  });
});
