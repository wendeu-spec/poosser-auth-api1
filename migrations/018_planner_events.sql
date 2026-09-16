-- Événements du planner financier : tâches/rendez-vous liés à un flux financier
-- prévu, avec durée de réalisation et statut de validation suite au rappel
-- (§ "planner financier" — rappel 15 min avant début/fin avec bouton de
-- validation réalisé/non réalisé, déjà implémenté côté prototype).
CREATE TABLE planner_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  title            TEXT NOT NULL,
  event_date       DATE NOT NULL,
  event_time       TIME NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  type             TEXT NOT NULL CHECK (type IN ('revenu', 'depense')),
  category         TEXT NOT NULL,
  amount           NUMERIC(14, 2) NOT NULL CHECK (amount > 0),

  status           TEXT NOT NULL DEFAULT 'a_venir' CHECK (status IN ('a_venir', 'realise', 'non_realise')),
  notified_start   BOOLEAN NOT NULL DEFAULT false,
  notified_end     BOOLEAN NOT NULL DEFAULT false,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX planner_events_user_date_idx ON planner_events (user_id, event_date, event_time);

CREATE TRIGGER planner_events_touch_updated_at
  BEFORE UPDATE ON planner_events
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
