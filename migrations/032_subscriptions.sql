-- Formules d'abonnement (Gratuit, Standard, Premium, Famille, Exécutive).
--
-- Décisions validées avec l'utilisateur (voir le document « Modèle
-- d'abonnements ») :
--   * les DÉFINITIONS des formules (limites, quotas, fonctions) vivent dans le
--     code (src/config/plans.ts), pas ici : elles changent par déploiement,
--     elles sont relues en revue, et une limite ne peut pas être desserrée par
--     une écriture en base ;
--   * cette migration ne stocke donc QUE l'état : qui a quelle formule,
--     jusqu'à quand, et ce qu'il a consommé ce mois-ci ;
--   * l'export PDF/Excel reste accessible à TOUTES les formules — personne ne
--     doit pouvoir être enfermé hors de ses propres données ;
--   * les limites bloquent la CRÉATION, jamais l'existant : un compte déclassé
--     garde ses données, les voit et saisit dedans.
--
-- Tant que PLANS_ENFORCED vaut false (voir src/config/env.ts), rien de tout
-- ceci n'a d'effet : les tables existent, les contrôles sont posés, mais tout
-- le monde reste illimité.

-- ---------------------------------------------------------------------------
-- Abonnement courant d'un utilisateur. UNE seule ligne par utilisateur : son
-- état présent. L'historique des paiements vit dans subscription_payments.
-- Un utilisateur SANS ligne est au Gratuit — c'est le cas par défaut, et
-- l'absence de ligne ne doit jamais être une erreur.
-- ---------------------------------------------------------------------------
CREATE TABLE subscriptions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_code          TEXT NOT NULL,
  -- trialing  : essai gratuit de 30 jours à l'inscription
  -- courtesy  : Premium offert (utilisateurs présents avant le lancement payant)
  -- active    : payé, dans sa période
  -- grace     : période finie, délai de grâce de quelques jours avant la bascule
  -- expired   : retombé au Gratuit (la ligne est gardée pour l'historique)
  -- cancelled : résilié par l'utilisateur, actif jusqu'à current_period_end
  status             TEXT NOT NULL CHECK (status IN ('trialing', 'courtesy', 'active', 'grace', 'expired', 'cancelled')),
  -- Fin de la période en cours. NULL = sans échéance (non utilisé aujourd'hui,
  -- réservé à un éventuel accès permanent accordé manuellement).
  current_period_end TIMESTAMPTZ,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX subscriptions_user_key ON subscriptions (user_id);

CREATE TRIGGER subscriptions_touch_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- Paiements d'abonnement. Une ligne par tentative, créée au moment où
-- l'utilisateur demande à payer, confirmée plus tard par le webhook signé de
-- l'agrégateur (MTN MoMo / Orange Money via CinetPay, Notch Pay...).
--
-- Deux garde-fous d'idempotence, parce qu'un agrégateur renvoie la même
-- notification plusieurs fois et qu'un double crédit prolongerait l'abonnement
-- deux fois :
--   * idempotency_key     : la nôtre, générée au moment du checkout ;
--   * (provider, provider_reference) : la sienne, posée à la confirmation.
-- Le webhook s'appuie sur ces contraintes plutôt que sur un test applicatif
-- « est-ce que je l'ai déjà vu », qui perdrait la course entre deux requêtes
-- simultanées.
-- ---------------------------------------------------------------------------
CREATE TABLE subscription_payments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_code          TEXT NOT NULL,
  period             TEXT NOT NULL CHECK (period IN ('monthly', 'quarterly', 'yearly')),
  -- Montant réellement demandé, figé à la création : un changement de tarif
  -- ne doit jamais réécrire ce qu'un utilisateur a payé.
  amount             NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  currency           TEXT NOT NULL DEFAULT 'XAF',
  provider           TEXT NOT NULL,
  provider_reference TEXT,
  idempotency_key    TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'cancelled')),
  paid_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX subscription_payments_idempotency_key ON subscription_payments (idempotency_key);
CREATE UNIQUE INDEX subscription_payments_provider_ref_key
  ON subscription_payments (provider, provider_reference)
  WHERE provider_reference IS NOT NULL;
CREATE INDEX subscription_payments_user_idx ON subscription_payments (user_id, created_at DESC);

CREATE TRIGGER subscription_payments_touch_updated_at
  BEFORE UPDATE ON subscription_payments
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- Compteurs mensuels (SMS collés, questions à l'assistant).
--
-- Volontairement séparés de rate_limit_buckets : ce n'est pas la même chose de
-- brider un abus (fenêtre glissante, purgée, invisible) et de compter un quota
-- qu'on doit AFFICHER à l'utilisateur (« 12 SMS sur 15 ce mois-ci ») et qui se
-- remet à zéro le 1er du mois.
--
-- period_month porte toujours le premier jour du mois en UTC.
-- ---------------------------------------------------------------------------
CREATE TABLE plan_usage (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  metric       TEXT NOT NULL,
  period_month DATE NOT NULL,
  count        INT NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, metric, period_month)
);

CREATE INDEX plan_usage_month_idx ON plan_usage (period_month);

CREATE TRIGGER plan_usage_touch_updated_at
  BEFORE UPDATE ON plan_usage
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
