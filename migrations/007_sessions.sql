-- Sessions = chaîne de rotation des refresh tokens. Le token lui-même n'est jamais
-- stocké : seulement son empreinte (SHA-256 suffit pour un secret à haute entropie
-- généré aléatoirement — voir docs/ARCHITECTURE.md §4 pour la justification).
CREATE TABLE sessions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id              UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,

  refresh_token_hash     TEXT NOT NULL,
  -- Identifiant de la "famille" de rotation : partagé par toute la lignée de tokens
  -- issus d'une même connexion initiale, permet de tout révoquer d'un coup si une
  -- réutilisation est détectée.
  refresh_token_family   TEXT NOT NULL,

  status                 TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'revoked', 'reused_detected')),

  expires_at             TIMESTAMPTZ NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at             TIMESTAMPTZ,
  revoked_at             TIMESTAMPTZ,
  revoked_reason         TEXT
);

CREATE UNIQUE INDEX sessions_refresh_token_hash_key ON sessions (refresh_token_hash);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_device_id_idx ON sessions (device_id);
CREATE INDEX sessions_family_idx ON sessions (refresh_token_family);
