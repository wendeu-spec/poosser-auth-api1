import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, resetDb, registerFreshUser } from "./helpers.js";

/**
 * Caisse de secours de tontine (migrations/035_tontine_caisse.sql).
 *
 * Le défaut corrigé : la caisse de solidarité et les pénalités partaient en
 * dépense sèche et disparaissaient. L'utilisateur ne savait ni ce que la
 * caisse du groupe détenait, ni ce qu'il y avait versé depuis le début.
 *
 * Ce que ces tests verrouillent :
 *   - la caisse est un COMPTE, créé paresseusement au premier besoin, exclu
 *     du disponible comme la cagnotte ;
 *   - la cotisation sociale est un VIREMENT vers la caisse, plus une dépense ;
 *   - la caisse ne mélange jamais son argent avec la cagnotte, qui doit
 *     continuer de retomber à zéro en fin de cycle — y compris en mode
 *     collecteur, où la solidarité des autres allait auparavant gonfler la
 *     cagnotte sans jamais en ressortir ;
 *   - un secours ne sort QUE vers un membre du groupe ;
 *   - un secours ne peut pas dépasser ce que la caisse détient ;
 *   - annuler un mouvement défait exactement l'argent qu'il avait créé ;
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

async function balanceOf(access: string, accountId: string) {
  const a = (await listAccounts(access)).find((x) => x.id === accountId);
  return a ? Number(a.balance) : null;
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
  caisseAccountId: string | null; caisseBalance: number; caisseContributed: number;
  secoursMotifs: string[];
  members: Array<{ id: string; name: string; position: number }>;
};

async function createTontine(access: string, body: Record<string, unknown>) {
  const res = await request(app)
    .post("/api/tontines")
    .set(auth(access))
    .send({ name: "COEUR JOYEUX", contributionAmount: 50_000, frequency: "mensuelle", members: ["Awa", "Bello", "Moi"], ...body })
    .expect(201);
  return res.body.tontine as Tontine;
}

async function getTontine(access: string, id: string) {
  const res = await request(app).get(`/api/tontines/${id}`).set(auth(access)).expect(200);
  return res.body.tontine as Tontine;
}

const mark = (access: string, id: string, body: Record<string, unknown>) =>
  request(app).post(`/api/tontines/${id}/contributions`).set(auth(access)).send(body);

const verser = (access: string, id: string, body: Record<string, unknown>) =>
  request(app).post(`/api/tontines/${id}/caisse/versements`).set(auth(access)).send(body);

const secours = (access: string, id: string, body: Record<string, unknown>) =>
  request(app).post(`/api/tontines/${id}/caisse/secours`).set(auth(access)).send(body);

const journal = (access: string, id: string) =>
  request(app).get(`/api/tontines/${id}/caisse`).set(auth(access));

async function transactionsOf(access: string) {
  const res = await request(app).get("/api/transactions").set(auth(access)).expect(200);
  return res.body.transactions as Array<{ id: string; type: string; category: string; amount: string; account_id: string }>;
}

describe("la caisse est un compte, créé au premier besoin", () => {
  it("n'existe pas tant que le groupe n'a ni solidarité ni versement", async () => {
    const { access } = await authedUser();
    const t = await createTontine(access, { myMemberPosition: 3 });
    expect(t.caisseAccountId).toBeNull();
    expect(t.caisseBalance).toBe(0);
    // Pas de compte vide qui encombre la page Comptes.
    expect((await listAccounts(access)).filter((a) => a.type === "caisse")).toHaveLength(0);
  });

  it("naît à la première cotisation sociale, et porte le nom du groupe", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 500_000);
    const t = await createTontine(access, { myMemberPosition: 3, solidarityAmount: 2_000 });

    await mark(access, t.id, { memberId: t.members[2]!.id, paid: true, accountId: especes.id, occurredOn: "2026-11-05" }).expect(200);

    const after = await getTontine(access, t.id);
    expect(after.caisseAccountId).toBeTruthy();
    const caisse = (await listAccounts(access)).find((a) => a.id === after.caisseAccountId)!;
    expect(caisse.type).toBe("caisse");
    expect(caisse.name).toBe("Caisse COEUR JOYEUX");
    expect(Number(caisse.balance)).toBe(2_000);
  });

  it("est exclue du disponible, comme la cagnotte", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 500_000);
    const t = await createTontine(access, { myMemberPosition: 3, solidarityAmount: 2_000 });
    await mark(access, t.id, { memberId: t.members[2]!.id, paid: true, accountId: especes.id, occurredOn: "2026-11-05" }).expect(200);

    const accounts = await listAccounts(access);
    const disponible = accounts
      .filter((a) => a.type !== "tontine" && a.type !== "caisse")
      .reduce((s, a) => s + Number(a.balance), 0);
    // 500 000 − 50 000 de cotisation − 2 000 de caisse.
    expect(disponible).toBe(448_000);
  });

  it("refuse la caisse comme compte payeur d'une cotisation", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 500_000);
    const t = await createTontine(access, { myMemberPosition: 3, solidarityAmount: 2_000 });
    await mark(access, t.id, { memberId: t.members[2]!.id, paid: true, accountId: especes.id, occurredOn: "2026-11-05" }).expect(200);
    const after = await getTontine(access, t.id);

    await mark(access, t.id, { memberId: t.members[0]!.id, paid: true }).expect(200);
    const res = await request(app)
      .post(`/api/tontines/${t.id}/caisse/versements`)
      .set(auth(access))
      .send({ amount: 1_000, accountId: after.caisseAccountId })
      .expect(409);
    expect(res.body.error.code).toBe("TONTINE_ACCOUNT_NOT_USABLE");
  });
});

describe("la cotisation sociale est un virement, plus une dépense", () => {
  it("trace l'argent dans la caisse au lieu de le faire disparaître", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 500_000);
    const t = await createTontine(access, { myMemberPosition: 3, solidarityAmount: 2_000, lateFee: 1_000 });

    await mark(access, t.id, { memberId: t.members[2]!.id, paid: true, accountId: especes.id, late: true, occurredOn: "2026-11-05" }).expect(200);

    const after = await getTontine(access, t.id);
    expect(after.caisseBalance).toBe(3_000); // 2 000 de caisse + 1 000 de pénalité
    expect(after.caisseContributed).toBe(3_000);
    expect(await balanceOf(access, especes.id)).toBe(447_000);

    // Plus aucune dépense « Tontine » : l'argent est dans un compte.
    const depenses = (await transactionsOf(access)).filter((x) => x.type === "depense" && x.category === "Tontine");
    expect(depenses).toHaveLength(0);
  });

  it("décocher la cotisation vide la caisse de ce qu'elle avait reçu", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 500_000);
    const t = await createTontine(access, { myMemberPosition: 3, solidarityAmount: 2_000 });
    const me = t.members[2]!.id;

    await mark(access, t.id, { memberId: me, paid: true, accountId: especes.id, occurredOn: "2026-11-05" }).expect(200);
    await mark(access, t.id, { memberId: me, paid: false }).expect(200);

    const after = await getTontine(access, t.id);
    expect(after.caisseBalance).toBe(0);
    expect(after.caisseContributed).toBe(0);
    expect(await balanceOf(access, especes.id)).toBe(500_000);
  });
});

describe("la caisse ne se mélange jamais à la cagnotte", () => {
  it("en mode collecteur, la solidarité des autres va dans la caisse, pas dans la cagnotte", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 500_000);
    const t = await createTontine(access, { myMemberPosition: 3, role: "collecteur", solidarityAmount: 2_000 });

    await mark(access, t.id, { memberId: t.members[0]!.id, paid: true, occurredOn: "2026-11-05" }).expect(200);

    const after = await getTontine(access, t.id);
    // La cagnotte ne reçoit QUE la cotisation.
    expect(await balanceOf(access, t.accountId!)).toBe(50_000);
    expect(after.caisseBalance).toBe(2_000);
    // Ce n'est pas mon argent : il ne compte pas dans ce que j'ai versé.
    expect(after.caisseContributed).toBe(0);
  });

  it("CYCLE COMPLET : la cagnotte retombe à zéro même avec une caisse", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 1_000_000);
    const t = await createTontine(access, { myMemberPosition: 3, role: "collecteur", solidarityAmount: 2_000 });
    const [awa, bello, moi] = t.members;

    for (let tour = 1; tour <= 3; tour++) {
      await mark(access, t.id, { memberId: awa!.id, paid: true, occurredOn: "2026-11-05" }).expect(200);
      await mark(access, t.id, { memberId: bello!.id, paid: true, occurredOn: "2026-11-05" }).expect(200);
      await mark(access, t.id, { memberId: moi!.id, paid: true, accountId: especes.id, occurredOn: "2026-11-05" }).expect(200);
      const beneficiaire = t.members[(tour - 1) % 3]!;
      const body = beneficiaire.id === moi!.id ? { accountId: especes.id, occurredOn: "2026-11-06" } : {};
      await request(app).post(`/api/tontines/${t.id}/close-round`).set(auth(access)).send(body).expect(200);
    }

    // C'est la vérification qui prouve que le modèle est juste : avant la
    // migration 035, la solidarité des autres entrait dans la cagnotte et
    // n'en ressortait jamais — elle finissait à +12 000 au lieu de 0.
    expect(await balanceOf(access, t.accountId!)).toBe(0);

    const after = await getTontine(access, t.id);
    // Depuis la migration 036, la caisse ne se verse qu'au PREMIER tour de
    // chaque cycle : 3 membres = un cycle de 3 tours, donc une seule série de
    // cotisations sociales sur les trois tours joués.
    expect(after.caisseBalance).toBe(6_000); // 3 membres × 2 000, au tour 1
    expect(after.caisseContributed).toBe(2_000); // ma seule cotisation sociale
  });
});

describe("versements libres", () => {
  it("verse depuis le compte choisi, avec un motif", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 500_000);
    const t = await createTontine(access, { myMemberPosition: 3 });

    await verser(access, t.id, { amount: 25_000, motif: "Maladie", accountId: especes.id, occurredOn: "2026-11-10" }).expect(201);

    const after = await getTontine(access, t.id);
    expect(after.caisseBalance).toBe(25_000);
    expect(after.caisseContributed).toBe(25_000);
    expect(await balanceOf(access, especes.id)).toBe(475_000);

    const j = await journal(access, t.id).expect(200);
    expect(j.body.caisseMovements).toHaveLength(1);
    expect(j.body.caisseMovements[0].kind).toBe("versement");
    expect(j.body.caisseMovements[0].motif).toBe("Maladie");
  });

  it("refuse un versement sur un groupe non configuré", async () => {
    const { access } = await authedUser();
    const t = await createTontine(access, {}); // personne n'est désigné
    const res = await verser(access, t.id, { amount: 5_000 }).expect(409);
    expect(res.body.error.code).toBe("TONTINE_NOT_CONFIGURED");
  });

  it("un participant ne peut pas saisir le versement d'un autre membre", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 100_000);
    const t = await createTontine(access, { myMemberPosition: 3 });
    const res = await verser(access, t.id, { amount: 5_000, memberId: t.members[0]!.id }).expect(409);
    expect(res.body.error.code).toBe("TONTINE_NOT_COLLECTOR");
  });

  it("un collecteur encaisse le versement d'un autre sans toucher ses comptes", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 100_000);
    const t = await createTontine(access, { myMemberPosition: 3, role: "collecteur" });

    await verser(access, t.id, { amount: 8_000, memberId: t.members[0]!.id, motif: "Deuil", occurredOn: "2026-11-10" }).expect(201);

    const after = await getTontine(access, t.id);
    expect(after.caisseBalance).toBe(8_000);
    expect(after.caisseContributed).toBe(0);
    expect(await balanceOf(access, especes.id)).toBe(100_000);
  });
});

describe("secours", () => {
  async function groupeAvecCaisse(access: string, extra: Record<string, unknown> = {}) {
    const especes = await especesOf(access);
    await fund(access, especes.id, 500_000);
    const t = await createTontine(access, { myMemberPosition: 3, ...extra });
    await verser(access, t.id, { amount: 60_000, motif: "Autre", accountId: especes.id, occurredOn: "2026-11-01" }).expect(201);
    return { t, especes };
  }

  it("verse à l'utilisateur sur le compte qu'il choisit", async () => {
    const { access } = await authedUser();
    const { t, especes } = await groupeAvecCaisse(access);

    await secours(access, t.id, {
      amount: 40_000, memberId: t.members[2]!.id, motif: "Maladie", accountId: especes.id, occurredOn: "2026-11-12",
    }).expect(201);

    const after = await getTontine(access, t.id);
    expect(after.caisseBalance).toBe(20_000);
    // 500 000 − 60 000 versés + 40 000 reçus.
    expect(await balanceOf(access, especes.id)).toBe(480_000);
    // Un secours reçu n'est pas un revenu du mois : c'est l'entraide du groupe.
    const revenus = (await transactionsOf(access)).filter((x) => x.type === "revenu" && x.category === "Tontine");
    expect(revenus).toHaveLength(0);
  });

  it("refuse un bénéficiaire qui n'est pas membre du groupe", async () => {
    const a = await authedUser();
    const b = await authedUser();
    const { t } = await groupeAvecCaisse(a.access);
    const autreGroupe = await createTontine(b.access, { myMemberPosition: 1, name: "AUTRE" });

    const res = await secours(a.access, t.id, {
      amount: 1_000, memberId: autreGroupe.members[0]!.id, motif: "Maladie",
    }).expect(404);
    expect(res.body.error.code).toBe("TONTINE_MEMBER_NOT_FOUND");
  });

  it("exige un bénéficiaire et un motif", async () => {
    const { access } = await authedUser();
    const { t } = await groupeAvecCaisse(access);
    await secours(access, t.id, { amount: 1_000 }).expect(400);
    await secours(access, t.id, { amount: 1_000, memberId: t.members[2]!.id }).expect(400);
  });

  it("refuse un secours supérieur à ce que la caisse détient, et dit combien est possible", async () => {
    const { access } = await authedUser();
    const { t, especes } = await groupeAvecCaisse(access);

    const res = await secours(access, t.id, {
      amount: 90_000, memberId: t.members[2]!.id, motif: "Maladie", accountId: especes.id,
    }).expect(409);
    expect(res.body.error.code).toBe("CAISSE_INSUFFICIENT");
    expect(Number(res.body.error.details.available)).toBe(60_000);

    // Rien n'a bougé.
    expect((await getTontine(access, t.id)).caisseBalance).toBe(60_000);
    expect(await balanceOf(access, especes.id)).toBe(440_000);
  });

  it("refuse tout secours quand la caisse n'existe pas encore", async () => {
    const { access } = await authedUser();
    const t = await createTontine(access, { myMemberPosition: 3 });
    const res = await secours(access, t.id, { amount: 1_000, memberId: t.members[2]!.id, motif: "Maladie" }).expect(409);
    expect(res.body.error.code).toBe("CAISSE_INSUFFICIENT");
  });

  it("un participant ne verse pas de secours à un autre membre", async () => {
    const { access } = await authedUser();
    const { t } = await groupeAvecCaisse(access);
    const res = await secours(access, t.id, { amount: 1_000, memberId: t.members[0]!.id, motif: "Deuil" }).expect(409);
    expect(res.body.error.code).toBe("TONTINE_NOT_COLLECTOR");
  });

  it("un collecteur sort l'argent de la caisse sans toucher ses comptes", async () => {
    const { access } = await authedUser();
    const { t, especes } = await groupeAvecCaisse(access, { role: "collecteur" });
    const avant = await balanceOf(access, especes.id);

    await secours(access, t.id, { amount: 15_000, memberId: t.members[0]!.id, motif: "Deuil", occurredOn: "2026-11-12" }).expect(201);

    expect((await getTontine(access, t.id)).caisseBalance).toBe(45_000);
    expect(await balanceOf(access, especes.id)).toBe(avant);
  });
});

describe("annulation d'un mouvement", () => {
  it("défait exactement l'argent créé", async () => {
    const { access } = await authedUser();
    const especes = await especesOf(access);
    await fund(access, especes.id, 200_000);
    const t = await createTontine(access, { myMemberPosition: 3 });
    await verser(access, t.id, { amount: 30_000, motif: "Autre", accountId: especes.id, occurredOn: "2026-11-01" }).expect(201);

    const j = await journal(access, t.id).expect(200);
    const mvId = j.body.caisseMovements[0].id as string;

    const res = await request(app).delete(`/api/tontines/${t.id}/caisse/${mvId}`).set(auth(access)).expect(200);
    expect(res.body.tontine.caisseBalance).toBe(0);
    expect(await balanceOf(access, especes.id)).toBe(200_000);
    expect((await journal(access, t.id)).body.caisseMovements).toHaveLength(0);
  });

  it("refuse un mouvement qui n'existe pas", async () => {
    const { access } = await authedUser();
    const t = await createTontine(access, { myMemberPosition: 3 });
    await request(app)
      .delete(`/api/tontines/${t.id}/caisse/11111111-1111-4111-8111-111111111111`)
      .set(auth(access))
      .expect(404);
  });
});

describe("motifs de secours", () => {
  it("applique la liste par défaut quand le groupe n'en définit pas", async () => {
    const { access } = await authedUser();
    const t = await createTontine(access, { myMemberPosition: 3 });
    expect(t.secoursMotifs).toContain("Décès");
    expect(t.secoursMotifs).toContain("Maladie");
    expect(t.secoursMotifs).toContain("Scolarité");
  });

  it("accepte une liste propre au groupe, modifiable ensuite", async () => {
    const { access } = await authedUser();
    const t = await createTontine(access, { myMemberPosition: 3, secoursMotifs: ["Deuil", "Hôpital"] });
    expect(t.secoursMotifs).toEqual(["Deuil", "Hôpital"]);

    const res = await request(app)
      .patch(`/api/tontines/${t.id}`)
      .set(auth(access))
      .send({ secoursMotifs: ["Deuil", "Hôpital", "Rentrée"] })
      .expect(200);
    expect(res.body.tontine.secoursMotifs).toEqual(["Deuil", "Hôpital", "Rentrée"]);
  });
});

describe("isolation entre utilisateurs", () => {
  it("ne laisse pas verser dans la caisse d'un autre", async () => {
    const a = await authedUser();
    const b = await authedUser();
    const t = await createTontine(a.access, { myMemberPosition: 3 });
    const res = await verser(b.access, t.id, { amount: 1_000 }).expect(404);
    expect(res.body.error.code).toBe("TONTINE_NOT_FOUND");
  });

  it("ne laisse pas lire le journal d'un autre", async () => {
    const a = await authedUser();
    const b = await authedUser();
    const t = await createTontine(a.access, { myMemberPosition: 3 });
    await journal(b.access, t.id).expect(404);
  });
});
