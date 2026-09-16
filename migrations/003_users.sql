-- Identité pivot : le numéro de téléphone, toujours normalisé E.164 avant stockage
-- (validation faite côté application avec libphonenumber-js, jamais un indicatif supposé).
CREATE TABLE users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164          TEXT NOT NULL,
  phone_verified_at   TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'suspended', 'deleted')),

  -- PIN de connexion (jamais en clair, jamais SHA-256 nu — voir docs/ARCHITECTURE.md §5)
  pin_hash            TEXT,
  pin_algo            TEXT NOT NULL DEFAULT 'argon2id',
  pin_updated_at      TIMESTAMPTZ,
  pin_failed_attempts INT NOT NULL DEFAULT 0,
  pin_locked_until    TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Un numéro = un compte. C'est la contrainte d'unicité la plus importante du schéma.
CREATE UNIQUE INDEX users_phone_e164_key ON users (phone_e164);
