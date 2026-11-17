/**
 * Offre le Premium aux utilisateurs déjà inscrits, au moment où les formules
 * s'activent (décision validée : 6 mois offerts, voir le document « Modèle
 * d'abonnements »).
 *
 * À lancer UNE FOIS, juste avant de passer PLANS_ENFORCED à true. Sans lui,
 * les comptes existants — dont le tien et celui de ton testeur — se
 * retrouveraient du jour au lendemain au-dessus des limites du Gratuit.
 *
 * Idempotent : relancer le script ne prolonge pas les courtoisies déjà
 * accordées ; il ne touche que les utilisateurs sans abonnement.
 *
 * Usage :
 *   npm run grant:courtesy -- --dry-run     (affiche sans rien changer)
 *   npm run grant:courtesy                  (applique)
 *   npm run grant:courtesy -- --months 12
 */
import { pool } from "../src/db/pool.js";
import { grantPlan, monthsFromNow } from "../src/services/entitlementService.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const monthsArg = args.indexOf("--months");
const months = monthsArg !== -1 ? Number(args[monthsArg + 1]) : 6;

async function main() {
  if (!Number.isInteger(months) || months < 1 || months > 36) {
    throw new Error(`--months invalide : ${months}`);
  }

  // Seuls les utilisateurs SANS ligne d'abonnement : on ne réécrit jamais un
  // essai en cours, une courtoisie déjà posée ni un abonnement payé.
  const { rows } = await pool.query<{ id: string; phone_e164: string; created_at: Date }>(
    `SELECT u.id, u.phone_e164, u.created_at
       FROM users u
       LEFT JOIN subscriptions s ON s.user_id = u.id
      WHERE s.id IS NULL
      ORDER BY u.created_at ASC`,
  );

  const periodEnd = monthsFromNow(months);
  // eslint-disable-next-line no-console
  console.log(
    `[courtoisie] ${rows.length} utilisateur(s) sans abonnement.\n`
    + `[courtoisie] Premium offert ${months} mois, jusqu'au ${periodEnd.toISOString().slice(0, 10)}.`
    + (dryRun ? "\n[courtoisie] --dry-run : rien ne sera écrit." : ""),
  );

  for (const u of rows) {
    // Le numéro n'est jamais affiché en entier dans les journaux.
    const masque = u.phone_e164.slice(0, 5) + "…" + u.phone_e164.slice(-2);
    if (!dryRun) {
      await grantPlan(u.id, { planCode: "premium", status: "courtesy", periodEnd });
    }
    // eslint-disable-next-line no-console
    console.log(`  ${dryRun ? "[simulé] " : ""}${masque}  inscrit le ${u.created_at.toISOString().slice(0, 10)}`);
  }

  // eslint-disable-next-line no-console
  console.log(`[courtoisie] ${dryRun ? "Simulation terminée." : "Terminé."}`);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[courtoisie] Échec :", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
