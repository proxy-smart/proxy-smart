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
- [x] `associated_endpoints` (SMART 2.1, experimental): the proxy's App State endpoint, with `capabilities: ["smart-app-state"]`

Keycloak's grant and response types are advertised unfiltered, so the list can include grants such as `password` that SMART apps should not use.

### Capabilities advertised by default

- [x] `launch-ehr`, `launch-standalone`
- [x] `authorize-post`: `POST /auth/authorize` takes the same parameters as a form body and runs the same handler as `GET`
- [x] `client-public`, `client-confidential-symmetric`, `client-confidential-asymmetric`
- [x] `sso-openid-connect`
- [x] `context-ehr-patient`, `context-ehr-encounter`, `context-standalone-patient`, `context-standalone-encounter`
- [x] `context-banner`, `context-style`: `need_patient_banner` and `smart_style_url` are returned when the EHR launch supplies them
- [x] `permission-offline`, `permission-online`, `permission-patient`, `permission-user`, `permission-v1`, `permission-v2`
- [x] `smart-app-state` (SMART 2.1, experimental), see App State below

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
- [x] Encounter picker for `launch/encounter` (`packages/auth/src/encounter-selection.ts`, routes `GET /auth/encounter-search` and `POST /auth/encounter-select`). Once the patient is settled, by the patient picker or from a Patient `fhirUser`, the picker offers that patient's encounters from `Encounter?patient=<id>&_sort=-date`, at most 50, and the chosen id reaches the token response as `encounter`. Only an encounter the search returned is accepted. A patient with no encounters, or a search that failed, may proceed without one
- [x] `launch/encounter` alone also starts patient selection, since the encounter has to belong to a patient
- [x] The patient submission is refused unless the callback gate cleared the session for the picker, so a session key cannot name an arbitrary patient

The encounter step is skipped under `prompt=none`, and when the patient is only resolved at the token endpoint (a Person `fhirUser` with no identity chosen at the callback). The token then carries no `encounter`, which the spec allows, since providing requested context is a SHOULD for the EHR.

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

### Access FHIR API

- [x] The resource server validates the token (signature, issuer, expiry, revocation) and that its scopes cover the request (see Scopes)
- [x] "The resource server also validates that the `aud` parameter associated with the authorization matches the resource server's own FHIR endpoint": a FHIR request's token is bound to the server it reaches when its `aud` holds that server's FHIR base (route base, RFC 8707 resource URL or upstream base, exact match) or the resource client whose `resource_url` is that base, narrowed to it. A token for another FHIR server, or for another client of the realm, is refused with `401 invalid_token` under `FHIR_AUDIENCE_ENFORCEMENT=enforce` and logged with the reason under `audit-only` (`backend/src/lib/fhir-audience-binding.ts`)
- [ ] Audience binding enforced by default: the default is `audit-only`, because deployed tokens issued before the resource indicator was forwarded, and tokens of clients that bypass the proxy's authorize endpoint, carry `aud: account`. Only one FHIR resource client (`fhir-resource-server`) exists, holding one server's base, so on a deployment with several FHIR servers the tokens for the others cannot be narrowed to their base yet
- [x] A SMART app's server restriction (`serverAccessType` `selected-servers` or `user-person-servers`, `allowedServerIds`) holds on every FHIR request its tokens make, batch and transaction entries and MCP tool calls included; `403 server_not_permitted` otherwise, `503` when Keycloak cannot be asked (`backend/src/lib/client-server-access.ts`)

## Scopes

