# OAuth & Authentication

Proxy Smart acts as an OAuth 2.0 / OpenID Connect proxy between SMART apps and Keycloak. All authentication traffic flows through the `/auth` endpoints, which validate, enrich, and forward requests to the underlying Keycloak realm.

## Architecture

```
SMART App  ──►  /auth/authorize  ──►  Keycloak /auth endpoint
                                          │
SMART App  ◄──  redirect with code  ◄────┘
                                          
SMART App  ──►  /auth/token      ──►  Keycloak /token endpoint
                                          │
SMART App  ◄──  access_token     ◄────────┘
                                          
SMART App  ──►  /proxy-smart/…   ──►  FHIR Server (with validated token)
```

## Endpoints

### Discovery

| Endpoint | Description |
|---|---|
| `GET /auth/.well-known/openid-configuration` | Keycloak's OIDC discovery metadata, rewritten to the proxy's endpoints |
| `GET /auth/.well-known/oauth-authorization-server` | OAuth 2.0 AS Metadata (RFC 8414) |
| `GET /{name}/{server}/{version}/.well-known/smart-configuration` | SMART configuration per FHIR server; `404` JSON for an unknown server or version, `503` JSON while Keycloak is unreachable |

Every discovery document advertises only what works through the proxy: the proxy's supported list (`PROXY_OAUTH_SUPPORT` in `backend/src/lib/oidc-discovery.ts`) intersected with what Keycloak declares. Grants are `authorization_code`, `refresh_token`, `client_credentials`, token exchange and `device_code`; the response type is `code`; client authentication is `client_secret_basic`, `client_secret_post`, `private_key_jwt` or `none`; client assertions may be signed `RS`, `PS` or `ES` 256/384/512, which the proxy verifies itself. `scopes_supported` lists the Keycloak client scopes a client can request, without Keycloak's internal ones. The SMART scopes the proxy advertises, including the v2 wildcards such as `patient/*.rs`, are created in Keycloak at startup.
| `GET /auth/config` | Returns Keycloak connectivity status and realm info |
| `GET /.well-known/oauth-protected-resource` | RFC 9728 Protected Resource Metadata for MCP clients |
| `GET /.well-known/jwks.json` | JSON Web Key Set for token verification |

### Authorization Flow

| Endpoint | Description |
|---|---|
| `GET /auth/authorize` | Redirects to Keycloak's authorization endpoint |
| `POST /auth/authorize` | The same, with the parameters as an `application/x-www-form-urlencoded` body (SMART `authorize-post`); answers with a 303 |
| `GET /auth/login` | Simplified login redirect with sensible defaults for UI apps |
| `GET /auth/logout` | Proxies logout to Keycloak with `id_token_hint` and redirect |
| `GET /auth/identity-providers` | Public list of the identity providers shown as sign-in buttons (enabled, not hidden on the login page); alias, type and label only |

### Launch

