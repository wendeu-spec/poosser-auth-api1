import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";
import { env } from "../config/env.js";
import { Errors } from "../lib/errors.js";
import {
  FREE_PLAN, PLANS, planByCode, planForFeature, planForQuota, planForResourceLimit,
  type CountedResource, type Feature, type PlanCode, type PlanDefinition, type Quota,
} from "../config/plans.js";

/**
 * Point de contrôle UNIQUE des formules d'abonnement.
 *
 * Pourquoi un seul module : l'API compte une vingtaine de routes de création.
 * Disséminer les contrôles garantit d'en oublier un, et une limite oubliée
 * rend la formule payante contournable. Ici, toute limite passe par
 * assertCanCreate / assertFeature / consumeQuota, et un test
 * (tests/plan-limits.test.ts) vérifie qu'aucune ressource limitée n'y échappe.
 *
 * Les contrôles vivent dans les SERVICES, pas dans les routes : certaines
 * créations n'empruntent aucune route (budgetProposalService crée des budgets
 * côté serveur), un contrôle posé sur la route les manquerait.
 *
 * Interrupteur : tant que PLANS_ENFORCED vaut false, rien n'est refusé. Les
 * compteurs de quota continuent pourtant d'être incrémentés — c'est ce qui
 * permettra de mesurer l'usage réel AVANT d'allumer les limites, et donc de
 * les corriger sur des faits plutôt que sur des suppositions.
 */

type Queryable = Pick<PoolClient, "query">;

export interface SubscriptionRow {
  id: string;
  user_id: string;
  plan_code: string;
  status: "trialing" | "courtesy" | "active" | "grace" | "expired" | "cancelled";
  current_period_end: Date | null;
  started_at: Date;
  cancelled_at: Date | null;
}

export interface Entitlements {
  plan: PlanDefinition;
  /** État tel qu'il est stocké ; "aucun" quand l'utilisateur n'a jamais eu d'abonnement. */
  status: SubscriptionRow["status"] | "aucun";
  currentPeriodEnd: Date | null;
  /** false = les limites sont calculées mais jamais appliquées (voir PLANS_ENFORCED). */
  enforced: boolean;
}

/** Statuts qui donnent accès à la formule payante. */
const ACTIVE_STATUSES = new Set(["trialing", "courtesy", "active", "grace", "cancelled"]);

