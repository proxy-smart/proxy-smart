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
- [x] `revocation_endpoint`, the proxy's `/auth/revoke`, also in the OAuth and OIDC discovery documents and the CapabilityStatement `oauth-uris` extension
- [x] `management_endpoint`: the consent app when one is configured (`CONSENT_APP_URL` or the consent `appUrl` setting), otherwise Keycloak's account console applications page, where the user sees and revokes the apps they authorized
- [ ] `associated_endpoints` (SMART 2.1, experimental)

Keycloak's grant and response types are advertised unfiltered, so the list can include grants such as `password` that SMART apps should not use.

### Capabilities advertised by default

- [x] `launch-ehr`, `launch-standalone`
- [x] `authorize-post`: `POST /auth/authorize` takes the same parameters as a form body and runs the same handler as `GET`
- [x] `client-public`, `client-confidential-symmetric`, `client-confidential-asymmetric`
- [x] `sso-openid-connect`
- [x] `context-ehr-patient`, `context-ehr-encounter`, `context-standalone-patient`
- [x] `context-banner`, `context-style`: `need_patient_banner` and `smart_style_url` are returned when the EHR launch supplies them
- [x] `permission-offline`, `permission-online`, `permission-patient`, `permission-user`, `permission-v1`, `permission-v2`

Not advertised, because they are not implemented:

- [ ] `context-standalone-encounter`: the standalone picker selects a patient only
- [ ] `smart-app-state`

## Authorization

### EHR launch

- [x] `POST /auth/launch` mints a signed launch code for an authenticated caller, carrying patient, encounter, fhirUser, intent, `fhirContext`, `need_patient_banner` and `smart_style_url` (`backend/src/routes/auth/oauth/launch.ts`)
- [x] `/auth/authorize` verifies the code, binds it to the requesting `client_id`, and loads its context into the session (`packages/auth/src/authorize-interceptor.ts`)
- [x] The context reaches the token response
- [x] An invalid or expired `launch` value, or one minted for another client, is refused: `error=invalid_request` with an `error_description`, `state` and RFC 9207 `iss` on the client's registered `redirect_uri`, or a `400` when that `redirect_uri` is not registered for the client

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
- [x] `jku` in client assertions: when present it must equal the client's registered JWKS URL, else `invalid_client`; the `jku` URL itself is never fetched

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
- [x] `online_access` gets Keycloak's session-bound refresh token, which stops working once the user's SSO session ends (30 minutes idle, 10 hours at most in the shipped realm). `offline_access` gets an offline token, which outlives the session and needs the `offline_access` realm role. A refresh token is also issued when neither scope is requested, which SMART allows

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
- [x] Introspection returns the absolute `fhirUser` of the token response, not the raw claim
- [ ] The `fhirUser` claim inside the `id_token` is Keycloak's raw user attribute and may be relative; only the token response and introspection values are made absolute. The proxy cannot re-sign Keycloak's `id_token`, and the attribute names no FHIR server, so an absolute value is only well defined for a single-server deployment

## Token introspection

`POST /auth/introspect` (`backend/src/routes/auth/oauth/introspection.ts`) proxies Keycloak's RFC 7662 endpoint.

- [x] The caller authenticates as a resource server, with HTTP Basic or `client_secret` / `client_assertion` in the body. A request without credentials gets `401 invalid_client`
- [x] Keycloak decides `active` for that caller, so a token is active only for a resource server in its audience
- [x] The response repeats the token response's launch context: `patient`, `encounter`, `fhirUser`, `fhirContext`, `intent`, `need_patient_banner`, `smart_style_url`, `tenant`, and the `act` chain of an exchanged token
- [ ] That context is held in memory on the issuing node, so a multi-node deployment needs sticky routing or a shared store

## Token revocation

`POST /auth/revoke` (`backend/src/routes/auth/oauth/revocation.ts`) proxies Keycloak's RFC 7009 endpoint.

- [x] A confidential client authenticates with HTTP Basic (passed through unchanged), `client_secret`, or a `private_key_jwt` assertion that the proxy verifies and re-signs; a public client sends only `client_id`. A request naming no client gets `401 invalid_client`
- [x] An unknown, invalid or expired token answers `200` (RFC 7009 §2.2); a token issued to another client is refused by Keycloak
- [x] A revoked access token's launch context is dropped, and the proxy's local token validation refuses its `jti` until it would have expired
- [ ] The revoked-`jti` list is per-process, so on a multi-node deployment the other nodes accept a revoked access token until it expires

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
- [ ] Standalone encounter selection

## Operational notes

These are not SMART requirements, but they decide how far the boxes above hold in a deployment.

- The `/auth` rate limiter in `backend/src/lib/rate-limit.ts` is mounted with local scope, so it does not run on the auth routes. It also keys on the leftmost `X-Forwarded-For` value, which a client can set. Rate limiting on `/auth` therefore comes from the infrastructure in front of the proxy, where there is any.
- The `jti` replay cache, the launch-context store, the revoked-token list and the rate limiter are all per-process.
- Backend tests run in-process against mocked Keycloak and FHIR upstreams. The Inferno runs above are the only end-to-end check against a live Keycloak and HAPI FHIR server.
