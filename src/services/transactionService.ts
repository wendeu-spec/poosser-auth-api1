import type { PoolClient } from "pg";
import { pool, withTransaction } from "../db/pool.js";
import { Errors } from "../lib/errors.js";
import { assertRubriqueBelongsToProject } from "./rubriqueService.js";
import { assertAccountUsable, ensureDefaultAccount, feeCategoryFor, type AccountType } from "./accountService.js";

export interface TransactionRow {
  id: string;
  type: "revenu" | "depense";
  category: string;
  amount: string;
  occurred_on: string;
  method: string;
  note: string | null;
  project_id: string | null;
  rubrique_id: string | null;
  // Compte du mouvement (obligatoire depuis migrations/029) et, pour une
  // dépense « frais » générée par un virement, le virement d'origine.
  account_id: string;
  transfer_id: string | null;
  // Dépense « frais » d'une opération : l'opération d'origine (migration 031).
  fee_parent_id: string | null;
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
  // Rattachement optionnel à un projet (onglet Projets) — la transaction
  // reste par ailleurs comptée normalement dans le budget et les listes
  // générales (vision consolidée, voir migrations/019_projects.sql).
  projectId?: string;
  // Rattachement optionnel à une rubrique DU projet ci-dessus (postes de
  // dépense à l'intérieur d'un projet, voir migrations/020_rubriques.sql).
  // N'a de sens que si projectId est aussi fourni — vérifié ci-dessous.
  rubriqueId?: string;
  // Compte du mouvement. Absent = compte par défaut de l'utilisateur (son plus
  // ancien compte actif, « Espèces » créé au besoin) : garde compatibles les
  // appels qui ne connaissent pas encore les comptes.
  accountId?: string;
  // Frais payés pour cette opération (0 ou absent = aucun). Enregistrés comme
  // une dépense de frais liée, voir createTransaction.
  fee?: number;
}

// La rubrique n'a de sens qu'à l'intérieur d'un projet donné : on exige donc
// projectId dès que rubriqueId est fourni, et on vérifie que la rubrique
// appartient bien à CE projet (et à l'utilisateur) — jamais une rubrique
// empruntée à un autre projet ou à un autre compte.
// Exportées : réutilisées telles quelles par favoriteService.ts, qui a
// exactement la même règle de cohérence projet/rubrique qu'une transaction
// (un favori est un gabarit de transaction) — une seule source de vérité
// plutôt que de dupliquer cette logique de validation.
export async function assertProjectAndRubriqueConsistent(
  userId: string,
  projectId: string | null | undefined,
  rubriqueId: string | null | undefined,
): Promise<void> {
  if (!rubriqueId) return;
  if (!projectId) throw Errors.validation({ field: "rubriqueId", reason: "requires projectId" });
  await assertRubriqueBelongsToProject(userId, rubriqueId, projectId);
}

// projectId n'a de garde-fou nulle part ailleurs : sans cette vérification,
// un projectId appartenant à un autre utilisateur serait accepté tel quel et
// fausserait silencieusement les totaux agrégés de SON projet (fuite de
// données entre comptes via project_id, voir projectService.SUMMARY_SELECT).
export async function assertProjectOwnedByUser(userId: string, projectId: string): Promise<void> {
  const { rows } = await pool.query(`SELECT id FROM projects WHERE id = $1 AND user_id = $2`, [projectId, userId]);
  if (!rows[0]) throw Errors.projectNotFound();
}

// Toutes les requêtes filtrent systématiquement sur user_id : c'est la seule
// barrière d'isolation entre les données de deux utilisateurs pour ces
// ressources métier — l'oublier sur une seule requête serait une fuite de
// données entre comptes.
export async function listTransactions(userId: string, projectId?: string): Promise<TransactionRow[]> {
  if (projectId) {
    const { rows } = await pool.query<TransactionRow>(
      `SELECT * FROM transactions WHERE user_id = $1 AND project_id = $2 ORDER BY occurred_on DESC, created_at DESC`,
      [userId, projectId],
    );
    return rows;
  }
  const { rows } = await pool.query<TransactionRow>(
    `SELECT * FROM transactions WHERE user_id = $1 ORDER BY occurred_on DESC, created_at DESC`,
    [userId],
  );
  return rows;
}

type Queryable = Pick<PoolClient, "query">;

function feeNote(note: string | null, category: string): string {
  return `Frais · ${note || category}`.slice(0, 280);
}

async function accountTypeOf(db: Queryable, accountId: string): Promise<AccountType> {
  const { rows } = await db.query<{ type: AccountType }>(`SELECT type FROM accounts WHERE id = $1`, [accountId]);
  return rows[0]!.type;
}

/**
 * Crée, met à jour ou supprime la dépense de frais liée à une opération,
 * pour qu'elle suive toujours son opération (même compte, même date, même
 * moyen de paiement, catégorie selon le type de compte). `fee` absent =
 * montant inchangé ; 0 = plus de frais.
 */
