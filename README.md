# POOSSER — Auth API

Système complet d'inscription, connexion et sécurité de compte pour POOSSER. Backend Node.js/TypeScript + Express + PostgreSQL, sans mock sécuritaire : toute vérification importante (PIN, OTP, session, appareil, step-up) est effectuée côté serveur et re-vérifiée en base à chaque requête protégée.

Le socle d'authentification est **backend + base de données uniquement** (voir `docs/ARCHITECTURE.md` §12) : aucun client (web, mobile, prototype HTML) n'y était câblé à l'origine. Un module métier (`/api/*` — transactions, budgets, épargne, tontines, planner financier) a depuis été ajouté sur ce même back-end ; le prototype HTML n'y est pas encore relié (voir la feuille de route du projet).

## 1. Documentation

| Document | Contenu |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Architecture, schéma de base de données, stratégie de jetons, step-up, biométrie, gestion des appareils, journalisation, rate limiting, i18n |
| [`docs/API.md`](docs/API.md) | Référence complète des endpoints d'authentification (17) et métier (`/api/*`), paramètres, validations, réponses, erreurs |
| [`docs/SECURITY_REPORT.md`](docs/SECURITY_REPORT.md) | Audit de sécurité Phase 4 : vulnérabilités trouvées/corrigées, défenses par type d'attaque, résultats de tests, limites connues |
| `.env.example` | Modèle documenté de toutes les variables d'environnement requises |

## 2. Prérequis

- Node.js 20+ et npm
- PostgreSQL 16 (une instance native ; aucune dépendance à Docker)

## 3. Installation

```bash
npm install
```

## 4. Configuration

```bash
cp .env.example .env
```

Puis renseigner dans `.env` :

- `DATABASE_URL` : connexion vers une base PostgreSQL existante (ex. `postgresql://user:pass@localhost:5432/poosser_auth`).
- `JWT_ACCESS_SECRET`, `JWT_OTP_TICKET_SECRET`, `JWT_STEPUP_SECRET` : trois secrets **distincts**, ≥32 caractères. Générer avec :
  ```bash
  openssl rand -base64 48
  ```
