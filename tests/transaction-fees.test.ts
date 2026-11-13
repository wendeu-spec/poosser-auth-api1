import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, resetDb, registerFreshUser } from "./helpers.js";
import { pool } from "../src/db/pool.js";

/**
 * Frais d'une opération (migrations/031_transaction_fees.sql) :
 *   - le champ `fee` crée une dépense de frais liée (fee_parent_id), dans la
 *     catégorie du type de compte, sur le même compte et à la même date ;
 *   - les frais suivent leur opération (modification, suppression) et ne se
 *     modifient pas seuls ;
 *   - le solde du compte = montant de l'opération − frais ;
 *   - les frais déjà saisis séparément sont rattachés quand c'est sans ambiguïté.
 */

beforeEach(resetDb);

async function authedUser() {
  const { body } = await registerFreshUser();
  return { auth: `Bearer ${body.accessToken as string}`, userId: body.user.id as string };
}

async function createAccount(auth: string, name: string, type: string) {
  const res = await request(app).post("/api/accounts").set("Authorization", auth).send({ name, type }).expect(201);
  return res.body.account as { id: string };
}

async function balances(auth: string) {
  const res = await request(app).get("/api/accounts").set("Authorization", auth).expect(200);
  return Object.fromEntries((res.body.accounts as Array<{ name: string; balance: string }>).map((a) => [a.name, Number(a.balance)]));
}

async function allTx(auth: string) {
  const res = await request(app).get("/api/transactions").set("Authorization", auth).expect(200);
  return res.body.transactions as Array<Record<string, any>>;
}

const base = { occurredOn: "2026-10-31", method: "Virement bancaire" as const };

describe("Frais d'une opération", () => {
  it("un revenu avec frais sur un compte bancaire crée une dépense « Frais bancaires » liée", async () => {
    const { auth } = await authedUser();
    const bank = await createAccount(auth, "ECOBANK", "banque");
    const res = await request(app)
      .post("/api/transactions")
      .set("Authorization", auth)
      .send({ ...base, type: "revenu", category: "Salaire", amount: 124000, fee: 500, accountId: bank.id, note: "Salaire octobre" })
      .expect(201);

    const fee = res.body.feeTransaction;
    expect(fee.type).toBe("depense");
    expect(fee.category).toBe("Frais bancaires");
    expect(Number(fee.amount)).toBe(500);
    expect(fee.account_id).toBe(bank.id);
    expect(fee.occurred_on).toBe("2026-10-31");
    expect(fee.fee_parent_id).toBe(res.body.transaction.id);
    expect(fee.note).toBe("Frais · Salaire octobre");
    expect((await balances(auth))["ECOBANK"]).toBe(123500);
  });

  it("la catégorie dépend du type de compte : Mobile Money, Espèces", async () => {
    const { auth } = await authedUser();
    const momo = await createAccount(auth, "MTN MoMo", "mobile_money");
    const a = await request(app).post("/api/transactions").set("Authorization", auth)
      .send({ ...base, method: "Mobile Money", type: "depense", category: "Santé", amount: 50000, fee: 104, accountId: momo.id }).expect(201);
    expect(a.body.feeTransaction.category).toBe("Frais Mobile Money");
    const b = await request(app).post("/api/transactions").set("Authorization", auth)
      .send({ ...base, method: "Espèces", type: "depense", category: "Transport", amount: 2000, fee: 100 }).expect(201);
    expect(b.body.feeTransaction.category).toBe("Frais");
  });

  it("frais à 0 ou absents : aucune dépense de frais", async () => {
    const { auth } = await authedUser();
    const res = await request(app).post("/api/transactions").set("Authorization", auth)
      .send({ ...base, method: "Espèces", type: "revenu", category: "Commerce", amount: 7000, fee: 0 }).expect(201);
    expect(res.body.feeTransaction).toBeNull();
    expect(await allTx(auth)).toHaveLength(1);
  });

  it("les frais suivent leur opération : date, compte (et catégorie), montant, suppression", async () => {
    const { auth } = await authedUser();
    const momo = await createAccount(auth, "MTN MoMo", "mobile_money");
    const bank = await createAccount(auth, "ECOBANK", "banque");
    const created = await request(app).post("/api/transactions").set("Authorization", auth)
      .send({ ...base, method: "Mobile Money", type: "depense", category: "Santé", amount: 50000, fee: 104, accountId: momo.id }).expect(201);
    const id = created.body.transaction.id;

    // Changement de date et de compte : les frais suivent, catégorie recalculée.
    const moved = await request(app).patch(`/api/transactions/${id}`).set("Authorization", auth)
      .send({ occurredOn: "2026-11-02", accountId: bank.id, method: "Virement bancaire" }).expect(200);
    expect(moved.body.feeTransaction.occurred_on).toBe("2026-11-02");
    expect(moved.body.feeTransaction.account_id).toBe(bank.id);
    expect(moved.body.feeTransaction.category).toBe("Frais bancaires");
    expect(Number(moved.body.feeTransaction.amount)).toBe(104); // fee absent = inchangé

    // Nouveau montant de frais, puis plus de frais.
    const changed = await request(app).patch(`/api/transactions/${id}`).set("Authorization", auth).send({ fee: 300 }).expect(200);
    expect(Number(changed.body.feeTransaction.amount)).toBe(300);
    const removed = await request(app).patch(`/api/transactions/${id}`).set("Authorization", auth).send({ fee: 0 }).expect(200);
    expect(removed.body.feeTransaction).toBeNull();
    expect(await allTx(auth)).toHaveLength(1);

    // Ajouter des frais à une opération qui n'en avait pas.
    const added = await request(app).patch(`/api/transactions/${id}`).set("Authorization", auth).send({ fee: 250 }).expect(200);
    expect(Number(added.body.feeTransaction.amount)).toBe(250);

    // Supprimer l'opération supprime ses frais.
    await request(app).delete(`/api/transactions/${id}`).set("Authorization", auth).expect(204);
    expect(await allTx(auth)).toHaveLength(0);
  });

  it("une dépense de frais ne se modifie ni ne se supprime seule", async () => {
    const { auth } = await authedUser();
    const created = await request(app).post("/api/transactions").set("Authorization", auth)
      .send({ ...base, method: "Espèces", type: "depense", category: "Transport", amount: 2000, fee: 100 }).expect(201);
    const feeId = created.body.feeTransaction.id;
    const patch = await request(app).patch(`/api/transactions/${feeId}`).set("Authorization", auth).send({ amount: 1 }).expect(409);
    expect(patch.body.error.code).toBe("TRANSACTION_IS_FEE");
    const del = await request(app).delete(`/api/transactions/${feeId}`).set("Authorization", auth).expect(409);
    expect(del.body.error.code).toBe("TRANSACTION_IS_FEE");
  });

  it("isolation : impossible de mettre une opération (et ses frais) sur le compte d'un autre utilisateur", async () => {
    const alice = await authedUser();
    const bob = await authedUser();
    const aliceBank = await createAccount(alice.auth, "ECOBANK", "banque");
    await request(app).post("/api/transactions").set("Authorization", bob.auth)
      .send({ ...base, type: "revenu", category: "Salaire", amount: 1000, fee: 10, accountId: aliceBank.id }).expect(404);
    expect(await allTx(alice.auth)).toHaveLength(0);
    expect(await allTx(bob.auth)).toHaveLength(0);
  });
});

