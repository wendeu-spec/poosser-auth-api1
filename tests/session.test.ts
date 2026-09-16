import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, resetDb, registerFreshUser } from "./helpers.js";

beforeEach(resetDb);

describe("POST /auth/refresh — rotation et détection de réutilisation", () => {
  it("fait tourner le refresh token à chaque appel (l'ancien devient inutilisable)", async () => {
    const { body } = await registerFreshUser();

    const r1 = await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: body.refreshToken })
      .expect(200);
    expect(r1.body.refreshToken).not.toBe(body.refreshToken);

    // L'ancien token (déjà tourné) est maintenant refusé.
    const replay = await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: body.refreshToken })
      .expect(401);
    expect(replay.body.error.code).toBe("REFRESH_REUSE_DETECTED");
  });

  it("détecte la réutilisation et révoque TOUTE la famille de sessions, y compris le token tout juste émis", async () => {
    // Régression : logSecurityEvent() écrivait auparavant via le pool partagé au lieu
    // du client de transaction, ce qui faisait échouer l'insertion (FK sur users) au
    // moment de l'inscription, et — bug distinct trouvé pendant la vérification —
    // rotateSession() levait son erreur *à l'intérieur* de la transaction, ce qui
    // annulait par ROLLBACK la révocation de la famille qu'elle venait d'écrire. Ce
    // test vérifie que la révocation de la famille est bien committée.
    const { body } = await registerFreshUser();
    const original = body.refreshToken;

    const rotated = await request(app).post("/auth/refresh").send({ refreshToken: original }).expect(200);
    const rotatedToken = rotated.body.refreshToken;

    // Rejouer l'ancien token déclenche la détection de réutilisation...
    await request(app).post("/auth/refresh").send({ refreshToken: original }).expect(401);

    // ...et DOIT avoir révoqué également le token issu de la rotation légitime,
    // pas seulement l'ancien. Sinon un attaquant en possession du vieux refresh
    // token pourrait laisser le titulaire légitime continuer indéfiniment.
    const afterReuse = await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: rotatedToken })
      .expect(401);
    expect(afterReuse.body.error.code).toBe("REFRESH_REUSE_DETECTED");
  });

  it("journalise un événement critique refresh_reuse_detected", async () => {
    const { phone, pin, body } = await registerFreshUser();
    await request(app).post("/auth/refresh").send({ refreshToken: body.refreshToken }).expect(200);
    // Rejouer l'ancien token déclenche la détection de réutilisation, qui révoque
    // TOUTE la famille — y compris la session issue de la rotation ci-dessus. On se
    // reconnecte donc avec une session fraîche et indépendante pour lire le journal.
    await request(app).post("/auth/refresh").send({ refreshToken: body.refreshToken }).expect(401);

    const freshLogin = await request(app)
      .post("/auth/login")
      .send({ phone, pin, device: { fingerprint: "fresh-reader-device", name: "Reader", platform: "web" } })
      .expect(200);

    const events = await request(app)
      .get("/auth/security-events")
      .set("Authorization", `Bearer ${freshLogin.body.accessToken}`)
      .expect(200);
    const reuse = events.body.events.find((e: any) => e.type === "refresh_reuse_detected");
    expect(reuse).toBeDefined();
    expect(reuse.severity).toBe("critical");
  });

  it("refuse un refresh token inconnu", async () => {
    const res = await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: "aW52YWxpZC10b2tlbi1kb2VzLW5vdC1leGlzdA" })
      .expect(401);
    expect(res.body.error.code).toBe("REFRESH_INVALID");
  });

  it("l'access token expire réellement quand la session est révoquée (logout)", async () => {
    const { body } = await registerFreshUser();

    await request(app)
      .post("/auth/logout")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .send({ refreshToken: body.refreshToken })
      .expect(204);

    // L'access token JWT est encore signé/valide dans sa fenêtre de 15 min, mais la
    // session sous-jacente a été révoquée en base : requireAccessToken doit rejeter.
    await request(app)
      .get("/auth/devices")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .expect(401);
  });

  it("logout ne révoque que CETTE session, pas les autres appareils", async () => {
    const { phone, pin, body } = await registerFreshUser();
    const login2 = await request(app)
      .post("/auth/login")
      .send({ phone, pin, device: { fingerprint: "device-2", name: "Device 2", platform: "android" } })
      .expect(200);

    await request(app)
      .post("/auth/logout")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .send({ refreshToken: body.refreshToken })
      .expect(204);

    // La session du 2e appareil reste valide.
    await request(app)
      .get("/auth/devices")
      .set("Authorization", `Bearer ${login2.body.accessToken}`)
      .expect(200);
  });

  it("logout-all révoque TOUTES les sessions de l'utilisateur", async () => {
    const { phone, pin, body } = await registerFreshUser();
    const login2 = await request(app)
      .post("/auth/login")
      .send({ phone, pin, device: { fingerprint: "device-2", name: "Device 2", platform: "android" } })
      .expect(200);

    await request(app)
      .post("/auth/logout-all")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .expect(204);

    await request(app).get("/auth/devices").set("Authorization", `Bearer ${body.accessToken}`).expect(401);
    await request(app).get("/auth/devices").set("Authorization", `Bearer ${login2.body.accessToken}`).expect(401);
    await request(app).post("/auth/refresh").send({ refreshToken: body.refreshToken }).expect(401);
  });
});

describe("Accès à une route protégée sans jeton valide", () => {
  it("refuse l'accès sans Authorization", async () => {
    await request(app).get("/auth/devices").expect(401);
  });

  it("refuse un access token malformé", async () => {
    await request(app).get("/auth/devices").set("Authorization", "Bearer not-a-jwt").expect(401);
  });
});
