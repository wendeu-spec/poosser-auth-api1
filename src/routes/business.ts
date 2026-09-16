import { Router } from "express";
import { requireAccessToken } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { Errors } from "../lib/errors.js";
import {
  createTransactionSchema, updateTransactionSchema,
  upsertBudgetSchema,
  createSavingsGoalSchema, updateSavingsGoalSchema,
  createTontineSchema, markContributionSchema,
  createPlannerEventSchema, updatePlannerEventSchema, setPlannerEventStatusSchema,
} from "../validators/businessSchemas.js";

import * as transactions from "../services/transactionService.js";
import * as budgets from "../services/budgetService.js";
import * as savingsGoals from "../services/savingsGoalService.js";
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
  res.json({ transactions: await transactions.listTransactions(req.auth!.userId) });
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
