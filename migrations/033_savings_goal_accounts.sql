-- L'épargne cesse d'être de l'argent créé à partir de rien.
--
-- Défaut corrigé : jusqu'ici « + Verser » n'augmentait que
-- savings_goals.current_amount. Aucun compte n'était débité, aucune opération
-- n'était créée. Le tableau de bord affichait donc côte à côte un « solde
-- disponible » (somme des comptes) et une « épargne totale » comme deux poches
-- distinctes, alors que l'argent épargné était toujours DANS les comptes : le
-- même argent était compté deux fois.
--
-- Choix validés avec Yannis :
--   * un objectif est rattaché à un COMPTE HÔTE (account_id) : l'endroit où
--     l'argent épargné se trouve réellement ;
--   * current_amount devient une RÉSERVATION sur ce compte — une part du solde
--     mise de côté, pas une poche supplémentaire. D'où l'invariant appliqué par
--     savingsGoalService : pour un compte donné, la somme des réservations ne
--     peut jamais dépasser son solde ;
--   * à chaque versement, l'utilisateur choisit :
--       - « l'argent est déjà sur ce compte »  → simple réservation, rien ne
--         bouge (c'est l'épargne informelle : espèces gardées à la maison,
--         argent laissé sur MoMo) ;
--       - « je le déplace depuis tel compte » → VRAI virement vers le compte
--         hôte, visible dans l'historique, frais compris (transfer_id).
--     Les deux cas existent réellement au Cameroun ; n'en autoriser qu'un
--     rendrait l'application fausse pour l'autre moitié des usages.
--
-- Corollaire : une réservation doit pouvoir être relâchée, sinon l'argent est
-- piégé et le « disponible » baisse définitivement. D'où les montants SIGNÉS
-- dans le journal (voir plus bas).

-- ---------------------------------------------------------------------------
-- 1. Compte hôte de l'objectif
-- ---------------------------------------------------------------------------
-- ON DELETE RESTRICT, comme transactions.account_id : un compte qui porte une
-- réservation ne se supprime pas, il s'archive.
ALTER TABLE savings_goals ADD COLUMN account_id UUID REFERENCES accounts(id) ON DELETE RESTRICT;

-- Backfill : le compte « Espèces » de l'utilisateur en priorité (c'est là que
-- se trouve réellement l'épargne déjà saisie — choix explicite de Yannis pour
-- ses 165 000 FCFA de « FOND DE SECOURS »), sinon son plus ancien compte actif,
-- avec le même ordre de tri que accountService.ensureDefaultAccount.
UPDATE savings_goals g
   SET account_id = (
     SELECT a.id FROM accounts a
      WHERE a.user_id = g.user_id AND a.archived = false
      ORDER BY (a.type = 'especes') DESC, a.created_at ASC, a.id ASC
      LIMIT 1
   )
 WHERE g.account_id IS NULL;

-- La colonne reste NULLABLE à dessein : un utilisateur sans aucun compte actif
-- (cas théorique mais possible) ne doit pas faire échouer la migration. Le
-- rattachement est exigé côté service à la création et au versement, et
-- l'interface signale un objectif non rattaché au lieu de l'ignorer.
CREATE INDEX savings_goals_account_id_idx ON savings_goals (account_id);

-- ---------------------------------------------------------------------------
-- 2. Journal des mouvements d'épargne
-- ---------------------------------------------------------------------------
-- Les montants deviennent SIGNÉS : positif = versement, négatif = retrait.
-- Un journal qui n'accepterait que des versements ne permettrait pas de
-- relâcher une réservation, et la réservation serait un piège à sens unique.
ALTER TABLE savings_goal_contributions DROP CONSTRAINT savings_goal_contributions_amount_check;
ALTER TABLE savings_goal_contributions
  ADD CONSTRAINT savings_goal_contributions_amount_check CHECK (amount <> 0);

-- Provenance du mouvement :
--   reservation : rien n'a bougé entre les comptes, seule la part réservée
--                 du compte hôte change ;
--   virement    : un vrai virement a eu lieu (transfer_id renseigné), du
--                 compte source vers le compte hôte pour un versement, du
--                 compte hôte vers le compte de destination pour un retrait.
ALTER TABLE savings_goal_contributions
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'reservation' CHECK (kind IN ('reservation', 'virement'));

-- Les lignes déjà présentes sont bien des réservations : à l'époque, aucun
-- versement ne déplaçait d'argent. Le DEFAULT n'a servi qu'à elles ; on le
-- retire pour que tout nouvel enregistrement doive déclarer sa provenance
-- explicitement (un oubli devient une erreur NOT NULL bruyante, pas une
-- réservation silencieuse).
ALTER TABLE savings_goal_contributions ALTER COLUMN kind DROP DEFAULT;

-- ON DELETE RESTRICT et non CASCADE : supprimer le virement effacerait la
-- ligne de journal SANS corriger la réservation de l'objectif, qui resterait
-- figée. accountService.deleteTransfer refuse donc explicitement un virement
-- qui adosse un mouvement d'épargne (TRANSFER_BACKS_SAVINGS) et renvoie
-- l'utilisateur vers le module Épargne.
ALTER TABLE savings_goal_contributions
  ADD COLUMN transfer_id UUID REFERENCES transfers(id) ON DELETE RESTRICT;

-- Un virement n'adosse qu'un seul mouvement d'épargne.
CREATE UNIQUE INDEX savings_goal_contributions_transfer_key
  ON savings_goal_contributions (transfer_id)
  WHERE transfer_id IS NOT NULL;

-- Un mouvement « virement » a forcément son virement, un mouvement
-- « reservation » n'en a jamais : l'incohérence est impossible, pas seulement
-- improbable.
ALTER TABLE savings_goal_contributions
  ADD CONSTRAINT savings_goal_contributions_kind_transfer_check
  CHECK ((kind = 'virement') = (transfer_id IS NOT NULL));