- [x] SMART v2 resource scopes `patient/`, `user/`, `system/` with `cruds` (`backend/src/lib/smart-access-control.ts`, parsed in `backend/src/lib/smart-scope-grants.ts`)
- [x] SMART v1 `read`, `write` and `*`, accepted at enforcement as `rs`, `cud` and `cruds`
- [x] "Valid suffixes are a subset of the in-order string `.cruds`": an out-of-order or repeated suffix (`.sr`, `.dus`, `.rr`) grants nothing, and the admin API refuses to create such a scope (`SMART_SCOPE_PATTERN`, `isSMARTScope`)
- [x] Interactions mapped to permissions as the spec's table does: read, vread and instance history are `r`; GET search, `POST _search`, type-level history and system-level history are `s`; POST is `c`; PUT and PATCH are `u`; DELETE and `$erase` are `d`
- [x] Enforcement defaults to `enforce`; `audit-only` logs and allows
- [x] A search or history across all resource types at the server base (`[base]?_type=`, `POST [base]/_search`, `[base]/_history`) needs an unconstrained wildcard search scope such as `system/*.rs`, and an authenticated caller. A paging link (`?_getpages=`) needs a valid token only
- [x] `_include` and `_revinclude` (with `:iterate`) need an unconstrained `r` or `s` scope for every type they return, in the URL or the form body of a `POST _search`. An include that does not name the type it returns (`Observation:subject`, `*`) is refused unless the token holds an unconstrained wildcard read scope (`backend/src/lib/smart-include-access.ts`)
- [x] A compartment search such as `Patient/123/Observation` is judged by the type it returns, so it needs an `Observation` scope
- [x] Batch Bundles: each entry runs through the same per-request pipeline as a single request (operation policy, consent, tenant isolation, scopes, patient compartment, capability normalisation) and the answer is a `batch-response`. A refused entry carries an OperationOutcome and does not fail the others (`backend/src/lib/fhir-bundle-access.ts`, `backend/src/lib/fhir-request-pipeline.ts`)
- [x] Transaction Bundles: every entry gets the same decisions. One refusal refuses the transaction with an OperationOutcome naming the entry; an admitted transaction is forwarded upstream unchanged. A search the compartment, tenant or scope constraint would have to narrow is admitted only when the narrowing is already in its query
- [x] Bundle bodies are validated: a JSON Bundle of type `batch` or `transaction`, at most `FHIR_BUNDLE_MAX_ENTRIES` entries (default 100), each with `request.method` and a `request.url` relative to, or absolute against, the proxy base
- [x] v2 scopes with search-parameter constraints (`patient/Observation.rs?category=...|laboratory`, `backend/src/lib/smart-scope-constraints.ts`). A search gets the constraint added (several constrained scopes on one parameter become a FHIR OR), a read by id is checked upstream with `_id` plus the constraint, a create or update is checked against the body, and an update or delete against the stored resource. An unconstrained scope for the same type grants full access. Patch, conditional writes, history, operations, `_include` and `_revinclude` are refused under a constrained scope, as is any constraint the proxy or the upstream server cannot evaluate
- [ ] Constraints on writes are evaluated locally only for common token parameters (`category`, `code`, `status`, `clinical-status`, `verification-status`, `intent`, `type`, `class`, `identifier`, `gender`, `priority`, `criticality`); anything else refuses the write
- [ ] Issuing constrained scopes end to end: the admin scope tooling lists and creates them as SMART scopes, but no Inferno run or live Keycloak test yet shows a client scope named with a `?` suffix reaching a token
- [x] `launch`, `launch/patient`, `launch/encounter`, `openid`, `fhirUser`, `profile`, `offline_access`, `online_access`
- [x] `online_access` gets Keycloak's session-bound refresh token, which stops working once the user's SSO session ends (30 minutes idle, 10 hours at most in the shipped realm). `offline_access` gets an offline token, which outlives the session and needs the `offline_access` realm role. A refresh token is also issued when neither scope is requested, which SMART allows

### Patient compartment

A grant through a `patient/` scope can be narrowed to the token's patient, controlled by `ROLE_BASED_FILTERING_MODE`:

