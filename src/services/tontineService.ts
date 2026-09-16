import type { PoolClient } from "pg";
import { pool, withTransaction } from "../db/pool.js";
import { Errors } from "../lib/errors.js";

export interface TontineMember {
  id: string;
  name: string;
  position: number;
}

export interface TontineView {
  id: string;
  name: string;
  contributionAmount: number;
  frequency: string;
  currentRound: number;
  members: TontineMember[];
  paidThisRound: Record<string, boolean>; // memberId -> paid
  history: Array<{ round: number; beneficiaryMemberId: string; beneficiaryName: string; totalAmount: number }>;
}

export interface CreateTontineInput {
  name: string;
  contributionAmount: number;
  frequency: string;
  members: string[];
}

async function loadTontineView(client: PoolClient | typeof pool, userId: string, tontineId: string): Promise<TontineView | null> {
  const { rows: tontineRows } = await client.query(
    `SELECT * FROM tontines WHERE id = $1 AND user_id = $2`,
    [tontineId, userId],
  );
  const tontine = tontineRows[0];
  if (!tontine) return null;

  const { rows: members } = await client.query<TontineMember>(
    `SELECT id, name, position FROM tontine_members WHERE tontine_id = $1 ORDER BY position ASC`,
    [tontineId],
  );

  const { rows: contributions } = await client.query<{ member_id: string; paid: boolean }>(
    `SELECT member_id, paid FROM tontine_contributions WHERE tontine_id = $1 AND round_number = $2`,
    [tontineId, tontine.current_round],
  );
  const paidThisRound: Record<string, boolean> = {};
  for (const m of members) paidThisRound[m.id] = false;
  for (const c of contributions) paidThisRound[c.member_id] = c.paid;

  const { rows: history } = await client.query<{
    round_number: number; beneficiary_member_id: string; beneficiary_name: string; total_amount: string;
  }>(
    `SELECT h.round_number, h.beneficiary_member_id, m.name AS beneficiary_name, h.total_amount
     FROM tontine_round_history h
     JOIN tontine_members m ON m.id = h.beneficiary_member_id
     WHERE h.tontine_id = $1
     ORDER BY h.round_number ASC`,
    [tontineId],
  );

  return {
    id: tontine.id,
    name: tontine.name,
    contributionAmount: Number(tontine.contribution_amount),
    frequency: tontine.frequency,
    currentRound: tontine.current_round,
    members,
    paidThisRound,
    history: history.map((h) => ({
      round: h.round_number,
      beneficiaryMemberId: h.beneficiary_member_id,
      beneficiaryName: h.beneficiary_name,
      totalAmount: Number(h.total_amount),
    })),
  };
}

export async function listTontines(userId: string): Promise<TontineView[]> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM tontines WHERE user_id = $1 ORDER BY created_at ASC`, [userId]);
  const views: TontineView[] = [];
  for (const row of rows) {
    const view = await loadTontineView(pool, userId, row.id);
    if (view) views.push(view);
  }
  return views;
}

export async function getTontine(userId: string, tontineId: string): Promise<TontineView> {
  const view = await loadTontineView(pool, userId, tontineId);
  if (!view) throw Errors.tontineNotFound();
  return view;
}

export async function createTontine(userId: string, input: CreateTontineInput): Promise<TontineView> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO tontines (user_id, name, contribution_amount, frequency) VALUES ($1, $2, $3, $4) RETURNING id`,
      [userId, input.name, input.contributionAmount, input.frequency],
    );
    const tontineId = rows[0]!.id;

    const memberIds: string[] = [];
    for (let i = 0; i < input.members.length; i++) {
      const { rows: memberRows } = await client.query<{ id: string }>(
        `INSERT INTO tontine_members (tontine_id, name, position) VALUES ($1, $2, $3) RETURNING id`,
        [tontineId, input.members[i], i + 1],
      );
      memberIds.push(memberRows[0]!.id);
    }
    for (const memberId of memberIds) {
      await client.query(
        `INSERT INTO tontine_contributions (tontine_id, member_id, round_number, paid) VALUES ($1, $2, 1, false)`,
        [tontineId, memberId],
      );
    }

    const view = await loadTontineView(client, userId, tontineId);
    if (!view) throw new Error("[createTontine] tontine introuvable juste après sa création");
    return view;
  });
}