function graceMs(): number {
  return env.PLAN_GRACE_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Formule réellement applicable maintenant. Une période échue, délai de grâce
 * compris, ramène au Gratuit — calculé à la lecture, sans tâche planifiée :
 * une tâche qui ne tourne pas laisserait des abonnements ouverts indéfiniment.
 */
export function resolvePlan(sub: SubscriptionRow | null, now = new Date()): PlanDefinition {
  if (!sub) return FREE_PLAN;
  if (!ACTIVE_STATUSES.has(sub.status)) return FREE_PLAN;
  if (sub.current_period_end && now.getTime() > sub.current_period_end.getTime() + graceMs()) {
    return FREE_PLAN;
  }
  return planByCode(sub.plan_code);
}

export async function getSubscription(userId: string, db: Queryable = pool): Promise<SubscriptionRow | null> {
  const { rows } = await db.query<SubscriptionRow>(
    `SELECT * FROM subscriptions WHERE user_id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

export async function getEntitlements(userId: string, db: Queryable = pool): Promise<Entitlements> {
  const sub = await getSubscription(userId, db);
  return {
    plan: resolvePlan(sub),
    status: sub?.status ?? "aucun",
    currentPeriodEnd: sub?.current_period_end ?? null,
    enforced: env.PLANS_ENFORCED,
  };
}

// ---------------------------------------------------------------------------
// Limites de nombre
// ---------------------------------------------------------------------------

/**
 * Comment compter l'existant de chaque ressource limitée.
 *
 * Ce qui est compté, c'est ce qui est VIVANT : un compte archivé, un projet
 * clos ou une échéance déjà passée ne consomment pas de place. Sinon un
 * utilisateur du Gratuit serait bloqué par son propre historique, ce qui
 * reviendrait à le punir d'avoir utilisé l'application.
 */
const COUNT_SQL: Record<CountedResource, string> = {
  account: `SELECT count(*)::int AS n FROM accounts WHERE user_id = $1 AND archived = false`,
  budget: `SELECT count(*)::int AS n FROM budgets WHERE user_id = $1`,
  project: `SELECT count(*)::int AS n FROM projects WHERE user_id = $1 AND status = 'actif'`,
  tontine: `SELECT count(*)::int AS n FROM tontines WHERE user_id = $1`,
  savings_goal: `SELECT count(*)::int AS n FROM savings_goals WHERE user_id = $1`,
  recurring_event: `SELECT count(*)::int AS n FROM planner_events
                    WHERE user_id = $1 AND recurrence IS NOT NULL AND status = 'a_venir'`,
};

export async function countResource(
  userId: string,
  resource: CountedResource,
  db: Queryable = pool,
): Promise<number> {
  const { rows } = await db.query<{ n: number }>(COUNT_SQL[resource], [userId]);
  return rows[0]?.n ?? 0;
}

/**
 * À appeler AVANT de créer une ressource limitée. Refuse quand la limite de la
 * formule est déjà atteinte, en nommant la formule qui la lèverait — l'app
 * peut alors proposer « Passer au Standard » plutôt qu'afficher « bloqué ».
 */
export async function assertCanCreate(
  userId: string,
  resource: CountedResource,
  db: Queryable = pool,
): Promise<void> {
  if (!env.PLANS_ENFORCED) return;
  const { plan } = await getEntitlements(userId, db);
  const limit = plan.limits[resource];
  if (limit === null) return;
  const current = await countResource(userId, resource, db);
  if (current < limit) return;
  const upgrade = planForResourceLimit(resource, current + 1);
  throw Errors.planLimitReached({
    resource,
    limit,
    current,
    plan: plan.code,
    upgradeTo: upgrade && upgrade.code !== plan.code ? upgrade.code : null,
  });
}

// ---------------------------------------------------------------------------
// Fonctions tout ou rien
// ---------------------------------------------------------------------------

export async function assertFeature(
  userId: string,
  feature: Feature,
  db: Queryable = pool,
): Promise<void> {
  if (!env.PLANS_ENFORCED) return;
  const { plan } = await getEntitlements(userId, db);
  if (plan.features[feature]) return;
  const upgrade = planForFeature(feature);
  throw Errors.planFeatureRequired({
    feature,
    plan: plan.code,
    upgradeTo: upgrade?.code ?? null,
  });
}

// ---------------------------------------------------------------------------
// Quotas mensuels
// ---------------------------------------------------------------------------

/** Premier jour du mois courant, en UTC — même repère que period_month en base. */
export function currentPeriodMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export async function getUsage(
  userId: string,
  quota: Quota,
  db: Queryable = pool,
): Promise<number> {
  const { rows } = await db.query<{ count: number }>(
    `SELECT count FROM plan_usage WHERE user_id = $1 AND metric = $2 AND period_month = $3`,
    [userId, quota, currentPeriodMonth()],
  );
  return rows[0]?.count ?? 0;
}

/**
 * Consomme une unité de quota. Incrémente le compteur DANS TOUS LES CAS, même
 * quand les limites sont éteintes : mesurer l'usage réel avant d'allumer les
 * formules est précisément ce qui permettra de fixer des quotas justes.
 *
 * L'incrément et la vérification se font en une seule requête atomique : deux
 * appels simultanés ne peuvent pas passer tous les deux sous la limite.
 */
export async function consumeQuota(
  userId: string,
  quota: Quota,
  db: Queryable = pool,
): Promise<{ used: number; limit: number | null }> {
  const month = currentPeriodMonth();
  const { rows } = await db.query<{ count: number }>(
    `INSERT INTO plan_usage (user_id, metric, period_month, count)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (user_id, metric, period_month)
     DO UPDATE SET count = plan_usage.count + 1
     RETURNING count`,
    [userId, quota, month],
  );
  const used = rows[0]!.count;

  const { plan } = await getEntitlements(userId, db);
  const limit = plan.quotas[quota];
  if (!env.PLANS_ENFORCED || limit === null || used <= limit) return { used, limit };

  // Au-delà de la limite : on rend l'unité consommée pour que le compteur
  // affiché reste honnête (« 15 sur 15 », jamais « 18 sur 15 »).
  await db.query(
    `UPDATE plan_usage SET count = count - 1
     WHERE user_id = $1 AND metric = $2 AND period_month = $3 AND count > 0`,
    [userId, quota, month],
  );
  const upgrade = planForQuota(quota, limit + 1);
  throw Errors.planQuotaExhausted({
    quota,
    limit,
    used: limit,
    plan: plan.code,
    upgradeTo: upgrade && upgrade.code !== plan.code ? upgrade.code : null,
    resetsOn: nextMonthIso(),
  });
}

function nextMonthIso(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Fenêtre d'historique
// ---------------------------------------------------------------------------

/**
 * Date la plus ancienne consultable DANS L'APPLICATION (null = sans limite).
 *
 * Ne s'applique jamais à l'export, accessible à toutes les formules : limiter
 * l'affichage est un argument commercial, enfermer quelqu'un hors de ses
 * propres données n'en est pas un.
 */
export async function historyFloor(userId: string, db: Queryable = pool): Promise<string | null> {
  if (!env.PLANS_ENFORCED) return null;
  const { plan } = await getEntitlements(userId, db);
  if (plan.historyMonths === null) return null;
  const now = new Date();
  const floor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - plan.historyMonths + 1, 1));
  return floor.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Attribution d'une formule
// ---------------------------------------------------------------------------

export interface GrantInput {
  planCode: PlanCode;
  status: SubscriptionRow["status"];
  periodEnd: Date | null;
}

/**
 * Pose ou remplace l'abonnement d'un utilisateur. Utilisé par l'essai de 30
 * jours, par le Premium de courtoisie des comptes existants, et plus tard par
 * la confirmation de paiement.
 */
export async function grantPlan(
  userId: string,
  input: GrantInput,
  db: Queryable = pool,
): Promise<SubscriptionRow> {
  const { rows } = await db.query<SubscriptionRow>(
    `INSERT INTO subscriptions (user_id, plan_code, status, current_period_end)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE
       SET plan_code = EXCLUDED.plan_code,
           status = EXCLUDED.status,
           current_period_end = EXCLUDED.current_period_end,
           cancelled_at = NULL
     RETURNING *`,
    [userId, input.planCode, input.status, input.periodEnd],
  );
  return rows[0]!;
}

export function monthsFromNow(months: number, now = new Date()): Date {
  return new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth() + months, now.getUTCDate(),
    now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(),
  ));
}

/** Vue destinée à l'application : formule, quotas consommés, échéance. */
export async function getSubscriptionView(userId: string) {
  const ent = await getEntitlements(userId);
  const [smsUsed, assistantUsed] = await Promise.all([
    getUsage(userId, "sms_parse"),
    getUsage(userId, "assistant"),
  ]);
  return {
    plan: ent.plan.code,
    planName: ent.plan.name,
    status: ent.status,
    currentPeriodEnd: ent.currentPeriodEnd,
    enforced: ent.enforced,
    limits: ent.plan.limits,
    features: ent.plan.features,
    historyMonths: ent.plan.historyMonths,
    usage: {
      sms_parse: { used: smsUsed, limit: ent.plan.quotas.sms_parse },
      assistant: { used: assistantUsed, limit: ent.plan.quotas.assistant },
    },
    prices: Object.fromEntries(
      Object.values(PLANS).map((p) => [p.code, p.prices]),
    ),
  };
}
