import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, resetDb, registerFreshUser } from "./helpers.js";
import { env } from "../src/config/env.js";
import {
  COUNTED_RESOURCES, PLANS, QUOTAS,
  type CountedResource, type Quota,
} from "../src/config/plans.js";
import { grantPlan, monthsFromNow, resolvePlan, getUsage } from "../src/services/entitlementService.js";

/**
 * Limites des formules d'abonnement (migrations/032, src/config/plans.ts,
 * src/services/entitlementService.ts).
 *
 * Le test le plus important de ce fichier est le PREMIER : il parcourt
 * COUNTED_RESOURCES et QUOTAS et exige que chacun soit réellement appliqué via
 * l'API. Ajouter une ressource limitée dans plans.ts sans la brancher dans son
 * service fait échouer ce test — c'est lui, et non la discipline, qui empêche
 * qu'une limite soit oubliée au milieu d'une vingtaine de routes de création.
 */

beforeEach(resetDb);

function setEnforced(on: boolean) {
  (env as { PLANS_ENFORCED: boolean }).PLANS_ENFORCED = on;
}
afterEach(() => setEnforced(false)); // l'interrupteur est éteint par défaut

async function freeUser() {
  const { body } = await registerFreshUser();
  return { auth: `Bearer ${body.accessToken as string}`, userId: body.user.id as string };
}

const auth = (a: string) => ({ Authorization: a });

/**
 * Comment créer une unité de chaque ressource limitée, via l'API publique.
 * Un `undefined` ici pour une ressource de COUNTED_RESOURCES fait échouer le
 * test de couverture : impossible d'ajouter une limite sans dire comment la
 * déclencher.
 */
const CREATE: Record<CountedResource, (a: string, i: number) => Promise<request.Response>> = {
  account: (a, i) => request(app).post("/api/accounts").set(auth(a))
    .send({ name: `Compte ${i}`, type: "mobile_money" }),
  budget: (a, i) => request(app).post("/api/budgets").set(auth(a))
    .send({ category: ["Alimentation", "Transport", "Logement", "Santé", "Loisirs"][i % 5], monthlyLimit: 10_000 + i }),
  project: (a, i) => request(app).post("/api/projects").set(auth(a))
    .send({ name: `Projet ${i}` }),
  tontine: (a, i) => request(app).post("/api/tontines").set(auth(a))
    .send({ name: `Tontine ${i}`, contributionAmount: 5_000, frequency: "mensuelle", members: ["Ada", "Bea"] }),
  savings_goal: (a, i) => request(app).post("/api/savings-goals").set(auth(a))
    .send({ name: `Objectif ${i}`, targetAmount: 100_000 }),
  recurring_event: (a, i) => request(app).post("/api/planner-events").set(auth(a))
    .send({
      title: `Loyer ${i}`, eventDate: "2026-11-05", eventTime: "09:00", durationMinutes: 30,
      type: "depense", category: "Logement", amount: 60_000, recurrence: "mensuelle",
    }),
};

/** Comment consommer une unité de chaque quota mensuel. */
const CONSUME: Record<Quota, (a: string) => Promise<request.Response>> = {
  sms_parse: (a) => request(app).post("/api/sms/parse").set(auth(a))
    .send({ text: "Vous avez reçu 1000 FCFA de PAUL le 2026-11-10. Solde: 5000 FCFA." }),
  assistant: (a) => request(app).post("/api/assistant/ask").set(auth(a))
    .send({ question: "Combien ai-je dépensé ?", context: {} }),
};

describe("Couverture : chaque limite déclarée est réellement appliquée", () => {
  it.each(COUNTED_RESOURCES)("la limite du Gratuit sur « %s » est appliquée", async (resource) => {
    const limit = PLANS.gratuit.limits[resource];
    expect(limit, `limite manquante pour ${resource}`).not.toBeNull();
    expect(CREATE[resource], `aucun créateur de test pour ${resource}`).toBeDefined();

    const { auth: a } = await freeUser();
    setEnforced(true);

    // Le compte « Espèces » créé d'office occupe déjà une place.
    const deja = resource === "account" ? 1 : 0;
    for (let i = 0; i < limit! - deja; i++) {
      const res = await CREATE[resource](a, i);
      expect(res.status, `création ${i + 1} de ${resource} refusée : ${JSON.stringify(res.body)}`).toBe(201);
    }

    const refus = await CREATE[resource](a, 99);
    expect(refus.status, `${resource} : la limite de ${limit} n'a pas été appliquée`).toBe(403);
    expect(refus.body.error.code).toBe("PLAN_LIMIT_REACHED");
    expect(refus.body.error.details.resource).toBe(resource);
    expect(refus.body.error.details.upgradeTo).toBeTruthy(); // on propose une sortie
  });

  it.each(QUOTAS)("le quota mensuel du Gratuit sur « %s » est appliqué", async (quota) => {
    const limit = PLANS.gratuit.quotas[quota];
    expect(limit, `quota manquant pour ${quota}`).not.toBeNull();

    const { auth: a, userId } = await freeUser();
    setEnforced(true);

    for (let i = 0; i < limit!; i++) {
      const res = await CONSUME[quota](a);
      expect(res.status, `consommation ${i + 1} de ${quota} refusée`).toBe(200);
    }
    const refus = await CONSUME[quota](a);
    expect(refus.status, `${quota} : le quota de ${limit} n'a pas été appliqué`).toBe(403);
    expect(refus.body.error.code).toBe("PLAN_QUOTA_EXHAUSTED");
    expect(refus.body.error.details.resetsOn).toMatch(/^\d{4}-\d{2}-01$/);

    // Le compteur affiché reste honnête : jamais au-dessus de la limite.
    expect(await getUsage(userId, quota)).toBe(limit);
  });
});

