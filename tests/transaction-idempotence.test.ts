import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, resetDb, registerFreshUser } from "./helpers.js";

/**
 * Clé d'idempotence des opérations (migration 039).
 *
 * Le cas qu'elle couvre, et lui seul : le serveur enregistre l'opération,
 * puis la réponse se perd en chemin — réseau qui coupe pile à ce moment.
 * Le téléphone ne sait pas que c'est passé, il réessaie. Sans clé, la
 * dépense est enregistrée deux fois ; et c'est en situation de réseau
 * intermittent, précisément celle pour laquelle la file d'attente existe,
 * que ce cas se produit.
 *
 * Ce que ces tests verrouillent :
 *   - rejouer la même clé ne crée rien et renvoie la MÊME opération ;
 *   - les frais liés ne sont pas recréés non plus, et reviennent dans la
 *     réponse comme au premier envoi ;
 *   - deux utilisateurs peuvent porter la même clé sans se gêner ;
 *   - une clé différente crée bien une opération différente, même à
 *     montant, date et note identiques (une dépense peut se répéter) ;
 *   - une opération sans clé reste exactement ce qu'elle était.
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

const depense = (access: string, body: Record<string, unknown>) =>
  request(app)
    .post("/api/transactions")
    .set(auth(access))
    .send({ type: "depense", category: "Alimentation", amount: 2500, occurredOn: "2026-11-21", method: "Espèces", ...body });

async function countTransactions(access: string) {
  const res = await request(app).get("/api/transactions").set(auth(access)).expect(200);
  return (res.body.transactions as unknown[]).length;
}

describe("rejouer une opération déjà passée", () => {
  it("ne l'enregistre pas deux fois et renvoie la même", async () => {
    const { access } = await authedUser();
    const cle = "11111111-2222-3333-4444-555555555555";

    const premier = await depense(access, { clientKey: cle, note: "Taxi marché" }).expect(201);
    const second = await depense(access, { clientKey: cle, note: "Taxi marché" }).expect(201);

    expect(second.body.transaction.id).toBe(premier.body.transaction.id);
    expect(await countTransactions(access)).toBe(1);
  });

  it("renvoie l'originale même si le renvoi porte d'autres valeurs", async () => {
    const { access } = await authedUser();
    const cle = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const premier = await depense(access, { clientKey: cle, amount: 2500 }).expect(201);

    // Un renvoi est censé être identique au premier envoi. S'il ne l'est
    // pas, c'est la PREMIÈRE version qui fait foi : le serveur a déjà
    // répondu une fois, et on ne réécrit pas l'histoire sur un renvoi.
    const second = await depense(access, { clientKey: cle, amount: 99999 }).expect(201);
    expect(second.body.transaction.id).toBe(premier.body.transaction.id);
    expect(Number(second.body.transaction.amount)).toBe(2500);
    expect(await countTransactions(access)).toBe(1);
  });

  it("ne recrée pas les frais, et les renvoie comme au premier envoi", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    const cle = "ffffffff-0000-1111-2222-333333333333";

    const premier = await depense(access, { clientKey: cle, accountId: especes.id, method: "Mobile Money", fee: 100 }).expect(201);
    expect(premier.body.feeTransaction).not.toBeNull();
    // L'opération + sa dépense de frais.
    expect(await countTransactions(access)).toBe(2);

    const second = await depense(access, { clientKey: cle, accountId: especes.id, method: "Mobile Money", fee: 100 }).expect(201);
    expect(second.body.transaction.id).toBe(premier.body.transaction.id);
    expect(second.body.feeTransaction?.id).toBe(premier.body.feeTransaction.id);
    expect(await countTransactions(access)).toBe(2);
  });

  it("laisse passer une opération identique sous une AUTRE clé", async () => {
    const { access } = await authedUser();
    // Deux taxis le même jour au même prix, ce n'est pas un doublon : seule
    // la clé décide.
    await depense(access, { clientKey: "cle-du-premier-taxi-aaaa", note: "Taxi" }).expect(201);
    await depense(access, { clientKey: "cle-du-second-taxi-bbbb", note: "Taxi" }).expect(201);
    expect(await countTransactions(access)).toBe(2);
  });

  it("ne change rien à une opération sans clé", async () => {
    const { access } = await authedUser();
    const res = await depense(access, {}).expect(201);
    expect(res.body.transaction.client_key).toBeNull();
    await depense(access, {}).expect(201);
    expect(await countTransactions(access)).toBe(2);
  });

  it("refuse une clé trop courte plutôt que de la rendre inoffensive en silence", async () => {
    const { access } = await authedUser();
    await depense(access, { clientKey: "court" }).expect(400);
  });
});

describe("isolation entre utilisateurs", () => {
  it("la même clé chez deux personnes reste deux opérations distinctes", async () => {
    const a = await authedUser();
    const b = await authedUser();
    const cle = "meme-cle-chez-deux-personnes";

    await depense(a.access, { clientKey: cle, amount: 2500 }).expect(201);
    await depense(b.access, { clientKey: cle, amount: 7000 }).expect(201);

    expect(await countTransactions(a.access)).toBe(1);
    expect(await countTransactions(b.access)).toBe(1);
    const chezB = await request(app).get("/api/transactions").set(auth(b.access)).expect(200);
    expect(Number(chezB.body.transactions[0].amount)).toBe(7000);
  });
});

describe("une opération mise en file garde ses rattachements", () => {
  it("projet et rubrique traversent le rejeu sans se dédoubler", async () => {
    const { access } = await authedUser();
    const projet = (await request(app).post("/api/projects").set(auth(access)).send({ name: "Chantier" }).expect(201)).body.project;
    const rubrique = (await request(app)
      .post(`/api/projects/${projet.id}/rubriques`)
      .set(auth(access))
      .send({ name: "Fondation" })
      .expect(201)).body.rubrique;
    const cle = "cle-operation-de-chantier-01";

    const premier = await depense(access, { clientKey: cle, category: undefined, projectId: projet.id, rubriqueId: rubrique.id }).expect(201);
    const second = await depense(access, { clientKey: cle, category: undefined, projectId: projet.id, rubriqueId: rubrique.id }).expect(201);

    expect(second.body.transaction.id).toBe(premier.body.transaction.id);
    expect(second.body.transaction.rubrique_id).toBe(rubrique.id);
    // Dans un projet, c'est la rubrique qui classe (migration 037).
    expect(second.body.transaction.category).toBeNull();
    expect(await countTransactions(access)).toBe(1);
  });
});
