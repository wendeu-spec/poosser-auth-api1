import type { PoolClient } from "pg";
import { assertCanCreate } from "./entitlementService.js";
import { pool, withTransaction } from "../db/pool.js";
import { Errors } from "../lib/errors.js";
import {
  METHOD_BY_ACCOUNT_TYPE,
  accountBalanceOf,
  assertAccountUsable,
  createLinkedAccount,
  createTransferIn,
  ensureDefaultAccount,
  isOffBudgetAccount,
  type AccountType,
} from "./accountService.js";

/**
 * Module tontine, branché sur l'argent réel depuis la migration 034 — voir ce
 * fichier SQL pour les choix structurants validés avec Yannis.
 *
 * Les trois règles à garder en tête :
 *
 *   1. Cotiser et encaisser sont des VIREMENTS NEUTRES entre un compte réel et
 *      la cagnotte du groupe. Les 700 000 FCFA encaissés à son tour ne sont pas
 *      un revenu : c'est son propre argent qui revient, versé 50 000 à la fois.
 *   2. La caisse de solidarité et les pénalités sont de VRAIES DÉPENSES : cet
 *      argent-là ne revient jamais.
 *   3. L'argent des AUTRES membres (rôle collecteur) entre dans la cagnotte
 *      depuis l'extérieur des finances de l'utilisateur : c'est un revenu sur
 *      le compte de la tontine, jamais un virement depuis un de ses comptes.
 *
 * Conséquence vérifiable : sur un cycle complet, le compte de la tontine
 * retombe exactement à zéro. Les tests s'appuient dessus.
 *
 * Une tontine dont `account_id` ou `my_member_id` est NULL n'est pas encore
 * configurée : elle reste un simple pointage, sans aucun mouvement d'argent.
 * C'est l'état des groupes créés avant la migration 034, et on ne devine jamais
 * rétroactivement ce qui a été payé ni depuis quel compte.
 */

export const TONTINE_ROLES = ["participant", "collecteur"] as const;
export type TontineRole = (typeof TONTINE_ROLES)[number];

/** Catégorie des dépenses réelles produites par le module (caisse, pénalités). */
export const TONTINE_CATEGORY = "Tontine";

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
  paidAtThisRound: Record<string, string | null>; // memberId -> date ISO du paiement (null si pas encore payé)
  history: Array<{ round: number; beneficiaryMemberId: string; beneficiaryName: string; totalAmount: number }>;
  // Date de début du tour en cours — colonne dédiée `round_started_at` (voir
  // migrations/025_tontine_round_started_at.sql), avancée uniquement à la
  // création et à chaque clôture de tour (closeRound). Volontairement
  // découplée de `updated_at`, que PATCH /api/tontines/:id (modifier nom,
  // cotisation, fréquence, membres) touche aussi via le trigger
  // `touch_updated_at` — sans cette séparation, éditer une tontine aurait
  // réinitialisé à tort l'échéance de cotisation affichée au client.
  currentRoundStartedAt: string;

  // ---- Argent réel (migrations/034) ----
  /** Cagnotte du groupe. NULL = groupe non configuré, simple pointage. */
  accountId: string | null;
  /** Quel membre de la liste est l'utilisateur. NULL = pas encore désigné. */
  myMemberId: string | null;
  role: TontineRole;
  lateFee: number;
  solidarityAmount: number;
  /**
   * Solde de la cagnotte. Pour un participant : ce que le groupe lui doit
   * (positif) ou ce qu'il doit encore au groupe (négatif, après avoir
   * encaissé). Pour un collecteur : l'argent du groupe qu'il détient.
   * Jamais compté dans le « disponible ».
   */
  position: number;
  /** Cotisations du tour en cours payées en retard (pénalité appliquée). */
  lateThisRound: Record<string, boolean>;

  // ---- Caisse de secours (migrations/035) ----
  /** Compte de la caisse. NULL = le groupe n'a encore rien mis de côté. */
  caisseAccountId: string | null;
  /** Ce que la caisse détient aujourd'hui. Jamais compté dans le « disponible ». */
  caisseBalance: number;
  /** Ce que l'utilisateur y a versé depuis le début (hors argent des autres). */
  caisseContributed: number;
  /** Motifs de secours du groupe, ou la liste par défaut. */
  secoursMotifs: string[];
}

export interface TontineMoneySettings {
  myMemberPosition?: number | null;
  role?: TontineRole;
  lateFee?: number;
  solidarityAmount?: number;
  /** Motifs de secours propres au groupe ; absent ou vide = liste par défaut. */
  secoursMotifs?: string[];
}

export interface CreateTontineInput extends TontineMoneySettings {
  name: string;
  contributionAmount: number;
  frequency: string;
  members: string[];
}

export interface UpdateTontineInput {
  name?: string;
  contributionAmount?: number;
  frequency?: string;
  // Renomme les membres existants, dans l'ordre de passage — ne permet pas
  // d'ajouter/retirer un membre ici : cela changerait l'ordre des
  // bénéficiaires et le sens des cotisations déjà enregistrées par round,
  // ce qui sort du cadre d'une simple modification.
  memberNames?: string[];
}

