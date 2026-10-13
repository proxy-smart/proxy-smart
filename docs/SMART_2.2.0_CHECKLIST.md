# SMART App Launch 2.2.0 Checklist

Implementation status of the [HL7 SMART App Launch](https://hl7.org/fhir/smart-app-launch/) requirements in Proxy Smart, checked against the code and against the Inferno runs described in [Compliance Reports](./compliance-reports.md). A box is ticked only where the behaviour exists in code and, where Inferno covers it, passes there. Paths are relative to the repository root.

The proxy sits in front of Keycloak and one or more FHIR servers. Keycloak authenticates users and issues tokens; the proxy owns the SMART surface: discovery, the authorize and token endpoints, launch context, introspection, and scope enforcement on FHIR requests.

## Conformance evidence

Inferno `smart_app_launch_test_kit` v1.0.0, suite `smart_stu2_2`, on 2026-10-13:

| Stage | Target | Result |
|---|---|---|
| `dev` | Local CI stack | 95 passed, 0 failed, 7 omitted of 102 |
| `beta` | Deployed VPS | 95 passed, 0 failed, 7 omitted of 102 |

The seven omitted tests are the TLS checks. They do not apply to the plain-HTTP CI stack, and were also switched off for `beta` until 2026-10-13; deployed stages now run them. Beta accepts TLS 1.2 and refuses 1.0 and 1.1. The four groups run are Standalone Launch, Token Introspection, Backend Services and EHR Launch. Production runs a read-only consent-enforcement probe rather than the suite; see [testing/README.md](https://github.com/proxy-smart/proxy-smart/blob/develop/testing/README.md).

## Discovery

`.well-known/smart-configuration` is served per FHIR server at `/{name}/{server}/{version}/.well-known/smart-configuration`, built by `backend/src/lib/smart-config.ts`.

- [x] `authorization_endpoint`, `token_endpoint`, `introspection_endpoint`, `registration_endpoint`, all absolute proxy URLs (SMART 2.1 absolute-URL rule)
- [x] `capabilities`, `scopes_supported` (both overridable with `SMART_CAPABILITIES` / `SMART_SCOPES_SUPPORTED`)
- [x] `code_challenge_methods_supported` with `S256` and never `plain`
- [x] `grant_types_supported`, `response_types_supported`, `token_endpoint_auth_methods_supported`, `token_endpoint_auth_signing_alg_values_supported`, passed through from Keycloak
- [x] `issuer` and `jwks_uri`, Keycloak's realm issuer and key set
- [x] `end_session_endpoint` (proxy `/auth/logout`) when Keycloak offers one
- [x] `user_access_brand_bundle` and `user_access_brand_identifier` (SMART 2.2, RECOMMENDED)
- [ ] `revocation_endpoint`: no revocation route exists
- [ ] `management_endpoint`: no management route exists
- [ ] `associated_endpoints` (SMART 2.1, experimental)

Keycloak's grant and response types are advertised unfiltered, so the list can include grants such as `password` that SMART apps should not use.

### Capabilities advertised by default

- [x] `launch-ehr`, `launch-standalone`
- [x] `client-public`, `client-confidential-symmetric`, `client-confidential-asymmetric`
- [x] `sso-openid-connect`
- [x] `context-ehr-patient`, `context-ehr-encounter`, `context-standalone-patient`
- [x] `context-banner`, `context-style`: `need_patient_banner` and `smart_style_url` are returned when the EHR launch supplies them
- [x] `permission-offline`, `permission-online`, `permission-patient`, `permission-user`, `permission-v1`, `permission-v2`

Not advertised, because they are not implemented:

- [ ] `authorize-post`: only `GET /auth/authorize` exists
- [ ] `context-standalone-encounter`: the standalone picker selects a patient only
- [ ] `smart-app-state`

## Authorization

### EHR launch

- [x] `POST /auth/launch` mints a signed launch code for an authenticated caller, carrying patient, encounter, fhirUser, intent, `fhirContext`, `need_patient_banner` and `smart_style_url` (`backend/src/routes/auth/oauth/launch.ts`)
- [x] `/auth/authorize` verifies the code, binds it to the requesting `client_id`, and loads its context into the session (`packages/auth/src/authorize-interceptor.ts`)
- [x] The context reaches the token response
- [ ] An invalid or expired `launch` value is ignored and the request continues without context, rather than being refused

The EHR builds the app's launch URL with `iss` and `launch`; the proxy does not.

### Standalone launch

- [x] Patient picker for `launch/patient` (`packages/patient-picker`, routes in `backend/src/routes/auth/oauth/context-selection.ts`)
- [x] A `patient/` resource scope triggers the same handling as `launch/patient`. SMART lets the EHR either refuse such a request or infer the scope; the proxy infers it (`hasPatientCompartmentScope` in `@proxy-smart/auth`)
- [ ] Encounter selection

### Authorization request

- [x] `response_type=code`, `client_id`, `redirect_uri`, `scope`, `state`
- [x] `aud` (or RFC 8707 `resource`) validated against the configured FHIR servers before redirecting to Keycloak
- [x] PKCE with `S256`
- [x] RFC 9207 `iss` on the callback

### Token endpoint

- [x] Authorization code, refresh token, client credentials and RFC 8693 token exchange, forwarded to Keycloak (`backend/src/routes/auth/oauth/token.ts`)
- [x] Confidential symmetric clients authenticate with `client_secret_basic` or `client_secret_post`; the HTTP Basic header is passed to Keycloak unchanged
- [x] `private_key_jwt` assertions are verified by the proxy (iss = sub, `aud` = the proxy token endpoint, `exp` at most five minutes out, `jti` not reused, signature against the client's registered JWKS) and re-signed for Keycloak (`backend/src/routes/auth/backend-services.ts`). A `jti` is spent only once its signature verifies
- [x] Launch context added to the response: `patient`, `encounter`, `fhirContext`, `need_patient_banner`, `smart_style_url`, `intent`, `tenant`
- [x] `fhirUser` made absolute against the proxy FHIR base. A Person reference resolves to its Patient link for a patient-facing client and to its Practitioner link otherwise
- [x] `authorization_details` (RFC 9396) listing the FHIR servers the token is good for
- [x] `Cache-Control: no-store` and `Pragma: no-cache`
- [ ] `jku` in client assertions

## Scopes

- [x] SMART v2 resource scopes `patient/`, `user/`, `system/` with `cruds` (`backend/src/lib/smart-access-control.ts`)
- [x] SMART v1 `read`, `write` and `*`, accepted at enforcement as `rs`, `cud` and `cruds`
- [x] Interactions mapped to permissions: GET read is `r`, GET search and `POST _search` are `s`, POST is `c`, PUT and PATCH are `u`, DELETE and `$erase` are `d`
- [x] Enforcement defaults to `enforce`; `audit-only` logs and allows
- [x] A search across all resource types at the server base needs a wildcard resource scope such as `system/*.rs`
- [x] Batch and transaction Bundles at the server base are refused in `enforce` mode, because consent, tenant and compartment rules are applied per request path and cannot yet be applied per entry
- [ ] Batch and transaction Bundles with per-entry enforcement
- [ ] v2 scopes with search-parameter constraints (`patient/Observation.rs?category=laboratory`). These grant nothing at present, so they fail closed
- [x] `launch`, `launch/patient`, `launch/encounter`, `openid`, `fhirUser`, `profile`, `offline_access`, `online_access`
- [ ] `online_access` behaves differently from a session-bound refresh token: Keycloak issues the same session-bound refresh token for both

### Patient compartment

A grant through a `patient/` scope can be narrowed to the token's patient, controlled by `ROLE_BASED_FILTERING_MODE`:

- `enforce` adds `patient=Patient/<id>` to searches (`_id=<id>` for Patient searches), refuses cross-patient reads, and refuses a patient-scoped token that carries no patient
- `audit-only` logs what `enforce` would change and changes nothing. This is the default in every environment
- `disabled` turns the filter off

Each deployment declares its mode in its environment rather than inheriting the code default.

## fhirContext and fhirUser

- [x] `fhirContext` with `reference` entries (SMART 2.1)
- [x] `fhirContext` with `canonical` and `identifier` entries, plus `type` and `role` (SMART 2.2)
- [x] `PractitionerRole` as `fhirUser` (SMART 2.1), kept for clinician-facing clients
- [ ] The `fhirUser` claim inside the `id_token` is Keycloak's raw user attribute and may be relative; only the token response value is made absolute

## Token introspection

`POST /auth/introspect` (`backend/src/routes/auth/oauth/introspection.ts`) proxies Keycloak's RFC 7662 endpoint.

- [x] The caller authenticates as a resource server, with HTTP Basic or `client_secret` / `client_assertion` in the body. A request without credentials gets `401 invalid_client`
- [x] Keycloak decides `active` for that caller, so a token is active only for a resource server in its audience
- [x] The response repeats the token response's launch context: `patient`, `encounter`, `fhirUser`, `fhirContext`, `intent`, `need_patient_banner`, `smart_style_url`, `tenant`, and the `act` chain of an exchanged token
- [x] That context is shared through PostgreSQL when `DATABASE_URL` (or the `PG*` parts) is set, so any node answers for a token another node issued (`backend/src/lib/token-context-store.ts`). Without a database it is held per process, and a multi-node deployment needs sticky routing

## Backend Services

- [x] `client_credentials` with `private_key_jwt` signed RS384 or ES384, as the registered key allows, validated as described under Token endpoint
- [x] Client keys from a registered JWKS URL or inline JWKS, fetched with an SSRF guard and cached
- [x] `system/` scopes, enforced on every FHIR request; `$export` requires one (`backend/src/lib/fhir-operation-policy.ts`)

## User-access Brands

- [x] Brand Bundle at `/branding.json`, with ETag and `304` support (`backend/src/lib/brand-bundle.ts`)
- [x] Organization entries with the `organization-brand` and `organization-portal` extensions, from `BRAND_*` settings and the admin branding routes (`backend/src/routes/admin/branding.ts`)
- [x] One Endpoint per registered FHIR server, named after the server, with `endpoint-fhir-version`, connection type `hl7-fhir-rest`, and contact
- [x] One Organization per Keycloak Organization, linked by `partOf`, listing only the endpoints that organization may use
- [x] Bundle validated against the IG's constraints when built

Choosing a provider from the Brand Bundle ("Connect to my records") is the patient app's job, not the server's. Inside the organization, `useBranding` in `shared-ui` and the AIHR portal read the bundle the server advertises.

## Not implemented

- [ ] App State Persistence (SMART 2.1, experimental): `smart-app-state` capability, `associated_endpoints`, and the state API
- [ ] Task-based launch (SMART 2.1 `task-ehr-launch` and `task-standalone-launch` profiles)
- [ ] POST-based authorization (`authorize-post`)
- [ ] Token revocation and app management endpoints
- [ ] Standalone encounter selection

## Operational notes

These are not SMART requirements, but they decide how far the boxes above hold in a deployment.

- Rate limiting on the credential endpoints (`/auth/token`, `/auth/device`, `/auth/introspect`, `/auth/register`) is off unless `AUTH_RATE_LIMIT_PER_MINUTE` is set. It runs per route before body validation, and keys on the client address taken `TRUSTED_PROXY_HOPS` entries from the right of `X-Forwarded-For` (`backend/src/lib/client-ip.ts`), so a client cannot pick its own bucket. The audit and OAuth event logs record the same address.
- The `jti` replay cache and the launch-context store are shared through PostgreSQL when a database is configured; the `jti` is spent with a single `INSERT ... ON CONFLICT` and kept until the assertion's `exp` plus the 30-second clock skew. Without a database both are per-process. The rate limiter counts per process in either case.
- Backend tests run in-process against mocked Keycloak and FHIR upstreams; the Postgres stores above are also tested against a real Postgres in CI (`backend/test/shared-state-postgres.test.ts`). The Inferno runs above are the only end-to-end check against a live Keycloak and HAPI FHIR server.