- `enforce` narrows searches to the patient (`_id=<id>` for Patient searches), refuses cross-patient reads, and refuses a patient-scoped token that carries no patient
- `audit-only` evaluates the same decisions, upstream ownership checks included, logs what `enforce` would change and changes nothing, for a `patient/` grant and a user who is a patient alike. This is the default in every environment
- `disabled` turns the filter off

Each deployment declares its mode in its environment rather than inheriting the code default.

- [x] Reads cover every type in the FHIR R4 Patient CompartmentDefinition (`backend/src/lib/patient-compartment/definition.ts`), each narrowed by its own search parameter (`patient`, or `subject`, `member`, `actor` where R4 has no `patient`), including `Appointment`, `Composition`, `List`, `Provenance`, `Claim`, `ExplanationOfBenefit`, `EpisodeOfCare`, `RelatedPerson`, `AdverseEvent` and `DeviceUseStatement`. The configurable `PATIENT_SCOPED_RESOURCES` list is gone
- [x] Server-base searches and history (`[base]?_type=`, `[base]/_history`, `POST [base]/_search`, base operations) and type-level history and operations on compartment types (`Observation/_history`, `Patient/$everything`) are refused, since no search parameter can confine them; an instance operation checks ownership first, whatever its method
- [x] Searches sent as `POST [type]/_search` are narrowed like `GET` searches, through the URL
- [x] `Patient.link`: "the server documentation SHALL describe its authorization behavior". Linked and merged Patient records are not part of the compartment; the grant reaches the one patient its context names, by id (docs/fhir-proxy.md, Linked Patients)
- [x] Writes stay in the patient's compartment, per the FHIR R4 Patient CompartmentDefinition (`backend/src/lib/patient-compartment/`): a create's body, an update's stored resource and new body, a patch's stored resource and a delete's stored resource must reference the in-context patient and no other patient. A patch may not touch `id` or a compartment element. Types outside the compartment, unresolvable references, non-JSON bodies, conditional and cascading writes are refused. The same rule confines a user who is a patient, write entries in batch and transaction Bundles, and the per-server MCP tools

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
- [x] That context is shared through PostgreSQL when `DATABASE_URL` (or the `PG*` parts) is set, so any node answers for a token another node issued (`backend/src/lib/token-context-store.ts`). Without a database it is held per process, and a multi-node deployment needs sticky routing

## Token revocation

`POST /auth/revoke` (`backend/src/routes/auth/oauth/revocation.ts`) proxies Keycloak's RFC 7009 endpoint.

- [x] A confidential client authenticates with HTTP Basic (passed through unchanged), `client_secret`, or a `private_key_jwt` assertion that the proxy verifies and re-signs; a public client sends only `client_id`. A request naming no client gets `401 invalid_client`
- [x] An unknown, invalid or expired token answers `200` (RFC 7009 §2.2); a token issued to another client is refused by Keycloak
- [x] A revoked access token's launch context is dropped, and the proxy's local token validation refuses its `jti` until it would have expired
- [x] The revoked-`jti` list reaches every node through PostgreSQL when a database is configured, within five seconds; without one it is per-process, and other nodes accept a revoked access token until it expires

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

## Task-based launch (SMART 2.1, experimental)

`POST /auth/launch/task` (`backend/src/routes/auth/oauth/task-launch.ts`, see [Task launch](./task-launch.md)) acts on a launch Task, given inline or as a reference that is read through the FHIR proxy with the caller's token, so scope, consent and tenant rules apply.

- [x] `task-ehr-launch` and `task-standalone-launch` validated against their profiles: `Task.code` from `smart-codes`, exactly one `smartonfhir-application` input, at most one `smartonfhir-appcontext` (`backend/src/lib/launch-task-profile.ts`)
- [x] EHR launch: a launch code minted from `Task.for` and `Task.encounter` under the same authorization as `POST /auth/launch` (`backend/src/routes/auth/oauth/launch-mint.ts`), answered with the app launch URL carrying `iss` and `launch`
- [x] Standalone launch: the app launch URL with `iss` only
- [x] The application URL must be the `launch_url` of exactly one registered SMART app, and the launch code is bound to that client
- [x] `appContext` returned as is in the token response, as for a CDS Hooks Link; `POST /auth/launch` accepts it too
- [x] Context references must point at the server the launch is for; `cancelled` and `entered-in-error` Tasks are refused with `409`
- [ ] Task `status` and `output` after launch: the specification defines none, so the Task is left unchanged

