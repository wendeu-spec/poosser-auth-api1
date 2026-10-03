import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, resetDb, registerFreshUser } from "./helpers.js";

beforeEach(resetDb);

async function authedUser() {
  const { body } = await registerFreshUser();
  return { access: body.accessToken as string, userId: body.user.id as string };
}

describe("routes métier — exigent toutes un access token", () => {
  it("refuse tout accès sans token (401)", async () => {
    await request(app).get("/api/transactions").expect(401);
    await request(app).get("/api/budgets").expect(401);
    await request(app).get("/api/savings-goals").expect(401);
    await request(app).get("/api/savings-goal-contributions").expect(401);
    await request(app).get("/api/projects").expect(401);
    await request(app).get("/api/rubriques").expect(401);
    await request(app).get("/api/transaction-favorites").expect(401);
    await request(app).get("/api/tontines").expect(401);
    await request(app).get("/api/planner-events").expect(401);
  });
});

describe("POST/GET /api/transactions", () => {
  it("crée puis liste une transaction pour l'utilisateur authentifié", async () => {
    const { access } = await authedUser();
    const create = await request(app)
      .post("/api/transactions")
      .set("Authorization", `Bearer ${access}`)
      .send({ type: "depense", category: "Alimentation", amount: 15000, occurredOn: "2026-08-18", method: "Mobile Money", note: "Marché" })
      .expect(201);
    expect(create.body.transaction.category).toBe("Alimentation");

    const list = await request(app).get("/api/transactions").set("Authorization", `Bearer ${access}`).expect(200);
    expect(list.body.transactions).toHaveLength(1);
  });

  // category a été desserré d'un z.enum(CATEGORIES) fermé à une chaîne libre
  // (bornée) pour accepter aussi les catégories personnalisées de
  // l'utilisateur (voir POST /api/categories ci-dessous) — un nom qui n'est
  // ni une catégorie de base ni une catégorie personnalisée existante est
  // donc désormais accepté tel quel : seule la forme (non vide, <= 60
  // caractères) est encore validée ici.
  it("accepte n'importe quel nom de catégorie non vide (catégories personnalisées)", async () => {
    const { access } = await authedUser();
    const res = await request(app)
      .post("/api/transactions")
      .set("Authorization", `Bearer ${access}`)
      .send({ type: "depense", category: "Abonnements", amount: 1000, occurredOn: "2026-08-18", method: "Espèces" })
      .expect(201);
    expect(res.body.transaction.category).toBe("Abonnements");
  });

  it("refuse une catégorie vide", async () => {
    const { access } = await authedUser();
    const res = await request(app)
      .post("/api/transactions")
      .set("Authorization", `Bearer ${access}`)
      .send({ type: "depense", category: "", amount: 1000, occurredOn: "2026-08-18", method: "Espèces" })
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("modifie puis supprime une transaction", async () => {
    const { access } = await authedUser();
    const create = await request(app)
      .post("/api/transactions")
      .set("Authorization", `Bearer ${access}`)
      .send({ type: "depense", category: "Transport", amount: 5000, occurredOn: "2026-08-18", method: "Espèces" })
      .expect(201);
    const id = create.body.transaction.id;

    const update = await request(app)
      .patch(`/api/transactions/${id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ amount: 7000 })
      .expect(200);
    expect(Number(update.body.transaction.amount)).toBe(7000);

    await request(app).delete(`/api/transactions/${id}`).set("Authorization", `Bearer ${access}`).expect(204);
    const list = await request(app).get("/api/transactions").set("Authorization", `Bearer ${access}`).expect(200);
    expect(list.body.transactions).toHaveLength(0);
  });
});

// Couvre le bouton "✏️ Modifier" de l'historique (voir public/app/index.html,
// enterTxEditMode) : note/projectId/rubriqueId doivent pouvoir être
// explicitement effacés/détachés via null, pas seulement remplacés.
describe("PATCH /api/transactions/:id — modification en place (tri-état)", () => {
  it("modifie tous les champs de base d'une transaction existante", async () => {
    const { access } = await authedUser();
    const create = await request(app)
      .post("/api/transactions")
      .set("Authorization", `Bearer ${access}`)
      .send({ type: "depense", category: "Transport", amount: 5000, occurredOn: "2026-08-18", method: "Espèces", note: "Taxi" })
      .expect(201);
    const id = create.body.transaction.id;

    const update = await request(app)
      .patch(`/api/transactions/${id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ type: "revenu", category: "Salaire", amount: 120000, occurredOn: "2026-08-20", method: "Virement bancaire", note: "Corrigé" })
      .expect(200);
    expect(update.body.transaction.type).toBe("revenu");
    expect(update.body.transaction.category).toBe("Salaire");
    expect(Number(update.body.transaction.amount)).toBe(120000);
    expect(update.body.transaction.occurred_on).toContain("2026-08-20");
    expect(update.body.transaction.method).toBe("Virement bancaire");
    expect(update.body.transaction.note).toBe("Corrigé");
  });

  it("efface explicitement la note via note: null, sans la toucher si le champ est absent", async () => {
    const { access } = await authedUser();
    const create = await request(app)
      .post("/api/transactions")
      .set("Authorization", `Bearer ${access}`)
      .send({ type: "depense", category: "Alimentation", amount: 3000, occurredOn: "2026-08-18", method: "Espèces", note: "Marché" })
      .expect(201);
    const id = create.body.transaction.id;

    // Un PATCH qui ne mentionne pas `note` ne doit pas y toucher.
    const unrelated = await request(app)
      .patch(`/api/transactions/${id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ amount: 3500 })
      .expect(200);
    expect(unrelated.body.transaction.note).toBe("Marché");

    // `note: null` doit explicitement l'effacer.
    const cleared = await request(app)
      .patch(`/api/transactions/${id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ note: null })
      .expect(200);
    expect(cleared.body.transaction.note).toBeNull();
  });

  it("détache explicitement projectId et rubriqueId via null", async () => {
    const { access } = await authedUser();
    const project = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Voyage" })
      .expect(201);
    const projectId = project.body.project.id;
    const rubrique = await request(app)
      .post(`/api/projects/${projectId}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Transport" })
      .expect(201);
    const rubriqueId = rubrique.body.rubrique.id;

    const create = await request(app)
      .post("/api/transactions")
      .set("Authorization", `Bearer ${access}`)
      .send({ type: "depense", category: "Transport", amount: 5000, occurredOn: "2026-08-18", method: "Espèces", projectId, rubriqueId })
      .expect(201);
    const id = create.body.transaction.id;

    // Un PATCH qui ne mentionne ni l'un ni l'autre ne doit rien détacher.
    const unrelated = await request(app)
      .patch(`/api/transactions/${id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ amount: 5500 })
      .expect(200);
    expect(unrelated.body.transaction.project_id).toBe(projectId);
    expect(unrelated.body.transaction.rubrique_id).toBe(rubriqueId);

    // rubriqueId: null détache la rubrique sans toucher au projet.
    const rubDetached = await request(app)
      .patch(`/api/transactions/${id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ rubriqueId: null })
      .expect(200);
    expect(rubDetached.body.transaction.rubrique_id).toBeNull();
    expect(rubDetached.body.transaction.project_id).toBe(projectId);

    // projectId: null détache aussi le projet (vision "mouvement libre").
    const projDetached = await request(app)
      .patch(`/api/transactions/${id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ projectId: null })
      .expect(200);
    expect(projDetached.body.transaction.project_id).toBeNull();
  });

  it("refuse rubriqueId sans projectId effectif, et une rubrique d'un autre projet", async () => {
    const { access } = await authedUser();
    const projectA = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Projet A" })
      .expect(201);
    const projectB = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Projet B" })
      .expect(201);
    const rubriqueB = await request(app)
      .post(`/api/projects/${projectB.body.project.id}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Hébergement" })
      .expect(201);

    const create = await request(app)
      .post("/api/transactions")
      .set("Authorization", `Bearer ${access}`)
      .send({ type: "depense", category: "Autres", amount: 1000, occurredOn: "2026-08-18", method: "Espèces", projectId: projectA.body.project.id })
      .expect(201);
    const id = create.body.transaction.id;

    // La rubrique appartient au projet B, la transaction est sur le projet A
    // → même traitement que "emprunter" une rubrique d'un autre projet à la
    // création (404 RUBRIQUE_NOT_FOUND, pas une fuite d'info entre projets).
    const crossProject = await request(app)
      .patch(`/api/transactions/${id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ rubriqueId: rubriqueB.body.rubrique.id })
      .expect(404);
    expect(crossProject.body.error.code).toBe("RUBRIQUE_NOT_FOUND");

    // Détacher le projet ET fournir une rubrique dans le même PATCH : la
    // rubrique n'a alors plus de projet effectif auquel appartenir.
    const noEffectiveProject = await request(app)
      .patch(`/api/transactions/${id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ projectId: null, rubriqueId: rubriqueB.body.rubrique.id })
      .expect(400);
    expect(noEffectiveProject.body.error.code).toBe("VALIDATION_ERROR");
  });
});

// Couvre le bouton "☆ Favori" (sauvegarder un mouvement fréquent) et la
// section "⭐ Favoris" de l'onglet Transactions (le rejouer). Un favori est un
// gabarit, jamais lié aux transactions déjà saisies.
describe("Favoris de saisie rapide (/api/transaction-favorites)", () => {
  it("crée, liste, modifie puis supprime un favori", async () => {
    const { access } = await authedUser();
    const create = await request(app)
      .post("/api/transaction-favorites")
      .set("Authorization", `Bearer ${access}`)
      .send({ label: "Taxi", type: "depense", category: "Transport", amount: 500, method: "Espèces" })
      .expect(201);
    const id = create.body.transactionFavorite.id;
    expect(create.body.transactionFavorite.label).toBe("Taxi");

    const list = await request(app)
      .get("/api/transaction-favorites")
      .set("Authorization", `Bearer ${access}`)
      .expect(200);
    expect(list.body.transactionFavorites).toHaveLength(1);

    const updated = await request(app)
      .patch(`/api/transaction-favorites/${id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ amount: 600 })
      .expect(200);
    expect(Number(updated.body.transactionFavorite.amount)).toBe(600);
    expect(updated.body.transactionFavorite.label).toBe("Taxi"); // champ non touché = inchangé

    await request(app).delete(`/api/transaction-favorites/${id}`).set("Authorization", `Bearer ${access}`).expect(204);
    const listAfter = await request(app)
      .get("/api/transaction-favorites")
      .set("Authorization", `Bearer ${access}`)
      .expect(200);
    expect(listAfter.body.transactionFavorites).toHaveLength(0);
  });

  it("peut rattacher un projet et une rubrique, et les détacher explicitement via null", async () => {
    const { access } = await authedUser();
    const project = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Voyage" })
      .expect(201);
    const projectId = project.body.project.id;
    const rubrique = await request(app)
      .post(`/api/projects/${projectId}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Transport" })
      .expect(201);
    const rubriqueId = rubrique.body.rubrique.id;

    const create = await request(app)
      .post("/api/transaction-favorites")
      .set("Authorization", `Bearer ${access}`)
      .send({ label: "Taxi voyage", type: "depense", category: "Transport", amount: 500, method: "Espèces", projectId, rubriqueId })
      .expect(201);
    const id = create.body.transactionFavorite.id;
    expect(create.body.transactionFavorite.project_id).toBe(projectId);
    expect(create.body.transactionFavorite.rubrique_id).toBe(rubriqueId);

    const rubDetached = await request(app)
      .patch(`/api/transaction-favorites/${id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ rubriqueId: null })
      .expect(200);
    expect(rubDetached.body.transactionFavorite.rubrique_id).toBeNull();
    expect(rubDetached.body.transactionFavorite.project_id).toBe(projectId);

    const projDetached = await request(app)
      .patch(`/api/transaction-favorites/${id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ projectId: null })
      .expect(200);
    expect(projDetached.body.transactionFavorite.project_id).toBeNull();
  });

  it("refuse une rubrique sans projectId effectif, ou empruntée à un autre projet", async () => {
    const { access } = await authedUser();
    const projectB = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Projet B" })
      .expect(201);
    const rubriqueB = await request(app)
      .post(`/api/projects/${projectB.body.project.id}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Hébergement" })
      .expect(201);

    const noProject = await request(app)
      .post("/api/transaction-favorites")
      .set("Authorization", `Bearer ${access}`)
      .send({ label: "Sans projet", type: "depense", category: "Autres", amount: 1000, method: "Espèces", rubriqueId: rubriqueB.body.rubrique.id })
      .expect(400);
    expect(noProject.body.error.code).toBe("VALIDATION_ERROR");

    const projectA = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Projet A" })
      .expect(201);
    const crossProject = await request(app)
      .post("/api/transaction-favorites")
      .set("Authorization", `Bearer ${access}`)
      .send({ label: "Emprunté", type: "depense", category: "Autres", amount: 1000, method: "Espèces", projectId: projectA.body.project.id, rubriqueId: rubriqueB.body.rubrique.id })
      .expect(404);
    expect(crossProject.body.error.code).toBe("RUBRIQUE_NOT_FOUND");
  });

  it("un utilisateur ne voit ni ne modifie les favoris d'un autre (404, pas une fuite)", async () => {
    const u1 = await authedUser();
    const u2 = await authedUser();
    const created = await request(app)
      .post("/api/transaction-favorites")
      .set("Authorization", `Bearer ${u1.access}`)
      .send({ label: "Privé", type: "depense", category: "Autres", amount: 1000, method: "Espèces" })
      .expect(201);
    const id = created.body.transactionFavorite.id;

    const listU2 = await request(app)
      .get("/api/transaction-favorites")
      .set("Authorization", `Bearer ${u2.access}`)
      .expect(200);
    expect(listU2.body.transactionFavorites).toHaveLength(0);

    const patchByU2 = await request(app)
      .patch(`/api/transaction-favorites/${id}`)
      .set("Authorization", `Bearer ${u2.access}`)
      .send({ amount: 1 })
      .expect(404);
    expect(patchByU2.body.error.code).toBe("TRANSACTION_FAVORITE_NOT_FOUND");

    const delByU2 = await request(app)
      .delete(`/api/transaction-favorites/${id}`)
      .set("Authorization", `Bearer ${u2.access}`)
      .expect(404);
    expect(delByU2.body.error.code).toBe("TRANSACTION_FAVORITE_NOT_FOUND");

    const stillThere = await request(app)
      .get("/api/transaction-favorites")
      .set("Authorization", `Bearer ${u1.access}`)
      .expect(200);
    expect(stillThere.body.transactionFavorites).toHaveLength(1);
  });
});

describe("isolation stricte entre utilisateurs", () => {
  it("un utilisateur ne voit jamais les transactions d'un autre", async () => {
    const u1 = await authedUser();
    const u2 = await authedUser();
    await request(app)
      .post("/api/transactions")
      .set("Authorization", `Bearer ${u1.access}`)
      .send({ type: "depense", category: "Autres", amount: 1000, occurredOn: "2026-08-18", method: "Espèces" })
      .expect(201);

    const listU2 = await request(app).get("/api/transactions").set("Authorization", `Bearer ${u2.access}`).expect(200);
    expect(listU2.body.transactions).toHaveLength(0);
  });

  it("un utilisateur ne peut ni lire ni supprimer une ressource d'un autre (404, pas une fuite)", async () => {
    const u1 = await authedUser();
    const u2 = await authedUser();
    const created = await request(app)
      .post("/api/transactions")
      .set("Authorization", `Bearer ${u1.access}`)
      .send({ type: "depense", category: "Autres", amount: 1000, occurredOn: "2026-08-18", method: "Espèces" })
      .expect(201);
    const id = created.body.transaction.id;

    const del = await request(app).delete(`/api/transactions/${id}`).set("Authorization", `Bearer ${u2.access}`).expect(404);
    expect(del.body.error.code).toBe("TRANSACTION_NOT_FOUND");

    // Toujours présente côté propriétaire : la tentative de l'autre utilisateur n'a rien supprimé.
    const stillThere = await request(app).get("/api/transactions").set("Authorization", `Bearer ${u1.access}`).expect(200);
    expect(stillThere.body.transactions).toHaveLength(1);
  });
});

describe("Catégories personnalisées (/api/categories)", () => {
  it("crée une catégorie, la liste, puis une transaction peut l'utiliser", async () => {
    const { access } = await authedUser();
    const created = await request(app)
      .post("/api/categories")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Abonnements" })
      .expect(201);
    expect(created.body.category.name).toBe("Abonnements");
    expect(created.body.category.color).toMatch(/^#/);

    const list = await request(app).get("/api/categories").set("Authorization", `Bearer ${access}`).expect(200);
    expect(list.body.categories.map((c: { name: string }) => c.name)).toEqual(["Abonnements"]);

    const tx = await request(app)
      .post("/api/transactions")
      .set("Authorization", `Bearer ${access}`)
      .send({ type: "depense", category: "Abonnements", amount: 5000, occurredOn: "2026-08-18", method: "Espèces" })
      .expect(201);
    expect(tx.body.transaction.category).toBe("Abonnements");
  });

  it("refuse une catégorie dont le nom existe déjà (insensible à la casse), qu'elle soit de base ou personnalisée", async () => {
    const { access } = await authedUser();
    const baseDup = await request(app)
      .post("/api/categories")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "alimentation" }) // catégorie de base existante, casse différente
      .expect(409);
    expect(baseDup.body.error.code).toBe("CATEGORY_ALREADY_EXISTS");

    await request(app)
      .post("/api/categories")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Abonnements" })
      .expect(201);
    const customDup = await request(app)
      .post("/api/categories")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "ABONNEMENTS" })
      .expect(409);
    expect(customDup.body.error.code).toBe("CATEGORY_ALREADY_EXISTS");
  });

  it("supprime une catégorie personnalisée sans affecter les transactions déjà enregistrées avec son nom", async () => {
    const { access } = await authedUser();
    const created = await request(app)
      .post("/api/categories")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Abonnements" })
      .expect(201);

    await request(app)
      .post("/api/transactions")
      .set("Authorization", `Bearer ${access}`)
      .send({ type: "depense", category: "Abonnements", amount: 5000, occurredOn: "2026-08-18", method: "Espèces" })
      .expect(201);

    await request(app)
      .delete(`/api/categories/${created.body.category.id}`)
      .set("Authorization", `Bearer ${access}`)
      .expect(204);

    const list = await request(app).get("/api/categories").set("Authorization", `Bearer ${access}`).expect(200);
    expect(list.body.categories).toHaveLength(0);

    const txList = await request(app).get("/api/transactions").set("Authorization", `Bearer ${access}`).expect(200);
    expect(txList.body.transactions[0].category).toBe("Abonnements");
  });

  it("isole les catégories personnalisées entre utilisateurs", async () => {
    const userA = await authedUser();
    const userB = await authedUser();

    await request(app)
      .post("/api/categories")
      .set("Authorization", `Bearer ${userA.access}`)
      .send({ name: "Abonnements" })
      .expect(201);

    const listB = await request(app).get("/api/categories").set("Authorization", `Bearer ${userB.access}`).expect(200);
    expect(listB.body.categories).toHaveLength(0);

    // userB peut créer une catégorie du même nom : l'unicité est par utilisateur.
    await request(app)
      .post("/api/categories")
      .set("Authorization", `Bearer ${userB.access}`)
      .send({ name: "Abonnements" })
      .expect(201);
  });

  it("refuse de supprimer la catégorie d'un autre utilisateur (404, sans fuite)", async () => {
    const userA = await authedUser();
    const userB = await authedUser();
    const created = await request(app)
      .post("/api/categories")
      .set("Authorization", `Bearer ${userA.access}`)
      .send({ name: "Abonnements" })
      .expect(201);

    await request(app)
      .delete(`/api/categories/${created.body.category.id}`)
      .set("Authorization", `Bearer ${userB.access}`)
      .expect(404);

    const list = await request(app).get("/api/categories").set("Authorization", `Bearer ${userA.access}`).expect(200);
    expect(list.body.categories).toHaveLength(1);
  });
});

