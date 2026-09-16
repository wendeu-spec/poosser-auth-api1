/**
 * Crée (ou confirme) un compte de test prêt à l'emploi, pour se connecter
 * directement au prototype sans passer par le cycle OTP par SMS.
 *
 * Ce script appelle directement le service `registerUser()` — la même
 * fonction qu'utilise la vraie route POST /auth/register — mais sans passer
 * par un ticket OTP, puisqu'il tourne en local avec un accès direct à la
 * base. La route HTTP réelle, elle, continue d'exiger un OTP valide pour
 * absolument tout le monde : ce script est un outil de développement, pas
 * une porte dérobée dans l'application.
 *
 * Idempotent : si le compte existe déjà (même numéro), le script se contente
 * d'afficher ses informations au lieu d'échouer ou de le recréer.
 *
 * Usage : npm run seed:test-account
 * (nécessite que .env pointe vers une base où les migrations ont été
 * appliquées — voir README §5)
 */
import { pool } from "../src/db/pool.js";
import { registerUser, findUserByPhone } from "../src/services/userService.js";

const TEST_PHONE = "+237690000099";
const TEST_PIN = "246813";
const TEST_FIRST_NAME = "Compte";
const TEST_LAST_NAME = "Test";
const TEST_PROFILE_TYPE = "salarie";

async function main() {
  const existing = await findUserByPhone(TEST_PHONE);

  if (existing) {
    // eslint-disable-next-line no-console
    console.log(
      [
        "[seed] Le compte de test existe déjà, rien à créer.",
        "",
        `  Téléphone : ${TEST_PHONE}`,
        `  PIN       : ${TEST_PIN}`,
        "",
        "  (Le PIN ci-dessus n'est correct que si le compte a été créé par ce",
        "  script — s'il a été recréé manuellement avec un autre PIN, utilisez",
        "  celui-là à la place, ou supprimez la ligne dans `users` et relancez.)",
      ].join("\n"),
    );
    return;
  }

  const { user } = await registerUser({
    phoneE164: TEST_PHONE,
    firstName: TEST_FIRST_NAME,
    lastName: TEST_LAST_NAME,
    profileTypeCode: TEST_PROFILE_TYPE,
    pin: TEST_PIN,
    device: { fingerprint: "seed-script-initial-device", name: "Compte de test (seed)", platform: "web" },
    ip: null,
  });

  // eslint-disable-next-line no-console
  console.log(
    [
      "[seed] Compte de test créé avec succès.",
      "",
      `  Téléphone : ${user.phone}`,
      `  PIN       : ${TEST_PIN}`,
      `  Profil    : ${TEST_PROFILE_TYPE}`,
      "",
      "  Connectez-vous avec ces identifiants sur l'écran de connexion du",
      "  prototype (poosser_prototype.html) — le compte n'a aucune donnée,",
      "  vous partez d'un tableau de bord vide.",
    ].join("\n"),
  );
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[seed] Échec :", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
