-- La tontine cesse d'être une simple liste de pointage.
--
-- Défaut corrigé : markContribution() ne faisait que basculer un booléen et
-- closeRound() n'écrivait qu'une ligne d'historique. Aucun compte débité,
-- aucune opération créée — jamais. Sur « COEUR JOYEUX » (14 membres,
-- 50 000 FCFA/mois), cela voulait dire 50 000 FCFA qui sortent chaque mois
-- sans trace, et 700 000 FCFA encaissés au tour du propriétaire sans trace non
-- plus. Un cycle entier, 700 000 dans chaque sens, totalement invisible.
--
-- Choix validés avec Yannis :
--
--   1. UNE TONTINE EST UN COMPTE. Type dédié `tontine`, créé avec le groupe.
--      Son solde dit la position réelle vis-à-vis du groupe.
--
--   2. COTISER ET ENCAISSER SONT DES VIREMENTS NEUTRES, pas des dépenses ni
--      des revenus. C'est le point important : les 700 000 encaissés au tour
--      du propriétaire ne sont PAS un revenu, c'est son propre argent qui
--      revient, versé 50 000 à la fois. Les enregistrer en revenu ferait
--      passer son mois de ~102 500 à ~802 500 FCFA et fausserait le score de
--      santé, les moyennes sur 3 mois, l'autonomie et les projections pendant
--      tout un cycle — exactement le genre de mensonge que la migration 033
--      vient de corriger pour l'épargne.
--
--      Vérification arithmétique : 14 cotisations de 50 000 font +700 000 sur
--      le compte de la tontine ; l'encaissement du tour 4 fait −700 000. Le
--      compte retombe EXACTEMENT à zéro en fin de cycle. Entre les deux, son
--      solde est négatif : c'est ce qui reste dû au groupe (−500 000 juste
--      après avoir encaissé, au tour 4 sur 14). C'est la preuve que le modèle
--      est juste.
--
--   3. LA CAISSE DE SOLIDARITÉ ET LES PÉNALITÉS SONT DE VRAIES DÉPENSES
--      (catégorie « Tontine »), pas des virements : cet argent-là ne revient
--      jamais. S'il transitait par le compte de la tontine, celui-ci ne
--      retomberait pas à zéro en fin de cycle et la vérification ci-dessus
--      serait perdue.
--
--   4. DEUX RÔLES, réglables par groupe :
--        * participant : seules MES deux opérations touchent mes comptes ;
--          les autres membres restent un pointage.
--        * collecteur  : j'encaisse l'argent de tous et je le remets au
--          bénéficiaire. L'argent des AUTRES entre dans la cagnotte depuis
--          l'extérieur de mes finances : c'est un revenu/dépense SUR le compte
--          de la tontine, jamais un virement depuis un de mes comptes.
--
-- Un compte de type `tontine` est exclu du « disponible » : pour un
-- participant son solde est une créance qu'il ne peut pas dépenser, pour un
-- collecteur c'est l'argent du groupe qu'il détient sans qu'il lui appartienne.
-- Dans les deux cas, l'ajouter au disponible serait faux. Il est affiché sur sa
-- propre ligne, comme la part réservée de l'épargne.

-- ---------------------------------------------------------------------------
-- 1. Nouveau type de compte
-- ---------------------------------------------------------------------------
ALTER TABLE accounts DROP CONSTRAINT accounts_type_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_type_check
  CHECK (type IN ('especes', 'mobile_money', 'banque', 'epargne', 'tontine', 'autre'));

