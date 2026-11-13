import type { PoolClient } from "pg";
import { pool, withTransaction } from "../db/pool.js";
import { Errors } from "../lib/errors.js";
import type { TransactionRow } from "./transactionService.js";

/**
 * Comptes (Espèces, Mobile Money, banque, épargne...) et virements entre
 * comptes — voir migrations/029_accounts_transfers.sql pour les choix
 * structurants (rattachement obligatoire, virement neutre + frais en dépense).
 *
 * Comme partout ailleurs dans le module métier, CHAQUE requête filtre sur
 * user_id : un compte ou un virement d'un autre utilisateur est traité comme
 * inexistant (404), jamais comme interdit (403), pour ne rien révéler.
 */

export const ACCOUNT_TYPES = ["especes", "mobile_money", "banque", "epargne", "autre"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

// Moyen de paiement implicite d'un compte : reporté sur la dépense « frais »
// d'un virement (la colonne transactions.method reste obligatoire).
export const METHOD_BY_ACCOUNT_TYPE: Record<AccountType, string> = {
  especes: "Espèces",
  mobile_money: "Mobile Money",
  banque: "Virement bancaire",
  epargne: "Autre",
  autre: "Autre",
};

export const TRANSFER_FEE_CATEGORY = "Frais Mobile Money";
export const DEFAULT_ACCOUNT_NAME = "Espèces";

export interface AccountRow {
  id: string;
  user_id: string;
  name: string;
  type: AccountType;
  opening_balance: string;
  archived: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface AccountWithBalanceRow extends AccountRow {
  balance: string;
}

export interface TransferRow {
  id: string;
  user_id: string;
  from_account_id: string;
  to_account_id: string;
  amount: string;
  fee: string;
  occurred_on: string;
  note: string | null;
  created_at: Date;
  updated_at: Date;
}

type Queryable = Pick<PoolClient, "query">;

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

/**
 * Renvoie l'id du compte par défaut de l'utilisateur (son plus ancien compte
 * actif), en créant le compte « Espèces » s'il n'en a encore aucun — cas d'un
 * utilisateur inscrit après la migration 029. Idempotent même en cas d'appels
 * concurrents (index unique sur le nom + ON CONFLICT DO NOTHING).
 */
export async function ensureDefaultAccount(userId: string, db: Queryable = pool): Promise<string> {
  const find = () =>
    db.query<{ id: string }>(
      `SELECT id FROM accounts WHERE user_id = $1 AND archived = false ORDER BY created_at ASC, id ASC LIMIT 1`,
      [userId],
    );
  const existing = await find();
  if (existing.rows[0]) return existing.rows[0].id;
  await db.query(
    `INSERT INTO accounts (user_id, name, type) VALUES ($1, $2, 'especes')
     ON CONFLICT (user_id, lower(name)) DO NOTHING`,
    [userId, DEFAULT_ACCOUNT_NAME],
  );
  const created = await find();
  if (created.rows[0]) return created.rows[0].id;
  // Un compte « Espèces » existe déjà mais il est archivé (et c'était le seul
  // compte) : on le réactive plutôt que d'en créer un second.
  const { rows } = await db.query<{ id: string }>(
    `UPDATE accounts SET archived = false
     WHERE user_id = $1 AND lower(name) = lower($2) RETURNING id`,
    [userId, DEFAULT_ACCOUNT_NAME],
  );
  return rows[0]!.id;
}

async function getOwnedAccount(userId: string, id: string, db: Queryable = pool): Promise<AccountRow> {
  const { rows } = await db.query<AccountRow>(`SELECT * FROM accounts WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!rows[0]) throw Errors.accountNotFound();
  return rows[0];
}

/**
 * Vérifie qu'un compte appartient à l'utilisateur ET peut recevoir un nouveau
 * mouvement (non archivé). Utilisé par transactionService et par les virements.
 */
export async function assertAccountUsable(userId: string, accountId: string, db: Queryable = pool): Promise<AccountRow> {
  const account = await getOwnedAccount(userId, accountId, db);
  if (account.archived) throw Errors.accountArchived();
  return account;
}

/** Vérifie seulement l'appartenance (un mouvement existant peut rester sur un compte archivé). */
export async function assertAccountOwned(userId: string, accountId: string): Promise<AccountRow> {
  return getOwnedAccount(userId, accountId);
}

const BALANCE_SELECT = `
  SELECT a.*,
    (a.opening_balance
      + COALESCE((SELECT SUM(CASE WHEN t.type = 'revenu' THEN t.amount ELSE -t.amount END)
                  FROM transactions t WHERE t.account_id = a.id), 0)
      + COALESCE((SELECT SUM(tr.amount) FROM transfers tr WHERE tr.to_account_id = a.id), 0)
      - COALESCE((SELECT SUM(tr.amount) FROM transfers tr WHERE tr.from_account_id = a.id), 0)
    )::numeric(14, 2) AS balance
  FROM accounts a`;

export async function listAccounts(userId: string): Promise<AccountWithBalanceRow[]> {
  await ensureDefaultAccount(userId);
  const { rows } = await pool.query<AccountWithBalanceRow>(
    `${BALANCE_SELECT} WHERE a.user_id = $1 ORDER BY a.archived ASC, a.created_at ASC, a.id ASC`,
    [userId],
  );
  return rows;
}

async function getAccountWithBalance(userId: string, id: string): Promise<AccountWithBalanceRow> {
  const { rows } = await pool.query<AccountWithBalanceRow>(`${BALANCE_SELECT} WHERE a.id = $1 AND a.user_id = $2`, [id, userId]);
  if (!rows[0]) throw Errors.accountNotFound();
  return rows[0];
}

export interface AccountInput {
  name: string;
  type: AccountType;
  openingBalance?: number;
}

export async function createAccount(userId: string, input: AccountInput): Promise<AccountWithBalanceRow> {
  // Le compte « Espèces » d'office (choix validé, voir migration 029) doit
  // exister AVANT le premier compte personnalisé : sinon un utilisateur dont
  // la première action est de créer « MoMo » n'aurait jamais de compte
  // Espèces, et MoMo deviendrait son compte par défaut.
  await ensureDefaultAccount(userId);
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO accounts (user_id, name, type, opening_balance) VALUES ($1, $2, $3, $4) RETURNING id`,
      [userId, input.name.trim(), input.type, input.openingBalance ?? 0],
    );
    return getAccountWithBalance(userId, rows[0]!.id);
  } catch (err) {
    if (isUniqueViolation(err)) throw Errors.accountNameTaken();
    throw err;
  }
}

async function countActiveAccounts(userId: string, db: Queryable = pool): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM accounts WHERE user_id = $1 AND archived = false`,
    [userId],
  );
  return Number(rows[0]!.n);
}

export async function updateAccount(
  userId: string,
  id: string,
  input: Partial<AccountInput> & { archived?: boolean },
): Promise<AccountWithBalanceRow> {
  const current = await getOwnedAccount(userId, id);
  if (input.archived === true && !current.archived && (await countActiveAccounts(userId)) <= 1) {
    throw Errors.accountLastActive();
  }
  try {
    await pool.query(
      `UPDATE accounts SET
         name = COALESCE($3, name),
         type = COALESCE($4, type),
         opening_balance = COALESCE($5, opening_balance),
         archived = COALESCE($6, archived)
       WHERE id = $1 AND user_id = $2`,
      [id, userId, input.name?.trim() ?? null, input.type ?? null, input.openingBalance ?? null, input.archived ?? null],
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw Errors.accountNameTaken();
    throw err;
  }
  return getAccountWithBalance(userId, id);
}

/**
 * Supprime un compte jamais utilisé. Un compte qui porte des mouvements ou
 * des virements ne se supprime pas (son historique en dépend) : il faut
 * l'archiver. Le dernier compte actif ne peut pas non plus disparaître.
 */
export async function deleteAccount(userId: string, id: string): Promise<void> {
  const account = await getOwnedAccount(userId, id);
  const { rows } = await pool.query<{ used: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM transactions WHERE account_id = $1)
         OR EXISTS (SELECT 1 FROM transfers WHERE from_account_id = $1 OR to_account_id = $1) AS used`,
    [id],
  );
  if (rows[0]!.used) throw Errors.accountInUse();
  if (!account.archived && (await countActiveAccounts(userId)) <= 1) throw Errors.accountLastActive();
  await pool.query(`DELETE FROM accounts WHERE id = $1 AND user_id = $2`, [id, userId]);
}

