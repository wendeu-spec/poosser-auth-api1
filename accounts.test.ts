import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, resetDb, registerFreshUser } from "./helpers.js";
import { pool } from "../src/db/pool.js";

/**
 * Comptes et virements (migrations/029_accounts_transfers.sql) :
 *   - chaque mouvement est rattaché à un compte (compte « Espèces » par défaut) ;
 *   - le solde d'un compte = solde d'ouverture + revenus − dépenses
 *     + virements reçus − virements émis ;
 *   - un virement est neutre ; ses frais deviennent une vraie dépense
 *     « Frais Mobile Money » sur le compte débité, liée au virement ;
 *   - isolation stricte entre utilisateurs, comme toute ressource métier.
 */

beforeEach(resetDb);

async function authedUser() {
  const { body } = await registerFreshUser();
  return { access: body.accessToken as string, userId: body.user.id as string };
}

const auth = (access: string) => ({ Authorization: `Bearer ${access}` });

async function createAccount(access: string, body: Record<string, unknown>) {
  const res = await request(app).post("/api/accounts").set(auth(access)).send(body).expect(201);
  return res.body.account as { id: string; name: string; balance: string; archived: boolean };
}

async function listAccounts(access: string) {
  const res = await request(app).get("/api/accounts").set(auth(access)).expect(200);
  return res.body.accounts as Array<{ id: string; name: string; type: string; balance: string; archived: boolean }>;
}

async function createTx(access: string, body: Record<string, unknown>) {
  const res = await request(app)
    .post("/api/transactions")
    .set(auth(access))
    .send({ occurredOn: "2026-11-10", method: "Espèces", ...body })
    .expect(201);
  return res.body.transaction as { id: string; account_id: string; transfer_id: string | null };
}

const balanceOf = (accounts: Array<{ id: string; balance: string }>, id: string) =>
  Number(accounts.find((a) => a.id === id)!.balance);

describe("Comptes — compte par défaut", () => {
  it("un nouvel utilisateur reçoit un compte « Espèces » à la première lecture, une seule fois", async () => {
    const { access } = await authedUser();
    const first = await listAccounts(access);
    expect(first).toHaveLength(1);
    expect(first[0]!.name).toBe("Espèces");
    expect(first[0]!.type).toBe("especes");
    expect(Number(first[0]!.balance)).toBe(0);

    const second = await listAccounts(access);
    expect(second).toHaveLength(1);
    expect(second[0]!.id).toBe(first[0]!.id);
  });

  it("un mouvement sans accountId est rattaché au compte par défaut", async () => {
    const { access } = await authedUser();
    const tx = await createTx(access, { type: "depense", category: "Alimentation", amount: 5000 });
    const accounts = await listAccounts(access);
    expect(accounts).toHaveLength(1);
    expect(tx.account_id).toBe(accounts[0]!.id);
  });

  it("créer un compte personnalisé en premier crée d'abord « Espèces », qui reste le compte par défaut", async () => {
    const { access } = await authedUser();
    const momo = await createAccount(access, { name: "MoMo", type: "mobile_money" });
    const accounts = await listAccounts(access);
    expect(accounts.map((a) => a.name)).toEqual(["Espèces", "MoMo"]);
    const tx = await createTx(access, { type: "depense", category: "Transport", amount: 500 });
    expect(tx.account_id).toBe(accounts[0]!.id);
    expect(tx.account_id).not.toBe(momo.id);
  });

  it("deux créations simultanées de mouvements ne créent qu'un seul compte par défaut", async () => {
    const { access } = await authedUser();
    await Promise.all([
      createTx(access, { type: "depense", category: "Transport", amount: 1000 }),
      createTx(access, { type: "depense", category: "Transport", amount: 2000 }),
    ]);
    expect(await listAccounts(access)).toHaveLength(1);
  });
});

