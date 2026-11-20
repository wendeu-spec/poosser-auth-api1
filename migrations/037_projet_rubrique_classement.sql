-- Dans un projet, la rubrique REMPLACE la catégorie.
--
-- Défaut signalé par Yannis : « lors de la saisie d'une opération, c'est la
-- rubrique qui devait remplacer les catégories. Or ce sont les catégories des
-- opérations générales qui s'affichent. »
--
-- Il a raison, et la décision avait déjà été prise à moitié. Le Budget exclut
-- les mouvements de projet depuis un changement validé plus tôt (voir le
-- commentaire de spentByCategory), et la vue Projets l'affiche à l'écran :
-- « exclus du Budget par catégorie — suivi séparément ici ». Mais la colonne
-- `category` est NOT NULL depuis la migration 014 : quand les rubriques sont
-- arrivées (migration 020), elles ont été ajoutées comme une étiquette EN PLUS,
-- jamais À LA PLACE. Le formulaire réclamait donc les deux.
--
-- Pire, l'exclusion n'était appliquée qu'à moitié : la catégorie d'une dépense
-- de projet était ignorée par le Budget et le donut, mais comptée par les
-- analyses « telle catégorie concentre vos dépenses », la catégorie dominante
-- du résumé hebdomadaire, la volatilité par catégorie et la détection
-- d'anomalies. La même dépense était hors-catégorie sur un écran et
-- dans-catégorie sur un autre.
--
-- Yannis a demandé une analyse avant toute correction, puis validé ce qui
-- suit :
--   * dès qu'un projet est choisi, le champ Catégorie disparaît — on ne range
--     pas un poste de chantier dans la liste des catégories personnelles, et
--     l'opération n'a alors plus de catégorie du tout ;
--   * la Rubrique n'est pour autant JAMAIS obligatoire : sans elle,
--     l'opération est « Non classé ». Bloquer la saisie ferait perdre une
--     dépense notée dans l'urgence sur un chantier, et serait de toute façon
--     incohérent avec la suppression d'une rubrique, qui produit déjà
--     exactement cet état ;
--   * la comparaison que la catégorie permettait (« combien de main d'œuvre
--     sur mes trois chantiers ? ») revient par une vue dédiée dans Projets, qui
--     regroupe les rubriques de même nom ;
--   * l'exclusion des dépenses de projet, jusqu'ici appliquée au seul Budget,
--     l'est désormais à toutes les analyses par catégorie.
--
-- Au moment de cette migration, Yannis avait 3 projets, 19 rubriques et AUCUNE
-- opération de projet : il n'y a donc rien à reclasser dans ses données. Le
-- bloc de normalisation ci-dessous existe pour les autres comptes.

-- ---------------------------------------------------------------------------
-- 1. La catégorie devient facultative
-- ---------------------------------------------------------------------------
ALTER TABLE transactions ALTER COLUMN category DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Normalisation des lignes déjà saisies
-- ---------------------------------------------------------------------------
-- Une opération de projet qui porte DÉJÀ une rubrique est classée : sa
-- catégorie devient inutile et part. Celle qui n'en a pas est laissée telle
-- quelle — on ne devine pas une rubrique, et sa catégorie reste son seul
-- classement jusqu'à ce que l'utilisateur la range.
UPDATE transactions
   SET category = NULL
 WHERE project_id IS NOT NULL
   AND rubrique_id IS NOT NULL
   AND category IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Les favoris suivent la même règle
-- ---------------------------------------------------------------------------
-- Un favori est un gabarit d'opération : « ☆ Favori » sur une opération de
-- projet en recopie le type, le montant, le projet et la rubrique. Sa colonne
-- `category` étant NOT NULL depuis la migration 022, enregistrer en favori une
-- opération de projet — désormais sans catégorie — échouait.
--
-- Trouvé en relisant ce changement, pas par un test : le cas n'était couvert
-- nulle part.
ALTER TABLE transaction_favorites ALTER COLUMN category DROP NOT NULL;

UPDATE transaction_favorites
   SET category = NULL
 WHERE project_id IS NOT NULL
   AND rubrique_id IS NOT NULL
   AND category IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Pas de contrainte « toujours classée », et c'est délibéré
-- ---------------------------------------------------------------------------
-- Une contrainte CHECK (category IS NOT NULL OR rubrique_id IS NOT NULL) a été
-- écrite ici, puis retirée : un test l'a prise en défaut.
--
-- Supprimer une rubrique DÉTACHE ses opérations sans les effacer — c'est le
-- comportement voulu depuis la migration 020 (ON DELETE SET NULL) et testé
-- comme tel. Une opération de projet se retrouve alors légitimement sans
-- rubrique ET sans catégorie. Ce n'est pas une anomalie : la vue Projets gère
-- cet état depuis toujours, avec un libellé « Non classé » dans le tableau et
-- son propre segment dans le donut de répartition, dont le total doit
-- justement continuer de correspondre exactement au total dépensé.
--
-- La contrainte aurait donc transformé une suppression de rubrique parfaitement
-- normale en erreur 500. La règle « projet ⇒ rubrique » est la bonne règle de
-- SAISIE, et elle est appliquée par transactionService.resolveClassement() à
-- chaque création et chaque modification ; elle n'est pas un invariant
-- permanent de la donnée.