describe("POST /api/budgets — sémantique upsert", () => {
  it("définir une limite sur une catégorie déjà suivie met à jour la ligne existante", async () => {
    const { access } = await authedUser();
    const first = await request(app)
      .post("/api/budgets")
      .set("Authorization", `Bearer ${access}`)
      .send({ category: "Alimentation", monthlyLimit: 60000 })
      .expect(201);

    const second = await request(app)
      .post("/api/budgets")
      .set("Authorization", `Bearer ${access}`)
      .send({ category: "Alimentation", monthlyLimit: 75000 })
      .expect(201);

    expect(second.body.budget.id).toBe(first.body.budget.id);

    const list = await request(app).get("/api/budgets").set("Authorization", `Bearer ${access}`).expect(200);
    expect(list.body.budgets).toHaveLength(1);
    expect(Number(list.body.budgets[0].monthly_limit)).toBe(75000);
  });
});

describe("Épargne", () => {
  it("crée un objectif et met à jour le montant courant", async () => {
    const { access } = await authedUser();
    const created = await request(app)
      .post("/api/savings-goals")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Fonds urgence", targetAmount: 500000, currentAmount: 100000, deadline: "2026-12-31" })
      .expect(201);

    const updated = await request(app)
      .patch(`/api/savings-goals/${created.body.savingsGoal.id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ currentAmount: 150000 })
      .expect(200);
    expect(Number(updated.body.savingsGoal.current_amount)).toBe(150000);
  });
});

describe("Versements d'épargne (/api/savings-goals/:id/contributions)", () => {
  it("un versement augmente le solde et laisse une trace datée dans le journal", async () => {
    const { access } = await authedUser();
    const created = await request(app)
      .post("/api/savings-goals")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Voyage", targetAmount: 500000, currentAmount: 100000, deadline: "2026-12-31" })
      .expect(201);
    const goalId = created.body.savingsGoal.id;

    const contributed = await request(app)
      .post(`/api/savings-goals/${goalId}/contributions`)
      .set("Authorization", `Bearer ${access}`)
      .send({ amount: 50000 })
      .expect(201);
    expect(Number(contributed.body.savingsGoal.current_amount)).toBe(150000);
    expect(Number(contributed.body.contribution.amount)).toBe(50000);
    expect(contributed.body.contribution.goal_id).toBe(goalId);
    expect(contributed.body.contribution.goal_name).toBe("Voyage");
    expect(contributed.body.contribution.created_at).toBeTruthy();

    const list = await request(app)
      .get("/api/savings-goal-contributions")
      .set("Authorization", `Bearer ${access}`)
      .expect(200);
    expect(list.body.savingsGoalContributions).toHaveLength(1);
    expect(Number(list.body.savingsGoalContributions[0].amount)).toBe(50000);
  });

  it("plafonne le solde affiché à l'objectif mais journalise le montant réellement versé", async () => {
    const { access } = await authedUser();
    const created = await request(app)
      .post("/api/savings-goals")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Fonds urgence", targetAmount: 100000, currentAmount: 90000, deadline: "2026-12-31" })
      .expect(201);
    const goalId = created.body.savingsGoal.id;

    const contributed = await request(app)
      .post(`/api/savings-goals/${goalId}/contributions`)
      .set("Authorization", `Bearer ${access}`)
      .send({ amount: 50000 })
      .expect(201);
    // Solde plafonné à l'objectif (100000), mais le versement réel (50000) est
    // bien celui qui apparaît dans le journal, pas un delta recalculé.
    expect(Number(contributed.body.savingsGoal.current_amount)).toBe(100000);
    expect(Number(contributed.body.contribution.amount)).toBe(50000);
  });

  it("refuse de verser vers l'objectif d'un autre utilisateur (404, pas une fuite)", async () => {
    const u1 = await authedUser();
    const u2 = await authedUser();
    const created = await request(app)
      .post("/api/savings-goals")
      .set("Authorization", `Bearer ${u1.access}`)
      .send({ name: "Fonds urgence", targetAmount: 500000, currentAmount: 0, deadline: "2026-12-31" })
      .expect(201);

    const attempt = await request(app)
      .post(`/api/savings-goals/${created.body.savingsGoal.id}/contributions`)
      .set("Authorization", `Bearer ${u2.access}`)
      .send({ amount: 10000 })
      .expect(404);
    expect(attempt.body.error.code).toBe("SAVINGS_GOAL_NOT_FOUND");

    // Le journal de u2 reste vide, et le solde de u1 n'a pas bougé.
    const listU2 = await request(app)
      .get("/api/savings-goal-contributions")
      .set("Authorization", `Bearer ${u2.access}`)
      .expect(200);
    expect(listU2.body.savingsGoalContributions).toHaveLength(0);
  });
});

describe("Projets", () => {
  it("crée un projet, rattache des transactions, et calcule les totaux consolidés", async () => {
    const { access } = await authedUser();
    const created = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Construction maison", targetAmount: 5000000, targetDate: "2027-06-30" })
      .expect(201);
    const projectId = created.body.project.id;
    expect(created.body.project.status).toBe("actif");
    expect(created.body.project.icon).toBe("📁");

    await request(app)
      .post("/api/transactions")
      .set("Authorization", `Bearer ${access}`)
      .send({ type: "revenu", category: "Autres", amount: 200000, occurredOn: "2026-08-18", method: "Mobile Money", projectId })
      .expect(201);
    await request(app)
      .post("/api/transactions")
      .set("Authorization", `Bearer ${access}`)
      .send({ type: "depense", category: "Autres", amount: 50000, occurredOn: "2026-08-19", method: "Espèces", projectId })
      .expect(201);
    // Une transaction hors projet ne doit pas polluer ses totaux.
    await request(app)
      .post("/api/transactions")
      .set("Authorization", `Bearer ${access}`)
      .send({ type: "depense", category: "Autres", amount: 9999, occurredOn: "2026-08-20", method: "Espèces" })
      .expect(201);

    const detail = await request(app).get(`/api/projects/${projectId}`).set("Authorization", `Bearer ${access}`).expect(200);
    expect(Number(detail.body.project.total_in)).toBe(200000);
    expect(Number(detail.body.project.total_out)).toBe(50000);
    expect(Number(detail.body.project.balance)).toBe(150000);
    expect(Number(detail.body.project.transaction_count)).toBe(2);

    // Vision consolidée : les transactions du projet comptent aussi dans la liste générale.
    const allTx = await request(app).get("/api/transactions").set("Authorization", `Bearer ${access}`).expect(200);
    expect(allTx.body.transactions).toHaveLength(3);

    // Filtrage par projet : uniquement les 2 transactions rattachées.
    const projectTx = await request(app)
      .get(`/api/transactions?projectId=${projectId}`)
      .set("Authorization", `Bearer ${access}`)
      .expect(200);
    expect(projectTx.body.transactions).toHaveLength(2);
  });

  it("refuse d'accéder au projet d'un autre utilisateur (404, pas une fuite)", async () => {
    const u1 = await authedUser();
    const u2 = await authedUser();
    const created = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${u1.access}`)
      .send({ name: "Privé" })
      .expect(201);

    const res = await request(app)
      .get(`/api/projects/${created.body.project.id}`)
      .set("Authorization", `Bearer ${u2.access}`)
      .expect(404);
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("supprimer un projet détache ses transactions sans les effacer", async () => {
    const { access } = await authedUser();
    const created = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Voyage" })
      .expect(201);
    const projectId = created.body.project.id;

    await request(app)
      .post("/api/transactions")
      .set("Authorization", `Bearer ${access}`)
      .send({ type: "depense", category: "Autres", amount: 10000, occurredOn: "2026-08-18", method: "Espèces", projectId })
      .expect(201);

    await request(app).delete(`/api/projects/${projectId}`).set("Authorization", `Bearer ${access}`).expect(204);

    const list = await request(app).get("/api/transactions").set("Authorization", `Bearer ${access}`).expect(200);
    expect(list.body.transactions).toHaveLength(1);
    expect(list.body.transactions[0].project_id).toBeNull();
  });
});

describe("Rubriques", () => {
  it("crée des rubriques dans un projet et rattache des dépenses, le réel se recalcule depuis les transactions", async () => {
    const { access } = await authedUser();
    const project = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Voyage Douala-Paris" })
      .expect(201);
    const projectId = project.body.project.id;

    const transport = await request(app)
      .post(`/api/projects/${projectId}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Transport", plannedAmount: 500000 })
      .expect(201);
    const hebergement = await request(app)
      .post(`/api/projects/${projectId}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Hébergement" }) // enveloppe optionnelle : absente ici
      .expect(201);
    expect(transport.body.rubrique.planned_amount).toBe("500000.00");
    expect(hebergement.body.rubrique.planned_amount).toBeNull();

    await request(app)
      .post("/api/transactions")
      .set("Authorization", `Bearer ${access}`)
      .send({ type: "depense", category: "Transport", amount: 150000, occurredOn: "2026-08-18", method: "Mobile Money", projectId, rubriqueId: transport.body.rubrique.id })
      .expect(201);
    await request(app)
      .post("/api/transactions")
      .set("Authorization", `Bearer ${access}`)
      .send({ type: "depense", category: "Transport", amount: 80000, occurredOn: "2026-08-19", method: "Espèces", projectId, rubriqueId: transport.body.rubrique.id })
      .expect(201);
    await request(app)
      .post("/api/transactions")
      .set("Authorization", `Bearer ${access}`)
      .send({ type: "depense", category: "Logement", amount: 300000, occurredOn: "2026-08-20", method: "Virement bancaire", projectId, rubriqueId: hebergement.body.rubrique.id })
      .expect(201);

    const list = await request(app)
      .get(`/api/projects/${projectId}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .expect(200);
    expect(list.body.rubriques).toHaveLength(2);
    // Pas de total pré-calculé renvoyé par l'API — recalcul côté client depuis
    // les transactions (même principe que les totaux de projet).
    expect(list.body.rubriques[0]).not.toHaveProperty("total_out");

    const txs = await request(app)
      .get(`/api/transactions?projectId=${projectId}`)
      .set("Authorization", `Bearer ${access}`)
      .expect(200);
    const transportTotal = txs.body.transactions
      .filter((t: { rubrique_id: string | null }) => t.rubrique_id === transport.body.rubrique.id)
      .reduce((sum: number, t: { amount: string }) => sum + Number(t.amount), 0);
    expect(transportTotal).toBe(230000);
  });

  it("exige projectId quand rubriqueId est fourni", async () => {
    const { access } = await authedUser();
    const project = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Mariage" })
      .expect(201);
    const rubrique = await request(app)
      .post(`/api/projects/${project.body.project.id}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Traiteur" })
      .expect(201);

    const res = await request(app)
      .post("/api/transactions")
      .set("Authorization", `Bearer ${access}`)
      .send({ type: "depense", category: "Autres", amount: 10000, occurredOn: "2026-08-18", method: "Espèces", rubriqueId: rubrique.body.rubrique.id })
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("refuse une rubrique empruntée à un autre projet", async () => {
    const { access } = await authedUser();
    const projectA = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Projet A" })
      .expect(201);
    const projectB = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Projet B" })
      .expect(201);
    const rubriqueA = await request(app)
      .post(`/api/projects/${projectA.body.project.id}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Rubrique A" })
      .expect(201);

    const res = await request(app)
      .post("/api/transactions")
      .set("Authorization", `Bearer ${access}`)
      .send({ type: "depense", category: "Autres", amount: 10000, occurredOn: "2026-08-18", method: "Espèces", projectId: projectB.body.project.id, rubriqueId: rubriqueA.body.rubrique.id })
      .expect(404);
    expect(res.body.error.code).toBe("RUBRIQUE_NOT_FOUND");
  });

  it("refuse d'accéder aux rubriques d'un projet d'un autre utilisateur (404, pas une fuite)", async () => {
    const u1 = await authedUser();
    const u2 = await authedUser();
    const project = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${u1.access}`)
      .send({ name: "Privé" })
      .expect(201);

    const res = await request(app)
      .get(`/api/projects/${project.body.project.id}/rubriques`)
      .set("Authorization", `Bearer ${u2.access}`)
      .expect(404);
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");

    const createRes = await request(app)
      .post(`/api/projects/${project.body.project.id}/rubriques`)
      .set("Authorization", `Bearer ${u2.access}`)
      .send({ name: "Intrusion" })
      .expect(404);
    expect(createRes.body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("supprimer une rubrique détache ses transactions sans les effacer", async () => {
    const { access } = await authedUser();
    const project = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Construction" })
      .expect(201);
    const projectId = project.body.project.id;
    const rubrique = await request(app)
      .post(`/api/projects/${projectId}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Fondation" })
      .expect(201);

    const tx = await request(app)
      .post("/api/transactions")
      .set("Authorization", `Bearer ${access}`)
      .send({ type: "depense", category: "Autres", amount: 200000, occurredOn: "2026-08-18", method: "Espèces", projectId, rubriqueId: rubrique.body.rubrique.id })
      .expect(201);

    await request(app)
      .delete(`/api/projects/${projectId}/rubriques/${rubrique.body.rubrique.id}`)
      .set("Authorization", `Bearer ${access}`)
      .expect(204);

    const list = await request(app).get("/api/transactions").set("Authorization", `Bearer ${access}`).expect(200);
    const kept = list.body.transactions.find((t: { id: string }) => t.id === tx.body.transaction.id);
    expect(kept).toBeTruthy();
    expect(kept.rubrique_id).toBeNull();
    expect(kept.project_id).toBe(projectId);
  });

  it("supprimer un projet supprime aussi ses rubriques (cascade)", async () => {
    const { access } = await authedUser();
    const project = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Activité" })
      .expect(201);
    const projectId = project.body.project.id;
    await request(app)
      .post(`/api/projects/${projectId}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Stock initial" })
      .expect(201);

    await request(app).delete(`/api/projects/${projectId}`).set("Authorization", `Bearer ${access}`).expect(204);

    // Le projet n'existe plus : lister ses rubriques renvoie 404 (projet introuvable).
    const res = await request(app)
      .get(`/api/projects/${projectId}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .expect(404);
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("GET /api/rubriques renvoie les rubriques de tous les projets de l'utilisateur", async () => {
    const { access } = await authedUser();
    const p1 = await request(app).post("/api/projects").set("Authorization", `Bearer ${access}`).send({ name: "P1" }).expect(201);
    const p2 = await request(app).post("/api/projects").set("Authorization", `Bearer ${access}`).send({ name: "P2" }).expect(201);
    await request(app).post(`/api/projects/${p1.body.project.id}/rubriques`).set("Authorization", `Bearer ${access}`).send({ name: "A" }).expect(201);
    await request(app).post(`/api/projects/${p2.body.project.id}/rubriques`).set("Authorization", `Bearer ${access}`).send({ name: "B" }).expect(201);

    const all = await request(app).get("/api/rubriques").set("Authorization", `Bearer ${access}`).expect(200);
    expect(all.body.rubriques).toHaveLength(2);
  });
});

describe("Rubriques — imbrication (sous-rubriques)", () => {
  it("crée une sous-rubrique rattachée à une rubrique parente, à profondeur illimitée", async () => {
    const { access } = await authedUser();
    const project = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Voyage" })
      .expect(201);
    const projectId = project.body.project.id;

    const transport = await request(app)
      .post(`/api/projects/${projectId}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Transport" })
      .expect(201);
    const billets = await request(app)
      .post(`/api/projects/${projectId}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Billets d'avion", parentRubriqueId: transport.body.rubrique.id })
      .expect(201);
    expect(billets.body.rubrique.parent_rubrique_id).toBe(transport.body.rubrique.id);

    // Profondeur illimitée : une sous-rubrique peut elle-même avoir un enfant.
    const vol = await request(app)
      .post(`/api/projects/${projectId}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Vol long-courrier", parentRubriqueId: billets.body.rubrique.id })
      .expect(201);
    expect(vol.body.rubrique.parent_rubrique_id).toBe(billets.body.rubrique.id);
  });

  it("autorise une dépense directement sur une rubrique qui a des sous-rubriques (ex: taxi sur Transport)", async () => {
    const { access } = await authedUser();
    const project = await request(app).post("/api/projects").set("Authorization", `Bearer ${access}`).send({ name: "Voyage 2" }).expect(201);
    const projectId = project.body.project.id;
    const transport = await request(app)
      .post(`/api/projects/${projectId}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Transport" })
      .expect(201);
    await request(app)
      .post(`/api/projects/${projectId}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Billets d'avion", parentRubriqueId: transport.body.rubrique.id })
      .expect(201);

    // Taxi tagué directement sur la rubrique parente "Transport", pas sur la sous-rubrique.
    await request(app)
      .post("/api/transactions")
      .set("Authorization", `Bearer ${access}`)
      .send({ type: "depense", category: "Transport", amount: 5000, occurredOn: "2026-08-18", method: "Espèces", projectId, rubriqueId: transport.body.rubrique.id })
      .expect(201);
  });

  it("refuse qu'une rubrique parente appartenant à un autre projet soit utilisée", async () => {
    const { access } = await authedUser();
    const projectA = await request(app).post("/api/projects").set("Authorization", `Bearer ${access}`).send({ name: "A" }).expect(201);
    const projectB = await request(app).post("/api/projects").set("Authorization", `Bearer ${access}`).send({ name: "B" }).expect(201);
    const rubriqueA = await request(app)
      .post(`/api/projects/${projectA.body.project.id}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Rubrique A" })
      .expect(201);

    const res = await request(app)
      .post(`/api/projects/${projectB.body.project.id}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Sous X", parentRubriqueId: rubriqueA.body.rubrique.id })
      .expect(404);
    expect(res.body.error.code).toBe("RUBRIQUE_NOT_FOUND");
  });

  it("refuse de déplacer une rubrique sous l'une de ses propres sous-rubriques (cycle)", async () => {
    const { access } = await authedUser();
    const project = await request(app).post("/api/projects").set("Authorization", `Bearer ${access}`).send({ name: "Cycle" }).expect(201);
    const projectId = project.body.project.id;
    const parent = await request(app)
      .post(`/api/projects/${projectId}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Transport" })
      .expect(201);
    const child = await request(app)
      .post(`/api/projects/${projectId}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Billets d'avion", parentRubriqueId: parent.body.rubrique.id })
      .expect(201);

    // Tenter de faire de "Transport" une sous-rubrique de son propre enfant "Billets d'avion".
    const res = await request(app)
      .patch(`/api/projects/${projectId}/rubriques/${parent.body.rubrique.id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ parentRubriqueId: child.body.rubrique.id })
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("détache explicitement une sous-rubrique de son parent via parentRubriqueId: null", async () => {
    const { access } = await authedUser();
    const project = await request(app).post("/api/projects").set("Authorization", `Bearer ${access}`).send({ name: "Détachement" }).expect(201);
    const projectId = project.body.project.id;
    const parent = await request(app)
      .post(`/api/projects/${projectId}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Transport" })
      .expect(201);
    const child = await request(app)
      .post(`/api/projects/${projectId}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Billets d'avion", parentRubriqueId: parent.body.rubrique.id })
      .expect(201);

    const patched = await request(app)
      .patch(`/api/projects/${projectId}/rubriques/${child.body.rubrique.id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ parentRubriqueId: null })
      .expect(200);
    expect(patched.body.rubrique.parent_rubrique_id).toBeNull();

    // Un PATCH qui ne mentionne pas parentRubriqueId ne doit pas y toucher.
    const untouched = await request(app)
      .patch(`/api/projects/${projectId}/rubriques/${child.body.rubrique.id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Billets d'avion (renommé)" })
      .expect(200);
    expect(untouched.body.rubrique.parent_rubrique_id).toBeNull();
  });

  it("supprimer une rubrique intermédiaire ré-attache ses enfants à son propre parent (pas d'aplatissement complet)", async () => {
    const { access } = await authedUser();
    const project = await request(app).post("/api/projects").set("Authorization", `Bearer ${access}`).send({ name: "Arbre profond" }).expect(201);
    const projectId = project.body.project.id;
    const transport = await request(app)
      .post(`/api/projects/${projectId}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Transport" })
      .expect(201);
    const billets = await request(app)
      .post(`/api/projects/${projectId}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Billets d'avion", parentRubriqueId: transport.body.rubrique.id })
      .expect(201);
    const vol = await request(app)
      .post(`/api/projects/${projectId}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Vol long-courrier", parentRubriqueId: billets.body.rubrique.id })
      .expect(201);

    // Supprime le niveau intermédiaire "Billets d'avion" : "Vol long-courrier"
    // doit remonter à SON grand-parent "Transport", pas directement en haut de l'arbre.
    await request(app)
      .delete(`/api/projects/${projectId}/rubriques/${billets.body.rubrique.id}`)
      .set("Authorization", `Bearer ${access}`)
      .expect(204);

    const list = await request(app).get(`/api/projects/${projectId}/rubriques`).set("Authorization", `Bearer ${access}`).expect(200);
    const volAfter = list.body.rubriques.find((r: { id: string }) => r.id === vol.body.rubrique.id);
    expect(volAfter.parent_rubrique_id).toBe(transport.body.rubrique.id);
  });

  it("supprimer une rubrique de premier niveau promeut ses enfants directs au premier niveau", async () => {
    const { access } = await authedUser();
    const project = await request(app).post("/api/projects").set("Authorization", `Bearer ${access}`).send({ name: "Promotion" }).expect(201);
    const projectId = project.body.project.id;
    const transport = await request(app)
      .post(`/api/projects/${projectId}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Transport" })
      .expect(201);
    const billets = await request(app)
      .post(`/api/projects/${projectId}/rubriques`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Billets d'avion", parentRubriqueId: transport.body.rubrique.id })
      .expect(201);

    await request(app)
      .delete(`/api/projects/${projectId}/rubriques/${transport.body.rubrique.id}`)
      .set("Authorization", `Bearer ${access}`)
      .expect(204);

    const list = await request(app).get(`/api/projects/${projectId}/rubriques`).set("Authorization", `Bearer ${access}`).expect(200);
    const billetsAfter = list.body.rubriques.find((r: { id: string }) => r.id === billets.body.rubrique.id);
    expect(billetsAfter.parent_rubrique_id).toBeNull();
  });
});

describe("Planner financier", () => {
  it("crée un événement puis valide sa réalisation", async () => {
    const { access } = await authedUser();
    const created = await request(app)
      .post("/api/planner-events")
      .set("Authorization", `Bearer ${access}`)
      .send({ title: "Paiement loyer", eventDate: "2026-08-25", eventTime: "09:00", durationMinutes: 30, type: "depense", category: "Logement", amount: 60000 })
      .expect(201);
    expect(created.body.plannerEvent.status).toBe("a_venir");

    const validated = await request(app)
      .post(`/api/planner-events/${created.body.plannerEvent.id}/status`)
      .set("Authorization", `Bearer ${access}`)
      .send({ status: "realise" })
      .expect(200);
    expect(validated.body.plannerEvent.status).toBe("realise");
  });

  it("refuse un statut hors de l'énumération connue", async () => {
    const { access } = await authedUser();
    const created = await request(app)
      .post("/api/planner-events")
      .set("Authorization", `Bearer ${access}`)
      .send({ title: "X", eventDate: "2026-08-25", eventTime: "09:00", durationMinutes: 30, type: "depense", category: "Autres", amount: 1000 })
      .expect(201);

    const res = await request(app)
      .post(`/api/planner-events/${created.body.plannerEvent.id}/status`)
      .set("Authorization", `Bearer ${access}`)
      .send({ status: "pas_un_statut" })
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("Planner financier — paiements récurrents", () => {
  it("valider un événement récurrent crée automatiquement la prochaine occurrence", async () => {
    const { access } = await authedUser();
    const created = await request(app)
      .post("/api/planner-events")
      .set("Authorization", `Bearer ${access}`)
      .send({
        title: "Loyer", eventDate: "2026-08-25", eventTime: "09:00", durationMinutes: 30,
        type: "depense", category: "Logement", amount: 60000, recurrence: "mensuelle",
      })
      .expect(201);
    expect(created.body.plannerEvent.recurrence).toBe("mensuelle");

    const validated = await request(app)
      .post(`/api/planner-events/${created.body.plannerEvent.id}/status`)
      .set("Authorization", `Bearer ${access}`)
      .send({ status: "realise" })
      .expect(200);
    expect(validated.body.plannerEvent.status).toBe("realise");
    expect(validated.body.nextPlannerEvent).toBeTruthy();
    expect(validated.body.nextPlannerEvent.event_date).toBe("2026-09-25");
    expect(validated.body.nextPlannerEvent.status).toBe("a_venir");
    expect(validated.body.nextPlannerEvent.recurrence).toBe("mensuelle");
    expect(validated.body.nextPlannerEvent.title).toBe("Loyer");
    expect(Number(validated.body.nextPlannerEvent.amount)).toBe(60000);

    // La nouvelle occurrence apparaît bien dans la liste (2 événements au total).
    const list = await request(app).get("/api/planner-events").set("Authorization", `Bearer ${access}`).expect(200);
    expect(list.body.plannerEvents).toHaveLength(2);
  });

  it("plafonne au dernier jour du mois cible plutôt que de déborder (31 janvier + mensuelle → 28/29 février)", async () => {
    const { access } = await authedUser();
    const created = await request(app)
      .post("/api/planner-events")
      .set("Authorization", `Bearer ${access}`)
      .send({
        title: "Abonnement", eventDate: "2026-01-31", eventTime: "08:00", durationMinutes: 10,
        type: "depense", category: "Autres", amount: 5000, recurrence: "mensuelle",
      })
      .expect(201);

    const validated = await request(app)
      .post(`/api/planner-events/${created.body.plannerEvent.id}/status`)
      .set("Authorization", `Bearer ${access}`)
      .send({ status: "realise" })
      .expect(200);
    // 2026 n'est pas bissextile : février s'arrête au 28.
    expect(validated.body.nextPlannerEvent.event_date).toBe("2026-02-28");
  });

  it("ne crée pas de prochaine occurrence pour un événement non récurrent", async () => {
    const { access } = await authedUser();
    const created = await request(app)
      .post("/api/planner-events")
      .set("Authorization", `Bearer ${access}`)
      .send({ title: "Achat ponctuel", eventDate: "2026-08-25", eventTime: "09:00", durationMinutes: 30, type: "depense", category: "Autres", amount: 15000 })
      .expect(201);
    expect(created.body.plannerEvent.recurrence).toBeNull();

    const validated = await request(app)
      .post(`/api/planner-events/${created.body.plannerEvent.id}/status`)
      .set("Authorization", `Bearer ${access}`)
      .send({ status: "realise" })
      .expect(200);
    expect(validated.body.nextPlannerEvent).toBeNull();

    const list = await request(app).get("/api/planner-events").set("Authorization", `Bearer ${access}`).expect(200);
    expect(list.body.plannerEvents).toHaveLength(1);
  });

  it("ne crée pas de prochaine occurrence si le statut n'est pas 'realise' (ex: non_realise)", async () => {
    const { access } = await authedUser();
    const created = await request(app)
      .post("/api/planner-events")
      .set("Authorization", `Bearer ${access}`)
      .send({
        title: "Cotisation club", eventDate: "2026-08-25", eventTime: "09:00", durationMinutes: 30,
        type: "depense", category: "Autres", amount: 3000, recurrence: "hebdomadaire",
      })
      .expect(201);

    const validated = await request(app)
      .post(`/api/planner-events/${created.body.plannerEvent.id}/status`)
      .set("Authorization", `Bearer ${access}`)
      .send({ status: "non_realise" })
      .expect(200);
    expect(validated.body.nextPlannerEvent).toBeNull();
  });

  it("PATCH peut retirer la récurrence (tri-état : absent = inchangé, null = retire, valeur = remplace)", async () => {
    const { access } = await authedUser();
    const created = await request(app)
      .post("/api/planner-events")
      .set("Authorization", `Bearer ${access}`)
      .send({
        title: "Internet", eventDate: "2026-08-25", eventTime: "09:00", durationMinutes: 10,
        type: "depense", category: "Autres", amount: 20000, recurrence: "mensuelle",
      })
      .expect(201);

    // PATCH sans le champ recurrence : inchangé.
    const untouched = await request(app)
      .patch(`/api/planner-events/${created.body.plannerEvent.id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ amount: 21000 })
      .expect(200);
    expect(untouched.body.plannerEvent.recurrence).toBe("mensuelle");

    // PATCH avec recurrence: null : retire la récurrence.
    const cleared = await request(app)
      .patch(`/api/planner-events/${created.body.plannerEvent.id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ recurrence: null })
      .expect(200);
    expect(cleared.body.plannerEvent.recurrence).toBeNull();

    // Valider ne crée donc plus de prochaine occurrence.
    const validated = await request(app)
      .post(`/api/planner-events/${created.body.plannerEvent.id}/status`)
      .set("Authorization", `Bearer ${access}`)
      .send({ status: "realise" })
      .expect(200);
    expect(validated.body.nextPlannerEvent).toBeNull();
  });

  it("refuse une fréquence de récurrence inconnue", async () => {
    const { access } = await authedUser();
    const res = await request(app)
      .post("/api/planner-events")
      .set("Authorization", `Bearer ${access}`)
      .send({
        title: "X", eventDate: "2026-08-25", eventTime: "09:00", durationMinutes: 10,
        type: "depense", category: "Autres", amount: 1000, recurrence: "quotidienne",
      })
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("Tontine — cycle complet", () => {
  it("crée un groupe, refuse la clôture tant que tous n'ont pas cotisé, puis clôture et fait tourner le bénéficiaire", async () => {
    const { access } = await authedUser();
    const created = await request(app)
      .post("/api/tontines")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Tontine Test", contributionAmount: 20000, frequency: "mensuelle", members: ["Awa", "Bella", "Cyrille"] })
      .expect(201);
    const tontine = created.body.tontine;
    expect(tontine.currentRound).toBe(1);
    expect(tontine.currentRoundStartedAt).toBeTruthy(); // date de début du tour 1 (= création)
    expect(tontine.members).toHaveLength(3);

    // Personne n'a cotisé : la clôture doit être refusée.
    const blocked = await request(app)
      .post(`/api/tontines/${tontine.id}/close-round`)
      .set("Authorization", `Bearer ${access}`)
      .expect(409);
    expect(blocked.body.error.code).toBe("TONTINE_ROUND_NOT_READY");

    // Deux membres sur trois cotisent : toujours refusé.
    const firstPaid = await request(app)
      .post(`/api/tontines/${tontine.id}/contributions`)
      .set("Authorization", `Bearer ${access}`)
      .send({ memberId: tontine.members[0].id, paid: true })
      .expect(200);
    // paidAtThisRound horodate le paiement (nécessaire au résumé hebdomadaire
    // pour compter les cotisations payées "cette semaine") et reste null pour
    // les membres qui n'ont pas encore payé.
    expect(firstPaid.body.tontine.paidAtThisRound[tontine.members[0].id]).not.toBeNull();
    expect(firstPaid.body.tontine.paidAtThisRound[tontine.members[1].id]).toBeNull();
    await request(app)
      .post(`/api/tontines/${tontine.id}/contributions`)
      .set("Authorization", `Bearer ${access}`)
      .send({ memberId: tontine.members[1].id, paid: true })
      .expect(200);
    await request(app)
      .post(`/api/tontines/${tontine.id}/close-round`)
      .set("Authorization", `Bearer ${access}`)
      .expect(409);

    // Le dernier membre cotise : la clôture doit désormais réussir.
    await request(app)
      .post(`/api/tontines/${tontine.id}/contributions`)
      .set("Authorization", `Bearer ${access}`)
      .send({ memberId: tontine.members[2].id, paid: true })
      .expect(200);
    const closed = await request(app)
      .post(`/api/tontines/${tontine.id}/close-round`)
      .set("Authorization", `Bearer ${access}`)
      .expect(200);

    expect(closed.body.tontine.currentRound).toBe(2);
    // La clôture du tour fait repartir "le début du tour en cours" à
    // maintenant (sert de base au calcul d'échéance de la prochaine cotisation).
    expect(new Date(closed.body.tontine.currentRoundStartedAt).getTime())
      .toBeGreaterThan(new Date(tontine.currentRoundStartedAt).getTime());
    expect(closed.body.tontine.history).toHaveLength(1);
    expect(closed.body.tontine.history[0].beneficiaryName).toBe("Awa"); // position 1 = premier bénéficiaire
    expect(closed.body.tontine.history[0].totalAmount).toBe(60000); // 20000 x 3 membres
    // Le nouveau tour repart avec tout le monde à "non payé".
    expect(Object.values(closed.body.tontine.paidThisRound).every((p) => p === false)).toBe(true);
    expect(Object.values(closed.body.tontine.paidAtThisRound).every((p) => p === null)).toBe(true);
  });

  it("refuse d'accéder à la tontine d'un autre utilisateur (404, pas une fuite)", async () => {
    const u1 = await authedUser();
    const u2 = await authedUser();
    const created = await request(app)
      .post("/api/tontines")
      .set("Authorization", `Bearer ${u1.access}`)
      .send({ name: "Privée", contributionAmount: 10000, frequency: "mensuelle", members: ["A", "B"] })
      .expect(201);

    const res = await request(app)
      .get(`/api/tontines/${created.body.tontine.id}`)
      .set("Authorization", `Bearer ${u2.access}`)
      .expect(404);
    expect(res.body.error.code).toBe("TONTINE_NOT_FOUND");
  });

  it("supprime un groupe de tontine : il disparaît de la liste (membres/cotisations/historique partent avec, via CASCADE)", async () => {
    const { access } = await authedUser();
    const created = await request(app)
      .post("/api/tontines")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "À supprimer", contributionAmount: 10000, frequency: "mensuelle", members: ["A", "B"] })
      .expect(201);
    const id = created.body.tontine.id;

    await request(app)
      .delete(`/api/tontines/${id}`)
      .set("Authorization", `Bearer ${access}`)
      .expect(204);

    const getAfter = await request(app).get(`/api/tontines/${id}`).set("Authorization", `Bearer ${access}`).expect(404);
    expect(getAfter.body.error.code).toBe("TONTINE_NOT_FOUND");

    const list = await request(app).get("/api/tontines").set("Authorization", `Bearer ${access}`).expect(200);
    expect(list.body.tontines).toHaveLength(0);
  });

  it("refuse de supprimer la tontine d'un autre utilisateur (404, pas une fuite) et ne la supprime pas", async () => {
    const u1 = await authedUser();
    const u2 = await authedUser();
    const created = await request(app)
      .post("/api/tontines")
      .set("Authorization", `Bearer ${u1.access}`)
      .send({ name: "Privée", contributionAmount: 10000, frequency: "mensuelle", members: ["A", "B"] })
      .expect(201);

    const del = await request(app)
      .delete(`/api/tontines/${created.body.tontine.id}`)
      .set("Authorization", `Bearer ${u2.access}`)
      .expect(404);
    expect(del.body.error.code).toBe("TONTINE_NOT_FOUND");

    const stillThere = await request(app).get("/api/tontines").set("Authorization", `Bearer ${u1.access}`).expect(200);
    expect(stillThere.body.tontines).toHaveLength(1);
  });
});

describe("PATCH /api/tontines/:id — modification (nom, cotisation, fréquence, membres)", () => {
  it("modifie le nom, la cotisation et la fréquence sans toucher à l'échéance du tour en cours", async () => {
    const { access } = await authedUser();
    const created = await request(app)
      .post("/api/tontines")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Tontine Test", contributionAmount: 20000, frequency: "mensuelle", members: ["Awa", "Bella"] })
      .expect(201);
    const tontine = created.body.tontine;

    const updated = await request(app)
      .patch(`/api/tontines/${tontine.id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Tontine Renommée", contributionAmount: 25000, frequency: "hebdomadaire" })
      .expect(200);

    expect(updated.body.tontine.name).toBe("Tontine Renommée");
    expect(updated.body.tontine.contributionAmount).toBe(25000);
    expect(updated.body.tontine.frequency).toBe("hebdomadaire");
    // L'échéance du tour en cours ne doit pas être réinitialisée par une
    // simple modification (voir migrations/025_tontine_round_started_at.sql).
    expect(updated.body.tontine.currentRoundStartedAt).toBe(tontine.currentRoundStartedAt);
    expect(updated.body.tontine.members.map((m: { name: string }) => m.name)).toEqual(["Awa", "Bella"]);
  });

  it("renomme les membres existants, dans l'ordre de passage, sans changer leurs id ni leurs cotisations déjà enregistrées", async () => {
    const { access } = await authedUser();
    const created = await request(app)
      .post("/api/tontines")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Tontine Test", contributionAmount: 10000, frequency: "mensuelle", members: ["Awa", "Bella"] })
      .expect(201);
    const tontine = created.body.tontine;

    await request(app)
      .post(`/api/tontines/${tontine.id}/contributions`)
      .set("Authorization", `Bearer ${access}`)
      .send({ memberId: tontine.members[0].id, paid: true })
      .expect(200);

    const updated = await request(app)
      .patch(`/api/tontines/${tontine.id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ memberNames: ["Awa Corrigée", "Bella Corrigée"] })
      .expect(200);

    expect(updated.body.tontine.members[0].id).toBe(tontine.members[0].id);
    expect(updated.body.tontine.members[0].name).toBe("Awa Corrigée");
    expect(updated.body.tontine.members[1].name).toBe("Bella Corrigée");
    // La cotisation déjà enregistrée pour ce membre reste intacte (même id).
    expect(updated.body.tontine.paidThisRound[tontine.members[0].id]).toBe(true);
  });

  it("refuse un nombre de noms de membres différent du nombre de membres existants", async () => {
    const { access } = await authedUser();
    const created = await request(app)
      .post("/api/tontines")
      .set("Authorization", `Bearer ${access}`)
      .send({ name: "Tontine Test", contributionAmount: 10000, frequency: "mensuelle", members: ["Awa", "Bella"] })
      .expect(201);

    const res = await request(app)
      .patch(`/api/tontines/${created.body.tontine.id}`)
      .set("Authorization", `Bearer ${access}`)
      .send({ memberNames: ["Juste Une"] })
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("refuse de modifier la tontine d'un autre utilisateur (404, pas une fuite) et ne la modifie pas", async () => {
    const u1 = await authedUser();
    const u2 = await authedUser();
    const created = await request(app)
      .post("/api/tontines")
      .set("Authorization", `Bearer ${u1.access}`)
      .send({ name: "Privée", contributionAmount: 10000, frequency: "mensuelle", members: ["A", "B"] })
      .expect(201);

    const res = await request(app)
      .patch(`/api/tontines/${created.body.tontine.id}`)
      .set("Authorization", `Bearer ${u2.access}`)
      .send({ name: "Piratée" })
      .expect(404);
    expect(res.body.error.code).toBe("TONTINE_NOT_FOUND");

    const stillOriginal = await request(app)
      .get(`/api/tontines/${created.body.tontine.id}`)
      .set("Authorization", `Bearer ${u1.access}`)
      .expect(200);
    expect(stillOriginal.body.tontine.name).toBe("Privée");
  });
});
