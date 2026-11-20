-- Deux corrections demandées par Yannis après usage réel de COEUR JOYEUX
-- (14 membres, 50 000 FCFA, rôle collecteur).
--
-- 1. LA CAISSE DE SOLIDARITÉ NE SE VERSE QU'UNE FOIS PAR CYCLE COMPLET.
--    Elle était prélevée à CHAQUE tour. Dans son groupe, un membre bénéficie
--    par mois et il y a 14 membres : la cotisation sociale se verse donc tous
--    les 14 mois, pas tous les mois. La règle vit dans le code
--    (tontineService.isFirstRoundOfCycle) et non ici : un cycle fait autant de
--    tours qu'il y a de membres, et le nombre de membres peut changer.
--    Rien à migrer pour ce point.
--
-- 2. RÉPARATION DES DONNÉES LAISSÉES PAR LA VERSION maj25.
--    Jusqu'à la migration 035, le rôle collecteur faisait entrer la cotisation
--    d'un autre membre ET sa caisse de solidarité ET sa pénalité dans la
--    CAGNOTTE, en une seule écriture. La cagnotte encaissait donc une
--    solidarité qu'elle ne reversait jamais : elle ne retombait plus à zéro en
--    fin de cycle, ce qui est précisément la vérification censée prouver que le
--    modèle est juste.
--
--    Sur les données de Yannis au 20 novembre 2026, cela représentait
--    69 000 FCFA bloqués dans la cagnotte de COEUR JOYEUX (13 membres × 5 000
--    de caisse, plus 2 × 2 000 de pénalité) après deux tours complets.
--
--    Ce bloc sépare rétroactivement ces écritures : la cagnotte ne garde que la
--    cotisation, le reste part dans la caisse, où il aurait dû aller. Aucun
--    montant n'est créé ni détruit — on déplace, et le total reste identique.
--
--    Conservateur à dessein : ne sont touchées que les lignes dont le montant
--    encaissé DÉPASSE la cotisation du groupe et qui n'ont pas déjà leur
--    écriture de caisse. Relancer ce bloc ne ferait donc rien de plus.

DO $$
DECLARE
  c          RECORD;
  caisse     UUID;
  diff       NUMERIC(14, 2);
  nouvelle   UUID;
  suffixe    INT;
  candidat   TEXT;
BEGIN
  FOR c IN
    SELECT tc.id            AS contribution_id,
           tc.tontine_id,
           tc.pot_transaction_id,
           tx.amount        AS montant_encaisse,
           tx.occurred_on,
           tx.note,
           t.contribution_amount,
           t.user_id,
           t.name           AS nom_tontine
      FROM tontine_contributions tc
      JOIN transactions tx ON tx.id = tc.pot_transaction_id
      JOIN tontines     t  ON t.id  = tc.tontine_id
     WHERE tc.pot_transaction_id IS NOT NULL
       AND tc.extra_transaction_id IS NULL
       AND tx.amount > t.contribution_amount
  LOOP
    diff := c.montant_encaisse - c.contribution_amount;

    -- Relu à CHAQUE tour de boucle, et non pris dans la requête ci-dessus :
    -- la caisse créée pour la première ligne doit servir aux suivantes, or le
    -- curseur travaille sur un instantané pris avant la boucle.
    SELECT caisse_account_id INTO caisse FROM tontines WHERE id = c.tontine_id;

    IF caisse IS NULL THEN
      suffixe := 0;
      LOOP
        candidat := CASE WHEN suffixe = 0
                         THEN 'Caisse ' || c.nom_tontine
                         ELSE 'Caisse ' || c.nom_tontine || ' (' || (suffixe + 1) || ')' END;
        BEGIN
          INSERT INTO accounts (user_id, name, type)
          VALUES (c.user_id, candidat, 'caisse')
          RETURNING id INTO caisse;
          EXIT;
        EXCEPTION WHEN unique_violation THEN
          suffixe := suffixe + 1;
          IF suffixe > 20 THEN
            RAISE EXCEPTION 'Impossible de nommer la caisse du groupe %', c.nom_tontine;
          END IF;
        END;
      END LOOP;
      UPDATE tontines SET caisse_account_id = caisse WHERE id = c.tontine_id;
    END IF;

    -- La cagnotte ne garde que la cotisation.
    UPDATE transactions SET amount = c.contribution_amount WHERE id = c.pot_transaction_id;

    -- Le reste rejoint la caisse, à la même date, avec une note qui dit d'où
    -- il vient. Si la note ne suit pas la forme attendue, replace() la laisse
    -- intacte plutôt que d'inventer un libellé.
    INSERT INTO transactions (user_id, type, category, amount, occurred_on, method, note, account_id)
    VALUES (c.user_id, 'revenu', 'Tontine', diff, c.occurred_on, 'Espèces',
            replace(c.note, '— cotisation de', '— caisse de solidarité de'), caisse)
    RETURNING id INTO nouvelle;

    UPDATE tontine_contributions SET extra_transaction_id = nouvelle WHERE id = c.contribution_id;
  END LOOP;
END $$;
