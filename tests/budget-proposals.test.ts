import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, resetDb, registerFreshUser } from "./helpers.js";
import { pool } from "../src/db/pool.js";
import { getCurrentProposal, recordReminderShown, decideProposal } from "../src/services/budgetProposalService.js";

beforeEach(resetDb);

// Mois de référence utilisé partout dans ce fichier : le 26 est après le jour
// de génération par défaut (BUDGET_PROPOSAL_GENERATE_DAY_OF_MONTH=25, voir
// .env.test), donc "maintenant" tombe toujours après le déclencheur, quel que
// soit le jour réel d'exécution des tests.
const SOURCE_MONTH = "2026-10";
const NOW_GENERATION = new Date("2026-10-26T10:00:00.000Z");
const NOW_TOO_EARLY = new Date("2026-10-20T10:00:00.000Z");

async function insertPlannerEvent(
  userId: string,
  opts: { title: string; eventDate: string; type: "revenu" | "depense"; category: string; amount: number; recurrence?: string | null },
) {
  await pool.query(
    `INSERT INTO planner_events (user_id, title, event_date, event_time, duration_minutes, type, category, amount, recurrence)
     VALUES ($1, $2, $3, '09:00', 30, $4, $5, $6, $7)`,
    [userId, opts.title, opts.eventDate, opts.type, opts.category, opts.amount, opts.recurrence ?? null],
  );
}

