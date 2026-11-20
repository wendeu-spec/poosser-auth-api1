-- La caisse de secours devient un compte, au lieu d'une ligne de dépense.
--
-- Défaut corrigé : depuis la migration 034, la caisse de solidarité et les
-- pénalités quittaient le compte de l'utilisateur dans une dépense « Tontine »
-- et disparaissaient. Il ne savait donc jamais ce que la caisse du groupe
-- détient, ni combien il y avait versé depuis le début.
--
-- Le cadre (voir le document « POOSSER — La caisse sociale de tontine ») :
-- une tontine camerounaise distingue deux caisses de nature opposée.
--
--   * la CAISSE DE SECOURS (« Ma'gwa' » en pays bamiléké) est à FONDS PERDUS :
--     on y verse sans jamais récupérer sa mise, et elle verse des DONS à un
--     membre lors d'un événement heureux ou malheureux — décès, mariage,
--     naissance, incendie ;
--   * la BANK (caisse de prêt) PRÊTE avec intérêt, et en fin de cycle on
--     « casse la caisse » : chacun récupère son capital plus sa part des
--     intérêts au prorata.
--
-- Choix validé avec Yannis : on implémente la CAISSE DE SECOURS seule. La
-- bank est une autre mécanique (échéanciers, intérêts, répartition au
-- prorata) et fera l'objet d'une livraison séparée si ses groupes la
-- pratiquent. Rien ici ne lui ferme la porte : ce serait un troisième compte.
--
-- Les six autres points validés :
--   * une caisse PAR GROUPE (chaque tontine a ses règles et ses membres) ;
--   * motifs par défaut : décès, maladie, naissance, mariage, scolarité,
--     incendie, autre — modifiables groupe par groupe ;
--   * les amendes et pénalités alimentent la caisse quand le groupe en a une
--     (usage courant : le censeur les encaisse pour le groupe), et restent une
--     dépense sèche sinon, comme avant ;
--   * le solde de fin d'exercice est REPORTÉ, pas redistribué ;
--   * un secours ne peut pas dépasser ce que la caisse détient ;
--   * un versement à la caisse n'est plus une dépense du mois : l'argent est
--     tracé dans un compte au lieu de disparaître.

-- ---------------------------------------------------------------------------
-- 1. Nouveau type de compte
-- ---------------------------------------------------------------------------
-- Exclu du « disponible » au même titre que la cagnotte (voir
-- OFF_BUDGET_ACCOUNT_TYPES) : cet argent appartient au groupe, pas à
-- l'utilisateur, et il ne peut en sortir que vers un membre.
ALTER TABLE accounts DROP CONSTRAINT accounts_type_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_type_check
  CHECK (type IN ('especes', 'mobile_money', 'banque', 'epargne', 'tontine', 'caisse', 'autre'));

-- ---------------------------------------------------------------------------
-- 2. La caisse du groupe
-- ---------------------------------------------------------------------------
-- NULL tant que le groupe n'a pas eu besoin d'une caisse : le compte est créé
-- PARESSEUSEMENT, au premier mouvement qui l'exige (cotisation sociale,
-- amende, versement libre). Un groupe sans caisse ne se retrouve donc pas avec
-- un compte vide qui encombre la page Comptes.
ALTER TABLE tontines
  ADD COLUMN caisse_account_id UUID REFERENCES accounts(id) ON DELETE RESTRICT,
  -- Motifs de secours propres au groupe. Tableau vide = on applique la liste
  -- par défaut du code (src/services/tontineService.ts), ce qui évite d'avoir
  -- à réécrire toutes les lignes existantes ici et laisse la liste évoluer par
  -- déploiement plutôt que par migration — même principe que PLANS.
  ADD COLUMN secours_motifs TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX tontines_caisse_account_id_idx ON tontines (caisse_account_id);

