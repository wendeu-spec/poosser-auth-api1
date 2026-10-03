-- Favoris de saisie rapide : un mouvement fréquent (ex: "Taxi" à 500 FCFA,
-- "Recharge crédit" à 1000 FCFA) enregistré une fois pour être rejoué en
-- quelques secondes depuis l'onglet Transactions, au lieu de ressaisir les
-- mêmes champs chaque jour. Choix structurant validé avec l'utilisateur :
-- appuyer sur un favori PRÉ-REMPLIT le formulaire (comme le bouton
-- "↻ Répéter" existant) plutôt que de créer la transaction instantanément —
-- le montant reste modifiable avant validation (ex: un taxi qui n'est pas
-- toujours exactement au même prix).
--
-- Un favori est un gabarit de transaction, pas une transaction elle-même :
-- aucun lien vers transactions, et le supprimer n'affecte jamais l'historique
-- déjà saisi. project_id/rubrique_id sont en ON DELETE SET NULL (même
-- logique que sur transactions, voir migrations/019_projects.sql et
-- 020_rubriques.sql) : supprimer le projet/la rubrique détache simplement le
-- favori au lieu de le supprimer ou de bloquer la suppression.
CREATE TABLE transaction_favorites (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  label        TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('revenu', 'depense')),
  category     TEXT NOT NULL,
  amount       NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  method       TEXT NOT NULL CHECK (method IN ('Mobile Money', 'Espèces', 'Virement bancaire', 'Autre')),
  note         TEXT,
  project_id   UUID REFERENCES projects(id) ON DELETE SET NULL,
  rubrique_id  UUID REFERENCES rubriques(id) ON DELETE SET NULL,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX transaction_favorites_user_id_idx ON transaction_favorites (user_id, created_at);

CREATE TRIGGER transaction_favorites_touch_updated_at
  BEFORE UPDATE ON transaction_favorites
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
