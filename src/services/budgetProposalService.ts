import { pool } from "../db/pool.js";
import { Errors } from "../lib/errors.js";
import { env } from "../config/env.js";
import { upsertBudget } from "./budgetService.js";
import { createPlannerEvent } from "./plannerEventService.js";

/**
 * Proposition automatique de budget mensuel : quelques jours avant le début
 * du mois N+1 (BUDGET_PROPOSAL_GENERATE_DAY_OF_MONTH), on reprend les
 * événements planner NON récurrents du mois en cours comme point de départ
 * du mois suivant, sous forme d'une proposition "pending" — jamais appliquée
 * directement (voir applyProposal, appelée uniquement à la validation
 * explicite ou à l'expiration du plafond de rappels).
 *
 * Pas de tâche planifiée (ce projet n'a pas de scheduler/cron dédié) : la
 * génération et le calcul de la cadence de rappel se font paresseusement, à
 * la prochaine requête authentifiée de l'utilisateur (voir getCurrentProposal,
 * appelée depuis GET /api/budget-proposals/current) — idempotent, jamais de
 * doublon (UNIQUE(user_id, target_month)).
 */

export type BudgetProposalStatus = "pending" | "validated" | "dismissed" | "auto_applied";

export interface BudgetProposalItem {
  titre: string;
  type: "revenu" | "depense";
  categorie: string;
  montant: number;
  jour: number; // 1-28, même convention que le wizard front-end (#budgetWizardCard)
}

