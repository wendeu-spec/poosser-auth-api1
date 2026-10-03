-- Catégories personnalisées, en complément de la liste fixe définie dans
-- src/lib/categories.ts (Alimentation, Transport, Salaire, ...). Décision
-- produit : une catégorie personnalisée s'applique aussi bien aux dépenses
-- qu'aux revenus (pas de distinction à la création, pour rester simple) —
-- voir createCategorySchema. Comme pour budgets.category/transactions.category,
-- c'est une simple chaîne, sans contrainte CHECK ni table de jonction : la
-- supprimer plus tard ne touchera donc jamais l'historique déjà enregistré
-- (transactions/budgets/événements planner qui l'utilisent gardent le nom tel
-- quel, exactement comme une catégorie de base jamais recensée nulle part).
CREATE TABLE categories (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  name       TEXT NOT NULL,
  color      TEXT NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Insensible à la casse pour éviter "Abonnements" et "abonnements" comme
-- deux catégories distinctes créées par erreur (categoryService.createCategory
-- fait la même vérification avant insertion, cet index est le filet de
-- sécurité côté base en cas de requêtes concurrentes).
CREATE UNIQUE INDEX categories_user_name_key ON categories (user_id, lower(name));
