import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import { app, resetDb, registerFreshUser } from "./helpers.js";
import { requireAccessToken, requireStepUp } from "../src/middleware/auth.js";
import { errorHandler } from "../src/middleware/errorHandler.js";

beforeEach(resetDb);

describe("POST /auth/change-pin", () => {
  it("change le PIN de connexion avec le PIN actuel correct", async () => {
    const { phone, body } = await registerFreshUser();
    await request(app)
      .post("/auth/change-pin")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .send({ currentPin: "482913", newPin: "739284", newPinConfirmation: "739284" })
      .expect(200);

    await request(app)
      .post("/auth/login")
      .send({ phone, pin: "739284", device: { fingerprint: "any-device-fingerprint", name: "Any", platform: "web" } })
      .expect(200);
  });

  it("refuse si le PIN actuel est incorrect", async () => {
    const { body } = await registerFreshUser();
    const res = await request(app)
      .post("/auth/change-pin")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .send({ currentPin: "000000", newPin: "739284", newPinConfirmation: "739284" })
      .expect(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("refuse un nouveau PIN faible", async () => {
    const { body } = await registerFreshUser();
    const res = await request(app)
      .post("/auth/change-pin")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .send({ currentPin: "482913", newPin: "000000", newPinConfirmation: "000000" })
      .expect(400);
    expect(res.body.error.code).toBe("PIN_TOO_WEAK");
  });

  it("exige d'être authentifié", async () => {
    await request(app)
      .post("/auth/change-pin")
      .send({ currentPin: "482913", newPin: "739284", newPinConfirmation: "739284" })
      .expect(401);
  });
});

describe("PIN transactionnel (/auth/transaction-pin, /auth/step-up) — indépendant du PIN de connexion", () => {
  it("permet de définir un PIN transactionnel distinct du PIN de connexion", async () => {
    const { body } = await registerFreshUser({ pin: "482913" });
    await request(app)
      .post("/auth/transaction-pin")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .send({ newTransactionPin: "564738", newTransactionPinConfirmation: "564738" })
      .expect(200);
  });

  it("step-up réussit avec le PIN transactionnel correct et échoue avec le PIN de connexion", async () => {
    const { body } = await registerFreshUser({ pin: "482913" });
    await request(app)
      .post("/auth/transaction-pin")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .send({ newTransactionPin: "564738", newTransactionPinConfirmation: "564738" })
      .expect(200);

    const ok = await request(app)
      .post("/auth/step-up")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .send({ transactionPin: "564738" })
      .expect(200);
    expect(ok.body.stepUpToken).toEqual(expect.any(String));
    expect(ok.body.amr).toContain("transaction_pin");

    // Le PIN de CONNEXION (482913) ne doit PAS marcher comme PIN transactionnel :
    // preuve que les deux secrets sont bien architecturalement distincts (§10).
    const wrong = await request(app)
      .post("/auth/step-up")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .send({ transactionPin: "482913" })
      .expect(401);
    expect(wrong.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("step-up échoue si aucun PIN transactionnel n'a jamais été défini", async () => {
    const { body } = await registerFreshUser();
    const res = await request(app)
      .post("/auth/step-up")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .send({ transactionPin: "564738" })
      .expect(400);
    expect(res.body.error.code).toBe("TRANSACTION_PIN_NOT_SET");
  });

  it("requireStepUp protège une route de démonstration : refuse sans jeton d'élévation, accepte avec", async () => {
    // Aucune route financière n'existe encore dans l'API (le PIN transactionnel est
    // préparé pour l'avenir, §10/§11) — on vérifie donc directement le middleware
    // réutilisable avec une mini-route de test, sans toucher à l'app réelle.
    const demo = express();
    demo.use(express.json());
    demo.get("/protected", requireAccessToken, requireStepUp(["transaction_pin"]), (_req, res) => {
      res.json({ ok: true });
    });
    demo.use(errorHandler);

    const { body } = await registerFreshUser({ pin: "482913" });
    await request(app)
      .post("/auth/transaction-pin")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .send({ newTransactionPin: "564738", newTransactionPinConfirmation: "564738" })
      .expect(200);
    const stepUp = await request(app)
      .post("/auth/step-up")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .send({ transactionPin: "564738" })
      .expect(200);

    // Sans en-tête x-step-up-token : refusé.
    await request(demo).get("/protected").set("Authorization", `Bearer ${body.accessToken}`).expect(403);

    // Avec un step-up token valide et couvrant le bon amr : accepté.
    await request(demo)
      .get("/protected")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .set("x-step-up-token", stepUp.body.stepUpToken)
      .expect(200);
  });
});

describe("GET /auth/security-events", () => {
  it("ne retourne que les événements de l'utilisateur courant", async () => {
    const userA = await registerFreshUser();
    const userB = await registerFreshUser();

    const eventsA = await request(app)
      .get("/auth/security-events")
      .set("Authorization", `Bearer ${userA.body.accessToken}`)
      .expect(200);
    const eventsB = await request(app)
      .get("/auth/security-events")
      .set("Authorization", `Bearer ${userB.body.accessToken}`)
      .expect(200);

    expect(eventsA.body.events.length).toBeGreaterThan(0);
    expect(eventsB.body.events.length).toBeGreaterThan(0);
    // Aucun chevauchement d'ID entre les deux utilisateurs.
    const idsA = new Set(eventsA.body.events.map((e: any) => e.id));
    for (const e of eventsB.body.events) expect(idsA.has(e.id)).toBe(false);
  });
});
