-- Défis OTP. Rattachés au numéro de téléphone (pas à un user_id) car l'inscription
-- vérifie un numéro avant même que le compte existe.
CREATE TABLE otp_challenges (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164        TEXT NOT NULL,
  purpose           TEXT NOT NULL CHECK (purpose IN ('registration', 'account_recovery')),

  -- Jamais le code en clair : uniquement son empreinte Argon2id.
  code_hash         TEXT NOT NULL,

  attempts          INT NOT NULL DEFAULT 0,
  max_attempts      INT NOT NULL DEFAULT 5,
  expires_at        TIMESTAMPTZ NOT NULL,
  consumed_at       TIMESTAMPTZ,

  request_ip        INET,
  request_user_agent TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Recherche du challenge actif le plus récent pour un (téléphone, motif).
CREATE INDEX otp_challenges_phone_purpose_idx
  ON otp_challenges (phone_e164, purpose, created_at DESC);

-- Accélère les requêtes "y a-t-il un challenge encore valide ?".
CREATE INDEX otp_challenges_active_idx
  ON otp_challenges (phone_e164, purpose)
  WHERE consumed_at IS NULL;
