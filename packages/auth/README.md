# @proxy-smart/auth

Server-side SMART on FHIR STU 2.2.0 authorization proxy. Framework-agnostic and IdP-pluggable.

SMART App Launch asks an authorization server for things plain OAuth does not provide: a patient and encounter in context, a `fhirUser` the app can resolve, and scopes narrowed to a compartment. Most identity providers do none of that. This package sits in front of one that handles identity well and adds the SMART layer around it.

The proxy intercepts `/authorize`, holds launch context in a store while the user authenticates upstream, intercepts the callback, and enriches the token response on the way back. Nothing here binds to a web framework: every handler takes plain parameters and returns a `SmartProxyResult` describing what the caller should do.

## Install

```bash
bun add @proxy-smart/auth
```

```ts
import {
  handleAuthorize,
  handleCallback,
  handlePatientSelect,
  enrichTokenResponse,
  enrichIntrospection,
  MemoryStore,
  KeycloakAdapter,
} from '@proxy-smart/auth'
```

Subpath entries narrow the import: `./stores` for the store interface and implementations, `./idp` for the adapter interface, `./idp/keycloak` for the Keycloak adapter alone.

## The flow

```
  app                    proxy                      IdP
   │                       │                         │
   │─ GET /authorize ─────►│                         │
   │                       │ handleAuthorize()       │
   │                       │  store LaunchSession    │
   │                       │  rewrite redirect_uri ──►│
   │                       │                         │ user logs in
   │                       │◄─ GET /smart-callback ──│
   │                       │ handleCallback()        │
   │                       │  match session by state │
   │◄─ 302 (+ code) ───────│  (or → patient picker)  │
   │                       │                         │
   │─ POST /token ────────►│───────────────────────► │
   │                       │ enrichTokenResponse()   │
   │◄─ token + context ────│  patient, fhirUser, …   │
```

The proxy replaces the client's `redirect_uri` with its own callback so it can regain control after login. That is what makes the launch context possible, and it is also why this package has to validate redirect URIs itself: the IdP never sees the real client URI and can no longer check it.

## Handlers

`handleAuthorize(params, deps)` decides whether a request is a SMART launch at all, and if so creates a `LaunchSession`, resolves any EHR launch code, and returns a redirect to the IdP with the rewritten `redirect_uri`. It returns `AuthorizeInterceptResult`, carrying the `SmartProxyResult`, the `sessionKey`, and any `resolvedLaunchContext`. `AuthorizeInterceptorDeps` needs `config`, `store`, `idp`, and optionally a `logger` and a `validateAudience` callback for the `aud`/`resource` parameter.

`handleCallback(params, deps)` matches the IdP's callback back to a stored session by `state`, and either redirects to the client with the authorization code or diverts to the patient picker when standalone launch left the patient unresolved. `CallbackHandlerDeps` adds `patientPickerPath` (default `/patient-picker/`) to the same config, store and logger.

`handlePatientSelect(params, deps)` completes that diversion. Given `{ session, code, patient }` it binds the chosen patient to the session and returns the redirect that resumes the original flow.

`enrichTokenResponse(input, deps)` returns the `TokenEnrichment` to merge into the token response: `patient`, `encounter`, `fhirUser`, `intent`, `smart_style_url`, `tenant`, `need_patient_banner`, `fhirContext`, and the final `scope`. Which of these are allowed out is decided by the granted scopes, not by what happens to be in the session.

`getRewrittenRedirectUri(clientId, clientRedirectUri, deps)` and `getSessionAudience(clientId, clientRedirectUri, deps)` recover the values the proxy substituted, for the token exchange upstream.

`enrichIntrospection(data)` normalizes an introspection response, filling `fhirUser` from a `fhir_user` claim so consumers read one spelling. It leaves inactive tokens untouched.

## Choosing an identity

Our IdP emits `fhirUser` as `Person/<id>`, because one human is one Person. SMART's `fhirUser` is
single-valued, so something has to turn that Person into the one concrete reference an app
receives — and guessing is what this replaces.

`chooseIdentity(candidates, scope, shape)` returns an `IdentityChoice`: `none` when the Person
links to nothing this launch could use, `resolved` when exactly one candidate survives so nobody is
asked, and `choose` when several do. `candidatesForScopes(candidates, scope, shape)` is the filter
behind it, answering an EHR launch first because that is a stronger statement about why this human
is here than the scopes an EHR-launched app also sets.

An `IdentityCandidate` is a `reference` the token can carry verbatim, its `resourceType`, and an
optional `display` for the picker. `IdentityType` and `IDENTITY_TYPES` name the three the flow can
use: `Patient`, `Practitioner` and `RelatedPerson`.

