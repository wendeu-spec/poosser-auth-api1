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