- `SMS_PROVIDER` : `console` en développement (aucun SMS réel, le code OTP est journalisé côté serveur avec le champ `otpDevOnly`) ; `africastalking` ou `twilio` en production, avec les clés correspondantes renseignées (sinon le démarrage échoue volontairement — jamais d'envoi simulé silencieux).

Toutes les autres variables (durées de vie des jetons, paramètres Argon2id, tous les seuils de rate limiting, pays par défaut pour la normalisation des numéros, locale par défaut, origines CORS) ont des valeurs par défaut raisonnables mais **entièrement surchageables**, aucune n'est codée en dur dans le code source.

## 5. Base de données

Les migrations SQL (`migrations/001_*.sql` à `018_*.sql`) sont appliquées automatiquement au démarrage du serveur, et peuvent aussi être lancées manuellement :

```bash
createdb poosser_auth        # si la base n'existe pas encore
npm run migrate
```

## 6. Démarrage

```bash
npm run dev      # développement, rechargement automatique
npm run build && npm start   # production
```

Le serveur écoute sur `PORT` (4000 par défaut) et expose `GET /health`.

## 7. Tests automatisés

La suite (Vitest + Supertest) tourne contre une **vraie base PostgreSQL de test**, séparée de la base de développement — aucune logique de sécurité n'est mockée ; seule la frontière d'envoi de SMS est remplacée par une capture en mémoire (un vrai SMS ne peut pas être reçu par une suite automatisée).

```bash
createdb poosser_auth_test
cp .env.example .env.test
# éditer .env.test : NODE_ENV=test, DATABASE_URL pointant vers poosser_auth_test, PORT différent (ex. 4001)
npm run migrate    # avec .env.test chargé, ou directement contre poosser_auth_test
npm test
```

Résultat actuel (voir `docs/SECURITY_REPORT.md` §11 pour le détail par scénario) :

```
 Test Files  8 passed (8)
      Tests  62 passed (62)
```

`npm run typecheck` doit également passer sans erreur (`tsc --noEmit`).

## 8. Compte de test

```bash
npm run seed:test-account
```

Crée (ou confirme s'il existe déjà) un compte de test prêt à l'emploi, sans passer par le cycle OTP :

| Champ | Valeur |
|---|---|
| Téléphone | `+237690000099` |
| PIN de connexion | `246813` |
| Profil | `salarie` |

Utilisez ces identifiants directement sur l'écran de connexion du prototype (`poosser_prototype.html`) — le compte démarre sans aucune donnée. Le script (`scripts/seed-test-account.ts`) appelle le même service que la vraie route `POST /auth/register`, juste sans exiger de ticket OTP au préalable : c'est un outil de développement local, la route HTTP réelle continue d'exiger un OTP valide pour tout le monde. Idempotent — relancez-le sans risque, y compris sur une base fraîchement migrée.

Vérification manuelle possible aussi via :

```bash
curl -X POST http://localhost:4000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"phone":"+237690000099","pin":"246813","device":{"fingerprint":"any-client-fingerprint","name":"Mon appareil","platform":"web"}}'
```

## 9. Résumé de l'architecture

- **Identifiant primaire** : numéro de téléphone (E.164, aucun pays supposé).
- **Vérification téléphonique** : OTP à 6 chiffres, haché (jamais en clair), à usage unique, limité en fréquence à plusieurs niveaux (par téléphone, par IP, cooldown de renvoi).
- **Connexion** : PIN POOSSER à 6 chiffres (Argon2id), avec verrouillage temporaire après échecs répétés.
- **Jetons** : access token JWT courte durée (15 min) + refresh token opaque longue durée avec rotation obligatoire et détection de réutilisation (révocation immédiate de toute la famille en cas de vol détecté).
- **Appareils** : chaque connexion est associée à un appareil identifié, listable et révocable individuellement ou globalement, avec invalidation immédiate des sessions concernées.
- **PIN transactionnel** : secret **distinct** du PIN de connexion, base d'un système d'authentification à paliers (`amr` : normal / PIN ou biométrie ; sensible : PIN transactionnel ; à haut risque : PIN transactionnel + OTP/biométrie) prêt à protéger de futures routes financières sans réécriture.
- **Biométrie** : jamais gérée côté serveur — uniquement un déverrouillage local d'un identifiant déjà protégé, avec PIN toujours disponible en repli.
- **Journal d'audit** : `security_events`, avec redaction systématique des champs sensibles dans les logs applicatifs.

Schéma de base de données complet (10 tables + tables de support) : voir `docs/ARCHITECTURE.md` §3.

## 10. Fichiers du projet

```
src/
  config/env.ts              Validation Zod de toute la configuration (fail-fast au démarrage)
  db/pool.ts, migrate.ts     Pool PostgreSQL, transactions, migrateur SQL maison
  lib/                       crypto (Argon2id, OTP, tokens opaques), jwt, phone, errors, logger
  i18n/                      Catalogues de messages fr/en
  services/
    sms/                     Interface SmsProvider + Console/AfricasTalking/Twilio
    otpService, pinService, userService, sessionService, deviceService,
    riskService, securityEventService, rateLimiter
  middleware/                auth (access token + step-up), validate, rateLimit, errorHandler
  validators/authSchemas.ts  Schémas Zod de toutes les requêtes
  routes/auth.ts             Les 17 endpoints
  app.ts, server.ts
migrations/                  001 à 013, appliquées par un runner maison (schema_migrations)
tests/                       7 fichiers, 50 tests, contre une vraie base PostgreSQL
docs/                        ARCHITECTURE.md, API.md, SECURITY_REPORT.md
.env.example                 Modèle documenté de toute la configuration
```

## 11. Variables d'environnement requises

Voir `.env.example` — chaque variable y est commentée. Aucun secret n'est présent dans le code source ; `.env` et `.env.test` sont gitignorés.

## 12. Sécurité

Voir `docs/SECURITY_REPORT.md` pour l'audit complet, y compris les deux vulnérabilités trouvées et corrigées pendant la vérification de ce chantier (perte d'événements de sécurité par violation de clé étrangère à l'inscription, et détection de réutilisation de refresh token neutralisée par un rollback de transaction), la couverture des attaques listées au cahier des charges, et les limites connues / améliorations futures.