export interface UpdateTontineInputFull extends UpdateTontineInput, TontineMoneySettings {}

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

  const { rows: contributions } = await client.query<{ member_id: string; paid: boolean; paid_at: Date | null; late: boolean }>(
    `SELECT member_id, paid, paid_at, late FROM tontine_contributions WHERE tontine_id = $1 AND round_number = $2`,
    [tontineId, tontine.current_round],
  );
  const paidThisRound: Record<string, boolean> = {};
  const paidAtThisRound: Record<string, string | null> = {};
  const lateThisRound: Record<string, boolean> = {};
  for (const m of members) { paidThisRound[m.id] = false; paidAtThisRound[m.id] = null; lateThisRound[m.id] = false; }
  for (const c of contributions) {
    paidThisRound[c.member_id] = c.paid;
    paidAtThisRound[c.member_id] = c.paid_at ? c.paid_at.toISOString() : null;
    lateThisRound[c.member_id] = c.late;
  }

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
    paidAtThisRound,
    history: history.map((h) => ({
      round: h.round_number,
      beneficiaryMemberId: h.beneficiary_member_id,
      beneficiaryName: h.beneficiary_name,
      totalAmount: Number(h.total_amount),
    })),
    currentRoundStartedAt: new Date(tontine.round_started_at).toISOString(),
    accountId: tontine.account_id ?? null,
    myMemberId: tontine.my_member_id ?? null,
    role: tontine.role as TontineRole,
    lateFee: Number(tontine.late_fee),
    solidarityAmount: Number(tontine.solidarity_amount),
    // Le solde de la cagnotte est calculé à la lecture, comme tout solde de
    // compte (accountService.BALANCE_SELECT) : un solde stocké finit toujours
    // par diverger des mouvements.
    position: tontine.account_id ? await accountBalanceOf(userId, tontine.account_id, client) : 0,
    lateThisRound,
    // ---- Caisse de secours (migration 035) ----
    caisseAccountId: tontine.caisse_account_id ?? null,
    // Ce que le groupe détient. Jamais compté dans le « disponible » : cet
    // argent appartient au groupe et ne peut sortir que vers un membre.
    caisseBalance: tontine.caisse_account_id
      ? await accountBalanceOf(userId, tontine.caisse_account_id, client)
      : 0,
    // Ce que l'utilisateur y a versé depuis le début, toutes sources
    // confondues — le chiffre qui manquait, et la raison d'être de la caisse
    // comme compte plutôt que comme catégorie de dépense.
    caisseContributed: tontine.caisse_account_id
      ? await caisseContributedByUser(client, userId, tontine)
      : 0,
    secoursMotifs: secoursMotifsOf(tontine),
  };
}

/**
 * Somme de ce que l'utilisateur a personnellement versé dans la caisse : ses
 * cotisations sociales et pénalités (virements adossés à ses cotisations) et
 * ses versements libres. Les entrées venues des AUTRES membres, qu'un
 * collecteur encaisse pour le groupe, en sont exclues — ce n'est pas son
 * argent.
 */