describe("Interrupteur PLANS_ENFORCED", () => {
  it("éteint, rien n'est jamais refusé", async () => {
    const { auth: a } = await freeUser();
    setEnforced(false);
    for (let i = 0; i < 6; i++) {
      await request(app).post("/api/accounts").set(auth(a))
        .send({ name: `Compte ${i}`, type: "mobile_money" }).expect(201);
    }
    const comptes = await request(app).get("/api/accounts").set(auth(a)).expect(200);
    expect(comptes.body.accounts.length).toBe(7); // 6 + Espèces
  });

  it("éteint, les quotas sont tout de même comptés (pour mesurer avant d'allumer)", async () => {
    const { auth: a, userId } = await freeUser();
    setEnforced(false);
    for (let i = 0; i < 3; i++) await CONSUME.sms_parse(a).then((r) => expect(r.status).toBe(200));
    expect(await getUsage(userId, "sms_parse")).toBe(3);
  });
});

describe("Les limites bloquent la création, jamais l'existant", () => {
  it("un Premium déclassé garde ses comptes, les voit et saisit dedans", async () => {
    const { auth: a, userId } = await freeUser();
    await grantPlan(userId, { planCode: "premium", status: "active", periodEnd: monthsFromNow(1) });
    setEnforced(true);

    for (let i = 0; i < 4; i++) {
      await request(app).post("/api/accounts").set(auth(a))
        .send({ name: `Compte ${i}`, type: "mobile_money" }).expect(201);
    }

    // Déclassement : abonnement échu.
    await grantPlan(userId, { planCode: "premium", status: "expired", periodEnd: new Date(Date.now() - 86_400_000) });

    const comptes = await request(app).get("/api/accounts").set(auth(a)).expect(200);
    expect(comptes.body.accounts.length).toBe(5); // rien n'a disparu

    // On peut toujours saisir sur un compte existant...
    const cible = comptes.body.accounts[0];
    await request(app).post("/api/transactions").set(auth(a)).send({
      type: "depense", category: "Transport", amount: 2_000,
      occurredOn: "2026-11-10", method: "Espèces", accountId: cible.id,
    }).expect(201);

    // ...mais plus en créer un nouveau.
    const refus = await request(app).post("/api/accounts").set(auth(a))
      .send({ name: "Un de trop", type: "banque" }).expect(403);
    expect(refus.body.error.code).toBe("PLAN_LIMIT_REACHED");
  });

  it("au plafond, on peut encore modifier un budget existant", async () => {
    const { auth: a } = await freeUser();
    setEnforced(true);
    for (const c of ["Alimentation", "Transport", "Logement"]) {
      await request(app).post("/api/budgets").set(auth(a)).send({ category: c, monthlyLimit: 10_000 }).expect(201);
    }
    // Une 4e catégorie est refusée…
    await request(app).post("/api/budgets").set(auth(a))
      .send({ category: "Santé", monthlyLimit: 5_000 }).expect(403);
    // …mais corriger une limite déjà posée reste possible.
    const maj = await request(app).post("/api/budgets").set(auth(a))
      .send({ category: "Transport", monthlyLimit: 25_000 }).expect(201);
    expect(Number(maj.body.budget.monthly_limit)).toBe(25_000);
  });

  it("le compte « Espèces » d'office n'est jamais refusé par une limite", async () => {
    const { auth: a } = await freeUser();
    setEnforced(true);
    const comptes = await request(app).get("/api/accounts").set(auth(a)).expect(200);
    expect(comptes.body.accounts.map((c: { name: string }) => c.name)).toContain("Espèces");
  });
});

