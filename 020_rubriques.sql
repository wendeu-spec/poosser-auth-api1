-- Rubriques : postes de dépense à l'intérieur d'un projet (ex: pour un
-- voyage, "Transport" et "Hébergement" ; pour une construction, "Fondation",
-- "Élévation", "Toiture"...). Une rubrique n'a de sens que pour SON projet
-- (pas une liste partagée entre tous les projets de l'utilisateur), d'où le
-- CASCADE : supprimer le projet supprime ses rubriques.
--
-- Choix structurant (validé avec l'utilisateur) : l'enveloppe (planned_amount)
-- est optionnelle — une rubrique peut être purement un libellé de
-- classement, ou porter un montant prévisionnel comparé au réel, sur le même
-- principe que l'objectif optionnel du projet lui-même.
--
-- Comme pour les totaux de projet, le montant réel dépensé par rubrique
-- n'est JAMAIS stocké ici : il est toujours recalculé à la lecture depuis
-- les transactions rattachées (rubrique_id), pour ne jamais se désynchroniser.
CREATE TABLE rubriques (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  name           TEXT NOT NULL,
  planned_amount NUMERIC(14, 2) CHECK (planned_amount IS NULL OR planned_amount > 0),
  position       INTEGER NOT NULL DEFAULT 0,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX rubriques_project_id_idx ON rubriques (project_id);

CREATE TRIGGER rubriques_touch_updated_at
  BEFORE UPDATE ON rubriques
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Rattachement optionnel d'une transaction à une rubrique de projet. SET
-- NULL (pas CASCADE) : supprimer une rubrique (ou le projet entier, via la
-- cascade ci-dessus) ne doit jamais effacer l'historique des transactions,
-- seulement détacher l'étiquette — même logique que project_id sur
-- transactions (voir migrations/019_projects.sql).
ALTER TABLE transactions
  ADD COLUMN rubrique_id UUID REFERENCES rubriques(id) ON DELETE SET NULL;

CREATE INDEX transactions_rubrique_id_idx ON transactions (rubrique_id) WHERE rubrique_id IS NOT NULL;