export async function markContribution(
  userId: string,
  tontineId: string,
  memberId: string,
  paid: boolean,
): Promise<TontineView> {
  return withTransaction(async (client) => {
    const { rows: tontineRows } = await client.query(
      `SELECT current_round FROM tontines WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [tontineId, userId],
    );
    const tontine = tontineRows[0];
    if (!tontine) throw Errors.tontineNotFound();

    const { rows: memberRows } = await client.query(
      `SELECT id FROM tontine_members WHERE id = $1 AND tontine_id = $2`,
      [memberId, tontineId],
    );
    if (!memberRows[0]) throw Errors.tontineMemberNotFound();

    await client.query(
      `INSERT INTO tontine_contributions (tontine_id, member_id, round_number, paid, paid_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $4 THEN now() ELSE NULL END)
       ON CONFLICT (member_id, round_number)
       DO UPDATE SET paid = EXCLUDED.paid, paid_at = EXCLUDED.paid_at`,
      [tontineId, memberId, tontine.current_round, paid],
    );

    const view = await loadTontineView(client, userId, tontineId);
    if (!view) throw new Error("[markContribution] tontine introuvable après mise à jour");
    return view;
  });
}

/**
 * Clôture le tour en cours et verse au bénéficiaire suivant (ordre de
 * passage = position). Refuse tant que tous les membres n'ont pas cotisé —
 * même règle que le bouton "Clôturer le tour" désactivé côté prototype tant
 * que 100% des membres n'ont pas payé.
 */
export async function closeRound(userId: string, tontineId: string): Promise<TontineView> {
  return withTransaction(async (client) => {
    const { rows: tontineRows } = await client.query(
      `SELECT * FROM tontines WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [tontineId, userId],
    );
    const tontine = tontineRows[0];
    if (!tontine) throw Errors.tontineNotFound();

    const { rows: members } = await client.query<TontineMember>(
      `SELECT id, name, position FROM tontine_members WHERE tontine_id = $1 ORDER BY position ASC`,
      [tontineId],
    );
    if (!members.length) throw Errors.tontineRoundNotReady();

    const { rows: contributions } = await client.query<{ member_id: string; paid: boolean }>(
      `SELECT member_id, paid FROM tontine_contributions WHERE tontine_id = $1 AND round_number = $2`,
      [tontineId, tontine.current_round],
    );
    const paidCount = contributions.filter((c) => c.paid).length;
    if (paidCount < members.length) throw Errors.tontineRoundNotReady();

    const beneficiaryIndex = (tontine.current_round - 1) % members.length;
    const beneficiary = members[beneficiaryIndex]!;
    const totalAmount = Number(tontine.contribution_amount) * members.length;

    await client.query(
      `INSERT INTO tontine_round_history (tontine_id, round_number, beneficiary_member_id, total_amount)
       VALUES ($1, $2, $3, $4)`,
      [tontineId, tontine.current_round, beneficiary.id, totalAmount],
    );

    const nextRound = tontine.current_round + 1;
    await client.query(`UPDATE tontines SET current_round = $2 WHERE id = $1`, [tontineId, nextRound]);
    for (const m of members) {
      await client.query(
        `INSERT INTO tontine_contributions (tontine_id, member_id, round_number, paid) VALUES ($1, $2, $3, false)`,
        [tontineId, m.id, nextRound],
      );
    }

    const view = await loadTontineView(client, userId, tontineId);
    if (!view) throw new Error("[closeRound] tontine introuvable après clôture du tour");
    return view;
  });
}
