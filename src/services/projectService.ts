import { pool } from "../db/pool.js";
import { Errors } from "../lib/errors.js";

export type ProjectStatus = "actif" | "termine" | "archive";

export interface ProjectRow {
  id: string;
  name: string;
  icon: string;
  target_amount: string | null;
  target_date: string | null;
  status: ProjectStatus;
  created_at: Date;
  updated_at: Date;
}

// Agrégats calculés depuis les transactions rattachées (project_id) — jamais
// stockés : toujours recalculés à la lecture pour rester exacts même si une
// transaction du projet est modifiée ou supprimée ailleurs.
export interface ProjectSummaryRow extends ProjectRow {
  total_in: string;
  total_out: string;
  balance: string;
  transaction_count: string;
}

export interface ProjectInput {
  name: string;
  icon?: string;
  targetAmount?: number;
  targetDate?: string;
  status?: ProjectStatus;
}

const SUMMARY_SELECT = `
  SELECT p.*,
         COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'revenu'), 0)  AS total_in,
         COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'depense'), 0) AS total_out,
         COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'revenu'), 0)
           - COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'depense'), 0) AS balance,
         COUNT(t.id) AS transaction_count
    FROM projects p
    LEFT JOIN transactions t ON t.project_id = p.id
`;

export async function listProjects(userId: string): Promise<ProjectSummaryRow[]> {
  const { rows } = await pool.query<ProjectSummaryRow>(
    `${SUMMARY_SELECT} WHERE p.user_id = $1 GROUP BY p.id ORDER BY p.created_at DESC`,
    [userId],
  );
  return rows;
}

export async function getProject(userId: string, id: string): Promise<ProjectSummaryRow> {
  const { rows } = await pool.query<ProjectSummaryRow>(
    `${SUMMARY_SELECT} WHERE p.id = $1 AND p.user_id = $2 GROUP BY p.id`,
    [id, userId],
  );
  if (!rows[0]) throw Errors.projectNotFound();
  return rows[0];
}

export async function createProject(userId: string, input: ProjectInput): Promise<ProjectRow> {
  const { rows } = await pool.query<ProjectRow>(
    `INSERT INTO projects (user_id, name, icon, target_amount, target_date, status)
     VALUES ($1, $2, COALESCE($3, '📁'), $4, $5, COALESCE($6, 'actif')) RETURNING *`,
    [userId, input.name, input.icon ?? null, input.targetAmount ?? null, input.targetDate ?? null, input.status ?? null],
  );
  return rows[0]!;
}

export async function updateProject(
  userId: string,
  id: string,
  input: Partial<ProjectInput>,
): Promise<ProjectRow> {
  const existing = await pool.query(`SELECT id FROM projects WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!existing.rows[0]) throw Errors.projectNotFound();

  const { rows } = await pool.query<ProjectRow>(
    `UPDATE projects SET
       name          = COALESCE($3, name),
       icon          = COALESCE($4, icon),
       target_amount = COALESCE($5, target_amount),
       target_date   = COALESCE($6, target_date),
       status        = COALESCE($7, status)
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [id, userId, input.name ?? null, input.icon ?? null, input.targetAmount ?? null, input.targetDate ?? null, input.status ?? null],
  );
  return rows[0]!;
}

export async function deleteProject(userId: string, id: string): Promise<void> {
  const { rowCount } = await pool.query(`DELETE FROM projects WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!rowCount) throw Errors.projectNotFound();
}