-- ---------------------------------------------------------------------------
-- 3. La cotisation sociale devient un virement, plus une dépense
-- ---------------------------------------------------------------------------
-- En migration 034, caisse de solidarité et pénalité partaient en UNE dépense
-- (`extra_transaction_id`). Elles deviennent un VIREMENT de mon compte vers la
-- caisse : l'argent est tracé au lieu de disparaître. D'où une colonne
-- dédiée — une dépense et un virement ne sont pas la même chose et ne se
-- défont pas pareil.
--
-- `extra_transaction_id` reste, pour deux usages :
--   * les lignes déjà écrites avant cette migration (des dépenses), qu'on ne
--     réécrit pas ;
--   * le rôle collecteur, où la caisse de solidarité d'un AUTRE membre entre
--     dans la caisse depuis l'extérieur de mes finances — un revenu sur la
--     caisse, pas un virement depuis un de mes comptes.
ALTER TABLE tontine_contributions
  ADD COLUMN extra_transfer_id UUID REFERENCES transfers(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX tontine_contributions_extra_transfer_key
  ON tontine_contributions (extra_transfer_id) WHERE extra_transfer_id IS NOT NULL;

-- Une cotisation non payée ne porte toujours aucun mouvement : la contrainte
-- posée en 034 est remplacée pour couvrir aussi la nouvelle colonne.
ALTER TABLE tontine_contributions
  DROP CONSTRAINT tontine_contributions_unpaid_has_no_money_check;
ALTER TABLE tontine_contributions
  ADD CONSTRAINT tontine_contributions_unpaid_has_no_money_check
  CHECK (paid OR (transfer_id IS NULL AND pot_transaction_id IS NULL
                  AND extra_transaction_id IS NULL AND extra_transfer_id IS NULL));

-- Les extras d'une cotisation prennent UN support, jamais deux.
ALTER TABLE tontine_contributions
  ADD CONSTRAINT tontine_contributions_one_extra_support_check
  CHECK (extra_transaction_id IS NULL OR extra_transfer_id IS NULL);

-- ---------------------------------------------------------------------------
-- 4. Mouvements de la caisse
-- ---------------------------------------------------------------------------
-- Les cotisations sociales et amendes restent rattachées à leur cotisation
-- (tontine_contributions.extra_transaction_id, migration 034) et ne sont PAS
-- journalisées ici : elles ont déjà leur trace, et les dupliquer ferait
-- compter deux fois ce qui est versé.
--
-- Cette table ne porte donc que les mouvements qui n'ont pas d'autre support :
--   versement : un adhérent verse librement à la caisse (aide, maladie...) ;
--   secours   : la caisse verse un don à UN MEMBRE du groupe.
CREATE TABLE tontine_caisse_movements (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tontine_id   UUID NOT NULL REFERENCES tontines(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  kind         TEXT NOT NULL CHECK (kind IN ('versement', 'secours')),
  -- Toujours positif : le sens est porté par `kind`, pas par le signe. Un
  -- montant signé inviterait un client à inverser un secours par erreur.
  amount       NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  -- Motif libre côté base (la liste vit dans le code et dans secours_motifs),
  -- obligatoire pour un secours, facultatif pour un versement.
  motif        TEXT,
  -- Bénéficiaire d'un secours : OBLIGATOIREMENT un membre du groupe. C'est la
  -- règle qui distingue une caisse mutuelle d'un compte d'épargne personnel —
  -- sans elle, la caisse deviendrait une tirelire dans laquelle on puise.
  member_id    UUID REFERENCES tontine_members(id) ON DELETE RESTRICT,

  -- Virement entre un compte réel de l'utilisateur et la caisse, quand c'est
  -- SON argent qui bouge (son versement, ou un secours qu'il reçoit).
  transfer_id  UUID REFERENCES transfers(id) ON DELETE RESTRICT,
  -- Argent du groupe qui entre ou sort de la caisse sans toucher ses comptes
  -- (rôle collecteur : versement d'un autre membre, secours versé à un autre).
  transaction_id UUID REFERENCES transactions(id) ON DELETE RESTRICT,

  occurred_on  DATE NOT NULL,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tontine_caisse_movements_tontine_idx
  ON tontine_caisse_movements (tontine_id, occurred_on DESC, created_at DESC);
CREATE INDEX tontine_caisse_movements_user_idx ON tontine_caisse_movements (user_id, created_at DESC);

CREATE UNIQUE INDEX tontine_caisse_movements_transfer_key
  ON tontine_caisse_movements (transfer_id) WHERE transfer_id IS NOT NULL;
CREATE UNIQUE INDEX tontine_caisse_movements_transaction_key
  ON tontine_caisse_movements (transaction_id) WHERE transaction_id IS NOT NULL;

-- Un secours a forcément son bénéficiaire et son motif ; un versement n'a
-- jamais de bénéficiaire (il va à la caisse, pas à quelqu'un). L'incohérence
-- est impossible, pas seulement improbable.
ALTER TABLE tontine_caisse_movements
  ADD CONSTRAINT tontine_caisse_movements_shape_check
  CHECK (
    (kind = 'secours'   AND member_id IS NOT NULL AND motif IS NOT NULL)
    OR
    (kind = 'versement' AND member_id IS NULL)
  );

-- Un mouvement porte au plus un support d'argent : soit un virement depuis ou
-- vers un compte de l'utilisateur, soit un mouvement interne à la caisse,
-- jamais les deux.
ALTER TABLE tontine_caisse_movements
  ADD CONSTRAINT tontine_caisse_movements_one_support_check
  CHECK (transfer_id IS NULL OR transaction_id IS NULL);

-- Les groupes existants démarrent avec une caisse à zéro. Ce qui a été versé
-- avant cette migration a été enregistré en dépense (migration 034) et le
-- reste : on ne réécrit pas l'historique et on n'invente pas un solde de
-- départ que personne ne connaît. L'utilisateur peut le saisir lui-même en
-- solde d'ouverture du compte s'il le connaît.
