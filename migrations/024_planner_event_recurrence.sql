-- Récurrence optionnelle d'un événement du planner (paiement/encaissement qui
-- revient régulièrement : loyer, abonnement, cotisation...). NULL = événement
-- ponctuel, comportement inchangé pour tous les événements existants. Quand un
-- événement récurrent est validé ("Réalisé"), la prochaine occurrence est
-- créée automatiquement à la date suivante (voir
-- plannerEventService.setPlannerEventStatus / nextOccurrenceDate) — pas besoin
-- de la ressaisir à chaque fois.
ALTER TABLE planner_events
  ADD COLUMN recurrence TEXT CHECK (recurrence IN ('hebdomadaire', 'mensuelle', 'trimestrielle'));
