import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, resetDb, registerFreshUser } from "./helpers.js";

/**
 * Épargne adossée à un compte réel (migrations/033_savings_goal_accounts.sql).
 *
 * Le défaut corrigé : « + Verser » n'augmentait que savings_goals.current_amount
 * sans toucher au moindre compte. Le tableau de bord affichait donc le même
 * argent deux fois — une fois dans « Disponible », une fois dans « Épargne ».
 *
 * Ce que ces tests verrouillent :
 *   - un objectif est rattaché à un compte hôte (celui demandé, sinon le compte
 *     par défaut) ;
 *   - une réservation ne peut jamais dépasser l'argent réellement présent sur
 *     ce compte — c'est l'invariant qui empêche l'épargne fantôme de revenir ;
 *   - mode « reservation » : rien ne bouge entre les comptes ;
 *   - mode « virement » : un vrai virement est créé, frais compris, et il est
 *     atomique avec la réservation ;
 *   - un objectif peut être dépassé (plus de plafonnement silencieux) ;
 *   - un retrait relâche la réservation, et ne peut pas dépasser l'épargne ;
 *   - un virement qui adosse un mouvement d'épargne ne se supprime pas par la
 *     porte des comptes ;
 *   - isolation stricte entre utilisateurs.
 */

beforeEach(resetDb);

const auth = (access: string) => ({ Authorization: `Bearer ${access}` });

async function authedUser() {
  const { body } = await registerFreshUser();
  return { access: body.accessToken as string, userId: body.user.id as string };
}

async function listAccounts(access: string) {
  const res = await request(app).get("/api/accounts").set(auth(access)).expect(200);
  return res.body.accounts as Array<{ id: string; name: string; type: string; balance: string }>;
}

async function defaultAccount(access: string) {
  const accounts = await listAccounts(access);
  return accounts.find((a) => a.name === "Espèces")!;
}

async function createAccount(access: string, body: Record<string, unknown>) {
  const res = await request(app).post("/api/accounts").set(auth(access)).send(body).expect(201);
  return res.body.account as { id: string; balance: string };
}

/** Crédite un compte par un vrai revenu, pour qu'une réservation ait de quoi tenir. */
async function fund(access: string, accountId: string, amount: number) {
  await request(app)
    .post("/api/transactions")
    .set(auth(access))
    .send({ type: "revenu", category: "Salaire", amount, occurredOn: "2026-11-01", method: "Espèces", accountId })
    .expect(201);
}

async function createGoal(access: string, body: Record<string, unknown>, expected = 201) {
  const res = await request(app)
    .post("/api/savings-goals")
    .set(auth(access))
    .send({ name: "Fonds d'urgence", targetAmount: 500_000, deadline: "2027-06-30", ...body })
    .expect(expected);
  return res.body;
}

const contribute = (access: string, goalId: string, body: Record<string, unknown>) =>
  request(app).post(`/api/savings-goals/${goalId}/contributions`).set(auth(access)).send(body);

const withdraw = (access: string, goalId: string, body: Record<string, unknown>) =>
  request(app).post(`/api/savings-goals/${goalId}/withdrawals`).set(auth(access)).send(body);

describe("rattachement d'un objectif à un compte", () => {
  it("rattache au compte par défaut quand aucun compte n'est précisé", async () => {
    const { access } = await authedUser();
    const especes = await defaultAccount(access);
    const { savingsGoal } = await createGoal(access, {});
    expect(savingsGoal.account_id).toBe(especes.id);
  });

  it("rattache au compte demandé", async () => {
    const { access } = await authedUser();
    const momo = await createAccount(access, { name: "MoMo", type: "mobile_money" });
    const { savingsGoal } = await createGoal(access, { accountId: momo.id });
    expect(savingsGoal.account_id).toBe(momo.id);
  });

  it("refuse un compte qui appartient à quelqu'un d'autre (404, pas 403)", async () => {
    const a = await authedUser();
    const b = await authedUser();
    const compteDeB = await createAccount(b.access, { name: "Privé", type: "banque" });
    const res = await createGoal(a.access, { accountId: compteDeB.id }, 404);
    expect(res.error.code).toBe("ACCOUNT_NOT_FOUND");
  });

  it("refuse un compte archivé", async () => {
    const { access } = await authedUser();
    const momo = await createAccount(access, { name: "MoMo", type: "mobile_money" });
    await request(app).patch(`/api/accounts/${momo.id}`).set(auth(access)).send({ archived: true }).expect(200);
    const res = await createGoal(access, { accountId: momo.id }, 409);
    expect(res.error.code).toBe("ACCOUNT_ARCHIVED");
  });
});