describe("Comptes — création, solde, modification", () => {
  it("calcule le solde : ouverture + revenus − dépenses", async () => {
    const { access } = await authedUser();
    const momo = await createAccount(access, { name: "MTN MoMo", type: "mobile_money", openingBalance: 20000 });
    expect(Number(momo.balance)).toBe(20000);

    await createTx(access, { type: "revenu", category: "Salaire", amount: 150000, accountId: momo.id, method: "Mobile Money" });
    await createTx(access, { type: "depense", category: "Alimentation", amount: 12500, accountId: momo.id, method: "Mobile Money" });

    const accounts = await listAccounts(access);
    expect(balanceOf(accounts, momo.id)).toBe(157500);
  });

  it("refuse deux comptes du même nom (insensible à la casse)", async () => {
    const { access } = await authedUser();
    await createAccount(access, { name: "Banque UBA", type: "banque" });
    const res = await request(app).post("/api/accounts").set(auth(access)).send({ name: "banque uba", type: "banque" }).expect(409);
    expect(res.body.error.code).toBe("ACCOUNT_NAME_TAKEN");
  });

  it("accepte un solde d'ouverture négatif (découvert) et refuse un type inconnu", async () => {
    const { access } = await authedUser();
    const bank = await createAccount(access, { name: "Banque", type: "banque", openingBalance: -15000 });
    expect(Number(bank.balance)).toBe(-15000);
    await request(app).post("/api/accounts").set(auth(access)).send({ name: "Crypto", type: "crypto" }).expect(400);
  });

  it("modifie le nom et le solde d'ouverture, le solde suit", async () => {
    const { access } = await authedUser();
    const acc = await createAccount(access, { name: "Orange", type: "mobile_money", openingBalance: 1000 });
    const res = await request(app)
      .patch(`/api/accounts/${acc.id}`)
      .set(auth(access))
      .send({ name: "Orange Money", openingBalance: 4000 })
      .expect(200);
    expect(res.body.account.name).toBe("Orange Money");
    expect(Number(res.body.account.balance)).toBe(4000);
  });

  it("un mouvement peut changer de compte, et les deux soldes suivent", async () => {
    const { access } = await authedUser();
    const [cash] = await listAccounts(access);
    const momo = await createAccount(access, { name: "MoMo", type: "mobile_money" });
    const tx = await createTx(access, { type: "depense", category: "Loisirs", amount: 3000, accountId: cash!.id });

    await request(app).patch(`/api/transactions/${tx.id}`).set(auth(access)).send({ accountId: momo.id }).expect(200);

    const accounts = await listAccounts(access);
    expect(balanceOf(accounts, cash!.id)).toBe(0);
    expect(balanceOf(accounts, momo.id)).toBe(-3000);
  });
});

describe("Comptes — archivage et suppression", () => {
  it("un compte jamais utilisé se supprime ; un compte utilisé doit être archivé", async () => {
    const { access } = await authedUser();
    await listAccounts(access); // crée « Espèces »
    const unused = await createAccount(access, { name: "Vide", type: "autre" });
    await request(app).delete(`/api/accounts/${unused.id}`).set(auth(access)).expect(204);

    const used = await createAccount(access, { name: "Utilisé", type: "banque" });
    await createTx(access, { type: "depense", category: "Santé", amount: 800, accountId: used.id });
    const res = await request(app).delete(`/api/accounts/${used.id}`).set(auth(access)).expect(409);
    expect(res.body.error.code).toBe("ACCOUNT_IN_USE");

    const archived = await request(app).patch(`/api/accounts/${used.id}`).set(auth(access)).send({ archived: true }).expect(200);
    expect(archived.body.account.archived).toBe(true);
  });

  it("un compte archivé ne reçoit plus de nouveaux mouvements ni virements", async () => {
    const { access } = await authedUser();
    const [cash] = await listAccounts(access);
    const old = await createAccount(access, { name: "Ancien", type: "banque" });
    await request(app).patch(`/api/accounts/${old.id}`).set(auth(access)).send({ archived: true }).expect(200);

    const tx = await request(app)
      .post("/api/transactions")
      .set(auth(access))
      .send({ type: "depense", category: "Autres", amount: 100, occurredOn: "2026-11-10", method: "Autre", accountId: old.id })
      .expect(409);
    expect(tx.body.error.code).toBe("ACCOUNT_ARCHIVED");

    const tr = await request(app)
      .post("/api/transfers")
      .set(auth(access))
      .send({ fromAccountId: cash!.id, toAccountId: old.id, amount: 100, occurredOn: "2026-11-10" })
      .expect(409);
    expect(tr.body.error.code).toBe("ACCOUNT_ARCHIVED");
  });

  it("refuse d'archiver ou de supprimer le dernier compte actif", async () => {
    const { access } = await authedUser();
    const [cash] = await listAccounts(access);
    const archive = await request(app).patch(`/api/accounts/${cash!.id}`).set(auth(access)).send({ archived: true }).expect(409);
    expect(archive.body.error.code).toBe("ACCOUNT_LAST_ACTIVE");
    const del = await request(app).delete(`/api/accounts/${cash!.id}`).set(auth(access)).expect(409);
    expect(del.body.error.code).toBe("ACCOUNT_LAST_ACTIVE");
  });
});

