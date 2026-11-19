import type { PoolClient } from "pg";
import { pool, withTransaction } from "../db/pool.js";
import { assertCanCreate } from "./entitlementService.js";
import {
  accountBalanceOf,
  assertAccountUsable,
  createTransferIn,
  ensureDefaultAccount,
  type TransferRow,
} from "./accountService.js";
import type { TransactionRow } from "./transactionService.js";
import { Errors } from "../lib/errors.js";

/**
 * Épargne adossée à un compte réel — voir migrations/033 pour les choix
 * structurants validés avec Yannis.
 *
 * Le point à garder en tête : current_amount n'est PAS une poche séparée, c'est
 * une RÉSERVATION sur le compte hôte. L'argent épargné est encore dans le
 * compte ; il est simplement mis de côté. D'où l'invariant appliqué par
 * assertReservationsFit : pour un compte donné, la somme des réservations de
 * tous les objectifs ne peut pas dépasser son solde.
 *
 * Sans cet invariant on retomberait dans le défaut d'origine, où l'épargne
 * était de l'argent créé à partir de rien et apparaissait deux fois sur le
 * tableau de bord (une fois dans « Disponible », une fois dans « Épargne »).
 */

/** Provenance d'un mouvement d'épargne (migrations/033). */
export const SAVINGS_MOVEMENT_KINDS = ["reservation", "virement"] as const;
export type SavingsMovementKind = (typeof SAVINGS_MOVEMENT_KINDS)[number];

// Les montants sont des NUMERIC(14, 2) : on compare au centime près plutôt
// qu'à l'égalité stricte, pour qu'une somme de décimales ne refuse pas un
// versement légitime.
const EPSILON = 0.005;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface SavingsGoalRow {
  id: string;
  name: string;
  target_amount: string;
  current_amount: string;
  deadline: string | null;
  /** Compte où se trouve réellement l'argent réservé. NULL = objectif héritée non rattachée. */
  account_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface SavingsGoalContributionRow {
  id: string;
  goal_id: string;
  goal_name: string;
  /** Signé : positif = versement, négatif = retrait. */
  amount: string;
  kind: SavingsMovementKind;
  transfer_id: string | null;
  created_at: Date;
}

export interface SavingsGoalInput {
  name: string;
  targetAmount: number;
  currentAmount?: number;
  deadline?: string;
  accountId?: string;
}

/** Résultat commun d'un versement et d'un retrait. */
export interface SavingsMovementResult {
  goal: SavingsGoalRow;
  contribution: SavingsGoalContributionRow;
  /** Renseigné uniquement en mode « virement ». */
  transfer: TransferRow | null;
  /** Dépense de frais du virement, le cas échéant. */
  feeTransaction: TransactionRow | null;
}

export async function listSavingsGoals(userId: string): Promise<SavingsGoalRow[]> {
  const { rows } = await pool.query<SavingsGoalRow>(
    `SELECT * FROM savings_goals WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Invariant « une réservation ne dépasse pas l'argent du compte »
// ---------------------------------------------------------------------------

async function reservedOnAccount(client: PoolClient, userId: string, accountId: string): Promise<number> {
  const { rows } = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(current_amount), 0) AS total
       FROM savings_goals WHERE user_id = $1 AND account_id = $2`,
    [userId, accountId],
  );
  return Number(rows[0]!.total);
}

/**
 * À appeler APRÈS avoir écrit la nouvelle réservation (et, en mode virement,
 * après avoir écrit le virement) : la vérification porte alors sur l'état réel
 * de la transaction SQL en cours, et un dépassement la fait entièrement
 * annuler. Vérifier avant l'écriture obligerait à refaire l'arithmétique à la
 * main et laisserait passer les cas concurrents.
 *
 * `attempted` ne sert qu'à construire un message utile (« il ne reste que X
 * sur ce compte ») ; il n'entre pas dans la décision.
 */
async function assertReservationsFit(
  client: PoolClient,
  userId: string,
  accountId: string,
  attempted: number,
): Promise<void> {
  const balance = await accountBalanceOf(userId, accountId, client);
  const reserved = await reservedOnAccount(client, userId, accountId);
  if (reserved > balance + EPSILON) {
    throw Errors.savingsExceedsAccount({
      accountId,
      accountBalance: round2(balance),
      reservedAfter: round2(reserved),
      requested: round2(attempted),
      maxAllowed: round2(Math.max(balance - (reserved - attempted), 0)),
    });
  }
}

async function lockGoal(client: PoolClient, userId: string, goalId: string): Promise<SavingsGoalRow> {
  const { rows } = await client.query<SavingsGoalRow>(
    `SELECT * FROM savings_goals WHERE id = $1 AND user_id = $2 FOR UPDATE`,
    [goalId, userId],
  );
  const goal = rows[0];
  if (!goal) throw Errors.savingsGoalNotFound();
  return goal;
}

async function setCurrent(
  client: PoolClient,
  userId: string,
  goalId: string,
  value: number,
): Promise<SavingsGoalRow> {
  const { rows } = await client.query<SavingsGoalRow>(
    `UPDATE savings_goals SET current_amount = $3 WHERE id = $1 AND user_id = $2 RETURNING *`,
    [goalId, userId, value],
  );
  return rows[0]!;
}

async function journalMovement(
  client: PoolClient,
  userId: string,
  goal: SavingsGoalRow,
  signedAmount: number,
  kind: SavingsMovementKind,
  transferId: string | null,
): Promise<SavingsGoalContributionRow> {
  const { rows } = await client.query<Omit<SavingsGoalContributionRow, "goal_name">>(
    `INSERT INTO savings_goal_contributions (goal_id, user_id, amount, kind, transfer_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [goal.id, userId, signedAmount, kind, transferId],
  );
  return { ...rows[0]!, goal_name: goal.name };
}

// ---------------------------------------------------------------------------
// Objectifs
// ---------------------------------------------------------------------------

export async function createSavingsGoal(userId: string, input: SavingsGoalInput): Promise<SavingsGoalRow> {
  await assertCanCreate(userId, "savings_goal");
  return withTransaction(async (client) => {
    // Pas de compte précisé : le compte par défaut, comme partout ailleurs
    // (une opération, une échéance...). Un objectif sans compte hôte n'aurait
    // aucun sens maintenant que l'épargne est une réservation.
    const accountId = input.accountId
      ? (await assertAccountUsable(userId, input.accountId, client)).id
      : await ensureDefaultAccount(userId, client);

    const current = round2(input.currentAmount ?? 0);
    const { rows } = await client.query<SavingsGoalRow>(
      `INSERT INTO savings_goals (user_id, name, target_amount, current_amount, deadline, account_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [userId, input.name, input.targetAmount, current, input.deadline ?? null, accountId],
    );

    // « Montant déjà épargné » : c'est de l'argent qui est DÉJÀ sur le compte,
    // donc une réservation immédiate — soumise au même invariant.
    //
    // Volontairement PAS journalisé : ce n'est pas un versement du jour. Le
    // journaliser ferait apparaître 165 000 FCFA « épargnés cette semaine »
    // dans le résumé hebdomadaire pour de l'argent mis de côté depuis des
    // mois. La somme du journal n'est donc pas censée égaler current_amount.
    if (current > 0) await assertReservationsFit(client, userId, accountId, current);

    return rows[0]!;
  });
}

