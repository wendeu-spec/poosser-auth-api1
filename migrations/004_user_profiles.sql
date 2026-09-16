-- Informations complémentaires du profil — minimisation des données : seuls les champs
-- listés dans le cahier des charges, rien de plus.
CREATE TABLE user_profiles (
  user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  first_name        TEXT NOT NULL,
  last_name         TEXT NOT NULL,
  display_name      TEXT,
  email             CITEXT,
  profile_type_code TEXT NOT NULL REFERENCES profile_types(code),
  locale            TEXT NOT NULL DEFAULT 'fr' CHECK (locale IN ('fr', 'en')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Email optionnel mais unique s'il est renseigné (plusieurs NULL sont autorisés par Postgres).
CREATE UNIQUE INDEX user_profiles_email_key ON user_profiles (email) WHERE email IS NOT NULL;