async function caisseContributedByUser(
  client: PoolClient | typeof pool,
  userId: string,
  tontine: { id: string; caisse_account_id: string | null },
): Promise<number> {
  const { rows } = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(tr.amount), 0) AS total
       FROM transfers tr
      WHERE tr.user_id = $1 AND tr.to_account_id = $2
        AND (
          tr.id IN (SELECT extra_transfer_id FROM tontine_contributions
                     WHERE tontine_id = $3 AND extra_transfer_id IS NOT NULL)
          OR
          tr.id IN (SELECT transfer_id FROM tontine_caisse_movements
                     WHERE tontine_id = $3 AND kind = 'versement' AND transfer_id IS NOT NULL)
        )`,
    [userId, tontine.caisse_account_id, tontine.id],
  );
  return Number(rows[0]!.total);
}

// ---------------------------------------------------------------------------
// Argent réel
// ---------------------------------------------------------------------------

interface TontineRow {
  id: string;
  name: string;
  contribution_amount: string;
  current_round: number;
  account_id: string | null;
  my_member_id: string | null;
  role: TontineRole;
  late_fee: string;
  solidarity_amount: string;
  /** Caisse de secours du groupe, créée au premier besoin (migration 035). */
  caisse_account_id: string | null;
  secours_motifs: string[] | null;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Un groupe ne déplace d'argent que s'il a une cagnotte ET un membre désigné. */
function tracksMoney(t: TontineRow): boolean {
  return Boolean(t.account_id && t.my_member_id);
}

/** Compte réel à débiter/créditer : celui demandé, sinon le compte par défaut. */
async function resolveUserAccount(
  client: PoolClient,
  userId: string,
  accountId: string | undefined,
  potAccountId: string,
): Promise<{ id: string; type: AccountType }> {
  if (accountId) {
    // La cagnotte ne peut pas être à la fois la source et la destination : ce
    // serait un virement sur lui-même, refusé plus bas, avec un message
    // incompréhensible. On le dit clairement ici.
    if (accountId === potAccountId) throw Errors.tontineAccountNotUsable();
    const account = await assertAccountUsable(userId, accountId, client);
    // Ni une cagnotte ni une caisse ne sont de l'argent dans lequel on puise :
    // elles appartiennent au groupe (voir OFF_BUDGET_ACCOUNT_TYPES).
    if (isOffBudgetAccount(account.type)) throw Errors.tontineAccountNotUsable();
    return { id: account.id, type: account.type };
  }
  const id = await ensureDefaultAccount(userId, client);
  const { rows } = await client.query<{ type: AccountType }>(`SELECT type FROM accounts WHERE id = $1`, [id]);
  return { id, type: rows[0]!.type };
}

/**
 * Motifs de secours proposés par défaut. Dans le code plutôt qu'en base (même
 * principe que PLANS) : la liste évolue par déploiement, et un groupe qui en
 * veut une autre la pose dans `secours_motifs`.
 */
export const DEFAULT_SECOURS_MOTIFS = [
  "Décès",
  "Maladie",
  "Naissance",
  "Mariage",
  "Scolarité",
  "Incendie",
  "Autre",
] as const;

export function secoursMotifsOf(t: { secours_motifs: string[] | null }): string[] {
  return t.secours_motifs && t.secours_motifs.length ? t.secours_motifs : [...DEFAULT_SECOURS_MOTIFS];
}

/**
 * Crée la caisse du groupe au premier besoin, et renvoie son id.
 *
 * Création PARESSEUSE, et non à la création du groupe comme la cagnotte : un
 * groupe sans caisse de solidarité ni pénalité n'a aucune raison de traîner un
 * compte vide dans la page Comptes. Le compte naît exactement quand il y a
 * quelque chose à y mettre.
 */
async function ensureCaisseAccount(client: PoolClient, userId: string, t: TontineRow): Promise<string> {
  if (t.caisse_account_id) return t.caisse_account_id;
  const accountId = await createLinkedAccount(client, userId, {
    name: `Caisse ${t.name}`,
    type: "caisse",
  });
  await client.query(`UPDATE tontines SET caisse_account_id = $2 WHERE id = $1`, [t.id, accountId]);
  t.caisse_account_id = accountId;
  return accountId;
}

/**
 * Caisse de solidarité + pénalité de retard, en UN virement vers la caisse du
 * groupe (migration 035).
 *
 * C'était une dépense sèche jusqu'ici : l'argent quittait le compte et
 * disparaissait, si bien que personne ne savait ce que la caisse détenait.
 * C'est maintenant un virement — mais surtout vers la CAISSE, jamais vers la
 * cagnotte : celle-ci doit retomber à zéro en fin de cycle, et y faire
 * transiter de l'argent qui ne tourne pas détruirait cette vérification.
 */
async function recordExtras(
  client: PoolClient,
  userId: string,
  t: TontineRow,
  accountId: string,
  late: boolean,
  solidarityDue: boolean,
  occurredOn: string,
): Promise<string | null> {
  const total = extrasTotal(t, late, solidarityDue);
  if (total <= 0) return null;

  const caisseId = await ensureCaisseAccount(client, userId, t);
  const { transfer } = await createTransferIn(client, userId, {
    fromAccountId: accountId,
    toAccountId: caisseId,
    amount: total,
    occurredOn,
    note: `${t.name} — ${extrasLabel(t, late, solidarityDue)}`,
  });
  return transfer.id;
}

/**
 * La caisse de solidarité se verse UNE SEULE FOIS par cycle complet, pas à
 * chaque tour — décision de Yannis, et l'usage de COEUR JOYEUX : 14 membres,
 * un bénéficiaire par mois, donc une cotisation sociale tous les 14 mois.
 *
 * Elle est prélevée au PREMIER tour de chaque cycle, en même temps que la
 * cotisation. Un cycle fait autant de tours qu'il y a de membres : avec 14
 * membres, les tours 1, 15, 29... ouvrent un cycle.
 *
 * La pénalité de retard, elle, s'applique au tour où le retard a lieu.
 */
function isFirstRoundOfCycle(t: TontineRow, memberCount: number): boolean {
  if (memberCount <= 0) return true;
  return (t.current_round - 1) % memberCount === 0;
}

function extrasTotal(t: TontineRow, late: boolean, solidarityDue: boolean): number {
  return round2((solidarityDue ? Number(t.solidarity_amount) : 0) + (late ? Number(t.late_fee) : 0));
}

function extrasLabel(t: TontineRow, late: boolean, solidarityDue: boolean): string {
  const penalty = late ? Number(t.late_fee) : 0;
  return [
    solidarityDue && Number(t.solidarity_amount) > 0 ? "caisse de solidarité" : null,
    penalty > 0 ? "pénalité de retard" : null,
  ].filter(Boolean).join(" + ");
}

/**
 * Collecteur : la caisse de solidarité et la pénalité d'un AUTRE membre
 * entrent dans la caisse que je détiens. Argent du groupe, venu de l'extérieur
 * de mes finances — un revenu sur la caisse, jamais un virement depuis un de
 * mes comptes.
 */
async function recordCaisseInflowForOther(
  client: PoolClient,
  userId: string,
  t: TontineRow,
  memberName: string,
  late: boolean,
  solidarityDue: boolean,
  occurredOn: string,
): Promise<string | null> {
  const total = extrasTotal(t, late, solidarityDue);
  if (total <= 0) return null;
  const caisseId = await ensureCaisseAccount(client, userId, t);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO transactions (user_id, type, category, amount, occurred_on, method, note, account_id)
     VALUES ($1, 'revenu', $2, $3, $4, 'Espèces', $5, $6) RETURNING id`,
    [userId, TONTINE_CATEGORY, total, occurredOn, `${t.name} — ${extrasLabel(t, late, solidarityDue)} de ${memberName}`, caisseId],
  );
  return rows[0]!.id;
}

