-- Imbrication des rubriques : une rubrique peut avoir une rubrique parente,
-- à n'importe quelle profondeur (ex: Transport > Billets d'avion, ou même
-- Transport > Billets d'avion > Vol long-courrier si besoin). Demandé par
-- l'utilisateur pour affiner le suivi des projets (voyage, construction...).
--
-- Choix structurants validés avec l'utilisateur :
--   - Profondeur illimitée (pas de limite à 1 ou 2 niveaux).
--   - Une dépense peut toujours être rattachée directement à une rubrique
--     qui a elle-même des sous-rubriques (ex: un taxi tagué sur "Transport"
--     même si "Billets d'avion" existe comme sous-rubrique) — le total de
--     "Transport" additionne alors sa propre dépense directe ET celles de
--     toutes ses sous-rubriques, à tout niveau.
--
-- ON DELETE SET NULL (comme project_id/rubrique_id sur transactions) : c'est
-- un filet de sécurité au niveau base de données. Le comportement normal
-- attendu (ré-attacher les enfants directs à LEUR grand-parent au lieu de
-- les faire remonter d'un coup tout en haut) est géré explicitement dans
-- rubriqueService.deleteRubrique(), dans une transaction, avant la
-- suppression — jamais de perte de données ni de sous-rubriques orphelines
-- "aplaties" plus que nécessaire.
--
-- La prévention des cycles (une rubrique ne peut pas devenir sa propre
-- descendante) n'est pas modélisable simplement par une contrainte SQL ici
-- (il faudrait une requête récursive) : elle est vérifiée dans
-- rubriqueService.ts à chaque changement de parent_rubrique_id.
ALTER TABLE rubriques
  ADD COLUMN parent_rubrique_id UUID REFERENCES rubriques(id) ON DELETE SET NULL;

CREATE INDEX rubriques_parent_rubrique_id_idx ON rubriques (parent_rubrique_id) WHERE parent_rubrique_id IS NOT NULL;
