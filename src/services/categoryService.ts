import { pool, withTransaction } from "../db/pool.js";
import { Errors } from "../lib/errors.js";
import { CATEGORIES } from "../lib/categories.js";

export interface CategoryRow {
  id: string;
  user_id: string;
  name: string;
  color: string;
  created_at: Date;
}

// Même palette cyclique que RUBRIQUE_PALETTE côté front (public/app/index.html)
// — répétée ici pour que la couleur soit attribuée une fois à la création et
// reste stable ensuite (stockée en base), plutôt que recalculée différemment
// à chaque rendu client.
const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];

export async function listCategories(userId: string): Promise<CategoryRow[]> {
  const { rows } = await pool.query<CategoryRow>(
    `SELECT * FROM categories WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId],
  );
  return rows;
}

/**
 * Crée une catégorie personnalisée pour l'utilisateur. Refuse un nom déjà
 * pris, que ce soit par une catégorie de base (CATEGORIES, fixe) ou par une
 * catégorie personnalisée existante — comparaison insensible à la casse pour
 * éviter les doublons du type "Abonnements" / "abonnements". La couleur est
 * assignée une fois ici (cycle sur PALETTE selon le nombre de catégories déjà
 * créées par l'utilisateur) et ne change plus ensuite.
 */
export async function createCategory(userId: string, name: string): Promise<CategoryRow> {
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  if (CATEGORIES.some((c) => c.toLowerCase() === lower)) {
    throw Errors.categoryAlreadyExists();
  }
  const existing = await listCategories(userId);
  if (existing.some((c) => c.name.toLowerCase() === lower)) {
    throw Errors.categoryAlreadyExists();
  }
  const color = PALETTE[existing.length % PALETTE.length];
  const { rows } = await pool.query<CategoryRow>(
    `INSERT INTO categories (user_id, name, color) VALUES ($1, $2, $3) RETURNING *`,
    [userId, trimmed, color],
  );
  return rows[0]!;
}

/**
 * Supprime une catégorie personnalisée de la liste de l'utilisateur. Sans
 * effet sur les transactions/budgets/événements planner qui l'utilisent déjà
 * — category y est une simple chaîne (voir migrations/026_categories.sql),
 * ils gardent le nom tel quel, seules les nouvelles saisies ne la proposeront
 * plus.
 */
export async function deleteCategory(userId: string, id: string): Promise<void> {
  const { rowCount } = await pool.query(`DELETE FROM categories WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!rowCount) throw Errors.categoryNotFound();
}

/* ---------------------------------------------------------------------------
   Renommer et réaffecter (maj35)
   ---------------------------------------------------------------------------
   Une catégorie est recopiée TELLE QUELLE dans quatre tables : transactions,
   budgets, planner_events, transaction_favorites. C'est le choix de la
   migration 026 — un simple texte, sans table de jonction — et il tient
   toujours : il rend une catégorie supprimée inoffensive pour l'historique.
   Il a ce prix : rien ne relie « Scolarité » le budget à « Scolarité » la
   catégorie, sinon le mot lui-même.

   Renommer sans toucher au reste laisserait donc des lignes orphelines :
   un budget portant un nom qui n'existe plus dans aucune liste. Le renommage
   réécrit le mot PARTOUT, dans une seule transaction SQL — tout change, ou
   rien ne change.

   La comparaison est insensible à la casse, comme l'index unique de la table
   categories : une opération enregistrée « scolarité » appartient bien à la
   catégorie « Scolarité ». */

/** Les quatre tables qui recopient le nom d'une catégorie. */
const TABLES_PORTANT_UNE_CATEGORIE = [
  "transactions",
  "budgets",
  "planner_events",
  "transaction_favorites",
] as const;

export interface CategoryUsage {
  transactions: number;
  budgets: number;
  plannerEvents: number;
  favorites: number;
}

const USAGE_VIDE: CategoryUsage = { transactions: 0, budgets: 0, plannerEvents: 0, favorites: 0 };

