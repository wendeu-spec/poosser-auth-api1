import { Router } from "express";
import { normalizePhone } from "../lib/phone.js";
import { Errors } from "../lib/errors.js";
import { requireAccessToken, requireStepUp } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { resolveLocale, t } from "../i18n/index.js";
import {
  requestOtpSchema,
  verifyOtpSchema,
  registerSchema,
  loginSchema,
  refreshSchema,
  logoutSchema,
  forgotPinSchema,
  resetPinSchema,
  changePinSchema,
  transactionPinSchema,
  stepUpSchema,
} from "../validators/authSchemas.js";

import { requestOtp, verifyOtp, consumeOtpTicket } from "../services/otpService.js";
import { registerUser, findUserByPhone, findUserById, getPublicUser } from "../services/userService.js";
import { assertPinStrength, verifyLoginPin, setLoginPin, setTransactionPin, verifyTransactionPin } from "../services/pinService.js";
import { upsertDevice, listDevices, getDeviceForUser, revokeDevice, revokeOtherDevices, revokeAllDevices } from "../services/deviceService.js";
import { createSession, rotateSession, revokeSessionByRefreshToken, revokeAllSessions } from "../services/sessionService.js";
import { assessLoginRisk } from "../services/riskService.js";
import { logSecurityEvent, listSecurityEvents } from "../services/securityEventService.js";
import { signStepUpToken } from "../lib/jwt.js";
import { pool, withTransaction } from "../db/pool.js";

export const authRouter = Router();

function clientIp(req: import("express").Request): string | null {
  return req.ip ?? null;
}
function clientUserAgent(req: import("express").Request): string | null {
  const ua = req.headers["user-agent"];
  return typeof ua === "string" ? ua : null;
}

// ---------------------------------------------------------------------------
// POST /auth/request-otp
// ---------------------------------------------------------------------------
authRouter.post("/request-otp", validateBody(requestOtpSchema), async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone) throw Errors.validation({ field: "phone" });

  const result = await requestOtp(phone, req.body.purpose, clientIp(req), clientUserAgent(req));
  res.json(result);
});

// ---------------------------------------------------------------------------
// POST /auth/verify-otp
// ---------------------------------------------------------------------------
authRouter.post("/verify-otp", validateBody(verifyOtpSchema), async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone) throw Errors.validation({ field: "phone" });

  const result = await verifyOtp(phone, req.body.purpose, req.body.code, clientIp(req));
  res.json(result);
});