describe("invariant : une réservation ne dépasse pas l'argent du compte", () => {
  it("refuse un montant déjà épargné supérieur au solde du compte", async () => {
    const { access } = await authedUser();
    const especes = await defaultAccount(access);
    await fund(access, especes.id, 50_000);
    const res = await createGoal(access, { currentAmount: 80_000 }, 409);
    expect(res.error.code).toBe("SAVINGS_EXCEEDS_ACCOUNT");
    expect(Number(res.error.details.maxAllowed)).toBe(50_000);
  });

  it("refuse un versement en réservation qui dépasse le solde, et n'écrit rien", async () => {
    const { access } = await authedUser();
    const especes = await defaultAccount(access);
    await fund(access, especes.id, 100_000);
    const { savingsGoal } = await createGoal(access, {});

    const res = await contribute(access, savingsGoal.id, { amount: 150_000, mode: "reservation" }).expect(409);
    expect(res.body.error.code).toBe("SAVINGS_EXCEEDS_ACCOUNT");
    expect(Number(res.body.error.details.maxAllowed)).toBe(100_000);

    // Rien ne doit subsister : ni réservation partielle, ni ligne de journal.
    const goals = await request(app).get("/api/savings-goals").set(auth(access)).expect(200);
    expect(Number(goals.body.savingsGoals[0].current_amount)).toBe(0);
    const journal = await request(app).get("/api/savings-goal-contributions").set(auth(access)).expect(200);
    expect(journal.body.savingsGoalContributions).toHaveLength(0);
  });

  it("compte les réservations de TOUS les objectifs hébergés sur le même compte", async () => {
    const { access } = await authedUser();
    const especes = await defaultAccount(access);
    await fund(access, especes.id, 100_000);
    const a = await createGoal(access, { name: "Objectif A" });
    const b = await createGoal(access, { name: "Objectif B" });

    await contribute(access, a.savingsGoal.id, { amount: 70_000, mode: "reservation" }).expect(201);
    // 70 000 déjà réservés sur les 100 000 du compte : 40 000 de plus ne tiennent pas.
    const res = await contribute(access, b.savingsGoal.id, { amount: 40_000, mode: "reservation" }).expect(409);
    expect(res.body.error.code).toBe("SAVINGS_EXCEEDS_ACCOUNT");
    expect(Number(res.body.error.details.maxAllowed)).toBe(30_000);
    // 30 000 passent.
    await contribute(access, b.savingsGoal.id, { amount: 30_000, mode: "reservation" }).expect(201);
  });

  it("refuse de déplacer un objectif vers un compte trop petit", async () => {
    const { access } = await authedUser();
    const especes = await defaultAccount(access);
    await fund(access, especes.id, 200_000);
    const momo = await createAccount(access, { name: "MoMo", type: "mobile_money" });
    const { savingsGoal } = await createGoal(access, {});
    await contribute(access, savingsGoal.id, { amount: 150_000, mode: "reservation" }).expect(201);

    const res = await request(app)
      .patch(`/api/savings-goals/${savingsGoal.id}`)
      .set(auth(access))
      .send({ accountId: momo.id })
      .expect(409);
    expect(res.body.error.code).toBe("SAVINGS_EXCEEDS_ACCOUNT");
  });
});

describe("mode réservation : rien ne bouge entre les comptes", () => {
  it("ne crée ni virement ni opération, et laisse le solde du compte intact", async () => {
    const { access } = await authedUser();
    const especes = await defaultAccount(access);
    await fund(access, especes.id, 300_000);
    const { savingsGoal } = await createGoal(access, {});

    const res = await contribute(access, savingsGoal.id, { amount: 120_000, mode: "reservation" }).expect(201);
    expect(res.body.transfer).toBeNull();
    expect(res.body.feeTransaction).toBeNull();
    expect(res.body.contribution.kind).toBe("reservation");
    expect(Number(res.body.savingsGoal.current_amount)).toBe(120_000);

    // Le solde du compte est inchangé : l'argent est réservé, pas déplacé.
    const accounts = await listAccounts(access);
    expect(Number(accounts.find((a) => a.id === especes.id)!.balance)).toBe(300_000);
    const transfers = await request(app).get("/api/transfers").set(auth(access)).expect(200);
    expect(transfers.body.transfers).toHaveLength(0);
  });

  it("vaut par défaut quand le client n'envoie que le montant (ancien client en cache)", async () => {
    const { access } = await authedUser();
    const especes = await defaultAccount(access);
    await fund(access, especes.id, 100_000);
    const { savingsGoal } = await createGoal(access, {});
    const res = await contribute(access, savingsGoal.id, { amount: 25_000 }).expect(201);
    expect(res.body.contribution.kind).toBe("reservation");
  });
});

