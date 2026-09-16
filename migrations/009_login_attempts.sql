-- Trace brute de chaque tentative de connexion, indexée par téléphone ET par IP,
-- utilisée par le rate limiter et le riskService. Volontairement séparée de
-- security_events (données plus techniques, volume plus élevé, rétention potentiellement
-- différente).
CREATE TABLE login_attempts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164          TEXT NOT NULL,
  user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
  device_fingerprint  TEXT,
  ip                  INET,
  success             BOOLEAN NOT NULL,
  failure_reason      TEXT, -- usage interne uniquement, jamais renvoyé tel quel au client

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX login_attempts_phone_idx ON login_attempts (phone_e164, created_at DESC);
CREATE INDEX login_attempts_ip_idx ON login_attempts (ip, created_at DESC);
