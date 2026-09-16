import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, resetDb, registerFreshUser, requestOtpAndGetCode, freshFingerprint } from "./helpers.js";
import { pool } from "../src/db/pool.js";

beforeEach(resetDb);

async function runRecovery(phone: string, newPin: string, revokeOtherDevices = true) {
  const code = await requestOtpAndGetCode(phone, "account_recovery");
  const verify = await request(app)
    .post("/auth/verify-otp")
    .send({ phone, purpose: "account_recovery", code })
    .expect(200);
  const res = await request(app)
    .post("/auth/reset-pin")
    .send({
      otpVerificationTicket: verify.body.otpVerificationTicket,
      newPin,
      newPinConfirmation: newPin,
      revokeOtherDevices,
      device: { fingerprint: freshFingerprint("recovery"), name: "Recovery Device", platform: "web" },
    });
  return res;
}

describe("Récupération de compte (/auth/forgot-pin, /auth/reset-pin)", () => {
  it("permet de définir un nouveau PIN et connecte automatiquement (auto-login)", async () => {
    const { phone } = await registerFreshUser();

    const res = await runRecovery(phone, "918273");
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.user.phone).toBe(phone);
  });

  it("l'ancien PIN ne fonctionne plus après réinitialisation, le nouveau fonctionne", async () => {
    const { phone, pin: oldPin, device } = await registerFreshUser();
    const recovered = await runRecovery(phone, "918273");
    expect(recovered.status).toBe(200);

    await request(app).post("/auth/login").send({ phone, pin: oldPin, device }).expect(401);
    await request(app)
      .post("/auth/login")
      .send({ phone, pin: "918273", device: { fingerprint: freshFingerprint(), name: "Any", platform: "web" } })
      .expect(200);
  });

  it("scénario téléphone perdu : revokeOtherDevices=true révoque réellement les ANCIENS appareils (pas juste leur session)", async () => {
    // Régression : /auth/reset-pin appelait auparavant revokeAllSessions() (qui ne
    // touche que les sessions) au lieu de revokeAllDevices() (qui marque aussi le
    // device lui-même comme révoqué) — un ancien appareil perdu réapparaissait donc
    // comme "actif" dans /auth/devices après une récupération de compte.
    const { phone, body: originalRegistration } = await registerFreshUser();
    const accessTokenParts = (originalRegistration.accessToken as string).split(".");
    const originalDeviceId = JSON.parse(Buffer.from(accessTokenParts[1]!, "base64url").toString()).deviceId;

    const res = await runRecovery(phone, "918273", true);
    expect(res.status).toBe(200);

    const devices = await request(app)
      .get("/auth/devices")
      .set("Authorization", `Bearer ${res.body.accessToken}`)
      .expect(200);
    const oldDevice = devices.body.devices.find((d: any) => d.id === originalDeviceId);
    expect(oldDevice).toBeDefined();
    expect(oldDevice.status).toBe("revoked");
  });

  it("l'ancien access token est invalidé après une récupération de compte", async () => {
    const { phone, body } = await registerFreshUser();
    const recovered = await runRecovery(phone, "918273");
    expect(recovered.status).toBe(200);

    await request(app).get("/auth/devices").set("Authorization", `Bearer ${body.accessToken}`).expect(401);
  });

  it("refuse un ticket de vérification pour un motif différent (registration vs account_recovery)", async () => {
    const { phone } = await registerFreshUser();
    // On demande un OTP d'inscription (mauvais "purpose") puis on tente un reset-pin avec.
    // registerFreshUser() a déjà consommé le cooldown de renvoi pour ce numéro : on le
    // vide pour isoler ce qu'on teste ici (le mismatch de purpose sur le ticket).
    await pool.query(`DELETE FROM rate_limit_buckets WHERE key = $1`, [`otp_resend_cooldown:registration:${phone}`]);
    await request(app).post("/auth/request-otp").send({ phone, purpose: "registration" }).expect(200);
    const { sentOtps } = await import("./setup.js");
    const code = sentOtps.get(phone)!;
    const verify = await request(app)
      .post("/auth/verify-otp")
      .send({ phone, purpose: "registration", code })
      .expect(200);

    const res = await request(app)
      .post("/auth/reset-pin")
      .send({
        otpVerificationTicket: verify.body.otpVerificationTicket,
        newPin: "918273",
        newPinConfirmation: "918273",
        device: { fingerprint: freshFingerprint(), name: "X", platform: "web" },
      })
      .expect(400);
    expect(res.body.error.code).toBe("OTP_TICKET_INVALID");
  });
});