`handleIdentitySelect(params, deps)` completes the picker. `isOfferedIdentity(reference, offered)`
is the whole authorization on that path: the offer was built from the signed-in human's own Person,
so a reference outside it is one they were never entitled to be. Without that check a session key
would be enough to name any Practitioner on the server and be issued a token as them. The picker
lives at `DEFAULT_IDENTITY_PICKER_PATH` unless `identityPickerPath` overrides it.

`isPractitioner(fhirUser)` reports whether a reference is a `Practitioner` or `PractitionerRole`,
which is what gates patient selection. `SmartErrorReason` distinguishes the two refusals a caller
must tell apart — `account-not-linked` when the account carries no `fhirUser` at all, and
`not-a-practitioner` when an identity exists but cannot be placed on a patient.
`ACCOUNT_NOT_LINKED_MESSAGE` and `PRACTITIONER_REQUIRED_MESSAGE` are the copy for each, exported so
the picker routes and the gate cannot drift into two explanations of one refusal.

## Scopes

The scope helpers are pure functions over a `Set<string>` and carry most of the spec reasoning in the package.

`parseScopes(scope)` splits a space-separated scope string. `isSmartLaunch(scopes)` reports whether a request is a launch, `isStandaloneLaunch(scopes, hasLaunchCode)` whether context must be established locally because no EHR supplied it.

`canReturnPatient`, `canReturnEncounter` and `canReturnFhirUser` gate what the token response may disclose. `canReturnFhirUser` accepts `openid` as well as `fhirUser`; `canReturnEncounter` requires `launch/encounter` or bare `launch`.

`hasPatientCompartmentScope(scopes)` and `PATIENT_COMPARTMENT_SCOPE_RE` implement a specific obligation. SMART 2.2 says that if an app is granted a scope restricted to a single patient, such as `patient/*.rs`, the EHR **shall** establish a patient in context, and **may** either refuse such a request without a launch scope or infer `launch/patient`. This package infers: a `patient/` scope is treated as implying `launch/patient`, so the existing launch machinery establishes the context the obligation requires. That is why `canReturnPatient` returns true for a patient-compartment scope even with no explicit launch scope — the app cannot stay inside the compartment its own grant is limited to unless the context reaches it.

`isScopeGranted(requested, granted)` implements v2 delegation, matching a specific request against a broader grant. It handles resource wildcards (`user/*.read`), operation wildcards (`user/Patient.*`, `user/*.*`), and the v1/v2 aliases: v1 `.read` covers `.r`, `.s` and `.rs`; v2 `.rs` covers `.r` and `.s`; `.crud` and `.cruds` cover `.r`; v1 `.write` covers any subset of `[cud]`. `filterScopes(requested, granted)` applies that to a whole request, keeping non-v2 scopes such as `openid` and `launch` when they were granted.

`SMART_V2_SCOPE_RE` matches the v2 scope grammar, accepting both a 1-5 character subset of `cruds` and the v1 `read`/`write` operations. `expandScopesToWildcards` is deprecated: Keycloak now has granular scopes created for it by the admin API, so nothing needs to widen scopes on the way upstream any more.

## Redirect URI validation

`isRedirectUriRegistered(candidate, registered)` decides whether a client's `redirect_uri` is allowed. RFC 6749 §10.6 requires this check, and here it is load-bearing rather than defensive: because the proxy rewrites the URI the IdP sees, the IdP cannot make this decision, so failing to make it would let anyone holding a `client_id` have the authorization code delivered anywhere.

Matching replicates Keycloak's, because the proxy has to reach the same verdict Keycloak would or legitimate clients break. That means exact string match, or a **single trailing** `*` matching any suffix after the literal prefix. Only a trailing wildcard counts, never a mid-string glob, so `https://app.example.com/*` cannot match `https://app.example.com.evil/cb`, and a registration without a wildcard stays strictly exact.

`GetRegisteredRedirectUris` is the async source of a client's registered URIs. An empty list rejects every candidate, so an unknown client fails closed.

`resolvePostLogoutUri({ baseUrl, sessionRedirectUri, requested, registered })` decides where the
browser goes after logout. A session's `clientRedirectUri` was validated at authorize so its origin
is trusted; anything the caller supplies is not, and an unregistered value falls back to `baseUrl`
rather than being honoured. That fallback is what stops `/logout` being an open redirect.

`resolveClientHomeUrl({ clientUri, redirectUris, proxyBaseUrl })` finds the app's own home page for
a link back. RFC 7591 `client_uri` wins; failing that a redirect URI's origin IS the app, since the
browser is already going there. A wildcard pattern is not a destination and the proxy's own
callback is not the client, so neither qualifies — and when nothing does the answer is `undefined`,
which renders no link rather than a wrong one.

## Client ID Metadata Documents