/** Argent d'un AUTRE membre entrant dans la cagnotte que je détiens (collecteur). */
async function recordPotInflow(
  client: PoolClient,
  userId: string,
  t: TontineRow,
  memberName: string,
  amount: number,
  occurredOn: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO transactions (user_id, type, category, amount, occurred_on, method, note, account_id)
     VALUES ($1, 'revenu', $2, $3, $4, 'Espèces', $5, $6) RETURNING id`,
    [userId, TONTINE_CATEGORY, amount, occurredOn, `${t.name} — cotisation de ${memberName}`, t.account_id],
  );
  return rows[0]!.id;
}

interface ContributionMoney {
  transfer_id: string | null;
  pot_transaction_id: string | null;
  extra_transaction_id: string | null;
  extra_transfer_id: string | null;
}

/** Défait tous les mouvements d'une cotisation qu'on décoche. */
async function undoContributionMoney(
  client: PoolClient,
  contribution: ContributionMoney,
  contributionId: string,
): Promise<void> {
  // Les colonnes sont en ON DELETE RESTRICT : on détache AVANT de supprimer,
  // sinon la contrainte refuse la suppression.
  await client.query(
    `UPDATE tontine_contributions
        SET paid = false, paid_at = NULL, late = false,
            transfer_id = NULL, pot_transaction_id = NULL,
            extra_transaction_id = NULL, extra_transfer_id = NULL
      WHERE id = $1`,
    [contributionId],
  );
  // Supprimer le virement emporte sa dépense de frais (ON DELETE CASCADE,
  // migrations/029).
  for (const trId of [contribution.transfer_id, contribution.extra_transfer_id]) {
    if (trId) await client.query(`DELETE FROM transfers WHERE id = $1`, [trId]);
  }
  for (const txId of [contribution.pot_transaction_id, contribution.extra_transaction_id]) {
    if (txId) await client.query(`DELETE FROM transactions WHERE id = $1`, [txId]);
  }
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
  await assertCanCreate(userId, "tontine");
  return withTransaction(async (client) => {
    // La cagnotte est créée avec le groupe : un compte de type `tontine`,
    // exclu du disponible (voir OFF_BUDGET_ACCOUNT_TYPES). Il est créé même si
    // l'utilisateur ne se désigne pas tout de suite, pour qu'il puisse le
    // faire plus tard sans migration de données.
    const accountId = await createLinkedAccount(client, userId, {
      name: `Tontine ${input.name}`,
      type: "tontine",
    });

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO tontines (user_id, name, contribution_amount, frequency, account_id, role, late_fee, solidarity_amount, secours_motifs)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        userId,
        input.name,
        input.contributionAmount,
        input.frequency,
        accountId,
        input.role ?? "participant",
        input.lateFee ?? 0,
        input.solidarityAmount ?? 0,
        input.secoursMotifs ?? [],
      ],
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

    // Le membre « c'est moi » est désigné par sa position dans l'ordre de
    // passage, puisque les identifiants n'existent qu'après l'insertion.
    if (input.myMemberPosition) {
      const index = input.myMemberPosition - 1;
      if (index < 0 || index >= memberIds.length) {
        throw Errors.validation({ field: "myMemberPosition", reason: "doit désigner un membre existant" });
      }
      await client.query(`UPDATE tontines SET my_member_id = $2 WHERE id = $1`, [tontineId, memberIds[index]]);
    }

    const view = await loadTontineView(client, userId, tontineId);
    if (!view) throw new Error("[createTontine] tontine introuvable juste après sa création");
    return view;
  });
}

/**
 * Modifie une tontine existante : nom, cotisation, fréquence et/ou nom des
 * membres (même nombre, même ordre de passage — voir UpdateTontineInput).
 * Ne touche jamais `round_started_at` : l'échéance de cotisation affichée au
 * client doit rester celle du tour en cours, même après une correction de
 * nom ou de montant.
 */
export async function updateTontine(
  userId: string,
  tontineId: string,
  input: UpdateTontineInputFull,
): Promise<TontineView> {
  return withTransaction(async (client) => {
    const { rows: tontineRows } = await client.query<{ id: string; account_id: string | null; name: string }>(
      `SELECT id, account_id, name FROM tontines WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [tontineId, userId],
    );
    if (!tontineRows[0]) throw Errors.tontineNotFound();

    if (input.memberNames) {
      const { rows: members } = await client.query<TontineMember>(
        `SELECT id, name, position FROM tontine_members WHERE tontine_id = $1 ORDER BY position ASC`,
        [tontineId],
      );
      if (members.length !== input.memberNames.length) {
        throw Errors.validation({ field: "memberNames", reason: "doit contenir exactement un nom par membre existant, dans l'ordre de passage" });
      }
      for (let i = 0; i < members.length; i++) {
        await client.query(`UPDATE tontine_members SET name = $1 WHERE id = $2`, [input.memberNames[i], members[i]!.id]);
      }
    }

    await client.query(
      `UPDATE tontines SET
         name = COALESCE($2, name),
         contribution_amount = COALESCE($3, contribution_amount),
         frequency = COALESCE($4, frequency),
         role = COALESCE($5, role),
         late_fee = COALESCE($6, late_fee),
         solidarity_amount = COALESCE($7, solidarity_amount),
         secours_motifs = COALESCE($8, secours_motifs)
       WHERE id = $1`,
      [
        tontineId,
        input.name ?? null,
        input.contributionAmount ?? null,
        input.frequency ?? null,
        input.role ?? null,
        input.lateFee ?? null,
        input.solidarityAmount ?? null,
        input.secoursMotifs ?? null,
      ],
    );

    // `null` retire explicitement la désignation (« finalement je ne suis pas
    // membre de ce groupe, je ne fais que le tenir »), `undefined` ne touche
    // à rien. Les cotisations déjà cochées gardent leurs mouvements : on ne
    // réécrit jamais le passé parce que le réglage a changé.
    if (input.myMemberPosition !== undefined) {
      let myMemberId: string | null = null;
      if (input.myMemberPosition !== null) {
        const { rows } = await client.query<{ id: string }>(
          `SELECT id FROM tontine_members WHERE tontine_id = $1 AND position = $2`,
          [tontineId, input.myMemberPosition],
        );
        if (!rows[0]) throw Errors.validation({ field: "myMemberPosition", reason: "doit désigner un membre existant" });
        myMemberId = rows[0].id;
      }
      await client.query(`UPDATE tontines SET my_member_id = $2 WHERE id = $1`, [tontineId, myMemberId]);
    }

    // Un groupe créé avant la migration 034 n'a pas de cagnotte : on la lui
    // donne dès qu'il est modifié, pour qu'il puisse être configuré sans que
    // l'utilisateur ait à le recréer.
    if (!tontineRows[0].account_id) {
      const accountId = await createLinkedAccount(client, userId, {
        name: `Tontine ${input.name ?? tontineRows[0].name}`,
        type: "tontine",
      });
      await client.query(`UPDATE tontines SET account_id = $2 WHERE id = $1`, [tontineId, accountId]);
    }

    const view = await loadTontineView(client, userId, tontineId);
    if (!view) throw new Error("[updateTontine] tontine introuvable après mise à jour");
    return view;
  });
}

