-- Devise du compte — un seul code ISO 4217 par utilisateur (pas de
-- multi-devises par transaction : tous les montants d'un même compte
-- partagent cette unique devise, voir PATCH /auth/me et currencyCode() côté
-- frontend). Même approche que `locale` ci-dessus : un CHECK fermé sur une
-- liste connue plutôt qu'un TEXT libre, pour ne jamais se retrouver avec un
-- code que Intl.NumberFormat ne sait pas formatter.
ALTER TABLE user_profiles
  ADD COLUMN currency TEXT NOT NULL DEFAULT 'XAF'
    CHECK (currency IN ('XAF', 'XOF', 'EUR', 'USD', 'GBP', 'CAD'));
