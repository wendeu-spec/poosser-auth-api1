import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, resetDb, freshPhone, sentOtps, registerFreshUser } from "./helpers.js";
import { pool } from "../src/db/pool.js";

beforeEach(resetDb);

describe("Cycle OTP (/auth/request-otp, /auth/verify-otp)", () => {
  it("accepte le bon code et retourne un ticket", async () => {
    const phone = freshPhone();
    await request(app).post("/auth/request-otp").send({ phone, purpose: "registration" }).expect(200);
    const code = sentOtps.get(phone)!;

    const res = await request(app)
      .post("/auth/verify-otp")
      .send({ phone, purpose: "registration", code })
      .expect(200);
    expect(res.body.otpVerificationTicket).toEqual(expect.any(String));
  });

  it("refuse un mauvais code sans jamais révéler d'information sur son existence", async () => {
    const phone = freshPhone();
    await request(app).post("/auth/request-otp").send({ phone, purpose: "registration" }).expect(200);

    const res = await request(app)
      .post("/auth/verify-otp")
      .send({ phone, purpose: "registration", code: "000000" })
      .expect(400);
    expect(res.body.error.code).toBe("OTP_INVALID");
    expect(res.body.error.message.toLowerCase()).not.toMatch(/existe|inscrit|enregistr/);
  });

  it("refuse un OTP expiré", async () => {
    const phone = freshPhone();
    await request(app).post("/auth/request-otp").send({ phone, purpose: "registration" }).expect(200);
    const code = sentOtps.get(phone)!;

    // On force l'expiration directement en base (on ne peut pas attendre 5 minutes réelles dans une suite de tests).
    await pool.query(
      `UPDATE otp_challenges SET expires_at = now() - interval '1 second' WHERE phone_e164 = $1`,
      [phone],
    );

    const res = await request(app)
      .post("/auth/verify-otp")
      .send({ phone, purpose: "registration", code })
      .expect(400);
    expect(res.body.error.code).toBe("OTP_INVALID");
  });

  it("refuse la réutilisation d'un code déjà consommé (un seul usage)", async () => {
    const phone = freshPhone();
    await request(app).post("/auth/request-otp").send({ phone, purpose: "registration" }).expect(200);
    const code = sentOtps.get(phone)!;

    await request(app).post("/auth/verify-otp").send({ phone, purpose: "registration", code }).expect(200);

    const res = await request(app)
      .post("/auth/verify-otp")
      .send({ phone, purpose: "registration", code })
      .expect(400);
    expect(res.body.error.code).toBe("OTP_INVALID");
  });

  it("verrouille après un nombre excessif de mauvais essais (OTP_MAX_ATTEMPTS)", async () => {
    const phone = freshPhone();
    await request(app).post("/auth/request-otp").send({ phone, purpose: "registration" }).expect(200);

    // OTP_MAX_ATTEMPTS=5 dans .env.test — on épuise volontairement les tentatives.
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post("/auth/verify-otp")
        .send({ phone, purpose: "registration", code: "999999" })
        .expect(400);
    }

    // Même le VRAI code doit désormais être refusé : le challenge est épuisé.
    const code = sentOtps.get(phone)!;
    const res = await request(app)
      .post("/auth/verify-otp")
      .send({ phone, purpose: "registration", code })
      .expect(400);
    expect(res.body.error.code).toBe("OTP_INVALID");
  });

  it("applique le cooldown de renvoi (RATE_LIMIT_OTP_REQUEST_PER_PHONE / cooldown)", async () => {
    const phone = freshPhone();
    await request(app).post("/auth/request-otp").send({ phone, purpose: "registration" }).expect(200);

    // Une deuxième demande immédiate pour le même numéro doit être bloquée (cooldown de renvoi).
    const res = await request(app)
      .post("/auth/request-otp")
      .send({ phone, purpose: "registration" })
      .expect(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
    expect(res.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("limite le nombre de demandes OTP par téléphone sur la fenêtre (RATE_LIMIT_OTP_REQUEST_PER_PHONE)", async () => {
    const phone = freshPhone();
    const cooldownKey = `otp_resend_cooldown:registration:${phone}`;
    // RATE_LIMIT_OTP_REQUEST_PER_PHONE=3 sur cette fenêtre, mais le cooldown de renvoi
    // (60s) bloquerait dès la 2e requête : on le vide à chaque itération pour isoler
    // la limite "par téléphone / fenêtre" elle-même.
    for (let i = 0; i < 3; i++) {
      await pool.query(`DELETE FROM rate_limit_buckets WHERE key = $1`, [cooldownKey]);
      await request(app).post("/auth/request-otp").send({ phone, purpose: "registration" }).expect(200);
    }
    // La 4e requête dépasse la limite de 3, même avec le cooldown vidé.
    await pool.query(`DELETE FROM rate_limit_buckets WHERE key = $1`, [cooldownKey]);
    const finalRes = await request(app).post("/auth/request-otp").send({ phone, purpose: "registration" });
    expect(finalRes.status).toBe(429);
    expect(finalRes.body.error.code).toBe("RATE_LIMITED");
  });

  it("anti-énumération : /auth/forgot-pin répond identiquement, numéro inscrit ou non", async () => {
    const { phone: registeredPhone } = await registerFreshUser();
    sentOtps.clear(); // on ne garde que ce que ce test génère lui-même
    const unknownPhone = freshPhone();

    const resKnown = await request(app).post("/auth/forgot-pin").send({ phone: registeredPhone }).expect(200);
    const resUnknown = await request(app).post("/auth/forgot-pin").send({ phone: unknownPhone }).expect(200);

    expect(Object.keys(resKnown.body).sort()).toEqual(Object.keys(resUnknown.body).sort());
    expect(resKnown.status).toBe(resUnknown.status);
    expect(resKnown.body).toEqual(resUnknown.body);

    // Le numéro inscrit reçoit réellement un OTP...
    expect(sentOtps.has(registeredPhone)).toBe(true);
    // ...mais AUCUN SMS n'est envoyé, ni aucune ligne otp_challenges créée, pour le numéro inconnu.
    expect(sentOtps.has(unknownPhone)).toBe(false);
    const { rows } = await pool.query(`SELECT 1 FROM otp_challenges WHERE phone_e164 = $1`, [unknownPhone]);
    expect(rows.length).toBe(0);
  });
});
