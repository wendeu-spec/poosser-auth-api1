import { pool, withTransaction } from "../db/pool.js";
import { Errors } from "../lib/errors.js";

export interface SavingsGoalRow {
  id: string;
  name: string;
  target_amount: string;
  current_amount: string;
  deadline: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface SavingsGoalContributionRow {
  id: string;
  goal_id: string;
  goal_name: string;
  amount: string;
  created_at: Date;
}

export interface SavingsGoalInput {
  name: string;
  targetAmount: number;
  currentAmount?: number;
  deadline?: string;
}

export async function listSavingsGoals(userId: string): Promise<SavingsGoalRow[]> {
  const { rows } = await pool.query<SavingsGoalRow>(
    `SELECT * FROM savings_goals WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId],
  );
  return rows;
}

export async function createSavingsGoal(userId: string, input: SavingsGoalInput): Promise<SavingsGoalRow> {
  const { rows } = await pool.query<SavingsGoalRow>(
    `INSERT INTO savings_goals (user_id, name, target_amount, current_amount, deadline)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [userId, input.name, input.targetAmount, input.currentAmount ?? 0, input.deadline ?? null],
  );
  return rows[0]!;
}

export async function updateSavingsGoal(
  userId: string,
  id: string,
  input: Partial<SavingsGoalInput>,
): Promise<SavingsGoalRow> {
  const existing = await pool.query(`SELECT id FROM savings_goals WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!existing.rows[0]) throw Errors.savingsGoalNotFound();

  const { rows } = await pool.query<SavingsGoalRow>(
    `UPDATE savings_goals SET
       name = COALESCE($3, name),
       target_amount = COALESCE($4, target_amount),
       current_amount = COALESCE($5, current_amount),
       deadline = COALESCE($6, deadline)
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [id, userId, input.name ?? null, input.targetAmount ?? null, input.currentAmount ?? null, input.deadline ?? null],
  );
  return rows[0]!;
}

export async function deleteSavingsGoal(userId: string, id: string): Promise<void> {
  const { rowCount } = await pool.query(`DELETE FROM savings_goals WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!rowCount) throw Errors.savingsGoalNotFound();
}

/**
 * Enregistre un versement vers un objectif d'épargne (bouton "+ Verser") et
 * journalise la date/montant dans savings_goal_contributions — nécessaire
 * pour que le résumé hebdomadaire puisse répondre à "combien épargné cette
 * semaine ?" avec un vrai chiffre plutôt qu'une approximation.
 *
 * Le solde affiché (current_amount) reste plafonné à l'objectif, comme le
 * faisait déjà le client avant ce changement, mais le montant stocké dans le
 * journal est le montant réellement versé (même si le solde affiché, lui,
 * est plafonné) : c'est le versement réel de l'utilisateur, pas un delta
 * théorique.
 */
export async function addContribution(
  userId: string,
  goalId: string,
  amount: number,
): Promise<{ goal: SavingsGoalRow; contribution: SavingsGoalContributionRow }> {
  return withTransaction(async (client) => {
    const { rows: goalRows } = await client.query<SavingsGoalRow>(
      `SELECT * FROM savings_goals WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [goalId, userId],
    );
    const goal = goalRows[0];
    if (!goal) throw Errors.savingsGoalNotFound();

    const newCurrent = Math.min(Number(goal.current_amount) + amount, Number(goal.target_amount));

    const { rows: updatedRows } = await client.query<SavingsGoalRow>(
      `UPDATE savings_goals SET current_amount = $3 WHERE id = $1 AND user_id = $2 RETURNING *`,
      [goalId, userId, newCurrent],
    );

    const { rows: contribRows } = await client.query<Omit<SavingsGoalContributionRow, "goal_name">>(
      `INSERT INTO savings_goal_contributions (goal_id, user_id, amount) VALUES ($1, $2, $3) RETURNING *`,
      [goalId, userId, amount],
    );

    return {
      goal: updatedRows[0]!,
      contribution: { ...contribRows[0]!, goal_name: goal.name },
    };
  });
}

/**
 * Journal des versements de l'utilisateur, tous objectifs confondus — permet
 * au client de calculer "épargné cette semaine" (ou n'importe quelle autre
 * fenêtre) sans endpoint dédié par période, même principe que les listes
 * complètes déjà exposées ailleurs (transactions, favoris...).
 */
export async function listRecentContributions(userId: string): Promise<SavingsGoalContributionRow[]> {
  const { rows } = await pool.query<SavingsGoalContributionRow>(
    `SELECT c.id, c.goal_id, g.name AS goal_name, c.amount, c.created_at
     FROM savings_goal_contributions c
     JOIN savings_goals g ON g.id = c.goal_id
     WHERE c.user_id = $1
     ORDER BY c.created_at DESC`,
    [userId],
  );
  return rows;
}
