import { Router } from "express";
import { requireAccessToken } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { Errors } from "../lib/errors.js";
import {
  createTransactionSchema, updateTransactionSchema,
  createTransactionFavoriteSchema, updateTransactionFavoriteSchema,
  upsertBudgetSchema,
  createSavingsGoalSchema, updateSavingsGoalSchema, addSavingsGoalContributionSchema,
  createProjectSchema, updateProjectSchema,
  createRubriqueSchema, updateRubriqueSchema,
  createTontineSchema, markContributionSchema,
  createPlannerEventSchema, updatePlannerEventSchema, setPlannerEventStatusSchema,
} from "../validators/businessSchemas.js";

import * as transactions from "../services/transactionService.js";
import * as favorites from "../services/favoriteService.js";
import * as budgets from "../services/budgetService.js";
import * as savingsGoals from "../services/savingsGoalService.js";
import * as projects from "../services/projectService.js";
import * as rubriques from "../services/rubriqueService.js";
import * as tontines from "../services/tontineService.js";
import * as plannerEvents from "../services/plannerEventService.js";

export const businessRouter = Router();

// Toutes les routes métier exigent une session active — aucune n'est jamais
// accessible sans access token valide (voir middleware/auth.ts).
businessRouter.use(requireAccessToken);

function requireParamId(id: string | string[] | undefined): string {
  if (typeof id !== "string") throw Errors.validation({ field: "id" });
  return id;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------
businessRouter.get("/transactions", async (req, res) => {
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
  res.json({ transactions: await transactions.listTransactions(req.auth!.userId, projectId) });
});
businessRouter.post("/transactions", validateBody(createTransactionSchema), async (req, res) => {
  const tx = await transactions.createTransaction(req.auth!.userId, req.body);
  res.status(201).json({ transaction: tx });
});
businessRouter.patch("/transactions/:id", validateBody(updateTransactionSchema), async (req, res) => {
  const id = requireParamId(req.params.id);
  res.json({ transaction: await transactions.updateTransaction(req.auth!.userId, id, req.body) });
});
businessRouter.delete("/transactions/:id", async (req, res) => {
  const id = requireParamId(req.params.id);
  await transactions.deleteTransaction(req.auth!.userId, id);
  res.status(204).send();
});

// ---------------------------------------------------------------------------
// Favoris de saisie rapide — gabarits de transaction réutilisables (bouton
// "☆ Favori" sur une ligne d'historique, puis "⭐ Favoris" dans l'onglet
// Transactions pour les rejouer). Pas de notion de projet dans l'URL ici
// (contrairement aux rubriques) : un favori appartient directement à
// l'utilisateur, le project_id/rubrique_id éventuel n'est qu'un champ parmi
// d'autres dans son gabarit.
// ---------------------------------------------------------------------------
businessRouter.get("/transaction-favorites", async (req, res) => {
  res.json({ transactionFavorites: await favorites.listTransactionFavorites(req.auth!.userId) });
});
businessRouter.post("/transaction-favorites", validateBody(createTransactionFavoriteSchema), async (req, res) => {
  const favorite = await favorites.createTransactionFavorite(req.auth!.userId, req.body);
  res.status(201).json({ transactionFavorite: favorite });
});
businessRouter.patch("/transaction-favorites/:id", validateBody(updateTransactionFavoriteSchema), async (req, res) => {
  const id = requireParamId(req.params.id);
  res.json({ transactionFavorite: await favorites.updateTransactionFavorite(req.auth!.userId, id, req.body) });
});
businessRouter.delete("/transaction-favorites/:id", async (req, res) => {
  const id = requireParamId(req.params.id);
  await favorites.deleteTransactionFavorite(req.auth!.userId, id);
  res.status(204).send();
});

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------
businessRouter.get("/budgets", async (req, res) => {
  res.json({ budgets: await budgets.listBudgets(req.auth!.userId) });
});
businessRouter.post("/budgets", validateBody(upsertBudgetSchema), async (req, res) => {
  const budget = await budgets.upsertBudget(req.auth!.userId, req.body.category, req.body.monthlyLimit);
  res.status(201).json({ budget });
});
businessRouter.delete("/budgets/:id", async (req, res) => {
  const id = requireParamId(req.params.id);
  await budgets.deleteBudget(req.auth!.userId, id);
  res.status(204).send();
});

// ---------------------------------------------------------------------------
// Épargne
// ---------------------------------------------------------------------------
businessRouter.get("/savings-goals", async (req, res) => {
  res.json({ savingsGoals: await savingsGoals.listSavingsGoals(req.auth!.userId) });
});
businessRouter.post("/savings-goals", validateBody(createSavingsGoalSchema), async (req, res) => {
  const goal = await savingsGoals.createSavingsGoal(req.auth!.userId, req.body);
  res.status(201).json({ savingsGoal: goal });
});
businessRouter.patch("/savings-goals/:id", validateBody(updateSavingsGoalSchema), async (req, res) => {
  const id = requireParamId(req.params.id);
  res.json({ savingsGoal: await savingsGoals.updateSavingsGoal(req.auth!.userId, id, req.body) });
});
businessRouter.delete("/savings-goals/:id", async (req, res) => {
  const id = requireParamId(req.params.id);
  await savingsGoals.deleteSavingsGoal(req.auth!.userId, id);
  res.status(204).send();
});
// Versement vers un objectif ("+ Verser") — journalisé pour permettre un
// calcul exact "épargné cette semaine" côté résumé hebdomadaire (voir
// migrations/023_savings_goal_contributions.sql). Route à part plutôt qu'un
// simple PATCH currentAmount : on veut une trace datée de chaque versement,
// pas seulement le nouveau solde.
businessRouter.post("/savings-goals/:id/contributions", validateBody(addSavingsGoalContributionSchema), async (req, res) => {
  const id = requireParamId(req.params.id);
  const { goal, contribution } = await savingsGoals.addContribution(req.auth!.userId, id, req.body.amount);
  res.status(201).json({ savingsGoal: goal, contribution });
});
// Journal complet des versements de l'utilisateur (tous objectifs confondus) —
// non imbriqué sous /savings-goals/:id pour éviter à chaque client de faire
// une requête par objectif ; même convention que /transaction-favorites.
businessRouter.get("/savings-goal-contributions", async (req, res) => {
  res.json({ savingsGoalContributions: await savingsGoals.listRecentContributions(req.auth!.userId) });
});

// ---------------------------------------------------------------------------
// Projets — chaque projet renvoie ses totaux calculés depuis les
// transactions rattachées (total_in, total_out, balance, transaction_count).
// Le détail des transactions d'un projet se récupère via
// GET /transactions?projectId=... (déjà filtrable ci-dessus).
// ---------------------------------------------------------------------------
businessRouter.get("/projects", async (req, res) => {
  res.json({ projects: await projects.listProjects(req.auth!.userId) });
});
businessRouter.get("/projects/:id", async (req, res) => {
  const id = requireParamId(req.params.id);
  res.json({ project: await projects.getProject(req.auth!.userId, id) });
});
businessRouter.post("/projects", validateBody(createProjectSchema), async (req, res) => {
  const project = await projects.createProject(req.auth!.userId, req.body);
  res.status(201).json({ project });
});
businessRouter.patch("/projects/:id", validateBody(updateProjectSchema), async (req, res) => {
  const id = requireParamId(req.params.id);
  res.json({ project: await projects.updateProject(req.auth!.userId, id, req.body) });
});
businessRouter.delete("/projects/:id", async (req, res) => {
  const id = requireParamId(req.params.id);
  await projects.deleteProject(req.auth!.userId, id);
  res.status(204).send();
});

// ---------------------------------------------------------------------------
// Rubriques — postes de dépense à l'intérieur d'un projet. Imbriquées sous
// /projects/:projectId car une rubrique n'existe jamais hors de son projet.
// GET sans :projectId renvoie toutes les rubriques de l'utilisateur (tous
// projets confondus), pratique pour le chargement initial côté front.
// ---------------------------------------------------------------------------
businessRouter.get("/rubriques", async (req, res) => {
  res.json({ rubriques: await rubriques.listRubriques(req.auth!.userId) });
});
businessRouter.get("/projects/:projectId/rubriques", async (req, res) => {
  const projectId = requireParamId(req.params.projectId);
  res.json({ rubriques: await rubriques.listRubriques(req.auth!.userId, projectId) });
});
businessRouter.post("/projects/:projectId/rubriques", validateBody(createRubriqueSchema), async (req, res) => {
  const projectId = requireParamId(req.params.projectId);
  const rubrique = await rubriques.createRubrique(req.auth!.userId, projectId, req.body);
  res.status(201).json({ rubrique });
});
businessRouter.patch("/projects/:projectId/rubriques/:id", validateBody(updateRubriqueSchema), async (req, res) => {
  const projectId = requireParamId(req.params.projectId);
  const id = requireParamId(req.params.id);
  res.json({ rubrique: await rubriques.updateRubrique(req.auth!.userId, projectId, id, req.body) });
});
businessRouter.delete("/projects/:projectId/rubriques/:id", async (req, res) => {
  const projectId = requireParamId(req.params.projectId);
  const id = requireParamId(req.params.id);
  await rubriques.deleteRubrique(req.auth!.userId, projectId, id);
  res.status(204).send();
});

// ---------------------------------------------------------------------------
// Tontines
// ---------------------------------------------------------------------------
businessRouter.get("/tontines", async (req, res) => {
  res.json({ tontines: await tontines.listTontines(req.auth!.userId) });
});
businessRouter.get("/tontines/:id", async (req, res) => {
  const id = requireParamId(req.params.id);
  res.json({ tontine: await tontines.getTontine(req.auth!.userId, id) });
});
businessRouter.post("/tontines", validateBody(createTontineSchema), async (req, res) => {
  const tontine = await tontines.createTontine(req.auth!.userId, req.body);
  res.status(201).json({ tontine });
});
businessRouter.post("/tontines/:id/contributions", validateBody(markContributionSchema), async (req, res) => {
  const id = requireParamId(req.params.id);
  const tontine = await tontines.markContribution(req.auth!.userId, id, req.body.memberId, req.body.paid);
  res.json({ tontine });
});
businessRouter.post("/tontines/:id/close-round", async (req, res) => {
  const id = requireParamId(req.params.id);
  const tontine = await tontines.closeRound(req.auth!.userId, id);
  res.json({ tontine });
});

// ---------------------------------------------------------------------------
// Planner financier
// ---------------------------------------------------------------------------
businessRouter.get("/planner-events", async (req, res) => {
  res.json({ plannerEvents: await plannerEvents.listPlannerEvents(req.auth!.userId) });
});
businessRouter.post("/planner-events", validateBody(createPlannerEventSchema), async (req, res) => {
  const event = await plannerEvents.createPlannerEvent(req.auth!.userId, req.body);
  res.status(201).json({ plannerEvent: event });
});
businessRouter.patch("/planner-events/:id", validateBody(updatePlannerEventSchema), async (req, res) => {
  const id = requireParamId(req.params.id);
  res.json({ plannerEvent: await plannerEvents.updatePlannerEvent(req.auth!.userId, id, req.body) });
});
businessRouter.post("/planner-events/:id/status", validateBody(setPlannerEventStatusSchema), async (req, res) => {
  const id = requireParamId(req.params.id);
  const event = await plannerEvents.setPlannerEventStatus(req.auth!.userId, id, req.body.status);
  res.json({ plannerEvent: event });
});
businessRouter.delete("/planner-events/:id", async (req, res) => {
  const id = requireParamId(req.params.id);
  await plannerEvents.deletePlannerEvent(req.auth!.userId, id);
  res.status(204).send();
});
