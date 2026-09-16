# POOSSER — Référence API d'authentification

Base URL : `/auth`. Toutes les requêtes et réponses sont en JSON. Les endpoints marqués
🔒 exigent un `Authorization: Bearer <accessToken>` valide. Les endpoints marqués 🔒🔒
exigent en plus un step-up token valide (voir `POST /auth/step-up`).

Convention d'erreur commune :

```json
{ "error": { "code": "OTP_INVALID", "message": "Code invalide ou expiré." } }
```

Les messages sont toujours résolus depuis `src/i18n/*.json` selon la langue du client, et
**jamais** formulés de façon à révéler si un numéro de téléphone est enregistré ou non
(§18 du cahier des charges).

---

## POST /auth/request-otp

Demande l'envoi d'un code OTP à un numéro de téléphone.

- **Paramètres (body)** : `{ phone: string, purpose: "registration" | "account_recovery" }`
- **Validation** : `phone` doit être un numéro international valide (libphonenumber-js,
  aucun indicatif pays supposé) ; `purpose` doit être l'une des deux valeurs autorisées.
- **Réponse 200** : `{ expiresInSeconds: 300, retryAfterSeconds: 60 }` — **toujours** la
  même forme, que le numéro soit déjà enregistré ou non, et que `purpose` soit cohérent
  avec l'état réel du compte ou non.
- **Erreurs** : `400 VALIDATION_ERROR` (numéro invalide), `429 RATE_LIMITED` (avec
  `retryAfterSeconds`).
- **Règles de sécurité** : rate limit par téléphone (3/15 min) et par IP (10/heure) ;
  cooldown de renvoi de 60 s ; invalide tout challenge actif précédent pour ce couple
  `(phone, purpose)` ; le code n'est jamais renvoyé dans la réponse HTTP ; pour
  `purpose="account_recovery"` sur un numéro non enregistré, **aucun SMS n'est envoyé**
  mais la réponse est identique (anti-énumération).

## POST /auth/verify-otp

Vérifie le code reçu par SMS.

- **Paramètres** : `{ phone: string, purpose: string, code: string(6) }`
- **Validation** : code = exactement 6 chiffres.
- **Réponse 200** : `{ otpVerificationTicket: string, expiresInSeconds: 600 }` — un JWT
  courte-durée attestant que ce téléphone vient d'être vérifié pour ce `purpose`.
- **Erreurs** : `400 OTP_INVALID` (code faux, expiré, déjà consommé, ou aucun challenge
  actif), `429 RATE_LIMITED` (trop de vérifications).
- **Règles de sécurité** : comparaison via `argon2.verify` (jamais en clair) ; incrémente
  `attempts` à chaque échec, le challenge est définitivement invalidé après
  `max_attempts` (5) ; message d'erreur identique quel que soit le motif exact de
  l'échec, pour ne pas aider un attaquant à distinguer « mauvais code » de « compte
  inexistant ».

## POST /auth/register

Crée le compte après vérification du téléphone. Connexion automatique.

- **Paramètres** : `{ otpVerificationTicket, firstName, lastName, displayName?, email?, profileTypeCode, pin: string(6), pinConfirmation: string(6), device: { fingerprint, name, platform } }`
- **Validation** : ticket signé avec `purpose="registration"`, non expiré, non déjà
  consommé ; prénom/nom non vides (bornés en longueur) ; `profileTypeCode` doit exister
  dans `profile_types` et être actif ; email optionnel mais si fourni, syntaxiquement
  valide et unique ; `pin === pinConfirmation` ; PIN rejeté s'il est une séquence
  triviale (`123456`, `654321`, chiffre répété `xxxxxx`, séquence strictement croissante
  ou décroissante) — liste complète dans `src/lib/crypto.ts::WEAK_PIN_PATTERNS`.
- **Réponse 201** : `{ user: {...}, accessToken, refreshToken, expiresIn }`
- **Erreurs** : `400 VALIDATION_ERROR`, `400 OTP_TICKET_INVALID`, `409 PHONE_ALREADY_REGISTERED`,
  `400 PIN_TOO_WEAK`.