## App State (SMART 2.1, experimental)

The proxy hosts the App State endpoint itself at `{BASE_URL}/app-state`, apart from the upstream FHIR servers, which it may not be able to write to (`backend/src/lib/app-state/`, routes in `backend/src/routes/app-state.ts`, see [App State](./app-state.md)).

- [x] `POST /Basic`, `PUT` and `DELETE /Basic/[id]`, `GET /Basic?code=&subject=`, and `subject:missing=true` for global state; a CapabilityStatement at `/app-state/metadata` instantiating `smart-app-state-server`
- [x] Search values percent-decoded only, so a literal `+` in a code is a plus; one code per search; an empty searchset carries no `entry`
- [x] `smart-app-state-basic` rules: exactly one Coding, no `id` or `meta.versionId` on create, an absolute subject of a permitted type on a FHIR server the proxy serves, top-level `valueString` extensions only, and a 256 KB body unless raised with `APP_STATE_MAX_RESOURCE_BYTES`
- [x] `ETag` on every response; `If-Match` required on update and delete, `400` when it is missing (FHIR R4 http) and `412` for a stale version or a changed code or subject
- [x] Every request about a deleted id is a failed precondition (`412`), checked before the body or `If-Match`
- [x] Per-app, per-code permissions in the spec's six sets (query or modify, for the in-context patient, the in-context user, or global state) through `appStatePermissions` on SMART apps; `appStateCodes` and `appStateGlobalCodes` keep their meaning as shorthands
- [x] The subject bound to the in-context patient or user on the FHIR server the token's context belongs to (its `aud`, an absolute `fhirUser`, or the only server); refused in a multi-server deployment when that server cannot be determined
- [x] `patient/Basic.*` or `user/Basic.*` scopes, including `?code=` narrowing
- [x] The per-(code, subject) limit holds under concurrent creates (one transaction behind an advisory lock in PostgreSQL)
- [x] Stored in PostgreSQL (`smart_app_state`) when a database is configured, else in `DATA_DIR/app-state.json`; a database outage fails the request rather than splitting state across two stores
- [ ] State codes for apps registered by metadata document (CIMD), which have no Keycloak record to hold them

## Operational notes

These are not SMART requirements, but they decide how far the boxes above hold in a deployment.

- Rate limiting on the credential endpoints (`/auth/token`, `/auth/device`, `/auth/introspect`, `/auth/revoke`, `/auth/register`) is off unless `AUTH_RATE_LIMIT_PER_MINUTE` is set. It runs per route before body validation, and keys on the client address taken `TRUSTED_PROXY_HOPS` entries from the right of `X-Forwarded-For` (`backend/src/lib/client-ip.ts`), so a client cannot pick its own bucket. The audit and OAuth event logs record the same address.
- The `jti` replay cache and the launch-context store are shared through PostgreSQL when a database is configured; the `jti` is spent with a single `INSERT ... ON CONFLICT` and kept until the assertion's `exp` plus the 30-second clock skew. So is the list of access tokens revoked through `/auth/revoke`, which every node checks in memory and refreshes from the database every five seconds. Without a database all three are per-process. The rate limiter counts per process in either case.
- Backend tests run in-process against mocked Keycloak and FHIR upstreams; the Postgres stores above are also tested against a real Postgres in CI (`backend/test/shared-state-postgres.test.ts`). The Inferno runs above are the only end-to-end check against a live Keycloak and HAPI FHIR server.
