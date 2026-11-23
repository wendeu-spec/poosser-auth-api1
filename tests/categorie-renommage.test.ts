import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, resetDb, registerFreshUser } from "./helpers.js";

/**
 * Renommer une catégorie personnelle, et la supprimer en réaffectant ce
 * qu'elle portait (maj35).
 *
 * Le problème : une catégorie est recopiée TELLE QUELLE dans quatre tables —
 * transactions, budgets, planner_events, transaction_favorites. C'est le
 * choix de la migration 026, et il tient ; mais renommer sans toucher au
 * reste laisserait des lignes orphelines, portant un nom qui n'existe plus
 * dans aucune liste.
 *
 * Sur les données réelles de Yannis au 23 novembre 2026, le cas n'est pas
 * théorique : « Scolarité » n'a aucune opération mais UN budget, et
 * « Starlink Ndéré » a une opération et TROIS échéances.
 *
 * Décision de Yannis : pas de fusion. Renommer vers un nom déjà pris est
 * refusé plutôt que deviné.
 */

beforeEach(resetDb);

const auth = (access: string) => ({ Authorization: `Bearer ${access}` });

async function authedUser() {
  const { body } = await registerFreshUser();
  return { access: body.accessToken as string };
}

async function creerCategorie(access: string, name: string) {
  const res = await request(app).post("/api/categories").set(auth(access)).send({ name }).expect(201);
  return res.body.category as { id: string; name: string };
}

const renommer = (access: string, id: string, name: string) =>
  request(app).patch(`/api/categories/${id}`).set(auth(access)).send({ name });

const supprimer = (access: string, id: string, reassignTo?: string) =>
  request(app)
    .delete(`/api/categories/${id}` + (reassignTo ? `?reassignTo=${encodeURIComponent(reassignTo)}` : ""))
    .set(auth(access));

async function depense(access: string, category: string, amount = 5000) {
  await request(app)
    .post("/api/transactions")
    .set(auth(access))
    .send({ type: "depense", category, amount, occurredOn: "2026-11-05", method: "Espèces" })
    .expect(201);
}

async function budget(access: string, category: string, monthlyLimit = 40_000) {
  await request(app)
    .post("/api/budgets")
    .set(auth(access))
    .send({ category, monthlyLimit })
    .expect(201);
}

async function echeance(access: string, category: string) {
  await request(app)
    .post("/api/planner-events")
    .set(auth(access))
    .send({ title: "Abonnement", category, amount: 30_000, type: "depense",
            eventDate: "2026-12-05", eventTime: "08:00", durationMinutes: 30 })
    .expect(201);
}

async function favori(access: string, category: string) {
  await request(app)
    .post("/api/transaction-favorites")
    .set(auth(access))
    .send({ label: "Mensuel", type: "depense", category, amount: 30_000, method: "Espèces" })
    .expect(201);
}

const lire = async (access: string, chemin: string) =>
  (await request(app).get(chemin).set(auth(access)).expect(200)).body;

