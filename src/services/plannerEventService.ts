import { pool } from "../db/pool.js";
import { Errors } from "../lib/errors.js";

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
    `INSERT INTO planner_events (user_id, title, event_date, event_time, duration_minutes, type, category, amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [userId, input.title, input.eventDate, input.eventTime, input.durationMinutes, input.type, input.category, input.amount],
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

  const { rows } = await pool.query<PlannerEventRow>(
    `UPDATE planner_events SET
       title = COALESCE($3, title),
       event_date = COALESCE($4, event_date),
       event_time = COALESCE($5, event_time),
       duration_minutes = COALESCE($6, duration_minutes),
       type = COALESCE($7, type),
       category = COALESCE($8, category),
       amount = COALESCE($9, amount)
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [
      id, userId,
      input.title ?? null, input.eventDate ?? null, input.eventTime ?? null,
      input.durationMinutes ?? null, input.type ?? null, input.category ?? null, input.amount ?? null,
    ],
  );
  return rows[0]!;
}

/**
 * Valide (ou invalide) la réalisation d'une tâche suite au rappel — le même
 * geste que les boutons "Réalisé / Non réalisé" de la notification côté
 * prototype.
 */
export async function setPlannerEventStatus(
  userId: string,
  id: string,
  status: "a_venir" | "realise" | "non_realise",
): Promise<PlannerEventRow> {
  const { rows } = await pool.query<PlannerEventRow>(
    `UPDATE planner_events SET status = $3 WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId, status],
  );
  if (!rows[0]) throw Errors.plannerEventNotFound();
  return rows[0];
}

export async function deletePlannerEvent(userId: string, id: string): Promise<void> {
  const { rowCount } = await pool.query(`DELETE FROM planner_events WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!rowCount) throw Errors.plannerEventNotFound();
}
