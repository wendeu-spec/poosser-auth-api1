import { pool } from "../db/pool.js";
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