export interface MarkContributionOptions {
  /** Compte réel qui paie (ma cotisation). Absent = compte par défaut. */
  accountId?: string;
  /** Cotisation payée en retard : déclenche la pénalité si le groupe en a une. */
  late?: boolean;
  /** Frais du virement (Mobile Money, banque). */
  fee?: number;
  occurredOn?: string;
}

/**
 * Coche ou décoche la cotisation d'un membre pour le tour en cours, et déplace
 * réellement l'argent quand c'est justifié :
 *
 *   * MA cotisation  → virement de mon compte vers la cagnotte (frais compris),
 *     plus une vraie dépense si le groupe a une caisse de solidarité ou si la
 *     cotisation est en retard ;
 *   * la cotisation d'un AUTRE membre, et seulement si je suis collecteur →
 *     entrée dans la cagnotte que je détiens (revenu sur le compte de la
 *     tontine, jamais un virement depuis un de mes comptes : cet argent ne
 *     vient pas de chez moi) ;
 *   * tout le reste → simple pointage, aucun mouvement.
 *
 * Décocher défait exactement ce qui avait été créé : sans cela, un clic
 * malheureux laisserait un virement fantôme dans les comptes.
 */
export async function markContribution(
  userId: string,
  tontineId: string,
  memberId: string,
  paid: boolean,
  options: MarkContributionOptions = {},
): Promise<TontineView> {
  return withTransaction(async (client) => {
    const { rows: tontineRows } = await client.query<TontineRow>(
      // `SELECT *` et non une liste de colonnes : une liste figée a déjà causé
      // un vrai défaut — `caisse_account_id` en était absent, si bien que
      // ensureCaisseAccount ne voyait jamais la caisse existante et en créait
      // une nouvelle à chaque cotisation.
      `SELECT * FROM tontines WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [tontineId, userId],
    );
    const tontine = tontineRows[0];
    if (!tontine) throw Errors.tontineNotFound();

    const { rows: memberRows } = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM tontine_members WHERE id = $1 AND tontine_id = $2`,
      [memberId, tontineId],
    );
    const member = memberRows[0];
    if (!member) throw Errors.tontineMemberNotFound();

    // Ligne de cotisation du tour en cours, verrouillée : deux clics
    // simultanés ne doivent pas produire deux virements.
    const { rows: existingRows } = await client.query<ContributionMoney & { id: string; paid: boolean }>(
      `INSERT INTO tontine_contributions (tontine_id, member_id, round_number, paid)
       VALUES ($1, $2, $3, false)
       ON CONFLICT (member_id, round_number) DO UPDATE SET tontine_id = EXCLUDED.tontine_id
       RETURNING id, paid, transfer_id, pot_transaction_id, extra_transaction_id, extra_transfer_id`,
      [tontineId, memberId, tontine.current_round],
    );
    const contribution = existingRows[0]!;

    if (!paid) {
      if (contribution.paid) await undoContributionMoney(client, contribution, contribution.id);
      const view = await loadTontineView(client, userId, tontineId);
      if (!view) throw new Error("[markContribution] tontine introuvable après mise à jour");
      return view;
    }

    // Déjà cochée : on ne recrée pas les mouvements. Pour changer le compte ou
    // le retard, il faut décocher puis recocher — c'est explicite, et ça évite
    // qu'un rafraîchissement double la cotisation.
    if (contribution.paid) {
      const view = await loadTontineView(client, userId, tontineId);
      if (!view) throw new Error("[markContribution] tontine introuvable après mise à jour");
      return view;
    }

    const late = options.late === true;
    const occurredOn = options.occurredOn ?? todayUtc();
    const amount = Number(tontine.contribution_amount);
    let transferId: string | null = null;
    let potTxId: string | null = null;
    let extraTxId: string | null = null;
    let extraTrId: string | null = null;

    // La caisse de solidarité n'est due qu'au premier tour de chaque cycle
    // (migration 036) : avec 14 membres, une fois tous les 14 mois.
    const { rows: countRows } = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM tontine_members WHERE tontine_id = $1`,
      [tontineId],
    );
    const solidarityDue = isFirstRoundOfCycle(tontine, Number(countRows[0]!.n));

    if (tracksMoney(tontine)) {
      const potId = tontine.account_id!;
      if (memberId === tontine.my_member_id) {
        const from = await resolveUserAccount(client, userId, options.accountId, potId);
        const { transfer } = await createTransferIn(client, userId, {
          fromAccountId: from.id,
          toAccountId: potId,
          amount,
          fee: options.fee ?? 0,
          occurredOn,
          note: `${tontine.name} — cotisation tour ${tontine.current_round}`,
        });
        transferId = transfer.id;
        extraTrId = await recordExtras(client, userId, tontine, from.id, late, solidarityDue, occurredOn);
      } else if (tontine.role === "collecteur") {
        // L'argent d'un autre membre entre dans la cagnotte que je détiens,
        // mais SEULE sa cotisation : sa caisse de solidarité et sa pénalité
        // vont dans la CAISSE (migration 035).
        //
        // Jusqu'ici tout entrait dans la cagnotte, ce qui l'empêchait de
        // retomber à zéro en fin de cycle dès que le groupe avait une caisse —
        // la cagnotte encaissait une solidarité qu'elle ne reversait jamais.
        potTxId = await recordPotInflow(client, userId, tontine, member.name, amount, occurredOn);
        extraTxId = await recordCaisseInflowForOther(client, userId, tontine, member.name, late, solidarityDue, occurredOn);
      }
    }

    await client.query(
      `UPDATE tontine_contributions
          SET paid = true, paid_at = now(), late = $2,
              transfer_id = $3, pot_transaction_id = $4,
              extra_transaction_id = $5, extra_transfer_id = $6
        WHERE id = $1`,
      [contribution.id, late, transferId, potTxId, extraTxId, extraTrId],
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
export interface CloseRoundOptions {
  /** Compte réel qui reçoit la cagnotte quand c'est mon tour. */
  accountId?: string;
  occurredOn?: string;
}

export async function closeRound(
  userId: string,
  tontineId: string,
  options: CloseRoundOptions = {},
): Promise<TontineView> {
  return withTransaction(async (client) => {
    const { rows: tontineRows } = await client.query<TontineRow>(
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

    // Versement réel au bénéficiaire.
    const occurredOn = options.occurredOn ?? todayUtc();
    let transferId: string | null = null;
    let payoutTxId: string | null = null;

    if (tracksMoney(tontine)) {
      const potId = tontine.account_id!;
      if (beneficiary.id === tontine.my_member_id) {
        // C'est mon tour : la cagnotte revient chez moi. Virement neutre, donc
        // AUCUN revenu — ces 700 000 FCFA sont mon propre argent qui rentre,
        // versé cotisation après cotisation. Les compter en revenu ferait
        // mentir toutes mes statistiques pendant un cycle entier.
        //
        // Pas de frais proposés ici : createTransferIn les imputerait à la
        // cagnotte, alors qu'ils seraient les miens. Un dépôt payant se saisit
        // comme une opération ordinaire.
        const to = await resolveUserAccount(client, userId, options.accountId, potId);
        const { transfer } = await createTransferIn(client, userId, {
          fromAccountId: potId,
          toAccountId: to.id,
          amount: totalAmount,
          occurredOn,
          note: `${tontine.name} — encaissement du tour ${tontine.current_round}`,
        });
        transferId = transfer.id;
      } else if (tontine.role === "collecteur") {
        // Je détenais la cagnotte, elle part chez quelqu'un d'autre : elle
        // quitte mes finances pour de bon.
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO transactions (user_id, type, category, amount, occurred_on, method, note, account_id)
           VALUES ($1, 'depense', $2, $3, $4, 'Espèces', $5, $6) RETURNING id`,
          [userId, TONTINE_CATEGORY, totalAmount, occurredOn, `${tontine.name} — versé à ${beneficiary.name}`, potId],
        );
        payoutTxId = rows[0]!.id;
      }
    }

    await client.query(
      `INSERT INTO tontine_round_history (tontine_id, round_number, beneficiary_member_id, total_amount, transfer_id, payout_transaction_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tontineId, tontine.current_round, beneficiary.id, totalAmount, transferId, payoutTxId],
    );

    const nextRound = tontine.current_round + 1;
    // round_started_at repart à maintenant : c'est le point de départ du calcul
    // d'échéance de la prochaine cotisation côté client (voir UpdateTontineInput
    // ci-dessus pour pourquoi ce n'est plus updated_at).
    await client.query(`UPDATE tontines SET current_round = $2, round_started_at = now() WHERE id = $1`, [tontineId, nextRound]);
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

/**
 * Supprime définitivement un groupe de tontine — membres, cotisations et
 * historique des tours partent avec lui (ON DELETE CASCADE, voir
 * migrations/017_tontines.sql). Aucune confirmation serveur au-delà de la
 * vérification de propriété : le bouton "Supprimer" côté client demande déjà
 * confirmation à l'utilisateur avant d'appeler cette route.
 */
export async function deleteTontine(userId: string, tontineId: string): Promise<void> {
  const { rowCount } = await pool.query(`DELETE FROM tontines WHERE id = $1 AND user_id = $2`, [tontineId, userId]);
  if (!rowCount) throw Errors.tontineNotFound();
}

// ---------------------------------------------------------------------------
// Caisse de secours (migration 035)
// ---------------------------------------------------------------------------
//
// Une caisse de secours est à FONDS PERDUS : on y verse sans récupérer sa
// mise, et elle verse des DONS à un membre lors d'un événement — décès,
// maladie, naissance, mariage, scolarité, incendie. Ce n'est ni un compte
// d'épargne, ni une banque : d'où les deux règles tenues côté serveur et non
// seulement dans l'écran.
//
//   1. L'argent ne sort QUE vers un membre du groupe. Sans cette contrainte,
//      la caisse deviendrait une tirelire personnelle et cesserait d'être
//      l'argent du groupe.
//   2. La caisse ne peut pas passer sous zéro. On ne distribue pas un argent
//      que le groupe n'a pas encaissé.

export interface CaisseMovementRow {
  id: string;
  tontine_id: string;
  kind: "versement" | "secours";
  amount: string;
  motif: string | null;
  member_id: string | null;
  member_name: string | null;
  occurred_on: string;
  note: string | null;
  created_at: Date;
}

export interface CaisseMovementInput {
  amount: number;
  /** Obligatoire pour un secours : le membre qui reçoit. */
  memberId?: string;
  motif?: string;
  /** Compte réel débité (versement) ou crédité (secours reçu). */
  accountId?: string;
  occurredOn?: string;
  note?: string;
}

async function lockTontine(client: PoolClient, userId: string, tontineId: string): Promise<TontineRow> {
  const { rows } = await client.query<TontineRow>(
    `SELECT * FROM tontines WHERE id = $1 AND user_id = $2 FOR UPDATE`,
    [tontineId, userId],
  );
  const t = rows[0];
  if (!t) throw Errors.tontineNotFound();
  return t;
}

async function memberOfTontine(client: PoolClient, tontineId: string, memberId: string) {
  const { rows } = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM tontine_members WHERE id = $1 AND tontine_id = $2`,
    [memberId, tontineId],
  );
  const m = rows[0];
  if (!m) throw Errors.tontineMemberNotFound();
  return m;
}

