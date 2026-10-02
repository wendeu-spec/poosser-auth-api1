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
    await request(app).get("/api/projects").expect(401);
    await request(app).get("/api/rubriques").expect(401);
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

  it("refuse une catégorie hors de la liste connue", async () => {
    const { access } = await authedUser();
    const res = await request(app)
      .post("/api/transactions")
      .set("Authorization", `Bearer ${access}`)
      .send({ type: "depense", category: "PasUneCategorie", amount: 1000, occurredOn: "2026-08-18", method: "Espèces" })
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
    expect(tontine.members).toHaveLength(3);

    // Personne n'a cotisé : la clôture doit être refusée.
    const blocked = await request(app)
      .post(`/api/tontines/${tontine.id}/close-round`)
      .set("Authorization", `Bearer ${access}`)
      .expect(409);
    expect(blocked.body.error.code).toBe("TONTINE_ROUND_NOT_READY");

    // Deux membres sur trois cotisent : toujours refusé.
    await request(app)
      .post(`/api/tontines/${tontine.id}/contributions`)
      .set("Authorization", `Bearer ${access}`)
      .send({ memberId: tontine.members[0].id, paid: true })
      .expect(200);
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
    expect(closed.body.tontine.history).toHaveLength(1);
    expect(closed.body.tontine.history[0].beneficiaryName).toBe("Awa"); // position 1 = premier bénéficiaire
    expect(closed.body.tontine.history[0].totalAmount).toBe(60000); // 20000 x 3 membres
    // Le nouveau tour repart avec tout le monde à "non payé".
    expect(Object.values(closed.body.tontine.paidThisRound).every((p) => p === false)).toBe(true);
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
});
