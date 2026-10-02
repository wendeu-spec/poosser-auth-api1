import { z } from "zod";
import { CATEGORIES, TRANSACTION_METHODS, TONTINE_FREQUENCIES } from "../lib/categories.js";

const categorySchema = z.enum(CATEGORIES);
const amountSchema = z.number().positive().max(1_000_000_000);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format AAAA-MM-JJ");

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------
export const createTransactionSchema = z.object({
  type: z.enum(["revenu", "depense"]),
  category: categorySchema,
  amount: amountSchema,
  occurredOn: dateSchema,
  method: z.enum(TRANSACTION_METHODS),
  note: z.string().trim().max(280).optional(),
  projectId: z.string().uuid().optional(),
  rubriqueId: z.string().uuid().optional(),
});
export const updateTransactionSchema = createTransactionSchema.partial();

// ---------------------------------------------------------------------------
// Budgets — définir une limite sur une catégorie existante la met à jour (upsert).
// ---------------------------------------------------------------------------
export const upsertBudgetSchema = z.object({
  category: categorySchema,
  monthlyLimit: amountSchema,
});

// ---------------------------------------------------------------------------
// Épargne
// ---------------------------------------------------------------------------
export const createSavingsGoalSchema = z.object({
  name: z.string().trim().min(1).max(120),
  targetAmount: amountSchema,
  currentAmount: z.number().min(0).max(1_000_000_000).optional(),
  deadline: dateSchema.optional(),
});
export const updateSavingsGoalSchema = createSavingsGoalSchema.partial();

// ---------------------------------------------------------------------------
// Projets (onglet Projets — suivi des entrées/sorties d'un projet donné)
// ---------------------------------------------------------------------------
export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  icon: z.string().trim().min(1).max(8).optional(),
  targetAmount: amountSchema.optional(),
  targetDate: dateSchema.optional(),
});
export const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  icon: z.string().trim().min(1).max(8).optional(),
  targetAmount: amountSchema.optional(),
  targetDate: dateSchema.optional(),
  status: z.enum(["actif", "termine", "archive"]).optional(),
});

// Rubriques (postes de dépense à l'intérieur d'un projet, ex: "Transport",
// "Hébergement" pour un voyage). Imbriquées sous un projet (voir routes
// /projects/:projectId/rubriques) — pas de champ projectId ici, il vient de l'URL.
export const createRubriqueSchema = z.object({
  name: z.string().trim().min(1).max(120),
  plannedAmount: amountSchema.optional(),
});
export const updateRubriqueSchema = createRubriqueSchema.partial();

// ---------------------------------------------------------------------------
// Tontines
// ---------------------------------------------------------------------------
export const createTontineSchema = z.object({
  name: z.string().trim().min(1).max(120),
  contributionAmount: amountSchema,
  frequency: z.enum(TONTINE_FREQUENCIES),
  // Reprend le champ "membres séparés par une virgule" du prototype : on
  // accepte directement la liste de noms, dans l'ordre de passage.
  members: z.array(z.string().trim().min(1).max(80)).min(2).max(50),
});

export const markContributionSchema = z.object({
  memberId: z.string().uuid(),
  paid: z.boolean(),
});

// ---------------------------------------------------------------------------
// Planner financier
// ---------------------------------------------------------------------------
export const createPlannerEventSchema = z.object({
  title: z.string().trim().min(1).max(160),
  eventDate: dateSchema,
  eventTime: z.string().regex(/^\d{2}:\d{2}$/, "Heure attendue au format HH:MM"),
  durationMinutes: z.number().int().positive().max(24 * 60),
  type: z.enum(["revenu", "depense"]),
  category: categorySchema,
  amount: amountSchema,
});
export const updatePlannerEventSchema = createPlannerEventSchema.partial();

export const setPlannerEventStatusSchema = z.object({
  status: z.enum(["a_venir", "realise", "non_realise"]),
});