export interface BudgetProposalRow {
  id: string;
  user_id: string;
  target_month: string; // "AAAA-MM-01"
  source_month: string;
  status: BudgetProposalStatus;
  items: BudgetProposalItem[];
  generated_at: string;
  reminder_count: number;
  last_reminder_at: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApplySummary {
  totalItems: number;
  createdEvents: number;
  eventErrors: string[];
  budgetsDone: number;
  budgetErrors: string[];
}

export interface ProposalWithReminder {
  proposal: BudgetProposalRow;
  shouldRemind: boolean;
  daysSinceGenerated: number;
}

export interface ReminderShownResult {
  proposal: BudgetProposalRow;
  autoApplied: boolean;
  applySummary?: ApplySummary;
}

// --- Arithmétique de dates, en UTC, jamais de fuseau horaire local (même
// principe que plannerEventService.addMonthsClamped) ---------------------
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function firstOfMonthUTC(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-01`;
}

function addMonthsToFirst(firstOfMonthStr: string, months: number): string {
  const [y, m] = firstOfMonthStr.split("-").map(Number);
  const totalMonths = y! * 12 + (m! - 1) + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12;
  return `${targetYear}-${pad2(targetMonth + 1)}-01`;
}

function dayOfMonth(dateStr: string): number {
  return Number(dateStr.split("-")[2]);
}

function dateForDay(targetMonth: string, day: number): string {
  const [y, m] = targetMonth.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  const d = Math.min(Math.max(1, day), lastDay);
  return `${y}-${pad2(m!)}-${pad2(d)}`;
}

/**
 * Génère (si elle n'existe pas déjà) la proposition du mois suivant, à partir
 * du jour configuré du mois en cours. Ne fait rien si c'est trop tôt dans le
 * mois, si la proposition existe déjà pour ce mois cible (idempotent, quel
 * que soit son statut), ou si l'utilisateur n'a aucun événement planner non
 * récurrent ce mois-ci (rien à reprendre).
 */
async function ensureProposalGenerated(userId: string, now: Date): Promise<void> {
  if (now.getUTCDate() < env.BUDGET_PROPOSAL_GENERATE_DAY_OF_MONTH) return;

  const sourceMonth = firstOfMonthUTC(now);
  const targetMonth = addMonthsToFirst(sourceMonth, 1);

  const existing = await pool.query(`SELECT id FROM budget_proposals WHERE user_id = $1 AND target_month = $2`, [
    userId,
    targetMonth,
  ]);
  if (existing.rows[0]) return;

  const sourceMonthEnd = addMonthsToFirst(sourceMonth, 1);
  const { rows: events } = await pool.query<{
    title: string;
    type: "revenu" | "depense";
    category: string;
    amount: string;
    event_date: string;
  }>(
    `SELECT title, type, category, amount, event_date
     FROM planner_events
     WHERE user_id = $1 AND recurrence IS NULL AND event_date >= $2 AND event_date < $3
     ORDER BY event_date ASC`,
    [userId, sourceMonth, sourceMonthEnd],
  );
  // Les événements récurrents sont volontairement exclus : ils ont déjà leur
  // propre mécanisme de report automatique (plannerEventService.setPlannerEventStatus
  // crée la prochaine occurrence à la validation) — les reprendre ici créerait
  // un doublon le mois suivant si la proposition est aussi validée.
  if (!events.length) return;

  const items: BudgetProposalItem[] = events.map((e) => ({
    titre: e.title,
    type: e.type,
    categorie: e.category,
    montant: Number(e.amount),
    jour: dayOfMonth(e.event_date),
  }));

  await pool.query(
    `INSERT INTO budget_proposals (user_id, target_month, source_month, items, generated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, target_month) DO NOTHING`,
    [userId, targetMonth, sourceMonth, JSON.stringify(items), now],
  );
}

/**
 * Cadence de rappel dégressive puis plafonnée : un rappel par jour les
 * BUDGET_PROPOSAL_REMINDER_EARLY_DAYS premiers jours, jusqu'à deux par jour
 * ensuite — jamais plus que BUDGET_PROPOSAL_REMINDER_CAP rappels affichés au
 * total (au-delà, recordReminderShown applique automatiquement la
 * proposition plutôt que de continuer à rappeler indéfiniment).
 */
function computeShouldRemind(proposal: BudgetProposalRow, now: Date): boolean {
  if (proposal.status !== "pending") return false;
  if (proposal.reminder_count === 0) return true;
  if (proposal.reminder_count >= env.BUDGET_PROPOSAL_REMINDER_CAP) return false;

  const daysSinceGenerated = Math.floor((now.getTime() - new Date(proposal.generated_at).getTime()) / 86_400_000);
  const gapHours =
    daysSinceGenerated < env.BUDGET_PROPOSAL_REMINDER_EARLY_DAYS
      ? env.BUDGET_PROPOSAL_REMINDER_GAP_HOURS_EARLY
      : env.BUDGET_PROPOSAL_REMINDER_GAP_HOURS_LATE;

  if (!proposal.last_reminder_at) return true;
  const hoursSinceLast = (now.getTime() - new Date(proposal.last_reminder_at).getTime()) / 3_600_000;
  return hoursSinceLast >= gapHours;
}

/** Point d'entrée principal, appelé par GET /api/budget-proposals/current. */
export async function getCurrentProposal(userId: string, now: Date = new Date()): Promise<ProposalWithReminder | null> {
  await ensureProposalGenerated(userId, now);

  const targetMonth = addMonthsToFirst(firstOfMonthUTC(now), 1);
  const { rows } = await pool.query<BudgetProposalRow>(
    `SELECT * FROM budget_proposals WHERE user_id = $1 AND target_month = $2`,
    [userId, targetMonth],
  );
  const proposal = rows[0];
  if (!proposal) return null;

  const daysSinceGenerated = Math.floor((now.getTime() - new Date(proposal.generated_at).getTime()) / 86_400_000);
  return { proposal, shouldRemind: computeShouldRemind(proposal, now), daysSinceGenerated };
}

/**
 * Intègre les lignes de la proposition (telles quelles, non modifiées) au
 * planner et aux limites du Budget — même logique que la validation côté
 * client du wizard "Proposer un budget mensuel", mais exécutée côté serveur
 * pour l'application automatique au plafond de rappels (voir
 * recordReminderShown). Tolérante aux échecs partiels (une ligne en échec
 * n'empêche pas les autres d'être créées), comme le reste du wizard.
 */
async function applyProposal(userId: string, proposal: BudgetProposalRow): Promise<ApplySummary> {
  const eventErrors: string[] = [];
  let createdEvents = 0;
  for (const item of proposal.items) {
    try {
      await createPlannerEvent(userId, {
        title: item.titre,
        eventDate: dateForDay(proposal.target_month, item.jour),
        eventTime: "09:00",
        durationMinutes: 30,
        type: item.type,
        category: item.categorie,
        amount: item.montant,
      });
      createdEvents++;
    } catch (err) {
      eventErrors.push(`${item.titre} : ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const categoryTotals = new Map<string, number>();
  for (const item of proposal.items) {
    if (item.type !== "depense") continue;
    categoryTotals.set(item.categorie, (categoryTotals.get(item.categorie) ?? 0) + item.montant);
  }
  const budgetErrors: string[] = [];
  let budgetsDone = 0;
  for (const [category, monthlyLimit] of categoryTotals) {
    try {
      await upsertBudget(userId, category, monthlyLimit);
      budgetsDone++;
    } catch (err) {
      budgetErrors.push(`${category} : ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { totalItems: proposal.items.length, createdEvents, eventErrors, budgetsDone, budgetErrors };
}

/**
 * Enregistre qu'un rappel vient d'être affiché à l'utilisateur (appelé par le
 * front uniquement quand getCurrentProposal a renvoyé shouldRemind=true et
 * que la bannière a réellement été montrée). Si ce rappel fait atteindre le
 * plafond, applique automatiquement la proposition telle quelle (principe
 * "défaut raisonnable + action réversible" : mieux vaut un budget actif,
 * modifiable ensuite, que harceler l'utilisateur indéfiniment).
 */
export async function recordReminderShown(
  userId: string,
  proposalId: string,
  now: Date = new Date(),
): Promise<ReminderShownResult> {
  const { rows: beforeRows } = await pool.query<BudgetProposalRow>(
    `SELECT * FROM budget_proposals WHERE id = $1 AND user_id = $2`,
    [proposalId, userId],
  );
  const existing = beforeRows[0];
  if (!existing) throw Errors.budgetProposalNotFound();
  if (existing.status !== "pending") return { proposal: existing, autoApplied: false };

  const { rows: updatedRows } = await pool.query<BudgetProposalRow>(
    `UPDATE budget_proposals SET reminder_count = reminder_count + 1, last_reminder_at = $3
     WHERE id = $1 AND user_id = $2 RETURNING *`,
    [proposalId, userId, now],
  );
  const updated = updatedRows[0]!;

  if (updated.reminder_count < env.BUDGET_PROPOSAL_REMINDER_CAP) {
    return { proposal: updated, autoApplied: false };
  }

  const applySummary = await applyProposal(userId, updated);
  const { rows: appliedRows } = await pool.query<BudgetProposalRow>(
    `UPDATE budget_proposals SET status = 'auto_applied', decided_at = $3 WHERE id = $1 AND user_id = $2 RETURNING *`,
    [proposalId, userId, now],
  );
  return { proposal: appliedRows[0]!, autoApplied: true, applySummary };
}

/**
 * Décision explicite de l'utilisateur : "validated" (après intégration
 * réussie côté client via le wizard pré-rempli — les écritures elles-mêmes
 * passent par /api/planner-events et /api/budgets, cet appel ne fait que
 * clore la proposition) ou "dismissed" (ignorer ce mois, jamais
 * auto-appliquée ensuite). Idempotent : si déjà décidée (y compris
 * auto-appliquée entre-temps), renvoie l'état actuel sans erreur plutôt que
 * d'écraser une décision déjà prise.
 */
export async function decideProposal(
  userId: string,
  proposalId: string,
  status: "validated" | "dismissed",
  now: Date = new Date(),
): Promise<BudgetProposalRow> {
  const { rows } = await pool.query<BudgetProposalRow>(
    `UPDATE budget_proposals SET status = $3, decided_at = $4
     WHERE id = $1 AND user_id = $2 AND status = 'pending'
     RETURNING *`,
    [proposalId, userId, status, now],
  );
  if (rows[0]) return rows[0];

  const current = await pool.query<BudgetProposalRow>(`SELECT * FROM budget_proposals WHERE id = $1 AND user_id = $2`, [
    proposalId,
    userId,
  ]);
  if (!current.rows[0]) throw Errors.budgetProposalNotFound();
  return current.rows[0];
}
