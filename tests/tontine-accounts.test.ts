import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, resetDb, registerFreshUser } from "./helpers.js";

/**
 * Tontine adossée à l'argent réel (migrations/034_tontine_accounts.sql).
 *
 * Le défaut corrigé : markContribution() ne faisait que basculer un booléen et
 * closeRound() n'écrivait qu'une ligne d'historique. Sur un groupe de 14
 * membres à 50 000 FCFA, cela voulait dire 700 000 FCFA dans chaque sens,
 * totalement invisibles dans les comptes.
 *
 * Ce que ces tests verrouillent :
 *   - cotiser et encaisser sont des VIREMENTS NEUTRES, jamais des revenus :
 *     les 700 000 encaissés ne doivent pas gonfler les revenus du mois ;
 *   - sur un cycle complet, la cagnotte retombe EXACTEMENT à zéro — c'est la
 *     preuve arithmétique que le modèle est juste ;
 *   - la cagnotte n'est jamais comptée dans l'argent disponible ;
 *   - décocher une cotisation défait exactement ce qu'elle avait créé ;
 *   - caisse de solidarité et pénalités sont de VRAIES dépenses ;
 *   - les deux rôles (participant / collecteur) ;
 *   - un groupe non configuré reste un simple pointage ;
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

async function especesOf(access: string) {
  return (await listAccounts(access)).find((a) => a.name === "Espèces")!;
}

async function fund(access: string, accountId: string, amount: number) {
  await request(app)
    .post("/api/transactions")
    .set(auth(access))
    .send({ type: "revenu", category: "Salaire", amount, occurredOn: "2026-11-01", method: "Espèces", accountId })
    .expect(201);
}

type Tontine = {
  id: string; accountId: string | null; myMemberId: string | null; role: string;
  position: number; currentRound: number; contributionAmount: number;
  members: Array<{ id: string; name: string; position: number }>;
  paidThisRound: Record<string, boolean>;
  history: Array<{ round: number; beneficiaryName: string; totalAmount: number }>;
};

async function createTontine(access: string, body: Record<string, unknown>, expected = 201) {
  const res = await request(app)
    .post("/api/tontines")
    .set(auth(access))
    .send({ name: "COEUR JOYEUX", contributionAmount: 50_000, frequency: "mensuelle", members: ["Awa", "Bello", "Moi"], ...body })
    .expect(expected);
  return res.body.tontine as Tontine;
}

const mark = (access: string, id: string, body: Record<string, unknown>) =>
  request(app).post(`/api/tontines/${id}/contributions`).set(auth(access)).send(body);

const close = (access: string, id: string, body: Record<string, unknown> = {}) =>
  request(app).post(`/api/tontines/${id}/close-round`).set(auth(access)).send(body);

async function transactionsOf(access: string) {
  const res = await request(app).get("/api/transactions").set(auth(access)).expect(200);
  return res.body.transactions as Array<{ id: string; type: string; category: string; amount: string; account_id: string }>;
}

describe("la cagnotte est un compte, hors du disponible", () => {
  it("crée un compte de type tontine avec le groupe", async () => {
    const { access } = await authedUser();
    const t = await createTontine(access, {});
    expect(t.accountId).toBeTruthy();
    const pot = (await listAccounts(access)).find((a) => a.id === t.accountId)!;
    expect(pot.type).toBe("tontine");
    expect(pot.name).toBe("Tontine COEUR JOYEUX");
  });

  it("refuse la cagnotte comme compte payeur", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 500_000);
    const t = await createTontine(access, { myMemberPosition: 3 });
    const res = await mark(access, t.id, { memberId: t.members[2]!.id, paid: true, accountId: t.accountId }).expect(409);
    expect(res.body.error.code).toBe("TONTINE_ACCOUNT_NOT_USABLE");
  });

  it("n'est jamais le compte par défaut d'une opération", async () => {
    const { access } = await authedUser();
    const t = await createTontine(access, {});
    const create = await request(app)
      .post("/api/transactions")
      .set(auth(access))
      .send({ type: "depense", category: "Alimentation", amount: 1_000, occurredOn: "2026-11-10", method: "Espèces" })
      .expect(201);
    expect(create.body.transaction.account_id).not.toBe(t.accountId);
  });
});

describe("participant : ma cotisation et mon encaissement", () => {
  it("cotiser est un virement neutre, pas une dépense", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 500_000);
    const t = await createTontine(access, { myMemberPosition: 3 });

    const res = await mark(access, t.id, { memberId: t.members[2]!.id, paid: true, occurredOn: "2026-11-05" }).expect(200);
    const after = res.body.tontine as Tontine;
    expect(after.position).toBe(50_000);

    const accounts = await listAccounts(access);
    expect(Number(accounts.find((a) => a.id === especes.id)!.balance)).toBe(450_000);
    expect(Number(accounts.find((a) => a.id === t.accountId)!.balance)).toBe(50_000);
    // Aucune dépense créée : un virement est neutre.
    expect((await transactionsOf(access)).filter((x) => x.type === "depense")).toHaveLength(0);
  });

  it("la cotisation d'un autre membre ne touche à aucun compte", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 500_000);
    const t = await createTontine(access, { myMemberPosition: 3 });

    const res = await mark(access, t.id, { memberId: t.members[0]!.id, paid: true }).expect(200);
    expect((res.body.tontine as Tontine).position).toBe(0);
    const accounts = await listAccounts(access);
    expect(Number(accounts.find((a) => a.id === especes.id)!.balance)).toBe(500_000);
  });

  it("encaisser à son tour est un virement neutre, PAS un revenu", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 500_000);
    // Je suis en position 1 : je suis bénéficiaire du tour 1.
    const t = await createTontine(access, { myMemberPosition: 1 });
    for (const m of t.members) await mark(access, t.id, { memberId: m.id, paid: true }).expect(200);

    const res = await close(access, t.id, { occurredOn: "2026-11-20" }).expect(200);
    const after = res.body.tontine as Tontine;
    // 1 cotisation versée (la mienne) − la cagnotte de 150 000 encaissée.
    expect(after.position).toBe(-100_000);

    const accounts = await listAccounts(access);
    expect(Number(accounts.find((a) => a.id === especes.id)!.balance)).toBe(600_000);

    // LE POINT CENTRAL : aucun revenu de 150 000 n'a été inventé.
    const revenus = (await transactionsOf(access)).filter((x) => x.type === "revenu");
    expect(revenus).toHaveLength(1); // uniquement le salaire d'amorçage
    expect(Number(revenus[0]!.amount)).toBe(500_000);
  });

  it("sur un cycle complet, la cagnotte retombe exactement à zéro", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 1_000_000);
    const t = await createTontine(access, { myMemberPosition: 2 });
    const soldeDepart = Number((await listAccounts(access)).find((a) => a.id === especes.id)!.balance);

    let view = t;
    for (let round = 1; round <= 3; round++) {
      for (const m of view.members) await mark(access, t.id, { memberId: m.id, paid: true }).expect(200);
      const res = await close(access, t.id).expect(200);
      view = res.body.tontine as Tontine;
    }

    // 3 cotisations de 50 000 versées, 150 000 encaissés au tour 2.
    expect(view.position).toBe(0);
    const especesFin = Number((await listAccounts(access)).find((a) => a.id === especes.id)!.balance);
    expect(especesFin).toBe(soldeDepart); // l'argent est revenu, au centime près
    expect(view.history).toHaveLength(3);
  });
});

describe("décocher défait les mouvements", () => {
  it("supprime le virement et rend l'argent", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 500_000);
    const t = await createTontine(access, { myMemberPosition: 3 });
    const me = t.members[2]!.id;

    await mark(access, t.id, { memberId: me, paid: true, fee: 500 }).expect(200);
    let accounts = await listAccounts(access);
    expect(Number(accounts.find((a) => a.id === especes.id)!.balance)).toBe(449_500);

    const res = await mark(access, t.id, { memberId: me, paid: false }).expect(200);
    expect((res.body.tontine as Tontine).position).toBe(0);
    accounts = await listAccounts(access);
    // Le virement ET sa dépense de frais ont disparu.
    expect(Number(accounts.find((a) => a.id === especes.id)!.balance)).toBe(500_000);
    const transfers = await request(app).get("/api/transfers").set(auth(access)).expect(200);
    expect(transfers.body.transfers).toHaveLength(0);
    expect(await transactionsOf(access)).toHaveLength(1); // seul le salaire
  });

  it("recocher deux fois ne double pas la cotisation", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 500_000);
    const t = await createTontine(access, { myMemberPosition: 3 });
    const me = t.members[2]!.id;

    await mark(access, t.id, { memberId: me, paid: true }).expect(200);
    const res = await mark(access, t.id, { memberId: me, paid: true }).expect(200);
    expect((res.body.tontine as Tontine).position).toBe(50_000);
    const transfers = await request(app).get("/api/transfers").set(auth(access)).expect(200);
    expect(transfers.body.transfers).toHaveLength(1);
  });

  it("refuse de supprimer le virement par la porte des comptes", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 500_000);
    const t = await createTontine(access, { myMemberPosition: 3 });
    await mark(access, t.id, { memberId: t.members[2]!.id, paid: true }).expect(200);

    const transfers = await request(app).get("/api/transfers").set(auth(access)).expect(200);
    const del = await request(app)
      .delete(`/api/transfers/${transfers.body.transfers[0].id}`)
      .set(auth(access))
      .expect(409);
    expect(del.body.error.code).toBe("TRANSFER_BACKS_TONTINE");
  });
});

describe("caisse de solidarité et pénalités : de vraies dépenses", () => {
  it("crée une dépense séparée, hors de la cagnotte", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 500_000);
    const t = await createTontine(access, { myMemberPosition: 3, solidarityAmount: 2_000, lateFee: 1_000 });

    const res = await mark(access, t.id, { memberId: t.members[2]!.id, paid: true, late: true, occurredOn: "2026-11-05" }).expect(200);
    // La cagnotte ne reçoit que la cotisation : sinon elle ne retomberait
    // jamais à zéro en fin de cycle.
    expect((res.body.tontine as Tontine).position).toBe(50_000);

    const depenses = (await transactionsOf(access)).filter((x) => x.type === "depense");
    expect(depenses).toHaveLength(1);
    expect(depenses[0]!.category).toBe("Tontine");
    expect(Number(depenses[0]!.amount)).toBe(3_000); // 2 000 de caisse + 1 000 de pénalité
    expect(depenses[0]!.account_id).toBe(especes.id);

    const accounts = await listAccounts(access);
    expect(Number(accounts.find((a) => a.id === especes.id)!.balance)).toBe(447_000);
  });

  it("sans retard, seule la caisse est prélevée", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 500_000);
    const t = await createTontine(access, { myMemberPosition: 3, solidarityAmount: 2_000, lateFee: 1_000 });
    await mark(access, t.id, { memberId: t.members[2]!.id, paid: true }).expect(200);
    const depenses = (await transactionsOf(access)).filter((x) => x.type === "depense");
    expect(Number(depenses[0]!.amount)).toBe(2_000);
  });

  it("sans extras, aucune dépense n'est créée", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 500_000);
    const t = await createTontine(access, { myMemberPosition: 3 });
    await mark(access, t.id, { memberId: t.members[2]!.id, paid: true, late: true }).expect(200);
    expect((await transactionsOf(access)).filter((x) => x.type === "depense")).toHaveLength(0);
  });

  it("la dépense ne se supprime pas depuis l'historique", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 500_000);
    const t = await createTontine(access, { myMemberPosition: 3, solidarityAmount: 2_000 });
    await mark(access, t.id, { memberId: t.members[2]!.id, paid: true }).expect(200);
    const depense = (await transactionsOf(access)).find((x) => x.type === "depense")!;
    const del = await request(app).delete(`/api/transactions/${depense.id}`).set(auth(access)).expect(409);
    expect(del.body.error.code).toBe("TRANSACTION_IS_TONTINE_MOVEMENT");
  });
});

describe("collecteur : je détiens l'argent du groupe", () => {
  it("l'argent des autres entre dans la cagnotte sans sortir de mes comptes", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 500_000);
    const t = await createTontine(access, { myMemberPosition: 3, role: "collecteur" });

    await mark(access, t.id, { memberId: t.members[0]!.id, paid: true }).expect(200);
    const res = await mark(access, t.id, { memberId: t.members[1]!.id, paid: true }).expect(200);
    // La cagnotte détient les 100 000 des deux autres...
    expect((res.body.tontine as Tontine).position).toBe(100_000);
    // ...sans que mes propres comptes bougent : cet argent ne vient pas de chez moi.
    const accounts = await listAccounts(access);
    expect(Number(accounts.find((a) => a.id === especes.id)!.balance)).toBe(500_000);
  });

  it("verser au bénéficiaire sort l'argent de la cagnotte pour de bon", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 500_000);
    // Je suis en position 3, le bénéficiaire du tour 1 est Awa (position 1).
    const t = await createTontine(access, { myMemberPosition: 3, role: "collecteur" });
    for (const m of t.members) await mark(access, t.id, { memberId: m.id, paid: true }).expect(200);

    const res = await close(access, t.id).expect(200);
    const after = res.body.tontine as Tontine;
    expect(after.history[0]!.beneficiaryName).toBe("Awa");
    // 100 000 encaissés des autres + 50 000 virés par moi − 150 000 versés.
    expect(after.position).toBe(0);
    // Ma cotisation a bien quitté mes comptes.
    const accounts = await listAccounts(access);
    expect(Number(accounts.find((a) => a.id === especes.id)!.balance)).toBe(450_000);
  });

  it("inclut la caisse et la pénalité des autres dans la cagnotte encaissée", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 500_000);
    const t = await createTontine(access, { myMemberPosition: 3, role: "collecteur", solidarityAmount: 2_000, lateFee: 1_000 });
    const res = await mark(access, t.id, { memberId: t.members[0]!.id, paid: true, late: true }).expect(200);
    // Je reçois bien la somme complète de ce membre : 50 000 + 2 000 + 1 000.
    expect((res.body.tontine as Tontine).position).toBe(53_000);
  });
});

describe("groupe non configuré", () => {
  it("reste un simple pointage tant qu'aucun membre n'est désigné", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 500_000);
    const t = await createTontine(access, {});
    expect(t.myMemberId).toBeNull();

    for (const m of t.members) await mark(access, t.id, { memberId: m.id, paid: true }).expect(200);
    const res = await close(access, t.id).expect(200);
    const after = res.body.tontine as Tontine;
    expect(after.position).toBe(0);
    const accounts = await listAccounts(access);
    expect(Number(accounts.find((a) => a.id === especes.id)!.balance)).toBe(500_000);
    expect(after.history).toHaveLength(1); // le pointage, lui, fonctionne toujours
  });

  it("se configure après coup sans toucher au passé", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 500_000);
    const t = await createTontine(access, {});
    await mark(access, t.id, { memberId: t.members[2]!.id, paid: true }).expect(200);

    const patched = await request(app)
      .patch(`/api/tontines/${t.id}`)
      .set(auth(access))
      .send({ myMemberPosition: 3, role: "collecteur", solidarityAmount: 1_500 })
      .expect(200);
    const after = patched.body.tontine as Tontine;
    expect(after.myMemberId).toBe(t.members[2]!.id);
    expect(after.role).toBe("collecteur");
    // La cotisation déjà cochée n'est pas réécrite rétroactivement.
    expect(after.position).toBe(0);
    expect(after.paidThisRound[t.members[2]!.id]).toBe(true);
  });

  it("refuse une position de membre inexistante", async () => {
    const { access } = await authedUser();
    // 9e position demandée sur un groupe de 3 membres : la forme est valide
    // (Zod accepte 1..50), c'est le service qui refuse, et rien n'est créé.
    const res = await request(app)
      .post("/api/tontines")
      .set(auth(access))
      .send({ name: "COEUR JOYEUX", contributionAmount: 50_000, frequency: "mensuelle", members: ["Awa", "Bello", "Moi"], myMemberPosition: 9 })
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    const list = await request(app).get("/api/tontines").set(auth(access)).expect(200);
    expect(list.body.tontines).toHaveLength(0);
    // La cagnotte créée dans la transaction annulée ne doit pas subsister.
    expect((await listAccounts(access)).filter((a) => a.type === "tontine")).toHaveLength(0);
  });
});

describe("isolation entre utilisateurs", () => {
  it("ne laisse pas cocher la cotisation d'un autre", async () => {
    const a = await authedUser();
    const b = await authedUser();
    const t = await createTontine(a.access, { myMemberPosition: 3 });
    const res = await mark(b.access, t.id, { memberId: t.members[2]!.id, paid: true }).expect(404);
    expect(res.body.error.code).toBe("TONTINE_NOT_FOUND");
  });

  it("ne laisse pas payer depuis le compte d'un autre", async () => {
    const a = await authedUser();
    const b = await authedUser();
    const compteDeB = await request(app)
      .post("/api/accounts").set(auth(b.access)).send({ name: "Privé", type: "banque" }).expect(201);
    const t = await createTontine(a.access, { myMemberPosition: 3 });
    const res = await mark(a.access, t.id, {
      memberId: t.members[2]!.id, paid: true, accountId: compteDeB.body.account.id,
    }).expect(404);
    expect(res.body.error.code).toBe("ACCOUNT_NOT_FOUND");
  });
});
