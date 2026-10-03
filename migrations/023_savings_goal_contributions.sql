-- Historique des versements vers un objectif d'épargne. Jusqu'ici
-- "+ Verser" se contentait d'écraser current_amount (PATCH) sans laisser de
-- trace datée — impossible de répondre à "combien a été épargné cette
-- semaine ?" pour le résumé hebdomadaire. Cette table journalise chaque
-- versement (montant réellement saisi par l'utilisateur, même si le solde
-- affiché est ensuite plafonné à l'objectif) pour permettre un calcul exact
-- par fenêtre de dates, au lieu d'une approximation sur current_amount.
CREATE TABLE savings_goal_contributions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id    UUID NOT NULL REFERENCES savings_goals(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount     NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX savings_goal_contributions_user_id_idx ON savings_goal_contributions (user_id, created_at);
CREATE INDEX savings_goal_contributions_goal_id_idx ON savings_goal_contributions (goal_id, created_at);
