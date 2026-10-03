-- La modification d'une tontine (nom, cotisation, fréquence — voir
-- PATCH /api/tontines/:id) a besoin de mettre à jour `tontines.updated_at`
-- (trigger `touch_updated_at`, déclenché sur tout UPDATE, sans condition).
-- Or `currentRoundStartedAt` réutilisait jusqu'ici `updated_at` comme "date de
-- début du tour en cours" (voir migrations/017_tontines.sql et
-- tontineService.loadTontineView) : éditer une tontine aurait donc
-- silencieusement réinitialisé l'échéance de cotisation affichée au client.
-- On introduit donc une colonne dédiée, détachée de toute autre écriture,
-- que seules la création et la clôture de tour font avancer.
ALTER TABLE tontines ADD COLUMN round_started_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Backfill : pour les tontines existantes, `updated_at` représentait déjà
-- fidèlement le début du tour en cours (création ou dernière clôture).
UPDATE tontines SET round_started_at = updated_at;
