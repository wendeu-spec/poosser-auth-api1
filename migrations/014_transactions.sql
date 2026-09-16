-- Mouvements financiers déclarés par l'utilisateur (revenus/dépenses). Saisie
-- manuelle pour cette v1 — voir docs/ROADMAP.md : l'intégration Mobile Money
-- réelle est un chantier ultérieur, délibérément hors scope du pilote fermé.
CREATE TABLE transactions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  type         TEXT NOT NULL CHECK (type IN ('revenu', 'depense')),
  category     TEXT NOT NULL,
  amount       NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  occurred_on  DATE NOT NULL,
  method       TEXT NOT NULL CHECK (method IN ('Mobile Money', 'Espèces', 'Virement bancaire', 'Autre')),
  note         TEXT,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX transactions_user_id_occurred_on_idx ON transactions (user_id, occurred_on DESC);

CREATE TRIGGER transactions_touch_updated_at
  BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
