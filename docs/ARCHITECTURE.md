# POOSSER — Architecture du système d'authentification (Phase 2)

Ce document est le livrable de conception avant implémentation. Il couvre l'architecture
cible, le modèle de données, les flux d'authentification, la stratégie de tokens/niveaux
de sécurité et la stratégie de gestion des appareils.

Stack retenue (validée avec le porteur du projet) : **Node.js + TypeScript + Express +
PostgreSQL**, sans dépendance à un service tiers non confirmé (Redis, Docker) — tout ce
qui a besoin d'un état partagé (rate limiting, sessions) vit dans PostgreSQL, avec une
interface suffisamment abstraite pour migrer vers Redis plus tard sans réécrire les
appelants.

## 1. Vue d'ensemble

```
Client (mobile/web, hors périmètre de ce chantier)
        │  HTTPS + JSON
        ▼
┌───────────────────────────────────────────────┐
│  API Express (src/app.ts)                      │
│  ┌─────────────┐  ┌─────────────┐              │
│  │ middleware   │  │ routes/auth │              │
│  │ - validate   │  │  17 endpoints              │
│  │ - rateLimit  │  └──────┬──────┘              │
│  │ - auth       │         │                     │
│  │ - errorHandler│         ▼                     │
│  └─────────────┘  ┌─────────────────────────┐   │
│                    │ services/                │   │
│                    │  otpService  pinService  │   │
│                    │  sessionService          │   │
│                    │  deviceService           │   │
│                    │  riskService             │   │
│                    │  securityEventService    │   │
│                    │  rateLimiter             │   │
│                    │  sms/SmsProvider (abst.) │   │
│                    └───────────┬──────────────┘   │
└────────────────────────────────┼──────────────────┘
                                  ▼
                       PostgreSQL 16 (pool pg)
                       9 tables, voir §3
```

Principe non négociable : **le frontend n'est jamais une zone de confiance**. Toute
vérification (format du PIN, expiration d'un token, propriété d'un appareil, limites de
débit) est refaite côté serveur, quoi que le client ait déjà validé.

## 2. Flux d'authentification

### 2.1 Inscription

```
POST /auth/request-otp {phone, purpose:"registration"}
        │  normalise le numéro (E.164, international, pas de préfixe supposé)
        │  rate-limit par téléphone + par IP, invalide les anciens challenges actifs
        │  génère un OTP à 6 chiffres (crypto.randomInt), le hash (argon2id) et le stocke
        │  envoie via SmsProvider.sendOtp() — jamais de log en clair
        ▼
POST /auth/verify-otp {phone, purpose:"registration", code}
        │  vérifie le hash, incrémente les tentatives en cas d'échec
        │  si succès : consomme le challenge, émet un otpVerificationTicket
        │  (JWT signé, courte durée ~10 min, claims {phone, purpose})
        ▼
POST /auth/register {otpVerificationTicket, prénom, nom, profileTypeCode, pin, device}
        │  revalide le ticket (signature + purpose + non expiré + non réutilisé)
        │  valide la force du PIN (rejette les séquences triviales)
        │  transaction SQL : users + user_profiles + devices (appareil principal)
        │  hash du PIN (argon2id, paramètres renforcés — voir §5)
        │  crée une session (access + refresh token), connexion automatique
        ▼
   Réponse : { user, accessToken, refreshToken, expiresIn }
```

### 2.2 Connexion normale

```
POST /auth/login {phone, pin, device}
        │  normalise le numéro, cherche l'utilisateur (temps de réponse constant
        │  même si le compte n'existe pas — vérif. factice contre l'énumération)
        │  vérifie le PIN (argon2.verify), vérifie le statut du compte et le verrou
        │  riskService : appareil connu ? échecs récents ? → décide simple allow /
        │  notifier (nouvel appareil) / durcir
        │  upsert de l'appareil, création de session, journal des événements
        ▼
   Réponse : { user, accessToken, refreshToken, expiresIn }
```

### 2.3 Récupération de compte (téléphone perdu)

Identique au flux d'inscription mais `purpose:"account_recovery"` et l'endpoint final est
`/auth/reset-pin` plutôt que `/auth/register`. Par défaut, une récupération de compte
révoque tous les appareils/sessions existants (le scénario typique est justement « on m'a
volé mon téléphone ») ; le client peut désactiver ce comportement explicitement si le
besoin est seulement d'oublier son code sur son propre appareil.

### 2.4 Rafraîchissement de session (rotation + détection de réutilisation)

```
POST /auth/refresh {refreshToken}
        │  hash le token reçu, cherche la session correspondante
        │  si la session est "revoked" → le token présenté a déjà été tourné :
        │    REUSE DETECTED → révoque toute la famille de tokens, événement critique,
        │    le client doit se ré-authentifier entièrement
        │  sinon : révoque la session courante (rotated_at=now），crée une nouvelle
        │  session dans la même "famille" avec un nouveau refresh token
        ▼
   Réponse : { accessToken, refreshToken, expiresIn }
```