async function syncFee(db: Queryable, userId: string, parent: TransactionRow, fee: number | undefined): Promise<TransactionRow | null> {
  const { rows: existingRows } = await db.query<TransactionRow>(
    `SELECT * FROM transactions WHERE fee_parent_id = $1 AND user_id = $2`,
    [parent.id, userId],
  );
  const existing = existingRows[0] ?? null;
  const amount = fee === undefined ? (existing ? Number(existing.amount) : 0) : fee;

  if (amount <= 0) {
    if (existing) await db.query(`DELETE FROM transactions WHERE id = $1 AND user_id = $2`, [existing.id, userId]);
    return null;
  }
  const category = feeCategoryFor(await accountTypeOf(db, parent.account_id));
  const note = feeNote(parent.note, parent.category);
  if (existing) {
    const { rows } = await db.query<TransactionRow>(
      `UPDATE transactions SET amount = $3, occurred_on = $4, method = $5, account_id = $6, category = $7, note = $8
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [existing.id, userId, amount, parent.occurred_on, parent.method, parent.account_id, category, note],
    );
    return rows[0]!;
  }
  const { rows } = await db.query<TransactionRow>(
    `INSERT INTO transactions (user_id, type, category, amount, occurred_on, method, note, account_id, fee_parent_id)
     VALUES ($1, 'depense', $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [userId, category, amount, parent.occurred_on, parent.method, note, parent.account_id, parent.id],
  );
  return rows[0]!;
}

/**
 * Crée une opération et, si `fee` > 0, sa dépense de frais liée — dans une
 * seule transaction SQL : jamais l'une sans l'autre.
 */
export async function createTransaction(
  userId: string,
  input: TransactionInput,
): Promise<{ transaction: TransactionRow; feeTransaction: TransactionRow | null }> {
  if (input.projectId) await assertProjectOwnedByUser(userId, input.projectId);
  await assertProjectAndRubriqueConsistent(userId, input.projectId, input.rubriqueId);

  const accountId = input.accountId
    ? (await assertAccountUsable(userId, input.accountId)).id
    : await ensureDefaultAccount(userId);

  return withTransaction(async (client) => {
    const { rows } = await client.query<TransactionRow>(
      `INSERT INTO transactions (user_id, type, category, amount, occurred_on, method, note, project_id, rubrique_id, account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [userId, input.type, input.category, input.amount, input.occurredOn, input.method, input.note ?? null, input.projectId ?? null, input.rubriqueId ?? null, accountId],
    );
    const transaction = rows[0]!;
    const feeTransaction = input.fee && input.fee > 0 ? await syncFee(client, userId, transaction, input.fee) : null;
    return { transaction, feeTransaction };
  });
}

export async function updateTransaction(
  userId: string,
  id: string,
  input: Partial<TransactionInput> & { note?: string | null; projectId?: string | null; rubriqueId?: string | null },
): Promise<{ transaction: TransactionRow; feeTransaction: TransactionRow | null }> {
  const existing = await pool.query<TransactionRow>(`SELECT * FROM transactions WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!existing.rows[0]) throw Errors.transactionNotFound();
  const current = existing.rows[0]!;
  // Les frais d'un virement suivent leur virement, ceux d'une opération
  // suivent leur opération : on ne les modifie pas directement.
  if (current.transfer_id) throw Errors.transactionLinkedToTransfer();
  if (current.fee_parent_id) throw Errors.transactionIsFee();

  // note/projectId/rubriqueId sont traités en tri-état (absent du body =
  // inchangé, null = effacé/détaché, valeur = remplacé) plutôt qu'avec
  // COALESCE côté SQL : COALESCE ne peut jamais mettre explicitement une
  // colonne à NULL, ce qui empêcherait de retirer la note ou de détacher un
  // projet/une rubrique lors d'une modification (bouton "Modifier" de
  // l'historique). Même approche que parent_rubrique_id dans
  // rubriqueService.updateRubrique().
  const nextNote = "note" in input ? (input.note ?? null) : current.note;
  const nextProjectId = "projectId" in input ? (input.projectId ?? null) : current.project_id;
  const nextRubriqueId = "rubriqueId" in input ? (input.rubriqueId ?? null) : current.rubrique_id;

  if (nextProjectId) await assertProjectOwnedByUser(userId, nextProjectId);
  await assertProjectAndRubriqueConsistent(userId, nextProjectId, nextRubriqueId);

  // Changer de compte : le nouveau doit appartenir à l'utilisateur et être
  // actif. Rester sur un compte depuis archivé reste permis (on corrige un
  // ancien mouvement sans le déplacer).
  if (input.accountId && input.accountId !== current.account_id) {
    await assertAccountUsable(userId, input.accountId);
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query<TransactionRow>(
      `UPDATE transactions SET
         type = COALESCE($3, type),
         category = COALESCE($4, category),
         amount = COALESCE($5, amount),
         occurred_on = COALESCE($6, occurred_on),
         method = COALESCE($7, method),
         note = $8,
         project_id = $9,
         rubrique_id = $10,
         account_id = COALESCE($11, account_id)
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [id, userId, input.type ?? null, input.category ?? null, input.amount ?? null, input.occurredOn ?? null, input.method ?? null, nextNote, nextProjectId, nextRubriqueId, input.accountId ?? null],
    );
    const transaction = rows[0]!;
    const feeTransaction = await syncFee(client, userId, transaction, input.fee);
    return { transaction, feeTransaction };
  });
}

/** Supprime une opération ; sa dépense de frais éventuelle part avec elle (ON DELETE CASCADE). */
export async function deleteTransaction(userId: string, id: string): Promise<void> {
  const existing = await pool.query<{ transfer_id: string | null; fee_parent_id: string | null }>(
    `SELECT transfer_id, fee_parent_id FROM transactions WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  if (!existing.rows[0]) throw Errors.transactionNotFound();
  if (existing.rows[0].transfer_id) throw Errors.transactionLinkedToTransfer();
  if (existing.rows[0].fee_parent_id) throw Errors.transactionIsFee();
  await pool.query(`DELETE FROM transactions WHERE id = $1 AND user_id = $2`, [id, userId]);
}
