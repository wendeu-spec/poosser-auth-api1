-- Module tontine : un groupe (tontine), ses membres, les cotisations du tour en
-- cours, et l'historique des tours clôturés. Le propriétaire (user_id) est la
-- personne POOSSER qui gère le groupe dans l'app ; les membres eux-mêmes ne sont
-- pas nécessairement des comptes POOSSER (comme dans le prototype : simple liste
-- de noms), pour rester au plus près de l'usage réel d'une tontine existante.
CREATE TABLE tontines (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  name                TEXT NOT NULL,
  contribution_amount NUMERIC(14, 2) NOT NULL CHECK (contribution_amount > 0),
  frequency           TEXT NOT NULL CHECK (frequency IN ('hebdomadaire', 'mensuelle', 'trimestrielle')),
  current_round       INTEGER NOT NULL DEFAULT 1 CHECK (current_round >= 1),

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tontines_user_id_idx ON tontines (user_id);

CREATE TRIGGER tontines_touch_updated_at
  BEFORE UPDATE ON tontines
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Membres du groupe, dans l'ordre de passage (position = ordre de bénéficiaire).
CREATE TABLE tontine_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tontine_id  UUID NOT NULL REFERENCES tontines(id) ON DELETE CASCADE,

  name        TEXT NOT NULL,
  position    INTEGER NOT NULL CHECK (position >= 1),

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX tontine_members_tontine_position_key ON tontine_members (tontine_id, position);
CREATE INDEX tontine_members_tontine_id_idx ON tontine_members (tontine_id);

-- Statut de cotisation d'un membre pour un tour donné du groupe.
CREATE TABLE tontine_contributions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tontine_id    UUID NOT NULL REFERENCES tontines(id) ON DELETE CASCADE,
  member_id     UUID NOT NULL REFERENCES tontine_members(id) ON DELETE CASCADE,
  round_number  INTEGER NOT NULL CHECK (round_number >= 1),

  paid          BOOLEAN NOT NULL DEFAULT false,
  paid_at       TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX tontine_contributions_member_round_key ON tontine_contributions (member_id, round_number);
CREATE INDEX tontine_contributions_tontine_round_idx ON tontine_contributions (tontine_id, round_number);

-- Historique des tours déjà clôturés (bénéficiaire et montant versé).
CREATE TABLE tontine_round_history (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tontine_id            UUID NOT NULL REFERENCES tontines(id) ON DELETE CASCADE,
  round_number          INTEGER NOT NULL CHECK (round_number >= 1),
  beneficiary_member_id UUID NOT NULL REFERENCES tontine_members(id),
  total_amount          NUMERIC(14, 2) NOT NULL CHECK (total_amount > 0),

  closed_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX tontine_round_history_tontine_round_key ON tontine_round_history (tontine_id, round_number);
