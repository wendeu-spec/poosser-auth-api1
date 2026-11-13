import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { parseMobileMoneySms } from "../src/lib/smsParser.js";
import { app, resetDb, registerFreshUser } from "./helpers.js";

/**
 * Messages inspirés des confirmations MTN MoMo et Orange Money (Cameroun),
 * en français et en anglais. Les formulations exactes changent souvent :
 * le parseur lit des mots-clés, et ces tests vérifient surtout qu'il ne
 * confond jamais montant, frais et nouveau solde.
 */

describe("Lecture des SMS Mobile Money", () => {
  it("MTN, réception en français : montant, date, expéditeur, référence, solde", () => {
    const p = parseMobileMoneySms(
      "Vous avez reçu 25 000 FCFA de JEAN DUPONT (237670000000) le 2026-11-10 14:22:05. Votre nouveau solde est: 312 000 FCFA. ID de la transaction: 8456123390. MTN MoMo",
    );
    expect(p.operator).toBe("mtn");
    expect(p.kind).toBe("reception");
    expect(p.direction).toBe("revenu");
    expect(p.amount).toBe(25000);
    expect(p.fee).toBeNull();
    expect(p.balanceAfter).toBe(312000);
    expect(p.date).toBe("2026-11-10");
    expect(p.counterparty).toBe("JEAN DUPONT");
    expect(p.reference).toBe("8456123390");
    expect(p.missing).toEqual([]);
  });

  it("MTN, transfert envoyé avec frais : le montant n'est jamais confondu avec les frais ni le solde", () => {
    const p = parseMobileMoneySms(
      "Vous avez transféré 10000 FCFA à MARIE NGO (237680000000) le 09/11/2026 08:15. Frais: 100 FCFA. Nouveau solde: 202000 FCFA. ID: 8456120001.",
    );
    expect(p.kind).toBe("envoi");
    expect(p.direction).toBe("depense");
    expect(p.amount).toBe(10000);
    expect(p.fee).toBe(100);
    expect(p.balanceAfter).toBe(202000);
    expect(p.date).toBe("2026-11-09");
    expect(p.counterparty).toBe("MARIE NGO");
  });

  it("MTN en anglais : « You have received ... from ... »", () => {
    const p = parseMobileMoneySms(
      "You have received 15,000 FCFA from PAUL ETOA (237677000000) on 2026-11-08 10:01:12. New balance: 90,500 FCFA. Financial Transaction Id: 7744112233.",
    );
    expect(p.kind).toBe("reception");
    expect(p.amount).toBe(15000);
    expect(p.balanceAfter).toBe(90500);
    expect(p.counterparty).toBe("PAUL ETOA");
    expect(p.reference).toBe("7744112233");
  });

  it("Orange Money, transfert « vers » un numéro : la contrepartie est le numéro", () => {
    const p = parseMobileMoneySms(
      "Orange Money: Transfert de 20.000 FCFA vers 699001122 réussi. Frais: 250 FCFA. Nouveau solde: 48.250 FCFA. Ref: CI261107.1530.B44721",
    );
    expect(p.operator).toBe("orange");
    expect(p.kind).toBe("envoi");
    expect(p.amount).toBe(20000);
    expect(p.fee).toBe(250);
    expect(p.balanceAfter).toBe(48250);
    expect(p.counterparty).toBe("699001122");
    expect(p.reference).toBe("CI261107.1530.B44721");
    expect(p.missing).toEqual(["date"]);
  });

  it("Orange Money, « Vous avez reçu un transfert » : la réception l'emporte", () => {
    const p = parseMobileMoneySms(
      "Vous avez reçu un transfert de 7500 FCFA de ALICE MBALLA le 05-11-2026. Nouveau solde: 55750 FCFA. Orange Money",
    );
    expect(p.kind).toBe("reception");
    expect(p.direction).toBe("revenu");
    expect(p.amount).toBe(7500);
    expect(p.date).toBe("2026-11-05");
    expect(p.counterparty).toBe("ALICE MBALLA");
  });

  it("paiement d'une facture : dépense, marchand reconnu", () => {
    const p = parseMobileMoneySms(
      "Votre paiement de 18 450 FCFA à ENEO a été effectué le 03/11/26. Frais 0 FCFA. Solde: 120 000 FCFA. MTN MoMo",
    );
    expect(p.kind).toBe("paiement");
    expect(p.direction).toBe("depense");
    expect(p.amount).toBe(18450);
    expect(p.fee).toBe(0);
    expect(p.date).toBe("2026-11-03");
    expect(p.counterparty).toBe("ENEO");
  });

  it("retrait chez un agent : pas de sens revenu/dépense, c'est un virement vers les espèces", () => {
    const p = parseMobileMoneySms(
      "Retrait de 30000 FCFA effectué chez l'agent DIALLO SHOP le 2026-11-02. Frais: 450 FCFA. Nouveau solde: 70000 FCFA. MTN MoMo",
    );
    expect(p.kind).toBe("retrait");
    expect(p.direction).toBeNull();
    expect(p.amount).toBe(30000);
    expect(p.fee).toBe(450);
  });

  it("dépôt d'espèces : virement vers le compte Mobile Money", () => {
    const p = parseMobileMoneySms("Dépôt de 50 000 FCFA effectué sur votre compte Orange Money le 01/11/2026. Nouveau solde: 98 000 FCFA.");
    expect(p.kind).toBe("depot");
    expect(p.direction).toBeNull();
    expect(p.amount).toBe(50000);
    expect(p.balanceAfter).toBe(98000);
  });

  it("frais et solde dans la même phrase : c'est le dernier mot-clé qui décide", () => {
    const p = parseMobileMoneySms("Transfert de 5000 FCFA à JULES réussi, frais 50 FCFA, solde 61 950 FCFA");
    expect(p.amount).toBe(5000);
    expect(p.fee).toBe(50);
    expect(p.balanceAfter).toBe(61950);
  });

  it("« à tes transactions » n'est pas un destinataire, « ID externe » n'est pas une référence", () => {
    const p = parseMobileMoneySms(
      "Vous avez payé 50250 FCFA le 29/10/2026. Frais 0 FCFA. Nouveau solde: 98 000 FCFA. ID externe: N/A. Accède à tes transactions sur MoMo App.",
    );
    expect(p.amount).toBe(50250);
    expect(p.counterparty).toBeNull();
    expect(p.reference).toBeNull();
  });

  it("« ID externe : 123... » garde le numéro comme référence", () => {
    const p = parseMobileMoneySms("Vous avez reçu 4000 FCFA de PAUL le 28/10/2026. ID externe: 77012345. Solde 9000 FCFA");
    expect(p.reference).toBe("77012345");
    expect(p.counterparty).toBe("PAUL");
  });

  it("« Montant : » sans unité est reconnu", () => {
    const p = parseMobileMoneySms("Paiement réussi. Montant: 12500, Frais: 0 FCFA. Ref: AB12345678");
    expect(p.amount).toBe(12500);
    expect(p.kind).toBe("paiement");
  });

  it("un numéro de téléphone n'est jamais pris pour un montant", () => {
    const p = parseMobileMoneySms("Vous avez reçu de 237670000000 la somme de 4000 FCFA. Solde 9000 FCFA");
    expect(p.amount).toBe(4000);
  });

  it("date impossible ignorée, message sans montant signalé comme incomplet", () => {
    const p = parseMobileMoneySms("Bonjour, votre transaction du 31/02/2026 est en cours de traitement.");
    expect(p.date).toBeNull();
    expect(p.amount).toBeNull();
    expect(p.missing).toEqual(expect.arrayContaining(["amount", "date"]));
  });
});

