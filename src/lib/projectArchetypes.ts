/**
 * Archétypes de projet : reconnaître ce qu'un utilisateur est en train de
 * créer, à partir du seul nom qu'il tape, pour lui PROPOSER une nature et une
 * liste de rubriques.
 *
 * Décision de Yannis : pas de menu « nature du projet » à remplir. POOSSER
 * reconnaît et propose ; l'utilisateur valide, modifie ou ignore — exactement
 * comme la proposition de budget mensuel (migration 028), qui reste en attente
 * tant qu'elle n'est pas validée. Une détection juste huit fois sur dix est
 * excellente si elle montre ce qu'elle a compris ; elle est néfaste si elle
 * range les dépenses toute seule.
 *
 * Volontairement dans le CODE et non en base : la liste s'enrichit par
 * déploiement, elle est relue en revue, et elle n'a aucun état à conserver.
 * Même choix que CATEGORIES et PLANS.
 *
 * Les listes sont pensées pour le contexte camerounais : un chantier se
 * découpe en phases de gros œuvre, une tontine n'est pas un projet, et
 * l'élevage ou la revente de téléphones sont des cas plus courants qu'un
 * « lancement de start-up ».
 */

export type ProjectKind = "depense" | "activite";

export interface ProjectArchetype {
  /** Identifiant stable, utilisable par les tests et le client. */
  code: string;
  /** Ce qu'on annonce à l'utilisateur : « POOSSER a reconnu un chantier ». */
  label: string;
  kind: ProjectKind;
  /** Rubriques proposées, dans l'ordre naturel de déroulement. */
  rubriques: readonly string[];
  /** Rubriques de cette liste qui sont des frais d'approche (migration 038). */
  landedCost?: readonly string[];
  /**
   * Mots déclencheurs, en minuscules et SANS accents : la comparaison
   * normalise le nom saisi, pour que « dépendance » trouve « dependance » et
   * « ÉLEVAGE » trouve « elevage ».
   */
  keywords: readonly string[];
}

