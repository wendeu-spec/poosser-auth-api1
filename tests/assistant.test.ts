import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, resetDb, registerFreshUser } from "./helpers.js";

beforeEach(resetDb);

describe("Assistant IA (POST /api/assistant/ask)", () => {
  it("refuse sans jeton d'authentification", async () => {
    await request(app).post("/api/assistant/ask").send({ question: "Quel est mon solde ?" }).expect(401);
  });

  it("refuse une question vide", async () => {
    const { body } = await registerFreshUser();
    const res = await request(app)
      .post("/api/assistant/ask")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .send({ question: "" })
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("refuse une question absente du corps de requête", async () => {
    const { body } = await registerFreshUser();
    await request(app)
      .post("/api/assistant/ask")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .send({})
      .expect(400);
  });

  it(
    "en mode AI_PROVIDER=console (défaut en test), répond toujours par un repli " +
      "sur le moteur local (source: fallback, answer: null), jamais une erreur",
    async () => {
      const { body } = await registerFreshUser();
      const res = await request(app)
        .post("/api/assistant/ask")
        .set("Authorization", `Bearer ${body.accessToken}`)
        .send({ question: "Comment se porte mon budget Alimentation ?", context: { solde: 12000 } })
        .expect(200);
      expect(res.body).toEqual({ source: "fallback", answer: null });
    },
  );

  it("accepte une requête sans `context` (optionnel, défaut à un objet vide)", async () => {
    const { body } = await registerFreshUser();
    await request(app)
      .post("/api/assistant/ask")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .send({ question: "Quel est mon solde ?" })
      .expect(200);
  });

  it("refuse un `context` dont la taille sérialisée dépasse la limite autorisée", async () => {
    const { body } = await registerFreshUser();
    const hugeContext = { blob: "x".repeat(25_000) };
    const res = await request(app)
      .post("/api/assistant/ask")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .send({ question: "Quel est mon solde ?", context: hugeContext })
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("limite le nombre de questions par utilisateur sur la fenêtre (RATE_LIMIT_ASSISTANT_PER_USER)", async () => {
    const { body } = await registerFreshUser();
    // RATE_LIMIT_ASSISTANT_PER_USER=20 par défaut (voir .env.example) : les 20
    // premières passent, la 21e doit être bloquée.
    for (let i = 0; i < 20; i++) {
      await request(app)
        .post("/api/assistant/ask")
        .set("Authorization", `Bearer ${body.accessToken}`)
        .send({ question: `Question ${i}` })
        .expect(200);
    }
    const finalRes = await request(app)
      .post("/api/assistant/ask")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .send({ question: "Question de trop" });
    expect(finalRes.status).toBe(429);
    expect(finalRes.body.error.code).toBe("RATE_LIMITED");
    expect(finalRes.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("la limite de requêtes est par utilisateur : un autre compte n'est pas affecté", async () => {
    const userA = await registerFreshUser();
    for (let i = 0; i < 20; i++) {
      await request(app)
        .post("/api/assistant/ask")
        .set("Authorization", `Bearer ${userA.body.accessToken}`)
        .send({ question: `Question ${i}` })
        .expect(200);
    }
    await request(app)
      .post("/api/assistant/ask")
      .set("Authorization", `Bearer ${userA.body.accessToken}`)
      .send({ question: "Question de trop" })
      .expect(429);

    const userB = await registerFreshUser();
    await request(app)
      .post("/api/assistant/ask")
      .set("Authorization", `Bearer ${userB.body.accessToken}`)
      .send({ question: "Quel est mon solde ?" })
      .expect(200);
  });
});
