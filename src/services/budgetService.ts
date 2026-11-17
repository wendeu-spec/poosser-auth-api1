import { pool } from "../db/pool.js";
import { Errors } from "../lib/errors.js";
import { assertCanCreate } from "./entitlementService.js";

export interface BudgetRow {
  id: string;
  category: string;
  monthly_limit: string;
  created_at: Date;
  updated_at: Date;
}

export async function listBudgets(userId: string): Promise<BudgetRow[]> {
  const { rows } = await pool.query<BudgetRow>(
    `SELECT * FROM budgets WHERE user_id = $1 ORDER BY category ASC`,
    [userId],
  );
  return rows;
}

/**
 * Définir une limite sur une catégorie déjà suivie met à jour la ligne
 * existante plutôt que d'en créer une seconde — comportement upsert déjà
 * présent et validé dans le prototype (voir migrations/015_budgets.sql).
 */
export async function upsertBudget(userId: string, category: string, monthlyLimit: number): Promise<BudgetRow> {
  // Seule la création d'une NOUVELLE catégorie suivie consomme une place :
  // modifier la limite d'un budget existant doit rester possible même au
  // plafond, sinon un utilisateur ne pourrait plus corriger ses propres
  // budgets après un déclassement.
  const existing = await pool.query(
    `SELECT 1 FROM budgets WHERE user_id = $1 AND category = $2`,
    [userId, category],
  );
  if (!existing.rows[0]) await assertCanCreate(userId, "budget");

  const { rows } = await pool.query<BudgetRow>(
    `INSERT INTO budgets (user_id, category, monthly_limit)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, category) DO UPDATE SET monthly_limit = EXCLUDED.monthly_limit
     RETURNING *`,
    [userId, category, monthlyLimit],
  );
  return rows[0]!;
}

export async function deleteBudget(userId: string, id: string): Promise<void> {
  const { rowCount } = await pool.query(`DELETE FROM budgets WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!rowCount) throw Errors.budgetNotFound();
}
