import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, resetDb, registerFreshUser } from "./helpers.js";
import { suggestArchetype, PROJECT_ARCHETYPES } from "../src/lib/projectArchetypes.js";

/**
 * Reconnaissance d'un archétype de projet, et économie d'un projet d'activité
 * (migrations/038_projet_nature_et_marge.sql).
 *
 * Décision de Yannis : pas de menu « nature du projet ». POOSSER reconnaît
 * depuis le nom et PROPOSE une nature et des rubriques ; l'utilisateur valide
 * ou ignore. Rien n'est créé par la reconnaissance elle-même.
 *
 * Ce que ces tests verrouillent :
 *   - ses trois projets réels sont correctement reconnus ;
 *   - un nom qui n'évoque rien ne déclenche AUCUNE proposition — une
 *     suggestion à côté de la plaque coûte plus cher qu'une absence ;
 *   - la reconnaissance ne crée rien par elle-même ;
 *   - les frais d'approche, la quantité produite et le prix de vente se
 *     stockent et s'effacent ;
 *   - isolation entre utilisateurs.
 */

beforeEach(resetDb);

const auth = (access: string) => ({ Authorization: `Bearer ${access}` });

async function authedUser() {
  const { body } = await registerFreshUser();
  return { access: body.accessToken as string };
}

const suggestion = (access: string, name: string) =>
  request(app).get("/api/project-archetype").query({ name }).set(auth(access));

async function createProject(access: string, body: Record<string, unknown>) {
  const res = await request(app).post("/api/projects").set(auth(access)).send(body).expect(201);
  return res.body.project as {
    id: string; name: string; kind: string | null;
    quantity_produced: string | null; unit_price: string | null;
    sale_currency: string; exchange_rate: string | null;
  };
}

describe("reconnaissance depuis le nom", () => {
  it("reconnaît les trois projets réels de Yannis", () => {
    expect(suggestArchetype("Construction de la dépendance")?.code).toBe("chantier");
    expect(suggestArchetype("Pates d'arachide Belgique")?.code).toBe("production");
    expect(suggestArchetype("Boutique de vente - produits IT")?.code).toBe("commerce");
  });

  it("donne la bonne nature : un chantier dépense, une production vend", () => {
    expect(suggestArchetype("Construction de la dépendance")?.kind).toBe("depense");
    expect(suggestArchetype("Pates d'arachide Belgique")?.kind).toBe("activite");
  });

  it("marque comme frais d'approche ce qui amène la marchandise à destination", () => {
    const s = suggestArchetype("Pates d'arachide Belgique")!;
    const frais = s.rubriques.filter((r) => r.isLandedCost).map((r) => r.name);
    expect(frais).toContain("Transport");
    expect(frais).toContain("Emballage");
    // La matière première est un coût d'achat, pas un frais d'approche.
    expect(frais).not.toContain("Matière première");
  });

  it("ignore les accents et la casse", () => {
    expect(suggestArchetype("ÉLEVAGE de poulets")?.code).toBe("elevage");
    expect(suggestArchetype("elevage de poulets")?.code).toBe("elevage");
    expect(suggestArchetype("Dépendance familiale")?.code).toBe("chantier");
  });

  it("ne propose rien plutôt que n'importe quoi", () => {
    expect(suggestArchetype("Projet X")).toBeNull();
    expect(suggestArchetype("")).toBeNull();
    expect(suggestArchetype("   ")).toBeNull();
    expect(suggestArchetype("zzzz")).toBeNull();
  });

  it("tranche par le mot déclencheur le plus long quand plusieurs collent", () => {
    // « construction » (12) l'emporte sur « dependance » (10).
    const s = suggestArchetype("Construction de la dépendance")!;
    expect(s.matchedOn).toBe("construction");
  });

  it("n'expose que des archétypes cohérents", () => {
    for (const a of PROJECT_ARCHETYPES) {
      expect(a.rubriques.length).toBeGreaterThan(2);
      expect(a.keywords.length).toBeGreaterThan(0);
      // Les mots déclencheurs sont déjà normalisés : sans accent, en minuscules.
      for (const k of a.keywords) expect(k).toBe(k.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""));
      // Un frais d'approche annoncé doit exister dans la liste des rubriques.
      for (const f of a.landedCost ?? []) expect(a.rubriques).toContain(f);
    }
  });
});

describe("la route de proposition", () => {
  it("propose sans rien créer", async () => {
    const { access } = await authedUser();
    const res = await suggestion(access, "Construction de la dépendance").expect(200);
    expect(res.body.suggestion.code).toBe("chantier");
    expect(res.body.suggestion.rubriques.length).toBeGreaterThan(2);

    // Aucun projet, aucune rubrique n'a été créé au passage.
    const projets = await request(app).get("/api/projects").set(auth(access)).expect(200);
    expect(projets.body.projects).toHaveLength(0);
  });

  it("renvoie null quand rien ne correspond", async () => {
    const { access } = await authedUser();
    const res = await suggestion(access, "zzzz").expect(200);
    expect(res.body.suggestion).toBeNull();
  });

  it("exige d'être connecté", async () => {
    await request(app).get("/api/project-archetype").query({ name: "chantier" }).expect(401);
  });
});

