import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, resetDb, freshPhone, VALID_DEVICE, sentOtps } from "./helpers.js";
import { pool } from "../src/db/pool.js";

beforeEach(resetDb);

describe("POST /auth/register", () => {
  it("crée un compte après vérification OTP et retourne un accès immédiat (auto-login)", async () => {
    const phone = freshPhone();
    await request(app).post("/auth/request-otp").send({ phone, purpose: "registration" }).expect(200);
    const code = sentOtps.get(phone)!;

    const verify = await request(app)
      .post("/auth/verify-otp")
      .send({ phone, purpose: "registration", code })
      .expect(200);
    expect(verify.body.otpVerificationTicket).toEqual(expect.any(String));

    const register = await request(app)
      .post("/auth/register")
      .send({
        otpVerificationTicket: verify.body.otpVerificationTicket,
        firstName: "Yannis",
        lastName: "Test",
        profileTypeCode: "salarie",
        pin: "482913",
        pinConfirmation: "482913",
        device: VALID_DEVICE(),
      })
      .expect(201);

    expect(register.body.user.phone).toBe(phone);
    expect(register.body.accessToken).toEqual(expect.any(String));
    expect(register.body.refreshToken).toEqual(expect.any(String));
    // Le PIN ne doit JAMAIS être renvoyé, sous aucune forme, dans la réponse.
    expect(JSON.stringify(register.body)).not.toContain("482913");
  });

  it("refuse un otpVerificationTicket jamais vérifié / invalide", async () => {
    const res = await request(app)
      .post("/auth/register")
      .send({
        otpVerificationTicket: "not-a-real-ticket-xxxxxxxxxxxxxxxx",
        firstName: "Yannis",
        lastName: "Test",
        profileTypeCode: "salarie",
        pin: "482913",
        pinConfirmation: "482913",
        device: VALID_DEVICE(),
      })
      .expect(400);
    expect(res.body.error.code).toBe("OTP_TICKET_INVALID");
  });

  it("refuse un ticket OTP déjà utilisé pour une précédente inscription (usage unique)", async () => {
    const phone = freshPhone();
    await request(app).post("/auth/request-otp").send({ phone, purpose: "registration" }).expect(200);
    const code = sentOtps.get(phone)!;
    const verify = await request(app)
      .post("/auth/verify-otp")
      .send({ phone, purpose: "registration", code })
      .expect(200);
    const ticket = verify.body.otpVerificationTicket;

    await request(app)
      .post("/auth/register")
      .send({
        otpVerificationTicket: ticket,
        firstName: "Yannis",
        lastName: "Test",
        profileTypeCode: "salarie",
        pin: "482913",
        pinConfirmation: "482913",
        device: VALID_DEVICE(),
      })
      .expect(201);

    // Rejouer EXACTEMENT le même ticket pour une seconde tentative doit échouer,
    // même s'il est encore dans sa fenêtre de validité JWT.
    const secondPhone = freshPhone();
    const replay = await request(app)
      .post("/auth/register")
      .send({
        otpVerificationTicket: ticket,
        firstName: "Autre",
        lastName: "Personne",
        profileTypeCode: "salarie",
        pin: "739284",
        pinConfirmation: "739284",
        device: VALID_DEVICE("Other Device"),
      })
      .expect(400);
    expect(replay.body.error.code).toBe("OTP_TICKET_INVALID");
    void secondPhone;
  });

  it("refuse une seconde inscription sur un numéro déjà enregistré", async () => {
    const phone = freshPhone();
    await request(app).post("/auth/request-otp").send({ phone, purpose: "registration" }).expect(200);
    let code = sentOtps.get(phone)!;
    let verify = await request(app)
      .post("/auth/verify-otp")
      .send({ phone, purpose: "registration", code })
      .expect(200);
    await request(app)
      .post("/auth/register")
      .send({
        otpVerificationTicket: verify.body.otpVerificationTicket,
        firstName: "Yannis",
        lastName: "Test",
        profileTypeCode: "salarie",
        pin: "482913",
        pinConfirmation: "482913",
        device: VALID_DEVICE(),
      })
      .expect(201);

    // Nouvelle demande OTP pour le MÊME numéro (déjà enregistré) puis nouvelle tentative d'inscription.
    // On vide le cooldown de renvoi pour isoler ce qu'on teste ici (le refus de la
    // RÉINSCRIPTION elle-même), pas le rate limiting déjà couvert par tests/otp.test.ts.
    await pool.query(`DELETE FROM rate_limit_buckets WHERE key = $1`, [`otp_resend_cooldown:registration:${phone}`]);
    await request(app).post("/auth/request-otp").send({ phone, purpose: "registration" }).expect(200);
    code = sentOtps.get(phone)!;
    verify = await request(app)
      .post("/auth/verify-otp")
      .send({ phone, purpose: "registration", code })
      .expect(200);

    const res = await request(app)
      .post("/auth/register")
      .send({
        otpVerificationTicket: verify.body.otpVerificationTicket,
        firstName: "Yannis",
        lastName: "Bis",
        profileTypeCode: "salarie",
        pin: "111222",
        pinConfirmation: "111222",
        device: VALID_DEVICE(),
      })
      .expect(409);
    expect(res.body.error.code).toBe("PHONE_ALREADY_REGISTERED");
  });

  it("refuse un PIN faible (motif répété / séquence)", async () => {
    const phone = freshPhone();
    await request(app).post("/auth/request-otp").send({ phone, purpose: "registration" }).expect(200);
    const code = sentOtps.get(phone)!;
    const verify = await request(app)
      .post("/auth/verify-otp")
      .send({ phone, purpose: "registration", code })
      .expect(200);

    const res = await request(app)
      .post("/auth/register")
      .send({
        otpVerificationTicket: verify.body.otpVerificationTicket,
        firstName: "Yannis",
        lastName: "Test",
        profileTypeCode: "salarie",
        pin: "123456",
        pinConfirmation: "123456",
        device: VALID_DEVICE(),
      })
      .expect(400);
    expect(res.body.error.code).toBe("PIN_TOO_WEAK");
  });

  it("refuse quand pin et pinConfirmation diffèrent", async () => {
    const phone = freshPhone();
    await request(app).post("/auth/request-otp").send({ phone, purpose: "registration" }).expect(200);
    const code = sentOtps.get(phone)!;
    const verify = await request(app)
      .post("/auth/verify-otp")
      .send({ phone, purpose: "registration", code })
      .expect(200);

    const res = await request(app)
      .post("/auth/register")
      .send({
        otpVerificationTicket: verify.body.otpVerificationTicket,
        firstName: "Yannis",
        lastName: "Test",
        profileTypeCode: "salarie",
        pin: "482913",
        pinConfirmation: "111222",
        device: VALID_DEVICE(),
      })
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("refuse un profileTypeCode inconnu ou inactif", async () => {
    const phone = freshPhone();
    await request(app).post("/auth/request-otp").send({ phone, purpose: "registration" }).expect(200);
    const code = sentOtps.get(phone)!;
    const verify = await request(app)
      .post("/auth/verify-otp")
      .send({ phone, purpose: "registration", code })
      .expect(200);

    const res = await request(app)
      .post("/auth/register")
      .send({
        otpVerificationTicket: verify.body.otpVerificationTicket,
        firstName: "Yannis",
        lastName: "Test",
        profileTypeCode: "does-not-exist",
        pin: "482913",
        pinConfirmation: "482913",
        device: VALID_DEVICE(),
      })
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("accepte un numéro international qui n'est pas +237 (aucune hypothèse de pays)", async () => {
    // +33 (France) — vérifie qu'on n'assume jamais le Cameroun malgré DEFAULT_PHONE_COUNTRY=CM.
    const phone = "+33612345678";
    await request(app).post("/auth/request-otp").send({ phone, purpose: "registration" }).expect(200);
    const code = sentOtps.get(phone)!;
    const verify = await request(app)
      .post("/auth/verify-otp")
      .send({ phone, purpose: "registration", code })
      .expect(200);
    const register = await request(app)
      .post("/auth/register")
      .send({
        otpVerificationTicket: verify.body.otpVerificationTicket,
        firstName: "Yannis",
        lastName: "France",
        profileTypeCode: "salarie",
        pin: "482913",
        pinConfirmation: "482913",
        device: VALID_DEVICE(),
      })
      .expect(201);
    expect(register.body.user.phone).toBe("+33612345678");
  });
});
