-- Une limite mensuelle par catégorie et par utilisateur. UNIQUE(user_id, category)
-- reflète volontairement la sémantique déjà présente dans le prototype : définir
-- une limite sur une catégorie déjà suivie MET À JOUR la limite existante plutôt
-- que d'en créer une seconde (comportement upsert, testé de bout en bout dans le
-- prototype avant cette implémentation serveur).
CREATE TABLE budgets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  category      TEXT NOT NULL,
  monthly_limit NUMERIC(14, 2) NOT NULL CHECK (monthly_limit > 0),

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX budgets_user_category_key ON budgets (user_id, category);

CREATE TRIGGER budgets_touch_updated_at
  BEFORE UPDATE ON budgets
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
