/**
 * Définition des formules d'abonnement.
 *
 * Volontairement dans le CODE et non en base (voir migrations/032) : les
 * limites changent par déploiement, elles sont relues en revue, et une limite
 * ne peut pas être desserrée par une écriture en base ou par une erreur de
 * manipulation. Même logique que CATEGORIES dans src/lib/categories.ts.
 *
 * Les prix sont en FCFA, toutes taxes comprises, tels qu'affichés à
 * l'utilisateur (décision produit : pas de prix hors taxes dans l'app).
 *
 * Ce que ce fichier ne contient PAS, délibérément :
 *   * l'export PDF/Excel — accessible à toutes les formules, y compris au
 *     Gratuit, pour que personne ne soit jamais enfermé hors de ses données ;
 *     il est d'ailleurs produit côté navigateur, le serveur n'a rien à ouvrir ;
 *   * les transactions, les virements et le champ Frais — illimités partout :
 *     brider la saisie de base viderait l'application de son sens.
 */

export const PLAN_CODES = ["gratuit", "standard", "premium", "famille", "executive"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

/** Ressources dont le NOMBRE est limité. Comptées à la création. */
export const COUNTED_RESOURCES = [
  "account",
  "budget",
  "project",
  "tontine",
  "savings_goal",
  "recurring_event",
] as const;
export type CountedResource = (typeof COUNTED_RESOURCES)[number];

/** Fonctions tout ou rien. */
export const FEATURES = ["advanced_stats", "shared_access", "business_separation"] as const;
export type Feature = (typeof FEATURES)[number];

/** Compteurs remis à zéro chaque mois. */
export const QUOTAS = ["sms_parse", "assistant"] as const;
export type Quota = (typeof QUOTAS)[number];

/** Périodicités de paiement et durée correspondante. */
export const BILLING_PERIODS = ["monthly", "quarterly", "yearly"] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

export const PERIOD_MONTHS: Record<BillingPeriod, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

/** `null` = illimité. Jamais 0 : une limite à 0 interdirait la fonction. */
export interface PlanDefinition {
  code: PlanCode;
  name: string;
  /** Ordre croissant de richesse — sert à comparer deux formules. */
  rank: number;
  limits: Record<CountedResource, number | null>;
  quotas: Record<Quota, number | null>;
  features: Record<Feature, boolean>;
  /** Mois d'historique consultable dans l'app ; null = tout. L'export n'est jamais limité. */
  historyMonths: number | null;
  /** Nombre de personnes couvertes (option Famille). */
  seats: number;
  prices: Record<BillingPeriod, number>;
}

const UNLIMITED = {
  limits: {
    account: null, budget: null, project: null,
    tontine: null, savings_goal: null, recurring_event: null,
  },
  quotas: { sms_parse: null, assistant: null },
} as const;

export const PLANS: Record<PlanCode, PlanDefinition> = {
  gratuit: {
    code: "gratuit",
    name: "Gratuit",
    rank: 0,
    limits: {
      account: 2,
      budget: 3,
      project: 1,
      tontine: 1,
      savings_goal: 1,
      recurring_event: 3,
    },
    quotas: { sms_parse: 15, assistant: 5 },
    features: { advanced_stats: false, shared_access: false, business_separation: false },
    historyMonths: 3,
    seats: 1,
    prices: { monthly: 0, quarterly: 0, yearly: 0 },
  },
  standard: {
    code: "standard",
    name: "Standard",
    rank: 1,
    limits: { ...UNLIMITED.limits, project: 3, tontine: 1, savings_goal: 3 },
    quotas: { sms_parse: null, assistant: 30 },
    features: { advanced_stats: false, shared_access: false, business_separation: false },
    historyMonths: null,
    seats: 1,
    prices: { monthly: 1_000, quarterly: 2_700, yearly: 10_000 },
  },
  premium: {
    code: "premium",
    name: "Premium",
    rank: 2,
    limits: { ...UNLIMITED.limits },
    quotas: { sms_parse: null, assistant: 150 },
    features: { advanced_stats: true, shared_access: false, business_separation: false },
    historyMonths: null,
    seats: 1,
    prices: { monthly: 2_500, quarterly: 6_750, yearly: 25_000 },
  },
  famille: {
    code: "famille",
    name: "Famille",
    rank: 3,
    limits: { ...UNLIMITED.limits },
    quotas: { sms_parse: null, assistant: 150 },
    features: { advanced_stats: true, shared_access: false, business_separation: false },
    historyMonths: null,
    seats: 5,
    prices: { monthly: 4_000, quarterly: 10_800, yearly: 40_000 },
  },
  executive: {
    code: "executive",
    name: "Exécutive",
    rank: 4,
    limits: { ...UNLIMITED.limits },
    quotas: { sms_parse: null, assistant: 500 },
    features: { advanced_stats: true, shared_access: true, business_separation: true },
    historyMonths: null,
    seats: 1,
    prices: { monthly: 7_500, quarterly: 20_000, yearly: 75_000 },
  },
};

export const FREE_PLAN = PLANS.gratuit;

export function isPlanCode(value: string): value is PlanCode {
  return (PLAN_CODES as readonly string[]).includes(value);
}

export function planByCode(code: string): PlanDefinition {
  return isPlanCode(code) ? PLANS[code] : FREE_PLAN;
}

/**
 * Formule minimale qui lève une limite donnée — sert à dire à l'utilisateur
 * « passez au Standard », et non juste « c'est bloqué ».
 */
export function cheapestPlanWith(check: (p: PlanDefinition) => boolean): PlanDefinition | null {
  const candidates = PLAN_CODES.map((c) => PLANS[c])
    .filter(check)
    .sort((a, b) => a.rank - b.rank);
  return candidates[0] ?? null;
}

export function planForResourceLimit(resource: CountedResource, needed: number): PlanDefinition | null {
  return cheapestPlanWith((p) => p.limits[resource] === null || p.limits[resource]! >= needed);
}

export function planForFeature(feature: Feature): PlanDefinition | null {
  return cheapestPlanWith((p) => p.features[feature]);
}

export function planForQuota(quota: Quota, needed: number): PlanDefinition | null {
  return cheapestPlanWith((p) => p.quotas[quota] === null || p.quotas[quota]! >= needed);
}
