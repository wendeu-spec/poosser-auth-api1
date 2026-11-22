-- Clé d'idempotence pour la file d'attente hors réseau (maj33).
--
-- Le problème que cette colonne résout, et lui seul :
--
--   Le téléphone envoie une opération, le serveur l'enregistre, puis la
--   réponse se perd en chemin — réseau qui coupe pile à ce moment, tunnel
--   mobile qui lâche, onglet fermé. Le téléphone ne sait pas que c'est passé.
--   Il réessaie. Sans garde-fou, la dépense est enregistrée DEUX FOIS.
--
--   Ce cas n'est pas théorique : c'est exactement la situation d'un réseau
--   intermittent, celle pour laquelle la file d'attente existe.
--
-- Le client tire une clé au hasard (crypto.randomUUID) AVANT le premier
-- envoi et la garde avec l'opération en attente. Tous ses renvois portent la
-- même clé. Le serveur, voyant une clé déjà connue de cet utilisateur,
-- renvoie l'opération déjà enregistrée au lieu d'en créer une seconde.
--
-- Décisions :
--
--   * La clé est NULLABLE : toutes les opérations saisies jusqu'ici n'en ont
--     pas, et une saisie en ligne normale n'en a pas besoin. Seule la file
--     d'attente en pose une.
--
--   * L'unicité est PAR UTILISATEUR, pas globale. Deux téléphones peuvent
--     tirer la même clé — c'est improbable avec un UUID v4, mais la
--     contrainte doit dire ce qu'on veut dire : une clé identifie une
--     opération DANS le compte de son propriétaire. L'index partiel ignore
--     les NULL, donc il ne coûte rien aux opérations ordinaires.
--
--   * Les FRAIS liés n'ont pas de clé à eux : ils sont créés dans la même
--     transaction SQL que l'opération qui les porte. Rejouer la clé de
--     l'opération ne recrée donc pas ses frais.

ALTER TABLE transactions
  ADD COLUMN client_key TEXT;

COMMENT ON COLUMN transactions.client_key IS
  'Clé tirée par le client avant le premier envoi, rejouée à chaque renvoi : empêche le doublon quand la réponse du serveur se perd. NULL pour toute opération saisie en ligne.';

CREATE UNIQUE INDEX transactions_user_client_key_uniq
  ON transactions (user_id, client_key)
  WHERE client_key IS NOT NULL;