-- ---------------------------------------------------------------------------
-- 2. Configuration du groupe
-- ---------------------------------------------------------------------------
ALTER TABLE tontines
  -- Cagnotte du groupe. ON DELETE RESTRICT comme partout ailleurs : un compte
  -- qui porte des mouvements ne se supprime pas, il s'archive.
  ADD COLUMN account_id        UUID REFERENCES accounts(id) ON DELETE RESTRICT,
  -- Quel membre de la liste est l'utilisateur lui-même. NULL = pas encore
  -- désigné : le groupe reste alors un simple pointage, sans mouvement
  -- d'argent, exactement comme avant cette migration.
  ADD COLUMN my_member_id      UUID REFERENCES tontine_members(id) ON DELETE SET NULL,
  ADD COLUMN role              TEXT NOT NULL DEFAULT 'participant'
                               CHECK (role IN ('participant', 'collecteur')),
  -- Extras facultatifs (0 = le groupe n'en a pas). Vraies dépenses, voir
  -- le point 3 ci-dessus.
  ADD COLUMN late_fee          NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (late_fee >= 0),
  ADD COLUMN solidarity_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (solidarity_amount >= 0);

CREATE INDEX tontines_account_id_idx ON tontines (account_id);

-- ---------------------------------------------------------------------------
-- 3. Mouvements rattachés à une cotisation
-- ---------------------------------------------------------------------------
-- Décocher une cotisation doit DÉFAIRE l'argent qu'elle a créé, sinon un clic
-- malheureux laisse un virement fantôme. On garde donc le lien vers chaque
-- mouvement produit, et markContribution(paid=false) les supprime.
--
-- ON DELETE RESTRICT : supprimer le virement ou l'opération par la porte des
-- comptes laisserait la cotisation cochée en face de rien. Le service renvoie
-- un refus explicite et renvoie vers le module Tontine.
ALTER TABLE tontine_contributions
  -- Ma propre cotisation : virement de mon compte vers la cagnotte.
  ADD COLUMN transfer_id        UUID REFERENCES transfers(id) ON DELETE RESTRICT,
  -- Collecteur : l'argent d'un AUTRE membre entrant dans la cagnotte.
  ADD COLUMN pot_transaction_id UUID REFERENCES transactions(id) ON DELETE RESTRICT,
  -- Pénalité de retard + caisse de solidarité, en une dépense réelle.
  ADD COLUMN extra_transaction_id UUID REFERENCES transactions(id) ON DELETE RESTRICT,
  -- Cotisation payée en retard : déclenche la pénalité si le groupe en a une.
  ADD COLUMN late               BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX tontine_contributions_transfer_key
  ON tontine_contributions (transfer_id) WHERE transfer_id IS NOT NULL;
CREATE UNIQUE INDEX tontine_contributions_pot_tx_key
  ON tontine_contributions (pot_transaction_id) WHERE pot_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX tontine_contributions_extra_tx_key
  ON tontine_contributions (extra_transaction_id) WHERE extra_transaction_id IS NOT NULL;

-- Une cotisation non payée ne porte aucun mouvement : l'incohérence est
-- impossible, pas seulement improbable.
ALTER TABLE tontine_contributions
  ADD CONSTRAINT tontine_contributions_unpaid_has_no_money_check
  CHECK (paid OR (transfer_id IS NULL AND pot_transaction_id IS NULL AND extra_transaction_id IS NULL));

-- ---------------------------------------------------------------------------
-- 4. Mouvements rattachés à la clôture d'un tour
-- ---------------------------------------------------------------------------
ALTER TABLE tontine_round_history
  -- Le bénéficiaire, c'est moi : virement de la cagnotte vers mon compte.
  ADD COLUMN transfer_id          UUID REFERENCES transfers(id) ON DELETE RESTRICT,
  -- Collecteur, bénéficiaire quelqu'un d'autre : la cagnotte sort de mes
  -- finances pour de bon.
  ADD COLUMN payout_transaction_id UUID REFERENCES transactions(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX tontine_round_history_transfer_key
  ON tontine_round_history (transfer_id) WHERE transfer_id IS NOT NULL;
CREATE UNIQUE INDEX tontine_round_history_payout_tx_key
  ON tontine_round_history (payout_transaction_id) WHERE payout_transaction_id IS NOT NULL;

-- Les tontines déjà existantes gardent account_id et my_member_id à NULL :
-- elles continuent de fonctionner comme un pointage jusqu'à ce que
-- l'utilisateur les configure. Aucune donnée n'est réécrite, aucun mouvement
-- n'est inventé rétroactivement — on ne devine pas ce qui a été payé ni depuis
-- quel compte.
