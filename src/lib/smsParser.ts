/**
 * Lecture d'un SMS de confirmation Mobile Money (MTN MoMo, Orange Money —
 * Cameroun, en français ou en anglais) pour PRÉ-REMPLIR une opération.
 *
 * Principes :
 * - rien n'est enregistré ici : le résultat sert à remplir un formulaire que
 *   l'utilisateur vérifie et valide lui-même ;
 * - lecture par mots-clés plutôt que par modèles exacts, parce que les
 *   opérateurs changent régulièrement la formulation de leurs messages ;
 * - chaque montant est classé selon les mots qui le précèdent (« frais »,
 *   « solde »...) pour ne jamais confondre le montant de l'opération, les
 *   frais et le nouveau solde ;
 * - en cas de doute, le champ reste vide (null) et figure dans `missing`,
 *   plutôt que d'inventer une valeur.
 */

export type SmsOperator = "mtn" | "orange";
/**
 * - reception : argent reçu (revenu)
 * - envoi : transfert envoyé à une personne (dépense)
 * - paiement : paiement d'un marchand / d'une facture (dépense)
 * - retrait : retrait d'espèces chez un agent (virement Mobile Money → Espèces)
 * - depot : dépôt d'espèces chez un agent (virement Espèces → Mobile Money)
 */
export type SmsKind = "reception" | "envoi" | "paiement" | "retrait" | "depot";

export interface ParsedSms {
  operator: SmsOperator | null;
  kind: SmsKind | null;
  /** Sens pour une opération classique ; null pour retrait/dépôt (ce sont des virements entre comptes). */
  direction: "revenu" | "depense" | null;
  amount: number | null;
  fee: number | null;
  balanceAfter: number | null;
  /** AAAA-MM-JJ */
  date: string | null;
  counterparty: string | null;
  reference: string | null;
  missing: Array<"amount" | "kind" | "date">;
}

/** Retire les accents en conservant la longueur du texte (positions alignées avec l'original). */
function fold(text: string): string {
  return [...text]
    .map((ch) => {
      const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
      return base.length === 1 ? base : ch;
    })
    .join("")
    .toLowerCase();
}

// Un montant : « 25000 », « 25 000 », « 25.000 », « 25,000 », « 25000.00 »,
// suivi d'une unité FCFA / XAF / CFA / F (avec ou sans espaces).
const AMOUNT_WITH_UNIT =
  /(\d{1,3}(?:[ .,  ]\d{3})+|\d+)(?:[.,](\d{1,2}))?\s*(?:f\s?cfa|xaf|cfa|f\b|frs?\b)/g;
// « Montant : 25000 » sans unité.
const AMOUNT_LABELLED = /(?:montant|amount)\s*:?\s*(\d{1,3}(?:[ .,  ]\d{3})+|\d+)/g;

function toNumber(intPart: string, decimals?: string): number {
  const n = Number(intPart.replace(/[ .,  ]/g, ""));
  return decimals ? n + Number(`0.${decimals}`) : n;
}

type AmountRole = "fee" | "balance" | "main";

interface FoundAmount {
  value: number;
  index: number;
  role: AmountRole;
}

