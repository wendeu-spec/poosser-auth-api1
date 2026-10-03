import { z } from "zod";
import { TRANSACTION_METHODS, TONTINE_FREQUENCIES } from "../lib/categories.js";

// Historiquement un z.enum(CATEGORIES) fermé. Desserré en chaîne libre
// (bornée) pour accepter aussi les catégories personnalisées de l'utilisateur
// (voir categoryService.ts / migrations/026_categories.sql) sans avoir à
// faire un aller-retour base de données dans un schéma Zod synchrone — même
// choix que pour `category` sur budgets/transactions, déjà une simple chaîne
// en base, jamais une contrainte CHECK fermée.
const categorySchema = z.string().trim().min(1).max(60);
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
// note/projectId/rubriqueId sont nullables (en plus d'optionnels) ici pour
// pouvoir les effacer/détacher explicitement en modification (bouton
// "Modifier" de l'historique) : absent = inchangé, null = efface/détache,
// valeur = remplace. Même logique tri-état que parentRubriqueId plus haut.
export const updateTransactionSchema = createTransactionSchema.partial().extend({
  note: z.string().trim().max(280).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  rubriqueId: z.string().uuid().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Favoris de saisie rapide — gabarit de transaction (voir
// migrations/022_transaction_favorites.sql). Mêmes règles que les
// transactions (catégorie connue, méthode connue, rubrique exige un projet)
// et même sémantique tri-état en modification pour note/projectId/rubriqueId.
// ---------------------------------------------------------------------------
export const createTransactionFavoriteSchema = z.object({
  label: z.string().trim().min(1).max(60),
  type: z.enum(["revenu", "depense"]),
  category: categorySchema,
  amount: amountSchema,
  method: z.enum(TRANSACTION_METHODS),
  note: z.string().trim().max(280).optional(),
  projectId: z.string().uuid().optional(),
  rubriqueId: z.string().uuid().optional(),
});
export const updateTransactionFavoriteSchema = createTransactionFavoriteSchema.partial().extend({
  note: z.string().trim().max(280).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  rubriqueId: z.string().uuid().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Catégories personnalisées — voir categoryService.ts. S'ajoutent à la liste
// fixe (CATEGORIES) sans distinction dépense/revenu (décision produit : une
// catégorie personnalisée est toujours disponible pour les deux).
// ---------------------------------------------------------------------------
export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(60),
});

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

// Versement vers un objectif existant — voir savingsGoalService.addContribution
// et migrations/023_savings_goal_contributions.sql.
export const addSavingsGoalContributionSchema = z.object({
  amount: amountSchema,
});

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
// parentRubriqueId est nullable (et non juste optionnel) pour pouvoir
// explicitement détacher une sous-rubrique de son parent lors d'une mise à
// jour (absent = inchangé, null = retire le parent, uuid = rattache).
export const createRubriqueSchema = z.object({
  name: z.string().trim().min(1).max(120),
  plannedAmount: amountSchema.optional(),
  parentRubriqueId: z.string().uuid().nullable().optional(),
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

// Modification d'une tontine existante — tous les champs sont optionnels
// (partial update). memberNames renomme les membres existants dans l'ordre
// de passage ; ajouter/retirer un membre n'est pas permis ici (voir
// tontineService.updateTontine).
export const updateTontineSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  contributionAmount: amountSchema.optional(),
  frequency: z.enum(TONTINE_FREQUENCIES).optional(),
  memberNames: z.array(z.string().trim().min(1).max(80)).min(2).max(50).optional(),
});

// ---------------------------------------------------------------------------
// Planner financier
// ---------------------------------------------------------------------------
const recurrenceSchema = z.enum(TONTINE_FREQUENCIES); // même vocabulaire hebdo/mensuelle/trimestrielle

export const createPlannerEventSchema = z.object({
  title: z.string().trim().min(1).max(160),
  eventDate: dateSchema,
  eventTime: z.string().regex(/^\d{2}:\d{2}$/, "Heure attendue au format HH:MM"),
  durationMinutes: z.number().int().positive().max(24 * 60),
  type: z.enum(["revenu", "depense"]),
  category: categorySchema,
  amount: amountSchema,
  // Optionnel : si renseigné, la validation ("Réalisé") de cet événement crée
  // automatiquement la prochaine occurrence à la date suivante (voir
  // plannerEventService.setPlannerEventStatus).
  recurrence: recurrenceSchema.optional(),
});
// recurrence nullable en plus d'optionnelle ici pour pouvoir l'effacer
// explicitement (repasser un événement récurrent en ponctuel) : absent =
// inchangée, null = retire la récurrence, valeur = la remplace — même
// sémantique tri-état que note/projectId/rubriqueId sur les transactions.
export const updatePlannerEventSchema = createPlannerEventSchema.partial().extend({
  recurrence: recurrenceSchema.nullable().optional(),
});

export const setPlannerEventStatusSchema = z.object({
  status: z.enum(["a_venir", "realise", "non_realise"]),
});
