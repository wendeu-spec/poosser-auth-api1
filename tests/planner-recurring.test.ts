import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, resetDb, registerFreshUser } from "./helpers.js";

/**
 * Échéances récurrentes du Planner (migrations/030_planner_event_account.sql) :
 *   - une échéance peut être rattachée à un compte ;
 *   - « Réalisé » avec createTransaction crée le mouvement côté serveur, sur
 *     ce compte, dans la même transaction SQL, et une seule fois ;
 *   - la prochaine occurrence garde le compte et n'est créée qu'une fois ;
 *   - sans createTransaction (ancienne app), rien ne change ;
 *   - isolation stricte entre utilisateurs.
 */

beforeEach(resetDb);

async function authedUser() {
  const { body } = await registerFreshUser();
  return { auth: `Bearer ${body.accessToken as string}` };
}

async function createAccount(auth: string, name: string, type = "mobile_money") {
  const res = await request(app).post("/api/accounts").set("Authorization", auth).send({ name, type }).expect(201);
  return res.body.account as { id: string; balance: string };
}

async function createLoyer(auth: string, extra: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/planner-events")
    .set("Authorization", auth)
    .send({
      title: "Loyer", eventDate: "2026-11-05", eventTime: "09:00", durationMinutes: 30,
      type: "depense", category: "Logement", amount: 60000, recurrence: "mensuelle", ...extra,
    })
    .expect(201);
  return res.body.plannerEvent as { id: string; account_id: string | null };
}

async function balances(auth: string) {
  const res = await request(app).get("/api/accounts").set("Authorization", auth).expect(200);
  return Object.fromEntries((res.body.accounts as Array<{ name: string; balance: string }>).map((a) => [a.name, Number(a.balance)]));
}