describe("économie d'un projet", () => {
  it("enregistre quantité, prix de vente et devise", async () => {
    const { access } = await authedUser();
    const p = await createProject(access, {
      name: "Pates d'arachide Belgique", kind: "activite",
      quantityProduced: 500, unitPrice: 4.5, saleCurrency: "EUR",
    });
    expect(p.kind).toBe("activite");
    expect(Number(p.quantity_produced)).toBe(500);
    expect(Number(p.unit_price)).toBe(4.5);
    expect(p.sale_currency).toBe("EUR");
    // Pas de taux : la parité fixe s'applique.
    expect(p.exchange_rate).toBeNull();
  });

  it("accepte un taux qui s'écarte de la parité (changeur informel)", async () => {
    const { access } = await authedUser();
    const p = await createProject(access, { name: "Export", saleCurrency: "EUR", exchangeRate: 640 });
    expect(Number(p.exchange_rate)).toBe(640);
  });

  it("laisse effacer une quantité saisie par erreur", async () => {
    const { access } = await authedUser();
    const p = await createProject(access, { name: "Lot", quantityProduced: 500 });
    const res = await request(app)
      .patch(`/api/projects/${p.id}`)
      .set(auth(access))
      .send({ quantityProduced: null })
      .expect(200);
    expect(res.body.project.quantity_produced).toBeNull();
  });

  it("ne touche pas aux champs absents du corps", async () => {
    const { access } = await authedUser();
    const p = await createProject(access, { name: "Lot", quantityProduced: 500, unitPrice: 4.5, kind: "activite" });
    const res = await request(app)
      .patch(`/api/projects/${p.id}`)
      .set(auth(access))
      .send({ name: "Lot 2" })
      .expect(200);
    expect(Number(res.body.project.quantity_produced)).toBe(500);
    expect(Number(res.body.project.unit_price)).toBe(4.5);
    expect(res.body.project.kind).toBe("activite");
  });

  it("refuse une quantité ou un prix négatif", async () => {
    const { access } = await authedUser();
    await request(app).post("/api/projects").set(auth(access)).send({ name: "X", quantityProduced: -1 }).expect(400);
    await request(app).post("/api/projects").set(auth(access)).send({ name: "X", unitPrice: 0 }).expect(400);
  });

  it("refuse une devise de vente inconnue", async () => {
    const { access } = await authedUser();
    await request(app).post("/api/projects").set(auth(access)).send({ name: "X", saleCurrency: "BTC" }).expect(400);
  });

  it("laisse effacer le prix de vente et le taux", async () => {
    const { access } = await authedUser();
    const p = await createProject(access, { name: "Lot", unitPrice: 4.5, saleCurrency: "EUR", exchangeRate: 640 });
    const res = await request(app)
      .patch(`/api/projects/${p.id}`)
      .set(auth(access))
      .send({ unitPrice: null, exchangeRate: null })
      .expect(200);
    expect(res.body.project.unit_price).toBeNull();
    // Taux effacé = on retombe sur la parité fixe appliquée par le client.
    expect(res.body.project.exchange_rate).toBeNull();
    expect(res.body.project.sale_currency).toBe("EUR");
  });

  it("laisse revenir à la nature déduite — une détection acceptée par erreur se défait", async () => {
    const { access } = await authedUser();
    const p = await createProject(access, { name: "Construction de la dépendance", kind: "depense" });
    expect(p.kind).toBe("depense");
    const res = await request(app)
      .patch(`/api/projects/${p.id}`)
      .set(auth(access))
      .send({ kind: null })
      .expect(200);
    expect(res.body.project.kind).toBeNull();
  });
});

describe("frais d'approche sur une rubrique", () => {
  async function projetAvecRubrique(access: string, isLandedCost?: boolean) {
    const p = await createProject(access, { name: "Pates d'arachide Belgique" });
    const res = await request(app)
      .post(`/api/projects/${p.id}/rubriques`)
      .set(auth(access))
      .send({ name: "Transport", ...(isLandedCost === undefined ? {} : { isLandedCost }) })
      .expect(201);
    return { p, r: res.body.rubrique as { id: string; is_landed_cost: boolean } };
  }

  it("vaut faux par défaut", async () => {
    const { access } = await authedUser();
    const { r } = await projetAvecRubrique(access);
    expect(r.is_landed_cost).toBe(false);
  });

  it("se pose à la création", async () => {
    const { access } = await authedUser();
    const { r } = await projetAvecRubrique(access, true);
    expect(r.is_landed_cost).toBe(true);
  });

  it("se retire ensuite — une erreur de marquage doit pouvoir se défaire", async () => {
    const { access } = await authedUser();
    const { p, r } = await projetAvecRubrique(access, true);
    const res = await request(app)
      .patch(`/api/projects/${p.id}/rubriques/${r.id}`)
      .set(auth(access))
      .send({ isLandedCost: false })
      .expect(200);
    expect(res.body.rubrique.is_landed_cost).toBe(false);
  });
});

describe("isolation entre utilisateurs", () => {
  it("ne laisse pas modifier l'économie du projet d'un autre", async () => {
    const a = await authedUser();
    const b = await authedUser();
    const p = await createProject(a.access, { name: "Lot" });
    await request(app)
      .patch(`/api/projects/${p.id}`)
      .set(auth(b.access))
      .send({ quantityProduced: 999 })
      .expect(404);
  });
});
