import { pool } from "../db/pool.js";
import { Errors } from "../lib/errors.js";

export interface RubriqueRow {
  id: string;
  project_id: string;
  name: string;
  planned_amount: string | null;
  position: number;
  created_at: Date;
  updated_at: Date;
}

export interface RubriqueInput {
  name: string;
  plannedAmount?: number;
}

// Vérifie que le projet appartient bien à l'utilisateur avant toute opération
// sur ses rubriques — même garde-fou que projectService, nécessaire ici en
// plus car les rubriques n'ont pas directement de colonne user_id.
async function assertProjectOwnership(userId: string, projectId: string): Promise<void> {
  const { rows } = await pool.query(`SELECT id FROM projects WHERE id = $1 AND user_id = $2`, [projectId, userId]);
  if (!rows[0]) throw Errors.projectNotFound();
}

// Liste les rubriques de l'utilisateur, optionnellement filtrées sur un seul
// projet. Ne renvoie QUE les champs stables (nom, enveloppe) — jamais de
// montant réel dépensé pré-calculé : comme pour les projets (voir
// mapProjectFromApi côté front), ce total doit toujours être recalculé depuis
// les transactions pour ne jamais se désynchroniser.
export async function listRubriques(userId: string, projectId?: string): Promise<RubriqueRow[]> {
  if (projectId) {
    await assertProjectOwnership(userId, projectId);
    const { rows } = await pool.query<RubriqueRow>(
      `SELECT r.* FROM rubriques r WHERE r.project_id = $1 ORDER BY r.position ASC, r.created_at ASC`,
      [projectId],
    );
    return rows;
  }
  const { rows } = await pool.query<RubriqueRow>(
    `SELECT r.* FROM rubriques r
       JOIN projects p ON p.id = r.project_id
      WHERE p.user_id = $1
      ORDER BY r.project_id, r.position ASC, r.created_at ASC`,
    [userId],
  );
  return rows;
}

export async function createRubrique(userId: string, projectId: string, input: RubriqueInput): Promise<RubriqueRow> {
  await assertProjectOwnership(userId, projectId);
  const { rows: posRows } = await pool.query<{ next_position: number }>(
    `SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM rubriques WHERE project_id = $1`,
    [projectId],
  );
  const { rows } = await pool.query<RubriqueRow>(
    `INSERT INTO rubriques (project_id, name, planned_amount, position)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [projectId, input.name, input.plannedAmount ?? null, posRows[0]!.next_position],
  );
  return rows[0]!;
}

export async function updateRubrique(
  userId: string,
  projectId: string,
  id: string,
  input: Partial<RubriqueInput>,
): Promise<RubriqueRow> {
  await assertProjectOwnership(userId, projectId);
  const existing = await pool.query(`SELECT id FROM rubriques WHERE id = $1 AND project_id = $2`, [id, projectId]);
  if (!existing.rows[0]) throw Errors.rubriqueNotFound();

  const { rows } = await pool.query<RubriqueRow>(
    `UPDATE rubriques SET
       name           = COALESCE($3, name),
       planned_amount = COALESCE($4, planned_amount)
     WHERE id = $1 AND project_id = $2
     RETURNING *`,
    [id, projectId, input.name ?? null, input.plannedAmount ?? null],
  );
  return rows[0]!;
}

export async function deleteRubrique(userId: string, projectId: string, id: string): Promise<void> {
  await assertProjectOwnership(userId, projectId);
  const { rowCount } = await pool.query(`DELETE FROM rubriques WHERE id = $1 AND project_id = $2`, [id, projectId]);
  if (!rowCount) throw Errors.rubriqueNotFound();
}

// Utilisé par transactionService pour valider rubriqueId à la création/mise à
// jour d'une transaction : la rubrique doit exister, appartenir à
// l'utilisateur (via son projet), et correspondre au projectId fourni sur la
// même transaction — on n'autorise jamais une rubrique d'un autre projet.
export async function assertRubriqueBelongsToProject(userId: string, rubriqueId: string, projectId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT r.id FROM rubriques r
       JOIN projects p ON p.id = r.project_id
      WHERE r.id = $1 AND r.project_id = $2 AND p.user_id = $3`,
    [rubriqueId, projectId, userId],
  );
  if (!rows[0]) throw Errors.rubriqueNotFound();
}