describe("Échéances récurrentes du Planner", () => {
  it("rattache l'échéance à un compte et crée le mouvement sur ce compte à la validation", async () => {
    const { auth } = await authedUser();
    const momo = await createAccount(auth, "MTN MoMo");
    const ev = await createLoyer(auth, { accountId: momo.id });
    expect(ev.account_id).toBe(momo.id);

    const res = await request(app)
      .post(`/api/planner-events/${ev.id}/status`)
      .set("Authorization", auth)
      .send({ status: "realise", createTransaction: true, occurredOn: "2026-11-06" })
      .expect(200);

    expect(res.body.transaction).toBeTruthy();
    expect(res.body.transaction.account_id).toBe(momo.id);
    expect(res.body.transaction.method).toBe("Mobile Money");
    expect(res.body.transaction.occurred_on).toBe("2026-11-06");
    expect(Number(res.body.transaction.amount)).toBe(60000);
    expect(res.body.transaction.note).toBe("Loyer");
    expect(res.body.plannerEvent.transaction_id).toBe(res.body.transaction.id);
    expect(res.body.nextPlannerEvent.event_date).toBe("2026-12-05");
    expect(res.body.nextPlannerEvent.account_id).toBe(momo.id);

    expect((await balances(auth))["MTN MoMo"]).toBe(-60000);
  });

  it("sans compte choisi, le mouvement va sur le compte par défaut", async () => {
    const { auth } = await authedUser();
    const ev = await createLoyer(auth);
    const res = await request(app)
      .post(`/api/planner-events/${ev.id}/status`)
      .set("Authorization", auth)
      .send({ status: "realise", createTransaction: true })
      .expect(200);
    expect((await balances(auth))["Espèces"]).toBe(-60000);
    expect(res.body.transaction.method).toBe("Espèces");
  });

  it("valider deux fois ne crée ni deux mouvements ni deux prochaines occurrences", async () => {
    const { auth } = await authedUser();
    const ev = await createLoyer(auth);
    const send = () =>
      request(app).post(`/api/planner-events/${ev.id}/status`).set("Authorization", auth).send({ status: "realise", createTransaction: true });

    const [a, b] = await Promise.all([send(), send()]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Repasser par « non réalisé » puis « réalisé » ne recrée rien non plus.
    await request(app).post(`/api/planner-events/${ev.id}/status`).set("Authorization", auth).send({ status: "non_realise" }).expect(200);
    await send().expect(200);

    const txs = await request(app).get("/api/transactions").set("Authorization", auth).expect(200);
    expect(txs.body.transactions).toHaveLength(1);
    const events = await request(app).get("/api/planner-events").set("Authorization", auth).expect(200);
    expect(events.body.plannerEvents).toHaveLength(2); // l'échéance + UNE prochaine occurrence
  });

  it("sans createTransaction (ancienne version de l'app), aucun mouvement n'est créé côté serveur", async () => {
    const { auth } = await authedUser();
    const ev = await createLoyer(auth);
    const res = await request(app)
      .post(`/api/planner-events/${ev.id}/status`)
      .set("Authorization", auth)
      .send({ status: "realise" })
      .expect(200);
    expect(res.body.transaction).toBeNull();
    const txs = await request(app).get("/api/transactions").set("Authorization", auth).expect(200);
    expect(txs.body.transactions).toHaveLength(0);
  });

  it("un compte archivé depuis : le mouvement retombe sur le compte par défaut", async () => {
    const { auth } = await authedUser();
    const momo = await createAccount(auth, "MTN MoMo");
    const ev = await createLoyer(auth, { accountId: momo.id });
    await request(app).patch(`/api/accounts/${momo.id}`).set("Authorization", auth).send({ archived: true }).expect(200);
    await request(app)
      .post(`/api/planner-events/${ev.id}/status`)
      .set("Authorization", auth)
      .send({ status: "realise", createTransaction: true })
      .expect(200);
    const b = await balances(auth);
    expect(b["Espèces"]).toBe(-60000);
    expect(b["MTN MoMo"]).toBe(0);
  });

  it("on peut changer ou retirer le compte d'une échéance", async () => {
    const { auth } = await authedUser();
    const momo = await createAccount(auth, "MTN MoMo");
    const om = await createAccount(auth, "Orange Money");
    const ev = await createLoyer(auth, { accountId: momo.id });
    const changed = await request(app).patch(`/api/planner-events/${ev.id}`).set("Authorization", auth).send({ accountId: om.id }).expect(200);
    expect(changed.body.plannerEvent.account_id).toBe(om.id);
    const kept = await request(app).patch(`/api/planner-events/${ev.id}`).set("Authorization", auth).send({ amount: 65000 }).expect(200);
    expect(kept.body.plannerEvent.account_id).toBe(om.id);
    const cleared = await request(app).patch(`/api/planner-events/${ev.id}`).set("Authorization", auth).send({ accountId: null }).expect(200);
    expect(cleared.body.plannerEvent.account_id).toBeNull();
  });

  it("isolation : impossible d'utiliser le compte d'un autre utilisateur ou de valider son échéance", async () => {
    const alice = await authedUser();
    const bob = await authedUser();
    const aliceMomo = await createAccount(alice.auth, "MTN MoMo");

    const res = await request(app)
      .post("/api/planner-events")
      .set("Authorization", bob.auth)
      .send({
        title: "Loyer", eventDate: "2026-11-05", eventTime: "09:00", durationMinutes: 30,
        type: "depense", category: "Logement", amount: 60000, accountId: aliceMomo.id,
      })
      .expect(404);
    expect(res.body.error.code).toBe("ACCOUNT_NOT_FOUND");

    const bobEv = await createLoyer(bob.auth);
    await request(app).patch(`/api/planner-events/${bobEv.id}`).set("Authorization", bob.auth).send({ accountId: aliceMomo.id }).expect(404);

    const aliceEv = await createLoyer(alice.auth);
    await request(app)
      .post(`/api/planner-events/${aliceEv.id}/status`)
      .set("Authorization", bob.auth)
      .send({ status: "realise", createTransaction: true })
      .expect(404);
    const txs = await request(app).get("/api/transactions").set("Authorization", alice.auth).expect(200);
    expect(txs.body.transactions).toHaveLength(0);
  });
});