describe("POST /api/sms/parse", () => {
  beforeEach(resetDb);

  it("exige une connexion", async () => {
    await request(app).post("/api/sms/parse").send({ text: "Vous avez reçu 1000 FCFA de X" }).expect(401);
  });

  it("renvoie la lecture du SMS et n'enregistre rien", async () => {
    const { body } = await registerFreshUser();
    const auth = `Bearer ${body.accessToken}`;
    const res = await request(app)
      .post("/api/sms/parse")
      .set("Authorization", auth)
      .send({ text: "Vous avez transféré 10000 FCFA à MARIE le 09/11/2026. Frais: 100 FCFA. Nouveau solde: 202000 FCFA." })
      .expect(200);
    expect(res.body.parsed.amount).toBe(10000);
    expect(res.body.parsed.fee).toBe(100);

    const list = await request(app).get("/api/transactions").set("Authorization", auth).expect(200);
    expect(list.body.transactions).toHaveLength(0);
  });

  it("refuse un texte vide ou démesuré", async () => {
    const { body } = await registerFreshUser();
    const auth = `Bearer ${body.accessToken}`;
    await request(app).post("/api/sms/parse").set("Authorization", auth).send({ text: "court" }).expect(400);
    await request(app).post("/api/sms/parse").set("Authorization", auth).send({ text: "x".repeat(1001) }).expect(400);
  });
});
