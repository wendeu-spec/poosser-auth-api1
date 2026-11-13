-- Échéances récurrentes du Planner rattachées à un compte, et validation
-- « Réalisé » qui crée le mouvement côté serveur, en une seule transaction
-- SQL, sans jamais le créer deux fois.
--
-- account_id : compte sur lequel l'échéance sera payée / encaissée. NULL =
-- compte par défaut de l'utilisateur au moment de la validation
-- (comportement des événements existants). Si le compte est supprimé,
-- l'échéance revient au compte par défaut plutôt que de bloquer.
--
-- transaction_id : mouvement créé lors de la validation. Sert de garde
-- anti-doublon (une échéance déjà liée ne recrée jamais de mouvement) et
-- permet de retrouver le mouvement depuis l'échéance. Si le mouvement est
-- supprimé ensuite, le lien est simplement effacé.
ALTER TABLE planner_events
  ADD COLUMN account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  ADD COLUMN transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL;

CREATE INDEX planner_events_account_idx ON planner_events (account_id) WHERE account_id IS NOT NULL;
CREATE INDEX planner_events_transaction_idx ON planner_events (transaction_id) WHERE transaction_id IS NOT NULL;
