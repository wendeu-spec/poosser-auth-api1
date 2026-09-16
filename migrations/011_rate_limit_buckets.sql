-- Compteurs de limitation de débit à fenêtre fixe. Remplace un Redis absent de cet
-- environnement ; l'interface applicative (src/services/rateLimiter.ts) est écrite pour
-- pouvoir être ré-implémentée sur Redis plus tard sans changer les appelants.
CREATE TABLE rate_limit_buckets (
  key           TEXT NOT NULL,
  window_start  TIMESTAMPTZ NOT NULL,
  count         INT NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);

-- Permet de purger facilement les vieilles fenêtres (tâche de maintenance périodique).
CREATE INDEX rate_limit_buckets_window_idx ON rate_limit_buckets (window_start);
