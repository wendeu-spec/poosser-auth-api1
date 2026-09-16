# POOSSER Auth API — Rapport de sécurité (Phase 4)

Ce rapport documente l'audit de sécurité du système d'authentification implémenté dans ce chantier. Il couvre l'authentification, la gestion de session, les secrets, les jetons, le stockage local, l'API, la protection contre le brute force, les fuites d'information, la journalisation et la récupération de compte — conformément au cahier des charges (§14 à §18, §25).

Portée : ce rapport couvre uniquement le backend d'authentification (`poosser-auth-api`). Aucun frontend/client n'existe dans ce chantier (voir `ARCHITECTURE.md` §12).

## 1. Résumé exécutif

Le système a été audité manuellement (revue de code ligne à ligne des chemins critiques) et testé automatiquement (50 tests, voir §11) contre une vraie base PostgreSQL, sans aucun mock de la logique de sécurité. Deux vulnérabilités réelles ont été trouvées et corrigées pendant la vérification (§2). Aucune vulnérabilité connue n'a été laissée ouverte dans le code applicatif. Les seules alertes `npm audit` restantes sont confinées à la chaîne d'outils de développement (`vitest`/`vite`, jamais exécutée en production) — voir §9.

## 2. Vulnérabilités trouvées et corrigées pendant l'audit

### 2.1 (Critique) Événements de sécurité perdus par violation de clé étrangère à l'inscription

`logSecurityEvent()` écrivait toujours via le pool de connexions partagé, jamais via le client de la transaction en cours. Lors de `registerUser()`, l'utilisateur nouvellement inséré n'était pas encore committé quand `logSecurityEvent({userId, type: "account_created", ...})` s'exécutait sur une **autre** connexion du pool — cette connexion ne voyait pas encore la ligne `users`, d'où une violation de contrainte de clé étrangère et un échec HTTP 500 sur `POST /auth/register`, cassant l'inscription de bout en bout.

**Correctif** : `logSecurityEvent()` accepte maintenant un client optionnel (`PoolClient | typeof pool`, par défaut `pool`) et l'utilise pour sa requête `INSERT`. `registerUser()` lui passe désormais le client de sa transaction. `getPublicUser()` a reçu le même traitement (elle lisait aussi, sur une autre connexion, une ligne pas encore committée).

### 2.2 (Critique) La détection de réutilisation de refresh token ne révoquait rien, à cause d'un ROLLBACK

`rotateSession()` détectait correctement la réutilisation d'un refresh token déjà tourné (signal classique de vol de jeton), révoquait toute la famille de sessions actives, journalisait un événement critique — puis levait `Errors.refreshReuseDetected()` **à l'intérieur même de la transaction** qui venait d'écrire cette révocation. `withTransaction()` fait un `ROLLBACK` dès qu'une exception traverse son callback : la révocation qu'on venait d'écrire était donc systématiquement annulée. Le refresh token « nouvellement » issu de la rotation légitime restait pleinement valide malgré la détection de vol — un attaquant en possession de l'ancien token pouvait ainsi être détecté sans que ça ait le moindre effet.

**Correctif** : `rotateSession()` calcule maintenant un résultat neutre (`{kind: "ok" | "invalid" | "reuse"}`) *à l'intérieur* de la transaction (qui se commite donc toujours normalement), et ne lève l'erreur `REFRESH_REUSE_DETECTED` qu'**après** le commit, à l'extérieur du callback. Vérifié par un test de régression explicite (`tests/session.test.ts`) qui confirme que le token issu de la rotation légitime est bien mort après une tentative de réutilisation de l'ancien.

### 2.3 (Élevé) La récupération « téléphone perdu » ne révoquait pas les anciens appareils, seulement leurs sessions

`POST /auth/reset-pin` avec `revokeOtherDevices: true` appelait `revokeAllSessions()`, qui ne touche que la table `sessions`. La table `devices` elle-même n'était jamais mise à jour : un ancien appareil perdu/volé continuait à apparaître comme `status: "active"` dans `GET /auth/devices` après une récupération de compte, ce qui contredit l'exigence explicite du cahier des charges (« gestion du téléphone perdu, qui révoque les anciens appareils », §9).