async function countProposals(userId: string): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*)::int AS c FROM budget_proposals WHERE user_id = $1`, [userId]);
  return rows[0].c;
}

async function backdateProposal(
  id: string,
  fields: { generatedAt?: Date; lastReminderAt?: Date | null; reminderCount?: number },
) {
  await pool.query(
    `UPDATE budget_proposals SET
       generated_at = COALESCE($2, generated_at),
       last_reminder_at = $3,
       reminder_count = COALESCE($4, reminder_count)
     WHERE id = $1`,
    [id, fields.generatedAt ?? null, fields.lastReminderAt ?? null, fields.reminderCount ?? null],
  );
}

describe("Proposition automatique de budget mensuel — service", () => {
  it("ne génère rien avant le jour configuré du mois (BUDGET_PROPOSAL_GENERATE_DAY_OF_MONTH=25)", async () => {
    const { body } = await registerFreshUser();
    await insertPlannerEvent(body.user.id, { title: "Loyer", eventDate: `${SOURCE_MONTH}-05`, type: "depense", category: "Logement", amount: 50000 });
    const result = await getCurrentProposal(body.user.id, NOW_TOO_EARLY);
    expect(result).toBeNull();
    expect(await countProposals(body.user.id)).toBe(0);
  });

  it("ne génère rien si l'utilisateur n'a aucun événement planner ce mois-ci (rien à répéter)", async () => {
    const { body } = await registerFreshUser();
    const result = await getCurrentProposal(body.user.id, NOW_GENERATION);
    expect(result).toBeNull();
  });

  it("génère la proposition à partir des événements non récurrents du mois, en excluant les événements récurrents", async () => {
    const { body } = await registerFreshUser();
    const userId = body.user.id;
    await insertPlannerEvent(userId, { title: "Revenu du mois", eventDate: `${SOURCE_MONTH}-01`, type: "revenu", category: "Salaire", amount: 500000 });
    await insertPlannerEvent(userId, { title: "Loyer mensuel", eventDate: `${SOURCE_MONTH}-05`, type: "depense", category: "Logement", amount: 130000 });
    // Événement récurrent : a déjà son propre mécanisme de report automatique
    // (setPlannerEventStatus) — ne doit PAS être repris dans la proposition,
    // sous peine de doublon à la validation.
    await insertPlannerEvent(userId, { title: "Cotisation tontine", eventDate: `${SOURCE_MONTH}-25`, type: "depense", category: "Tontine", amount: 40000, recurrence: "mensuelle" });

    const result = await getCurrentProposal(userId, NOW_GENERATION);
    expect(result).not.toBeNull();
    const { proposal, shouldRemind, daysSinceGenerated } = result!;
    expect(proposal.target_month).toBe("2026-11-01");
    expect(proposal.source_month).toBe("2026-10-01");
    expect(proposal.status).toBe("pending");
    expect(proposal.reminder_count).toBe(0);
    expect(shouldRemind).toBe(true); // premier affichage, dès que la proposition existe
    expect(daysSinceGenerated).toBe(0);

    expect(proposal.items).toHaveLength(2);
    const loyer = proposal.items.find((i) => i.titre === "Loyer mensuel");
    expect(loyer).toMatchObject({ type: "depense", categorie: "Logement", montant: 130000, jour: 5 });
    expect(proposal.items.find((i) => i.titre === "Cotisation tontine")).toBeUndefined();
  });

  it("est idempotente : relancer la génération pour le même mois ne crée jamais de doublon", async () => {
    const { body } = await registerFreshUser();
    const userId = body.user.id;
    await insertPlannerEvent(userId, { title: "Loyer", eventDate: `${SOURCE_MONTH}-05`, type: "depense", category: "Logement", amount: 50000 });

    const first = await getCurrentProposal(userId, NOW_GENERATION);
    const second = await getCurrentProposal(userId, NOW_GENERATION);
    expect(await countProposals(userId)).toBe(1);
    expect(first!.proposal.id).toBe(second!.proposal.id);
  });

  it("la cadence de rappel est dégressive : espacement de 24h les 3 premiers jours, puis 12h", async () => {
    const { body } = await registerFreshUser();
    const userId = body.user.id;
    await insertPlannerEvent(userId, { title: "Loyer", eventDate: `${SOURCE_MONTH}-05`, type: "depense", category: "Logement", amount: 50000 });
    const generated = await getCurrentProposal(userId, NOW_GENERATION);
    const id = generated!.proposal.id;

    // Juste après un premier rappel (phase précoce, écart minimal 24h) :
    // moins de 24h plus tard, pas de nouveau rappel.
    await backdateProposal(id, { lastReminderAt: NOW_GENERATION, reminderCount: 1 });
    const soon = await getCurrentProposal(userId, new Date(NOW_GENERATION.getTime() + 2 * 3_600_000));
    expect(soon!.shouldRemind).toBe(false);

    // 25h plus tard (>= 24h), toujours en phase précoce (jour 1 < 3) : nouveau rappel dû.
    const after25h = await getCurrentProposal(userId, new Date(NOW_GENERATION.getTime() + 25 * 3_600_000));
    expect(after25h!.shouldRemind).toBe(true);

    // En phase tardive (>= 3 jours depuis la génération), l'écart minimal
    // tombe à 12h : 13h après le dernier rappel, un nouveau rappel est dû.
    const lastReminderLate = new Date(NOW_GENERATION.getTime() + 3 * 86_400_000);
    await backdateProposal(id, { lastReminderAt: lastReminderLate, reminderCount: 4 });
    const stillTooSoon = await getCurrentProposal(userId, new Date(lastReminderLate.getTime() + 5 * 3_600_000));
    expect(stillTooSoon!.shouldRemind).toBe(false);
    const nowDue = await getCurrentProposal(userId, new Date(lastReminderLate.getTime() + 13 * 3_600_000));
    expect(nowDue!.shouldRemind).toBe(true);
  });

  it("applique automatiquement la proposition au plafond de rappels (BUDGET_PROPOSAL_REMINDER_CAP=10), sans la modifier", async () => {
    const { body } = await registerFreshUser();
    const userId = body.user.id;
    await insertPlannerEvent(userId, { title: "Revenu du mois", eventDate: `${SOURCE_MONTH}-01`, type: "revenu", category: "Salaire", amount: 300000 });
    await insertPlannerEvent(userId, { title: "Loyer mensuel", eventDate: `${SOURCE_MONTH}-05`, type: "depense", category: "Logement", amount: 70000 });
    await insertPlannerEvent(userId, { title: "Électricité", eventDate: `${SOURCE_MONTH}-10`, type: "depense", category: "Logement", amount: 10000 });
    const generated = await getCurrentProposal(userId, NOW_GENERATION);
    const id = generated!.proposal.id;

    await backdateProposal(id, { reminderCount: 9 });
    const result = await recordReminderShown(userId, id, new Date(NOW_GENERATION.getTime() + 999 * 3_600_000));
    expect(result.autoApplied).toBe(true);
    expect(result.proposal.status).toBe("auto_applied");
    expect(result.proposal.decided_at).not.toBeNull();
    expect(result.applySummary).toMatchObject({ totalItems: 3, createdEvents: 3, eventErrors: [], budgetsDone: 1, budgetErrors: [] });

    const { rows: events } = await pool.query(`SELECT * FROM planner_events WHERE user_id = $1 AND event_date >= '2026-11-01'`, [userId]);
    expect(events).toHaveLength(3);
    const { rows: budgetRows } = await pool.query(`SELECT * FROM budgets WHERE user_id = $1 AND category = 'Logement'`, [userId]);
    expect(Number(budgetRows[0].monthly_limit)).toBe(80000); // 70000 + 10000

    // Une fois auto-appliquée, plus aucun rappel ne doit être proposé (on
    // reste dans le même mois source pour continuer à interroger la
    // proposition de novembre, pas une proposition d'un mois encore plus loin).
    const after = await getCurrentProposal(userId, new Date(NOW_GENERATION.getTime() + 100 * 3_600_000));
    expect(after!.shouldRemind).toBe(false);
  });

  it("un rappel qui n'atteint pas encore le plafond n'applique rien", async () => {
    const { body } = await registerFreshUser();
    const userId = body.user.id;
    await insertPlannerEvent(userId, { title: "Loyer", eventDate: `${SOURCE_MONTH}-05`, type: "depense", category: "Logement", amount: 50000 });
    const generated = await getCurrentProposal(userId, NOW_GENERATION);
    const id = generated!.proposal.id;

    const result = await recordReminderShown(userId, id, NOW_GENERATION);
    expect(result.autoApplied).toBe(false);
    expect(result.proposal.reminder_count).toBe(1);
    expect(result.proposal.status).toBe("pending");
    // On ne compte que les événements du mois cible (novembre) : l'événement
    // d'octobre inséré comme fixture source reste, lui, bien présent.
    const { rows: events } = await pool.query(`SELECT * FROM planner_events WHERE user_id = $1 AND event_date >= '2026-11-01'`, [userId]);
    expect(events).toHaveLength(0); // rien créé tant que ce n'est ni validé ni au plafond
  });

  it("'dismissed' est définitif : ignorer ce mois ne déclenche jamais d'application automatique", async () => {
    const { body } = await registerFreshUser();
    const userId = body.user.id;
    await insertPlannerEvent(userId, { title: "Loyer", eventDate: `${SOURCE_MONTH}-05`, type: "depense", category: "Logement", amount: 50000 });
    const generated = await getCurrentProposal(userId, NOW_GENERATION);
    const id = generated!.proposal.id;

    const dismissed = await decideProposal(userId, id, "dismissed", NOW_GENERATION);
    expect(dismissed.status).toBe("dismissed");
    expect(dismissed.decided_at).not.toBeNull();

    // Idempotent : redécider ne change rien et ne lève pas d'erreur. On reste
    // dans le mois source (octobre) pour continuer à viser la même
    // proposition cible (novembre) à chaque relecture.
    const again = await decideProposal(userId, id, "validated", new Date(NOW_GENERATION.getTime() + 24 * 3_600_000));
    expect(again.status).toBe("dismissed");

    const after = await getCurrentProposal(userId, new Date(NOW_GENERATION.getTime() + 100 * 3_600_000));
    expect(after!.shouldRemind).toBe(false);
    const { rows: events } = await pool.query(`SELECT * FROM planner_events WHERE user_id = $1 AND event_date >= '2026-11-01'`, [userId]);
    expect(events).toHaveLength(0);
  });

  it("'validated' clôt la proposition sans rien écrire côté serveur (les écritures passent par le wizard front-end)", async () => {
    const { body } = await registerFreshUser();
    const userId = body.user.id;
    await insertPlannerEvent(userId, { title: "Loyer", eventDate: `${SOURCE_MONTH}-05`, type: "depense", category: "Logement", amount: 50000 });
    const generated = await getCurrentProposal(userId, NOW_GENERATION);
    const id = generated!.proposal.id;

    const validated = await decideProposal(userId, id, "validated", NOW_GENERATION);
    expect(validated.status).toBe("validated");
    const { rows: events } = await pool.query(`SELECT * FROM planner_events WHERE user_id = $1 AND event_date >= '2026-11-01'`, [userId]);
    expect(events).toHaveLength(0);
  });

  it("isolation stricte entre utilisateurs : les événements de l'un n'apparaissent jamais dans la proposition de l'autre", async () => {
    const userA = await registerFreshUser();
    const userB = await registerFreshUser();
    await insertPlannerEvent(userA.body.user.id, { title: "Loyer A", eventDate: `${SOURCE_MONTH}-05`, type: "depense", category: "Logement", amount: 10000 });
    // userB n'a aucun événement planner ce mois-ci.

    const resultA = await getCurrentProposal(userA.body.user.id, NOW_GENERATION);
    const resultB = await getCurrentProposal(userB.body.user.id, NOW_GENERATION);
    expect(resultA).not.toBeNull();
    expect(resultB).toBeNull();
  });

  it("recordReminderShown et decideProposal renvoient une 404 propre pour une proposition d'un autre utilisateur", async () => {
    const userA = await registerFreshUser();
    const userB = await registerFreshUser();
    await insertPlannerEvent(userA.body.user.id, { title: "Loyer A", eventDate: `${SOURCE_MONTH}-05`, type: "depense", category: "Logement", amount: 10000 });
    const generated = await getCurrentProposal(userA.body.user.id, NOW_GENERATION);
    const id = generated!.proposal.id;

    await expect(recordReminderShown(userB.body.user.id, id, NOW_GENERATION)).rejects.toMatchObject({ code: "BUDGET_PROPOSAL_NOT_FOUND" });
    await expect(decideProposal(userB.body.user.id, id, "dismissed", NOW_GENERATION)).rejects.toMatchObject({ code: "BUDGET_PROPOSAL_NOT_FOUND" });
  });
});

describe("Proposition automatique de budget mensuel — HTTP (/api/budget-proposals/*)", () => {
  it("refuse sans jeton d'authentification", async () => {
    await request(app).get("/api/budget-proposals/current").expect(401);
  });

  it("renvoie `current: null` pour un compte neuf sans événement planner (déterministe quelle que soit la date réelle d'exécution)", async () => {
    const { body } = await registerFreshUser();
    const res = await request(app)
      .get("/api/budget-proposals/current")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .expect(200);
    expect(res.body).toEqual({ current: null });
  });

  it("404 sur reminder-shown / decide pour un identifiant inexistant", async () => {
    const { body } = await registerFreshUser();
    await request(app)
      .post("/api/budget-proposals/00000000-0000-0000-0000-000000000000/reminder-shown")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .expect(404);
    await request(app)
      .post("/api/budget-proposals/00000000-0000-0000-0000-000000000000/decide")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .send({ status: "dismissed" })
      .expect(404);
  });

  it("400 sur decide avec un statut invalide", async () => {
    const { body } = await registerFreshUser();
    const res = await request(app)
      .post("/api/budget-proposals/00000000-0000-0000-0000-000000000000/decide")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .send({ status: "autre_chose" })
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
