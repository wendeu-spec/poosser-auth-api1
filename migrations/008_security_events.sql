-- Journal d'audit. `metadata` est un JSONB générique pour absorber de futurs signaux
-- (réputation IP, géoloc approximative...) sans migration de schéma — mais l'application
-- garantit qu'aucun secret (PIN, OTP, token) n'y est jamais écrit.
CREATE TABLE security_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  device_id   UUID REFERENCES devices(id) ON DELETE SET NULL,

  event_type  TEXT NOT NULL CHECK (event_type IN (
    'login_success', 'login_failed', 'otp_requested', 'otp_invalid', 'otp_expired',
    'pin_incorrect', 'pin_changed', 'account_created', 'account_recovered',
    'account_locked_temporarily', 'new_device', 'device_revoked', 'logout',
    'global_logout', 'refresh_reuse_detected', 'suspicious_attempt', 'step_up_granted',
    'step_up_denied', 'transaction_pin_set'
  )),
  severity    TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),

  ip          INET,
  user_agent  TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX security_events_user_id_idx ON security_events (user_id, created_at DESC);
CREATE INDEX security_events_type_idx ON security_events (event_type, created_at DESC);
