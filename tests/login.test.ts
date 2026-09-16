import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, resetDb, freshPhone, VALID_DEVICE, registerFreshUser } from "./helpers.js";

beforeEach(resetDb);

describe("POST /auth/login", () => {
  it("connecte avec le bon PIN", async () => {
    const { phone, pin, device } = await registerFreshUser();
    const res = await request(app).post("/auth/login").send({ phone, pin, device }).expect(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toEqual(expect.any(String));
  });

  it("refuse un mauvais PIN", async () => {
    const { phone, device } = await registerFreshUser();
    const res = await request(app)
      .post("/auth/login")
      .send({ phone, pin: "000000", device })
      .expect(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("répond de façon indiscernable pour un numéro qui n'existe pas (anti-énumération)", async () => {
    const { device } = await registerFreshUser();
    const unknownPhone = freshPhone();

    const resKnownWrongPin = await request(app)
      .post("/auth/login")
      .send({ phone: unknownPhone, pin: "000000", device })
      .expect(401);
    expect(resKnownWrongPin.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("verrouille temporairement le compte après trop d'échecs consécutifs (RATE_LIMIT_LOGIN_PER_PHONE)", async () => {
    const { phone, pin, device } = await registerFreshUser();

    // RATE_LIMIT_LOGIN_PER_PHONE=5 dans .env.test — le 5e échec doit déclencher le verrou.
    for (let i = 0; i < 5; i++) {
      await request(app).post("/auth/login").send({ phone, pin: "000000", device }).expect(401);
    }

    // Même le BON pin est désormais refusé pendant la durée du verrou.
    const res = await request(app).post("/auth/login").send({ phone, pin, device }).expect(423);
    expect(res.body.error.code).toBe("ACCOUNT_LOCKED");
    expect(res.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("réinitialise le compteur d'échecs après une connexion réussie", async () => {
    const { phone, pin, device } = await registerFreshUser();

    await request(app).post("/auth/login").send({ phone, pin: "000000", device }).expect(401);
    await request(app).post("/auth/login").send({ phone, pin: "000000", device }).expect(401);
    await request(app).post("/auth/login").send({ phone, pin, device }).expect(200);

    // Après un succès, on peut de nouveau échouer plusieurs fois sans être immédiatement verrouillé.
    await request(app).post("/auth/login").send({ phone, pin: "000000", device }).expect(401);
    const res = await request(app).post("/auth/login").send({ phone, pin, device }).expect(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
  });

  it("signale un nouvel appareil (newDevice / événement new_device)", async () => {
    const { phone, pin } = await registerFreshUser();
    const secondDevice = VALID_DEVICE("Second Device");

    const res = await request(app).post("/auth/login").send({ phone, pin, device: secondDevice }).expect(200);
    expect(res.body.newDevice).toBe(true);

    const events = await request(app)
      .get("/auth/security-events")
      .set("Authorization", `Bearer ${res.body.accessToken}`)
      .expect(200);
    expect(events.body.events.some((e: any) => e.type === "new_device")).toBe(true);
  });

  it("ne signale PAS de nouvel appareil pour un appareil déjà connu", async () => {
    const { phone, pin, device } = await registerFreshUser();
    const res = await request(app).post("/auth/login").send({ phone, pin, device }).expect(200);
    expect(res.body.newDevice).toBeFalsy();
  });
});