describe("renommer une catégorie", () => {
  it("réécrit le nom dans les QUATRE tables qui le recopient", async () => {
    const { access } = await authedUser();
    const cat = await creerCategorie(access, "Scolarite");
    await depense(access, "Scolarite");
    await budget(access, "Scolarite");
    await echeance(access, "Scolarite");
    await favori(access, "Scolarite");

    const res = await renommer(access, cat.id, "Scolarité").expect(200);
    expect(res.body.category.name).toBe("Scolarité");
    // Ce qui a été réécrit est annoncé : c'est ce que l'écran montre avant
    // de confirmer.
    expect(res.body.usage).toEqual({ transactions: 1, budgets: 1, plannerEvents: 1, favorites: 1 });

    expect((await lire(access, "/api/transactions")).transactions[0].category).toBe("Scolarité");
    expect((await lire(access, "/api/budgets")).budgets[0].category).toBe("Scolarité");
    expect((await lire(access, "/api/planner-events")).plannerEvents[0].category).toBe("Scolarité");
    expect((await lire(access, "/api/transaction-favorites")).transactionFavorites[0].category).toBe("Scolarité");
  });

  it("ne laisse aucun budget orphelin — le cas réel de Yannis", async () => {
    const { access } = await authedUser();
    const cat = await creerCategorie(access, "Scolarite");
    await budget(access, "Scolarite"); // un budget, zéro opération

    await renommer(access, cat.id, "Scolarité").expect(200);
    const { budgets } = await lire(access, "/api/budgets");
    const { categories } = await lire(access, "/api/categories");
    // Le budget porte toujours un nom qui existe dans la liste : c'est tout
    // l'enjeu du renommage multi-tables.
    expect(budgets[0].category).toBe("Scolarité");
    expect(categories.map((c: { name: string }) => c.name)).toContain(budgets[0].category);
  });

  it("rattrape les lignes écrites dans une autre casse", async () => {
    const { access } = await authedUser();
    const cat = await creerCategorie(access, "Abonnements");
    await depense(access, "abonnements");

    await renommer(access, cat.id, "Abonnements mensuels").expect(200);
    expect((await lire(access, "/api/transactions")).transactions[0].category).toBe("Abonnements mensuels");
  });

  it("laisse corriger la seule casse", async () => {
    const { access } = await authedUser();
    const cat = await creerCategorie(access, "scolarité");
    await depense(access, "scolarité");

    await renommer(access, cat.id, "Scolarité").expect(200);
    expect((await lire(access, "/api/categories")).categories[0].name).toBe("Scolarité");
    expect((await lire(access, "/api/transactions")).transactions[0].category).toBe("Scolarité");
  });

  it("refuse un nom déjà pris par une autre catégorie personnelle — pas de fusion", async () => {
    const { access } = await authedUser();
    const a = await creerCategorie(access, "Scolarite");
    await creerCategorie(access, "Éducation privée");
    await renommer(access, a.id, "Éducation privée").expect(409);
    // Rien n'a bougé.
    expect((await lire(access, "/api/categories")).categories.map((c: { name: string }) => c.name))
      .toEqual(expect.arrayContaining(["Scolarite", "Éducation privée"]));
  });

  it("refuse un nom déjà pris par une catégorie de base", async () => {
    const { access } = await authedUser();
    const cat = await creerCategorie(access, "Scolarite");
    await renommer(access, cat.id, "Éducation").expect(409);
    await renommer(access, cat.id, "éducation").expect(409);
  });

  it("refuse un nom vide ou démesuré", async () => {
    const { access } = await authedUser();
    const cat = await creerCategorie(access, "Scolarite");
    await renommer(access, cat.id, "   ").expect(400);
    await renommer(access, cat.id, "x".repeat(61)).expect(400);
  });

  it("ne touche à rien quand le renommage est refusé", async () => {
    const { access } = await authedUser();
    const cat = await creerCategorie(access, "Scolarite");
    await depense(access, "Scolarite");
    await renommer(access, cat.id, "Éducation").expect(409);
    expect((await lire(access, "/api/transactions")).transactions[0].category).toBe("Scolarite");
  });
});

describe("usage d'une catégorie", () => {
  it("compte ce qui la porte, table par table", async () => {
    const { access } = await authedUser();
    const cat = await creerCategorie(access, "Starlink");
    await depense(access, "Starlink");
    await echeance(access, "Starlink");
    await echeance(access, "Starlink");

    const res = await request(app).get(`/api/categories/${cat.id}/usage`).set(auth(access)).expect(200);
    expect(res.body.usage).toEqual({ transactions: 1, budgets: 0, plannerEvents: 2, favorites: 0 });
  });
});