`isCimdClientId(clientId)` recognizes a CIMD-style client id: an `https` URL with a path. `resolveCimdRedirectUris(clientId, opts)` fetches and caches the document, and `validateCimdDocument(body, expectedClientId)` checks it. The critical check is that `client_id` inside the document equals the URL it was fetched from; without it any URL could vouch for any client id. `clearCimdCache()` drops the cache, and `CimdOptions` takes a `logger` and an injectable `fetchImpl`.

## Launch codes

`signLaunchCode(payload, options)` mints the HS256 JWT an EHR hands to an app to carry launch context, and `verifyLaunchCode(code, options)` returns a `LaunchCodeContext` with the payload and its `remainingTtl`, or `null`. `LaunchCodeServiceOptions` takes the HMAC `secret`, the `issuer` (normally the proxy's base URL), and `ttlSeconds`, defaulting to 300. The short default is the point: a launch code is a bearer credential for a patient context and is meant to be redeemed immediately.

Signing and verification have to agree on all three, so derive them from one place rather than assembling the object at each call site: `toLaunchCodeOptions(config, logger)` builds `LaunchCodeServiceOptions` from a `LaunchCodeConfig` — the `baseUrl`, `launchCodeSecret` and `launchCodeTtlSeconds` slice of `SmartProxyConfig`. It is structural, so a getter-backed config object works and the secret is read at call time rather than captured at startup.

## Stores

`ILaunchContextStore` is the session contract: `set`, `get`, `update`, `delete`, `find`, `size` and `dispose`. `get` returns `null` for both missing and expired entries, so callers never see a stale session.

`MemoryStore` implements it with a TTL sweep. `LaunchContextStoreOptions` takes `ttlMs` (default 10 minutes) and `cleanupIntervalMs` (default 60 seconds). It is per-process, which makes it correct for a single instance and wrong behind a load balancer: a callback landing on a different instance finds no session. Implement the same interface over Redis or Postgres for a multi-instance deployment.

## IdP adapters

`IdPAdapter` is what the proxy needs from an identity provider: `getAuthorizationUrl`, `getTokenUrl`, `getIntrospectionUrl` and `getLogoutUrl` are required. The optional members cover what not every IdP has: `getDeviceAuthorizationUrl` for the RFC 8628 device grant, `getLaunchContextParams` to map launch context onto IdP-specific query parameters that protocol mappers can turn into claims, `getIntrospectionAuth` for introspection credentials, and `isReachable` for health checks.

`KeycloakAdapter` implements it, configured with `KeycloakAdapterConfig`.

## Configuration

`SmartProxyConfig` takes `baseUrl`, the `launchCodeSecret`, and optionally `callbackPath` (default `/auth/smart-callback`), `launchCodeTtlSeconds`, and `interceptedResourceUrls`.

That last one is worth understanding before you need it. MCP clients discover the authorization server at `/.well-known/oauth-authorization-server`, where the proxy advertises its own base URL as `issuer`, because RFC 8414 §3.3 requires the issuer to match the URL the document came from. Without interception the IdP redirects straight to the client and the response carries the IdP's `iss` instead. MCP 2026-07-28 has clients compare the two by simple string comparison and forbids normalization, so the mismatch is fatal. Naming a resource URL here forces the proxy to own the authorization response for it even when the request carries no SMART scopes. SMART launches are intercepted regardless, so this list only needs the non-SMART resources.

`SmartProxyLogger` is the four-level logger interface consumers inject. `noopLogger` satisfies it and does nothing.

## Types

`LaunchSession` is what the store holds between authorize and token exchange. `LaunchCodePayload` and `LaunchCodeContext` cover launch codes. `AuthorizeParams`, `TokenRequestParams`, `TokenPayload` and `TokenEnrichment` are the request and response shapes. `SmartProxyResult` is the framework-agnostic return: a `redirect`, a `response`, or an `error`.

`TokenEnricherDeps`, `TokenEnrichInput`, `CallbackParams`, `CallbackResult`, `IntrospectionData`, `AuthorizeInterceptResult` and `CimdDocument` are the per-handler argument and result types described above.

## FHIR user helpers

`extractPatientFromFhirUser(fhirUser)` pulls the id out of a `Patient/123` reference, returning `null` for any other resource type. `getFhirUserResourceType(fhirUser)` reports the type for `Patient`, `Practitioner`, `RelatedPerson` and `Person`, handling both relative references and absolute URLs. `isAbsoluteUrl(fhirUser)` and `toAbsoluteFhirUser(fhirUser, fhirBaseUrl)` convert a relative reference to the absolute form the token response needs, leaving an already-absolute value alone.

## Related

- [OAuth & Authentication](https://proxy-smart.github.io/proxy-smart/oauth-authentication) for the deployed request pipeline.
- [SMART 2.2.0 Checklist](https://proxy-smart.github.io/proxy-smart/SMART_2.2.0_CHECKLIST) for spec coverage.