**Correctif** : le handler appelle désormais `revokeAllDevices()` (qui marque le device `status = 'revoked'` **et** révoque ses sessions actives), fonction déjà existante et déjà utilisée correctement par `DELETE /auth/devices/:id`. Vérifié par un test de régression dédié.

Ces trois corrections ont été appliquées avant la fin du chantier ; aucune n'affecte de fonctionnalité existante par ailleurs (règle §21.8).

## 3. Authentification et identifiants

- **Identifiant primaire** : numéro de téléphone au format E.164, normalisé via `libphonenumber-js` avec validation stricte (`isValid()`), sans aucune hypothèse de pays imposée malgré `DEFAULT_PHONE_COUNTRY=CM` (testé avec un numéro français, voir `tests/registration.test.ts`).
- **PIN de connexion** (6 chiffres) : haché avec **Argon2id**, jamais SHA-256 ni un algorithme maison, avec des paramètres délibérément élevés pour un secret court (mémoire 64 Mo, time cost 3, parallélisme 1 — voir `ARCHITECTURE.md` §5 pour la justification face à OWASP).
- **Rejet des PIN faibles** : motifs répétés (`111111`), séquences croissantes/décroissantes (`123456`, `654321`) et une liste de motifs connus sont rejetés à la création et au changement de PIN (`isWeakPin()`).
- **Verrouillage temporaire** après échecs consécutifs (`RATE_LIMIT_LOGIN_PER_PHONE`, `ACCOUNT_LOCK_DURATION_SECONDS`, tous deux configurables), avec réinitialisation du compteur après un succès.
- **Résistance à l'énumération de comptes** : `verifyLoginPin()` exécute toujours un `argon2.verify()` (contre un hash factice `getDummyHash()` si le compte n'existe pas) pour égaliser le temps de réponse ; `POST /auth/login` répond `INVALID_CREDENTIALS` de façon identique, compte inexistant ou mauvais PIN.

## 4. Gestion de session (jetons)

