import { pool, withTransaction } from "../db/pool.js";
import { Errors } from "../lib/errors.js";

export interface RubriqueRow {
  id: string;
  project_id: string;
  name: string;
  planned_amount: string | null;
  position: number;
  parent_rubrique_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RubriqueInput {
  name: string;
  plannedAmount?: number;
  // undefined = non fourni (ne touche pas au parent existant, en update) ;
  // null = retire explicitement le parent (la rubrique redevient de premier
  // niveau) ; string = rattache à cette rubrique parente. Profondeur
  // illimitée : une rubrique parente peut elle-même avoir un parent.
  parentRubriqueId?: string | null;
}

// Vérifie que le projet appartient bien à l'utilisateur avant toute opération
// sur ses rubriques — même garde-fou que projectService, nécessaire ici en
// plus car les rubriques n'ont pas directement de colonne user_id.
async function assertProjectOwnership(userId: string, projectId: string): Promise<void> {
  const { rows } = await pool.query(`SELECT id FROM projects WHERE id = $1 AND user_id = $2`, [projectId, userId]);
  if (!rows[0]) throw Errors.projectNotFound();
}

// Valide qu'une rubrique parente proposée est utilisable : elle doit exister
// dans LE MÊME projet (jamais de rattachement cross-projet), et — si on est
// en train de modifier une rubrique existante (selfId fourni) — le parent
// proposé ne doit être ni la rubrique elle-même, ni l'une de ses propres
// descendantes (sinon on créerait un cycle). La profondeur n'est pas
// limitée : le parent peut lui-même avoir un parent, à n'importe quel niveau.
async function assertValidParent(
  projectId: string,
  parentId: string,
  selfId: string | null,
): Promise<void> {
  if (selfId && parentId === selfId) {
    throw Errors.validation({ field: "parentRubriqueId", reason: "a rubrique cannot be its own parent" });
  }

  const { rows: parentRows } = await pool.query(
    `SELECT id FROM rubriques WHERE id = $1 AND project_id = $2`,
    [parentId, projectId],
  );
  if (!parentRows[0]) throw Errors.rubriqueNotFound();

  if (selfId) {
    // Un cycle ne peut être introduit que par une modification (reparent
    // d'une rubrique existante vers l'une de ses propres descendantes) —
    // impossible à la création puisque la nouvelle rubrique n'a encore
    // aucun enfant. On remonte la chaîne des parents à partir du parent
    // proposé : si on retombe sur selfId, le parent proposé est en fait un
    // descendant de la rubrique qu'on modifie.
    const { rows: cycleRows } = await pool.query(
      `WITH RECURSIVE ancestors AS (
         SELECT id, parent_rubrique_id FROM rubriques WHERE id = $1
         UNION ALL
         SELECT r.id, r.parent_rubrique_id FROM rubriques r
         JOIN ancestors a ON r.id = a.parent_rubrique_id
       )
       SELECT 1 FROM ancestors WHERE id = $2 LIMIT 1`,
      [parentId, selfId],
    );
    if (cycleRows[0]) {
      throw Errors.validation({
        field: "parentRubriqueId",
        reason: "cannot move a rubrique under one of its own sub-rubriques (would create a cycle)",
      });
    }
  }
}

// Liste les rubriques de l'utilisateur, optionnellement filtrées sur un seul
// projet. Ne renvoie QUE les champs stables (nom, enveloppe, parent) —
// jamais de montant réel dépensé pré-calculé : comme pour les projets (voir
// mapProjectFromApi côté front), ce total (et son cumul avec les
// sous-rubriques) doit toujours être recalculé depuis les transactions pour
// ne jamais se désynchroniser. Le front reconstruit l'arborescence à partir
// de parent_rubrique_id.
export async function listRubriques(userId: string, projectId?: string): Promise<RubriqueRow[]> {
  if (projectId) {
    await assertProjectOwnership(userId, projectId);
    const { rows } = await pool.query<RubriqueRow>(
      `SELECT r.* FROM rubriques r WHERE r.project_id = $1 ORDER BY r.position ASC, r.created_at ASC`,
      [projectId],
    );
    return rows;
  }
  const { rows } = await pool.query<RubriqueRow>(
    `SELECT r.* FROM rubriques r
       JOIN projects p ON p.id = r.project_id
      WHERE p.user_id = $1
      ORDER BY r.project_id, r.position ASC, r.created_at ASC`,
    [userId],
  );
  return rows;
}

export async function createRubrique(userId: string, projectId: string, input: RubriqueInput): Promise<RubriqueRow> {
  await assertProjectOwnership(userId, projectId);
  if (input.parentRubriqueId) {
    await assertValidParent(projectId, input.parentRubriqueId, null);
  }
  const { rows: posRows } = await pool.query<{ next_position: number }>(
    `SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM rubriques WHERE project_id = $1`,
    [projectId],
  );
  const { rows } = await pool.query<RubriqueRow>(
    `INSERT INTO rubriques (project_id, name, planned_amount, position, parent_rubrique_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [projectId, input.name, input.plannedAmount ?? null, posRows[0]!.next_position, input.parentRubriqueId ?? null],
  );
  return rows[0]!;
}

export async function updateRubrique(
  userId: string,
  projectId: string,
  id: string,
  input: Partial<RubriqueInput>,
): Promise<RubriqueRow> {
  await assertProjectOwnership(userId, projectId);
  const existing = await pool.query<RubriqueRow>(`SELECT * FROM rubriques WHERE id = $1 AND project_id = $2`, [id, projectId]);
  if (!existing.rows[0]) throw Errors.rubriqueNotFound();

  // parentRubriqueId a une sémantique à 3 états (absent = inchangé, null =
  // détache, string = rattache) qu'un simple COALESCE ne peut pas exprimer
  // (COALESCE ne sait jamais remettre une colonne à NULL). On calcule donc
  // explicitement la valeur finale à écrire.
  let nextParentId = existing.rows[0]!.parent_rubrique_id;
  if ("parentRubriqueId" in input) {
    if (input.parentRubriqueId) {
      await assertValidParent(projectId, input.parentRubriqueId, id);
      nextParentId = input.parentRubriqueId;
    } else {
      nextParentId = null;
    }
  }

  const { rows } = await pool.query<RubriqueRow>(
    `UPDATE rubriques SET
       name              = COALESCE($3, name),
       planned_amount    = COALESCE($4, planned_amount),
       parent_rubrique_id = $5
     WHERE id = $1 AND project_id = $2
     RETURNING *`,
    [id, projectId, input.name ?? null, input.plannedAmount ?? null, nextParentId],
  );
  return rows[0]!;
}

// Supprimer une rubrique ne doit jamais faire disparaître ses sous-rubriques
// ni les "aplatir" plus que nécessaire : ses enfants directs sont ré-attachés
// à SON propre parent (son grand-parent du point de vue des enfants), donc
// une sous-rubrique profonde ne remonte que d'un niveau, pas jusqu'en haut
// de l'arbre. Si la rubrique supprimée était déjà de premier niveau, ses
// enfants deviennent naturellement de premier niveau à leur tour. Fait dans
// une transaction pour ne jamais laisser les enfants dans un état
// intermédiaire incohérent.
export async function deleteRubrique(userId: string, projectId: string, id: string): Promise<void> {
  await assertProjectOwnership(userId, projectId);
  await withTransaction(async (client) => {
    const { rows } = await client.query<{ parent_rubrique_id: string | null }>(
      `SELECT parent_rubrique_id FROM rubriques WHERE id = $1 AND project_id = $2`,
      [id, projectId],
    );
    if (!rows[0]) throw Errors.rubriqueNotFound();
    const grandparentId = rows[0].parent_rubrique_id;

    await client.query(
      `UPDATE rubriques SET parent_rubrique_id = $3 WHERE parent_rubrique_id = $1 AND project_id = $2`,
      [id, projectId, grandparentId],
    );

    const { rowCount } = await client.query(`DELETE FROM rubriques WHERE id = $1 AND project_id = $2`, [id, projectId]);
    if (!rowCount) throw Errors.rubriqueNotFound();
  });
}

// Utilisé par transactionService pour valider rubriqueId à la création/mise à
// jour d'une transaction : la rubrique doit exister, appartenir à
// l'utilisateur (via son projet), et correspondre au projectId fourni sur la
// même transaction — on n'autorise jamais une rubrique d'un autre projet.
// Une dépense peut être rattachée à une rubrique de n'importe quel niveau
// (racine ou sous-rubrique, à n'importe quelle profondeur) : aucune
// restriction ici liée à la hiérarchie.
export async function assertRubriqueBelongsToProject(userId: string, rubriqueId: string, projectId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT r.id FROM rubriques r
       JOIN projects p ON p.id = r.project_id
      WHERE r.id = $1 AND r.project_id = $2 AND p.user_id = $3`,
    [rubriqueId, projectId, userId],
  );
  if (!rows[0]) throw Errors.rubriqueNotFound();
}
