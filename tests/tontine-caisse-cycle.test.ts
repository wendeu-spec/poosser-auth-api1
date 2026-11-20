import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, resetDb, registerFreshUser } from "./helpers.js";
import { pool } from "../src/db/pool.js";

/**
 * Deux corrections demandées après usage réel de COEUR JOYEUX
 * (migrations/036_tontine_caisse_par_cycle.sql).
 *
 *   1. La caisse de solidarité ne se verse qu'UNE FOIS par cycle complet : un
 *      bénéficiaire par tour, 14 membres, donc une cotisation sociale tous les
 *      14 mois — pas tous les mois.
 *   2. L'argent du groupe ne doit jamais entrer dans les analyses de revenus
 *      et de dépenses de l'utilisateur. Un collecteur de 14 membres encaissait
 *      650 000 FCFA par tour qui apparaissaient comme ses revenus : sur les
 *      données réelles, 1 540 500 FCFA d'entrées affichées pour 102 500 réels.
 *      Le filtrage est côté client (ownTx), mais on verrouille ici la donnée
 *      sur laquelle il s'appuie : ces mouvements portent bien un compte de
 *      type `tontine` ou `caisse`, jamais un compte personnel.
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
  id: string; accountId: string | null; currentRound: number; caisseBalance: number;
  caisseContributed: number; members: Array<{ id: string; name: string; position: number }>;
};

async function createTontine(access: string, body: Record<string, unknown>) {
  const res = await request(app)
    .post("/api/tontines")
    .set(auth(access))
    .send({ name: "COEUR JOYEUX", contributionAmount: 50_000, frequency: "mensuelle", ...body })
    .expect(201);
  return res.body.tontine as Tontine;
}

async function getTontine(access: string, id: string) {
  const res = await request(app).get(`/api/tontines/${id}`).set(auth(access)).expect(200);
  return res.body.tontine as Tontine;
}

const mark = (access: string, id: string, body: Record<string, unknown>) =>
  request(app).post(`/api/tontines/${id}/contributions`).set(auth(access)).send(body);

/** Joue un tour entier et le clôture. Renvoie le bénéficiaire du tour joué. */
async function jouerUnTour(access: string, t: Tontine, especesId: string, moiId: string) {
  for (const m of t.members) {
    const body: Record<string, unknown> = { memberId: m.id, paid: true, occurredOn: "2026-11-05" };
    if (m.id === moiId) body.accountId = especesId;
    await mark(access, t.id, body).expect(200);
  }
  const courant = (await getTontine(access, t.id)).currentRound;
  const beneficiaire = t.members[(courant - 1) % t.members.length]!;
  const body = beneficiaire.id === moiId ? { accountId: especesId, occurredOn: "2026-11-06" } : {};
  await request(app).post(`/api/tontines/${t.id}/close-round`).set(auth(access)).send(body).expect(200);
}

describe("la caisse de solidarité ne se verse qu'une fois par cycle", () => {
  it("prélève au tour 1, puis plus rien jusqu'au tour suivant cycle", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 2_000_000);
    const t = await createTontine(access, {
      members: ["Awa", "Bello", "Moi"], myMemberPosition: 3, role: "collecteur", solidarityAmount: 5_000,
    });
    const moi = t.members[2]!.id;

    // Tour 1 : les 3 membres versent leur caisse.
    await jouerUnTour(access, t, especes.id, moi);
    expect((await getTontine(access, t.id)).caisseBalance).toBe(15_000);

    // Tours 2 et 3 : aucune caisse, on est au milieu du cycle.
    await jouerUnTour(access, t, especes.id, moi);
    expect((await getTontine(access, t.id)).caisseBalance).toBe(15_000);
    await jouerUnTour(access, t, especes.id, moi);
    expect((await getTontine(access, t.id)).caisseBalance).toBe(15_000);

    // Tour 4 : nouveau cycle (3 membres), la caisse repart.
    expect((await getTontine(access, t.id)).currentRound).toBe(4);
    await mark(access, t.id, { memberId: moi, paid: true, accountId: especes.id, occurredOn: "2027-02-05" }).expect(200);
    expect((await getTontine(access, t.id)).caisseBalance).toBe(20_000);
  });

  it("applique la pénalité de retard au tour où le retard a lieu, pas une fois par cycle", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 2_000_000);
    const t = await createTontine(access, {
      members: ["Awa", "Bello", "Moi"], myMemberPosition: 3, solidarityAmount: 5_000, lateFee: 1_000,
    });
    const moi = t.members[2]!.id;

    // Tour 1, en retard : caisse (5 000) + pénalité (1 000).
    await mark(access, t.id, { memberId: moi, paid: true, accountId: especes.id, late: true, occurredOn: "2026-11-05" }).expect(200);
    expect((await getTontine(access, t.id)).caisseBalance).toBe(6_000);

    await mark(access, t.id, { memberId: t.members[0]!.id, paid: true }).expect(200);
    await mark(access, t.id, { memberId: t.members[1]!.id, paid: true }).expect(200);
    await request(app).post(`/api/tontines/${t.id}/close-round`).set(auth(access)).send({}).expect(200);

    // Tour 2, en retard aussi : la pénalité s'applique, la caisse non.
    await mark(access, t.id, { memberId: moi, paid: true, accountId: especes.id, late: true, occurredOn: "2026-12-05" }).expect(200);
    expect((await getTontine(access, t.id)).caisseBalance).toBe(7_000);
  });
});

