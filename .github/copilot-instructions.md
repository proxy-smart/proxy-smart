# Copilot Cloud Agent Instructions -- Proxy Smart

## Architecture Overview

Proxy Smart is a SMART on FHIR authorization proxy. Components in CI:

| Component | Port | Purpose |
|-----------|------|---------|
| **Keycloak** | 8080 | Identity provider (OIDC/OAuth2) |
| **Backend (Elysia/Bun)** | 8445 | Auth proxy -- authorize, token, introspect, userinfo |
| **HAPI FHIR** | 8081 | FHIR R4 server (test data) |
| **Inferno** | 8080 | SMART STU2.2 compliance test runner (Ruby) |
| **PostgreSQL** | 5432 | Keycloak persistence |
| **Redis** | 6379 | Inferno persistence |

### OAuth2 Token Flow

```
Client → /auth/authorize → Keycloak login → redirect with code
Client → /auth/token (code + PKCE) → Backend proxies to Keycloak → access_token
Client → /auth/introspect (token) → Backend adds admin-service Basic auth → Keycloak introspect
```

The backend enriches introspection responses with SMART launch context from the TokenContextStore (session-based, per-token JTI):
`patient`, `encounter`, `fhirUser` are applied from the store and `fhir_user` → `fhirUser` normalization is done.

## Key Files

| File | Controls |
|------|----------|
| `keycloak/realm-export.json` | Users, clients, secrets, scopes, protocol mappers |
| `testing/{env}/inferno-config.json` | Test credentials, URLs, client IDs per environment |
| `.github/workflows/smart-compliance-tests.yml` | CI env vars, service containers, test orchestration |
| `.github/scripts/inferno-oauth-automation.js` | Playwright-based OAuth flow for Inferno tests |
| `backend/src/routes/auth/oauth/` | Token proxy, introspection, authorize redirect |
| `scripts/seed/fhir-seed-bundle.json` | FHIR transaction bundle for test data |
| `docker-compose.development.yml` | Local dev stack config |

## Keycloak Realm Import Gotchas

**CRITICAL**: Keycloak's `--import-realm` does **NOT** resolve `${VAR:-default}` bash-style env var syntax in JSON credential values. The literal string (including `${}` characters) is stored as the password/secret.

- **DO**: Use plain values in `realm-export.json` (e.g., `"value": "DevD0c!2024"`)
- **DON'T**: Use `"value": "${DOCTOR_PASSWORD:-DevD0c!2024}"` -- this stores the literal string
- Production deployments override secrets via env vars on the Keycloak container, not via the JSON

Keycloak's own template variables like `${profileScopeConsentText}` and `${role_default-roles}` are fine -- those are resolved by Keycloak internally.

## Config Consistency Rules

These values MUST match across files:

| Source (realm-export.json) | Must match in |
|---------------------------|---------------|
| User `credentials[].value` | `testing/*/inferno-config.json` → `test_user.password` |
| Client `secret` | CI workflow `KEYCLOAK_ADMIN_CLIENT_*` env vars |
| Client `redirectUris` | `inferno-config.json` → `redirect_uris` |
| Client `webOrigins` | Inferno base URL |

## FHIR Seed Bundle Rules

The file `scripts/seed/fhir-seed-bundle.json` is a FHIR transaction bundle:

- All entries use `PUT` method (idempotent upsert)
- **`fullUrl` MUST match `request.url`** for PUT entries (e.g., `"fullUrl": "Patient/test-patient"`)
- **DO NOT** use `urn:uuid:` for `fullUrl` with PUT -- HAPI FHIR rejects this with HTTP 400
- `urn:uuid:` is only valid with `POST` (server-assigned ID) entries

## Common Failure Patterns

| Error Signature | Root Cause | Fix Location |
|----------------|-----------|-------------|
| `"Invalid username or password"` | realm-export password ≠ test config password | `keycloak/realm-export.json` credentials + `testing/*/inferno-config.json` |
| Introspection `401 Authentication failed` | admin-service client secret mismatch | `keycloak/realm-export.json` client secret + CI workflow env |
| FHIR seed `400` | `fullUrl` uses `urn:uuid:` with PUT method | `scripts/seed/fhir-seed-bundle.json` |
| Token exchange `400` | redirect_uri or client_id mismatch | `keycloak/realm-export.json` redirectUris + `inferno-config.json` |
| `"Account is not fully set up"` | Keycloak requires user action (e.g., email verify) | `keycloak/realm-export.json` user `requiredActions` must be empty |
| CORS errors on token endpoint | webOrigins missing for client | `keycloak/realm-export.json` client `webOrigins` |
| `"Client not found"` | client_id in test config doesn't match realm | `keycloak/realm-export.json` `clientId` + `testing/*/inferno-config.json` |

## Test Environments

| Branch | Stage | Target |
|--------|-------|--------|
| `dev/*`, `develop/*` | dev | Local CI (services as containers) |
| `develop` | alpha | Dev-only release (no live deployment) |
| `test` | beta | Deployed (VPS) |
| `main` | production | Deployed (AWS) |

The CI workflow auto-detects the stage from the branch. Local stages start Keycloak + HAPI FHIR as containers. Deployed stages test against remote backends.

## Editing Guidelines

- Keep `realm-export.json` passwords as plain text (not env var syntax)
- When changing a password/secret, update ALL matching locations (see consistency rules)
- Test configs are in `testing/{dev,alpha,beta,production}/inferno-config.json`
- The backend reads `KEYCLOAK_ADMIN_CLIENT_ID` and `KEYCLOAK_ADMIN_CLIENT_SECRET` from env
- Never commit real production secrets -- only dev/test defaults
