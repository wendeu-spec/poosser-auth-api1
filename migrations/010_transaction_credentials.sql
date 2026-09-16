-- Structure prête pour le futur PIN transactionnel, explicitement DISTINCT du PIN de
-- connexion stocké sur `users`. Ne rien fusionner : deux secrets, deux cycles de vie.
CREATE TABLE transaction_credentials (
  user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  pin_hash            TEXT NOT NULL,
  pin_algo            TEXT NOT NULL DEFAULT 'argon2id',
  failed_attempts     INT NOT NULL DEFAULT 0,
  locked_until        TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
