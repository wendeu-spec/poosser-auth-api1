-- Empêche le rejeu d'un otpVerificationTicket : le JWT lui-même prouve qu'un OTP a
-- été vérifié, mais sans cette table, un ticket valide pourrait être présenté
-- plusieurs fois tant qu'il n'a pas expiré (ex: rejouer /auth/reset-pin plusieurs
-- fois avec le même ticket). "OTP à usage unique" s'étend logiquement au ticket
-- qui en découle.
CREATE TABLE used_otp_tickets (
  jti         UUID PRIMARY KEY,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX used_otp_tickets_expires_idx ON used_otp_tickets (expires_at);
