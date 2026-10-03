import { pool, withTransaction } from "../db/pool.js";
import { Errors } from "../lib/errors.js";

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
}

export async function listPlannerEvents(userId: string): Promise<PlannerEventRow[]> {
  const { rows } = await pool.query<PlannerEventRow>(
    `SELECT * FROM planner_events WHERE user_id = $1 ORDER BY event_date ASC, event_time ASC`,
    [userId],
  );
  return rows;
}

export async function createPlannerEvent(userId: string, input: PlannerEventInput): Promise<PlannerEventRow> {
  const { rows } = await pool.query<PlannerEventRow>(
    `INSERT INTO planner_events (user_id, title, event_date, event_time, duration_minutes, type, category, amount, recurrence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [userId, input.title, input.eventDate, input.eventTime, input.durationMinutes, input.type, input.category, input.amount, input.recurrence ?? null],
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

  const { rows } = await pool.query<PlannerEventRow>(
    `UPDATE planner_events SET
       title = COALESCE($3, title),
       event_date = COALESCE($4, event_date),
       event_time = COALESCE($5, event_time),
       duration_minutes = COALESCE($6, duration_minutes),
       type = COALESCE($7, type),
       category = COALESCE($8, category),
       amount = COALESCE($9, amount),
       recurrence = CASE WHEN $10 THEN $11 ELSE recurrence END
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [
      id, userId,
      input.title ?? null, input.eventDate ?? null, input.eventTime ?? null,
      input.durationMinutes ?? null, input.type ?? null, input.category ?? null, input.amount ?? null,
      hasRecurrence, input.recurrence ?? null,
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

/**
 * Valide (ou invalide) la réalisation d'une tâche suite au rappel — le même
 * geste que les boutons "Réalisé / Non réalisé" de la notification côté
 * prototype. Si l'événement est récurrent ET qu'il vient d'être marqué
 * "réalisé", la prochaine occurrence est créée automatiquement (même titre,
 * heure, durée, catégorie, montant et récurrence — seule la date avance) :
 * l'utilisateur n'a plus jamais à ressaisir un paiement qui revient
 * régulièrement.
 */
export async function setPlannerEventStatus(
  userId: string,
  id: string,
  status: "a_venir" | "realise" | "non_realise",
): Promise<{ event: PlannerEventRow; nextEvent: PlannerEventRow | null }> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<PlannerEventRow>(
      `UPDATE planner_events SET status = $3 WHERE id = $1 AND user_id = $2 RETURNING *`,
      [id, userId, status],
    );
    const event = rows[0];
    if (!event) throw Errors.plannerEventNotFound();

    let nextEvent: PlannerEventRow | null = null;
    if (status === "realise" && event.recurrence) {
      const nextDate = nextOccurrenceDate(event.event_date, event.recurrence);
      const { rows: nextRows } = await client.query<PlannerEventRow>(
        `INSERT INTO planner_events (user_id, title, event_date, event_time, duration_minutes, type, category, amount, recurrence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [userId, event.title, nextDate, event.event_time, event.duration_minutes, event.type, event.category, event.amount, event.recurrence],
      );
      nextEvent = nextRows[0]!;
    }

    return { event, nextEvent };
  });
}

export async function deletePlannerEvent(userId: string, id: string): Promise<void> {
  const { rowCount } = await pool.query(`DELETE FROM planner_events WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!rowCount) throw Errors.plannerEventNotFound();
}
