import type { PoolClient } from "pg";
import { pool, withTransaction } from "../db/pool.js";
import { Errors } from "../lib/errors.js";
import { assertRubriqueBelongsToProject } from "./rubriqueService.js";
import { assertAccountUsable, ensureDefaultAccount, feeCategoryFor, type AccountType } from "./accountService.js";

export interface TransactionRow {
  id: string;
  type: "revenu" | "depense";
  // NULL pour une opération de projet : c'est sa rubrique qui la classe
  // (migration 037). Tout affichage doit donc tolérer son absence.
  category: string | null;
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
  // Clé d'idempotence de la file d'attente hors réseau (migration 039). NULL
  // pour toute opération saisie en ligne.
  client_key: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface TransactionInput {
  type: "revenu" | "depense";
  // Facultative depuis la migration 037 : dans un projet, c'est la rubrique
  // qui classe l'opération, et la catégorie n'est pas enregistrée.
  category?: string;
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
  // Clé d'idempotence (migration 039) : posée par la file d'attente hors
  // réseau avant le premier envoi et rejouée à chaque renvoi. Absente pour
  // une saisie en ligne.
  clientKey?: string;
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

/**
 * Règle de classement d'une opération (migration 037).
 *
 * Hors projet : une CATÉGORIE, comme toujours.
 * Dans un projet : une RUBRIQUE, et pas de catégorie — c'est la rubrique qui
 * classe. Exiger les deux revenait à faire saisir deux taxonomies pour la même
 * dépense, dont une que le Budget ignorait déjà.
 *
 * Renvoie la catégorie à écrire : celle fournie hors projet, `null` dedans.
 * Appliqué ici plutôt que dans le validateur Zod parce que la règle dépend de
 * l'appartenance de la rubrique au projet, qui demande la base.
 */
export function resolveClassement(
  projectId: string | null | undefined,
  rubriqueId: string | null | undefined,
  category: string | null | undefined,
): string | null {
  if (projectId) {
    // La rubrique n'est PAS exigée (choix de Yannis) : sans elle, l'opération
    // est « Non classé », un état que la vue Projets affiche depuis toujours
    // et que produit déjà la suppression d'une rubrique. Bloquer ici serait
    // incohérent avec ce qui arrive par cette autre porte, et ferait perdre
    // une dépense notée dans l'urgence sur un chantier.
    //
    // La catégorie éventuellement envoyée par un client plus ancien est
    // ignorée, pas refusée : il n'a pas à connaître la règle.
    return null;
  }
  if (!category) {
    throw Errors.validation({ field: "category", reason: "required outside a project" });
  }
  return category;
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

// L'opération d'origine peut n'avoir aucune catégorie (opération de projet,
// migration 037) : on se rabat alors sur sa note, puis sur un libellé neutre,
// plutôt que d'écrire « Frais · null » dans l'historique.
function feeNote(note: string | null, category: string | null): string {
  return `Frais · ${note || category || "opération"}`.slice(0, 280);
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
  // Rejeu d'une opération déjà passée (migration 039) : la réponse s'est
  // perdue, le téléphone réessaie avec la même clé. On renvoie ce qui existe
  // déjà, sans rien créer. Ce contrôle vient AVANT toute validation : une
  // opération déjà enregistrée n'a pas à être revalidée, et son projet a pu
  // être supprimé entre-temps.
  if (input.clientKey) {
    const deja = await findByClientKey(userId, input.clientKey);
    if (deja) return deja;
  }

  if (input.projectId) await assertProjectOwnedByUser(userId, input.projectId);
  await assertProjectAndRubriqueConsistent(userId, input.projectId, input.rubriqueId);
  const category = resolveClassement(input.projectId, input.rubriqueId, input.category);

  const accountId = input.accountId
    ? (await assertAccountUsable(userId, input.accountId)).id
    : await ensureDefaultAccount(userId);

  try {
    return await withTransaction(async (client) => {
      const { rows } = await client.query<TransactionRow>(
        `INSERT INTO transactions (user_id, type, category, amount, occurred_on, method, note, project_id, rubrique_id, account_id, client_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [userId, input.type, category, input.amount, input.occurredOn, input.method, input.note ?? null, input.projectId ?? null, input.rubriqueId ?? null, accountId, input.clientKey ?? null],
      );
      const transaction = rows[0]!;
      const feeTransaction = input.fee && input.fee > 0 ? await syncFee(client, userId, transaction, input.fee) : null;
      return { transaction, feeTransaction };
    });
  } catch (err) {
    // Deux renvois partis en même temps : le premier a gagné la course, le
    // second heurte l'index unique. Ce n'est pas une erreur du point de vue
    // de l'utilisateur — son opération est bien enregistrée — donc on lui
    // renvoie celle qui est passée plutôt qu'un 500.
    if (input.clientKey && (err as { code?: string }).code === "23505") {
      const gagnante = await findByClientKey(userId, input.clientKey);
      if (gagnante) return gagnante;
    }
    throw err;
  }
}

/**
 * Retrouve une opération déjà enregistrée sous cette clé, avec ses frais
 * éventuels — la réponse doit être identique à celle du premier envoi, sans
 * quoi le client croirait les frais perdus.
 */
async function findByClientKey(
  userId: string,
  clientKey: string,
): Promise<{ transaction: TransactionRow; feeTransaction: TransactionRow | null } | null> {
  const { rows } = await pool.query<TransactionRow>(
    `SELECT * FROM transactions WHERE user_id = $1 AND client_key = $2`,
    [userId, clientKey],
  );
  const transaction = rows[0];
  if (!transaction) return null;
  const fees = await pool.query<TransactionRow>(
    `SELECT * FROM transactions WHERE user_id = $1 AND fee_parent_id = $2`,
    [userId, transaction.id],
  );
  return { transaction, feeTransaction: fees.rows[0] ?? null };
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
  await assertNotTontineMovement(id);

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
  // Rattacher une opération existante à un projet efface sa catégorie, et
  // l'en détacher en réclame une : le classement suit la destination, pas
  // l'état d'origine. Dans un projet, l'absence de rubrique est permise et
  // vaut « Non classé » (voir resolveClassement).
  const nextCategory = resolveClassement(nextProjectId, nextRubriqueId, input.category ?? current.category);

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
         category = $4,
         amount = COALESCE($5, amount),
         occurred_on = COALESCE($6, occurred_on),
         method = COALESCE($7, method),
         note = $8,
         project_id = $9,
         rubrique_id = $10,
         account_id = COALESCE($11, account_id)
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [id, userId, input.type ?? null, nextCategory, input.amount ?? null, input.occurredOn ?? null, input.method ?? null, nextNote, nextProjectId, nextRubriqueId, input.accountId ?? null],
    );
    const transaction = rows[0]!;
    const feeTransaction = await syncFee(client, userId, transaction, input.fee);
    return { transaction, feeTransaction };
  });
}

/**
 * Une opération produite par le module Tontine (entrée dans la cagnotte,
 * caisse de solidarité, pénalité, versement au bénéficiaire) ne se modifie ni
 * ne se supprime depuis l'historique : elle est l'envers comptable d'une
 * cotisation cochée ou d'un tour clôturé. La défaire ici laisserait la
 * cotisation cochée en face de rien — le même défaut que
 * TRANSFER_BACKS_SAVINGS corrige pour l'épargne. On décoche la cotisation dans
 * le module Tontine, qui défait les deux ensemble.
 */
async function assertNotTontineMovement(id: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT 1 FROM tontine_contributions WHERE pot_transaction_id = $1 OR extra_transaction_id = $1
     UNION ALL
     SELECT 1 FROM tontine_round_history WHERE payout_transaction_id = $1`,
    [id],
  );
  if (rows[0]) throw Errors.transactionIsTontineMovement();
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
  await assertNotTontineMovement(id);
  await pool.query(`DELETE FROM transactions WHERE id = $1 AND user_id = $2`, [id, userId]);
}