describe("supprimer une catégorie", () => {
  it("sans réaffectation : comportement d'origine, 204 et l'historique garde le nom", async () => {
    const { access } = await authedUser();
    const cat = await creerCategorie(access, "Abonnements");
    await depense(access, "Abonnements");

    await supprimer(access, cat.id).expect(204);
    expect((await lire(access, "/api/categories")).categories).toHaveLength(0);
    expect((await lire(access, "/api/transactions")).transactions[0].category).toBe("Abonnements");
  });

  it("avec réaffectation : opérations, échéances et favoris changent de catégorie", async () => {
    const { access } = await authedUser();
    const cat = await creerCategorie(access, "Abonnements");
    await depense(access, "Abonnements");
    await echeance(access, "Abonnements");
    await favori(access, "Abonnements");

    const res = await supprimer(access, cat.id, "Loisirs").expect(200);
    expect(res.body.reassignedTo).toBe("Loisirs");
    expect((await lire(access, "/api/transactions")).transactions[0].category).toBe("Loisirs");
    expect((await lire(access, "/api/planner-events")).plannerEvents[0].category).toBe("Loisirs");
    expect((await lire(access, "/api/transaction-favorites")).transactionFavorites[0].category).toBe("Loisirs");
    expect((await lire(access, "/api/categories")).categories).toHaveLength(0);
  });

  it("le budget de la catégorie supprimée part avec elle, il n'est jamais transféré", async () => {
    const { access } = await authedUser();
    const cat = await creerCategorie(access, "Abonnements");
    await budget(access, "Abonnements", 25_000);
    await budget(access, "Loisirs", 80_000);

    await supprimer(access, cat.id, "Loisirs").expect(200);
    const { budgets } = await lire(access, "/api/budgets");
    // Une limite fixée pour « Abonnements » ne dit rien de celle de
    // « Loisirs » : la reporter changerait en silence un chiffre choisi par
    // l'utilisateur. Et budgets refuse deux lignes sur la même catégorie.
    expect(budgets).toHaveLength(1);
    expect(budgets[0].category).toBe("Loisirs");
    expect(Number(budgets[0].monthly_limit)).toBe(80_000);
  });

  it("refuse une cible inconnue, et ne supprime alors rien", async () => {
    const { access } = await authedUser();
    const cat = await creerCategorie(access, "Abonnements");
    await supprimer(access, cat.id, "Catégorie qui n'existe pas").expect(404);
    expect((await lire(access, "/api/categories")).categories).toHaveLength(1);
  });

  it("refuse de se réaffecter à elle-même", async () => {
    const { access } = await authedUser();
    const cat = await creerCategorie(access, "Abonnements");
    await supprimer(access, cat.id, "Abonnements").expect(400);
    expect((await lire(access, "/api/categories")).categories).toHaveLength(1);
  });
});

describe("isolation entre utilisateurs", () => {
  it("ne laisse pas renommer la catégorie d'un autre", async () => {
    const a = await authedUser();
    const b = await authedUser();
    const cat = await creerCategorie(a.access, "Scolarite");
    await renommer(b.access, cat.id, "Détournée").expect(404);
    expect((await lire(a.access, "/api/categories")).categories[0].name).toBe("Scolarite");
  });

  it("un renommage ne touche jamais les lignes d'un autre utilisateur", async () => {
    const a = await authedUser();
    const b = await authedUser();
    const catA = await creerCategorie(a.access, "Abonnements");
    await creerCategorie(b.access, "Abonnements");
    await depense(a.access, "Abonnements");
    await depense(b.access, "Abonnements");

    await renommer(a.access, catA.id, "Abonnements TV").expect(200);
    expect((await lire(a.access, "/api/transactions")).transactions[0].category).toBe("Abonnements TV");
    expect((await lire(b.access, "/api/transactions")).transactions[0].category).toBe("Abonnements");
    expect((await lire(b.access, "/api/categories")).categories[0].name).toBe("Abonnements");
  });
});