describe("Planner : seules les échéances récurrentes sont limitées", () => {
  const base = {
    eventDate: "2026-11-05", eventTime: "09:00", durationMinutes: 30,
    type: "depense" as const, category: "Logement", amount: 10_000,
  };

  it("les événements ponctuels restent illimités", async () => {
    const { auth: a } = await freeUser();
    setEnforced(true);
    for (let i = 0; i < 8; i++) {
      await request(app).post("/api/planner-events").set(auth(a))
        .send({ ...base, title: `Rendez-vous ${i}` }).expect(201);
    }
  });

  it("rendre récurrent un événement ponctuel compte dans la limite", async () => {
    const { auth: a } = await freeUser();
    setEnforced(true);
    for (let i = 0; i < 3; i++) {
      await request(app).post("/api/planner-events").set(auth(a))
        .send({ ...base, title: `Loyer ${i}`, recurrence: "mensuelle" }).expect(201);
    }
    const ponctuel = await request(app).post("/api/planner-events").set(auth(a))
      .send({ ...base, title: "Ponctuel" }).expect(201);

    const refus = await request(app)
      .patch(`/api/planner-events/${ponctuel.body.plannerEvent.id}`)
      .set(auth(a)).send({ recurrence: "mensuelle" }).expect(403);
    expect(refus.body.error.code).toBe("PLAN_LIMIT_REACHED");
  });
});

describe("Isolation entre utilisateurs", () => {
  it("un utilisateur au plafond n'empêche pas un autre de créer", async () => {
    const alice = await freeUser();
    const bob = await freeUser();
    setEnforced(true);

    await request(app).post("/api/accounts").set(auth(alice.auth))
      .send({ name: "MoMo", type: "mobile_money" }).expect(201);
    await request(app).post("/api/accounts").set(auth(alice.auth))
      .send({ name: "Banque", type: "banque" }).expect(403);

    await request(app).post("/api/accounts").set(auth(bob.auth))
      .send({ name: "MoMo", type: "mobile_money" }).expect(201);
  });

  it("les quotas sont comptés par utilisateur", async () => {
    const alice = await freeUser();
    const bob = await freeUser();
    setEnforced(true);
    for (let i = 0; i < 15; i++) await CONSUME.sms_parse(alice.auth);
    await CONSUME.sms_parse(alice.auth).then((r) => expect(r.status).toBe(403));
    await CONSUME.sms_parse(bob.auth).then((r) => expect(r.status).toBe(200));
  });
});

describe("Résolution de la formule applicable", () => {
  const sub = (over: Record<string, unknown>) => ({
    id: "x", user_id: "u", plan_code: "premium", status: "active",
    current_period_end: null, started_at: new Date(), cancelled_at: null, ...over,
  } as Parameters<typeof resolvePlan>[0]);

  it("sans abonnement, c'est le Gratuit", () => {
    expect(resolvePlan(null).code).toBe("gratuit");
  });

  it("une période échue retombe au Gratuit après le délai de grâce", () => {
    const hier = new Date(Date.now() - 86_400_000);
    // Dans le délai de grâce : encore Premium.
    expect(resolvePlan(sub({ current_period_end: hier })).code).toBe("premium");
    // Bien au-delà : Gratuit.
    const vieux = new Date(Date.now() - 60 * 86_400_000);
    expect(resolvePlan(sub({ current_period_end: vieux })).code).toBe("gratuit");
  });

  it("un essai et une courtoisie donnent accès à la formule", () => {
    expect(resolvePlan(sub({ status: "trialing" })).code).toBe("premium");
    expect(resolvePlan(sub({ status: "courtesy" })).code).toBe("premium");
  });

  it("une résiliation reste active jusqu'à l'échéance", () => {
    const demain = new Date(Date.now() + 86_400_000);
    expect(resolvePlan(sub({ status: "cancelled", current_period_end: demain })).code).toBe("premium");
  });

  it("un code de formule inconnu en base ne donne jamais plus que le Gratuit", () => {
    expect(resolvePlan(sub({ plan_code: "platine_or_massif" })).code).toBe("gratuit");
  });
});

describe("GET /api/subscription", () => {
  it("renvoie la formule, les quotas consommés et la grille tarifaire", async () => {
    const { auth: a } = await freeUser();
    await CONSUME.sms_parse(a);
    const res = await request(app).get("/api/subscription").set(auth(a)).expect(200);
    const s = res.body.subscription;
    expect(s.plan).toBe("gratuit");
    expect(s.status).toBe("aucun");
    expect(s.enforced).toBe(false);
    expect(s.usage.sms_parse).toEqual({ used: 1, limit: 15 });
    expect(s.prices.standard.monthly).toBe(1000);
  });

  it("exige une connexion", async () => {
    await request(app).get("/api/subscription").expect(401);
  });
});
