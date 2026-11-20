import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, resetDb, registerFreshUser } from "./helpers.js";
import { pool } from "../src/db/pool.js";

/**
 * Dans un projet, la rubrique remplace la catégorie
 * (migrations/037_projet_rubrique_classement.sql).
 *
 * Défaut signalé par Yannis : le formulaire réclamait une catégorie ET une
 * rubrique pour la même dépense de projet — deux taxonomies pour un seul
 * mouvement, alors que le Budget ignorait déjà la catégorie des opérations de
 * projet.
 *
 * Ce que ces tests verrouillent :
 *   - hors projet, la catégorie reste obligatoire ;
 *   - dans un projet, la catégorie n'est pas enregistrée, même si un client
 *     l'envoie ;
 *   - la rubrique, elle, n'est JAMAIS obligatoire : sans elle l'opération est
 *     « Non classé », l'état que produit déjà la suppression d'une rubrique ;
 *   - rattacher une opération à un projet efface sa catégorie, l'en détacher
 *     en réclame une ;
 *   - un favori créé depuis une opération de projet suit la même règle ;
 *   - la rubrique doit appartenir au projet, et le projet à l'utilisateur.
 */

beforeEach(resetDb);

const auth = (access: string) => ({ Authorization: `Bearer ${access}` });

async function authedUser() {
  const { body } = await registerFreshUser();
  return { access: body.accessToken as string, userId: body.user.id as string };
}

async function createProject(access: string, name = "Construction") {
  const res = await request(app).post("/api/projects").set(auth(access)).send({ name }).expect(201);
  return res.body.project as { id: string; name: string };
}

async function createRubrique(access: string, projectId: string, name: string) {
  const res = await request(app)
    .post(`/api/projects/${projectId}/rubriques`)
    .set(auth(access))
    .send({ name })
    .expect(201);
  return res.body.rubrique as { id: string; name: string };
}

const createTx = (access: string, body: Record<string, unknown>) =>
  request(app)
    .post("/api/transactions")
    .set(auth(access))
    .send({ type: "depense", amount: 25_000, occurredOn: "2026-11-10", method: "Espèces", ...body });

describe("hors projet, la catégorie reste le classement", () => {
  it("accepte une opération avec une catégorie", async () => {
    const { access } = await authedUser();
    const res = await createTx(access, { category: "Alimentation" }).expect(201);
    expect(res.body.transaction.category).toBe("Alimentation");
    expect(res.body.transaction.rubrique_id).toBeNull();
  });

  it("refuse une opération sans catégorie ni projet", async () => {
    const { access } = await authedUser();
    const res = await createTx(access, {}).expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details.field).toBe("category");
  });
});

describe("dans un projet, la rubrique remplace la catégorie", () => {
  it("enregistre la rubrique et AUCUNE catégorie", async () => {
    const { access } = await authedUser();
    const p = await createProject(access);
    const r = await createRubrique(access, p.id, "Fondation");

    const res = await createTx(access, { projectId: p.id, rubriqueId: r.id }).expect(201);
    expect(res.body.transaction.rubrique_id).toBe(r.id);
    expect(res.body.transaction.category).toBeNull();
  });

  it("ignore la catégorie envoyée par un client qui ne connaît pas la règle", async () => {
    const { access } = await authedUser();
    const p = await createProject(access);
    const r = await createRubrique(access, p.id, "Toiture");

    // Un client en cache enverra encore une catégorie : on l'ignore plutôt que
    // de refuser, il n'a pas à connaître la règle.
    const res = await createTx(access, { projectId: p.id, rubriqueId: r.id, category: "Alimentation" }).expect(201);
    expect(res.body.transaction.category).toBeNull();
  });

  it("accepte une opération de projet sans rubrique : elle est « Non classé »", async () => {
    const { access } = await authedUser();
    const p = await createProject(access);
    // Choix de Yannis : la saisie n'est JAMAIS bloquée. Un projet tout neuf
    // n'a pas encore de rubrique, et arrêter l'utilisateur en pleine saisie
    // ferait perdre la dépense plus sûrement qu'un classement différé. C'est
    // aussi l'état que produit déjà la suppression d'une rubrique.
    const res = await createTx(access, { projectId: p.id, category: "Alimentation" }).expect(201);
    expect(res.body.transaction.project_id).toBe(p.id);
    expect(res.body.transaction.rubrique_id).toBeNull();
    // Pas de catégorie pour autant : on ne range pas un poste de chantier
    // dans la liste des catégories personnelles.
    expect(res.body.transaction.category).toBeNull();
  });

  it("refuse une rubrique qui appartient à un autre projet", async () => {
    const { access } = await authedUser();
    const a = await createProject(access, "Chantier A");
    const b = await createProject(access, "Chantier B");
    const rb = await createRubrique(access, b.id, "Toiture");
    // 404 et non 403 : une rubrique qui n'est pas dans ce projet est traitée
    // comme inexistante, comme partout ailleurs dans le module métier.
    const res = await createTx(access, { projectId: a.id, rubriqueId: rb.id }).expect(404);
    expect(res.body.error.code).toBe("RUBRIQUE_NOT_FOUND");
  });

  it("refuse le projet d'un autre utilisateur (404, pas une fuite)", async () => {
    const moi = await authedUser();
    const autre = await authedUser();
    const p = await createProject(autre.access);
    const r = await createRubrique(autre.access, p.id, "Fondation");
    const res = await createTx(moi.access, { projectId: p.id, rubriqueId: r.id }).expect(404);
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
  });
});