function lastIndexOf(re: RegExp, text: string): number {
  let last = -1;
  const g = new RegExp(re.source, "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(text))) last = m.index;
  return last;
}

function roleFromContext(before: string): AmountRole {
  // On regarde la fin du texte qui précède le montant, en s'arrêtant à la
  // dernière ponctuation forte : c'est le DERNIER mot-clé rencontré qui
  // décide (« Frais 0 FCFA, solde 120 000 » → 120 000 est le solde).
  const tail = before.slice(-32).split(/[.;!?](?:\s|$)/).pop() ?? "";
  const fee = lastIndexOf(/\b(?:frais|fees?|commission|charges?)\b/, tail);
  const balance = lastIndexOf(/\b(?:solde|balance|bal)\b/, tail);
  const main = lastIndexOf(/\b(?:montant|amount|somme|de|of|recu|received|transfere|transferred|envoye|sent|paiement|payment|retrait|depot)\b/, tail);
  const best = Math.max(fee, balance, main);
  if (best === -1 || best === main) return "main";
  return best === fee ? "fee" : "balance";
}

function findAmounts(folded: string): FoundAmount[] {
  const found: FoundAmount[] = [];
  const seen = new Set<number>();
  for (const re of [AMOUNT_WITH_UNIT, AMOUNT_LABELLED]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(folded))) {
      const numberStart = m.index + m[0].indexOf(m[1]!);
      if (seen.has(numberStart)) continue;
      // Un numéro de téléphone ou un identifiant n'est pas un montant.
      const prev = folded[numberStart - 1];
      if (prev && /[\d+]/.test(prev)) continue;
      const digits = m[1]!.replace(/\D/g, "");
      if (digits.length >= 9 && !/[ .,  ]/.test(m[1]!)) continue;
      seen.add(numberStart);
      found.push({
        value: toNumber(m[1]!, re === AMOUNT_WITH_UNIT ? m[2] : undefined),
        index: numberStart,
        role: roleFromContext(folded.slice(0, numberStart)),
      });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

function detectOperator(folded: string): SmsOperator | null {
  if (/orange\s*money|\borange\b|\bom\b/.test(folded)) return "orange";
  if (/\bmtn\b|\bmomo\b|mobile\s*money/.test(folded)) return "mtn";
  return null;
}

function detectKind(folded: string): SmsKind | null {
  if (/\bretrait|\bwithdraw|\bcash\s*out/.test(folded)) return "retrait";
  if (/\bdepot\b|\bdeposit|\bcash\s*in\b/.test(folded)) return "depot";
  // « Vous avez reçu un transfert » : la réception l'emporte sur « transfert ».
  if (/\brecu\b|\breceived?\b|\bcredite?s?\b|\bcredited\b/.test(folded)) return "reception";
  if (/\bpaiement|\bpayment|\bpaid\b|\bpaye\b|\bachat|\bpurchase|\bfacture|\bbill\b/.test(folded)) return "paiement";
  if (/\btransf[eé]r|\btransfert|\benvoy|\bsent\b|\bsend\b|\bdebite?s?\b|\bdebited\b/.test(folded)) return "envoi";
  return null;
}

function directionOf(kind: SmsKind | null): ParsedSms["direction"] {
  if (kind === "reception") return "revenu";
  if (kind === "envoi" || kind === "paiement") return "depense";
  return null;
}

function validDate(y: number, m: number, d: number): string | null {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function detectDate(folded: string): string | null {
  const iso = /\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(folded);
  if (iso) return validDate(+iso[1]!, +iso[2]!, +iso[3]!);
  const fr = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})\b/.exec(folded);
  if (fr) {
    const y = fr[3]!.length === 2 ? 2000 + Number(fr[3]) : Number(fr[3]);
    return validDate(y, +fr[2]!, +fr[1]!);
  }
  return null;
}

function detectReference(original: string): string | null {
  // Une référence contient toujours au moins un chiffre : « ID externe »,
  // « Ref interne » ou « ID de transaction : » suivi d'un mot ne sont pas des
  // références. On prend la première candidate valable.
  const re =
    /(?:id\s+de\s+(?:la\s+)?transaction|transaction\s+id|txn\s*id|financial\s+transaction\s+id|r[ée]f[ée]rence|\bref\b\.?|\bid\b)(?:\s+(?:externe|interne|financier|financi[eè]re))?\s*[:#.]?\s*([A-Za-z0-9][A-Za-z0-9.\-]{5,40})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(original))) {
    const value = m[1]!.replace(/\.$/, "");
    if (/\d/.test(value)) return value;
  }
  return null;
}

function detectCounterparty(original: string, folded: string, kind: SmsKind | null): string | null {
  const keyword =
    kind === "reception" ? /\b(?:de|from|par)\s+/g : kind === "envoi" || kind === "paiement" ? /\b(?:a|to|vers|pour|chez)\s+/g : null;
  if (!keyword) return null;
  let m: RegExpExecArray | null;
  keyword.lastIndex = 0;
  while ((m = keyword.exec(folded))) {
    const start = m.index + m[0].length;
    const rest = original.slice(start, start + 60);
    // Un nom : lettres (avec accents), espaces, tirets, apostrophes, points ;
    // s'arrête à une parenthèse, un chiffre, une ponctuation forte ou « le ».
    const name = /^([A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’.\- ]{1,48}?)(?=\s*(?:\(|\d|[,;:.]\s|\.$|$|\s+(?:le|on|au|a|at|reussi|réussi|effectue|effectué)\b))/.exec(
      rest,
    );
    if (name) {
      const value = name[1]!.trim();
      const low = fold(value);
      // Écarte les faux noms (« votre compte », unités, mots génériques).
      // Écarte les faux noms : possessifs (« à tes transactions », « de votre
      // compte »), unités, articles et mots génériques des messages.
      const generic = /^(votre|vos|ton|ta|tes|mon|ma|mes|son|sa|ses|notre|nos|leur|leurs|your|my|the|compte|account|fcfa|xaf|cfa|la|le|les|l'|un|une|des|du|partir|travers|ce|cette|tout|toute|tous)\b/;
      if (!generic.test(low) && value.length >= 2) return value;
    }
    // Pas de nom mais un numéro : on le garde comme contrepartie.
    const phone = /^\(?(\+?\d[\d ]{7,14}\d)\)?/.exec(rest);
    if (phone) return phone[1]!.replace(/\s+/g, "");
  }
  return null;
}

export function parseMobileMoneySms(text: string): ParsedSms {
  const original = text.replace(/\s+/g, " ").trim();
  const folded = fold(original);

  const kind = detectKind(folded);
  const amounts = findAmounts(folded);
  const main = amounts.find((a) => a.role === "main") ?? null;
  const fee = amounts.find((a) => a.role === "fee") ?? null;
  const balance = amounts.filter((a) => a.role === "balance").pop() ?? null;
  const date = detectDate(folded);

  const missing: ParsedSms["missing"] = [];
  if (!main) missing.push("amount");
  if (!kind) missing.push("kind");
  if (!date) missing.push("date");

  return {
    operator: detectOperator(folded),
    kind,
    direction: directionOf(kind),
    amount: main ? main.value : null,
    fee: fee ? fee.value : null,
    balanceAfter: balance ? balance.value : null,
    date,
    counterparty: detectCounterparty(original, folded, kind),
    reference: detectReference(original),
    missing,
  };
}
