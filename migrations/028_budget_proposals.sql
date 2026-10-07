-- Proposition automatique de budget mensuel : quelques jours avant le début
-- du mois N+1 (voir BUDGET_PROPOSAL_GENERATE_DAY_OF_MONTH), le serveur
-- propose de reprendre les événements planner non récurrents du mois N comme
-- point de départ du mois suivant — jamais appliqué directement : reste
-- "pending" tant que l'utilisateur n'a pas validé (éventuellement après
-- modification, dans le même formulaire wizard que "Proposer un budget
-- mensuel") ou explicitement ignoré. Un seul enregistrement par utilisateur
-- et par mois cible (génération idempotente : relancer la génération ne crée
-- jamais de doublon).
--
-- `items` stocke les lignes au même format que le wizard front-end
-- ([{titre, type, categorie, montant, jour}]) pour pouvoir être chargées
-- telles quelles dans le même formulaire éditable, sans étape de conversion
-- supplémentaire.
--
-- Rappels de validation : cadence dégressive calculée à la volée à partir de
-- generated_at/reminder_count/last_reminder_at (voir budgetProposalService.ts
-- et les variables RATE_LIMIT/REMINDER dans .env) plutôt que par une tâche
-- planifiée côté serveur — ce projet n'a pas de scheduler/cron dédié, donc la
-- génération et le calcul de rappel se déclenchent paresseusement à la
-- prochaine requête de l'utilisateur authentifié, jamais en tâche de fond.
CREATE TABLE budget_proposals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  target_month     DATE NOT NULL, -- premier jour du mois proposé (ex. 2026-11-01)
  source_month     DATE NOT NULL, -- premier jour du mois d'origine copié (ex. 2026-10-01)
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'validated', 'dismissed', 'auto_applied')),
  items            JSONB NOT NULL,

  generated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  reminder_count   INTEGER NOT NULL DEFAULT 0,
  last_reminder_at TIMESTAMPTZ,
  decided_at       TIMESTAMPTZ,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX budget_proposals_user_month_key ON budget_proposals (user_id, target_month);

CREATE TRIGGER budget_proposals_touch_updated_at
  BEFORE UPDATE ON budget_proposals
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