- **Access token** : JWT HS256, courte durée (900 s par défaut), signé avec un secret dédié (`JWT_ACCESS_SECRET`).
- **Refresh token** : chaîne aléatoire opaque de 256 bits, jamais un JWT — stockée en base uniquement sous forme de hash SHA-256 (voir `ARCHITECTURE.md` §4 pour la justification : Argon2 est pensé pour des secrets choisis à faible entropie, pas pour un jeton déjà uniformément aléatoire sur 256 bits — l'y appliquer n'apporterait aucune résistance supplémentaire et coûterait cher en calcul).
- **Rotation obligatoire** à chaque `POST /auth/refresh`, avec traçage de « famille » (`refresh_token_family`) et **détection de réutilisation** (§2.2 ci-dessus) : présenter un token déjà tourné ou déjà révoqué révoque immédiatement toute la famille.
- **Invalidation immédiate** : chaque appel à une route protégée revérifie en base le statut de la session (`requireAccessToken`), pas seulement la signature JWT — une révocation prend donc effet immédiatement, sans attendre l'expiration naturelle de l'access token (jusqu'à 15 min sinon).
- **Trois secrets JWT indépendants** (access / ticket OTP / step-up) : la compromission d'un seul type de jeton ne compromet pas les autres.

## 5. Biométrie

POOSSER ne collecte, ne stocke et ne transmet **aucune** donnée biométrique brute (empreinte, visage). La biométrie, gérée exclusivement côté OS (Keystore Android / Secure Enclave iOS), ne fait que déverrouiller localement un identifiant déjà protégé ; le PIN reste toujours disponible en repli et n'est jamais désactivable de façon permanente tant que la biométrie est active (voir `ARCHITECTURE.md` §7 — c'est un point d'intégration client, hors périmètre de ce backend, mais l'architecture serveur (PIN + step-up) est conçue pour ne jamais dépendre d'un secret biométrique).

## 6. Appareils et détection de risque

- Chaque appareil est identifié par une empreinte fournie par le client, associée à un enregistrement serveur (`devices`) avec statut (`active`/`revoked`), horodatage de dernière activité et IP.
- `GET /auth/devices`, `DELETE /auth/devices/:id`, `POST /auth/devices/revoke-others` permettent une gestion complète, avec invalidation immédiate des sessions concernées (testé).
- **Nouvel appareil** détecté à la connexion (`isNewDevice`) déclenche un événement de sécurité `new_device`.
- Le risque de connexion (`riskService.assessLoginRisk`) s'appuie sur le nombre réel d'échecs récents en base (`login_attempts`) — **jamais** sur la seule IP ou la géolocalisation comme preuve d'identité (rejeté explicitement dans `ARCHITECTURE.md` §9, ces signaux étant trop peu fiables pour bloquer une action, seulement pour informer/alerter).

## 7. PIN transactionnel et authentification à paliers (step-up)

- Le PIN transactionnel (`transaction_credentials`) est une table et un cycle de vie **entièrement distincts** du PIN de connexion (`users.pin_hash`) — vérifié explicitement par un test qui confirme que le PIN de connexion échoue comme PIN transactionnel et vice-versa.
- `requireStepUp(requiredAmr)` est un middleware réutilisable, non encore branché sur une route financière (aucune n'existe dans ce chantier) mais fonctionnellement complet et testé : il exige un jeton d'élévation distinct (`x-step-up-token`), lié au même utilisateur **et** au même appareil que l'access token, avec vérification des méthodes `amr` requises.
- Ce mécanisme permet d'implémenter les 3 niveaux du cahier des charges (normal / sensible / à haut risque) sans réécriture future.

## 8. Défenses contre les attaques listées au cahier des charges

| Attaque | Défense |
|---|---|
| Brute force PIN | Verrouillage temporaire après N échecs (§3), limite par IP et par téléphone |
| Credential stuffing | Même verrouillage + limite globale par IP (`globalIpRateLimit`) sur tout `/auth/*` |
| Énumération de comptes | Réponses indiscernables sur login, forgot-pin, request-otp ; comparaison à temps constant |
| Brute force OTP | `OTP_MAX_ATTEMPTS`, limite de vérifications par téléphone/fenêtre, code à usage unique |
| SIM swap | Détection de nouvel appareil + événement de sécurité ; recommandation produit (hors backend) d'alerter l'utilisateur par un canal secondaire |
| Vol de session / rejeu | Vérification de statut de session en base à chaque requête, pas seulement JWT |
| Rejeu de token | Ticket OTP à usage unique (`used_otp_tickets`, `INSERT ... ON CONFLICT`) |
| Réutilisation de refresh token | Rotation + détection + révocation de famille (§2.2) |
| Appareil compromis | Révocation individuelle ou globale des appareils, effet immédiat |
| Fuite de jeton | Jamais logué en clair (§10), TTL courts, jetons opaques hachés en base |
| Injection SQL | 100% requêtes paramétrées (`pg`), aucune concaténation de SQL nulle part |
| CSRF/XSS | `helmet()` (CSP par défaut), API stateless à jetons Bearer (pas de cookies de session) — CSRF non applicable à ce modèle |
| Abus d'API / DoS | Rate limiting multi-niveaux entièrement configurable par variables d'environnement (voir `.env.example` et `ARCHITECTURE.md` §10) |

## 9. Dépendances (npm audit)

```
npm audit --omit=dev  → 0 vulnérabilités
npm audit (avec dev)  → 5 vulnérabilités (3 modérées, 1 élevée, 1 critique)
```

Les 5 alertes sont **toutes** confinées à la chaîne `vitest → vite-node → vite → esbuild` (avis CORS du serveur de développement d'esbuild/vite), un outillage de **développement/test uniquement**, jamais exécuté en production ni exposé sur le réseau. Aucune dépendance de production (`express`, `pg`, `argon2`, `jsonwebtoken`, `helmet`, `cors`, `pino`, `zod`, `libphonenumber-js`, `dotenv`) n'est concernée. Corriger ces alertes exigerait de faire passer `vitest` en version majeure 4 (changement cassant sans rapport avec la sécurité de production) — décision documentée ici plutôt qu'appliquée sans nécessité.

## 10. Journalisation et confidentialité

- `pino` avec une liste de `redact.paths` couvrant PIN, OTP, mot de passe, tokens complets, empreintes d'appareil sensibles, etc. — testée manuellement (le smoke test confirme `"authorization":"[Redacted]"` dans les logs de requête).
- Le fournisseur SMS console (`ConsoleSmsProvider`, dev uniquement) journalise le code OTP en clair sous un champ explicitement nommé `otpDevOnly`, pour permettre le test manuel sans dépendre d'un vrai SMS — jamais utilisé si `SMS_PROVIDER` est `africastalking` ou `twilio`.
- `security_events` constitue le journal d'audit fonctionnel (types listés dans `securityEventService.ts`), avec un filet de sécurité supplémentaire (`sanitizeMetadata`) qui retire toute clé de métadonnées ressemblant à un secret avant écriture.

## 11. Résultats des tests automatisés

Suite Vitest + Supertest, exécutée contre une **vraie base PostgreSQL de test** (`poosser_auth_test`), sans mock de la logique de sécurité — seule la frontière d'envoi de SMS est remplacée par une capture en mémoire (voir `tests/setup.ts`), un vrai SMS ne pouvant pas être reçu par une suite automatisée.

```
 Test Files  7 passed (7)
      Tests  50 passed (50)
```

Couverture : inscription (succès, ticket invalide/déjà utilisé, numéro déjà enregistré, PIN faible, mismatch de confirmation, profil invalide, numéro international non-camerounais) ; cycle OTP (succès, mauvais code, expiration, réutilisation, épuisement des tentatives, cooldown, limite par fenêtre, anti-énumération) ; connexion (succès, mauvais PIN, anti-énumération, verrouillage par brute force, réinitialisation du compteur, détection de nouvel appareil) ; sessions (rotation, détection de réutilisation avec révocation de famille — régression du bug §2.2 —, logout unique vs global, accès protégé sans jeton) ; appareils (liste, révocation individuelle, révocation croisée refusée, revoke-others) ; récupération de compte (auto-login, ancien PIN mort, régression du bug §2.3, invalidation de l'ancien access token, mismatch de purpose sur le ticket) ; PIN transactionnel et step-up (indépendance des deux PIN, middleware `requireStepUp` bout en bout) ; journal d'audit (isolation par utilisateur).

## 12. Conformité à la règle « pas de mock sécuritaire » (§22)

Vérifiée explicitement :
- Aucune comparaison de PIN/OTP en clair, aucun `if (pin === "123456")`.
- Aucun token fictif ; tous les JWT sont réellement signés/vérifiés, tous les refresh tokens réellement générés par CSPRNG et hachés en base.
- Aucune vérification côté frontend (il n'y a pas de frontend dans ce chantier) — toutes les vérifications sont serveur, avec re-vérification en base à chaque requête protégée.
- Aucun secret dans le code source ; tous via variables d'environnement, `.env`/`.env.test` gitignorés et jamais présentés à l'utilisateur.

## 13. Limites connues et améliorations futures

- **Rate limiting sur PostgreSQL, pas Redis** : fonctionnellement correct et testé, mais moins performant à très grande échelle qu'un vrai magasin en mémoire. L'interface (`checkRateLimit`) est conçue pour être remplacée par une implémentation Redis sans toucher aux appelants.
- **SIM swap** : la détection de nouvel appareil existe, mais il n'existe pas encore de canal de notification externe (SMS/email de sécurité) pour alerter l'utilisateur en temps réel — c'est un sujet produit, pas seulement backend.
- **Aucun endpoint financier réel** : le PIN transactionnel et `requireStepUp` sont fonctionnellement complets et testés, mais n'ont encore aucune route métier à protéger (attendu, hors périmètre de ce chantier).
- **Pas de détection avancée de fraude** (vélocité de connexion inter-appareils, empreinte réseau, listes de blocage) — au-delà du périmètre du cahier des charges actuel.
- **Purge des tables de journalisation** (`rate_limit_buckets`, `used_otp_tickets`) : une fonction de purge existe (`pruneRateLimitBuckets`) mais n'est pas encore branchée sur une tâche planifiée récurrente.
