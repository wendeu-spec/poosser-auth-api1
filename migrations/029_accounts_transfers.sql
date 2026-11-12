-- Comptes et virements : répondre à « où se trouve mon argent » en plus de
-- « à quoi il a servi ». Chaque mouvement (transaction) est désormais
-- rattaché à un compte (Espèces, Mobile Money, banque, épargne...), ce qui
-- permet d'afficher un solde par compte.
--
-- Choix validés avec l'utilisateur :
--   * le rattachement à un compte est OBLIGATOIRE : un compte « Espèces » est
--     créé d'office pour chaque utilisateur existant et reçoit tous les
--     mouvements déjà saisis (backfill ci-dessous) ; les nouveaux comptes
--     utilisateurs reçoivent ce même compte par défaut à la première requête
--     qui en a besoin (accountService.ensureDefaultAccount) ;
--   * un passage d'un compte à un autre (ex. retrait Mobile Money vers les
--     espèces) est un VIREMENT, neutre (ni revenu ni dépense), avec des frais
--     facultatifs enregistrés automatiquement comme une vraie dépense
--     « Frais Mobile Money » sur le compte débité (transactions.transfer_id).
--
-- Solde d'un compte = opening_balance
--   + revenus − dépenses rattachés au compte (frais de virement compris)
--   + virements reçus − virements émis.
-- Calculé à la lecture (accountService.listAccounts), jamais stocké : un
-- solde stocké finit toujours par diverger des mouvements.

CREATE TABLE accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  type            TEXT NOT NULL CHECK (type IN ('especes', 'mobile_money', 'banque', 'epargne', 'autre')),
  -- Solde au moment où l'utilisateur commence à suivre ce compte dans
  -- POOSSER. Peut être négatif (découvert bancaire).
  opening_balance NUMERIC(14, 2) NOT NULL DEFAULT 0,
  -- Un compte qui a servi ne se supprime pas (l'historique en dépend) : on
  -- l'archive. Un compte archivé ne reçoit plus de nouveaux mouvements.
  archived        BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deux comptes d'un même utilisateur ne peuvent pas porter le même nom
-- (insensible à la casse) : sinon impossible de les distinguer dans les listes.
CREATE UNIQUE INDEX accounts_user_name_key ON accounts (user_id, lower(name));
CREATE INDEX accounts_user_id_idx ON accounts (user_id);

CREATE TRIGGER accounts_touch_updated_at
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE transfers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  to_account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  amount          NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  fee             NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  occurred_on     DATE NOT NULL,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_account_id <> to_account_id)
);

CREATE INDEX transfers_user_id_occurred_on_idx ON transfers (user_id, occurred_on DESC);
CREATE INDEX transfers_from_account_id_idx ON transfers (from_account_id);
CREATE INDEX transfers_to_account_id_idx ON transfers (to_account_id);

CREATE TRIGGER transfers_touch_updated_at
  BEFORE UPDATE ON transfers
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE transactions ADD COLUMN account_id UUID REFERENCES accounts(id) ON DELETE RESTRICT;
-- Renseigné uniquement pour la dépense « frais » générée par un virement :
-- supprimer le virement supprime ses frais (CASCADE), et le service refuse
-- de modifier ou supprimer ces frais directement (ils suivent leur virement).
ALTER TABLE transactions ADD COLUMN transfer_id UUID REFERENCES transfers(id) ON DELETE CASCADE;

-- Backfill : un compte « Espèces » par utilisateur existant, qui reçoit tous
-- ses mouvements déjà saisis.
INSERT INTO accounts (user_id, name, type)
SELECT id, 'Espèces', 'especes' FROM users;

UPDATE transactions t
SET account_id = a.id
FROM accounts a
WHERE a.user_id = t.user_id;

ALTER TABLE transactions ALTER COLUMN account_id SET NOT NULL;

CREATE INDEX transactions_account_id_idx ON transactions (account_id);
CREATE INDEX transactions_transfer_id_idx ON transactions (transfer_id);