| Endpoint | Description |
|---|---|
| `POST /auth/launch` | Issues a signed launch code for an EHR launch (see [EHR Launch](#ehr-launch)) |
| `POST /auth/launch/task` | Acts on a SMART launch Task and returns the app launch URL (see [Task-Based App Launch](/task-launch)) |

### Token Operations

| Endpoint | Description |
|---|---|
| `POST /auth/token` | Proxies token requests to Keycloak (authorization code, refresh, client credentials, token exchange, device code) |
| `POST /auth/device` | RFC 8628 device authorization, forwarded to Keycloak |
| `POST /auth/introspect` | Token introspection with SMART launch context enrichment |
| `POST /auth/revoke` | RFC 7009 token revocation, forwarded to Keycloak |
| `GET /auth/userinfo` | UserInfo endpoint with authorization_details generation |

### Dynamic Client Registration

| Endpoint | Description |
|---|---|
| `POST /auth/register` | RFC 7591 Dynamic Client Registration |

## Authorization Flow Details

### SMART App Launch

1. **App redirects to `/auth/authorize`** with standard OAuth parameters plus SMART-specific:
   - `code_challenge` and `code_challenge_method=S256` -- PKCE, required on every request. `plain`, a missing method or a missing challenge is refused
   - `aud` -- the FHIR server URL the app wants to access. Required when the scope carries a SMART launch or resource scope
   - `scope` -- SMART scopes like `launch/patient patient/*.read openid fhirUser`
   - `launch` -- EHR launch token (for EHR launch flow)

   The same parameters can be sent as a form `POST` to `/auth/authorize`.

2. **Audience validation** -- `aud` (or RFC 8707 `resource`) must be the base of a configured FHIR server, `{BASE_URL}/{name}/{server}/{version}`, or the proxy's MCP endpoint, an enabled per-server MCP endpoint or an allowed external audience. A path below a FHIR base or a server that does not exist is refused, which keeps a genuine token away from a counterfeit resource server (SMART App Launch 2.2.0). For an EHR launch `aud` must also be the `iss` the launch code was minted for.

   **Refusals.** When the proxy refuses an authorization request and the `redirect_uri` is registered for the client, the app gets an RFC 6749 §4.1.2.1 error on that `redirect_uri`, with `error_description`, its `state` and the RFC 9207 `iss`:

   | `error` | When |
   |---|---|
   | `invalid_request` | PKCE missing or not `S256`; `aud` missing on a SMART request; a `launch` value that is invalid, expired, already used, bound to no client or to another client |
   | `invalid_target` | `aud` names no resource this proxy serves, or not the `iss` of the launch |
   | `access_denied` | No patient can be established for a request that needs one (see below), or a picker submission the session never offered. For an account linked to no FHIR record, `error_uri` points at `PATIENT_ONBOARDING_URL` when it is set |
   | `interaction_required` | A patient has to be chosen but the request carried `prompt=none` |

   A `redirect_uri` that is not registered gets a plain `400` with the same `error`, since an unverified address is never redirected to. An app that was refused `access_denied` because the wrong account was signed in can start again with `prompt=login`, which the proxy passes to Keycloak.

   **Redirect URIs** match exactly, or through a single trailing Keycloak `*` wildcard. SMART asks apps to register fixed, fully specified redirect URIs, and dynamic registration stores exactly what the app sends; wildcards remain for the clients shipped in the realm export, which serve several origins and development ports. A wildcard match has to keep the registered origin once the URL is parsed, may not carry userinfo, and may not leave the registered path through dot segments. A port wildcard such as `http://localhost:*` is honoured for loopback hosts only.

   **Patient context.** A request with `launch/patient` or a `patient/` scope gets a patient in context, as SMART requires of a server that grants a patient-level scope: from the EHR launch code, from a Patient `fhirUser` (directly or through a Person), or from the patient picker, which only a practitioner may use. That includes an EHR launch whose code names no patient. Anyone else is refused, and a launch whose identity is settled only at the token endpoint and still has no patient there gets `invalid_grant` instead of a token.

3. **Keycloak handles authentication** -- user logs in, consents to scopes, Keycloak redirects back with an authorization code.

4. **App exchanges code at `/auth/token`** -- the proxy forwards the token request to Keycloak, then adds the launch context it holds for that code (`patient`, `encounter`, `fhirContext`, `need_patient_banner`, `smart_style_url`, `intent`) and an absolute `fhirUser` to the response. A confidential client authenticates with `client_secret_basic` (HTTP Basic), `client_secret_post`, or `private_key_jwt`; the proxy passes the first two to Keycloak unchanged and re-signs the third.

   When the proxy intercepted the authorization, Keycloak issued the code to the proxy callback and never saw the app's `redirect_uri`, so the proxy compares it: the code must be redeemed by the client it was issued to, with the `redirect_uri` of the authorization request. Anything else, and any request naming the proxy callback (`/auth/smart-callback`) as its own `redirect_uri`, is refused with `invalid_grant` before Keycloak is asked.

   `fhirUser` is returned when `openid` and `fhirUser` were both granted, made absolute against the FHIR server the authorization's `aud` named. `scope` is the scope Keycloak granted.

5. **App refreshes at `/auth/token`** -- the launch context is stored by the refresh token too. Once Keycloak accepts a `refresh_token` grant, the response carries the same context again (gated by the refreshed scope, so a narrowed scope can drop `patient` or `encounter`), and it is bound to the new access and refresh tokens. Introspection and patient confinement therefore keep working for the life of the refresh token; a refresh token revoked at `/auth/revoke` takes its context with it.

### Error responses

`/auth/token`, `/auth/introspect`, `/auth/revoke`, `/auth/register` and `/auth/device` answer errors as RFC 6749 §5.2 JSON (`error`, `error_description`) with `Cache-Control: no-store`. A request that does not validate or cannot be parsed gets `400 invalid_request` (`invalid_client_metadata` from `/auth/register`, per RFC 7591), and an unexpected failure `500 server_error`. One boundary (`backend/src/lib/oauth-errors.ts`) applies this to all five, so a schema failure never surfaces as the framework's `422`.

### Issuer identifiers

The proxy publishes two issuers, each matching what its reader checks against:

- The RFC 9207 `iss` parameter on every authorization response is the proxy origin (`BASE_URL`). So is the `issuer` of the proxy's RFC 8414 metadata (`/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration`), which MCP clients use to discover the proxy as their authorization server and against which they string-compare `iss`.
- The `issuer` in `.well-known/smart-configuration` is Keycloak's realm issuer. It is what the `id_token` carries in `iss`, and a SMART app validates the `id_token` against it and the advertised `jwks_uri`. It is present only while `sso-openid-connect` is among the capabilities, as SMART requires.

Both cannot be the same value without the proxy re-signing Keycloak's `id_token` under its own issuer and keys, which it does not do. Neither value is changed.

### EHR Launch

An EHR (or an agent acting for its signed-in user) calls `POST /auth/launch` with its Bearer token, the `clientId` of the app it launches, and the context to launch with: `patient`, `encounter`, `fhirUser`, `intent`, `fhirContext`, `appContext`, `smartStyleUrl`, `tenant`, `needPatientBanner`. It should also send the `iss` it will hand the app. The proxy answers with a signed, short-lived `launch` code, which the EHR passes to the app's launch URL together with `iss`.

A patient may name only their own record and a practitioner any patient; a `fhirUser` may only name the caller. The code is bound to the caller, so its context applies only when the same user signs in. `appContext` is returned as is in the token response.

The proxy holds the launch context to the SMART rules:

- `clientId` is required, and the code authorizes that client only.
- A code works once. The first authorization request that passes validation spends it, on every node when `DATABASE_URL` is set; launch the app again for a new one.
- With `iss`, which must be the base of a configured FHIR server, the code is bound to that server: the app's `aud` must name it, and an `encounter` given with a `patient` is read there with the caller's token and must belong to that patient. Without `iss` neither check can run.
- Each `fhirContext` item needs `reference`, `canonical` or `identifier`. `role` may be left out but not empty, and is an absolute URI unless it is `launch`. Patient and Encounter go in the `patient` and `encounter` parameters; inside `fhirContext` they need a role other than `launch`. Anything else is refused with `400`.

To launch from a FHIR Task instead, see [Task-Based App Launch](/task-launch).

### Supported Grant Types

| Grant Type | Use Case |
|---|---|
| `authorization_code` | Standard SMART App Launch (EHR and standalone) |
| `refresh_token` | Token refresh |
| `client_credentials` | Backend Services (with JWT client assertion) |
| Token Exchange (RFC 8693) | Subject token exchange for delegated access |
| `urn:ietf:params:oauth:grant-type:device_code` (RFC 8628) | Devices and CLIs, started at `/auth/device` |

These are the grants discovery advertises. `password` is still forwarded for admin tooling but is not advertised, and SMART apps should not use it.

### Backend Services

For system-to-system access without user interaction:

- Uses `client_credentials` grant with `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`
- Client authenticates with a signed JWT containing `system/*.read` scopes
- No user context -- suitable for bulk data, analytics, and integration engines

### Token Introspection

`POST /auth/introspect` is for resource servers, and the caller authenticates as one (RFC 7662 §2.1): HTTP Basic with its client credentials, `client_secret` in the body, or a `private_key_jwt` assertion, which the proxy verifies and re-signs as it does at the token endpoint. A request without credentials, including one that only names a `client_id`, gets `401 invalid_client`. Keycloak then answers for that caller, so a token is `active` only for a resource server in its audience, which is what RFC 8707 resource indicators put there.

A SMART app or backend service can instead authenticate with its bearer token, as SMART 2.2 requires of an access-controlled introspection endpoint. The token must validate and carry the introspection scope, `token-introspection` unless `SMART_INTROSPECTION_SCOPE` names another. The backend creates that client scope in Keycloak at startup; assign it to each client allowed to introspect, then request it (for example `scope=system/*.rs token-introspection` on a `client_credentials` grant). Such a caller may introspect a token issued to any client, so the proxy asks Keycloak as its own introspection client (`KEYCLOAK_ADMIN_CLIENT_ID`), which is exempt from Keycloak's audience check. A bearer token that does not validate gets `401 invalid_token`; one without the scope gets `403 insufficient_scope`.

For an active token the response repeats the launch context of the original token response: `patient`, `encounter`, `fhirUser`, `fhirContext`, `intent`, `need_patient_banner`, `smart_style_url`, `tenant`, and the RFC 8693 `act` chain of an exchanged token. The context is kept whenever any of these was in the token response, and `scope` is reported as the token response granted it. With `DATABASE_URL` set the context is stored in PostgreSQL, so every backend node returns it; without a database it lives in memory on the node that issued the token, and a multi-node deployment needs sticky routing (see [environment variables](environment-variables.md#database-and-multi-node-state)).

### Token Revocation

`POST /auth/revoke` takes `token` and an optional `token_type_hint` (RFC 7009). A confidential client authenticates as it does at the token endpoint: HTTP Basic is passed to Keycloak unchanged, `client_secret` travels in the body, and a `private_key_jwt` assertion (with `aud` = the proxy token endpoint) is verified and re-signed. A public client sends only its `client_id`. A request that names no client gets `401 invalid_client`.

An unknown, expired or already revoked token answers `200`, as RFC 7009 §2.2 requires. Revoking a token issued to another client is refused by Keycloak and the refusal is passed through. A successful revocation also drops the launch context the proxy held for that token.

Keycloak records the revocation, so introspection reports the token inactive from then on. The proxy validates access tokens locally, so it also keeps the `jti` of each access token revoked through it until that token would have expired, and refuses it on the FHIR, DICOMweb, MCP and admin routes. Each node checks that list in memory. With `DATABASE_URL` set every revocation is also written to PostgreSQL and the other nodes pick it up within five seconds; without a database the list stays on the node that took the revocation, and the others accept the token until it expires. Revoking a refresh token makes Keycloak end that client's session, which stops new access tokens but not the ones already issued.

### Managing app access

`management_endpoint` in `.well-known/smart-configuration` points the user to where they see and revoke the apps they authorized: the consent app when `CONSENT_APP_URL` (or the consent `appUrl` runtime setting) is set, otherwise the Keycloak account console's applications page (`{KEYCLOAK_PUBLIC_URL}/realms/{realm}/account/applications`).

### UserInfo

`GET /auth/userinfo` returns the standard OIDC UserInfo response plus `authorization_details` generated from the token's SMART claims and configured FHIR server endpoints.

## Keycloak Unavailability

If Keycloak is unreachable when a user tries to authenticate, the proxy returns a friendly HTML error page (HTTP 503) with a retry button instead of a raw browser connection error. This applies to `/auth/authorize` and `/auth/login`.

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `KEYCLOAK_BASE_URL` | Internal Keycloak URL | -- |
| `KEYCLOAK_PUBLIC_URL` | Browser-facing Keycloak URL (if different from internal) | derives from `KEYCLOAK_BASE_URL` |
| `KEYCLOAK_REALM` | Keycloak realm name | -- |
| `KEYCLOAK_ADMIN_CLIENT_ID` | Service account client ID for admin API calls | -- |
| `KEYCLOAK_ADMIN_CLIENT_SECRET` | Service account client secret | -- |
| `KEYCLOAK_DOMAIN` | Domain override for public URL generation | -- |
| `SMART_INTROSPECTION_SCOPE` | Scope a SMART bearer token needs to call `/auth/introspect` | `token-introspection` |
