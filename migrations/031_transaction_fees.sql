-- Frais d'une opération (revenu ou dépense) : Mobile Money, banque...
--
-- Choix validé avec Yannis : les frais restent une VRAIE dépense (catégorie
-- « Frais Mobile Money », « Frais bancaires » ou « Frais » selon le type de
-- compte), mais liée à l'opération qui les a causés. Ainsi tous les calculs
-- existants (soldes, totaux, budget, graphiques, exports, assistant) les
-- comptent sans changement, et l'opération et ses frais se modifient ou se
-- suppriment ensemble (comme les frais d'un virement, voir migration 029).
--
-- fee_parent_id : l'opération dont cette dépense est le frais. Supprimer
-- l'opération supprime ses frais (CASCADE). Une opération a au plus UN frais
-- (index unique). Une ligne ne peut pas être à la fois le frais d'un virement
-- et le frais d'une opération.
ALTER TABLE transactions
  ADD COLUMN fee_parent_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  ADD CONSTRAINT transactions_single_fee_link CHECK (fee_parent_id IS NULL OR transfer_id IS NULL),
  ADD CONSTRAINT transactions_fee_not_self CHECK (fee_parent_id IS NULL OR fee_parent_id <> id);

CREATE UNIQUE INDEX transactions_one_fee_per_parent ON transactions (fee_parent_id) WHERE fee_parent_id IS NOT NULL;

-- Rattachement des frais déjà saisis séparément (par l'import de SMS de la
-- maj18/19, dont la note est « Frais · <note de l'opération> ») : uniquement
-- quand il n'existe qu'UNE opération possible — même utilisateur, même
-- compte, même date, et la note (ou à défaut la catégorie) correspondante.
-- Les montants ne changent pas, donc aucun solde ne bouge. En cas de doute,
-- la dépense de frais reste simplement séparée, comme avant.
WITH fees AS (
  SELECT f.id, f.user_id, f.account_id, f.occurred_on, substring(f.note FROM 9) AS parent_label
  FROM transactions f
  WHERE f.transfer_id IS NULL
    AND f.fee_parent_id IS NULL
    AND f.type = 'depense'
    AND f.category IN ('Frais Mobile Money', 'Frais bancaires', 'Frais')
    AND f.note LIKE 'Frais · %'
),
candidates AS (
  SELECT fees.id AS fee_id, p.id AS parent_id,
         count(*) OVER (PARTITION BY fees.id) AS parents_for_fee,
         count(*) OVER (PARTITION BY p.id) AS fees_for_parent
  FROM fees
  JOIN transactions p
    ON p.user_id = fees.user_id
   AND p.account_id = fees.account_id
   AND p.occurred_on = fees.occurred_on
   AND p.id <> fees.id
   AND p.transfer_id IS NULL
   AND p.fee_parent_id IS NULL
   AND p.category NOT IN ('Frais Mobile Money', 'Frais bancaires', 'Frais')
   AND (p.note = fees.parent_label OR (p.note IS NULL AND p.category = fees.parent_label))
)
UPDATE transactions t
SET fee_parent_id = c.parent_id
FROM candidates c
WHERE t.id = c.fee_id
  AND c.parents_for_fee = 1
  AND c.fees_for_parent = 1;