## 3. Modèle de données

Toutes les tables utilisent des UUID (`gen_random_uuid()`, extension `pgcrypto`) et des
horodatages `timestamptz`. Le numéro de téléphone est **toujours** stocké normalisé en
E.164 (`+237670000000`), jamais dans le format saisi par l'utilisateur.

| Table | Rôle |
|---|---|
| `profile_types` | Catégories de profil (commerçant, entrepreneur, salarié, étudiant, autre) — table de référence, pas un ENUM figé, pour pouvoir en ajouter sans migration lourde |
| `users` | Identité + PIN de connexion (hash) + statut du compte |
| `user_profiles` | Prénom, nom, nom d'activité, email optionnel, type de profil, langue |
| `otp_challenges` | Défis OTP (hash du code, tentatives, expiration, consommation) |
| `devices` | Appareils enregistrés par utilisateur |
| `sessions` | Sessions actives, hash du refresh token, chaîne de rotation |
| `security_events` | Journal d'audit (jamais de secret en clair) |
| `login_attempts` | Historique brut des tentatives de connexion (succès/échec) |
| `transaction_credentials` | PIN transactionnel (distinct du PIN de connexion), prêt pour les futures opérations financières |
| `rate_limit_buckets` | Compteurs de limitation de débit (fenêtre fixe), remplace un Redis absent de cet environnement |

Le détail complet des colonnes, contraintes et index est dans les fichiers de migration
(`migrations/`), qui sont la source de vérité — ce document n'en est qu'un résumé.

Décision de conception notable : le PIN de connexion vit sur `users` (donnée 1:1 avec
l'identité), alors que le PIN transactionnel vit dans sa propre table
`transaction_credentials`. Ce n'est pas une redondance : c'est la mise en œuvre directe de
l'exigence « le PIN transactionnel doit être distinct du PIN de connexion » — deux
secrets, deux tables, deux cycles de vie.

## 4. Stratégie de tokens

- **Access token** : JWT signé (HS256, secret dans `.env`), durée de vie **15 minutes**,
  claims `{sub: userId, deviceId, sessionId, jti}`. Utilisé pour toutes les routes
  protégées. Ne jamais persister côté serveur (stateless, vérifié à la volée).
- **Refresh token** : chaîne aléatoire opaque à haute entropie (32 octets, base64url) —
  **pas** un JWT, et **pas** hashé avec argon2. Un refresh token est un secret à haute
  entropie généré aléatoirement (pas un secret choisi par un humain comme un PIN) : un
  hash rapide (SHA-256) suffit pour le comparer en toute sécurité côté serveur, et
  utiliser argon2 ici ajouterait un coût de calcul inutile sans bénéfice de sécurité
  réel. C'est la distinction que la mission demandait explicitement de respecter :
  « utiliser les mécanismes cryptographiques adaptés à chaque type de donnée ».
- **Rotation** : chaque appel à `/auth/refresh` invalide immédiatement l'ancien refresh
  token et en émet un nouveau. Le jeton stocké côté serveur n'est jamais réutilisable.
- **Détection de réutilisation** : si un refresh token déjà tourné est présenté à nouveau
  (signe probable de vol), toute la famille de sessions qui en descend est révoquée
  immédiatement et un événement de sécurité critique est journalisé.
- **Aucun token permanent** n'existe dans le système.

## 5. Hachage des secrets

Argon2id pour tout secret choisi/proposé par un humain (PIN de connexion, PIN
transactionnel, code OTP) — jamais un simple SHA-256, jamais un algorithme maison.
Comme un PIN à 6 chiffres n'a que 1 000 000 de valeurs possibles (bien moins que
l'entropie d'un mot de passe), le paramétrage est volontairement plus coûteux que la
base OWASP générique, pour rendre une attaque hors-ligne sur une fuite de hash
significativement plus chère :

| Paramètre | Mots de passe génériques (OWASP) | PIN / OTP (POOSSER) |
|---|---|---|
| Coût mémoire | 19 456 KiB (~19 Mo) | 65 536 KiB (~64 Mo) |
| Coût temps | 2 | 3 |
| Parallélisme | 1 | 1 |

Ces valeurs sont dans `.env` (`ARGON2_PIN_MEMORY_KB`, `ARGON2_PIN_TIME_COST`, etc.), non
codées en dur, conformément à l'exigence de configuration externalisée.

## 6. Niveaux d'authentification (step-up)

Le système est conçu autour d'un pattern **step-up token à revendications `amr`**
(*authentication methods reference*), extensible sans réécriture :

