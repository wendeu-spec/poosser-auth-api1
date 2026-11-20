import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, resetDb, registerFreshUser } from "./helpers.js";

/**
 * Position personnelle dans une tontine, et contrôle de caisse du collecteur.
 *
 * Défaut corrigé : la carte affichait « Le groupe vous doit : X » en lisant le
 * solde de la cagnotte. Pour un COLLECTEUR c'était l'exact contraire de la
 * vérité — cet argent est celui du groupe, qu'il détient en attendant de le
 * remettre au bénéficiaire du tour.
 *
 * Sur les données réelles de Yannis au 20 novembre 2026 : COEUR JOYEUX,
 * 14 membres à 50 000, tour 5, collecteur, rang 4 — donc tour déjà passé.
 * La carte annonçait « le groupe vous doit 500 000 » alors qu'il lui restait
 * justement 500 000 à VERSER. Le bon montant, avec le mauvais sens.
 *
 * Ce que ces tests verrouillent :
 *   - versé / reçu / reste à verser, identiques quel que soit le rôle ;
 *   - le tour de passage, et le fait qu'il soit déjà passé ;
 *   - le contrôle de caisse du collecteur (détenu vs attendu) ;
 *   - un participant n'a pas de contrôle de caisse : il ne détient rien.
 */

beforeEach(resetDb);

const auth = (access: string) => ({ Authorization: `Bearer ${access}` });

async function authedUser() {
  const { body } = await registerFreshUser();
  return { access: body.accessToken as string };
}

async function especesOf(access: string) {
  const res = await request(app).get("/api/accounts").set(auth(access)).expect(200);
  return (res.body.accounts as Array<{ id: string; name: string }>).find((a) => a.name === "Espèces")!;
}

async function fund(access: string, accountId: string, amount: number) {
  await request(app)
    .post("/api/transactions")
    .set(auth(access))
    .send({ type: "revenu", category: "Salaire", amount, occurredOn: "2026-11-01", method: "Espèces", accountId })
    .expect(201);
}

type Tontine = {
  id: string; accountId: string | null; currentRound: number; position: number;
  myContributed: number; myReceived: number; myRemainingToPay: number;
  myTurnRound: number | null; myTurnPassed: boolean; expectedHeld: number | null;
  members: Array<{ id: string; name: string; position: number }>;
};

/** Reproduit COEUR JOYEUX en réduit : 4 membres, moi en 2e position. */
async function groupe(access: string, body: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/tontines")
    .set(auth(access))
    .send({
      name: "COEUR JOYEUX", contributionAmount: 50_000, frequency: "mensuelle",
      members: ["Awa", "Moi", "Bello", "Nadia"], myMemberPosition: 2, ...body,
    })
    .expect(201);
  return res.body.tontine as Tontine;
}

async function get(access: string, id: string) {
  const res = await request(app).get(`/api/tontines/${id}`).set(auth(access)).expect(200);
  return res.body.tontine as Tontine;
}

const mark = (access: string, id: string, body: Record<string, unknown>) =>
  request(app).post(`/api/tontines/${id}/contributions`).set(auth(access)).send(body);

/** Joue un tour entier et le clôture. */
async function tourComplet(access: string, t: Tontine, especesId: string, moiId: string) {
  for (const m of t.members) {
    const body: Record<string, unknown> = { memberId: m.id, paid: true, occurredOn: "2026-11-05" };
    if (m.id === moiId) body.accountId = especesId;
    await mark(access, t.id, body).expect(200);
  }
  const courant = (await get(access, t.id)).currentRound;
  const benef = t.members[(courant - 1) % t.members.length]!;
  const body = benef.id === moiId ? { accountId: especesId, occurredOn: "2026-11-06" } : {};
  await request(app).post(`/api/tontines/${t.id}/close-round`).set(auth(access)).send(body).expect(200);
}

