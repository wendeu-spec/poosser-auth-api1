-- Projets : suivi des entrées/sorties liées à un projet spécifique (ex :
-- construction, mariage, voyage, lancement d'activité). Choix structurant
-- (vision consolidée, validé avec l'utilisateur) : les transactions d'un
-- projet restent aussi comptabilisées dans le budget et les listes
-- générales — project_id est une étiquette portée par la transaction, pas
-- un grand livre séparé.
CREATE TABLE projects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  name          TEXT NOT NULL,
  icon          TEXT NOT NULL DEFAULT '📁',
  target_amount NUMERIC(14, 2) CHECK (target_amount IS NULL OR target_amount > 0),
  target_date   DATE,
  status        TEXT NOT NULL DEFAULT 'actif' CHECK (status IN ('actif', 'termine', 'archive')),

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX projects_user_id_idx ON projects (user_id);

CREATE TRIGGER projects_touch_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Rattachement optionnel d'une transaction à un projet. SET NULL (pas
-- CASCADE) : supprimer un projet ne doit jamais effacer l'historique déjà
-- comptabilisé dans le budget général, seulement détacher l'étiquette.
ALTER TABLE transactions
  ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE SET NULL;

CREATE INDEX transactions_project_id_idx ON transactions (project_id) WHERE project_id IS NOT NULL;