// ---------------------------------------------------------------------------
// Virements
// ---------------------------------------------------------------------------

export async function listTransfers(userId: string): Promise<TransferRow[]> {
  const { rows } = await pool.query<TransferRow>(
    `SELECT * FROM transfers WHERE user_id = $1 ORDER BY occurred_on DESC, created_at DESC`,
    [userId],
  );
  return rows;
}

export interface TransferInput {
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  fee?: number;
  occurredOn: string;
  note?: string;
}

/**
 * Crée un virement neutre entre deux comptes de l'utilisateur. Si des frais
 * sont indiqués, une vraie dépense « Frais Mobile Money » est créée sur le
 * compte débité, liée au virement (transfer_id) — le tout dans une seule
 * transaction SQL : jamais un virement sans ses frais, ni l'inverse.
 */
export async function createTransfer(
  userId: string,
  input: TransferInput,
): Promise<{ transfer: TransferRow; feeTransaction: TransactionRow | null }> {
  if (input.fromAccountId === input.toAccountId) {
    throw Errors.validation({ field: "toAccountId", reason: "must differ from fromAccountId" });
  }
  return withTransaction(async (client) => {
    const from = await assertAccountUsable(userId, input.fromAccountId, client);
    const to = await assertAccountUsable(userId, input.toAccountId, client);
    const fee = input.fee ?? 0;

    const { rows } = await client.query<TransferRow>(
      `INSERT INTO transfers (user_id, from_account_id, to_account_id, amount, fee, occurred_on, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [userId, from.id, to.id, input.amount, fee, input.occurredOn, input.note ?? null],
    );
    const transfer = rows[0]!;

    let feeTransaction: TransactionRow | null = null;
    if (fee > 0) {
      const feeRes = await client.query<TransactionRow>(
        `INSERT INTO transactions (user_id, type, category, amount, occurred_on, method, note, account_id, transfer_id)
         VALUES ($1, 'depense', $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          userId,
          TRANSFER_FEE_CATEGORY,
          fee,
          input.occurredOn,
          METHOD_BY_ACCOUNT_TYPE[from.type],
          `Frais de virement : ${from.name} → ${to.name}`,
          from.id,
          transfer.id,
        ],
      );
      feeTransaction = feeRes.rows[0]!;
    }
    return { transfer, feeTransaction };
  });
}

/** Supprime un virement ; sa dépense « frais » éventuelle part avec lui (ON DELETE CASCADE). */
export async function deleteTransfer(userId: string, id: string): Promise<void> {
  const { rowCount } = await pool.query(`DELETE FROM transfers WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!rowCount) throw Errors.transferNotFound();
}