describe("Virements entre comptes", () => {
  it("un virement est neutre : il déplace le solde sans créer de revenu ni de dépense", async () => {
    const { access } = await authedUser();
    const momo = await createAccount(access, { name: "MoMo", type: "mobile_money", openingBalance: 50000 });
    const [cash] = (await listAccounts(access)).filter((a) => a.name === "Espèces");

    const res = await request(app)
      .post("/api/transfers")
      .set(auth(access))
      .send({ fromAccountId: momo.id, toAccountId: cash!.id, amount: 30000, occurredOn: "2026-11-11", note: "Retrait" })
      .expect(201);
    expect(res.body.feeTransaction).toBeNull();

    const accounts = await listAccounts(access);
    expect(balanceOf(accounts, momo.id)).toBe(20000);
    expect(balanceOf(accounts, cash!.id)).toBe(30000);

    const txs = await request(app).get("/api/transactions").set(auth(access)).expect(200);
    expect(txs.body.transactions).toHaveLength(0);
  });

  it("les frais deviennent une dépense « Frais Mobile Money » sur le compte débité", async () => {
    const { access } = await authedUser();
    const momo = await createAccount(access, { name: "MoMo", type: "mobile_money", openingBalance: 50000 });
    const [cash] = (await listAccounts(access)).filter((a) => a.name === "Espèces");

    const res = await request(app)
      .post("/api/transfers")
      .set(auth(access))
      .send({ fromAccountId: momo.id, toAccountId: cash!.id, amount: 30000, fee: 450, occurredOn: "2026-11-11" })
      .expect(201);
    const fee = res.body.feeTransaction;
    expect(fee.type).toBe("depense");
    expect(fee.category).toBe("Frais Mobile Money");
    expect(Number(fee.amount)).toBe(450);
    expect(fee.method).toBe("Mobile Money");
    expect(fee.account_id).toBe(momo.id);
    expect(fee.transfer_id).toBe(res.body.transfer.id);

    const accounts = await listAccounts(access);
    expect(balanceOf(accounts, momo.id)).toBe(50000 - 30000 - 450);
    expect(balanceOf(accounts, cash!.id)).toBe(30000);
  });

  it("les frais d'un virement ne se modifient ni ne se suppriment directement", async () => {
    const { access } = await authedUser();
    const momo = await createAccount(access, { name: "MoMo", type: "mobile_money", openingBalance: 10000 });
    const [cash] = (await listAccounts(access)).filter((a) => a.name === "Espèces");
    const res = await request(app)
      .post("/api/transfers")
      .set(auth(access))
      .send({ fromAccountId: momo.id, toAccountId: cash!.id, amount: 5000, fee: 100, occurredOn: "2026-11-11" })
      .expect(201);
    const feeId = res.body.feeTransaction.id;

    const patch = await request(app).patch(`/api/transactions/${feeId}`).set(auth(access)).send({ amount: 1 }).expect(409);
    expect(patch.body.error.code).toBe("TRANSACTION_LINKED_TO_TRANSFER");
    const del = await request(app).delete(`/api/transactions/${feeId}`).set(auth(access)).expect(409);
    expect(del.body.error.code).toBe("TRANSACTION_LINKED_TO_TRANSFER");
  });

  it("supprimer un virement supprime ses frais et rétablit les soldes", async () => {
    const { access } = await authedUser();
    const momo = await createAccount(access, { name: "MoMo", type: "mobile_money", openingBalance: 10000 });
    const [cash] = (await listAccounts(access)).filter((a) => a.name === "Espèces");
    const res = await request(app)
      .post("/api/transfers")
      .set(auth(access))
      .send({ fromAccountId: momo.id, toAccountId: cash!.id, amount: 5000, fee: 100, occurredOn: "2026-11-11" })
      .expect(201);

    await request(app).delete(`/api/transfers/${res.body.transfer.id}`).set(auth(access)).expect(204);

    const accounts = await listAccounts(access);
    expect(balanceOf(accounts, momo.id)).toBe(10000);
    expect(balanceOf(accounts, cash!.id)).toBe(0);
    const txs = await request(app).get("/api/transactions").set(auth(access)).expect(200);
    expect(txs.body.transactions).toHaveLength(0);
    const transfers = await request(app).get("/api/transfers").set(auth(access)).expect(200);
    expect(transfers.body.transfers).toHaveLength(0);
  });

  it("refuse un virement vers le même compte, ou un montant nul", async () => {
    const { access } = await authedUser();
    const [cash] = await listAccounts(access);
    await request(app)
      .post("/api/transfers")
      .set(auth(access))
      .send({ fromAccountId: cash!.id, toAccountId: cash!.id, amount: 100, occurredOn: "2026-11-11" })
      .expect(400);
    const other = await createAccount(access, { name: "Autre", type: "autre" });
    await request(app)
      .post("/api/transfers")
      .set(auth(access))
      .send({ fromAccountId: cash!.id, toAccountId: other.id, amount: 0, occurredOn: "2026-11-11" })
      .expect(400);
  });
});

