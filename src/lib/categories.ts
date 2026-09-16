/**
 * Catégories de transaction/budget/planner — reprises telles quelles du
 * prototype front-end (poosser_prototype.html) pour ne rien reconcevoir côté
 * serveur. Liste volontairement validée en application (Zod), pas en
 * contrainte CHECK en base, pour rester facile à étendre sans migration —
 * contrairement à `method`, un ensemble fermé et stable, qui lui reste en
 * CHECK SQL (voir migrations/014_transactions.sql).
 */
export const CATEGORIES = [
  "Alimentation",
  "Transport",
  "Logement",
  "Santé",
  "Éducation",
  "Loisirs",
  "Tontine",
  "Salaire",
  "Commerce",
  "Freelance",
  "Autres",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const TRANSACTION_METHODS = ["Mobile Money", "Espèces", "Virement bancaire", "Autre"] as const;
export type TransactionMethod = (typeof TRANSACTION_METHODS)[number];

export const TONTINE_FREQUENCIES = ["hebdomadaire", "mensuelle", "trimestrielle"] as const;
export type TontineFrequency = (typeof TONTINE_FREQUENCIES)[number];
