import { z } from "zod";

const phoneSchema = z.string().min(6).max(20);
const pinSchema = z.string().regex(/^\d{6}$/, "Le PIN doit contenir exactement 6 chiffres");
const otpCodeSchema = z.string().regex(/^\d{4,8}$/);

const deviceSchema = z.object({
  fingerprint: z.string().min(8).max(255),
  name: z.string().min(1).max(120),
  platform: z.enum(["android", "ios", "web", "other"]),
});

export const requestOtpSchema = z.object({
  phone: phoneSchema,
  purpose: z.enum(["registration", "account_recovery"]),
});

export const verifyOtpSchema = z.object({
  phone: phoneSchema,
  purpose: z.enum(["registration", "account_recovery"]),
  code: otpCodeSchema,
});

export const registerSchema = z.object({
  otpVerificationTicket: z.string().min(10),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  displayName: z.string().trim().max(120).optional(),
  email: z.string().trim().email().max(255).optional(),
  profileTypeCode: z.string().min(1).max(40),
  pin: pinSchema,
  pinConfirmation: pinSchema,
  device: deviceSchema,
});

export const loginSchema = z.object({
  phone: phoneSchema,
  pin: pinSchema,
  device: deviceSchema,
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});

export const logoutSchema = z.object({
  refreshToken: z.string().min(10),
});

export const forgotPinSchema = z.object({
  phone: phoneSchema,
});

export const resetPinSchema = z.object({
  otpVerificationTicket: z.string().min(10),
  newPin: pinSchema,
  newPinConfirmation: pinSchema,
  revokeOtherDevices: z.boolean().optional().default(true),
  device: deviceSchema,
});

export const changePinSchema = z.object({
  currentPin: pinSchema,
  newPin: pinSchema,
  newPinConfirmation: pinSchema,
});

export const transactionPinSchema = z.object({
  currentTransactionPin: pinSchema.optional(),
  newTransactionPin: pinSchema,
  newTransactionPinConfirmation: pinSchema,
});

export const stepUpSchema = z.object({
  transactionPin: pinSchema,
});
