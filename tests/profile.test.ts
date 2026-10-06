import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, resetDb, registerFreshUser } from "./helpers.js";

beforeEach(resetDb);

describe("Devise du compte (GET/PATCH /auth/me)", () => {
  it("un compte fraîchement créé a 'XAF' comme devise par défaut", async () => {
    const { body } = await registerFreshUser();
    expect(body.user.currency).toBe("XAF");

    const res = await request(app)
      .get("/auth/me")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .expect(200);
    expect(res.body.currency).toBe("XAF");
  });

  it("change la devise du compte et la renvoie dans la réponse", async () => {
    const { body } = await registerFreshUser();
    const res = await request(app)
      .patch("/auth/me")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .send({ currency: "EUR" })
      .expect(200);
    expect(res.body.user.currency).toBe("EUR");
    // le reste du profil ne doit pas bouger au passage
    expect(res.body.user.id).toBe(body.user.id);
    expect(res.body.user.firstName).toBe(body.user.firstName);
  });

  it("la nouvelle devise persiste : un GET /me ultérieur la confirme", async () => {
    const { body } = await registerFreshUser();
    await request(app)
      .patch("/auth/me")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .send({ currency: "USD" })
      .expect(200);

    const res = await request(app)
      .get("/auth/me")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .expect(200);
    expect(res.body.currency).toBe("USD");
  });

  it("refuse un code devise inconnu", async () => {
    const { body } = await registerFreshUser();
    const res = await request(app)
      .patch("/auth/me")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .send({ currency: "JPY" })
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("refuse une devise vide ou absente", async () => {
    const { body } = await registerFreshUser();
    await request(app)
      .patch("/auth/me")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .send({})
      .expect(400);
  });

  it("refuse sans jeton d'authentification", async () => {
    await request(app).patch("/auth/me").send({ currency: "EUR" }).expect(401);
  });

  it("changer la devise d'un compte n'affecte pas les autres comptes", async () => {
    const userA = await registerFreshUser();
    const userB = await registerFreshUser();

    await request(app)
      .patch("/auth/me")
      .set("Authorization", `Bearer ${userA.body.accessToken}`)
      .send({ currency: "GBP" })
      .expect(200);

    const resB = await request(app)
      .get("/auth/me")
      .set("Authorization", `Bearer ${userB.body.accessToken}`)
      .expect(200);
    expect(resB.body.currency).toBe("XAF");
  });
});
