import { pool } from "../db/pool.js";
import { Errors } from "../lib/errors.js";

export interface TransactionRow {
  id: string;
  type: "revenu" | "depense";
  category: string;
  amount: string;
  occurred_on: string;
  method: string;
  note: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface TransactionInput {
  type: "revenu" | "depense";
  category: string;
  amount: number;
  occurredOn: string;
  method: string;
  note?: string;
}

// Toutes les requêtes filtrent systématiquement sur user_id : c'est la seule
// barrière d'isolation entre les données de deux utilisateurs pour ces
// ressources métier — l'oublier sur une seule requête serait une fuite de
// données entre comptes.
export async function listTransactions(userId: string): Promise<TransactionRow[]> {
  const { rows } = await pool.query<TransactionRow>(
    `SELECT * FROM transactions WHERE user_id = $1 ORDER BY occurred_on DESC, created_at DESC`,
    [userId],
  );
  return rows;
}

export async function createTransaction(userId: string, input: TransactionInput): Promise<TransactionRow> {
  const { rows } = await pool.query<TransactionRow>(
    `INSERT INTO transactions (user_id, type, category, amount, occurred_on, method, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [userId, input.type, input.category, input.amount, input.occurredOn, input.method, input.note ?? null],
  );
  return rows[0]!;
}

export async function updateTransaction(
  userId: string,
  id: string,
  input: Partial<TransactionInput>,
): Promise<TransactionRow> {
  const existing = await pool.query(`SELECT id FROM transactions WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!existing.rows[0]) throw Errors.transactionNotFound();

  const { rows } = await pool.query<TransactionRow>(
    `UPDATE transactions SET
       type = COALESCE($3, type),
       category = COALESCE($4, category),
       amount = COALESCE($5, amount),
       occurred_on = COALESCE($6, occurred_on),
       method = COALESCE($7, method),
       note = COALESCE($8, note)
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [id, userId, input.type ?? null, input.category ?? null, input.amount ?? null, input.occurredOn ?? null, input.method ?? null, input.note ?? null],
  );
  return rows[0]!;
}

export async function deleteTransaction(userId: string, id: string): Promise<void> {
  const { rowCount } = await pool.query(`DELETE FROM transactions WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!rowCount) throw Errors.transactionNotFound();
}