/** Verse librement à la caisse du groupe (aide, maladie, deuil...). */
export async function addCaisseVersement(
  userId: string,
  tontineId: string,
  input: CaisseMovementInput,
): Promise<TontineView> {
  return withTransaction(async (client) => {
    const tontine = await lockTontine(client, userId, tontineId);
    if (!tracksMoney(tontine)) throw Errors.tontineNotConfigured();
    const occurredOn = input.occurredOn ?? todayUtc();
    const caisseId = await ensureCaisseAccount(client, userId, tontine);

    let transferId: string | null = null;
    let transactionId: string | null = null;

    if (input.memberId && input.memberId !== tontine.my_member_id) {
      // Collecteur : le versement d'un autre membre entre dans la caisse que je
      // détiens, sans toucher mes comptes.
      if (tontine.role !== "collecteur") throw Errors.tontineNotCollector();
      const member = await memberOfTontine(client, tontineId, input.memberId);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO transactions (user_id, type, category, amount, occurred_on, method, note, account_id)
         VALUES ($1, 'revenu', $2, $3, $4, 'Espèces', $5, $6) RETURNING id`,
        [userId, TONTINE_CATEGORY, input.amount, occurredOn,
         `${tontine.name} — versement caisse de ${member.name}${input.motif ? ` (${input.motif})` : ""}`, caisseId],
      );
      transactionId = rows[0]!.id;
    } else {
      // Mon propre versement : virement de mon compte vers la caisse.
      const from = await resolveUserAccount(client, userId, input.accountId, tontine.account_id!);
      const { transfer } = await createTransferIn(client, userId, {
        fromAccountId: from.id,
        toAccountId: caisseId,
        amount: input.amount,
        occurredOn,
        note: `${tontine.name} — caisse${input.motif ? ` (${input.motif})` : ""}`,
      });
      transferId = transfer.id;
    }

    await client.query(
      `INSERT INTO tontine_caisse_movements
         (tontine_id, user_id, kind, amount, motif, transfer_id, transaction_id, occurred_on, note)
       VALUES ($1, $2, 'versement', $3, $4, $5, $6, $7, $8)`,
      [tontineId, userId, input.amount, input.motif ?? null, transferId, transactionId, occurredOn, input.note ?? null],
    );

    const view = await loadTontineView(client, userId, tontineId);
    if (!view) throw new Error("[addCaisseVersement] tontine introuvable après versement");
    return view;
  });
}

/** Verse un secours de la caisse à un membre du groupe. */
export async function addSecours(
  userId: string,
  tontineId: string,
  input: CaisseMovementInput,
): Promise<TontineView> {
  return withTransaction(async (client) => {
    const tontine = await lockTontine(client, userId, tontineId);
    if (!tracksMoney(tontine)) throw Errors.tontineNotConfigured();
    if (!tontine.caisse_account_id) throw Errors.caisseEmpty({ available: 0, requested: input.amount });
    if (!input.memberId) throw Errors.validation({ field: "memberId", reason: "required for a secours" });
    if (!input.motif) throw Errors.validation({ field: "motif", reason: "required for a secours" });

    // Règle 1 : le bénéficiaire est forcément un membre de CE groupe.
    const member = await memberOfTontine(client, tontineId, input.memberId);
    const caisseId = tontine.caisse_account_id;
    const occurredOn = input.occurredOn ?? todayUtc();

    // Règle 2 : la caisse ne passe pas sous zéro. Vérifié avant d'écrire quoi
    // que ce soit, parce que le solde ne dépend pas de ce qu'on s'apprête à
    // faire — contrairement à l'épargne, où la réservation elle-même entre
    // dans le calcul.
    const solde = await accountBalanceOf(userId, caisseId, client);
    if (input.amount > solde + 0.005) {
      throw Errors.caisseEmpty({ available: round2(solde), requested: round2(input.amount) });
    }

    let transferId: string | null = null;
    let transactionId: string | null = null;

    if (input.memberId === tontine.my_member_id) {
      // C'est moi qui reçois : la caisse me verse sur un compte réel.
      const to = await resolveUserAccount(client, userId, input.accountId, tontine.account_id!);
      const { transfer } = await createTransferIn(client, userId, {
        fromAccountId: caisseId,
        toAccountId: to.id,
        amount: input.amount,
        occurredOn,
        note: `${tontine.name} — secours (${input.motif})`,
      });
      transferId = transfer.id;
    } else {
      // Un autre membre reçoit : l'argent quitte la caisse pour de bon. Ne
      // concerne que le collecteur — un participant ne détient pas la caisse
      // et n'a donc rien à saisir.
      if (tontine.role !== "collecteur") throw Errors.tontineNotCollector();
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO transactions (user_id, type, category, amount, occurred_on, method, note, account_id)
         VALUES ($1, 'depense', $2, $3, $4, 'Espèces', $5, $6) RETURNING id`,
        [userId, TONTINE_CATEGORY, input.amount, occurredOn,
         `${tontine.name} — secours à ${member.name} (${input.motif})`, caisseId],
      );
      transactionId = rows[0]!.id;
    }

    await client.query(
      `INSERT INTO tontine_caisse_movements
         (tontine_id, user_id, kind, amount, motif, member_id, transfer_id, transaction_id, occurred_on, note)
       VALUES ($1, $2, 'secours', $3, $4, $5, $6, $7, $8, $9)`,
      [tontineId, userId, input.amount, input.motif, member.id, transferId, transactionId, occurredOn, input.note ?? null],
    );

    const view = await loadTontineView(client, userId, tontineId);
    if (!view) throw new Error("[addSecours] tontine introuvable après secours");
    return view;
  });
}