- **Règles de sécurité** : toute la création (users + user_profiles + devices + session)
  se fait dans **une seule transaction SQL** ; le PIN est haché avec les paramètres
  Argon2id renforcés (§5 ARCHITECTURE.md) avant tout `INSERT` ; le ticket OTP est
  marqué consommé pour empêcher un rejeu.

## POST /auth/login

Connexion normale : téléphone + PIN.

- **Paramètres** : `{ phone, pin, device: { fingerprint, name, platform } }`
- **Réponse 200** : `{ user, accessToken, refreshToken, expiresIn, newDevice: boolean }`
- **Erreurs** : `401 INVALID_CREDENTIALS` (numéro inconnu **ou** PIN faux — volontairement
  fusionnés), `423 ACCOUNT_LOCKED` (verrou temporaire actif, avec `retryAfterSeconds`),
  `429 RATE_LIMITED`.
- **Règles de sécurité** : si le numéro n'existe pas, une vérification Argon2 factice
  contre un hash fixe est tout de même exécutée pour que le temps de réponse ne trahisse
  pas l'existence du compte ; 5 échecs en 15 min déclenchent un verrou temporaire
  (`users.pin_locked_until`) ; chaque tentative (succès ou échec) est journalisée dans
  `login_attempts` ; un appareil dont l'empreinte n'a jamais été vue pour cet utilisateur
  déclenche un `security_events` de type `new_device` et positionne `newDevice: true`
  dans la réponse pour que le client puisse afficher la notification prévue au §8 du
  cahier des charges.

## POST /auth/refresh

Rafraîchit une session (rotation obligatoire).