describe("Comptes et virements — isolation stricte entre utilisateurs", () => {
  it("un utilisateur ne voit, ne modifie ni n'utilise jamais le compte d'un autre (404)", async () => {
    const alice = await authedUser();
    const bob = await authedUser();
    const aliceMomo = await createAccount(alice.access, { name: "MoMo Alice", type: "mobile_money", openingBalance: 1000 });
    const [bobCash] = await listAccounts(bob.access);

    const bobAccounts = await listAccounts(bob.access);
    expect(bobAccounts.some((a) => a.id === aliceMomo.id)).toBe(false);

    await request(app).patch(`/api/accounts/${aliceMomo.id}`).set(auth(bob.access)).send({ name: "Volé" }).expect(404);
    await request(app).delete(`/api/accounts/${aliceMomo.id}`).set(auth(bob.access)).expect(404);

    const tx = await request(app)
      .post("/api/transactions")
      .set(auth(bob.access))
      .send({ type: "depense", category: "Autres", amount: 10, occurredOn: "2026-11-10", method: "Autre", accountId: aliceMomo.id })
      .expect(404);
    expect(tx.body.error.code).toBe("ACCOUNT_NOT_FOUND");

    await request(app)
      .post("/api/transfers")
      .set(auth(bob.access))
      .send({ fromAccountId: aliceMomo.id, toAccountId: bobCash!.id, amount: 500, occurredOn: "2026-11-11" })
      .expect(404);

    // Le solde d'Alice n'a pas bougé.
    expect(balanceOf(await listAccounts(alice.access), aliceMomo.id)).toBe(1000);
  });

  it("un utilisateur ne voit ni ne supprime les virements d'un autre (404)", async () => {
    const alice = await authedUser();
    const bob = await authedUser();
    const [aliceCash] = await listAccounts(alice.access);
    const aliceMomo = await createAccount(alice.access, { name: "MoMo", type: "mobile_money" });
    const res = await request(app)
      .post("/api/transfers")
      .set(auth(alice.access))
      .send({ fromAccountId: aliceCash!.id, toAccountId: aliceMomo.id, amount: 100, occurredOn: "2026-11-11" })
      .expect(201);

    const bobTransfers = await request(app).get("/api/transfers").set(auth(bob.access)).expect(200);
    expect(bobTransfers.body.transfers).toHaveLength(0);
    await request(app).delete(`/api/transfers/${res.body.transfer.id}`).set(auth(bob.access)).expect(404);
  });
});

describe("Migration 029 — reprise des mouvements existants", () => {
  it("chaque mouvement en base porte un compte (contrainte NOT NULL)", async () => {
    const { rows } = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'account_id'`,
    );
    expect(rows[0]!.is_nullable).toBe("NO");
  });
});