// ---------------------------------------------------------------------------
// POST /auth/register
// ---------------------------------------------------------------------------
authRouter.post("/register", validateBody(registerSchema), async (req, res) => {
  const body = req.body as import("zod").infer<typeof registerSchema>;

  const claims = await consumeOtpTicket(body.otpVerificationTicket, "registration");

  assertPinStrength(body.pin, body.pinConfirmation);

  const { user, tokens } = await registerUser({
    phoneE164: claims.phone,
    firstName: body.firstName,
    lastName: body.lastName,
    displayName: body.displayName,
    email: body.email,
    profileTypeCode: body.profileTypeCode,
    pin: body.pin,
    device: body.device,
    ip: clientIp(req),
  });

  res.status(201).json({ user, ...tokens });
});

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------
authRouter.post("/login", validateBody(loginSchema), async (req, res) => {
  const body = req.body as import("zod").infer<typeof loginSchema>;
  const phone = normalizePhone(body.phone);
  const ip = clientIp(req);

  if (!phone) throw Errors.validation({ field: "phone" });

  const user = await findUserByPhone(phone);

  const pinOk = await verifyLoginPin(
    user?.id ?? null,
    user?.pin_hash ?? null,
    user?.pin_failed_attempts ?? 0,
    user?.pin_locked_until ?? null,
    body.pin,
    ip,
  );

  await pool.query(
    `INSERT INTO login_attempts (phone_e164, user_id, device_fingerprint, ip, success, failure_reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [phone, user?.id ?? null, body.device.fingerprint, ip, pinOk, pinOk ? null : "invalid_credentials"],
  );

  if (!user || user.status !== "active" || !pinOk) {
    throw Errors.invalidCredentials();
  }

  const { device, isNew: isNewDevice } = await upsertDevice(pool, user.id, body.device, ip);
  const risk = await assessLoginRisk(phone, ip, isNewDevice);

  const tokens = await createSession(pool, user.id, device.id);

  await logSecurityEvent({ userId: user.id, deviceId: device.id, type: "login_success", ip });
  if (isNewDevice) {
    await logSecurityEvent({
      userId: user.id,
      deviceId: device.id,
      type: "new_device",
      severity: "warning",
      ip,
      metadata: { reasons: risk.reasons },
    });
  }
  if (risk.level === "heightened") {
    await logSecurityEvent({
      userId: user.id,
      deviceId: device.id,
      type: "suspicious_attempt",
      severity: "warning",
      ip,
      metadata: { reasons: risk.reasons, recentFailedAttempts: risk.recentFailedAttempts },
    });
  }

  const publicUser = await getPublicUser(user.id);
  res.json({ user: publicUser, ...tokens, newDevice: isNewDevice });
});

// ---------------------------------------------------------------------------
// POST /auth/refresh
// ---------------------------------------------------------------------------
authRouter.post("/refresh", validateBody(refreshSchema), async (req, res) => {
  const tokens = await rotateSession(req.body.refreshToken, clientIp(req));
  res.json(tokens);
});

// ---------------------------------------------------------------------------
// POST /auth/logout   🔒
// ---------------------------------------------------------------------------
authRouter.post("/logout", requireAccessToken, validateBody(logoutSchema), async (req, res) => {
  await revokeSessionByRefreshToken(req.body.refreshToken, req.auth!.userId);
  await logSecurityEvent({
    userId: req.auth!.userId,
    deviceId: req.auth!.deviceId,
    type: "logout",
    ip: clientIp(req),
  });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// POST /auth/logout-all   🔒
// ---------------------------------------------------------------------------
authRouter.post("/logout-all", requireAccessToken, async (req, res) => {
  await withTransaction((client) => revokeAllSessions(client, req.auth!.userId));
  await logSecurityEvent({ userId: req.auth!.userId, type: "global_logout", ip: clientIp(req) });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// POST /auth/forgot-pin
// ---------------------------------------------------------------------------
authRouter.post("/forgot-pin", validateBody(forgotPinSchema), async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone) throw Errors.validation({ field: "phone" });

  const result = await requestOtp(phone, "account_recovery", clientIp(req), clientUserAgent(req));
  res.json(result);
});

// ---------------------------------------------------------------------------
// POST /auth/reset-pin
// ---------------------------------------------------------------------------
authRouter.post("/reset-pin", validateBody(resetPinSchema), async (req, res) => {
  const body = req.body as import("zod").infer<typeof resetPinSchema>;
  const ip = clientIp(req);

  const claims = await consumeOtpTicket(body.otpVerificationTicket, "account_recovery");
  assertPinStrength(body.newPin, body.newPinConfirmation);

  const user = await findUserByPhone(claims.phone);
  if (!user) throw Errors.otpTicketInvalid(); // le compte a pu être supprimé entre-temps

  await setLoginPin(user.id, body.newPin);

  // Scénario "téléphone perdu" par défaut : on révoque les appareils eux-mêmes
  // (pas seulement leurs sessions actives), pour qu'un ancien appareil compromis
  // ne réapparaisse pas comme "actif" dans /auth/devices, et qu'il ne puisse pas
  // se reconnecter silencieusement. On le fait AVANT d'enregistrer le nouvel
  // appareil, pour ne jamais annuler la session qu'on est en train de créer.
  if (body.revokeOtherDevices) {
    await withTransaction((client) => revokeAllDevices(client, user.id));
  }

  const { device } = await upsertDevice(pool, user.id, body.device, ip);
  const tokens = await createSession(pool, user.id, device.id);

  await logSecurityEvent({ userId: user.id, deviceId: device.id, type: "account_recovered", severity: "warning", ip });
  await logSecurityEvent({ userId: user.id, deviceId: device.id, type: "login_success", ip, metadata: { via: "account_recovery" } });

  const publicUser = await getPublicUser(user.id);
  res.json({ user: publicUser, ...tokens });
});

// ---------------------------------------------------------------------------
// POST /auth/change-pin   🔒
// ---------------------------------------------------------------------------
authRouter.post("/change-pin", requireAccessToken, validateBody(changePinSchema), async (req, res) => {
  const body = req.body as import("zod").infer<typeof changePinSchema>;
  const ip = clientIp(req);

  const user = await findUserById(req.auth!.userId);
  if (!user) throw Errors.unauthorized();

  const currentOk = await verifyLoginPin(
    user.id,
    user.pin_hash,
    user.pin_failed_attempts,
    user.pin_locked_until,
    body.currentPin,
    ip,
  );
  if (!currentOk) throw Errors.invalidCredentials();

  assertPinStrength(body.newPin, body.newPinConfirmation);
  await setLoginPin(user.id, body.newPin);
  await logSecurityEvent({ userId: user.id, type: "pin_changed", ip });

  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// GET /auth/me   🔒
// ---------------------------------------------------------------------------
authRouter.get("/me", requireAccessToken, async (req, res) => {
  const user = await getPublicUser(req.auth!.userId);
  if (!user) throw Errors.unauthorized();
  res.json(user);
});

// ---------------------------------------------------------------------------
// GET /auth/devices   🔒
// ---------------------------------------------------------------------------
authRouter.get("/devices", requireAccessToken, async (req, res) => {
  const devices = await listDevices(req.auth!.userId);
  res.json({
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      isPrimary: d.is_primary,
      isCurrent: d.id === req.auth!.deviceId,
      status: d.status,
      lastSeenAt: d.last_seen_at,
      createdAt: d.created_at,
    })),
  });
});

// ---------------------------------------------------------------------------
// DELETE /auth/devices/:id   🔒
// ---------------------------------------------------------------------------
authRouter.delete("/devices/:id", requireAccessToken, async (req, res) => {
  const deviceId = req.params.id;
  if (typeof deviceId !== "string") throw Errors.validation({ field: "id" });

  const device = await getDeviceForUser(req.auth!.userId, deviceId);
  if (!device) throw Errors.deviceNotFound();

  await withTransaction((client) => revokeDevice(client, device.id));
  await logSecurityEvent({
    userId: req.auth!.userId,
    deviceId: device.id,
    type: "device_revoked",
    ip: clientIp(req),
  });

  res.status(204).end();
});

// ---------------------------------------------------------------------------
// POST /auth/devices/revoke-others   🔒
// ---------------------------------------------------------------------------
authRouter.post("/devices/revoke-others", requireAccessToken, async (req, res) => {
  const revokedCount = await withTransaction((client) =>
    revokeOtherDevices(client, req.auth!.userId, req.auth!.deviceId),
  );
  await logSecurityEvent({
    userId: req.auth!.userId,
    deviceId: req.auth!.deviceId,
    type: "device_revoked",
    ip: clientIp(req),
    metadata: { revokedCount, scope: "others" },
  });
  res.json({ revokedCount });
});

// ---------------------------------------------------------------------------
// GET /auth/security-events   🔒
// ---------------------------------------------------------------------------
authRouter.get("/security-events", requireAccessToken, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const before = typeof req.query.before === "string" ? req.query.before : undefined;

  const events = await listSecurityEvents(req.auth!.userId, limit, before);
  res.json({
    events: events.map((e) => ({
      id: e.id,
      type: e.event_type,
      severity: e.severity,
      deviceName: e.device_name,
      createdAt: e.created_at,
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /auth/transaction-pin   🔒
// ---------------------------------------------------------------------------
authRouter.post("/transaction-pin", requireAccessToken, validateBody(transactionPinSchema), async (req, res) => {
  const body = req.body as import("zod").infer<typeof transactionPinSchema>;
  const ip = clientIp(req);

  const { getTransactionCredentials } = await import("../services/pinService.js");
  const existing = await getTransactionCredentials(req.auth!.userId);

  if (existing) {
    if (!body.currentTransactionPin) throw Errors.validation({ field: "currentTransactionPin" });
    const ok = await verifyTransactionPin(req.auth!.userId, body.currentTransactionPin, ip);
    if (!ok) throw Errors.invalidCredentials();
  }

  assertPinStrength(body.newTransactionPin, body.newTransactionPinConfirmation);
  await setTransactionPin(req.auth!.userId, body.newTransactionPin);

  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// POST /auth/step-up   🔒
// ---------------------------------------------------------------------------
authRouter.post("/step-up", requireAccessToken, validateBody(stepUpSchema), async (req, res) => {
  const ip = clientIp(req);
  const ok = await verifyTransactionPin(req.auth!.userId, req.body.transactionPin, ip);
  if (!ok) throw Errors.invalidCredentials();

  const amr = ["transaction_pin"];
  const stepUpToken = signStepUpToken({ sub: req.auth!.userId, deviceId: req.auth!.deviceId, amr });

  res.json({ stepUpToken, expiresIn: 300, amr });
});

// Exemple d'usage de requireStepUp, exposé pour la Phase 3 des futures
// fonctionnalités financières — non routé publiquement, juste pour référence :
// authRouter.post('/wallet/transfer', requireAccessToken, requireStepUp(['transaction_pin']), ...)
void requireStepUp; // évite un import inutilisé tant qu'aucun endpoint ne l'exploite encore