- **Paramètres** : `{ refreshToken }`
- **Réponse 200** : `{ accessToken, refreshToken, expiresIn }` (nouveau refresh token à
  chaque appel — l'ancien devient immédiatement inutilisable)
- **Erreurs** : `401 REFRESH_INVALID` (token inconnu/expiré/révoqué), `401 REFRESH_REUSE_DETECTED`
  (token déjà tourné présenté à nouveau — toute la famille de sessions vient d'être
  révoquée, ré-authentification complète requise).
- **Règles de sécurité** : voir §4 ARCHITECTURE.md (rotation + détection de réutilisation).

## POST /auth/logout

🔒 Déconnecte l'appareil courant.

- **Paramètres** : `{ refreshToken }`
- **Réponse 204**
- **Règles de sécurité** : révoque uniquement la session correspondant au refresh token
  fourni (doit appartenir à l'utilisateur authentifié par l'access token).

## POST /auth/logout-all

🔒 Déconnecte **toutes** les sessions de l'utilisateur, y compris l'appareil courant.

- **Réponse 204**
- **Règles de sécurité** : révoque toutes les lignes `sessions` actives du `user_id`,
  journalise un événement `global_logout`.

## POST /auth/forgot-pin

Démarre une récupération de compte (délègue à `request-otp` avec
`purpose="account_recovery"`).

- **Paramètres** : `{ phone }`
- **Réponse 200** : identique à `request-otp` (même contrat anti-énumération).

## POST /auth/reset-pin

Termine la récupération de compte : définit un nouveau PIN de connexion.

- **Paramètres** : `{ otpVerificationTicket, newPin, newPinConfirmation, revokeOtherDevices?: boolean = true, device: { fingerprint, name, platform } }`
- **Réponse 200** : `{ user, accessToken, refreshToken, expiresIn }`
- **Erreurs** : `400 OTP_TICKET_INVALID`, `400 PIN_TOO_WEAK`.
- **Règles de sécurité** : par défaut, révoque tous les appareils/sessions existants
  (scénario « téléphone perdu ») ; journalise `account_recovered` ; le nouvel appareil
  utilisé pour la récupération devient le nouvel appareil principal.

## POST /auth/change-pin

🔒 Change le PIN de connexion (utilisateur déjà authentifié, connaît son PIN actuel).

- **Paramètres** : `{ currentPin, newPin, newPinConfirmation }`
- **Réponse 200** : `{ success: true }`
- **Erreurs** : `401 INVALID_CREDENTIALS` (mauvais PIN actuel), `400 PIN_TOO_WEAK`.
- **Règles de sécurité** : rate-limité (5/heure/utilisateur) ; journalise `pin_changed`
  sans jamais logger la valeur du PIN.

## GET /auth/me

🔒 Retourne le profil de l'utilisateur authentifié.

- **Réponse 200** : `{ id, phone, firstName, lastName, displayName, email, profileType, locale, createdAt }`
  — jamais de hash, jamais de token.

## GET /auth/devices

🔒 Liste les appareils de l'utilisateur.

- **Réponse 200** : `{ devices: [{ id, name, platform, isPrimary, isCurrent, status, lastSeenAt, createdAt }] }`

## DELETE /auth/devices/:id

🔒 Révoque un appareil spécifique.

- **Réponse 204**
- **Erreurs** : `404 DEVICE_NOT_FOUND` (y compris si l'appareil appartient à un autre
  utilisateur — même code pour ne pas révéler l'existence de l'ID chez autrui).
- **Règles de sécurité** : révoque l'appareil et **toutes** ses sessions actives.

## POST /auth/devices/revoke-others

🔒 Révoque tous les appareils sauf celui utilisé pour l'appel courant.

- **Réponse 200** : `{ revokedCount: number }`

## GET /auth/security-events

🔒 Historique des événements de sécurité de l'utilisateur (pagination par curseur).

- **Paramètres (query)** : `?limit=20&before=<eventId>`
- **Réponse 200** : `{ events: [{ id, type, severity, deviceName, createdAt }] }`

## POST /auth/transaction-pin

🔒 Crée ou met à jour le PIN transactionnel (distinct du PIN de connexion).

- **Paramètres** : `{ currentTransactionPin?, newTransactionPin, newTransactionPinConfirmation }`
  (`currentTransactionPin` absent uniquement lors de la toute première création)
- **Réponse 200** : `{ success: true }`
- **Règles de sécurité** : mêmes règles de robustesse et de hachage que le PIN de
  connexion, stocké dans `transaction_credentials`, jamais comparé ni confondu avec le
  PIN de connexion.

## POST /auth/step-up

🔒 Élève temporairement le niveau d'authentification pour une action sensible.

- **Paramètres** : `{ transactionPin }` (aujourd'hui) — extensible demain à
  `{ transactionPin, otp }` ou `{ transactionPin, biometricAssertion }` sans changer la
  forme de la réponse.
- **Réponse 200** : `{ stepUpToken, expiresIn: 300, amr: ["transaction_pin"] }`
- **Erreurs** : `401 INVALID_CREDENTIALS`, `400 TRANSACTION_PIN_NOT_SET`.
- **Règles de sécurité** : rate-limité indépendamment du login ; le step-up token est un
  JWT distinct de l'access token, à très courte durée de vie (5 min), consulté par le
  futur middleware `requireStepUp([...])` sur les endpoints financiers.

---

# Routes métier (`/api/*`)

Toutes les routes ci-dessous exigent 🔒 un access token valide (`Authorization: Bearer
<accessToken>`) et n'opèrent jamais que sur les données de l'utilisateur authentifié —
toute tentative d'accéder à une ressource d'un autre utilisateur répond `404` avec le
code `*_NOT_FOUND` correspondant, jamais une fuite d'information sur son existence.
Catégories acceptées (`category`) : voir `src/lib/categories.ts` (liste reprise telle
quelle du prototype front-end). Montants toujours en FCFA, nombres positifs.

## Transactions

- `GET /api/transactions` → `{ transactions: [...] }`, triées par date décroissante.
- `POST /api/transactions` → `{ type, category, amount, occurredOn, method, note? }` →
  `201 { transaction }`.
- `PATCH /api/transactions/:id` → champs partiels → `200 { transaction }`.
- `DELETE /api/transactions/:id` → `204`.
- Erreurs : `404 TRANSACTION_NOT_FOUND`.

## Budgets

- `GET /api/budgets` → `{ budgets: [...] }`.
- `POST /api/budgets` → `{ category, monthlyLimit }` → **upsert** : si un budget existe
  déjà pour cette catégorie chez cet utilisateur, sa limite est mise à jour plutôt que
  d'en créer un second (`UNIQUE(user_id, category)`) → `201 { budget }`.
- `DELETE /api/budgets/:id` → `204`.
- Erreurs : `404 BUDGET_NOT_FOUND`.

## Épargne

- `GET /api/savings-goals` → `{ savingsGoals: [...] }`.
- `POST /api/savings-goals` → `{ name, targetAmount, currentAmount?, deadline? }` →
  `201 { savingsGoal }`.
- `PATCH /api/savings-goals/:id` → champs partiels (typiquement `currentAmount` pour
  enregistrer un versement) → `200 { savingsGoal }`.
- `DELETE /api/savings-goals/:id` → `204`.
- Erreurs : `404 SAVINGS_GOAL_NOT_FOUND`.

## Tontines

- `GET /api/tontines` → `{ tontines: [...] }`, chaque tontine incluant ses membres, le
  statut de cotisation du tour en cours (`paidThisRound`) et l'historique des tours
  clôturés.
- `GET /api/tontines/:id` → `{ tontine }`.
- `POST /api/tontines` → `{ name, contributionAmount, frequency, members: string[] }`
  (2 à 50 membres, dans l'ordre de passage) → `201 { tontine }`.
- `POST /api/tontines/:id/contributions` → `{ memberId, paid }` — marque un membre
  payé/non payé pour le tour en cours → `200 { tontine }`.
- `POST /api/tontines/:id/close-round` — clôture le tour en cours et verse au
  bénéficiaire suivant (ordre de passage) ; **refuse tant que tous les membres n'ont pas
  cotisé** (même règle que le bouton correspondant, désactivé dans le prototype tant que
  100 % des membres n'ont pas payé) → `200 { tontine }` ou `409 TONTINE_ROUND_NOT_READY`.
- Erreurs : `404 TONTINE_NOT_FOUND`, `404 TONTINE_MEMBER_NOT_FOUND`, `409
  TONTINE_ROUND_NOT_READY`.

## Planner financier

- `GET /api/planner-events` → `{ plannerEvents: [...] }`, triés par date/heure.
- `POST /api/planner-events` → `{ title, eventDate, eventTime, durationMinutes, type,
  category, amount }` → `201 { plannerEvent }` (statut initial `a_venir`).
- `PATCH /api/planner-events/:id` → champs partiels → `200 { plannerEvent }`.
- `POST /api/planner-events/:id/status` → `{ status: "a_venir" | "realise" |
  "non_realise" }` — c'est l'action déclenchée par les boutons de validation de la
  notification de rappel (15 min avant début/fin) → `200 { plannerEvent }`.
- `DELETE /api/planner-events/:id` → `204`.
- Erreurs : `404 PLANNER_EVENT_NOT_FOUND`.

---

## Codes d'erreur utilisés

`VALIDATION_ERROR`, `RATE_LIMITED`, `OTP_INVALID`, `OTP_TICKET_INVALID`,
`PHONE_ALREADY_REGISTERED`, `PIN_TOO_WEAK`, `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED`,
`REFRESH_INVALID`, `REFRESH_REUSE_DETECTED`, `DEVICE_NOT_FOUND`,
`TRANSACTION_PIN_NOT_SET`, `UNAUTHORIZED` (access token manquant/expiré/invalide),
`FORBIDDEN` (step-up manquant sur un endpoint qui l'exige), `INTERNAL_ERROR`,
`TRANSACTION_NOT_FOUND`, `BUDGET_NOT_FOUND`, `SAVINGS_GOAL_NOT_FOUND`,
`TONTINE_NOT_FOUND`, `TONTINE_MEMBER_NOT_FOUND`, `TONTINE_ROUND_NOT_READY`,
`PLANNER_EVENT_NOT_FOUND`.