export const PROJECT_ARCHETYPES: readonly ProjectArchetype[] = [
  {
    code: "chantier",
    label: "un chantier de construction",
    kind: "depense",
    rubriques: ["Fondation", "Élévation", "Toiture", "Électricité", "Plomberie", "Menuiserie", "Finitions", "Main d'œuvre"],
    keywords: [
      "construction", "chantier", "batiment", "maison", "villa", "immeuble",
      "dependance", "fondation", "toiture", "renovation", "refection",
      "cloture", "forage", "puits", "terrain", "parcelle", "carrelage",
    ],
  },
  {
    code: "commerce",
    label: "un commerce ou une boutique",
    kind: "activite",
    rubriques: ["Stock initial", "Équipement", "Local / loyer", "Marketing", "Salaire", "Transport"],
    landedCost: ["Transport"],
    keywords: [
      "boutique", "commerce", "vente", "magasin", "shop", "revente", "kiosque",
      "quincaillerie", "pharmacie", "alimentation generale", "superette",
      "telephone", "informatique", "produits it", "friperie", "pret a porter",
    ],
  },
  {
    code: "production",
    label: "une production à transformer et vendre",
    kind: "activite",
    rubriques: ["Matière première", "Transport", "Emballage", "Main d'œuvre", "Énergie"],
    landedCost: ["Transport", "Emballage"],
    keywords: [
      "production", "transformation", "fabrication", "atelier", "usine",
      "arachide", "manioc", "huile", "savon", "jus", "farine", "pates",
      "beignets", "patisserie", "boulangerie", "couture", "menuiserie bois",
      "export", "conditionnement",
    ],
  },
  {
    code: "agriculture",
    label: "une activité agricole",
    kind: "activite",
    rubriques: ["Semences", "Engrais", "Traitement", "Main d'œuvre", "Transport", "Outillage"],
    landedCost: ["Transport"],
    keywords: [
      "agriculture", "champ", "plantation", "culture", "mais", "cacao", "cafe",
      "palmier", "bananeraie", "marachage", "tomate", "piment", "recolte", "ferme",
    ],
  },
  {
    code: "elevage",
    label: "un élevage",
    kind: "activite",
    rubriques: ["Achat des bêtes", "Alimentation", "Soins vétérinaires", "Bâtiment / enclos", "Main d'œuvre"],
    keywords: [
      "elevage", "poulet", "poule", "poussin", "porc", "porcherie", "cheptel",
      "chevre", "mouton", "boeuf", "lapin", "poisson", "pisciculture", "etang", "aviculture",
    ],
  },
  {
    code: "evenement",
    label: "un événement familial",
    kind: "depense",
    rubriques: ["Salle", "Traiteur", "Décoration", "Tenues", "Transport", "Sonorisation", "Imprévus"],
    keywords: [
      "mariage", "dot", "fete", "anniversaire", "bapteme", "funerailles",
      "deuil", "ceremonie", "reception", "soiree", "communion",
    ],
  },
  {
    code: "voyage",
    label: "un voyage",
    kind: "depense",
    rubriques: ["Billet d'avion", "Hébergement", "Visa", "Restauration", "Transport sur place", "Assurance"],
    keywords: ["voyage", "vacances", "sejour", "billet", "visa", "pelerinage", "tourisme", "deplacement"],
  },
  {
    code: "etudes",
    label: "des études ou une formation",
    kind: "depense",
    rubriques: ["Frais de scolarité", "Fournitures", "Transport", "Logement", "Restauration"],
    keywords: [
      "etudes", "scolarite", "ecole", "universite", "formation", "inscription",
      "rentree", "concours", "faculte", "lycee", "college", "stage",
    ],
  },
  {
    code: "sante",
    label: "des soins de santé",
    kind: "depense",
    rubriques: ["Consultations", "Médicaments", "Examens", "Hospitalisation", "Transport"],
    keywords: ["sante", "hopital", "soins", "maladie", "operation", "chirurgie", "traitement", "clinique", "accouchement"],
  },
  {
    code: "vehicule",
    label: "un véhicule",
    kind: "depense",
    rubriques: ["Achat", "Douane", "Transport", "Assurance", "Réparations", "Carburant"],
    landedCost: ["Douane", "Transport"],
    keywords: ["voiture", "vehicule", "moto", "taxi", "camion", "bus", "achat auto", "importation vehicule"],
  },
];

/** Minuscules, sans accents : « Élévation » et « elevation » doivent se rencontrer. */
export function normalizeForMatch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface ArchetypeSuggestion {
  code: string;
  label: string;
  kind: ProjectKind;
  rubriques: Array<{ name: string; isLandedCost: boolean }>;
  /** Le mot du nom qui a déclenché la reconnaissance, pour pouvoir le dire. */
  matchedOn: string;
}

/**
 * Reconnaît l'archétype d'un projet d'après son nom. Renvoie `null` quand
 * rien ne correspond — ne jamais proposer au hasard : une suggestion à côté
 * de la plaque coûte plus cher en confiance qu'une absence de suggestion.
 *
 * En cas de plusieurs correspondances, le mot déclencheur le plus LONG gagne :
 * « menuiserie bois » (production) doit l'emporter sur « menuiserie » si les
 * deux apparaissaient, et un mot long est un indice plus sûr qu'un mot court.
 */
export function suggestArchetype(projectName: string): ArchetypeSuggestion | null {
  const haystack = normalizeForMatch(projectName);
  if (!haystack) return null;

  let best: { archetype: ProjectArchetype; keyword: string } | null = null;
  for (const archetype of PROJECT_ARCHETYPES) {
    for (const keyword of archetype.keywords) {
      if (!haystack.includes(keyword)) continue;
      if (!best || keyword.length > best.keyword.length) best = { archetype, keyword };
    }
  }
  if (!best) return null;

  const landed = new Set(best.archetype.landedCost ?? []);
  return {
    code: best.archetype.code,
    label: best.archetype.label,
    kind: best.archetype.kind,
    rubriques: best.archetype.rubriques.map((name) => ({ name, isLandedCost: landed.has(name) })),
    matchedOn: best.keyword,
  };
}