/**
 * Annule un mouvement de caisse et défait l'argent qu'il avait créé — même
 * principe que décocher une cotisation : une saisie erronée ne doit pas
 * laisser un virement orphelin.
 */
export async function deleteCaisseMovement(userId: string, tontineId: string, movementId: string): Promise<TontineView> {
  return withTransaction(async (client) => {
    await lockTontine(client, userId, tontineId);
    const { rows } = await client.query<{ id: string; transfer_id: string | null; transaction_id: string | null }>(
      `SELECT id, transfer_id, transaction_id FROM tontine_caisse_movements
        WHERE id = $1 AND tontine_id = $2 AND user_id = $3`,
      [movementId, tontineId, userId],
    );
    const mv = rows[0];
    if (!mv) throw Errors.caisseMovementNotFound();

    // ON DELETE RESTRICT : on supprime la ligne AVANT ses supports.
    await client.query(`DELETE FROM tontine_caisse_movements WHERE id = $1`, [mv.id]);
    if (mv.transfer_id) await client.query(`DELETE FROM transfers WHERE id = $1`, [mv.transfer_id]);
    if (mv.transaction_id) await client.query(`DELETE FROM transactions WHERE id = $1`, [mv.transaction_id]);

    const view = await loadTontineView(client, userId, tontineId);
    if (!view) throw new Error("[deleteCaisseMovement] tontine introuvable après annulation");
    return view;
  });
}

/** Journal de la caisse d'un groupe, le plus récent en premier. */
export async function listCaisseMovements(userId: string, tontineId: string): Promise<CaisseMovementRow[]> {
  const { rows: owned } = await pool.query(`SELECT 1 FROM tontines WHERE id = $1 AND user_id = $2`, [tontineId, userId]);
  if (!owned[0]) throw Errors.tontineNotFound();
  const { rows } = await pool.query<CaisseMovementRow>(
    `SELECT c.id, c.tontine_id, c.kind, c.amount, c.motif, c.member_id,
            m.name AS member_name, c.occurred_on, c.note, c.created_at
       FROM tontine_caisse_movements c
       LEFT JOIN tontine_members m ON m.id = c.member_id
      WHERE c.tontine_id = $1 AND c.user_id = $2
      ORDER BY c.occurred_on DESC, c.created_at DESC`,
    [tontineId, userId],
  );
  return rows;
}