describe("le classement suit la destination quand on modifie", () => {
  it("rattacher une opération à un projet efface sa catégorie", async () => {
    const { access } = await authedUser();
    const p = await createProject(access);
    const r = await createRubrique(access, p.id, "Élévation");
    const tx = (await createTx(access, { category: "Alimentation" }).expect(201)).body.transaction;

    const res = await request(app)
      .patch(`/api/transactions/${tx.id}`)
      .set(auth(access))
      .send({ projectId: p.id, rubriqueId: r.id })
      .expect(200);
    expect(res.body.transaction.category).toBeNull();
    expect(res.body.transaction.rubrique_id).toBe(r.id);
  });

  it("détacher du projet réclame une catégorie", async () => {
    const { access } = await authedUser();
    const p = await createProject(access);
    const r = await createRubrique(access, p.id, "Plomberie");
    const tx = (await createTx(access, { projectId: p.id, rubriqueId: r.id }).expect(201)).body.transaction;

    // Sans catégorie, l'opération se retrouverait sans aucun classement.
    const refus = await request(app)
      .patch(`/api/transactions/${tx.id}`)
      .set(auth(access))
      .send({ projectId: null, rubriqueId: null })
      .expect(400);
    expect(refus.body.error.details.field).toBe("category");

    const ok = await request(app)
      .patch(`/api/transactions/${tx.id}`)
      .set(auth(access))
      .send({ projectId: null, rubriqueId: null, category: "Logement" })
      .expect(200);
    expect(ok.body.transaction.category).toBe("Logement");
  });
});

describe("supprimer une rubrique laisse ses opérations « Non classé »", () => {
  it("détache sans effacer, même quand l'opération n'a pas de catégorie", async () => {
    const { access } = await authedUser();
    const p = await createProject(access);
    const r = await createRubrique(access, p.id, "Menuiserie");
    const tx = (await createTx(access, { projectId: p.id, rubriqueId: r.id }).expect(201)).body.transaction;

    await request(app).delete(`/api/projects/${p.id}/rubriques/${r.id}`).set(auth(access)).expect(204);

    // L'opération survit, sans rubrique NI catégorie. C'est un état légitime —
    // la vue Projets l'affiche « Non classé » et son donut lui réserve un
    // segment. Une contrainte « toujours classée » avait été écrite en base
    // puis retirée pour cette raison : elle transformait une suppression de
    // rubrique normale en erreur 500.
    const { rows } = await pool.query<{ category: string | null; rubrique_id: string | null; project_id: string | null }>(
      `SELECT category, rubrique_id, project_id FROM transactions WHERE id = $1`,
      [tx.id],
    );
    expect(rows[0]!.rubrique_id).toBeNull();
    expect(rows[0]!.category).toBeNull();
    expect(rows[0]!.project_id).toBe(p.id);
  });
});

describe("les frais d'une opération de projet restent lisibles", () => {
  it("nomme les frais depuis la note quand il n'y a pas de catégorie", async () => {
    const { access } = await authedUser();
    const p = await createProject(access);
    const r = await createRubrique(access, p.id, "Transport");
    const res = await createTx(access, {
      projectId: p.id, rubriqueId: r.id, note: "Livraison ciment", fee: 500,
    }).expect(201);
    // Sans ce repli, l'historique afficherait « Frais · null ».
    expect(res.body.feeTransaction.note).toBe("Frais · Livraison ciment");
  });
});

/**
 * Trouvé en relisant le changement, pas par un test existant : « ☆ Favori »
 * sur une opération de projet recopie son type, son montant, son projet et sa
 * rubrique — et sa catégorie, désormais absente. La colonne `category` des
 * favoris étant NOT NULL depuis la migration 022, l'enregistrement échouait.
 */
describe("un favori de projet suit la même règle", () => {
  const favori = (access: string, body: Record<string, unknown>) =>
    request(app)
      .post("/api/transaction-favorites")
      .set(auth(access))
      .send({ label: "Ciment", type: "depense", amount: 25_000, method: "Espèces", ...body });

  it("accepte un favori de projet sans catégorie", async () => {
    const { access } = await authedUser();
    const p = await createProject(access);
    const r = await createRubrique(access, p.id, "Fondation");

    const res = await favori(access, { projectId: p.id, rubriqueId: r.id }).expect(201);
    expect(res.body.transactionFavorite.category).toBeNull();
    expect(res.body.transactionFavorite.rubrique_id).toBe(r.id);
  });

  it("ignore une catégorie envoyée avec un favori de projet", async () => {
    const { access } = await authedUser();
    const p = await createProject(access);
    const r = await createRubrique(access, p.id, "Toiture");

    const res = await favori(access, { projectId: p.id, rubriqueId: r.id, category: "Logement" }).expect(201);
    expect(res.body.transactionFavorite.category).toBeNull();
  });

  it("exige toujours une catégorie hors projet", async () => {
    const { access } = await authedUser();
    const res = await favori(access, {}).expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("efface la catégorie d'un favori qu'on rattache à un projet", async () => {
    const { access } = await authedUser();
    const p = await createProject(access);
    const r = await createRubrique(access, p.id, "Élévation");
    const cree = await favori(access, { category: "Logement" }).expect(201);

    const res = await request(app)
      .patch(`/api/transaction-favorites/${cree.body.transactionFavorite.id}`)
      .set(auth(access))
      .send({ projectId: p.id, rubriqueId: r.id })
      .expect(200);
    expect(res.body.transactionFavorite.category).toBeNull();
  });
});
