import { pool } from "../db/pool.js";
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