describe("ma position dans le cycle", () => {
  it("dit ce que j'ai versé, reçu, et ce qu'il me reste", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 2_000_000);
    const t = await groupe(access, { role: "collecteur" });
    const moi = t.members[1]!;

    // Rien joué : 4 tours × 50 000 à verser.
    let v = await get(access, t.id);
    expect(v.myContributed).toBe(0);
    expect(v.myReceived).toBe(0);
    expect(v.myRemainingToPay).toBe(200_000);
    expect(v.myTurnRound).toBe(2);
    expect(v.myTurnPassed).toBe(false);

    // Tour 1 : bénéficiaire Awa. J'ai cotisé une fois.
    await tourComplet(access, t, especes.id, moi.id);
    v = await get(access, t.id);
    expect(v.myContributed).toBe(50_000);
    expect(v.myReceived).toBe(0);
    expect(v.myRemainingToPay).toBe(150_000);
    expect(v.currentRound).toBe(2);
    expect(v.myTurnRound).toBe(2);

    // Tour 2 : c'est mon tour, j'encaisse 200 000.
    await tourComplet(access, t, especes.id, moi.id);
    v = await get(access, t.id);
    expect(v.myContributed).toBe(100_000);
    expect(v.myReceived).toBe(200_000);
    expect(v.myRemainingToPay).toBe(100_000); // tours 3 et 4
    expect(v.myTurnPassed).toBe(true);
    // Mon tour est passé : le prochain est au cycle suivant.
    expect(v.myTurnRound).toBe(6);
  });

  it("sur un cycle complet, j'ai versé exactement ce que j'ai reçu", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 2_000_000);
    const t = await groupe(access, { role: "collecteur" });
    const moi = t.members[1]!;
    for (let i = 0; i < 4; i++) await tourComplet(access, t, especes.id, moi.id);

    const v = await get(access, t.id);
    // La preuve que le modèle est juste, côté personnel cette fois : sur un
    // cycle entier, une tontine ne fait ni gagner ni perdre.
    expect(v.myContributed).toBe(200_000);
    expect(v.myReceived).toBe(200_000);
    // Et un nouveau cycle est déjà ouvert : clôturer le dernier tour enchaîne
    // directement sur le suivant, il n'y a pas d'état « cycle terminé ».
    expect(v.currentRound).toBe(5);
    expect(v.myRemainingToPay).toBe(200_000);
    expect(v.myTurnRound).toBe(6);
  });

  it("n'annonce plus rien à cotiser au dernier tour une fois payé", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 2_000_000);
    const t = await groupe(access, {});
    const moi = t.members[1]!;
    // Trois tours joués : on arrive au 4e et dernier du cycle.
    for (let i = 0; i < 3; i++) await tourComplet(access, t, especes.id, moi.id);
    expect((await get(access, t.id)).currentRound).toBe(4);

    await mark(access, t.id, { memberId: moi.id, paid: true, accountId: especes.id, occurredOn: "2026-11-05" }).expect(200);
    expect((await get(access, t.id)).myRemainingToPay).toBe(0);
  });

  it("déduit le tour en cours dès que je l'ai cotisé", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 500_000);
    const t = await groupe(access, {});
    const moi = t.members[1]!;

    expect((await get(access, t.id)).myRemainingToPay).toBe(200_000);
    await mark(access, t.id, { memberId: moi.id, paid: true, accountId: especes.id, occurredOn: "2026-11-05" }).expect(200);
    expect((await get(access, t.id)).myRemainingToPay).toBe(150_000);
  });
});

describe("contrôle de caisse du collecteur", () => {
  it("compare ce que la cagnotte détient à ce que les cotisations impliquent", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 500_000);
    const t = await groupe(access, { role: "collecteur" });

    // Deux membres ont cotisé : la cagnotte doit contenir 100 000.
    await mark(access, t.id, { memberId: t.members[0]!.id, paid: true, occurredOn: "2026-11-05" }).expect(200);
    await mark(access, t.id, { memberId: t.members[2]!.id, paid: true, occurredOn: "2026-11-05" }).expect(200);

    const v = await get(access, t.id);
    expect(v.expectedHeld).toBe(100_000);
    expect(v.position).toBe(100_000);
    expect(v.position - v.expectedHeld!).toBe(0);
  });

  it("n'existe pas pour un participant : il ne détient rien", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 500_000);
    const t = await groupe(access, { role: "participant" });
    expect((await get(access, t.id)).expectedHeld).toBeNull();
  });
});

describe("groupe non configuré", () => {
  it("ne calcule aucune position tant que personne n'est désigné", async () => {
    const { access } = await authedUser();
    const t = await groupe(access, { myMemberPosition: undefined });
    const v = await get(access, t.id);
    expect(v.myTurnRound).toBeNull();
    expect(v.myRemainingToPay).toBe(0);
    expect(v.expectedHeld).toBeNull();
  });
});