describe("Migration 031 : rattachement des frais déjà saisis", () => {
  const backfill = readFileSync(new URL("../migrations/031_transaction_fees.sql", import.meta.url), "utf8");
  const backfillSql = backfill.slice(backfill.indexOf("WITH fees AS"));

  it("rattache un frais à son opération quand il n'y a qu'une possibilité, sans changer les soldes", async () => {
    const { auth, userId } = await authedUser();
    const momo = await createAccount(auth, "MTN MoMo", "mobile_money");
    const parent = await request(app).post("/api/transactions").set("Authorization", auth)
      .send({ ...base, method: "Mobile Money", type: "depense", category: "Santé", amount: 50000, note: "Envoi à Christiane · Réf. 19455656831", accountId: momo.id }).expect(201);
    // Frais saisi à l'ancienne (dépense séparée, sans lien).
    await request(app).post("/api/transactions").set("Authorization", auth)
      .send({ ...base, method: "Mobile Money", type: "depense", category: "Frais Mobile Money", amount: 104, note: "Frais · Envoi à Christiane · Réf. 19455656831", accountId: momo.id }).expect(201);
    // Une dépense « Frais » sans opération correspondante reste séparée.
    await request(app).post("/api/transactions").set("Authorization", auth)
      .send({ ...base, method: "Mobile Money", type: "depense", category: "Frais Mobile Money", amount: 50, note: "Frais · introuvable", accountId: momo.id }).expect(201);
    const before = await balances(auth);

    await pool.query(backfillSql);

    const { rows } = await pool.query(
      `SELECT amount, fee_parent_id FROM transactions WHERE user_id = $1 AND category = 'Frais Mobile Money' ORDER BY amount`,
      [userId],
    );
    expect(rows.find((r) => Number(r.amount) === 104)!.fee_parent_id).toBe(parent.body.transaction.id);
    expect(rows.find((r) => Number(r.amount) === 50)!.fee_parent_id).toBeNull();
    expect(await balances(auth)).toEqual(before);
  });

  it("deux opérations possibles : on ne devine pas, le frais reste séparé", async () => {
    const { auth, userId } = await authedUser();
    for (let i = 0; i < 2; i++) {
      await request(app).post("/api/transactions").set("Authorization", auth)
        .send({ ...base, method: "Espèces", type: "depense", category: "Transport", amount: 2000 }).expect(201);
    }
    await request(app).post("/api/transactions").set("Authorization", auth)
      .send({ ...base, method: "Espèces", type: "depense", category: "Frais Mobile Money", amount: 100, note: "Frais · Transport" }).expect(201);
    await pool.query(backfillSql);
    const { rows } = await pool.query(`SELECT fee_parent_id FROM transactions WHERE user_id = $1 AND amount = 100`, [userId]);
    expect(rows[0].fee_parent_id).toBeNull();
  });
});
