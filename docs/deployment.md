# Deployment

Proxy Smart uses Docker Compose for deployment. Multiple compose files target different environments.

## Compose Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | Base infrastructure (Keycloak + PostgreSQL) |
| `docker-compose.development.yml` | Development with Orthanc PACS, against public test FHIR servers |
| `docker-compose.prod.yml` | Production with built backend image and required secrets |
| `docker-compose.beta.yml` | Beta/staging environment |
| `docker-compose.caddy.yml` | Adds Caddy reverse proxy with automatic HTTPS |

## Quick Start (Development)

```bash
# Start base infrastructure
docker compose up -d

# Start development stack (adds Orthanc and the backend container)
docker compose -f docker-compose.development.yml up -d

# Run backend locally
cd backend && bun install && bun run dev
```

The development stack provides:
- **Keycloak** on port `8080` (admin/admin)
- **PostgreSQL** on port `5432`
- **Orthanc PACS** on port `8042` (HTTP and DICOMweb)
- **Backend** on port `8445`, either from the compose `app` service or locally with `bun run dev`

No FHIR server runs locally. `FHIR_SERVER_BASE` in the development compose points at the public `hapi.fhir.org` and `server.fire.ly` test servers; register your own through the admin UI to replace them.

## Production Deployment

### Prerequisites

Set required environment variables or use a `.env` file:

```bash
KC_DB_PASSWORD=<secure-password>
POSTGRES_PASSWORD=<secure-password>
KEYCLOAK_ADMIN_CLIENT_SECRET=<service-account-secret>
KEYCLOAK_REALM_FILE=<path to your realm-export.json>
```

### Bring your own realm

`Dockerfile.keycloak` builds a Keycloak image with the login theme, the feature
flags and the optimized build, and **no realm at all**. That is deliberate: a
realm names your users, clients and identity providers, so there is no sensible
default to ship. Keycloak with no realm fails loudly; Keycloak with someone
else's realm does not.

`KEYCLOAK_REALM_FILE` has no default for the same reason. Point it at your own
export and compose mounts it into the import directory.

To make one, start from `keycloak/realm-export.json` and then:

- remove the seeded `admin`, `doctor` and `testuser` accounts, whose passwords
  are published in this repository
- replace the `admin-service` client secret, likewise published
- keep the `default-roles-proxy-smart` composite declared in both
  `realm.defaultRole` and `roles.realm[]` (see
  [keycloak-features.md](keycloak-features)), or every user silently gets no roles

`backend/test/realm-export-importable.test.ts` encodes the constraints that stop
Keycloak booting — column-width limits and rejected fields. Point it at your file
with `REALM_EXPORT_PATHS=/path/to/realm-export.json bun test` to check it before
you deploy.

The backend enforces the secret rule at startup too: with `NODE_ENV=production`
it refuses to start when `KEYCLOAK_ADMIN_CLIENT_SECRET` is still the fixture
value.

### Deploy

```bash
docker compose -f docker-compose.prod.yml up -d
```

### Production Architecture

```
Internet  ──►  Caddy (HTTPS)  ──►  Backend (:8445)  ──►  FHIR Server(s)
                                       │
                                       ├──►  Keycloak (:8080)
                                       └──►  Orthanc PACS (optional)
```

The production compose builds the backend from `Dockerfile` and Keycloak from `Dockerfile.keycloak`:
- Backend image includes the Admin UI and Patient Picker as static files
- External SMART apps are deployed independently into the `apps_static` Docker volume
- Keycloak uses PostgreSQL for persistence
- Realm configuration is mounted from `$KEYCLOAK_REALM_FILE` (the image ships none)

### With Caddy (HTTPS)

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.caddy.yml up -d
```

Caddy provides automatic TLS certificate provisioning via Let's Encrypt.

## Services

### Keycloak

- **Image**: `quay.io/keycloak/keycloak:26.6.3`
- **Purpose**: OAuth 2.0 / OIDC identity provider
- **Health check**: HTTP on port 9000 (`/health/ready`)
- **Realm import**: Auto-imports whatever is in `/opt/keycloak/data/import/` on first start. The image ships no realm; supply one (see [Bring your own realm](#bring-your-own-realm))
- **Features**: `cimd`, `token-exchange`, `client-auth-federated`, `resource-indicators` (RFC 8707) enabled at build time

#### Seeded administrator (beta / prod)

The beta and prod realms live in the private `proxy-smart-infra` repository and
are layered onto the base image at deploy time. They declare
`max.nussbaumer@maxhealth.tech` as the initial administrator, and deliberately
the only one:

- No `credentials` block, so there is no seeded password to leak and no password
  login. The account authenticates through the maxhealth IdP.
- The IdP sets `trustEmail`, so the first brokered sign-in links to this account
  by email. `federatedIdentities` is intentionally not pinned, because the
  IdP-side user id differs per environment.
- It holds the `admin` composite, which grants every product's admin role.

Do not add `"//"` pseudo-comment keys to these files. Keycloak parses
`users[]` into `UserRepresentation`, which rejects unknown fields, and the whole
realm import fails with `Unrecognized field "//"` — which stops Keycloak from
starting at all. JSON has no comments; document intent here instead.

### PostgreSQL

- **Image**: `postgres:16-alpine`
- **Purpose**: Keycloak persistence
- **Init script**: `keycloak/database/init.sql` runs on first start
- **Volume**: `postgres_data` for data persistence

### Backend

- **Built from**: `Dockerfile` (multi-stage Bun build)
- **Port**: 8445
- **Serves**: Backend API, Admin UI (`/webapp/`), Patient Picker (`/patient-picker/`), App Store (`/apps/`)
- **Volume**: `apps_static` mounted at `/app/backend/public/apps` for externally deployed SMART apps
- **Key env vars**: See [Environment Variables](environment-variables)

> **App Deployment Model**: The backend Docker image includes only the Admin UI and Patient Picker (built in this repo). External SMART apps (Patient Portal, Consent App, DTR App) are deployed independently from their own repositories -- each app's CI builds static assets and deploys them into the shared `apps_static` Docker volume. The backend serves them from `/apps/{app-name}/`.

### Orthanc (Development)

- **Image**: `jodogne/orthanc-plugins:1.12.8`
- **Purpose**: DICOM PACS with DICOMweb support
- **Ports**: 8042 (HTTP/DICOMweb), 4242 (DICOM DIMSE)
- **Volume**: `orthanc_data_dev` for study persistence

## AWS CDK Deployment

The CDK stacks for Max Health's own AWS deployment live in the private
`proxy-smart-infra` repository, because they describe one operator's account
rather than the product. Self-hosting does not need them; the compose files
above are the supported path. They provide:
- ECS Fargate services
- RDS PostgreSQL
- CloudFront distribution
- ACM certificates
- VPC networking

## Networking

All services join the `proxy-smart-network` bridge network. Services communicate by container name:
- Backend → Keycloak: `http://keycloak:8080`
- Backend → FHIR: configured via `FHIR_SERVER_BASE`
- Backend → Orthanc: `http://orthanc:8042/dicom-web`