- **Niveau 1 — session normale** : un access token valide suffit. Obtenu via PIN de
  connexion ou biométrie (la biométrie ne fait que déverrouiller localement le refresh
  token déjà émis — voir §7 — elle n'est jamais vérifiée par le serveur).
- **Niveau 2 — action sensible** : le client appelle `POST /auth/step-up` avec le PIN
  transactionnel ; en cas de succès, le serveur émet un **step-up token** de courte durée
  (5 minutes) avec `amr: ["transaction_pin"]`. Les futurs endpoints financiers exigeront
  ce token via un middleware `requireStepUp(["transaction_pin"])`.
- **Niveau 3 — action à haut risque** : même mécanisme, mais le middleware peut exiger
  `requireStepUp(["transaction_pin", "otp"])` ou `["transaction_pin", "biometric_assertion"]`
  — il suffira de combiner plusieurs preuves dans un seul appel à `/auth/step-up` sans
  toucher au reste de l'architecture.

Ce pattern est implémenté dès maintenant (endpoint `/auth/step-up` fonctionnel), même si
aucune fonctionnalité financière n'existe encore à protéger — conformément à la demande
de préparer l'architecture pour son intégration future sans mock.

## 7. Biométrie

Le serveur ne reçoit, ne stocke et ne transmet **jamais** de donnée biométrique. La
biométrie est gérée entièrement par l'OS du téléphone (Android BiometricPrompt / iOS
Face ID-Touch ID via Keychain), qui déverrouille localement un secret déjà stocké dans
l'enclave sécurisée de l'appareil (typiquement le refresh token courant, ou une clé
permettant de le déchiffrer). Côté serveur, rien ne distingue une connexion « biométrie »
d'une connexion « refresh token présenté normalement » — c'est un choix délibéré : cela
évite d'avoir à faire confiance à une affirmation du client du type
`{"biometricVerified": true}`, qui serait falsifiable. Le PIN reste toujours disponible en
repli et n'est jamais désactivé quand la biométrie est active.

## 8. Gestion des appareils

Chaque connexion réussie associe la session à un `device` identifié par une empreinte
stable générée et conservée côté client (stockage sécurisé, pas un simple identifiant
matériel volatile). Un appareil inconnu déclenche un événement `new_device` (§9). Les
endpoints `GET /auth/devices`, `DELETE /auth/devices/:id` et
`POST /auth/devices/revoke-others` permettent à l'utilisateur de voir et de révoquer ses
appareils ; révoquer un appareil invalide immédiatement toutes ses sessions actives
(`sessions.status = 'revoked'`), donc son prochain appel avec l'ancien access token
échouera dès qu'il expirera (≤15 min) et son refresh token sera rejeté immédiatement.

## 9. Détection de risque et journalisation

`riskService` calcule un signal simple et réel (pas simulé) à partir des données déjà en
base : l'appareil est-il nouveau pour cet utilisateur ? y a-t-il eu une salve d'échecs
récents sur ce téléphone ou cette IP (`login_attempts`) ? Le résultat déclenche soit un
simple événement `new_device` notifiable côté client, soit un durcissement (verrouillage
temporaire). Conformément à la mission, ni l'IP ni la géolocalisation ne sont jamais
traitées comme une preuve d'identité absolue — seulement comme un signal parmi d'autres.
L'architecture des `security_events` est conçue pour accueillir plus tard des signaux
supplémentaires (réputation IP, géolocalisation approximative) sans changement de schéma
(`metadata jsonb`).

## 10. Rate limiting

Chaque limite est nommée, configurable via `.env`, et appliquée par une fonction
générique `checkRateLimit(key, limit, windowSeconds)` adossée à `rate_limit_buckets`
(fenêtre fixe). Valeurs par défaut (modifiables sans toucher au code) :

| Action | Limite par défaut |
|---|---|
| Demande d'OTP par téléphone | 3 / 15 min |
| Demande d'OTP par IP | 10 / heure |
| Délai minimum avant renvoi d'OTP | 60 secondes |
| Vérification d'OTP par téléphone | 10 / 15 min (+ 5 tentatives max par challenge) |
| Connexion (PIN) par téléphone | 5 échecs / 15 min → verrouillage temporaire |
| Connexion (PIN) par IP | 20 / 15 min |
| Récupération de compte par téléphone | 3 / 24 h |
| Changement de PIN | 5 / heure |

## 11. Internationalisation

Tous les messages utilisateur sont externalisés dans `src/i18n/{fr,en}.json`, jamais codés
en dur dans la logique métier. La locale est déterminée par un en-tête `Accept-Language`
ou le champ `locale` du profil, avec repli sur le français.

## 12. Ce que ce chantier NE couvre PAS (délimitation explicite du périmètre)

Pour rester honnête sur le périmètre validé avec le porteur du projet : ce chantier livre
l'API d'authentification et sa base de données, testables en HTTP/tests automatisés. Il
ne comprend pas d'écrans Flutter ni de branchement du prototype HTML existant — ce sont
des extensions possibles, à traiter comme des chantiers séparés une fois ce socle validé.