export async function updateSavingsGoal(
  userId: string,
  id: string,
  input: Partial<SavingsGoalInput>,
): Promise<SavingsGoalRow> {
  return withTransaction(async (client) => {
    const existing = await lockGoal(client, userId, id);

    const nextAccountId = input.accountId
      ? (await assertAccountUsable(userId, input.accountId, client)).id
      : existing.account_id;

    const { rows } = await client.query<SavingsGoalRow>(
      `UPDATE savings_goals SET
         name = COALESCE($3, name),
         target_amount = COALESCE($4, target_amount),
         current_amount = COALESCE($5, current_amount),
         deadline = COALESCE($6, deadline),
         account_id = $7
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [
        id,
        userId,
        input.name ?? null,
        input.targetAmount ?? null,
        input.currentAmount !== undefined ? round2(input.currentAmount) : null,
        input.deadline ?? null,
        nextAccountId,
      ],
    );
    const updated = rows[0]!;

    // Corriger le montant déjà épargné, ou déplacer l'objectif sur un autre
    // compte, peut faire dépasser le compte d'arrivée : on revérifie. Le
    // compte de départ, lui, se retrouve moins chargé — rien à vérifier.
    if (nextAccountId) {
      await assertReservationsFit(client, userId, nextAccountId, Number(updated.current_amount));
    }
    return updated;
  });
}

/**
 * Supprime un objectif. Sa réservation disparaît avec lui : l'argent redevient
 * disponible sur le compte hôte, ce qui est le comportement attendu — on
 * renonce à l'objectif, pas à l'argent. Les lignes de journal partent en
 * cascade (migrations/023) ; les virements réels, eux, restent dans
 * l'historique des comptes, puisque l'argent a bel et bien bougé.
 */
export async function deleteSavingsGoal(userId: string, id: string): Promise<void> {
  const { rowCount } = await pool.query(`DELETE FROM savings_goals WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!rowCount) throw Errors.savingsGoalNotFound();
}

// ---------------------------------------------------------------------------
// Versements et retraits
// ---------------------------------------------------------------------------

export interface SavingsMovementInput {
  amount: number;
  mode: SavingsMovementKind;
  /**
   * Mode « virement » uniquement. Pour un versement : le compte d'où vient
   * l'argent. Pour un retrait : le compte où il repart.
   */
  counterpartAccountId?: string;
  fee?: number;
  occurredOn?: string;
  note?: string;
}

function requireCounterpart(input: SavingsMovementInput): string {
  if (!input.counterpartAccountId) {
    throw Errors.validation({ field: "counterpartAccountId", reason: "required when mode is virement" });
  }
  return input.counterpartAccountId;
}

/**
 * Versement vers un objectif (bouton « + Verser »).
 *
 * Mode « reservation » : l'argent est déjà sur le compte hôte, on met
 * simplement une part de côté. Aucune opération, aucun virement — c'est
 * l'épargne informelle (espèces à la maison, argent laissé sur MoMo).
 *
 * Mode « virement » : vrai virement du compte source vers le compte hôte,
 * visible dans l'historique, frais compris. Le virement, ses frais et la
 * réservation sont écrits dans UNE SEULE transaction SQL : jamais un virement
 * sans sa réservation, ni l'inverse.
 */
export async function addContribution(
  userId: string,
  goalId: string,
  input: SavingsMovementInput,
): Promise<SavingsMovementResult> {
  return withTransaction(async (client) => {
    const goal = await lockGoal(client, userId, goalId);
    const hostId = goal.account_id;
    if (!hostId) throw Errors.savingsGoalAccountMissing();
    await assertAccountUsable(userId, hostId, client);

    let transfer: TransferRow | null = null;
    let feeTransaction: TransactionRow | null = null;
    if (input.mode === "virement") {
      const res = await createTransferIn(client, userId, {
        fromAccountId: requireCounterpart(input),
        toAccountId: hostId,
        amount: input.amount,
        fee: input.fee ?? 0,
        occurredOn: input.occurredOn ?? todayUtc(),
        note: input.note ?? `Épargne : ${goal.name}`,
      });
      transfer = res.transfer;
      feeTransaction = res.feeTransaction;
    }

    // Plus de plafonnement à l'objectif (l'ancien Math.min) : un objectif peut
    // être dépassé, 600 000 sur 500 000 s'affiche 120 %. Plafonner faisait
    // disparaître le surplus du total affiché alors qu'il était bel et bien
    // enregistré dans le journal — de l'argent perdu de vue.
    const updated = await setCurrent(client, userId, goalId, round2(Number(goal.current_amount) + input.amount));
    await assertReservationsFit(client, userId, hostId, input.amount);

    const contribution = await journalMovement(client, userId, goal, input.amount, input.mode, transfer?.id ?? null);
    return { goal: updated, contribution, transfer, feeTransaction };
  });
}

/**
 * Retrait d'un objectif (bouton « − Retirer »). Indispensable dès lors que
 * l'épargne est une réservation : sans lui, mettre de l'argent de côté
 * baisserait le « disponible » définitivement, sans retour possible.
 *
 * Mode « reservation » : on relâche simplement la part réservée, elle
 * redevient disponible sur le compte hôte. Mode « virement » : l'argent part
 * réellement du compte hôte vers un autre compte.
 */
export async function withdrawContribution(
  userId: string,
  goalId: string,
  input: SavingsMovementInput,
): Promise<SavingsMovementResult> {
  return withTransaction(async (client) => {
    const goal = await lockGoal(client, userId, goalId);
    const hostId = goal.account_id;
    if (!hostId) throw Errors.savingsGoalAccountMissing();

    const current = Number(goal.current_amount);
    if (input.amount > current + EPSILON) {
      throw Errors.savingsWithdrawalTooLarge({ requested: round2(input.amount), available: round2(current) });
    }

    let transfer: TransferRow | null = null;
    let feeTransaction: TransactionRow | null = null;
    if (input.mode === "virement") {
      await assertAccountUsable(userId, hostId, client);
      const res = await createTransferIn(client, userId, {
        fromAccountId: hostId,
        toAccountId: requireCounterpart(input),
        amount: input.amount,
        fee: input.fee ?? 0,
        occurredOn: input.occurredOn ?? todayUtc(),
        note: input.note ?? `Retrait d'épargne : ${goal.name}`,
      });
      transfer = res.transfer;
      feeTransaction = res.feeTransaction;
    }

    const updated = await setCurrent(client, userId, goalId, round2(Math.max(current - input.amount, 0)));

    // La réservation baisse, donc l'invariant se détend... sauf si des frais
    // de virement ont été prélevés sur le compte hôte : son solde baisse alors
    // de plus que la réservation libérée, et un autre objectif hébergé sur le
    // même compte pourrait se retrouver à découvert. D'où la revérification.
    await assertReservationsFit(client, userId, hostId, 0);

    const contribution = await journalMovement(client, userId, goal, -input.amount, input.mode, transfer?.id ?? null);
    return { goal: updated, contribution, transfer, feeTransaction };
  });
}

/**
 * Journal des mouvements d'épargne de l'utilisateur, tous objectifs confondus
 * — permet au client de calculer « épargné cette semaine » (ou n'importe
 * quelle autre fenêtre) sans endpoint dédié par période, même principe que les
 * listes complètes déjà exposées ailleurs (transactions, favoris...).
 *
 * Les montants sont signés depuis la migration 033 : un retrait est négatif.
 */
export async function listRecentContributions(userId: string): Promise<SavingsGoalContributionRow[]> {
  const { rows } = await pool.query<SavingsGoalContributionRow>(
    `SELECT c.id, c.goal_id, g.name AS goal_name, c.amount, c.kind, c.transfer_id, c.created_at
     FROM savings_goal_contributions c
     JOIN savings_goals g ON g.id = c.goal_id
     WHERE c.user_id = $1
     ORDER BY c.created_at DESC`,
    [userId],
  );
  return rows;
}