describe("l'argent du groupe n'est jamais sur un compte personnel", () => {
  it("porte tous les mouvements des autres membres sur la cagnotte ou la caisse", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 2_000_000);
    const t = await createTontine(access, {
      members: ["Awa", "Bello", "Moi"], myMemberPosition: 3, role: "collecteur", solidarityAmount: 5_000,
    });
    await jouerUnTour(access, t, especes.id, t.members[2]!.id);

    const comptes = await listAccounts(access);
    const horsBudget = new Set(comptes.filter((a) => a.type === "tontine" || a.type === "caisse").map((a) => a.id));
    const tx = (await request(app).get("/api/transactions").set(auth(access)).expect(200))
      .body.transactions as Array<{ category: string; account_id: string; amount: string }>;

    const tontineTx = tx.filter((x) => x.category === "Tontine");
    expect(tontineTx.length).toBeGreaterThan(0);
    // Aucun mouvement de catégorie « Tontine » ne doit atterrir sur un compte
    // personnel : c'est ce qui polluait les revenus et dépenses du mois.
    for (const x of tontineTx) expect(horsBudget.has(x.account_id)).toBe(true);
  });
});

describe("réparation des données laissées par maj25 (migration 036)", () => {
  it("sépare rétroactivement la solidarité fondue dans la cagnotte", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 2_000_000);
    const t = await createTontine(access, {
      members: ["Awa", "Bello", "Moi"], myMemberPosition: 3, role: "collecteur", solidarityAmount: 5_000,
    });

    // On reconstitue l'état que produisait maj25 : une seule écriture de
    // 55 000 sur la cagnotte (50 000 + 5 000 de caisse), sans ligne de caisse.
    await mark(access, t.id, { memberId: t.members[0]!.id, paid: true, occurredOn: "2026-11-05" }).expect(200);
    const { rows: contribRows } = await pool.query<{ id: string; pot_transaction_id: string; extra_transaction_id: string | null }>(
      `SELECT id, pot_transaction_id, extra_transaction_id FROM tontine_contributions
        WHERE tontine_id = $1 AND member_id = $2`,
      [t.id, t.members[0]!.id],
    );
    const contrib = contribRows[0]!;
    await pool.query(`DELETE FROM tontine_contributions WHERE id = $1 RETURNING 1`, []).catch(() => undefined);
    // On refond les deux écritures en une, comme le faisait maj25.
    await pool.query(`UPDATE tontine_contributions SET extra_transaction_id = NULL WHERE id = $1`, [contrib.id]);
    if (contrib.extra_transaction_id) {
      await pool.query(`DELETE FROM transactions WHERE id = $1`, [contrib.extra_transaction_id]);
    }
    await pool.query(`UPDATE transactions SET amount = 55000 WHERE id = $1`, [contrib.pot_transaction_id]);

    const avant = await getTontine(access, t.id);
    expect(Number((await listAccounts(access)).find((a) => a.id === t.accountId)!.balance)).toBe(55_000);

    // On rejoue le bloc de réparation de la migration 036.
    await pool.query(await reparation());

    const comptes = await listAccounts(access);
    expect(Number(comptes.find((a) => a.id === t.accountId)!.balance)).toBe(50_000);
    const caisse = comptes.find((a) => a.type === "caisse")!;
    expect(Number(caisse.balance)).toBe(5_000);
    expect(avant.caisseBalance).toBe(0);

    // Idempotent : relancer ne déplace rien de plus.
    await pool.query(await reparation());
    const apres = await listAccounts(access);
    expect(Number(apres.find((a) => a.id === t.accountId)!.balance)).toBe(50_000);
    expect(Number(apres.find((a) => a.type === "caisse")!.balance)).toBe(5_000);
  });
});

/** Le bloc DO de la migration 036, relu depuis le fichier — pas une copie. */
async function reparation(): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const sql = await readFile(new URL("../migrations/036_tontine_caisse_par_cycle.sql", import.meta.url), "utf-8");
  const start = sql.indexOf("DO $$");
  if (start === -1) throw new Error("[test] bloc DO introuvable dans la migration 036");
  return sql.slice(start);
}
