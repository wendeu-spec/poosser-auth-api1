import { pool, withTransaction } from "../db/pool.js";
import { Errors } from "../lib/errors.js";
import { assertAccountUsable, ensureDefaultAccount, METHOD_BY_ACCOUNT_TYPE, type AccountType } from "./accountService.js";
import type { TransactionRow } from "./transactionService.js";

export type RecurrenceFrequency = "hebdomadaire" | "mensuelle" | "trimestrielle";

export interface PlannerEventRow {
  id: string;
  title: string;
  event_date: string;
  event_time: string;
  duration_minutes: number;
  type: "revenu" | "depense";
  category: string;
  amount: string;
  status: "a_venir" | "realise" | "non_realise";
  recurrence: RecurrenceFrequency | null;
  account_id: string | null;
  transaction_id: string | null;
  notified_start: boolean;
  notified_end: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface PlannerEventInput {
  title: string;
  eventDate: string;
  eventTime: string;
  durationMinutes: number;
  type: "revenu" | "depense";
  category: string;
  amount: number;
  recurrence?: RecurrenceFrequency | null;
  /** Compte de paiement/encaissement ; absent = compte par défaut à la validation. */
  accountId?: string | null;
}

export async function listPlannerEvents(userId: string): Promise<PlannerEventRow[]> {
  const { rows } = await pool.query<PlannerEventRow>(
    `SELECT * FROM planner_events WHERE user_id = $1 ORDER BY event_date ASC, event_time ASC`,
    [userId],
  );
  return rows;
}

export async function createPlannerEvent(userId: string, input: PlannerEventInput): Promise<PlannerEventRow> {
  if (input.accountId) await assertAccountUsable(userId, input.accountId);
  const { rows } = await pool.query<PlannerEventRow>(
    `INSERT INTO planner_events (user_id, title, event_date, event_time, duration_minutes, type, category, amount, recurrence, account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [userId, input.title, input.eventDate, input.eventTime, input.durationMinutes, input.type, input.category, input.amount, input.recurrence ?? null, input.accountId ?? null],
  );
  return rows[0]!;
}

export async function updatePlannerEvent(
  userId: string,
  id: string,
  input: Partial<PlannerEventInput>,
): Promise<PlannerEventRow> {
  const existing = await pool.query(`SELECT id FROM planner_events WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!existing.rows[0]) throw Errors.plannerEventNotFound();

  // recurrence a une sémantique tri-état comme note/projectId/rubriqueId sur
  // les transactions : absent du corps = inchangé, null = retire la
  // récurrence (redevient un événement ponctuel), valeur = la remplace.
  const hasRecurrence = "recurrence" in input;
  // Même règle tri-état pour le compte (null = revenir au compte par défaut).
  const hasAccount = "accountId" in input;
  if (input.accountId) await assertAccountUsable(userId, input.accountId);

  const { rows } = await pool.query<PlannerEventRow>(
    `UPDATE planner_events SET
       title = COALESCE($3, title),
       event_date = COALESCE($4, event_date),
       event_time = COALESCE($5, event_time),
       duration_minutes = COALESCE($6, duration_minutes),
       type = COALESCE($7, type),
       category = COALESCE($8, category),
       amount = COALESCE($9, amount),
       recurrence = CASE WHEN $10 THEN $11 ELSE recurrence END,
       account_id = CASE WHEN $12 THEN $13::uuid ELSE account_id END
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [
      id, userId,
      input.title ?? null, input.eventDate ?? null, input.eventTime ?? null,
      input.durationMinutes ?? null, input.type ?? null, input.category ?? null, input.amount ?? null,
      hasRecurrence, input.recurrence ?? null,
      hasAccount, input.accountId ?? null,
    ],
  );
  return rows[0]!;
}

// --- Calcul de la prochaine occurrence (arithmétique pure, en UTC, jamais de
// fuseau horaire local) : "31 janvier" + mensuelle doit donner "28/29
// février" (plafonné au dernier jour du mois cible) et non déborder sur mars,
// comme le ferait Date#setMonth naïvement.
function pad2(n: number): string { return String(n).padStart(2, "0"); }

function addWeeks(dateStr: string, weeks: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!) + weeks * 7 * 86_400_000);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

function addMonthsClamped(dateStr: string, months: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const totalMonths = y! * 12 + (m! - 1) + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12; // 0-based, toujours positif
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(d!, lastDayOfTargetMonth);
  return `${targetYear}-${pad2(targetMonth + 1)}-${pad2(day)}`;
}

export function nextOccurrenceDate(dateStr: string, recurrence: RecurrenceFrequency): string {
  if (recurrence === "hebdomadaire") return addWeeks(dateStr, 1);
  if (recurrence === "mensuelle") return addMonthsClamped(dateStr, 1);
  return addMonthsClamped(dateStr, 3); // trimestrielle
}

function todayUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * Valide (ou invalide) la réalisation d'une échéance — boutons « Réalisé /
 * Non réalisé » du rappel, du Planner ou de la carte « À confirmer ».
 *
 * Avec `createTransaction` (envoyé par l'app depuis la maj19) et le statut
 * « réalisé », le mouvement correspondant est créé ICI, dans la même
 * transaction SQL que le changement de statut et que la prochaine
 * occurrence : jamais d'échéance validée sans son mouvement, ni l'inverse.
 * Une échéance déjà liée à un mouvement n'en recrée jamais un second (double
 * clic, deux appareils, nouvelle validation après « non réalisé »).
 * Sans `createTransaction` (ancienne version de l'app encore en cache), le
 * comportement d'avant est conservé : l'app crée elle-même le mouvement.
 *
 * Si l'échéance est récurrente et vient d'être marquée « réalisée », la
 * prochaine occurrence est créée (même titre, heure, durée, catégorie,
 * montant, compte et récurrence — seule la date avance), une seule fois.
 */
export async function setPlannerEventStatus(
  userId: string,
  id: string,
  status: "a_venir" | "realise" | "non_realise",
  options: { createTransaction?: boolean; occurredOn?: string } = {},
): Promise<{ event: PlannerEventRow; nextEvent: PlannerEventRow | null; transaction: TransactionRow | null }> {
  return withTransaction(async (client) => {
    // Verrou sur la ligne : deux validations simultanées passent l'une après
    // l'autre et la seconde voit le lien déjà posé par la première.
    const { rows: currentRows } = await client.query<PlannerEventRow>(
      `SELECT * FROM planner_events WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [id, userId],
    );
    const current = currentRows[0];
    if (!current) throw Errors.plannerEventNotFound();
    const wasRealise = current.status === "realise";

    let transaction: TransactionRow | null = null;
    let transactionId = current.transaction_id;
    if (status === "realise" && options.createTransaction && !current.transaction_id) {
      let accountId = current.account_id;
      let accountType: AccountType = "especes";
      if (accountId) {
        try {
          accountType = (await assertAccountUsable(userId, accountId, client)).type;
        } catch {
          accountId = null; // compte archivé depuis : on retombe sur le compte par défaut
        }
      }
      if (!accountId) {
        accountId = await ensureDefaultAccount(userId, client);
        const { rows } = await client.query<{ type: AccountType }>(`SELECT type FROM accounts WHERE id = $1`, [accountId]);
        accountType = rows[0]!.type;
      }
      // Même règle de date qu'avant : une échéance en retard est datée du jour
      // de sa validation, une échéance à venir garde sa date.
      const today = todayUtc();
      const occurredOn = options.occurredOn ?? (current.event_date < today ? today : current.event_date);
      const { rows: txRows } = await client.query<TransactionRow>(
        `INSERT INTO transactions (user_id, type, category, amount, occurred_on, method, note, account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [userId, current.type, current.category, current.amount, occurredOn, METHOD_BY_ACCOUNT_TYPE[accountType], current.title, accountId],
      );
      transaction = txRows[0]!;
      transactionId = transaction.id;
    }

    const { rows } = await client.query<PlannerEventRow>(
      `UPDATE planner_events SET status = $3, transaction_id = $4 WHERE id = $1 AND user_id = $2 RETURNING *`,
      [id, userId, status, transactionId],
    );
    const event = rows[0]!;

    let nextEvent: PlannerEventRow | null = null;
    if (status === "realise" && !wasRealise && event.recurrence) {
      const nextDate = nextOccurrenceDate(event.event_date, event.recurrence);
      // Une seule prochaine occurrence, même si l'échéance repasse par
      // « non réalisé » puis « réalisé ».
      const { rows: existing } = await client.query(
        `SELECT 1 FROM planner_events
          WHERE user_id = $1 AND title = $2 AND event_date = $3 AND recurrence IS NOT NULL AND id <> $4 LIMIT 1`,
        [userId, event.title, nextDate, event.id],
      );
      if (!existing[0]) {
        const { rows: nextRows } = await client.query<PlannerEventRow>(
          `INSERT INTO planner_events (user_id, title, event_date, event_time, duration_minutes, type, category, amount, recurrence, account_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
          [userId, event.title, nextDate, event.event_time, event.duration_minutes, event.type, event.category, event.amount, event.recurrence, event.account_id],
        );
        nextEvent = nextRows[0]!;
      }
    }

    return { event, nextEvent, transaction };
  });
}

export async function deletePlannerEvent(userId: string, id: string): Promise<void> {
  const { rowCount } = await pool.query(`DELETE FROM planner_events WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!rowCount) throw Errors.plannerEventNotFound();
}
