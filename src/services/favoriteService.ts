import { pool } from "../db/pool.js";
import { Errors } from "../lib/errors.js";
import { assertProjectAndRubriqueConsistent, assertProjectOwnedByUser } from "./transactionService.js";

export interface TransactionFavoriteRow {
  id: string;
  user_id: string;
  label: string;
  type: "revenu" | "depense";
  category: string;
  amount: string;
  method: string;
  note: string | null;
  project_id: string | null;
  rubrique_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface TransactionFavoriteInput {
  label: string;
  type: "revenu" | "depense";
  category: string;
  amount: number;
  method: string;
  note?: string | null;
  projectId?: string | null;
  rubriqueId?: string | null;
}

export async function listTransactionFavorites(userId: string): Promise<TransactionFavoriteRow[]> {
  const { rows } = await pool.query<TransactionFavoriteRow>(
    `SELECT * FROM transaction_favorites WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId],
  );
  return rows;
}

export async function createTransactionFavorite(
  userId: string,
  input: TransactionFavoriteInput,
): Promise<TransactionFavoriteRow> {
  if (input.projectId) await assertProjectOwnedByUser(userId, input.projectId);
  await assertProjectAndRubriqueConsistent(userId, input.projectId, input.rubriqueId);

  const { rows } = await pool.query<TransactionFavoriteRow>(
    `INSERT INTO transaction_favorites (user_id, label, type, category, amount, method, note, project_id, rubrique_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      userId,
      input.label,
      input.type,
      input.category,
      input.amount,
      input.method,
      input.note ?? null,
      input.projectId ?? null,
      input.rubriqueId ?? null,
    ],
  );
  return rows[0]!;
}

// Même sémantique tri-état que PATCH /api/transactions/:id (voir
// transactionService.updateTransaction) : note/projectId/rubriqueId absents
// du body = inchangés, null = effacé/détaché, valeur = remplacé.
export async function updateTransactionFavorite(
  userId: string,
  id: string,
  input: Partial<TransactionFavoriteInput>,
): Promise<TransactionFavoriteRow> {
  const existing = await pool.query<TransactionFavoriteRow>(
    `SELECT * FROM transaction_favorites WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  if (!existing.rows[0]) throw Errors.transactionFavoriteNotFound();
  const current = existing.rows[0]!;

  const nextNote = "note" in input ? (input.note ?? null) : current.note;
  const nextProjectId = "projectId" in input ? (input.projectId ?? null) : current.project_id;
  const nextRubriqueId = "rubriqueId" in input ? (input.rubriqueId ?? null) : current.rubrique_id;

  if (nextProjectId) await assertProjectOwnedByUser(userId, nextProjectId);
  await assertProjectAndRubriqueConsistent(userId, nextProjectId, nextRubriqueId);

  const { rows } = await pool.query<TransactionFavoriteRow>(
    `UPDATE transaction_favorites SET
       label    = COALESCE($3, label),
       type     = COALESCE($4, type),
       category = COALESCE($5, category),
       amount   = COALESCE($6, amount),
       method   = COALESCE($7, method),
       note     = $8,
       project_id = $9,
       rubrique_id = $10
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [
      id,
      userId,
      input.label ?? null,
      input.type ?? null,
      input.category ?? null,
      input.amount ?? null,
      input.method ?? null,
      nextNote,
      nextProjectId,
      nextRubriqueId,
    ],
  );
  return rows[0]!;
}

export async function deleteTransactionFavorite(userId: string, id: string): Promise<void> {
  const { rowCount } = await pool.query(
    `DELETE FROM transaction_favorites WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  if (!rowCount) throw Errors.transactionFavoriteNotFound();
}
