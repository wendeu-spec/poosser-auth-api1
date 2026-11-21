-- Le module Projet sert trois natures très différentes avec un seul modèle.
--
-- Constat de l'analyse demandée par Yannis (voir « POOSSER — Quelles
-- statistiques dans Projets et Tontine »). Ses trois projets :
--
--   * Construction de la dépendance — un CHANTIER : que des dépenses, par
--     phases. Son « objectif » de 1 000 000 est un budget à ne pas dépasser ;
--     l'atteindre à 100 % est une mauvaise nouvelle.
--   * Pâtes d'arachide Belgique — un LOT DE PRODUCTION : il achète, transforme
--     et vend. La question n'est pas le budget mais la marge.
--   * Boutique de vente produits IT — un LANCEMENT : investir avant d'ouvrir,
--     puis mesurer le retour sur investissement.
--
-- Un seul chiffre « objectif », trois significations opposées. C'est ce qui
-- faisait afficher « Progression : 0 % » sur un chantier quoi qu'on dépense
-- (corrigé en maj29, par détection implicite).
--
-- Décisions validées avec Yannis :
--
--   1. PAS DE MENU « nature du projet » à remplir. POOSSER reconnaît un
--      archétype depuis le nom et PROPOSE la nature et une liste de rubriques
--      — sur le modèle de la proposition de budget mensuel (migration 028) :
--      proposer, jamais décider en silence. D'où une colonne `kind`
--      NULLABLE : NULL = on applique l'heuristique (un projet qui n'a jamais
--      rien encaissé est un projet de dépense), une valeur = l'utilisateur ou
--      l'archétype qu'il a accepté a tranché.
--
--   2. LE PRIX DE REVIENT tient en deux nombres et une case à cocher. Les
--      coûts sont déjà saisis sous forme de rubriques ; il ne manque que la
--      quantité produite, le prix de vente unitaire, et le moyen de distinguer
--      le coût d'achat des FRAIS D'APPROCHE (transport, emballage, manutention
--      pour amener la marchandise à destination). Tout le reste se déduit.
--
--      Limite posée explicitement : pas de stock, pas de facturation, pas de
--      TVA, pas d'amortissements. POOSSER reste une application de finances
--      personnelles.
--
--   3. LES VENTES EN EUROS se convertissent à la PARITÉ FIXE. Le franc CFA
--      d'Afrique centrale est arrimé à l'euro à 1 € = 655,957, et cet
--      arrimage est toujours en vigueur. Ce n'est pas un cours qui bouge : la
--      constante vit dans le code, pas en base. La colonne `exchange_rate`
--      ci-dessous ne sert qu'au cas du changeur informel, dont le taux diffère
--      de la parité officielle ; NULL = parité.
--
--      Ce qui varie réellement, c'est la commission du transfert — et elle a
--      déjà son champ « Frais » depuis la migration 031.

-- ---------------------------------------------------------------------------
-- 1. Nature du projet
-- ---------------------------------------------------------------------------
ALTER TABLE projects
  ADD COLUMN kind TEXT CHECK (kind IS NULL OR kind IN ('depense', 'activite'));

COMMENT ON COLUMN projects.kind IS
  'NULL = déduit des mouvements (aucun encaissement ⇒ depense). Renseigné quand l''utilisateur a accepté un archétype ou choisi explicitement.';

-- ---------------------------------------------------------------------------
-- 2. Prix de revient et marge
-- ---------------------------------------------------------------------------
ALTER TABLE projects
  -- Fractionnaire : on produit aussi des kilos, des litres ou des mètres.
  ADD COLUMN quantity_produced NUMERIC(14, 3) CHECK (quantity_produced IS NULL OR quantity_produced > 0),
  ADD COLUMN unit_price        NUMERIC(14, 2) CHECK (unit_price IS NULL OR unit_price > 0),
  -- Devise dans laquelle le prix de vente est exprimé. Les montants restent
  -- enregistrés en monnaie de l'utilisateur : ses coûts le sont, et une marge
  -- ne se calcule pas entre deux devises.
  ADD COLUMN sale_currency     TEXT NOT NULL DEFAULT 'XAF'
                               CHECK (sale_currency IN ('XAF', 'XOF', 'EUR', 'USD', 'GBP', 'CAD')),
  -- Uniquement pour un taux qui s'écarte de la parité officielle (changeur
  -- informel). NULL = parité fixe appliquée par le code.
  ADD COLUMN exchange_rate     NUMERIC(12, 4) CHECK (exchange_rate IS NULL OR exchange_rate > 0);

-- ---------------------------------------------------------------------------
-- 3. Frais d'approche
-- ---------------------------------------------------------------------------
-- Une rubrique marquée ainsi compte dans le prix de revient mais pas dans le
-- coût d'achat. Chez Yannis : Transport, Emballage et Cartonnerie amènent les
-- pâtes d'arachide jusqu'en Belgique ; l'arachide elle-même est le coût
-- d'achat. Une case à cocher sur une rubrique existante, pas un concept de
-- plus.
ALTER TABLE rubriques
  ADD COLUMN is_landed_cost BOOLEAN NOT NULL DEFAULT false;

-- Rien à migrer : aucun projet existant n'a de quantité ni de prix de vente,
-- et aucune rubrique n'est un frais d'approche tant que l'utilisateur ne l'a
-- pas dit. `kind` reste NULL partout, donc l'heuristique de maj29 continue de
-- s'appliquer telle quelle.
