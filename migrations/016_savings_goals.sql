-- Objectifs d'épargne (module "Épargne" du prototype).
CREATE TABLE savings_goals (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  name           TEXT NOT NULL,
  target_amount  NUMERIC(14, 2) NOT NULL CHECK (target_amount > 0),
  current_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (current_amount >= 0),
  deadline       DATE,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX savings_goals_user_id_idx ON savings_goals (user_id);

CREATE TRIGGER savings_goals_touch_updated_at
  BEFORE UPDATE ON savings_goals
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