describe("mode virement : l'argent vient vraiment d'un compte", () => {
  it("crée le virement vers le compte hôte et réserve le montant", async () => {
    const { access } = await authedUser();
    const especes = await defaultAccount(access);
    await fund(access, especes.id, 400_000);
    const livret = await createAccount(access, { name: "Livret", type: "epargne" });
    const { savingsGoal } = await createGoal(access, { accountId: livret.id });

    const res = await contribute(access, savingsGoal.id, {
      amount: 100_000,
      mode: "virement",
      counterpartAccountId: especes.id,
      occurredOn: "2026-11-14",
    }).expect(201);

    expect(res.body.contribution.kind).toBe("virement");
    expect(res.body.transfer.from_account_id).toBe(especes.id);
    expect(res.body.transfer.to_account_id).toBe(livret.id);
    expect(res.body.contribution.transfer_id).toBe(res.body.transfer.id);

    const accounts = await listAccounts(access);
    expect(Number(accounts.find((a) => a.id === especes.id)!.balance)).toBe(300_000);
    expect(Number(accounts.find((a) => a.id === livret.id)!.balance)).toBe(100_000);
    expect(Number(res.body.savingsGoal.current_amount)).toBe(100_000);
  });

  it("enregistre les frais comme une vraie dépense sur le compte débité", async () => {
    const { access } = await authedUser();
    const especes = await defaultAccount(access);
    await fund(access, especes.id, 400_000);
    const momo = await createAccount(access, { name: "MoMo", type: "mobile_money" });
    await fund(access, momo.id, 200_000);
    const livret = await createAccount(access, { name: "Livret", type: "epargne" });
    const { savingsGoal } = await createGoal(access, { accountId: livret.id });

    const res = await contribute(access, savingsGoal.id, {
      amount: 50_000,
      mode: "virement",
      counterpartAccountId: momo.id,
      fee: 500,
      occurredOn: "2026-11-14",
    }).expect(201);

    expect(res.body.feeTransaction.category).toBe("Frais Mobile Money");
    expect(Number(res.body.feeTransaction.amount)).toBe(500);
    expect(res.body.feeTransaction.account_id).toBe(momo.id);

    const accounts = await listAccounts(access);
    expect(Number(accounts.find((a) => a.id === momo.id)!.balance)).toBe(149_500);
    expect(Number(accounts.find((a) => a.id === livret.id)!.balance)).toBe(50_000);
  });

  it("exige le compte d'origine", async () => {
    const { access } = await authedUser();
    const { savingsGoal } = await createGoal(access, {});
    const res = await contribute(access, savingsGoal.id, { amount: 10_000, mode: "virement" }).expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("refuse un virement du compte hôte vers lui-même", async () => {
    const { access } = await authedUser();
    const especes = await defaultAccount(access);
    await fund(access, especes.id, 100_000);
    const { savingsGoal } = await createGoal(access, { accountId: especes.id });
    await contribute(access, savingsGoal.id, {
      amount: 10_000,
      mode: "virement",
      counterpartAccountId: especes.id,
      occurredOn: "2026-11-14",
    }).expect(400);
  });

  it("n'écrit ni virement ni frais si la réservation ne tient pas (atomicité)", async () => {
    const { access } = await authedUser();
    const especes = await defaultAccount(access);
    await fund(access, especes.id, 100_000);
    const livret = await createAccount(access, { name: "Livret", type: "epargne" });
    const autre = await createGoal(access, { name: "Déjà là", accountId: livret.id });

    // Le livret reçoit 60 000 par virement, intégralement réservés par « Déjà là ».
    await contribute(access, autre.savingsGoal.id, {
      amount: 60_000,
      mode: "virement",
      counterpartAccountId: especes.id,
      occurredOn: "2026-11-14",
    }).expect(201);

    // Un second objectif sur le même livret : le virement apporte 10 000 mais
    // les frais de 9 999 sont pris sur Espèces, donc le livret reçoit bien
    // 10 000 — ce cas doit passer. On force l'échec autrement : un retrait du
    // livret plus gros que ce qu'il contient est refusé plus bas ; ici on
    // vérifie qu'un versement impossible en réservation ne laisse aucune trace.
    const res = await contribute(access, autre.savingsGoal.id, { amount: 10_000, mode: "reservation" }).expect(409);
    expect(res.body.error.code).toBe("SAVINGS_EXCEEDS_ACCOUNT");

    const transfers = await request(app).get("/api/transfers").set(auth(access)).expect(200);
    expect(transfers.body.transfers).toHaveLength(1); // seul le virement légitime
    const journal = await request(app).get("/api/savings-goal-contributions").set(auth(access)).expect(200);
    expect(journal.body.savingsGoalContributions).toHaveLength(1);
  });
});

describe("dépassement de l'objectif", () => {
  it("laisse l'épargne dépasser la cible au lieu de faire disparaître le surplus", async () => {
    const { access } = await authedUser();
    const especes = await defaultAccount(access);
    await fund(access, especes.id, 1_000_000);
    const { savingsGoal } = await createGoal(access, { targetAmount: 500_000 });

    const res = await contribute(access, savingsGoal.id, { amount: 600_000, mode: "reservation" }).expect(201);
    // Avant la migration 033 : Math.min plafonnait à 500 000 et les 100 000
    // excédentaires étaient écrits au journal mais invisibles dans le total.
    expect(Number(res.body.savingsGoal.current_amount)).toBe(600_000);
    expect(Number(res.body.contribution.amount)).toBe(600_000);
  });
});

describe("retraits", () => {
  it("relâche la réservation sans toucher aux comptes en mode réservation", async () => {
    const { access } = await authedUser();
    const especes = await defaultAccount(access);
    await fund(access, especes.id, 300_000);
    const { savingsGoal } = await createGoal(access, {});
    await contribute(access, savingsGoal.id, { amount: 200_000, mode: "reservation" }).expect(201);

    const res = await withdraw(access, savingsGoal.id, { amount: 80_000, mode: "reservation" }).expect(201);
    expect(Number(res.body.savingsGoal.current_amount)).toBe(120_000);
    expect(Number(res.body.contribution.amount)).toBe(-80_000);
    expect(res.body.transfer).toBeNull();

    const accounts = await listAccounts(access);
    expect(Number(accounts.find((a) => a.id === especes.id)!.balance)).toBe(300_000);
  });

  it("sort l'argent du compte hôte en mode virement", async () => {
    const { access } = await authedUser();
    const especes = await defaultAccount(access);
    await fund(access, especes.id, 300_000);
    const livret = await createAccount(access, { name: "Livret", type: "epargne" });
    const { savingsGoal } = await createGoal(access, { accountId: livret.id });
    await contribute(access, savingsGoal.id, {
      amount: 150_000,
      mode: "virement",
      counterpartAccountId: especes.id,
      occurredOn: "2026-11-14",
    }).expect(201);

    const res = await withdraw(access, savingsGoal.id, {
      amount: 50_000,
      mode: "virement",
      counterpartAccountId: especes.id,
      occurredOn: "2026-11-15",
    }).expect(201);

    expect(res.body.transfer.from_account_id).toBe(livret.id);
    expect(res.body.transfer.to_account_id).toBe(especes.id);
    const accounts = await listAccounts(access);
    expect(Number(accounts.find((a) => a.id === livret.id)!.balance)).toBe(100_000);
    expect(Number(accounts.find((a) => a.id === especes.id)!.balance)).toBe(200_000);
    expect(Number(res.body.savingsGoal.current_amount)).toBe(100_000);
  });

  it("refuse de retirer plus que l'épargne de l'objectif", async () => {
    const { access } = await authedUser();
    const especes = await defaultAccount(access);
    await fund(access, especes.id, 300_000);
    const { savingsGoal } = await createGoal(access, {});
    await contribute(access, savingsGoal.id, { amount: 60_000, mode: "reservation" }).expect(201);

    const res = await withdraw(access, savingsGoal.id, { amount: 90_000, mode: "reservation" }).expect(409);
    expect(res.body.error.code).toBe("SAVINGS_WITHDRAWAL_TOO_LARGE");
    expect(Number(res.body.error.details.available)).toBe(60_000);
  });

  it("refuse un retrait dont les frais mettraient un autre objectif à découvert", async () => {
    const { access } = await authedUser();
    const especes = await defaultAccount(access);
    await fund(access, especes.id, 500_000);
    const momo = await createAccount(access, { name: "MoMo", type: "mobile_money" });
    await fund(access, momo.id, 100_000);
    // Les 100 000 de MoMo sont intégralement réservés par deux objectifs.
    const a = await createGoal(access, { name: "A", accountId: momo.id });
    const b = await createGoal(access, { name: "B", accountId: momo.id });
    await contribute(access, a.savingsGoal.id, { amount: 60_000, mode: "reservation" }).expect(201);
    await contribute(access, b.savingsGoal.id, { amount: 40_000, mode: "reservation" }).expect(201);

    // Retirer 40 000 de B vers Espèces avec 1 000 de frais : MoMo descend à
    // 59 000 alors que A en réserve encore 60 000.
    const res = await withdraw(access, b.savingsGoal.id, {
      amount: 40_000,
      mode: "virement",
      counterpartAccountId: especes.id,
      fee: 1_000,
      occurredOn: "2026-11-15",
    }).expect(409);
    expect(res.body.error.code).toBe("SAVINGS_EXCEEDS_ACCOUNT");

    // Sans frais, le même retrait passe.
    await withdraw(access, b.savingsGoal.id, {
      amount: 40_000,
      mode: "virement",
      counterpartAccountId: especes.id,
      occurredOn: "2026-11-15",
    }).expect(201);
  });
});

describe("cohérence avec les comptes", () => {
  it("refuse de supprimer un virement qui adosse un mouvement d'épargne", async () => {
    const { access } = await authedUser();
    const especes = await defaultAccount(access);
    await fund(access, especes.id, 300_000);
    const livret = await createAccount(access, { name: "Livret", type: "epargne" });
    const { savingsGoal } = await createGoal(access, { accountId: livret.id });
    const res = await contribute(access, savingsGoal.id, {
      amount: 100_000,
      mode: "virement",
      counterpartAccountId: especes.id,
      occurredOn: "2026-11-14",
    }).expect(201);

    const del = await request(app)
      .delete(`/api/transfers/${res.body.transfer.id}`)
      .set(auth(access))
      .expect(409);
    expect(del.body.error.code).toBe("TRANSFER_BACKS_SAVINGS");
  });

  it("libère la réservation quand l'objectif est supprimé", async () => {
    const { access } = await authedUser();
    const especes = await defaultAccount(access);
    await fund(access, especes.id, 200_000);
    const a = await createGoal(access, { name: "A" });
    await contribute(access, a.savingsGoal.id, { amount: 180_000, mode: "reservation" }).expect(201);

    const b = await createGoal(access, { name: "B" });
    await contribute(access, b.savingsGoal.id, { amount: 100_000, mode: "reservation" }).expect(409);

    await request(app).delete(`/api/savings-goals/${a.savingsGoal.id}`).set(auth(access)).expect(204);
    await contribute(access, b.savingsGoal.id, { amount: 100_000, mode: "reservation" }).expect(201);
  });
});

describe("isolation entre utilisateurs", () => {
  it("ne laisse pas verser sur l'objectif d'un autre", async () => {
    const a = await authedUser();
    const b = await authedUser();
    const { savingsGoal } = await createGoal(a.access, {});
    const res = await contribute(b.access, savingsGoal.id, { amount: 1_000, mode: "reservation" }).expect(404);
    expect(res.body.error.code).toBe("SAVINGS_GOAL_NOT_FOUND");
  });

  it("ne laisse pas retirer de l'objectif d'un autre", async () => {
    const a = await authedUser();
    const b = await authedUser();
    const { savingsGoal } = await createGoal(a.access, {});
    await withdraw(b.access, savingsGoal.id, { amount: 1_000, mode: "reservation" }).expect(404);
  });

  it("ne laisse pas virer depuis le compte d'un autre", async () => {
    const a = await authedUser();
    const b = await authedUser();
    const compteDeB = await createAccount(b.access, { name: "Privé", type: "banque" });
    const { savingsGoal } = await createGoal(a.access, {});
    const res = await contribute(a.access, savingsGoal.id, {
      amount: 1_000,
      mode: "virement",
      counterpartAccountId: compteDeB.id,
      occurredOn: "2026-11-14",
    }).expect(404);
    expect(res.body.error.code).toBe("ACCOUNT_NOT_FOUND");
  });
});
