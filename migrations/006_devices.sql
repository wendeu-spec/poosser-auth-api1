-- Appareils associés à un compte. Uniquement les informations utiles à la sécurité
-- (§7 du cahier des charges) : pas de collecte invasive.
CREATE TABLE devices (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Identifiant stable généré et conservé côté client (stockage sécurisé), pas un
  -- simple User-Agent qui changerait à chaque mise à jour d'app.
  device_fingerprint  TEXT NOT NULL,
  name                TEXT NOT NULL,
  platform            TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'web', 'other')),

  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  is_primary          BOOLEAN NOT NULL DEFAULT false,

  last_seen_at        TIMESTAMPTZ,
  last_ip             INET,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at          TIMESTAMPTZ
);

-- Un appareil (empreinte) n'est enregistré qu'une fois par utilisateur.
CREATE UNIQUE INDEX devices_user_fingerprint_key ON devices (user_id, device_fingerprint);
CREATE INDEX devices_user_id_idx ON devices (user_id);
