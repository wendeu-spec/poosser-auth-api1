import { defineConfig } from "vitest/config";

/**
 * La suite tourne contre une VRAIE base Postgres (poosser_auth_test, voir
 * .env.test) — aucun mock de la couche base de données ou de la logique de
 * sécurité. La seule chose remplacée en test est la frontière d'envoi de SMS
 * (voir tests/setup.ts) : on ne peut pas envoyer de vrais SMS dans une suite
 * automatisée, donc on capture le code au lieu de l'envoyer, sans toucher à
 * la moindre ligne de logique métier ou de vérification.
 *
 * pool: "forks" — argon2 utilise des bindings natifs ; les threads workers de
 * Vitest partagent parfois mal ce genre de module. Les process forks évitent
 * la classe de bugs "module natif chargé deux fois" et isolent proprement
 * chaque fichier de test (chacun a son propre process.env).
 */
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    hookTimeout: 30_000,
    testTimeout: 30_000,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true, // une seule connexion pool Postgres à la fois, évite les conflits sur les mêmes lignes
      },
    },
    fileParallelism: false,
  },
});