/** Compte, table par table, ce qui porte ce nom de catégorie. */
export async function categoryUsage(userId: string, name: string): Promise<CategoryUsage> {
  const counts = await Promise.all(
    TABLES_PORTANT_UNE_CATEGORIE.map((table) =>
      pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = $1 AND lower(category) = lower($2)`,
        [userId, name],
      ),
    ),
  );
  return {
    transactions: Number(counts[0]!.rows[0]!.n),
    budgets: Number(counts[1]!.rows[0]!.n),
    plannerEvents: Number(counts[2]!.rows[0]!.n),
    favorites: Number(counts[3]!.rows[0]!.n),
  };
}

async function findCategory(userId: string, id: string): Promise<CategoryRow> {
  const { rows } = await pool.query<CategoryRow>(
    `SELECT * FROM categories WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  if (!rows[0]) throw Errors.categoryNotFound();
  return rows[0];
}

/**
 * Renomme une catégorie personnelle ET toutes les lignes qui la portent.
 *
 * Refuse un nom déjà pris, de base ou personnel — décision de Yannis : pas de
 * fusion. Renommer « Scolarité » en « Éducation » quand « Éducation » existe
 * n'est pas un renommage mais une fusion, qui combinerait deux historiques et
 * ferait de toute façon entrer deux budgets en collision (budgets a un index
 * unique sur (user_id, category)). On refuse en nommant le conflit, plutôt
 * que de deviner ce que l'utilisateur voulait.
 */
export async function renameCategory(
  userId: string,
  id: string,
  newName: string,
): Promise<{ category: CategoryRow; usage: CategoryUsage }> {
  const trimmed = newName.trim();
  const lower = trimmed.toLowerCase();
  const current = await findCategory(userId, id);

  // Même nom à la casse près : on laisse passer, c'est une correction de casse
  // (« scolarité » → « Scolarité ») et elle doit être possible.
  if (current.name.toLowerCase() !== lower) {
    if (CATEGORIES.some((c) => c.toLowerCase() === lower)) throw Errors.categoryAlreadyExists();
    const existing = await listCategories(userId);
    if (existing.some((c) => c.id !== id && c.name.toLowerCase() === lower)) {
      throw Errors.categoryAlreadyExists();
    }
  }

  const usage = await categoryUsage(userId, current.name);

  const category = await withTransaction(async (client) => {
    for (const table of TABLES_PORTANT_UNE_CATEGORIE) {
      await client.query(
        `UPDATE ${table} SET category = $1 WHERE user_id = $2 AND lower(category) = lower($3)`,
        [trimmed, userId, current.name],
      );
    }
    const { rows } = await client.query<CategoryRow>(
      `UPDATE categories SET name = $1 WHERE id = $2 AND user_id = $3 RETURNING *`,
      [trimmed, id, userId],
    );
    return rows[0]!;
  });

  return { category, usage };
}

/**
 * Supprime une catégorie personnelle, en réaffectant éventuellement ce qui la
 * portait à une autre catégorie.
 *
 * `reassignTo` absent : comportement d'origine — les lignes gardent le nom
 * tel quel, et il n'est simplement plus proposé à la saisie.
 *
 * `reassignTo` fourni : opérations, échéances et favoris passent à cette
 * catégorie. Le BUDGET éventuel de la catégorie supprimée est supprimé avec
 * elle, jamais transféré : une limite mensuelle définie pour « Scolarité » ne
 * dit rien de ce que devrait être celle d'« Éducation », et la reporter
 * changerait en silence une limite que l'utilisateur a fixée lui-même. La
 * table budgets refuserait de toute façon deux lignes sur la même catégorie.
 */
export async function deleteCategoryWithReassign(
  userId: string,
  id: string,
  reassignTo?: string,
): Promise<{ usage: CategoryUsage; reassignedTo: string | null }> {
  const current = await findCategory(userId, id);
  if (!reassignTo) {
    await deleteCategory(userId, id);
    return { usage: USAGE_VIDE, reassignedTo: null };
  }

  const cible = reassignTo.trim();
  const cibleLower = cible.toLowerCase();
  if (cibleLower === current.name.toLowerCase()) throw Errors.validation({ field: "reassignTo" });
  const connue =
    CATEGORIES.some((c) => c.toLowerCase() === cibleLower) ||
    (await listCategories(userId)).some((c) => c.name.toLowerCase() === cibleLower);
  if (!connue) throw Errors.categoryNotFound();

  const usage = await categoryUsage(userId, current.name);

  await withTransaction(async (client) => {
    for (const table of ["transactions", "planner_events", "transaction_favorites"] as const) {
      await client.query(
        `UPDATE ${table} SET category = $1 WHERE user_id = $2 AND lower(category) = lower($3)`,
        [cible, userId, current.name],
      );
    }
    await client.query(`DELETE FROM budgets WHERE user_id = $1 AND lower(category) = lower($2)`, [
      userId,
      current.name,
    ]);
    await client.query(`DELETE FROM categories WHERE id = $1 AND user_id = $2`, [id, userId]);
  });

  return { usage, reassignedTo: cible };
}
